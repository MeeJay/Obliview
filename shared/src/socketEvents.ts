// Server → Client events
export const SOCKET_EVENTS = {
  // Connection
  INITIAL_DATA: 'initialData',

  // Monitor events
  MONITOR_HEARTBEAT: 'monitor:heartbeat',
  MONITOR_STATUS_CHANGE: 'monitor:statusChange',
  MONITOR_CREATED: 'monitor:created',
  MONITOR_UPDATED: 'monitor:updated',
  MONITOR_DELETED: 'monitor:deleted',
  MONITOR_PAUSED: 'monitor:paused',

  // Group events
  GROUP_CREATED: 'group:created',
  GROUP_UPDATED: 'group:updated',
  GROUP_DELETED: 'group:deleted',
  GROUP_MOVED: 'group:moved',

  // Notification events
  NOTIFICATION_SENT: 'notification:sent',

  // Settings events
  SETTINGS_UPDATED: 'settings:updated',

  // Incident events
  INCIDENT_CREATED: 'incident:created',
  INCIDENT_RESOLVED: 'incident:resolved',

  // Agent device events
  AGENT_DEVICE_UPDATED: 'agent:deviceUpdated',
  /** Real-time UP/ALERT/DOWN/INACTIVE status from agent push or offline watchdog */
  AGENT_STATUS_CHANGED: 'agent:statusChanged',
  /** Emitted when a device is auto-deleted (e.g. after successful uninstall command) */
  AGENT_DEVICE_DELETED: 'agent:deviceDeleted',

  // Maintenance events
  /** Emitted when a maintenance window is created, updated, or deleted */
  MAINTENANCE_CHANGED: 'maintenance:changed',

  // Live alert / notification events
  /** Emitted to tenant:{tenantId}:notifications when a new DB-backed alert is created */
  NOTIFICATION_NEW: 'notification:new',
} as const;

// Client → Server events
export const CLIENT_EVENTS = {
  MONITOR_SUBSCRIBE: 'monitor:subscribe',
  MONITOR_UNSUBSCRIBE: 'monitor:unsubscribe',
  MONITOR_REQUEST_HISTORY: 'monitor:requestHistory',
} as const;
