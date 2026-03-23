import type { Server as SocketIOServer } from 'socket.io';
import * as fs from 'fs';
import * as path from 'path';
import { db } from '../db';
import type { AgentApiKey, AgentDevice, AgentDisplayConfig, AgentGroupConfig, AgentThresholds, NotificationTypeConfig } from '@obliview/shared';
import { DEFAULT_AGENT_THRESHOLDS, SOCKET_EVENTS, prettifySensorLabel } from '@obliview/shared';
import { heartbeatService } from './heartbeat.service';
import { notificationService } from './notification.service';
import { liveAlertService } from './liveAlert.service';
import { logger } from '../utils/logger';
import { obligateService } from './obligate.service';

// ── Socket.io instance (set from index.ts) ──────────────────
let _io: SocketIOServer | null = null;
export function setAgentServiceIO(io: SocketIOServer): void {
  _io = io;
}

// ============================================================
// Row ↔ Model helpers
// ============================================================

interface AgentApiKeyRow {
  id: number;
  name: string;
  key: string;
  created_by: number | null;
  created_at: Date;
  last_used_at: Date | null;
  device_count?: string | number;
}

interface AgentDeviceRow {
  id: number;
  uuid: string;
  hostname: string;
  name: string | null;
  ip: string | null;
  os_info: unknown;
  agent_version: string | null;
  api_key_id: number | null;
  status: string;
  heartbeat_monitoring: boolean;
  check_interval_seconds: number;
  agent_max_missed_pushes: number | null;  // migration 021
  approved_by: number | null;
  approved_at: Date | null;
  group_id: number | null;
  created_at: Date;
  updated_at: Date;
  // migration 025
  sensor_display_names: unknown;
  // migration 026
  override_group_settings: boolean;
  // migration 032
  display_config: unknown;
  // migration 033
  pending_command: string | null;
  uninstall_commanded_at: Date | null;
  // migration 039
  tenant_id: number;
  // migration 040
  updating_since: Date | null;
  // migration 042
  notification_types: unknown;
}

function rowToApiKey(row: AgentApiKeyRow): AgentApiKey {
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
    deviceCount: row.device_count ? Number(row.device_count) : undefined,
  };
}

function rowToDevice(row: AgentDeviceRow, groupConfig?: AgentGroupConfig | null, groupThresholds?: AgentThresholds | null): AgentDevice {
  const override = row.override_group_settings ?? false;

  // Compute effective (resolved) settings, honouring group inheritance when override=false.
  let resolvedSettings: AgentDevice['resolvedSettings'];
  if (!override && groupConfig) {
    resolvedSettings = {
      checkIntervalSeconds: groupConfig.pushIntervalSeconds ?? row.check_interval_seconds,
      heartbeatMonitoring:  groupConfig.heartbeatMonitoring  ?? (row.heartbeat_monitoring ?? true),
      maxMissedPushes:      groupConfig.maxMissedPushes      ?? (row.agent_max_missed_pushes ?? 2),
    };
  } else {
    resolvedSettings = {
      checkIntervalSeconds: row.check_interval_seconds,
      heartbeatMonitoring:  row.heartbeat_monitoring ?? true,
      maxMissedPushes:      row.agent_max_missed_pushes ?? 2,
    };
  }

  return {
    id: row.id,
    uuid: row.uuid,
    hostname: row.hostname,
    tenantId: row.tenant_id as number,
    name: row.name ?? null,
    ip: row.ip,
    osInfo: typeof row.os_info === 'string' ? JSON.parse(row.os_info) : (row.os_info as AgentDevice['osInfo']),
    agentVersion: row.agent_version,
    apiKeyId: row.api_key_id,
    status: row.status as AgentDevice['status'],
    heartbeatMonitoring: row.heartbeat_monitoring ?? true,
    checkIntervalSeconds: row.check_interval_seconds,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at ? row.approved_at.toISOString() : null,
    groupId: row.group_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    sensorDisplayNames: (row.sensor_display_names as Record<string, string> | null) ?? null,
    overrideGroupSettings: override,
    resolvedSettings,
    groupSettings: groupConfig ?? null,
    groupThresholds: groupThresholds ?? null,
    displayConfig: (typeof row.display_config === 'string'
      ? JSON.parse(row.display_config)
      : (row.display_config as AgentDisplayConfig | null)) ?? null,
    pendingCommand: row.pending_command ?? null,
    uninstallCommandedAt: row.uninstall_commanded_at ? row.uninstall_commanded_at.toISOString() : null,
    updatingSince: row.updating_since ? row.updating_since.toISOString() : null,
    notificationTypes: row.notification_types
      ? (typeof row.notification_types === 'string'
          ? JSON.parse(row.notification_types)
          : row.notification_types as NotificationTypeConfig)
      : null,
  };
}

/**
 * Resolve the effective agent group config by traversing the full ancestor chain
 * root→leaf (depth DESC → root first, direct group last).
 * Each level that has a non-null value overrides the previous, so the most-specific
 * group (direct parent) wins — mirrors AgentMonitorWorker and settingsService logic.
 */
