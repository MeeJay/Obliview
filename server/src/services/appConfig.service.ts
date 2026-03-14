import { db } from '../db';
import type { AppConfig, AgentGlobalConfig, NotificationTypeConfig, ObliguardConfig, OblimapConfig, OblianceConfig } from '@obliview/shared';
import { DEFAULT_NOTIFICATION_TYPES } from '@obliview/shared';

const AGENT_GLOBAL_CONFIG_KEY = 'agent_global_config';
const OBLIGUARD_CONFIG_KEY    = 'obliguard_config';
const OBLIMAP_CONFIG_KEY      = 'oblimap_config';
const OBLIANCE_CONFIG_KEY     = 'obliance_config';

export const appConfigService = {
  async get(key: string): Promise<string | null> {
    const row = await db('app_config').where({ key }).first('value');
    return row?.value ?? null;
  },

  async set(key: string, value: string): Promise<void> {
    await db('app_config')
      .insert({ key, value })
      .onConflict('key')
      .merge({ value });
  },

  async getAll(): Promise<AppConfig> {
    const rows = await db('app_config').select('key', 'value');
    const map = Object.fromEntries(rows.map((r: { key: string; value: string }) => [r.key, r.value]));

    /** Extract only the URL from a JSON config blob (never expose apiKey) */
    const parseUrl = (key: string): string | null => {
      if (!map[key]) return null;
      try { return (JSON.parse(map[key]) as { url?: string }).url || null; } catch { return null; }
    };

    return {
      allow_2fa: map['allow_2fa'] === 'true',
      force_2fa: map['force_2fa'] === 'true',
      otp_smtp_server_id: map['otp_smtp_server_id'] ? parseInt(map['otp_smtp_server_id'], 10) : null,
      obliguard_url: parseUrl(OBLIGUARD_CONFIG_KEY),
      oblimap_url:   parseUrl(OBLIMAP_CONFIG_KEY),
      obliance_url:  parseUrl(OBLIANCE_CONFIG_KEY),
      enable_foreign_sso:  map['enable_foreign_sso']  === 'true',
      enable_oblimap_sso:  map['enable_oblimap_sso']  === 'true',
      enable_obliance_sso: map['enable_obliance_sso'] === 'true',
    };
  },

  /** Get Obliguard integration config (includes API key — admin only) */
  async getObliguardConfig(): Promise<ObliguardConfig | null> {
    const raw = await this.get(OBLIGUARD_CONFIG_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ObliguardConfig;
    } catch {
      return null;
    }
  },

  /** Save Obliguard integration config */
  async setObliguardConfig(cfg: ObliguardConfig): Promise<void> {
    await this.set(OBLIGUARD_CONFIG_KEY, JSON.stringify(cfg));
  },

  // ── Oblimap integration ─────────────────────────────────────────────────

  /** Get Oblimap integration config (includes API key — admin only) */
  async getOblimapConfig(): Promise<OblimapConfig | null> {
    const raw = await this.get(OBLIMAP_CONFIG_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw) as OblimapConfig; } catch { return null; }
  },

  /** Save Oblimap integration config */
  async setOblimapConfig(cfg: OblimapConfig): Promise<void> {
    await this.set(OBLIMAP_CONFIG_KEY, JSON.stringify(cfg));
  },

  // ── Obliance integration ────────────────────────────────────────────────

  /** Get Obliance integration config (includes API key — admin only) */
  async getOblianceConfig(): Promise<OblianceConfig | null> {
    const raw = await this.get(OBLIANCE_CONFIG_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw) as OblianceConfig; } catch { return null; }
  },

  /** Save Obliance integration config */
  async setOblianceConfig(cfg: OblianceConfig): Promise<void> {
    await this.set(OBLIANCE_CONFIG_KEY, JSON.stringify(cfg));
  },

  /** Get global agent defaults from app_config */
  async getAgentGlobal(): Promise<AgentGlobalConfig> {
    const raw = await this.get(AGENT_GLOBAL_CONFIG_KEY);
    if (!raw) {
      return {
        checkIntervalSeconds: null,
        heartbeatMonitoring: null,
        maxMissedPushes: null,
        notificationTypes: null,
      };
    }
    try {
      return JSON.parse(raw) as AgentGlobalConfig;
    } catch {
      return {
        checkIntervalSeconds: null,
        heartbeatMonitoring: null,
        maxMissedPushes: null,
        notificationTypes: null,
      };
    }
  },

  /** Merge-patch global agent defaults */
  async setAgentGlobal(patch: Partial<AgentGlobalConfig>): Promise<AgentGlobalConfig> {
    const current = await this.getAgentGlobal();
    const updated: AgentGlobalConfig = { ...current, ...patch };
    await this.set(AGENT_GLOBAL_CONFIG_KEY, JSON.stringify(updated));
    return updated;
  },

  /**
   * Read the global notification types (fully resolved — each field falls back to
   * DEFAULT_NOTIFICATION_TYPES when null).
   */
  async getResolvedAgentNotificationTypes(): Promise<{
    global: boolean; down: boolean; up: boolean; alert: boolean; update: boolean;
  }> {
    const cfg = await this.getAgentGlobal();
    const nt: NotificationTypeConfig | null = cfg.notificationTypes ?? null;
    return {
      global: nt?.global ?? DEFAULT_NOTIFICATION_TYPES.global,
      down:   nt?.down   ?? DEFAULT_NOTIFICATION_TYPES.down,
      up:     nt?.up     ?? DEFAULT_NOTIFICATION_TYPES.up,
      alert:  nt?.alert  ?? DEFAULT_NOTIFICATION_TYPES.alert,
      update: nt?.update ?? DEFAULT_NOTIFICATION_TYPES.update,
    };
  },
};
