import { BaseMonitorWorker, type CheckResult } from './BaseMonitorWorker';
import { agentPushData } from '../services/agent.service';
import { db } from '../db';
import { SOCKET_EVENTS } from '@obliview/shared';
import { SERVER_START_TIME } from '../utils/serverStartTime';

/**
 * Agent Monitor Worker (passive).
 *
 * Thresholds are evaluated in real-time at push time (in agent.service.ts).
 * This worker's only job is to detect "device offline" (no push received
 * within 2 × check_interval_seconds) and return the current status.
 */
export class AgentMonitorWorker extends BaseMonitorWorker {
  async performCheck(): Promise<CheckResult> {
    const agentDeviceId = this.config.agentDeviceId as number | null;

    if (!agentDeviceId) {
      return { status: 'down', message: 'Agent monitor not configured (no device ID)' };
    }

    // Collect the result into a local variable so we can emit AGENT_STATUS_CHANGED
    // from every code path (offline watchdog, normal push, device state changes).
    let result: CheckResult;

    // Fetch device for status + raw settings + override flag + updating_since
    const device = await db('agent_devices')
      .where({ id: agentDeviceId })
      .select('check_interval_seconds', 'status', 'heartbeat_monitoring', 'group_id', 'agent_max_missed_pushes', 'override_group_settings', 'updating_since', 'notification_cooldown_seconds')
      .first() as {
        check_interval_seconds: number; status: string; heartbeat_monitoring: boolean;
        group_id: number | null; agent_max_missed_pushes: number | null; override_group_settings: boolean;
        updating_since: Date | null; notification_cooldown_seconds: number | null;
      } | undefined;

    if (!device) {
      result = { status: 'down', message: 'Agent device not found' };
    } else if (device.status === 'refused') {
      result = { status: 'down', message: 'Agent device is refused' };
    } else if (device.status === 'suspended') {
      result = { status: 'paused', message: 'Agent device is suspended' };
    } else if (device.status === 'pending') {
      result = { status: 'pending', message: 'Waiting for device approval' };
    } else if (device.updating_since !== null) {
      // Agent notified us it is self-updating.
      // Within 10 minutes: show "updating" status — no offline alert, excluded from uptime.
      // After 10 minutes: cleanupStuckUpdating() will clear updating_since and normal
      // offline detection resumes on the next worker cycle.
      const updatingAgeMs = Date.now() - new Date(device.updating_since).getTime();
      if (updatingAgeMs < 10 * 60 * 1000) {
        result = { status: 'pending', message: 'Agent is self-updating...' };
        // Emit 'updating' to the UI (distinct from 'pending') via a dedicated event payload
        const tenantId = await this.resolveTenantId();
        const updatingPayload = { deviceId: agentDeviceId, status: 'updating', violations: [], violationKeys: [] };
        if (tenantId !== null) {
          this.io.to(`tenant:${tenantId}:admin`).emit(SOCKET_EVENTS.AGENT_STATUS_CHANGED, updatingPayload);
        }
        this.io.to('role:admin').emit(SOCKET_EVENTS.AGENT_STATUS_CHANGED, updatingPayload);
        return result; // skip the generic AGENT_STATUS_CHANGED emit below
      }
      // Updating window expired — cleanupStuckUpdating() will clear this shortly.
      // Fall through to normal offline detection (snapshot will be stale → 'down').
      const snapshot = agentPushData.get(agentDeviceId);
      result = snapshot ? { status: 'down', message: 'Update timed out — device offline' }
                        : { status: 'down', message: 'Update timed out — no data received' };
    } else {
      // Check for a recent push
      const snapshot = agentPushData.get(agentDeviceId);

      // Resolve effective settings — when override_group_settings is false and the
      // device belongs to a group, walk the FULL group closure chain (root → leaf)
      // so that sub-group configs override parent configs, matching the same hierarchy
      // as settingsService.resolveForMonitor:
      //   device own values → global default
      //   group chain root→leaf each overrides previous
      //   device override_group_settings=true → device values always win
      let effectiveCheckInterval = device.check_interval_seconds;
      let effectiveHeartbeatMonitoring = device.heartbeat_monitoring ?? true;
      let effectiveMaxMissedPushes: number | null = device.agent_max_missed_pushes ?? null;

      if (!device.override_group_settings && device.group_id !== null) {
        // Traverse ancestor chain ordered root→leaf (depth DESC → root first, depth=0 = self last).
        // Each row that has a non-null value overrides whatever came before it, so the
        // most-specific group (direct parent, depth=0) wins over the root group.
        const ancestorRows = await db('group_closure')
          .join('monitor_groups', 'monitor_groups.id', 'group_closure.ancestor_id')
          .where('group_closure.descendant_id', device.group_id)
          .orderBy('group_closure.depth', 'desc') // root first → direct group last
          .select('monitor_groups.agent_group_config') as { agent_group_config: unknown }[];

        for (const row of ancestorRows) {
          const cfg = typeof row.agent_group_config === 'string'
            ? JSON.parse(row.agent_group_config)
            : row.agent_group_config as { pushIntervalSeconds?: number | null; heartbeatMonitoring?: boolean | null; maxMissedPushes?: number | null; notificationCooldownSeconds?: number | null } | null | undefined;
          if (cfg) {
            if (cfg.pushIntervalSeconds != null) effectiveCheckInterval       = cfg.pushIntervalSeconds;
            if (cfg.heartbeatMonitoring  != null) effectiveHeartbeatMonitoring = cfg.heartbeatMonitoring;
            if (cfg.maxMissedPushes      != null) effectiveMaxMissedPushes    = cfg.maxMissedPushes;
            if (cfg.notificationCooldownSeconds != null) this.config.notificationCooldownSeconds = cfg.notificationCooldownSeconds;
          }
        }
      }

      // Per-device cooldown override — always applies when set (null = inherit from group/global)
      if (device.notification_cooldown_seconds != null) {
        this.config.notificationCooldownSeconds = device.notification_cooldown_seconds;
      }

      const effectiveMaxMissed = effectiveMaxMissedPushes ?? 2;
      const maxStaleMs = effectiveCheckInterval * effectiveMaxMissed * 1000;

      if (!snapshot) {
        // No push received since server start.
        // Apply a startup grace period to avoid spamming notifications while agents
        // reconnect after a server restart.  Formula (per agent): 60s + checkInterval × maxMissed.
        // During this window we return the last confirmed status (a no-op for the state machine),
        // which prevents retryCount from accumulating and triggering an offline notification.
        const gracePeriodMs = 60_000 + effectiveCheckInterval * effectiveMaxMissed * 1000;
        if (Date.now() - SERVER_START_TIME < gracePeriodMs) {
          result = {
            status: this.getConfirmedStatus(),
            message: 'Server restarted — waiting for agent reconnect...',
          };
        } else {
          result = effectiveHeartbeatMonitoring
            ? { status: 'down', message: 'Waiting for first agent push...' }
            : { status: 'inactive', message: 'No data received (heartbeat monitoring disabled)' };
        }
      } else {
        const ageMs = Date.now() - snapshot.receivedAt.getTime();
        if (ageMs > maxStaleMs) {
          const ageSec = Math.round(ageMs / 1000);
          const ageMins = Math.floor(ageSec / 60);
          const timeLabel = ageMins > 0 ? `${ageMins}m ${ageSec % 60}s` : `${ageSec}s`;
          result = effectiveHeartbeatMonitoring
            ? { status: 'down', message: `Device offline (last seen ${timeLabel} ago)` }
            : { status: 'inactive', message: `No data received for ${timeLabel} (heartbeat monitoring disabled)` };
        } else {
          // Agent is online — return the status computed at push time for the
          // monitor badge / notifications, but pin the heartbeat row to 'up'.
          // Threshold violations (CPU/RAM/temp) must NOT register as downtime
          // in the Uptime tab — that section is reachability only.
          const message = snapshot.violations.length > 0
            ? snapshot.violations.join('; ')
            : 'All metrics OK';
          result = {
            status: snapshot.overallStatus,
            heartbeatStatus: 'up',
            message,
          };
        }
      }
    }

    // Emit dedicated agent status event so the sidebar badge updates immediately,
    // regardless of whether the BaseMonitorWorker will emit MONITOR_STATUS_CHANGE
    // (which only fires on transitions after retries are exhausted).
    const snapshot = agentPushData.get(agentDeviceId);
    const agentStatusPayload = {
      deviceId: agentDeviceId,
      status: result.status,
      violations: snapshot?.violations ?? [],
      violationKeys: snapshot?.violationKeys ?? [],
    };
    // Emit to tenant-scoped admin room (primary) and legacy 'role:admin' for backward compat.
    const tenantId = await this.resolveTenantId();
    if (tenantId !== null) {
      this.io.to(`tenant:${tenantId}:admin`).emit(SOCKET_EVENTS.AGENT_STATUS_CHANGED, agentStatusPayload);
    }
    this.io.to('role:admin').emit(SOCKET_EVENTS.AGENT_STATUS_CHANGED, agentStatusPayload);

    return result;
  }
}
