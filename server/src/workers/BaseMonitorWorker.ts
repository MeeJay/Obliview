import type { Server as SocketIOServer } from 'socket.io';
import type { MonitorStatus } from '@obliview/shared';
import { SOCKET_EVENTS } from '@obliview/shared';
import { heartbeatService } from '../services/heartbeat.service';
import { monitorService } from '../services/monitor.service';
import { notificationService } from '../services/notification.service';
import { remediationService } from '../services/remediation.service';
import { groupService } from '../services/group.service';
import { groupNotificationService } from '../services/groupNotification.service';
import { permissionService } from '../services/permission.service';
import { maintenanceService } from '../services/maintenance.service';
import { liveAlertService } from '../services/liveAlert.service';
import { db } from '../db';
import { logger } from '../utils/logger';

export interface CheckResult {
  status: MonitorStatus;
  responseTime?: number;
  statusCode?: number;
  message?: string;
  ping?: number;
  value?: string;
  /** Set to true for value watcher "changed" operator — triggers notification without changing status */
  valueChanged?: boolean;
}

export interface MonitorConfig {
  id: number;
  name: string;
  type: string;
  groupId: number | null;
  intervalSeconds: number;
  retryIntervalSeconds: number;
  maxRetries: number;
  timeoutMs: number;
  upsideDown: boolean;
  /** Minimum seconds between repeated problem notifications (0 = disabled) */
  notificationCooldownSeconds: number;
  [key: string]: unknown;
}

export abstract class BaseMonitorWorker {
  protected config: MonitorConfig;
  protected io: SocketIOServer;
  protected timer: ReturnType<typeof setTimeout> | null = null;
  protected isRunning: boolean = false;
  protected retryCount: number = 0;
  protected previousStatus: MonitorStatus = 'pending';
  /** The last status that was officially confirmed and notified (survives retries) */
  protected confirmedStatus: MonitorStatus = 'pending';
  /** Unix-ms timestamp of the last notification sent (for cooldown) */
  protected lastNotifiedAt: number = 0;
  /** The status that was last actually notified to the user */
  protected lastNotifiedStatus: MonitorStatus = 'pending';
  /** Unix-ms timestamp of the last confirmed status change (for debounce) */
  protected lastStateChangeAt: number = 0;
  /** Pending notification queued during cooldown (sent when state is stable for cooldown duration) */
  protected pendingNotification: { status: MonitorStatus; message?: string; inMaintenance?: boolean } | null = null;
  /** Tenant ID for scoped Socket.io room emissions (null until resolved) */
  protected tenantId: number | null = null;
  /**
   * True only on the very first processResult() call after start().
   * Combined with restoredFromDb, suppresses spurious notifications caused
   * by in-memory state (push timestamps, agent snapshots) being lost on restart.
   */
  private isFirstBeat: boolean = true;
  /**
   * True when confirmedStatus was loaded from a non-pending DB row,
   * i.e. this is an existing monitor being (re)started, not a brand-new one.
   */
  private restoredFromDb: boolean = false;

  constructor(config: MonitorConfig, io: SocketIOServer) {
    this.config = config;
    this.io = io;
  }

  /** Resolve and cache the tenant_id for this monitor from the DB. */
  protected async resolveTenantId(): Promise<number | null> {
    if (this.tenantId !== null) return this.tenantId;
    const row = await db('monitors')
      .where({ id: this.config.id })
      .select('tenant_id')
      .first() as { tenant_id: number | null } | undefined;
    this.tenantId = row?.tenant_id ?? null;
    return this.tenantId;
  }