async function resolveGroupAgentConfig(groupId: number): Promise<AgentGroupConfig | null> {
  const ancestorRows = await db('group_closure')
    .join('monitor_groups', 'monitor_groups.id', 'group_closure.ancestor_id')
    .where('group_closure.descendant_id', groupId)
    .orderBy('group_closure.depth', 'desc') // root first → direct group last
    .select('monitor_groups.agent_group_config') as { agent_group_config: unknown }[];

  let resolved: Partial<AgentGroupConfig> | null = null;
  for (const row of ancestorRows) {
    const cfg = typeof row.agent_group_config === 'string'
      ? JSON.parse(row.agent_group_config) as AgentGroupConfig | null | undefined
      : row.agent_group_config as AgentGroupConfig | null | undefined;
    if (cfg) {
      if (!resolved) resolved = {};
      if (cfg.pushIntervalSeconds != null) resolved.pushIntervalSeconds = cfg.pushIntervalSeconds;
      if (cfg.heartbeatMonitoring  != null) resolved.heartbeatMonitoring  = cfg.heartbeatMonitoring;
      if (cfg.maxMissedPushes      != null) resolved.maxMissedPushes      = cfg.maxMissedPushes;
    }
  }
  return resolved as AgentGroupConfig | null;
}

/**
 * Resolve the effective agent thresholds by traversing the full ancestor chain
 * root→leaf. Each level spreads its thresholds over the previous, so the
 * most-specific group wins.
 */
async function resolveGroupAgentThresholds(groupId: number): Promise<AgentThresholds | null> {
  const ancestorRows = await db('group_closure')
    .join('monitor_groups', 'monitor_groups.id', 'group_closure.ancestor_id')
    .where('group_closure.descendant_id', groupId)
    .orderBy('group_closure.depth', 'desc')
    .select('monitor_groups.agent_thresholds') as { agent_thresholds: unknown }[];

  let resolved: AgentThresholds | null = null;
  for (const row of ancestorRows) {
    const t = typeof row.agent_thresholds === 'string'
      ? JSON.parse(row.agent_thresholds) as AgentThresholds | null | undefined
      : row.agent_thresholds as AgentThresholds | null | undefined;
    if (t) {
      resolved = { ...(resolved ?? {}), ...t } as AgentThresholds;
    }
  }
  return resolved;
}

// ============================================================
// Push payload types
// ============================================================

export interface AgentMetrics {
  cpu?: {
    percent: number;
    cores?: number[];
    model?: string;
    freqMhz?: number;
  };
  memory?: {
    totalMb: number;
    usedMb: number;
    percent: number;
    cachedMb?: number;
    buffersMb?: number;
    swapTotalMb?: number;
    swapUsedMb?: number;
  };
  disks?: Array<{
    mount: string;
    totalGb: number;
    usedGb: number;
    percent: number;
    readBytesPerSec?: number;
    writeBytesPerSec?: number;
  }>;
  network?: {
    inBytesPerSec: number;
    outBytesPerSec: number;
    interfaces?: Array<{ name: string; inBytesPerSec: number; outBytesPerSec: number }>;
  };
  loadAvg?: number;
  temps?: Array<{ label: string; celsius: number }>;
  gpus?: Array<{
    model: string;
    utilizationPct: number;
    vramUsedMb: number;
    vramTotalMb: number;
    tempCelsius?: number;
    engines?: Array<{ label: string; pct: number }>;
  }>;
  fans?: Array<{ label: string; rpm: number; maxRpm?: number }>;
}

export interface AgentPushPayload {
  hostname: string;
  agentVersion: string;
  osInfo?: {
    platform: string;
    distro?: string | null;
    release?: string | null;
    arch: string;
  };
  metrics: AgentMetrics;
}

export interface AgentPushResponse {
  status: 'ok' | 'pending' | 'unauthorized';
  config?: { checkIntervalSeconds: number };
  /** Piggybacked on every ok/pending response so agents update without an extra round-trip. */
  latestVersion?: string;
  /**
   * One-shot command for the agent to execute (e.g. 'uninstall').
   * Cleared from DB as soon as it is included in a push response.
   */
  command?: string;
}

// ── In-memory snapshot: indexed by deviceId ─────────────────
export interface AgentPushSnapshot {
  monitorId: number;
  receivedAt: Date;
  metrics: AgentMetrics;
  violations: string[];
  /** Stable per-metric keys (same index as violations), used by the client for dedup */
  violationKeys: string[];
  overallStatus: 'up' | 'alert';
}

export const agentPushData = new Map<number, AgentPushSnapshot>();

// ============================================================
// Agent Service
// ============================================================

