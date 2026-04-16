import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import { logger } from '../utils/logger';
import { agentService } from './agent.service';

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
        }
      } catch { /* malformed JSON — ignore */ }
    });

    // Send an initial config response immediately so the agent gets its interval
    // and any queued command without waiting for the first timed heartbeat.
    await this._handleHeartbeat(conn, { type: 'heartbeat' });

    logger.info({ deviceUuid }, 'Obliview agent WS connected');
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
}

export const agentHub = new AgentHubService();
