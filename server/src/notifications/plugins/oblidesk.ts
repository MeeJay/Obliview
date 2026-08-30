import type { NotificationPlugin, NotificationPayload } from '../types';

type Severity = 'info' | 'warning' | 'critical';

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

function normalizeSeverity(value: unknown, fallback: Severity): Severity {
  const s = String(value ?? '');
  return s === 'info' || s === 'warning' || s === 'critical' ? s : fallback;
}

/** Body sent to POST {baseUrl}/api/alerts/ingest — see the Oblidesk ingest contract. */
function buildBody(config: Record<string, unknown>, payload: NotificationPayload) {
  return {
    source: 'obliview' as const,
    version: 1 as const,
    stableKey: payload.stableKey!,
    severity: normalizeSeverity(payload.severity, 'warning'),
    status: payload.isRecovery ? ('resolved' as const) : ('firing' as const),
    title: payload.isGroupNotification
      ? `Group "${payload.groupName ?? payload.monitorName}" — ${payload.totalFailingCount ?? 1} monitor(s) failing`
      : `${payload.monitorName} is ${payload.newStatus.toUpperCase()}`,
    message: payload.message ?? null,
    occurredAt: payload.timestamp,
    resolvedAt: payload.recoveredAt ?? null,
    occurrenceCount: payload.occurrenceCount ?? 1,
    queueSlug: config.queueSlug ? String(config.queueSlug) : null,
    tenantSlug: payload.tenantSlug ?? null,
    tenantId: payload.tenantId ?? null,
    appName: payload.appName ?? null,
    monitor: {
      id: payload.monitorId ?? null,
      name: payload.monitorName,
      type: payload.monitorType ?? null,
      url: payload.monitorUrl ?? null,
      oldStatus: payload.oldStatus,
      newStatus: payload.newStatus,
    },
    group: payload.isGroupNotification
      ? {
          id: payload.groupId ?? null,
          name: payload.groupName ?? null,
          downMonitors: payload.downMonitors ?? [],
          failingMonitors: payload.failingMonitors ?? [],
          totalFailingCount: payload.totalFailingCount ?? null,
        }
      : null,
    device: {
      agentDeviceId: payload.agentDeviceId ?? null,
      deviceUuid: payload.deviceUuid ?? null,
    },
    maintenance: {
      inMaintenance: payload.inMaintenance ?? false,
      suppressedReason: payload.suppressedReason ?? null,
    },
  };
}

export const obliDeskPlugin: NotificationPlugin = {
  type: 'oblidesk',
  name: 'Oblidesk',
  description: 'Open and auto-resolve service desk tickets in Oblidesk',
  configFields: [
    { key: 'baseUrl', label: 'Oblidesk URL', type: 'url', required: true, placeholder: 'https://desk.example.com' },
    { key: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'Paste the key from Oblidesk → Integrations' },
    { key: 'queueSlug', label: 'Queue (optional)', type: 'text', placeholder: 'Leave blank for the default queue' },
    {
      key: 'minSeverity',
      label: 'Minimum Severity',
      type: 'select',
      defaultValue: 'warning',
      options: [
        { value: 'info', label: 'Info' },
        { value: 'warning', label: 'Warning' },
        { value: 'critical', label: 'Critical' },
      ],
    },
  ],

  async send(config, payload) {
    // Anti-landfill guarantee: without a stable key Oblidesk cannot dedupe or
    // auto-resolve, so every beat would open a new ticket. Refuse instead.
    if (!payload.stableKey) {
      throw new Error('Oblidesk: payload has no stableKey — refusing to send an undedupable alert');
    }

    const severity = normalizeSeverity(payload.severity, 'warning');
    const minSeverity = normalizeSeverity(config.minSeverity, 'warning');
    // Recoveries always go through: they close a ticket that was already opened.
    if (!payload.isRecovery && SEVERITY_RANK[severity] < SEVERITY_RANK[minSeverity]) {
      return;
    }

    const url = `${String(config.baseUrl).replace(/\/$/, '')}/api/alerts/ingest`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${String(config.apiKey)}`,
      },
      body: JSON.stringify(buildBody(config, payload)),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Oblidesk returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
  },

  async sendTest(config) {
    await this.send(config, {
      monitorName: 'Test Monitor',
      oldStatus: 'up',
      newStatus: 'down',
      message: 'This is a test notification from Obliview',
      timestamp: new Date().toISOString(),
      stableKey: 'obliview:test',
      severity: 'critical',
      isRecovery: false,
      occurrenceCount: 1,
    });
  },
};
