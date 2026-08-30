import type { NotificationConfigField } from '@obliview/shared';

export interface NotificationPayload {
  monitorName: string;
  monitorUrl?: string;
  oldStatus: string;
  newStatus: string;
  message?: string;
  timestamp: string;
  appName?: string;
  // Group notification fields
  groupName?: string;
  groupId?: number;
  downMonitors?: string[];       // Names of confirmed-down monitors
  failingMonitors?: string[];    // Names of ALL failing monitors (confirmed + retrying)
  totalFailingCount?: number;    // Total count of failing monitors in the group
  isGroupNotification?: boolean;

  // ── Alert-spine identity fields (added centrally by notification.service) ──
  // All optional so every existing plugin keeps compiling and ignoring them.
  // Consumer: Oblidesk (service desk) — needs these to open/dedupe/auto-resolve
  // a ticket and bind it to the right workspace and device.
  monitorId?: number;            // Oblidesk: links the ticket back to the exact monitor (deep link + reopen on the same source)
  monitorType?: string;          // Oblidesk: routing/classification (http, tcp, agent, …) — decides the ticket template
  agentDeviceId?: number | null; // Oblidesk: local FK to the Obliview device row; null when the monitor is not agent-backed
  deviceUuid?: string | null;    // Oblidesk: the CMDB join key — the same UUID the Obligate suite uses to identify a machine
  tenantId?: number;             // Oblidesk: numeric tenant, useful for logs; not portable across apps
  tenantSlug?: string;           // Oblidesk: THE cross-app join key — maps an Obliview workspace onto an Oblidesk workspace
  stableKey?: string;            // Oblidesk: dedupe key — repeat alerts with the same key update one ticket instead of creating a landfill
  severity?: 'info' | 'warning' | 'critical'; // Oblidesk: ticket priority + the plugin's minSeverity filter
  isRecovery?: boolean;          // Oblidesk: true → auto-resolve the open ticket carrying this stableKey
  recoveredAt?: string;          // Oblidesk: REAL recovery timestamp (the state-change time, not send time) — drives MTTR
  occurrenceCount?: number;      // Oblidesk: how many times this stableKey fired since the last recovery — flap detection
  inMaintenance?: boolean;       // Oblidesk: mark the ticket as expected/planned rather than an incident
  suppressedReason?: string | null; // Oblidesk: why Obliview would have muted this (audit trail on the ticket); null when not suppressed
}

export interface NotificationPlugin {
  type: string;
  name: string;
  description: string;
  configFields: NotificationConfigField[];

  send(config: Record<string, unknown>, payload: NotificationPayload): Promise<void>;
  sendTest(config: Record<string, unknown>): Promise<void>;
}
