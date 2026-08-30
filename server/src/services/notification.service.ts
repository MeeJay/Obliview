import { db } from '../db';
import type { NotificationChannel, NotificationBinding, NotificationTypeConfig, OverrideMode } from '@obliview/shared';
import { DEFAULT_NOTIFICATION_TYPES } from '@obliview/shared';
import type { NotificationPayload } from '../notifications/types';
import { getPlugin } from '../notifications/registry';
import { smtpServerService } from './smtpServer.service';
import { config } from '../config';
import { logger } from '../utils/logger';

interface ChannelRow {
  id: number;
  name: string;
  type: string;
  config: Record<string, unknown>;
  is_enabled: boolean;
  created_by: number | null;
  tenant_id: number;
  created_at: Date;
  updated_at: Date;
}

interface BindingRow {
  id: number;
  channel_id: number;
  scope: string;
  scope_id: number | null;
  override_mode: string;
}

function rowToChannel(row: ChannelRow, currentTenantId?: number): NotificationChannel {
  const ch: NotificationChannel = {
    id: row.id,
    name: row.name,
    type: row.type,
    config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
    isEnabled: row.is_enabled,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
  if (currentTenantId !== undefined) {
    ch.tenantId = row.tenant_id;
    ch.isShared = row.tenant_id !== currentTenantId;
  }
  return ch;
}

// ─── Alert-spine enrichment (Oblidesk) ───────────────────────────────────────
// Every outbound notification is stamped with a stable identity so a downstream
// service desk can dedupe, auto-resolve and bind the alert to a device.
// Resolution is one small query per monitor/group, cached with a short TTL
// because this runs on every single notification.

const IDENTITY_TTL_MS = 60_000; // 60 seconds — same TTL as the maintenance cache

interface MonitorIdentity {
  monitorType?: string;
  agentDeviceId: number | null;
  deviceUuid: string | null;
  tenantId?: number;
  tenantSlug?: string;
}

interface IdentityCacheEntry {
  value: MonitorIdentity;
  cachedAt: number;
}

const monitorIdentityCache = new Map<number, IdentityCacheEntry>();
const groupIdentityCache = new Map<number, IdentityCacheEntry>();

function getCachedIdentity(cache: Map<number, IdentityCacheEntry>, key: number): MonitorIdentity | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > IDENTITY_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

/** monitor → tenant slug + agent device uuid, in a single left-joined row. */
async function resolveMonitorIdentity(monitorId: number): Promise<MonitorIdentity> {
  const cached = getCachedIdentity(monitorIdentityCache, monitorId);
  if (cached !== null) return cached;

  const row = await db('monitors')
    .leftJoin('tenants', 'tenants.id', 'monitors.tenant_id')
    .leftJoin('agent_devices', 'agent_devices.id', 'monitors.agent_device_id')
    .where('monitors.id', monitorId)
    .first(
      'monitors.type as type',
      'monitors.tenant_id as tenant_id',
      'monitors.agent_device_id as agent_device_id',
      'tenants.slug as tenant_slug',
      'agent_devices.uuid as device_uuid',
    ) as
      | { type: string | null; tenant_id: number | null; agent_device_id: number | null; tenant_slug: string | null; device_uuid: string | null }
      | undefined;

  const identity: MonitorIdentity = {
    monitorType: row?.type ?? undefined,
    agentDeviceId: row?.agent_device_id ?? null,
    deviceUuid: row?.device_uuid ?? null,
    tenantId: row?.tenant_id ?? undefined,
    tenantSlug: row?.tenant_slug ?? undefined,
  };
  monitorIdentityCache.set(monitorId, { value: identity, cachedAt: Date.now() });
  return identity;
}

/** group → tenant slug. Groups carry no device, so those stay null. */
async function resolveGroupIdentity(groupId: number): Promise<MonitorIdentity> {
  const cached = getCachedIdentity(groupIdentityCache, groupId);
  if (cached !== null) return cached;

  const row = await db('monitor_groups')
    .leftJoin('tenants', 'tenants.id', 'monitor_groups.tenant_id')
    .where('monitor_groups.id', groupId)
    .first('monitor_groups.tenant_id as tenant_id', 'tenants.slug as tenant_slug') as
      | { tenant_id: number | null; tenant_slug: string | null }
      | undefined;

  const identity: MonitorIdentity = {
    agentDeviceId: null,
    deviceUuid: null,
    tenantId: row?.tenant_id ?? undefined,
    tenantSlug: row?.tenant_slug ?? undefined,
  };
  groupIdentityCache.set(groupId, { value: identity, cachedAt: Date.now() });
  return identity;
}

/**
 * Map an Obliview monitor status onto the three-level severity a service desk
 * uses for ticket priority. 'ssl_expired' is grouped with the criticals because
 * BaseMonitorWorker already treats it as a hard problem status.
 */
function severityForStatus(status: string): 'info' | 'warning' | 'critical' {
  switch (status) {
    case 'down':
    case 'alert':
    case 'ssl_expired':
      return 'critical';
    case 'ssl_warning':
    case 'pending':
    case 'value_changed':
      return 'warning';
    case 'up':
    case 'inactive':
    case 'maintenance':
      return 'info';
    default:
      return 'warning';
  }
}

// In-process occurrence counter per stableKey: how many times this alert has
// fired since its last recovery. Feeds Oblidesk's flap detection. Resets on
// recovery and on server restart (it is a hint, not a ledger).
const OCCURRENCE_TTL_MS = 24 * 60 * 60 * 1000;
const occurrenceCounts = new Map<string, { count: number; updatedAt: number }>();

function nextOccurrenceCount(stableKey: string, isRecovery: boolean): number {
  const now = Date.now();
  const entry = occurrenceCounts.get(stableKey);
  const current = entry && now - entry.updatedAt <= OCCURRENCE_TTL_MS ? entry.count : 0;

  if (isRecovery) {
    // Report how many times the alert being resolved had fired, then forget it.
    occurrenceCounts.delete(stableKey);
    return current;
  }

  // Lazy prune so a long-lived process with churning keys cannot grow unbounded.
  if (occurrenceCounts.size > 500) {
    for (const [key, value] of occurrenceCounts) {
      if (now - value.updatedAt > OCCURRENCE_TTL_MS) occurrenceCounts.delete(key);
    }
  }

  const next = current + 1;
  occurrenceCounts.set(stableKey, { count: next, updatedAt: now });
  return next;
}

/**
 * Stamp a payload with the alert-spine identity fields.
 * Note on maintenance: Obliview already suppresses notifications during a
 * maintenance window upstream (BaseMonitorWorker.handleStatusChange returns
 * before dispatching, and maintenanceService.isInMaintenance owns that decision
 * with its own 60s cache). We do NOT re-check it here — we only forward whatever
 * the caller already knows, so the consumer sees the same verdict Obliview used.
 */
async function enrichPayload(
  payload: NotificationPayload,
  identity: MonitorIdentity,
  stableKey: string,
  extra: { monitorId?: number },
): Promise<NotificationPayload> {
  const isRecovery = payload.newStatus === 'up';
  return {
    ...payload,
    appName: config.appName,
    ...extra,
    monitorType: identity.monitorType,
    agentDeviceId: identity.agentDeviceId,
    deviceUuid: identity.deviceUuid,
    tenantId: identity.tenantId,
    tenantSlug: identity.tenantSlug,
    stableKey,
    severity: severityForStatus(payload.newStatus),
    isRecovery,
    // The real state-change time carried in the payload — never "now" at send time.
    recoveredAt: isRecovery ? payload.timestamp : undefined,
    occurrenceCount: nextOccurrenceCount(stableKey, isRecovery),
    inMaintenance: payload.inMaintenance ?? false,
    suppressedReason: payload.suppressedReason ?? null,
  };
}

function rowToBinding(row: BindingRow): NotificationBinding {
  return {
    id: row.id,
    channelId: row.channel_id,
    scope: row.scope as NotificationBinding['scope'],
    scopeId: row.scope_id,
    overrideMode: row.override_mode as OverrideMode,
  };
}

export const notificationService = {
  // ── Channel CRUD ──

  async getAllChannels(tenantId: number | null): Promise<NotificationChannel[]> {
    if (tenantId === null) {
      const rows = await db<ChannelRow>('notification_channels').orderBy('name');
      return rows.map((row) => rowToChannel(row));
    }
    // Own channels + channels shared to this tenant via the junction table
    const rows = await db<ChannelRow>('notification_channels')
      .where(function () {
        this.where('notification_channels.tenant_id', tenantId)
          .orWhereIn(
            'notification_channels.id',
            db('notification_channel_tenants').select('channel_id').where({ tenant_id: tenantId }),
          );
      })
      .orderBy('name');
    return rows.map((row) => rowToChannel(row, tenantId));
  },

  async getChannelById(id: number): Promise<NotificationChannel | null> {
    const row = await db<ChannelRow>('notification_channels').where({ id }).first();
    return row ? rowToChannel(row) : null;
  },

  async createChannel(data: {
    name: string;
    type: string;
    config: Record<string, unknown>;
    isEnabled?: boolean;
    createdBy?: number;
  }, tenantId: number): Promise<NotificationChannel> {
    const plugin = getPlugin(data.type);
    if (!plugin) throw new Error(`Unknown notification type: ${data.type}`);

    const [row] = await db<ChannelRow>('notification_channels')
      .insert({
        name: data.name,
        type: data.type,
        config: JSON.stringify(data.config) as unknown as Record<string, unknown>,
        is_enabled: data.isEnabled ?? true,
        created_by: data.createdBy ?? null,
        tenant_id: tenantId,
      })
      .returning('*');

    return rowToChannel(row);
  },

  async updateChannel(id: number, data: {
    name?: string;
    config?: Record<string, unknown>;
    isEnabled?: boolean;
  }): Promise<NotificationChannel | null> {
    const updateData: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) updateData.name = data.name;
    if (data.config !== undefined) updateData.config = JSON.stringify(data.config);
    if (data.isEnabled !== undefined) updateData.is_enabled = data.isEnabled;

    const [row] = await db<ChannelRow>('notification_channels')
      .where({ id })
      .update(updateData)
      .returning('*');
    return row ? rowToChannel(row) : null;
  },

  async deleteChannel(id: number): Promise<boolean> {
    const count = await db('notification_channels').where({ id }).del();
    return count > 0;
  },

  // ── Cross-tenant channel sharing ──

  /** Returns the list of tenant IDs the channel is shared to (not including its own tenant). */
  async getChannelTenants(channelId: number): Promise<number[]> {
    const rows = await db('notification_channel_tenants')
      .where({ channel_id: channelId })
      .select('tenant_id');
    return rows.map((r: { tenant_id: number }) => r.tenant_id);
  },

  /** Replaces the sharing list for a channel (full replace — not additive). */
  async setChannelTenants(channelId: number, tenantIds: number[]): Promise<void> {
    await db.transaction(async (trx) => {
      await trx('notification_channel_tenants').where({ channel_id: channelId }).del();
      if (tenantIds.length > 0) {
        await trx('notification_channel_tenants').insert(
          tenantIds.map((tenant_id) => ({ channel_id: channelId, tenant_id })),
        );
      }
    });
  },

  /**
   * Resolve the effective config for a channel.
   * For smtp channels using smtpServerId, fetches the SMTP server and injects its credentials.
   * For all other channels, returns config as-is (backward-compat).
   */
  async resolveChannelConfig(channel: NotificationChannel): Promise<Record<string, unknown>> {
    if (channel.type === 'smtp' && channel.config.smtpServerId) {
      const server = await smtpServerService.getTransportConfig(Number(channel.config.smtpServerId));
      if (!server) throw new Error(`SMTP server #${channel.config.smtpServerId} not found`);
      return {
        host: server.host,
        port: server.port,
        secure: server.secure,
        username: server.username,
        password: server.password,
        from: channel.config.fromOverride || server.fromAddress,
        to: channel.config.to,
      };
    }
    return channel.config;
  },

  async testChannel(id: number): Promise<void> {
    const channel = await this.getChannelById(id);
    if (!channel) throw new Error('Channel not found');

    const plugin = getPlugin(channel.type);
    if (!plugin) throw new Error(`No plugin for type: ${channel.type}`);

    const resolvedConfig = await this.resolveChannelConfig(channel);
    await plugin.sendTest(resolvedConfig);
  },

  // ── Bindings ──

  async getBindings(scope: string, scopeId: number | null): Promise<NotificationBinding[]> {
    const rows = await db<BindingRow>('notification_bindings')
      .where({ scope, scope_id: scopeId });
    return rows.map(rowToBinding);
  },

  async addBinding(channelId: number, scope: string, scopeId: number | null, overrideMode: OverrideMode = 'merge'): Promise<NotificationBinding> {
    const [row] = await db<BindingRow>('notification_bindings')
      .insert({
        channel_id: channelId,
        scope,
        scope_id: scopeId,
        override_mode: overrideMode,
      })
      .onConflict(['channel_id', 'scope', 'scope_id'])
      .merge({ override_mode: overrideMode })
      .returning('*');
    return rowToBinding(row);
  },

  async removeBinding(channelId: number, scope: string, scopeId: number | null): Promise<boolean> {
    const count = await db('notification_bindings')
      .where({ channel_id: channelId, scope, scope_id: scopeId })
      .del();
    return count > 0;
  },

  // ── Resolution (merge/replace/exclude inheritance) ──

  /**
   * Apply a set of bindings to the current channel set.
   * 1. If any binding has 'replace' mode → clear the set first
   * 2. Add all 'merge' (and 'replace') bindings to the set
   * 3. Remove all 'exclude' bindings from the set
   */
  _applyBindings(channelIds: Set<number>, bindings: NotificationBinding[]): Set<number> {
    if (bindings.length === 0) return channelIds;

    const hasReplace = bindings.some((b) => b.overrideMode === 'replace');
    if (hasReplace) {
      channelIds = new Set();
    }

    // Add merge/replace bindings
    for (const b of bindings) {
      if (b.overrideMode !== 'exclude') {
        channelIds.add(b.channelId);
      }
    }

    // Remove exclude bindings
    for (const b of bindings) {
      if (b.overrideMode === 'exclude') {
        channelIds.delete(b.channelId);
      }
    }

    return channelIds;
  },

  /**
   * Resolve which channels should fire for a given monitor.
   * Chain: Global → Group ancestors (root→leaf) → Monitor
   * 'merge' = add to parent channels, 'replace' = discard parent channels at that level,
   * 'exclude' = remove a specific channel from the inherited set.
   */
  async resolveChannelsForMonitor(monitorId: number, groupId: number | null, agentDeviceId?: number | null): Promise<number[]> {
    let channelIds: Set<number> = new Set();

    // 1. Global bindings
    const globalBindings = await this.getBindings('global', null);
    channelIds = this._applyBindings(channelIds, globalBindings);

    // 2. Group chain (root → leaf)
    if (groupId !== null) {
      const ancestorRows = await db('group_closure')
        .where('descendant_id', groupId)
        .orderBy('depth', 'desc')
        .select('ancestor_id');

      for (const row of ancestorRows) {
        const groupBindings = await this.getBindings('group', row.ancestor_id);
        channelIds = this._applyBindings(channelIds, groupBindings);
      }
    }

    // 3. Monitor bindings
    const monitorBindings = await this.getBindings('monitor', monitorId);
    channelIds = this._applyBindings(channelIds, monitorBindings);

    // 4. Agent device bindings (when this monitor is backed by an agent device).
    //    Agent-level channel overrides are stored under scope='agent'/scope_id=deviceId
    //    and must be applied AFTER the monitor bindings so device-level config wins.
    if (agentDeviceId) {
      const agentBindings = await this.getBindings('agent', agentDeviceId);
      channelIds = this._applyBindings(channelIds, agentBindings);
    }

    return Array.from(channelIds);
  },

  /**
   * Resolve bindings for a scope WITH source info (for the UI).
   * Shows which channels are active and where they come from.
   * Also tracks excluded channels so the UI can show "Unbind" state.
   */
  async resolveBindingsWithSources(
    scope: 'group' | 'monitor',
    scopeId: number,
    groupId?: number | null,
  ): Promise<{
    channelId: number;
    channelName: string;
    channelType: string;
    source: 'global' | 'group' | 'monitor';
    sourceId: number | null;
    sourceName: string;
    isDirect: boolean;
    isExcluded: boolean;
  }[]> {
    interface SourceInfo {
      channelId: number;
      source: 'global' | 'group' | 'monitor';
      sourceId: number | null;
      sourceName: string;
      isDirect: boolean;
      isExcluded: boolean;
    }

    // Build the inheritance chain
    const result: Map<number, SourceInfo> = new Map();
    // Track excluded channel IDs separately for the final output
    const excludedSet: Set<number> = new Set();

    const applyBindingsWithSources = (
      bindings: NotificationBinding[],
      source: SourceInfo['source'],
      sourceId: number | null,
      sourceName: string,
      isDirect: boolean,
    ) => {
      if (bindings.length === 0) return;

      const hasReplace = bindings.some((b) => b.overrideMode === 'replace');
      if (hasReplace) {
        result.clear();
        excludedSet.clear();
      }

      // Add merge/replace bindings
      for (const b of bindings) {
        if (b.overrideMode !== 'exclude') {
          result.set(b.channelId, {
            channelId: b.channelId,
            source,
            sourceId,
            sourceName,
            isDirect,
            isExcluded: false,
          });
          excludedSet.delete(b.channelId);
        }
      }

      // Process excludes
      for (const b of bindings) {
        if (b.overrideMode === 'exclude') {
          // Keep the entry in result (for UI to show it) but mark as excluded
          const existing = result.get(b.channelId);
          if (existing) {
            existing.isExcluded = true;
          }
          excludedSet.add(b.channelId);
        }
      }
    };

    // 1. Global bindings
    const globalBindings = await this.getBindings('global', null);
    applyBindingsWithSources(globalBindings, 'global', null, 'Global', false);

    // 2. Group chain (for monitor scope: walk group ancestors; for group scope: walk parent ancestors)
    const effectiveGroupId = scope === 'monitor' ? groupId : null;

    // For group scope, walk the parent chain (ancestors of this group)
    if (scope === 'group') {
      const ancestorRows = await db('group_closure')
        .where('descendant_id', scopeId)
        .where('depth', '>', 0) // exclude self
        .orderBy('depth', 'desc')
        .select('ancestor_id');

      for (const row of ancestorRows) {
        const groupBindings = await this.getBindings('group', row.ancestor_id);
        const groupRow = await db('monitor_groups').where({ id: row.ancestor_id }).first('name');
        applyBindingsWithSources(
          groupBindings,
          'group',
          row.ancestor_id,
          groupRow?.name || `Group #${row.ancestor_id}`,
          false,
        );
      }
    }

    // For monitor scope, walk all group ancestors (including the direct group)
    if (scope === 'monitor' && effectiveGroupId !== null && effectiveGroupId !== undefined) {
      const ancestorRows = await db('group_closure')
        .where('descendant_id', effectiveGroupId)
        .orderBy('depth', 'desc')
        .select('ancestor_id');

      for (const row of ancestorRows) {
        const groupBindings = await this.getBindings('group', row.ancestor_id);
        const groupRow = await db('monitor_groups').where({ id: row.ancestor_id }).first('name');
        applyBindingsWithSources(
          groupBindings,
          'group',
          row.ancestor_id,
          groupRow?.name || `Group #${row.ancestor_id}`,
          false,
        );
      }
    }

    // 3. Direct bindings at this scope
    const directBindings = await this.getBindings(scope, scopeId);
    applyBindingsWithSources(directBindings, scope, scopeId, 'Direct', true);

    // Enrich with channel name/type
    const channelIds = Array.from(result.keys());
    if (channelIds.length === 0) return [];

    const channels = await db<ChannelRow>('notification_channels').whereIn('id', channelIds);
    const channelMap = new Map(channels.map((c) => [c.id, c]));

    return Array.from(result.values()).map((r) => {
      const ch = channelMap.get(r.channelId);
      return {
        ...r,
        channelName: ch?.name || `Channel #${r.channelId}`,
        channelType: ch?.type || 'unknown',
      };
    });
  },

  // ── Send notifications ──

  async sendForMonitor(
    monitorId: number,
    groupId: number | null,
    payload: NotificationPayload,
    agentDeviceId?: number | null,
  ): Promise<void> {
    const channelIds = await this.resolveChannelsForMonitor(monitorId, groupId, agentDeviceId);
    if (channelIds.length === 0) {
      logger.warn(`No notification channels resolved for monitor ${monitorId} (event: ${payload.newStatus}) — check global/group/monitor bindings`);
      return;
    }

    // Enrich payload with app name from config + alert-spine identity
    const enrichedPayload: NotificationPayload = await enrichPayload(
      payload,
      await resolveMonitorIdentity(monitorId),
      `obliview:monitor:${monitorId}`,
      { monitorId },
    );

    const channels = await db<ChannelRow>('notification_channels')
      .whereIn('id', channelIds)
      .where({ is_enabled: true });

    for (const row of channels) {
      const channel = rowToChannel(row);
      const plugin = getPlugin(channel.type);
      if (!plugin) {
        logger.warn(`No plugin for notification type "${channel.type}"`);
        continue;
      }

      try {
        const resolvedConfig = await this.resolveChannelConfig(channel);
        await plugin.send(resolvedConfig, enrichedPayload);
        await this.logNotification(channel.id, monitorId, 'status_change', true);
        logger.info(`Notification sent: ${channel.name} (${channel.type}) for monitor ${payload.monitorName}`);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : 'Unknown error';
        await this.logNotification(channel.id, monitorId, 'status_change', false, errMsg);
        logger.error(`Notification failed: ${channel.name} (${channel.type}): ${errMsg}`);
      }
    }
  },

  /**
   * Resolve channels for a group-level notification.
   * Chain: Global → Group ancestors (root→leaf, including the group itself).
   * No monitor-level bindings are included.
   */
  async resolveChannelsForGroup(groupId: number): Promise<number[]> {
    let channelIds: Set<number> = new Set();

    // 1. Global bindings
    const globalBindings = await this.getBindings('global', null);
    channelIds = this._applyBindings(channelIds, globalBindings);

    // 2. Group chain (root → leaf, including self via depth >= 0)
    const ancestorRows = await db('group_closure')
      .where('descendant_id', groupId)
      .orderBy('depth', 'desc')
      .select('ancestor_id');

    for (const row of ancestorRows) {
      const groupBindings = await this.getBindings('group', row.ancestor_id);
      channelIds = this._applyBindings(channelIds, groupBindings);
    }

    return Array.from(channelIds);
  },

  /**
   * Resolve which channels should fire for a given agent device.
   * Chain: Global → Agent Group ancestors (root→leaf) → Agent-level bindings.
   */
  async resolveChannelsForAgent(deviceId: number): Promise<number[]> {
    let channelIds: Set<number> = new Set();

    // 1. Global bindings
    const globalBindings = await this.getBindings('global', null);
    channelIds = this._applyBindings(channelIds, globalBindings);

    // 2. Agent group hierarchy (root → leaf)
    const device = await db('agent_devices').where({ id: deviceId }).select('group_id').first() as { group_id: number | null } | undefined;
    if (device?.group_id) {
      const ancestorRows = await db('group_closure')
        .where('descendant_id', device.group_id)
        .orderBy('depth', 'desc')
        .select('ancestor_id');

      for (const row of ancestorRows) {
        const groupBindings = await this.getBindings('group', row.ancestor_id);
        channelIds = this._applyBindings(channelIds, groupBindings);
      }
    }

    // 3. Agent-level bindings
    const agentBindings = await this.getBindings('agent', deviceId);
    channelIds = this._applyBindings(channelIds, agentBindings);

    return Array.from(channelIds);
  },

  /**
   * Resolve bindings for an agent device WITH source info (for the UI).
   * Chain: Global → Agent Group ancestors (root→leaf) → Agent-level bindings.
   */
  async resolveBindingsWithSourcesForAgent(
    deviceId: number,
  ): Promise<{
    channelId: number;
    channelName: string;
    channelType: string;
    source: 'global' | 'group' | 'agent';
    sourceId: number | null;
    sourceName: string;
    isDirect: boolean;
    isExcluded: boolean;
  }[]> {
    interface SourceInfo {
      channelId: number;
      source: 'global' | 'group' | 'agent';
      sourceId: number | null;
      sourceName: string;
      isDirect: boolean;
      isExcluded: boolean;
    }

    const result: Map<number, SourceInfo> = new Map();
    const excludedSet: Set<number> = new Set();

    const applyBindingsWithSources = (
      bindings: NotificationBinding[],
      source: SourceInfo['source'],
      sourceId: number | null,
      sourceName: string,
      isDirect: boolean,
    ) => {
      if (bindings.length === 0) return;

      const hasReplace = bindings.some((b) => b.overrideMode === 'replace');
      if (hasReplace) {
        result.clear();
        excludedSet.clear();
      }

      for (const b of bindings) {
        if (b.overrideMode !== 'exclude') {
          result.set(b.channelId, {
            channelId: b.channelId,
            source,
            sourceId,
            sourceName,
            isDirect,
            isExcluded: false,
          });
          excludedSet.delete(b.channelId);
        }
      }

      for (const b of bindings) {
        if (b.overrideMode === 'exclude') {
          const existing = result.get(b.channelId);
          if (existing) {
            existing.isExcluded = true;
          }
          excludedSet.add(b.channelId);
        }
      }
    };

    // 1. Global bindings
    const globalBindings = await this.getBindings('global', null);
    applyBindingsWithSources(globalBindings, 'global', null, 'Global', false);

    // 2. Agent group hierarchy (root → leaf)
    const device = await db('agent_devices').where({ id: deviceId }).select('group_id').first() as { group_id: number | null } | undefined;
    if (device?.group_id) {
      const ancestorRows = await db('group_closure')
        .where('descendant_id', device.group_id)
        .orderBy('depth', 'desc')
        .select('ancestor_id');

      for (const row of ancestorRows) {
        const groupBindings = await this.getBindings('group', row.ancestor_id);
        const groupRow = await db('monitor_groups').where({ id: row.ancestor_id }).first('name') as { name: string } | undefined;
        applyBindingsWithSources(
          groupBindings,
          'group',
          row.ancestor_id,
          groupRow?.name || `Group #${row.ancestor_id}`,
          false,
        );
      }
    }

    // 3. Agent-level bindings
    const agentBindings = await this.getBindings('agent', deviceId);
    applyBindingsWithSources(agentBindings, 'agent', deviceId, 'Direct', true);

    // Enrich with channel name/type
    const channelIds = Array.from(result.keys());
    if (channelIds.length === 0) return [];

    const channels = await db<ChannelRow>('notification_channels').whereIn('id', channelIds);
    const channelMap = new Map(channels.map((c) => [c.id, c]));

    return Array.from(result.values()).map((r) => {
      const ch = channelMap.get(r.channelId);
      return {
        ...r,
        channelName: ch?.name || `Channel #${r.channelId}`,
        channelType: ch?.type || 'unknown',
      };
    });
  },

  /**
   * Resolve the effective notification types for an agent device.
   * Chain: device notification_types → group agentGroupConfig.notificationTypes (ancestor chain) → system defaults.
   * Each field uses the first non-null value found in the chain.
   */
  async resolveNotificationTypesForDevice(deviceId: number): Promise<{
    global: boolean; down: boolean; up: boolean; alert: boolean; update: boolean;
  }> {
    // Accumulated values — undefined means "not yet resolved"
    let global: boolean | undefined;
    let down: boolean | undefined;
    let up: boolean | undefined;
    let alert: boolean | undefined;
    let update: boolean | undefined;

    const applyConfig = (cfg: NotificationTypeConfig | null | undefined) => {
      if (!cfg) return;
      if (global === undefined && cfg.global !== null && cfg.global !== undefined) global = cfg.global;
      if (down   === undefined && cfg.down   !== null && cfg.down   !== undefined) down   = cfg.down;
      if (up     === undefined && cfg.up     !== null && cfg.up     !== undefined) up     = cfg.up;
      if (alert  === undefined && cfg.alert  !== null && cfg.alert  !== undefined) alert  = cfg.alert;
      if (update === undefined && cfg.update !== null && cfg.update !== undefined) update = cfg.update;
    };

    // 1. Device-level override
    const deviceRow = await db('agent_devices')
      .where({ id: deviceId })
      .select('group_id', 'notification_types')
      .first() as { group_id: number | null; notification_types: unknown } | undefined;

    if (deviceRow?.notification_types) {
      const nt = typeof deviceRow.notification_types === 'string'
        ? JSON.parse(deviceRow.notification_types)
        : deviceRow.notification_types as NotificationTypeConfig;
      applyConfig(nt);
    }

    // 2. Walk up the group hierarchy (leaf → root)
    if (deviceRow?.group_id) {
      const ancestorRows = await db('group_closure')
        .where('descendant_id', deviceRow.group_id)
        .orderBy('depth', 'asc')
        .select('ancestor_id');

      for (const row of ancestorRows) {
        const groupRow = await db('monitor_groups')
          .where({ id: row.ancestor_id })
          .select('agent_group_config')
          .first() as { agent_group_config: unknown } | undefined;
        if (groupRow?.agent_group_config) {
          const cfg = typeof groupRow.agent_group_config === 'string'
            ? JSON.parse(groupRow.agent_group_config)
            : groupRow.agent_group_config as { notificationTypes?: NotificationTypeConfig | null };
          applyConfig(cfg.notificationTypes);
        }
      }
    }

    // 3. Global agent defaults (from app_config agent_global_config)
    if (global === undefined || down === undefined || up === undefined || alert === undefined || update === undefined) {
      const { appConfigService } = await import('./appConfig.service');
      const globalTypes = await appConfigService.getResolvedAgentNotificationTypes();
      if (global === undefined) global = globalTypes.global;
      if (down   === undefined) down   = globalTypes.down;
      if (up     === undefined) up     = globalTypes.up;
      if (alert  === undefined) alert  = globalTypes.alert;
      if (update === undefined) update = globalTypes.update;
    }

    // 4. Hardcoded system defaults for any still-unresolved fields
    return {
      global: global ?? DEFAULT_NOTIFICATION_TYPES.global,
      down:   down   ?? DEFAULT_NOTIFICATION_TYPES.down,
      up:     up     ?? DEFAULT_NOTIFICATION_TYPES.up,
      alert:  alert  ?? DEFAULT_NOTIFICATION_TYPES.alert,
      update: update ?? DEFAULT_NOTIFICATION_TYPES.update,
    };
  },

  /**
   * Send notifications for an agent device threshold alert.
   * Resolves channels using the global → agent chain.
   */
  async sendForAgent(
    deviceId: number,
    deviceName: string,
    newStatus: string,
    previousStatus: string,
    violations?: string[],
    notifType?: 'alert' | 'up' | 'update',
  ): Promise<void> {
    // Only notify on status transitions (up → alert or alert → up)
    if (newStatus === previousStatus) return;

    // Check notification type preferences
    const types = await this.resolveNotificationTypesForDevice(deviceId);
    if (!types.global) {
      logger.info(`Agent notification suppressed (global=off) for device ${deviceId}`);
      return;
    }
    const effectiveType = notifType ?? (newStatus === 'alert' ? 'alert' : 'up');
    if (effectiveType === 'alert' && !types.alert) {
      logger.info(`Agent notification suppressed (alert type disabled) for device ${deviceId}`);
      return;
    }
    if (effectiveType === 'up' && !types.up) {
      logger.info(`Agent notification suppressed (up type disabled) for device ${deviceId}`);
      return;
    }
    if (effectiveType === 'update' && !types.update) {
      logger.info(`Agent notification suppressed (update type disabled) for device ${deviceId}`);
      return;
    }

    const channelIds = await this.resolveChannelsForAgent(deviceId);
    if (channelIds.length === 0) {
      logger.warn(`No notification channels resolved for agent device ${deviceId} (event: ${newStatus}) — check global/agent bindings`);
      return;
    }

    const payload: NotificationPayload = {
      monitorName: deviceName,
      oldStatus: previousStatus,
      newStatus,
      message: newStatus === 'alert'
        ? (violations && violations.length > 0
            ? violations.join('; ')
            : `Agent device "${deviceName}" has threshold violations`)
        : `Agent device "${deviceName}" metrics are back to normal`,
      timestamp: new Date().toISOString(),
      appName: config.appName,
    };

    const channels = await db<ChannelRow>('notification_channels')
      .whereIn('id', channelIds)
      .where({ is_enabled: true });

    for (const row of channels) {
      const channel = rowToChannel(row);
      const plugin = getPlugin(channel.type);
      if (!plugin) {
        logger.warn(`No plugin for notification type "${channel.type}"`);
        continue;
      }

      try {
        const resolvedConfig = await this.resolveChannelConfig(channel);
        await plugin.send(resolvedConfig, payload);
        await this.logNotification(channel.id, null, 'agent_status_change', true);
        logger.info(`Agent notification sent: ${channel.name} (${channel.type}) for device "${deviceName}"`);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : 'Unknown error';
        await this.logNotification(channel.id, null, 'agent_status_change', false, errMsg);
        logger.error(`Agent notification failed: ${channel.name} (${channel.type}): ${errMsg}`);
      }
    }
  },

  /**
   * Send a group-level notification (for grouped notifications feature).
   * Resolves channels at the group level (no monitor bindings) and dispatches.
   */
  async sendForGroup(
    groupId: number,
    groupName: string,
    payload: NotificationPayload,
  ): Promise<void> {
    const channelIds = await this.resolveChannelsForGroup(groupId);
    if (channelIds.length === 0) return;

    const enrichedPayload: NotificationPayload = await enrichPayload(
      payload,
      await resolveGroupIdentity(groupId),
      `obliview:group:${groupId}`,
      {},
    );

    const channels = await db<ChannelRow>('notification_channels')
      .whereIn('id', channelIds)
      .where({ is_enabled: true });

    for (const row of channels) {
      const channel = rowToChannel(row);
      const plugin = getPlugin(channel.type);
      if (!plugin) {
        logger.warn(`No plugin for notification type "${channel.type}"`);
        continue;
      }

      try {
        const resolvedConfig = await this.resolveChannelConfig(channel);
        await plugin.send(resolvedConfig, enrichedPayload);
        await this.logNotification(channel.id, null, 'group_status_change', true);
        logger.info(`Group notification sent: ${channel.name} (${channel.type}) for group "${groupName}"`);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : 'Unknown error';
        await this.logNotification(channel.id, null, 'group_status_change', false, errMsg);
        logger.error(`Group notification failed: ${channel.name} (${channel.type}): ${errMsg}`);
      }
    }
  },

  async logNotification(
    channelId: number,
    monitorId: number | null,
    eventType: string,
    success: boolean,
    error?: string,
  ): Promise<void> {
    await db('notification_log').insert({
      channel_id: channelId,
      monitor_id: monitorId,
      event_type: eventType,
      success,
      error: error ?? null,
    });
  },
};
