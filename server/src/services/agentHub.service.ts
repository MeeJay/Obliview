import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import { logger } from '../utils/logger';
import { agentService } from './agent.service';
import { db } from '../db';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentConn {
  ws: WebSocket;
  /** API key row ID — forwarded to agentService.handlePush */
  apiKeyId: number;
  tenantId: number;
  deviceUuid: string;
  clientIp: string;
}

interface AgentHeartbeat {
  type: 'heartbeat';
  hostname?: string;
  agentVersion?: string;
  deviceType?: 'agent' | 'proxy';
  osInfo?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
}

interface AgentAck {
  type: 'ack';
  id: string;
  commandType: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

interface PendingAck {
  deviceUuid: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ── Service ───────────────────────────────────────────────────────────────────

class AgentHubService {
  /** deviceUuid → active connection */
  private byDevice = new Map<string, AgentConn>();

  /** command id → pending ack promise */
  private pendingAcks = new Map<string, PendingAck>();

  constructor() {
    // Ping all connected agents every 15 s to keep connections alive through
    // reverse proxies that close idle connections.
    setInterval(() => {
      for (const [uuid, conn] of this.byDevice) {
        if (conn.ws.readyState === 1 /* OPEN */) {
          try { (conn.ws as any).ping(); } catch { this._unregister(uuid, conn.ws); }
        }
      }
    }, 15_000);
  }

  /**
   * Register an agent WebSocket command channel.
   * Replaces any previous connection for the same UUID cleanly.
   * Drains any pending_command stored in DB immediately on connect.
   */
  async register(
    apiKeyId: number,
    tenantId: number,
    deviceUuid: string,
    clientIp: string,
    ws: WebSocket,
  ): Promise<void> {
    const existing = this.byDevice.get(deviceUuid);
    if (existing && existing.ws.readyState === 1 /* OPEN */) {
      try { existing.ws.close(1000, 'replaced'); } catch {}
    }

    const conn: AgentConn = { ws, apiKeyId, tenantId, deviceUuid, clientIp };
    this.byDevice.set(deviceUuid, conn);

    ws.on('close', () => this._unregister(deviceUuid, ws));
    ws.on('error', () => this._unregister(deviceUuid, ws));
    ws.on('message', async (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'heartbeat') {
          await this._handleHeartbeat(conn, msg as AgentHeartbeat);
        } else if (msg.type === 'ack') {
          this._handleAck(msg as AgentAck);
        } else if (msg.type === 'proxy_result') {
          this._handleProxyResult(msg);
        }
      } catch { /* malformed JSON — ignore */ }
    });

    // Send an initial config response immediately so the agent gets its interval
    // and any queued command without waiting for the first timed heartbeat.
    await this._handleHeartbeat(conn, { type: 'heartbeat' });

    logger.info({ deviceUuid }, 'Obliview agent WS connected');

    // Push proxy monitor configs to the agent so it can start checking immediately.
    this.syncProxyMonitors(deviceUuid).catch((e) =>
      logger.error(e, `Failed to sync proxy monitors on connect for ${deviceUuid}`),
    );
  }

  private _unregister(deviceUuid: string, ws: WebSocket): void {
    const existing = this.byDevice.get(deviceUuid);
    if (existing?.ws === ws) {
      this.byDevice.delete(deviceUuid);
      logger.info({ deviceUuid }, 'Obliview agent WS disconnected');

      // Reject all pending acks for this device so callers don't hang until timeout.
      for (const [id, pending] of this.pendingAcks) {
        if (pending.deviceUuid === deviceUuid) {
          clearTimeout(pending.timer);
          this.pendingAcks.delete(id);
          pending.reject(new Error(`Agent ${deviceUuid} disconnected`));
        }
      }
    }
  }