export const agentService = {

  // ── API Keys ────────────────────────────────────────────

  async listKeys(tenantId: number): Promise<AgentApiKey[]> {
    const rows = await db('agent_api_keys as k')
      .leftJoin('agent_devices as d', 'k.id', 'd.api_key_id')
      .where({ 'k.tenant_id': tenantId })
      .groupBy('k.id')
      .select('k.*', db.raw('COUNT(d.id) as device_count'))
      .orderBy('k.created_at', 'desc') as AgentApiKeyRow[];
    return rows.map(rowToApiKey);
  },

  async createKey(name: string, createdBy: number, tenantId: number): Promise<AgentApiKey> {
    const [row] = await db('agent_api_keys')
      .insert({ name, created_by: createdBy, tenant_id: tenantId })
      .returning('*') as AgentApiKeyRow[];
    return rowToApiKey(row);
  },

  async deleteKey(id: number): Promise<boolean> {
    const count = await db('agent_api_keys').where({ id }).del();
    return count > 0;
  },

  // ── Devices ─────────────────────────────────────────────

  async listDevices(tenantId: number, status?: AgentDevice['status']): Promise<AgentDevice[]> {
    const query = db('agent_devices')
      .where({ tenant_id: tenantId })
      .select('*')
      .orderBy('created_at', 'desc');
    if (status) query.where({ status });
    const rows = await query as AgentDeviceRow[];

    // Deduplicate group IDs, then resolve each group's full closure chain once.
    const uniqueGroupIds = [...new Set(rows.map(r => r.group_id).filter((id): id is number => id !== null))];
    const configMap = new Map<number, AgentGroupConfig | null>();
    const thresholdsMap = new Map<number, AgentThresholds | null>();
    await Promise.all(uniqueGroupIds.map(async (gid) => {
      const [gc, gt] = await Promise.all([
        resolveGroupAgentConfig(gid),
        resolveGroupAgentThresholds(gid),
      ]);
      configMap.set(gid, gc);
      thresholdsMap.set(gid, gt);
    }));

    return rows.map(r => rowToDevice(
      r,
      r.group_id !== null ? (configMap.get(r.group_id) ?? null) : null,
      r.group_id !== null ? (thresholdsMap.get(r.group_id) ?? null) : null,
    ));
  },

  async getDeviceById(id: number): Promise<AgentDevice | null> {
    const row = await db('agent_devices').where({ id }).first() as AgentDeviceRow | undefined;
    if (!row) return null;
    const [groupConfig, groupThresholds] = await Promise.all([
      row.group_id ? resolveGroupAgentConfig(row.group_id) : null,
      row.group_id ? resolveGroupAgentThresholds(row.group_id) : null,
    ]);
    return rowToDevice(row, groupConfig, groupThresholds);
  },

  async getDeviceByUuid(uuid: string): Promise<AgentDevice | null> {
    const row = await db('agent_devices').where({ uuid }).first() as AgentDeviceRow | undefined;
    if (!row) return null;
    const [groupConfig, groupThresholds] = await Promise.all([
      row.group_id ? resolveGroupAgentConfig(row.group_id) : null,
      row.group_id ? resolveGroupAgentThresholds(row.group_id) : null,
    ]);
    return rowToDevice(row, groupConfig, groupThresholds);
  },

  async updateDevice(id: number, data: {
    status?: AgentDevice['status'];
    groupId?: number | null;
    checkIntervalSeconds?: number;
    approvedBy?: number;
    approvedAt?: Date;
    name?: string | null;
    heartbeatMonitoring?: boolean;
    sensorDisplayNames?: Record<string, string> | null;
    overrideGroupSettings?: boolean;
    displayConfig?: AgentDisplayConfig | null;
    notificationTypes?: NotificationTypeConfig | null;
  }): Promise<AgentDevice | null> {
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.status !== undefined) update.status = data.status;
    if (data.groupId !== undefined) update.group_id = data.groupId;
    if (data.checkIntervalSeconds !== undefined) update.check_interval_seconds = data.checkIntervalSeconds;
    if (data.approvedBy !== undefined) update.approved_by = data.approvedBy;
    if (data.approvedAt !== undefined) update.approved_at = data.approvedAt;
    if (data.name !== undefined) update.name = data.name;
    if (data.heartbeatMonitoring !== undefined) update.heartbeat_monitoring = data.heartbeatMonitoring;
    if (data.sensorDisplayNames !== undefined) update.sensor_display_names = data.sensorDisplayNames;
    if (data.overrideGroupSettings !== undefined) update.override_group_settings = data.overrideGroupSettings;
    if (data.displayConfig !== undefined) update.display_config = data.displayConfig;
    if ('notificationTypes' in data) update.notification_types = data.notificationTypes
      ? JSON.stringify(data.notificationTypes)
      : null;

    const [row] = await db('agent_devices')
      .where({ id })
      .update(update)
      .returning('*') as AgentDeviceRow[];
    if (!row) return null;
    const groupConfig = row.group_id ? await resolveGroupAgentConfig(row.group_id) : null;
    const device = rowToDevice(row, groupConfig);

    // Sync the associated monitor name whenever device.name is explicitly changed
    if (data.name !== undefined) {
      await db('monitors')
        .where({ agent_device_id: id })
        .update({ name: device.name ?? device.hostname });
    }

    // Broadcast so the sidebar can update name/status/group without polling
    if (_io) {
      _io.to('role:admin').emit(SOCKET_EVENTS.AGENT_DEVICE_UPDATED, {
        deviceId: device.id,
        name: device.name,
        hostname: device.hostname,
        status: device.status,
        groupId: device.groupId,
      });
    }

    return device;
  },

  async deleteDevice(id: number): Promise<boolean> {
    // Delete associated monitor first
    await db('monitors').where({ agent_device_id: id }).del();
    const count = await db('agent_devices').where({ id }).del();
    return count > 0;
  },

  // ── Bulk operations ──────────────────────────────────────────────────────

  async bulkDeleteDevices(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await db('monitors').whereIn('agent_device_id', ids).del();
    await db('agent_devices').whereIn('id', ids).del();
    // Broadcast deletion events so the frontend updates in real-time
    if (_io) {
      for (const id of ids) {
        _io.to('role:admin').emit(SOCKET_EVENTS.AGENT_DEVICE_DELETED, { deviceId: id });
      }
    }
  },

  async bulkUpdateDevices(ids: number[], data: {
    groupId?: number | null;
    heartbeatMonitoring?: boolean;
    overrideGroupSettings?: boolean;
    status?: 'approved' | 'suspended';
  }): Promise<void> {
    if (ids.length === 0) return;
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.groupId !== undefined)             update.group_id               = data.groupId;
    if (data.heartbeatMonitoring !== undefined)  update.heartbeat_monitoring   = data.heartbeatMonitoring;
    if (data.overrideGroupSettings !== undefined) update.override_group_settings = data.overrideGroupSettings;
    if (data.status !== undefined)               update.status                 = data.status;
    await db('agent_devices').whereIn('id', ids).update(update);
    // Notify frontend of each updated device
    if (_io) {
      for (const id of ids) {
        _io.to('role:admin').emit(SOCKET_EVENTS.AGENT_DEVICE_UPDATED, { deviceId: id });
      }
    }
  },

  /** Queue a command to be delivered to a device on its next push. */
  async sendCommand(id: number, command: string): Promise<boolean> {
    const count = await db('agent_devices')
      .where({ id })
      .update({ pending_command: command, updated_at: new Date() });
    return count > 0;
  },

  /** Queue a command for multiple devices at once. */
  async bulkSendCommand(ids: number[], command: string): Promise<void> {
    if (ids.length === 0) return;
    await db('agent_devices')
      .whereIn('id', ids)
      .update({ pending_command: command, updated_at: new Date() });
  },

  /**
   * Cleanup job: auto-delete devices whose 'uninstall' command was delivered
   * more than 10 minutes ago (they've had enough time to uninstall and stop pushing).
   * Should be called periodically (e.g. every 5 minutes).
   */
  async cleanupUninstalledDevices(): Promise<void> {
    const cutoff = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    const rows = await db('agent_devices')
      .whereNotNull('uninstall_commanded_at')
      .where('uninstall_commanded_at', '<', cutoff)
      .select('id') as { id: number }[];

    if (rows.length === 0) return;

    const ids = rows.map(r => r.id);
    await this.bulkDeleteDevices(ids);
    logger.info(`Agent cleanup: auto-deleted ${ids.length} device(s) after uninstall command.`);
  },

  /** Suspend a device: set status=suspended + pause the agent monitor */
  async suspendDevice(id: number): Promise<void> {
    await db('agent_devices').where({ id }).update({ status: 'suspended', updated_at: new Date() });
    await db('monitors')
      .where({ agent_device_id: id, type: 'agent' })
      .update({ is_active: false, status: 'paused', updated_at: new Date() });
  },

  /** Reinstate a suspended device: re-activate the agent monitor */
  async reinstateDevice(id: number): Promise<void> {
    await db('monitors')
      .where({ agent_device_id: id, type: 'agent' })
      .update({ is_active: true, status: 'pending', updated_at: new Date() });
  },

  // ── Approval ─────────────────────────────────────────────

  /**
   * Approve a device: set status=approved, create ONE monitor with all thresholds.
   */
  async approveDevice(
    deviceId: number,
    approvedBy: number,
    groupId: number | null,
    customThresholds?: AgentThresholds,
  ): Promise<AgentDevice | null> {
    const device = await this.getDeviceById(deviceId);
    if (!device) return null;

    // Update device status and reset interval to 60s on approval
    const updated = await this.updateDevice(deviceId, {
      status: 'approved',
      groupId,
      approvedBy,
      approvedAt: new Date(),
      checkIntervalSeconds: 60,
    });

    // Determine thresholds: custom > group defaults > system defaults
    let thresholds: AgentThresholds = { ...DEFAULT_AGENT_THRESHOLDS };
    if (groupId) {
      const groupRow = await db('monitor_groups')
        .where({ id: groupId })
        .select('agent_thresholds')
        .first() as { agent_thresholds: AgentThresholds | null } | undefined;
      if (groupRow?.agent_thresholds) {
        thresholds = groupRow.agent_thresholds;
      }
    }
    if (customThresholds) {
      thresholds = customThresholds;
    }

    // Remove any previously created monitors for this device (re-approval)
    await db('monitors').where({ agent_device_id: deviceId }).del();

    // Create ONE monitor for this device (use display name if set, fallback to hostname)
    try {
      await db('monitors').insert({
        name: device.name ?? device.hostname,
        type: 'agent',
        group_id: groupId,
        is_active: true,
        status: 'pending',
        agent_device_id: deviceId,
        agent_thresholds: JSON.stringify(thresholds),
        created_by: approvedBy,
        tenant_id: device.tenantId,
      });
    } catch (error) {
      logger.error(error, `Failed to create agent monitor for device ${deviceId}`);
    }

    return updated;
  },

  // ── Update device thresholds ─────────────────────────────

  /**
   * Update the thresholds on the agent monitor associated with a device.
   */
  async updateDeviceThresholds(
    deviceId: number,
    thresholds: AgentThresholds,
  ): Promise<boolean> {
    const count = await db('monitors')
      .where({ agent_device_id: deviceId, type: 'agent' })
      .update({
        agent_thresholds: JSON.stringify(thresholds),
        updated_at: new Date(),
      });
    return count > 0;
  },

  // ── Latest metrics ───────────────────────────────────────

  getLatestMetrics(deviceId: number): AgentPushSnapshot | null {
    return agentPushData.get(deviceId) ?? null;
  },

  /**
   * Reconstruct the latest AgentPushSnapshot from the most recent heartbeat in DB.
   * Used as fallback when in-memory Map is empty (e.g. after server restart).
   */
  async getMetricsFromDB(deviceId: number): Promise<AgentPushSnapshot | null> {
    // Find the agent monitor for this device
    const monitor = await db('monitors')
      .where({ agent_device_id: deviceId, type: 'agent' })
      .select('id')
      .first() as { id: number } | undefined;

    if (!monitor) return null;

    // Get the most recent heartbeat
    const hb = await db('heartbeats')
      .where({ monitor_id: monitor.id })
      .orderBy('created_at', 'desc')
      .select('status', 'message', 'value', 'created_at')
      .first() as { status: string; message: string; value: string | null; created_at: Date } | undefined;

    if (!hb || !hb.value) return null;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(hb.value);
    } catch {
      return null;
    }

    const fullMetrics = parsed._full as AgentMetrics | undefined;
    const violations = (parsed._violations as string[] | undefined) ?? [];

    if (!fullMetrics) return null;

    const snapshot: AgentPushSnapshot = {
      monitorId: monitor.id,
      receivedAt: hb.created_at,
      metrics: fullMetrics,
      violations,
      violationKeys: [], // keys not persisted in DB; recomputed on next live push
      overallStatus: (hb.status === 'alert' ? 'alert' : 'up') as 'up' | 'alert',
    };

    // Cache it so next call is instant
    agentPushData.set(deviceId, snapshot);
    return snapshot;
  },

  // ── Push endpoint logic ───────────────────────────────────

  async handlePush(
    apiKeyId: number,
    tenantId: number,
    deviceUuid: string,
    clientIp: string,
    payload: AgentPushPayload,
  ): Promise<AgentPushResponse> {
    let device = await this.getDeviceByUuid(deviceUuid);

    if (!device) {
      // Register new device as pending
      const [row] = await db('agent_devices')
        .insert({
          uuid: deviceUuid,
          hostname: payload.hostname,
          ip: clientIp,
          os_info: payload.osInfo ? JSON.stringify(payload.osInfo) : null,
          agent_version: payload.agentVersion,
          api_key_id: apiKeyId,
          tenant_id: tenantId,
          status: 'pending',
          check_interval_seconds: 300, // pending: check every 5min
        })
        .returning('*') as AgentDeviceRow[];
      device = rowToDevice(row);
      // Register device UUID with Obligate for cross-app linking (non-blocking)
      obligateService.registerDeviceLink(deviceUuid, `/agents/${device.id}`).catch(() => {});
    } else {
      // Update device metadata — clear updating_since if set (agent came back after update)
      const metadataUpdate: Record<string, unknown> = {
        hostname: payload.hostname,
        ip: clientIp,
        agent_version: payload.agentVersion,
        os_info: payload.osInfo ? JSON.stringify(payload.osInfo) : null,
        updated_at: new Date(),
      };
      if (device.updatingSince) {
        metadataUpdate.updating_since = null;
        logger.info(`Agent ${device.id} (${device.hostname}) came back online after update.`);
      }
      await db('agent_devices')
        .where({ id: device.id })
        .update(metadataUpdate);

      // Apply metadata changes in-memory (avoid redundant DB round-trip)
      device = {
        ...device,
        hostname: payload.hostname,
        ip: clientIp,
        agentVersion: payload.agentVersion ?? device.agentVersion,
        osInfo: payload.osInfo
          ? { platform: payload.osInfo.platform, distro: payload.osInfo.distro ?? null, release: payload.osInfo.release ?? null, arch: payload.osInfo.arch }
          : device.osInfo,
        updatingSince: null,
      };
    }

    // After if/else, device is always assigned (either new insert or existing update)
    const dev = device as AgentDevice;

    // Handle refused/suspended devices
    if (dev.status === 'refused' || dev.status === 'suspended') {
      return { status: 'unauthorized' };
    }

    // Consume any pending command: clear from DB and include in response once.
    // For 'uninstall', also record the delivery timestamp so the cleanup job can
    // auto-delete the device after ~10 minutes of silence.
    let pendingCommand: string | undefined;
    if (dev.pendingCommand) {
      pendingCommand = dev.pendingCommand;
      const commandUpdate: Record<string, unknown> = { pending_command: null, updated_at: new Date() };
      if (pendingCommand === 'uninstall') {
        commandUpdate.uninstall_commanded_at = new Date();
      }
      await db('agent_devices').where({ id: dev.id }).update(commandUpdate);
    }

    // Handle pending devices
    if (dev.status === 'pending') {
      return {
        status: 'pending',
        // Use resolvedSettings so group-inherited intervals are honoured.
        config: { checkIntervalSeconds: dev.resolvedSettings.checkIntervalSeconds },
        latestVersion: this.getAgentVersion().version,
        ...(pendingCommand ? { command: pendingCommand } : {}),
      };
    }

    // Device is approved → store single heartbeat
    if (dev.status === 'approved') {
      await this._storeMetricsAsHeartbeat(dev, payload);

      return {
        status: 'ok',
        // Use resolvedSettings so group-inherited intervals are honoured.
        config: { checkIntervalSeconds: dev.resolvedSettings.checkIntervalSeconds },
        latestVersion: this.getAgentVersion().version,
        ...(pendingCommand ? { command: pendingCommand } : {}),
      };
    }

    return { status: 'unauthorized' };
  },

  /**
   * Evaluate all metric thresholds and store ONE heartbeat for the device's monitor.
   */
  async _storeMetricsAsHeartbeat(
    device: AgentDevice,
    payload: AgentPushPayload,
  ): Promise<void> {
    // Find the single agent monitor for this device
    const monitor = await db('monitors')
      .where({ agent_device_id: device.id, type: 'agent', is_active: true })
      .select('id', 'agent_thresholds')
      .first() as { id: number; agent_thresholds: AgentThresholds | null } | undefined;

    if (!monitor) {
      logger.warn(`No active agent monitor found for device ${device.id} (${device.hostname})`);
      return;
    }

    // Threshold hierarchy: agent's explicitly saved thresholds always win;
    // group thresholds are the default when the agent has none;
    // system defaults are the last resort.
    // Note: overrideGroupSettings controls checkInterval/heartbeat/maxMissedPushes only.
    const thresholds: AgentThresholds =
      monitor.agent_thresholds ?? device.groupThresholds ?? DEFAULT_AGENT_THRESHOLDS;
    const m = payload.metrics;

    // Evaluate each threshold and build violation list.
    // violations[i] = human-readable message, violationKeys[i] = stable metric key for client dedup.
    const violations: string[] = [];
    const violationKeys: string[] = [];

    if (thresholds.cpu.enabled && m.cpu !== undefined) {
      if (this._isThresholdExceeded(m.cpu.percent, thresholds.cpu)) {
        violations.push(`CPU: ${m.cpu.percent.toFixed(1)}% ${thresholds.cpu.op} ${thresholds.cpu.threshold}%`);
        violationKeys.push('cpu');
      }
    }

    if (thresholds.memory.enabled && m.memory !== undefined) {
      if (this._isThresholdExceeded(m.memory.percent, thresholds.memory)) {
        violations.push(`RAM: ${m.memory.percent.toFixed(1)}% ${thresholds.memory.op} ${thresholds.memory.threshold}%`);
        violationKeys.push('ram');
      }
    }

    if (thresholds.disk.enabled && m.disks) {
      for (const disk of m.disks) {
        if (this._isThresholdExceeded(disk.percent, thresholds.disk)) {
          const diskName = device.displayConfig?.drives?.renames?.[disk.mount] ?? disk.mount;
          violations.push(`Disk ${diskName}: ${disk.percent.toFixed(1)}% ${thresholds.disk.op} ${thresholds.disk.threshold}%`);
          violationKeys.push(`disk:${disk.mount}`); // raw mount (stable, not affected by rename)
        }
      }
    }

    if (thresholds.netIn.enabled && m.network !== undefined) {
      if (this._isThresholdExceeded(m.network.inBytesPerSec, thresholds.netIn)) {
        // Convert bytes/sec → Mbps (1 Mbps = 125 000 bytes/sec)
        const current = (m.network.inBytesPerSec / 125_000).toFixed(1);
        const limit   = (thresholds.netIn.threshold  / 125_000).toFixed(0);
        violations.push(`Net In: ${current} Mbps ${thresholds.netIn.op} ${limit} Mbps`);
        violationKeys.push('net_in');
      }
    }

    if (thresholds.netOut.enabled && m.network !== undefined) {
      if (this._isThresholdExceeded(m.network.outBytesPerSec, thresholds.netOut)) {
        const current = (m.network.outBytesPerSec / 125_000).toFixed(1);
        const limit   = (thresholds.netOut.threshold / 125_000).toFixed(0);
        violations.push(`Net Out: ${current} Mbps ${thresholds.netOut.op} ${limit} Mbps`);
        violationKeys.push('net_out');
      }
    }

    // Temperature thresholds: global + per-sensor overrides
    if (thresholds.temp?.globalEnabled) {
      const tempT = thresholds.temp;
      // Gather all sensors: regular temps + GPU temps
      const sensors: Array<{ key: string; label: string; celsius: number }> = [];
      if (m.temps) {
        for (const s of m.temps) {
          sensors.push({ key: `temp:${s.label}`, label: s.label, celsius: s.celsius });
        }
      }
      if (m.gpus) {
        m.gpus.forEach((gpu, i) => {
          if (gpu.tempCelsius !== undefined) {
            sensors.push({
              key: `gpu:${i}:${gpu.model}`,
              label: `GPU ${i} – ${gpu.model}`,
              celsius: gpu.tempCelsius,
            });
          }
        });
      }
      for (const sensor of sensors) {
        const override = tempT.overrides[sensor.key];
        // Per-sensor override active → use its settings; otherwise fall back to global
        const active = override?.enabled
          ? { op: override.op, threshold: override.threshold }
          : { op: tempT.op, threshold: tempT.threshold };
        if (this._isThresholdExceeded(sensor.celsius, active)) {
          const displayLabel = device.sensorDisplayNames?.[sensor.key] ?? prettifySensorLabel(sensor.label);
          violations.push(
            `Temp ${displayLabel}: ${sensor.celsius.toFixed(1)}°C ${active.op} ${active.threshold}°C`,
          );
          violationKeys.push(sensor.key); // already stable: "temp:CPU Package", "gpu:0:RTX 4090", etc.
        }
      }
    }

    const overallStatus: 'up' | 'alert' = violations.length > 0 ? 'alert' : 'up';
    const message = violations.length > 0 ? violations.join('; ') : 'All metrics OK';

    // Capture previous status before overwriting snapshot (for transition detection).
    // When no in-memory snapshot exists (e.g. server just restarted), fall back to the
    // monitor's persisted DB status so we don't fire a false up→alert notification for
    // a device that was already in alert state before the restart.
    const previousSnapshot = agentPushData.get(device.id);
    let previousStatus: 'up' | 'alert';
    if (previousSnapshot) {
      previousStatus = previousSnapshot.overallStatus;
    } else {
      const monitorStatusRow = await db('monitors')
        .where({ id: monitor.id })
        .select('status')
        .first() as { status: string } | undefined;
      const dbStatus = monitorStatusRow?.status ?? 'up';
      previousStatus = dbStatus === 'alert' ? 'alert' : 'up';
    }

    // Update in-memory snapshot
    const snapshot: AgentPushSnapshot = {
      monitorId: monitor.id,
      receivedAt: new Date(),
      metrics: m,
      violations,
      violationKeys,
      overallStatus,
    };
    agentPushData.set(device.id, snapshot);

    // ── Emit real-time updates FIRST (before DB writes) for lowest latency ──
    if (_io) {
      _io.to('role:admin').emit('agentPush', {
        deviceId: device.id,
        monitorId: monitor.id,
        agentVersion: payload.agentVersion,
        metrics: m,
        violations,
        overallStatus,
        receivedAt: snapshot.receivedAt.toISOString(),
      });
      _io.to('role:admin').emit(SOCKET_EVENTS.MONITOR_STATUS_CHANGE, {
        monitorId: monitor.id,
        newStatus: overallStatus,
      });
      _io.to('role:admin').emit(SOCKET_EVENTS.AGENT_STATUS_CHANGED, {
        deviceId: device.id,
        status: overallStatus,
        violations,
        violationKeys,
      });
    }

    // ── DB persistence (fire-and-forget — errors logged, don't block response) ──
    const heartbeatValue = JSON.stringify({
      cpu: m.cpu?.percent,
      memory: m.memory?.percent,
      disks: m.disks?.map(d => ({ mount: d.mount, percent: d.percent })),
      netIn: m.network?.inBytesPerSec,
      netOut: m.network?.outBytesPerSec,
      loadAvg: m.loadAvg,
      _full: m,
      _violations: violations,
    });

    Promise.all([
      heartbeatService.create({
        monitorId: monitor.id,
        status: overallStatus,
        message,
        value: heartbeatValue,
      }).then(heartbeat => {
        // Emit MONITOR_HEARTBEAT after insert so the heartbeat has an id/timestamp
        if (_io) {
          _io.to('role:admin').emit(SOCKET_EVENTS.MONITOR_HEARTBEAT, {
            monitorId: monitor.id,
            heartbeat,
          });
        }
      }),
      db('monitors')
        .where({ id: monitor.id })
        .update({ status: overallStatus, updated_at: new Date() }),
    ]).catch(err => logger.error(err, `Failed to persist heartbeat/status for device ${device.id}`));

    // ── Notifications + live alerts on status transitions (fire-and-forget) ──
    if (overallStatus !== previousStatus) {
      const deviceName = device.name ?? device.hostname;
      notificationService.sendForAgent(device.id, deviceName, overallStatus, previousStatus, violations).catch(
        (err) => logger.error(err, `Failed to send agent notification for device ${device.id}`),
      );

      const deviceTenantId = device.tenantId;
      if (overallStatus === 'alert') {
        for (const [i, violation] of violations.entries()) {
          const metricKey = violationKeys[i] ?? `unknown_${i}`;
          liveAlertService.add(deviceTenantId, {
            severity: 'warning',
            title: deviceName,
            message: violation,
            navigateTo: `/agents/${device.id}`,
            stableKey: `agent-${device.id}-${metricKey}`,
          }).catch(err => logger.error(err, `Failed to persist live alert for device ${device.id}`));
        }
      } else if (previousStatus === 'alert') {
        liveAlertService.add(deviceTenantId, {
          severity: 'up',
          title: deviceName,
          message: 'All metrics back to normal',
          navigateTo: `/agents/${device.id}`,
        }).catch(err => logger.error(err, `Failed to persist recovery alert for device ${device.id}`));
      }
    }
  },

  /**
   * Returns true if the threshold condition is triggered (i.e. metric is in violation).
   */
  _isThresholdExceeded(value: number, t: { threshold: number; op: string }): boolean {
    switch (t.op) {
      case '>':  return value > t.threshold;
      case '<':  return value < t.threshold;
      case '>=': return value >= t.threshold;
      case '<=': return value <= t.threshold;
      default:   return false;
    }
  },

  // ── Version / download endpoints ─────────────────────────

  getAgentVersion(): { version: string } {
    // 1. Try agent/VERSION (plain text "X.Y.Z\n") — present in both dev and prod
    try {
      const versionFilePath = path.resolve(__dirname, '../../../../agent/VERSION');
      const v = fs.readFileSync(versionFilePath, 'utf-8').trim();
      if (v) return { version: v };
    } catch { /* not found, try next */ }

    // 2. Dev fallback: parse `var agentVersion = "x.y.z"` from agent/main.go
    // (main.go now uses `var agentVersion = "dev"` as default — skip "dev")
    try {
      const mainGoPath = path.resolve(__dirname, '../../../../agent/main.go');
      const content = fs.readFileSync(mainGoPath, 'utf-8');
      const match = content.match(/(?:var|const)\s+agentVersion\s*=\s*"([^"]+)"/);
      if (match?.[1] && match[1] !== 'dev') return { version: match[1] };
    } catch { /* not found */ }

    return { version: '0.0.0' };
  },

  /**
   * Mark a device as "updating" — called when the agent notifies us it is
   * about to self-update.  Sets updating_since to NOW() and emits the
   * AGENT_STATUS_CHANGED event so the UI shows the "UPDATING" badge immediately.
   */
  async setDeviceUpdating(deviceId: number, tenantId: number): Promise<void> {
    await db('agent_devices')
      .where({ id: deviceId })
      .update({ updating_since: new Date(), updated_at: new Date() });

    const device = await db('agent_devices').where({ id: deviceId }).select('hostname', 'name').first() as
      { hostname: string; name: string | null } | undefined;
    const label = device?.name ?? device?.hostname ?? `#${deviceId}`;
    logger.info(`Agent ${deviceId} (${label}) is self-updating.`);

    // Notify connected admins immediately
    if (_io) {
      const payload = { deviceId, status: 'updating', violations: [], violationKeys: [] };
      if (tenantId) {
        _io.to(`tenant:${tenantId}:admin`).emit(SOCKET_EVENTS.AGENT_STATUS_CHANGED, payload);
      }
      _io.to('role:admin').emit(SOCKET_EVENTS.AGENT_STATUS_CHANGED, payload);
    }

    // Send "update" notification if the update type is enabled for this device
    notificationService.sendForAgent(deviceId, label, 'updating', 'up', [], 'update').catch(
      (err) => logger.error(err, `Failed to send update notification for device ${deviceId}`),
    );
  },

  /**
   * Cleanup job: clear updating_since for devices that have been stuck in the
   * updating state for more than 10 minutes without reconnecting.
   * After clearing, the normal offline detection takes over and sends
   * the standard "device offline" alert.
   */
  async cleanupStuckUpdating(): Promise<void> {
    const cutoff = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    const rows = await db('agent_devices')
      .whereNotNull('updating_since')
      .where('updating_since', '<', cutoff)
      .select('id', 'hostname', 'name') as { id: number; hostname: string; name: string | null }[];

    if (rows.length === 0) return;

    const ids = rows.map(r => r.id);
    await db('agent_devices')
      .whereIn('id', ids)
      .update({ updating_since: null, updated_at: new Date() });

    for (const row of rows) {
      const label = row.name ?? row.hostname;
      logger.warn(`Agent ${row.id} (${label}) update timed out — resuming offline detection.`);
    }
    logger.info(`Agent updating cleanup: cleared ${ids.length} stuck update(s).`);
  },

  getDesktopVersion(): { version: string } {
    // 1. Try obli.tools/VERSION (plain text "X.Y.Z\n")
    try {
      const versionFilePath = path.resolve(__dirname, '../../../../obli.tools/VERSION');
      const v = fs.readFileSync(versionFilePath, 'utf-8').trim();
      if (v) return { version: v };
    } catch { /* not found, try next */ }

    // 2. Dev fallback: parse `const appVersion = "x.y.z"` from obli.tools/main.go
    try {
      const mainGoPath = path.resolve(__dirname, '../../../../obli.tools/main.go');
      const content = fs.readFileSync(mainGoPath, 'utf-8');
      const match = content.match(/(?:var|const)\s+appVersion\s*=\s*"([^"]+)"/);
      if (match?.[1]) return { version: match[1] };
    } catch { /* not found */ }

    return { version: '0.0.0' };
  },
};
