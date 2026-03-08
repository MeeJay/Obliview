export const MONITOR_TYPES = [
  'http',
  'ping',
  'tcp',
  'dns',
  'ssl',
  'smtp',
  'docker',
  'game_server',
  'push',
  'script',
  'json_api',
  'browser',
  'value_watcher',
  'agent',
] as const;

export type MonitorType = (typeof MONITOR_TYPES)[number];

export const MONITOR_STATUS = [
  'up', 'down', 'pending', 'maintenance', 'paused',
  'ssl_warning', 'ssl_expired',
  'alert',    // threshold violation on an agent monitor (orange)
  'inactive', // agent offline + heartbeat_monitoring=false (grey, no notification)
  'updating', // agent is performing a self-update (blue, not counted in uptime)
] as const;
export type MonitorStatus = (typeof MONITOR_STATUS)[number];

export const MONITOR_TYPE_LABELS: Record<MonitorType, string> = {
  http: 'HTTP(S)',
  ping: 'Ping',
  tcp: 'TCP Port',
  dns: 'DNS',
  ssl: 'SSL Certificate',
  smtp: 'SMTP',
  docker: 'Docker Container',
  game_server: 'Game Server',
  push: 'Push (Heartbeat)',
  script: 'Custom Script',
  json_api: 'JSON API',
  browser: 'Browser (Playwright)',
  value_watcher: 'Value Watcher',
  agent: 'Agent Monitor',
};

export const USER_ROLES = ['admin', 'user'] as const;
export type UserRole = (typeof USER_ROLES)[number];
