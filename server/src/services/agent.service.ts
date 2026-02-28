import type { Server as SocketIOServer } from 'socket.io';
import * as fs from 'fs';
import * as path from 'path';
import { db } from '../db';
import type { AgentApiKey, AgentDevice, AgentThresholds } from '@obliview/shared';
import { DEFAULT_AGENT_THRESHOLDS } from '@obliview/shared';
import { heartbeatService } from './heartbeat.service';
import { logger } from '../utils/logger';

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
  approved_by: number | null;
  approved_at: Date | null;
  group_id: number | null;
  created_at: Date;
  updated_at: Date;
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

function rowToDevice(row: AgentDeviceRow): AgentDevice {
  return {
    id: row.id,
    uuid: row.uuid,
    hostname: row.hostname,
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
  };
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
}

// ── In-memory snapshot: indexed by deviceId ─────────────────
export interface AgentPushSnapshot {
  monitorId: number;
  receivedAt: Date;
  metrics: AgentMetrics;
  violations: string[];
  overallStatus: 'up' | 'alert';
}

export const agentPushData = new Map<number, AgentPushSnapshot>();

// ============================================================
// Agent Service
// ============================================================

export const agentService = {

  // ── API Keys ────────────────────────────────────────────

  async listKeys(): Promise<AgentApiKey[]> {
    const rows = await db('agent_api_keys as k')
      .leftJoin('agent_devices as d', 'k.id', 'd.api_key_id')
      .groupBy('k.id')
      .select('k.*', db.raw('COUNT(d.id) as device_count'))
      .orderBy('k.created_at', 'desc') as AgentApiKeyRow[];
    return rows.map(rowToApiKey);
  },

  async createKey(name: string, createdBy: number): Promise<AgentApiKey> {
    const [row] = await db('agent_api_keys')
      .insert({ name, created_by: createdBy })
      .returning('*') as AgentApiKeyRow[];
    return rowToApiKey(row);
  },

  async deleteKey(id: number): Promise<boolean> {
    const count = await db('agent_api_keys').where({ id }).del();
    return count > 0;
  },

  // ── Devices ─────────────────────────────────────────────

  async listDevices(status?: AgentDevice['status']): Promise<AgentDevice[]> {
    const query = db('agent_devices').orderBy('created_at', 'desc');
    if (status) query.where({ status });
    const rows = await query as AgentDeviceRow[];
    return rows.map(rowToDevice);
  },

  async getDeviceById(id: number): Promise<AgentDevice | null> {
    const row = await db('agent_devices').where({ id }).first() as AgentDeviceRow | undefined;
    if (!row) return null;
    return rowToDevice(row);
  },

  async getDeviceByUuid(uuid: string): Promise<AgentDevice | null> {
    const row = await db('agent_devices').where({ uuid }).first() as AgentDeviceRow | undefined;
    if (!row) return null;
    return rowToDevice(row);
  },

  async updateDevice(id: number, data: {
    status?: AgentDevice['status'];
    groupId?: number | null;
    checkIntervalSeconds?: number;
    approvedBy?: number;
    approvedAt?: Date;
    name?: string | null;
    heartbeatMonitoring?: boolean;
  }): Promise<AgentDevice | null> {
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.status !== undefined) update.status = data.status;
    if (data.groupId !== undefined) update.group_id = data.groupId;
    if (data.checkIntervalSeconds !== undefined) update.check_interval_seconds = data.checkIntervalSeconds;
    if (data.approvedBy !== undefined) update.approved_by = data.approvedBy;
    if (data.approvedAt !== undefined) update.approved_at = data.approvedAt;
    if (data.name !== undefined) update.name = data.name;
    if (data.heartbeatMonitoring !== undefined) update.heartbeat_monitoring = data.heartbeatMonitoring;

    const [row] = await db('agent_devices')
      .where({ id })
      .update(update)
      .returning('*') as AgentDeviceRow[];
    if (!row) return null;
    return rowToDevice(row);
  },

  async deleteDevice(id: number): Promise<boolean> {
    // Delete associated monitor first
    await db('monitors').where({ agent_device_id: id }).del();
    const count = await db('agent_devices').where({ id }).del();
    return count > 0;
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
      overallStatus: (hb.status === 'alert' ? 'alert' : 'up') as 'up' | 'alert',
    };

    // Cache it so next call is instant
    agentPushData.set(deviceId, snapshot);
    return snapshot;
  },

  // ── Push endpoint logic ───────────────────────────────────

  async handlePush(
    apiKeyId: number,
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
          status: 'pending',
          check_interval_seconds: 300, // pending: check every 5min
        })
        .returning('*') as AgentDeviceRow[];
      device = rowToDevice(row);
    } else {
      // Update device metadata
      await db('agent_devices')
        .where({ id: device.id })
        .update({
          hostname: payload.hostname,
          ip: clientIp,
          agent_version: payload.agentVersion,
          os_info: payload.osInfo ? JSON.stringify(payload.osInfo) : null,
          updated_at: new Date(),
        });

      // Refresh
      device = (await this.getDeviceByUuid(deviceUuid))!;
    }

    // Handle refused/suspended devices
    if (device.status === 'refused' || device.status === 'suspended') {
      return { status: 'unauthorized' };
    }

    // Handle pending devices
    if (device.status === 'pending') {
      return {
        status: 'pending',
        config: { checkIntervalSeconds: device.checkIntervalSeconds },
      };
    }

    // Device is approved → store single heartbeat
    if (device.status === 'approved') {
      await this._storeMetricsAsHeartbeat(device, payload);

      return {
        status: 'ok',
        config: { checkIntervalSeconds: device.checkIntervalSeconds },
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

    const thresholds: AgentThresholds = monitor.agent_thresholds ?? DEFAULT_AGENT_THRESHOLDS;
    const m = payload.metrics;

    // Evaluate each threshold and build violation list
    const violations: string[] = [];

    if (thresholds.cpu.enabled && m.cpu !== undefined) {
      if (this._isThresholdExceeded(m.cpu.percent, thresholds.cpu)) {
        violations.push(`CPU: ${m.cpu.percent.toFixed(1)}% ${thresholds.cpu.op} ${thresholds.cpu.threshold}%`);
      }
    }

    if (thresholds.memory.enabled && m.memory !== undefined) {
      if (this._isThresholdExceeded(m.memory.percent, thresholds.memory)) {
        violations.push(`RAM: ${m.memory.percent.toFixed(1)}% ${thresholds.memory.op} ${thresholds.memory.threshold}%`);
      }
    }

    if (thresholds.disk.enabled && m.disks) {
      for (const disk of m.disks) {
        if (this._isThresholdExceeded(disk.percent, thresholds.disk)) {
          violations.push(`Disk ${disk.mount}: ${disk.percent.toFixed(1)}% ${thresholds.disk.op} ${thresholds.disk.threshold}%`);
        }
      }
    }

    if (thresholds.netIn.enabled && m.network !== undefined) {
      if (this._isThresholdExceeded(m.network.inBytesPerSec, thresholds.netIn)) {
        // Convert bytes/sec → Mbps (1 Mbps = 125 000 bytes/sec)
        const current = (m.network.inBytesPerSec / 125_000).toFixed(1);
        const limit   = (thresholds.netIn.threshold  / 125_000).toFixed(0);
        violations.push(`Net In: ${current} Mbps ${thresholds.netIn.op} ${limit} Mbps`);
      }
    }

    if (thresholds.netOut.enabled && m.network !== undefined) {
      if (this._isThresholdExceeded(m.network.outBytesPerSec, thresholds.netOut)) {
        const current = (m.network.outBytesPerSec / 125_000).toFixed(1);
        const limit   = (thresholds.netOut.threshold / 125_000).toFixed(0);
        violations.push(`Net Out: ${current} Mbps ${thresholds.netOut.op} ${limit} Mbps`);
      }
    }

    const overallStatus: 'up' | 'alert' = violations.length > 0 ? 'alert' : 'up';
    const message = violations.length > 0 ? violations.join('; ') : 'All metrics OK';

    // Update in-memory snapshot
    const snapshot: AgentPushSnapshot = {
      monitorId: monitor.id,
      receivedAt: new Date(),
      metrics: m,
      violations,
      overallStatus,
    };
    agentPushData.set(device.id, snapshot);

    // Emit real-time update for AgentDetailPage
    if (_io) {
      _io.to('role:admin').emit('agentPush', {
        deviceId: device.id,
        monitorId: monitor.id,
        metrics: m,
        violations,
        overallStatus,
        receivedAt: snapshot.receivedAt.toISOString(),
      });
    }

    // Store heartbeat — include full metrics for DB reconstruction on server restart
    await heartbeatService.create({
      monitorId: monitor.id,
      status: overallStatus,
      message,
      value: JSON.stringify({
        // Summary fields (quick access)
        cpu: m.cpu?.percent,
        memory: m.memory?.percent,
        disks: m.disks?.map(d => ({ mount: d.mount, percent: d.percent })),
        netIn: m.network?.inBytesPerSec,
        netOut: m.network?.outBytesPerSec,
        loadAvg: m.loadAvg,
        // Full metrics for reconstruction
        _full: m,
        _violations: violations,
      }),
    });

    // Update monitor status
    await db('monitors')
      .where({ id: monitor.id })
      .update({ status: overallStatus, updated_at: new Date() });
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
    // Read version from agent/main.go: const agentVersion = "X.X.X"
    try {
      const mainGoPath = path.resolve(__dirname, '../../../../agent/main.go');
      const content = fs.readFileSync(mainGoPath, 'utf-8');
      const match = content.match(/const agentVersion\s*=\s*"([^"]+)"/);
      if (match?.[1]) {
        return { version: match[1] };
      }
    } catch {
      // fallback below
    }
    return { version: '0.0.0' };
  },
};