  async start(): Promise<void> {
    this.isRunning = true;
    logger.info(`Starting worker for monitor "${this.config.name}" (id: ${this.config.id})`);

    // Restore previousStatus / confirmedStatus from the DB so a fresh start
    // does not re-send notifications for problems that were already known before
    // the server restarted (e.g. a monitor that was already DOWN).
    try {
      const row = await db('monitors')
        .where({ id: this.config.id })
        .select('status')
        .first() as { status: MonitorStatus } | undefined;
      if (row?.status && row.status !== 'pending') {
        this.previousStatus  = row.status;
        this.confirmedStatus = row.status;
        // Flag that we have a real prior state — used to suppress the first beat's
        // spurious notifications when in-memory data (push/agent) is not yet available.
        this.restoredFromDb  = true;
      }
    } catch {
      // Non-critical — fall through with defaults ('pending')
    }

    await this.beat();
    this.scheduleNext();
  }

  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info(`Stopped worker for monitor "${this.config.name}" (id: ${this.config.id})`);
  }

  updateConfig(config: MonitorConfig): void {
    this.config = config;
  }

  private scheduleNext(): void {
    if (!this.isRunning) return;

    // Use shorter retry interval while in the retry window for both 'down' and 'alert'.
    const isRetryableStatus = this.previousStatus === 'down' || this.previousStatus === 'alert';
    const interval =
      isRetryableStatus && this.retryCount <= this.config.maxRetries
        ? this.config.retryIntervalSeconds
        : this.config.intervalSeconds;

    this.timer = setTimeout(async () => {
      if (!this.isRunning) return;
      await this.beat();
      this.scheduleNext();
    }, interval * 1000);
  }

  private async beat(): Promise<void> {
    let result: CheckResult;

    try {
      result = await this.performCheck();
    } catch (error) {
      result = {
        status: 'down',
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }

    // Apply upside-down logic (only for up/down, not SSL statuses)
    if (this.config.upsideDown && (result.status === 'up' || result.status === 'down')) {
      result.status = result.status === 'up' ? 'down' : 'up';
    }

    await this.processResult(result);
  }

  private async processResult(result: CheckResult): Promise<void> {
    try {
      // On the very first beat of a restarted existing monitor, suppress all
      // handleStatusChange calls and confirmedStatus updates.  In-memory state
      // (agent push snapshots, push-monitor timestamps) is empty right after
      // server restart, so the first check may return a stale/incorrect status.
      // We still update the DB status and emit the heartbeat — only notifications
      // and live alerts are skipped until the second beat.
      const isStartupBeat = this.isFirstBeat && this.restoredFromDb;

      // SSL statuses are deterministic (not transient) — no retries needed
      const isSslStatus = result.status === 'ssl_warning' || result.status === 'ssl_expired';

      // 'down' AND 'alert' both go through the retry mechanism:
      //   • retryCount accumulates on consecutive failures
      //   • notification fires only after retryCount > maxRetries (confirmed problem)
      //   • this prevents spurious notifications on transient failures / brief threshold spikes
      const isRetryableStatus = result.status === 'down' || result.status === 'alert';

      if (isRetryableStatus) {
        this.retryCount++;
      }
      const isRetrying = isRetryableStatus && this.retryCount <= this.config.maxRetries;

      // 0. Check maintenance state (cached — 60s TTL)
      const agentDeviceId = this.config.agentDeviceId as number | null | undefined;
      const inMaintenance = agentDeviceId
        ? await maintenanceService.isInMaintenance('agent', agentDeviceId, this.config.groupId)
        : await maintenanceService.isInMaintenance('monitor', this.config.id, this.config.groupId);

      // 1. Store heartbeat (with retry flag + maintenance tag)
      const heartbeat = await heartbeatService.create({
        monitorId: this.config.id,
        status: result.status,
        responseTime: result.responseTime,
        statusCode: result.statusCode,
        message: result.message,
        ping: result.ping,
        isRetrying,
        value: result.value,
        inMaintenance,
      });

      // 1b. Value changed notification (value watcher "changed" operator)
      //     Fires independently of status change logic — monitor stays UP
      if (result.valueChanged) {
        try {
          await notificationService.sendForMonitor(this.config.id, this.config.groupId, {
            monitorName: this.config.name,
            monitorUrl: this.config.url as string | undefined,
            oldStatus: 'up',
            newStatus: 'value_changed',
            message: result.message,
            timestamp: new Date().toISOString(),
          });
        } catch (error) {
          logger.error(error, `Failed to send value-changed notification for monitor ${this.config.id}`);
        }
      }

      // 2. State change logic — compare against confirmedStatus (not previousStatus)
      //    confirmedStatus tracks the last "officially notified" state.
      //    previousStatus tracks the raw last-check status (used for scheduleNext timing).

      if (isRetryableStatus) {
        if (this.retryCount > this.config.maxRetries) {
          // Retries exhausted — confirmed problem (DOWN or ALERT)
          if (this.confirmedStatus !== result.status && !isStartupBeat) {
            await this.handleStatusChange(result.status, result.message, inMaintenance);
            // Do NOT advance confirmedStatus while in maintenance.
            // Keeping the pre-maintenance value ensures that once the window ends,
            // confirmedStatus !== result.status is still true and a notification fires
            // immediately on the next check — even if the monitor was already down
            // throughout the entire maintenance period.
            if (!inMaintenance) {
              this.confirmedStatus = result.status;
            }
          }
        }
        // During retry period: do NOT update confirmedStatus — wait for the threshold to be met
      } else if (isSslStatus) {
        // SSL statuses fire immediately with no retries
        this.retryCount = 0;
        if (this.confirmedStatus !== result.status && !isStartupBeat) {
          await this.handleStatusChange(result.status, result.message, inMaintenance);
          if (!inMaintenance) {
            this.confirmedStatus = result.status;
          }
        }
      } else {
        // Status is UP (or 'inactive') — always update confirmedStatus, even during maintenance.
        // If a down monitor recovers during a maintenance window we want to track that transition
        // so that a subsequent drop after maintenance correctly fires a notification.
        if (this.confirmedStatus !== result.status && this.confirmedStatus !== 'pending' && !isStartupBeat) {
          await this.handleStatusChange(result.status, result.message, inMaintenance);
        }
        if (!isStartupBeat) {
          this.confirmedStatus = result.status;
        }
        this.retryCount = 0;
      }

      this.previousStatus = result.status;
      this.isFirstBeat = false;

      // 2b. Flush pending debounced notification if state has been stable long enough
      await this.flushPendingNotification();

      // 3. Update monitor status in DB
      // For agent monitors on the startup beat, skip writing 'down' to the DB.
      // agentPushData is empty right after restart, so the first worker check
      // always returns 'down' even if the agent was 'alert' or 'up' before restart.
      // Overwriting the DB here would corrupt the fallback used by agent.service.ts
      // to detect transitions on the agent's first push after restart, causing a
      // false up→alert notification.  The DB will be updated correctly on the next
      // beat once the agent has pushed its real data.
      const isAgentStartupDown =
        isStartupBeat &&
        !!this.config.agentDeviceId &&
        result.status === 'down';
      if (!isAgentStartupDown) {
        await monitorService.updateStatus(this.config.id, result.status);
      }

      // 4. Broadcast heartbeat via Socket.io (visibility-filtered)
      await this.emitToVisibleUsers(SOCKET_EVENTS.MONITOR_HEARTBEAT, {
        monitorId: this.config.id,
        heartbeat,
      });
    } catch (error) {
      // FK violation (23503): the monitor was deleted while the worker was still running.
      // Stop the worker gracefully instead of spamming the logs on every tick.
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code: string }).code === '23503'
      ) {
        logger.warn(
          `Monitor "${this.config.name}" (id: ${this.config.id}) no longer exists in DB — stopping worker gracefully`,
        );
        this.stop();
        return;
      }
      logger.error(
        error,
        `Error processing result for monitor "${this.config.name}" (id: ${this.config.id})`,
      );
    }
  }

  /**
   * Check if a debounced notification is ready to fire.
   * Called on every beat — sends the pending notification only when the state
   * has been stable (no handleStatusChange calls) for the full cooldown period.
   */
  private async flushPendingNotification(): Promise<void> {
    if (!this.pendingNotification) return;
    const cooldownMs = (this.config.notificationCooldownSeconds ?? 0) * 1000;
    if (cooldownMs <= 0) return;
    const elapsed = Date.now() - this.lastStateChangeAt;
    if (elapsed < cooldownMs) return; // still in debounce window

    // State has been stable for the full cooldown — send the queued notification
    const pending = this.pendingNotification;
    this.pendingNotification = null;

    // Skip if the pending status is the same as what we last notified
    if (pending.status === this.lastNotifiedStatus) {
      logger.info(
        `Monitor "${this.config.name}" (id: ${this.config.id}): ` +
        `pending notification discarded — status unchanged (${pending.status})`,
      );
      return;
    }

    logger.info(
      `Monitor "${this.config.name}" (id: ${this.config.id}): ` +
      `flushing debounced notification: ${this.lastNotifiedStatus} → ${pending.status} (stable for ${Math.round(elapsed / 1000)}s)`,
    );
    this.lastNotifiedAt = Date.now();
    this.lastNotifiedStatus = pending.status;
    await this.dispatchNotification(this.confirmedStatus, pending.status, pending.message, pending.inMaintenance);
  }

  private async handleStatusChange(newStatus: MonitorStatus, message?: string, inMaintenance?: boolean): Promise<void> {
    const oldStatus = this.confirmedStatus;
    logger.info(
      `Monitor "${this.config.name}" (id: ${this.config.id}): ${oldStatus} → ${newStatus}`,
    );

    // Emit status change event (visibility-filtered)
    await this.emitToVisibleUsers(SOCKET_EVENTS.MONITOR_STATUS_CHANGE, {
      monitorId: this.config.id,
      oldStatus,
      newStatus,
      timestamp: new Date().toISOString(),
    });

    // 'inactive' status = agent offline with heartbeat_monitoring disabled → no notification
    if (newStatus === 'inactive') {
      return;
    }

    // 'inactive' → 'up': the agent came back online after being off, but heartbeat monitoring
    // was disabled — the user does not want a "recovered" ping for simply resuming data.
    // Threshold violations (inactive → 'alert') still fire normally.
    if (oldStatus === 'inactive' && newStatus === 'up') {
      return;
    }

    // ── Maintenance suppression ────────────────────────────────────────────────
    // When in maintenance, skip notifications and remediations entirely.
    if (inMaintenance) {
      logger.info(
        `Monitor "${this.config.name}" (id: ${this.config.id}): ` +
        `status change ${oldStatus} → ${newStatus} suppressed (in maintenance)`,
      );
      return;
    }

    // ── Notification cooldown (debounce) ─────────────────────────────────────
    // Prevents notification spam when metrics oscillate around a threshold.
    // First notification fires immediately. Subsequent state changes during the
    // cooldown window are queued — the timer resets on every change. Only when
    // the state has been stable for the full cooldown period does the queued
    // notification fire. This applies to ALL transitions (alert, down, up).
    const cooldownMs = (this.config.notificationCooldownSeconds ?? 0) * 1000;
    if (cooldownMs > 0 && this.lastNotifiedAt > 0) {
      // We already sent at least one notification — debounce subsequent ones
      this.lastStateChangeAt = Date.now();
      this.pendingNotification = { status: newStatus, message, inMaintenance };
      logger.info(
        `Monitor "${this.config.name}" (id: ${this.config.id}): ` +
        `notification queued (cooldown debounce ${this.config.notificationCooldownSeconds}s) — ${oldStatus} → ${newStatus}`,
      );
      return;
    }
    // First notification or cooldown disabled — send immediately
    this.lastNotifiedAt = Date.now();
    this.lastNotifiedStatus = newStatus;
    this.lastStateChangeAt = Date.now();
    await this.dispatchNotification(oldStatus, newStatus, message, inMaintenance);
  }

  /**
   * Actually send the notification + remediation + live alert.
   * Called by handleStatusChange (first/immediate) and flushPendingNotification (debounced).
   */
  private async dispatchNotification(oldStatus: MonitorStatus, newStatus: MonitorStatus, message?: string, inMaintenance?: boolean): Promise<void> {
    const isProblemStatus = (s: string) =>
      s === 'down' || s === 'ssl_expired' || s === 'ssl_warning' || s === 'alert';

    // ── Notification type filtering for agent monitors ─────────────────────────
    if (this.config.agentDeviceId) {
      const types = await notificationService.resolveNotificationTypesForDevice(this.config.agentDeviceId as number);
      if (!types.global) {
        logger.info(
          `Monitor "${this.config.name}" (id: ${this.config.id}): notification suppressed (global=off)`,
        );
        return;
      }
      if (newStatus === 'down' && !types.down) {
        logger.info(
          `Monitor "${this.config.name}" (id: ${this.config.id}): notification suppressed (down type disabled)`,
        );
        return;
      }
      if (newStatus === 'up' && !types.up) {
        logger.info(
          `Monitor "${this.config.name}" (id: ${this.config.id}): notification suppressed (up type disabled)`,
        );
        return;
      }
      if (newStatus === 'alert' && !types.alert) {
        logger.info(
          `Monitor "${this.config.name}" (id: ${this.config.id}): notification suppressed (alert type disabled)`,
        );
        return;
      }
      if (newStatus === 'pending' && !types.update) {
        logger.info(
          `Monitor "${this.config.name}" (id: ${this.config.id}): notification suppressed (update type disabled)`,
        );
        return;
      }
    }

    // Trigger notifications
    try {
      const groupNotifGroupId = await groupNotificationService.shouldSuppressIndividual(
        this.config.id,
        this.config.groupId,
      );

      if (groupNotifGroupId !== null) {
        const group = await groupService.getById(groupNotifGroupId);

        if (isProblemStatus(newStatus)) {
          const result = groupNotificationService.handleMonitorDown(
            this.config.id,
            this.config.name,
            groupNotifGroupId,
          );

          if (result === 'first_down') {
            const failing = await groupNotificationService.getFailingMonitorsInGroup(groupNotifGroupId);
            const failingNames = failing.map(m => m.name);
            const confirmedNames = failing.filter(m => !m.isRetrying).map(m => m.name);
            const totalFailing = failing.length;

            let groupMsg: string;
            if (totalFailing <= 1) {
              groupMsg = message ?? `Monitor "${this.config.name}" in group "${group!.name}" is ${newStatus.toUpperCase()}`;
            } else {
              groupMsg = `${totalFailing} monitor(s) failing in group "${group!.name}": ${failingNames.join(', ')}`;
            }

            await notificationService.sendForGroup(groupNotifGroupId, group!.name, {
              monitorName: this.config.name,
              monitorUrl: this.config.url as string | undefined,
              oldStatus,
              newStatus,
              groupName: group!.name,
              groupId: groupNotifGroupId,
              downMonitors: confirmedNames,
              failingMonitors: failingNames,
              totalFailingCount: totalFailing,
              isGroupNotification: true,
              message: groupMsg,
              timestamp: new Date().toISOString(),
            });
          }
        } else if (isProblemStatus(oldStatus)) {
          const result = groupNotificationService.handleMonitorUp(
            this.config.id,
            groupNotifGroupId,
          );

          if (result === 'all_recovered') {
            await notificationService.sendForGroup(groupNotifGroupId, group!.name, {
              monitorName: group!.name,
              oldStatus: 'down',
              newStatus: 'up',
              groupName: group!.name,
              groupId: groupNotifGroupId,
              downMonitors: [],
              isGroupNotification: true,
              message: `All monitors in group "${group!.name}" are back up`,
              timestamp: new Date().toISOString(),
            });
          }
        }
      } else {
        await notificationService.sendForMonitor(this.config.id, this.config.groupId, {
          monitorName: this.config.name,
          monitorUrl: this.config.url as string | undefined,
          oldStatus,
          newStatus,
          message,
          timestamp: new Date().toISOString(),
        }, this.config.agentDeviceId as number | null | undefined);
      }
    } catch (error) {
      logger.error(error, `Failed to send notifications for monitor ${this.config.id}`);
    }

    // Trigger remediations
    remediationService.triggerForMonitor(
      this.config.id,
      this.config.name,
      this.config.url as string | undefined,
      this.config.type,
      this.config.groupId,
      oldStatus,
      newStatus,
    ).catch(err => logger.error(err, `Remediation trigger failed for monitor ${this.config.id}`));

    // Persist live alert
    const tenantId = await this.resolveTenantId();
    if (tenantId !== null) {
      const isProblem = isProblemStatus(newStatus);
      const wasProblematic = isProblemStatus(oldStatus);
      let severity: 'down' | 'up' | 'warning' | 'info';
      let alertMessage: string;
      if (isProblem) {
        severity = newStatus === 'down' ? 'down' : 'warning';
        alertMessage = message ?? `Monitor is ${newStatus.toUpperCase()}`;
      } else if (wasProblematic) {
        severity = 'up';
        alertMessage = 'Monitor recovered';
      } else {
        return;
      }
      liveAlertService.add(tenantId, {
        severity,
        title: this.config.name,
        message: alertMessage,
        navigateTo: `/monitor/${this.config.id}`,
      }).catch(err => logger.error(err, `Failed to persist live alert for monitor ${this.config.id}`));
    }
  }

  /**
   * Emit a Socket.io event only to users who can see this monitor.
   * Admins always receive it. Non-admins receive it based on team permissions.
   */
  private async emitToVisibleUsers(event: string, payload: unknown): Promise<void> {
    const tenantId = await this.resolveTenantId();

    // Always send to admins — emit to the tenant-scoped admin room (primary)
    // and to the legacy 'role:admin' room for backward compatibility.
    if (tenantId !== null) {
      this.io.to(`tenant:${tenantId}:admin`).emit(event, payload);
    }
    this.io.to('role:admin').emit(event, payload);

    // Get non-admin user IDs with access to this monitor via team permissions
    const userIds = await permissionService.getUsersWithMonitorAccess(this.config.id);
    for (const userId of userIds) {
      this.io.to(`user:${userId}`).emit(event, payload);
    }
  }

  /**
   * Perform the actual check. Implemented by each monitor type.
   * Must resolve within this.config.timeoutMs.
   */
  abstract performCheck(): Promise<CheckResult>;

  /**
   * Expose the last confirmed (notified) status so subclasses can synthesize
   * a no-op result (e.g. during the startup grace period) without triggering
   * a spurious status transition.
   */
  protected getConfirmedStatus(): MonitorStatus {
    return this.confirmedStatus;
  }
}