  private _handleAck(msg: AgentAck): void {
    const pending = this.pendingAcks.get(msg.id);
    if (!pending) return;
    this.pendingAcks.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.success) {
      pending.resolve(msg.result);
    } else {
      pending.reject(new Error(msg.error ?? 'Agent command failed'));
    }
  }

  private async _handleHeartbeat(conn: AgentConn, msg: AgentHeartbeat): Promise<void> {
    try {
      const response = await agentService.handlePush(
        conn.apiKeyId,
        conn.tenantId,
        conn.deviceUuid,
        conn.clientIp,
        {
          hostname: msg.hostname ?? '',
          agentVersion: msg.agentVersion ?? '',
          deviceType: msg.deviceType,
          osInfo: msg.osInfo as any,
          metrics: (msg.metrics ?? {}) as any,
        },
      );

      if (conn.ws.readyState !== 1 /* OPEN */) return;

      // Build config reply — same fields the old HTTP push endpoint returned.
      const configMsg: Record<string, unknown> = { type: 'config' };
      if (response.config?.checkIntervalSeconds) {
        configMsg.checkIntervalSeconds = response.config.checkIntervalSeconds;
      }
      if (response.latestVersion) {
        configMsg.latestVersion = response.latestVersion;
      }
      if (response.command) {
        configMsg.command = response.command;
      }

      conn.ws.send(JSON.stringify(configMsg));
    } catch (e) {
      logger.error(e, 'agentHub: failed to handle heartbeat');
    }
  }

  // ── Proxy result handling ────────────────────────────────────────────────

  private _handleProxyResult(msg: {
    monitorId?: number;
    result?: { status: string; responseTime?: number; statusCode?: number; message?: string; ping?: number; value?: string };
  }): void {
    if (!msg.monitorId || !msg.result) return;
    // Lazy import to avoid circular dependency at module load time.
    const { BaseMonitorWorker } = require('../workers/BaseMonitorWorker');
    BaseMonitorWorker.recordProxyResult(msg.monitorId, msg.result);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  isConnected(deviceUuid: string): boolean {
    const conn = this.byDevice.get(deviceUuid);
    return !!conn && conn.ws.readyState === 1;
  }

  connectedCount(): number {
    return this.byDevice.size;
  }

  /**
   * Send a structured command to a connected agent and wait for its ack.
   * Returns the ack `result` field, or throws on timeout / agent error / disconnect.
   */
  async sendCommandAndWait(
    deviceUuid: string,
    commandType: string,
    payload: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    const conn = this.byDevice.get(deviceUuid);
    if (!conn || conn.ws.readyState !== 1) {
      throw new Error(`Agent ${deviceUuid} is not connected`);
    }

    const id = crypto.randomUUID();
    const msg = JSON.stringify({ type: 'command', id, commandType, payload });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(id);
        reject(new Error(`Timeout waiting for ack from agent ${deviceUuid}`));
      }, timeoutMs);

      this.pendingAcks.set(id, { deviceUuid, resolve, reject, timer });
      conn.ws.send(msg);
    });
  }

  /**
   * Send the list of proxy monitor configs to a specific agent.
   * Called on agent connect and when a proxy monitor is created/updated/deleted.
   */
  async syncProxyMonitors(deviceUuid: string): Promise<void> {
    const conn = this.byDevice.get(deviceUuid);
    if (!conn || conn.ws.readyState !== 1) return;

    // Find the agent_device row for this UUID to get the device ID + tenant.
    const device = await db('agent_devices').where({ uuid: deviceUuid }).select('id', 'tenant_id').first() as { id: number; tenant_id: number } | undefined;
    if (!device) return;

    // Fetch all active monitors that use this device as proxy — scoped to the
    // device's tenant as defence-in-depth against cross-tenant config leaks.
    // The service layer already blocks cross-tenant assignment on create/update,
    // but this additional filter prevents any legacy rows or bypass from
    // leaking a tenant's monitor configuration to another tenant's proxy.
    const monitors = await db('monitors')
      .where({ proxy_agent_device_id: device.id, is_active: true, tenant_id: device.tenant_id })
      .select(
        'id', 'type', 'interval_seconds', 'timeout_ms',
        'url', 'method', 'headers', 'body', 'expected_status_codes',
        'keyword', 'keyword_is_present', 'ignore_ssl',
        'json_path', 'json_expected_value',
        'hostname', 'port',
        'dns_record_type', 'dns_resolver', 'dns_expected_value',
        'ssl_warn_days',
        'smtp_host', 'smtp_port',
        'game_type', 'game_host', 'game_port',
      );

    const configs = monitors.map((m: Record<string, unknown>) => ({
      monitorId: m.id,
      type: m.type,
      intervalSeconds: m.interval_seconds ?? 60,
      timeoutMs: m.timeout_ms ?? 10000,
      url: m.url, method: m.method, headers: m.headers, body: m.body,
      expectedStatusCodes: m.expected_status_codes,
      keyword: m.keyword, keywordIsPresent: m.keyword_is_present,
      ignoreSsl: m.ignore_ssl,
      jsonPath: m.json_path, jsonExpectedValue: m.json_expected_value,
      hostname: m.hostname, port: m.port,
      dnsRecordType: m.dns_record_type, dnsResolver: m.dns_resolver, dnsExpectedValue: m.dns_expected_value,
      sslWarnDays: m.ssl_warn_days,
      smtpHost: m.smtp_host, smtpPort: m.smtp_port,
      gameType: m.game_type, gameHost: m.game_host, gamePort: m.game_port,
    }));

    conn.ws.send(JSON.stringify({ type: 'proxy_sync', monitors: configs }));
    logger.info({ deviceUuid, count: configs.length }, 'Synced proxy monitors to agent');
  }

  /**
   * Sync proxy monitors to ALL connected agents.
   * Called when a proxy monitor is created, updated, or deleted.
   */
  async syncAllProxyMonitors(): Promise<void> {
    for (const [uuid] of this.byDevice) {
      await this.syncProxyMonitors(uuid).catch((e) =>
        logger.error(e, `Failed to sync proxy monitors to ${uuid}`),
      );
    }
  }
}

export const agentHub = new AgentHubService();
