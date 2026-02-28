import type { MonitorType, MonitorStatus, UserRole } from './monitorTypes';
import type { SettingsKey } from './settingsDefaults';

// ============================================
// User types
// ============================================
export interface User {
  id: number;
  username: string;
  displayName: string | null;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UserWithPassword extends User {
  passwordHash: string;
}

// ============================================
// Monitor types
// ============================================
export interface Monitor {
  id: number;
  name: string;
  description: string | null;
  type: MonitorType;
  groupId: number | null;
  isActive: boolean;
  status: MonitorStatus;

  // Common config
  intervalSeconds: number | null;
  retryIntervalSeconds: number | null;
  maxRetries: number | null;
  timeoutMs: number | null;
  upsideDown: boolean;

  // HTTP / JSON API
  url: string | null;
  method: string | null;
  headers: Record<string, string> | null;
  body: string | null;
  expectedStatusCodes: number[] | null;
  keyword: string | null;
  keywordIsPresent: boolean | null;
  ignoreSsl: boolean;

  // JSON API
  jsonPath: string | null;
  jsonExpectedValue: string | null;

  // Ping / TCP
  hostname: string | null;
  port: number | null;

  // DNS
  dnsRecordType: string | null;
  dnsResolver: string | null;
  dnsExpectedValue: string | null;

  // SSL
  sslWarnDays: number | null;

  // SMTP
  smtpHost: string | null;
  smtpPort: number | null;

  // Docker
  dockerHost: string | null;
  dockerContainerName: string | null;

  // Game server
  gameType: string | null;
  gameHost: string | null;
  gamePort: number | null;

  // Push
  pushToken: string | null;
  pushMaxIntervalSec: number | null;

  // Script
  scriptCommand: string | null;
  scriptExpectedExit: number | null;

  // Browser (Playwright)
  browserUrl: string | null;
  browserKeyword: string | null;
  browserKeywordIsPresent: boolean | null;
  browserWaitForSelector: string | null;
  browserScreenshotOnFailure: boolean;

  // Value Watcher
  valueWatcherUrl: string | null;
  valueWatcherJsonPath: string | null;
  valueWatcherOperator: string | null;
  valueWatcherThreshold: number | null;
  valueWatcherThresholdMax: number | null;
  valueWatcherPreviousValue: string | null;
  valueWatcherHeaders: Record<string, string> | null;

  // Agent Monitor
  agentDeviceId: number | null;
  agentThresholds: AgentThresholds | null;

  // Metadata
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
}

// ============================================
// Heartbeat types
// ============================================
export interface Heartbeat {
  id: number;
  monitorId: number;
  status: MonitorStatus;
  responseTime: number | null;
  statusCode: number | null;
  message: string | null;
  ping: number | null;
  isRetrying: boolean;
  value: string | null;
  createdAt: string;
}

export interface HeartbeatStats {
  monitorId: number;
  period: string;
  uptimePct: number;
  avgResponse: number | null;
  maxResponse: number | null;
  minResponse: number | null;
  totalChecks: number;
  totalUp: number;
  totalDown: number;
}

// ============================================
// Group types
// ============================================
export interface MonitorGroup {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  parentId: number | null;
  sortOrder: number;
  isGeneral: boolean;
  groupNotifications: boolean;
  kind: 'monitor' | 'agent';
  agentThresholds?: AgentThresholds | null;
  createdAt: string;
  updatedAt: string;
}

export interface GroupTreeNode extends MonitorGroup {
  children: GroupTreeNode[];
  monitors: Monitor[];
}

// ============================================
// Notification types
// ============================================
export interface NotificationChannel {
  id: number;
  name: string;
  type: string;
  config: Record<string, unknown>;
  isEnabled: boolean;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
}

export type OverrideMode = 'merge' | 'replace' | 'exclude';

// ============================================
// Settings types
// ============================================
export type SettingsScope = 'global' | 'group' | 'monitor';

export interface SettingValue {
  value: number;
  source: SettingsScope | 'default';
  sourceId: number | null;
  sourceName: string;
}

export type ResolvedSettings = Record<SettingsKey, SettingValue>;

// ============================================
// Incident types
// ============================================
export interface Incident {
  id: number;
  monitorId: number;
  startedAt: string;
  resolvedAt: string | null;
  durationSec: number | null;
  previousStatus: MonitorStatus;
  newStatus: MonitorStatus;
  message: string | null;
}

// ============================================
// API types
// ============================================
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total: number;
  page: number;
  pageSize: number;
}

export interface BulkEditRequest {
  monitorIds: number[];
  changes: Partial<Monitor>;
}

export interface CreateGroupRequest {
  name: string;
  description?: string | null;
  parentId?: number | null;
  sortOrder?: number;
  isGeneral?: boolean;
  groupNotifications?: boolean;
  kind?: 'monitor' | 'agent';
}

export interface UpdateGroupRequest {
  name?: string;
  description?: string | null;
  parentId?: number | null;
  sortOrder?: number;
  isGeneral?: boolean;
  groupNotifications?: boolean;
}

export interface MoveGroupRequest {
  newParentId: number | null;
}

// ============================================
// Notification API types
// ============================================
export interface CreateNotificationChannelRequest {
  name: string;
  type: string;
  config: Record<string, unknown>;
  isEnabled?: boolean;
}

export interface UpdateNotificationChannelRequest {
  name?: string;
  config?: Record<string, unknown>;
  isEnabled?: boolean;
}

export interface NotificationBinding {
  id: number;
  channelId: number;
  scope: 'global' | 'group' | 'monitor';
  scopeId: number | null;
  overrideMode: OverrideMode;
}

export interface NotificationPluginMeta {
  type: string;
  name: string;
  description: string;
  configFields: NotificationConfigField[];
}

export interface NotificationConfigField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'url' | 'textarea' | 'boolean';
  placeholder?: string;
  required?: boolean;
}

// ============================================
// Team & Permission types
// ============================================
export type PermissionLevel = 'ro' | 'rw';
export type PermissionScope = 'group' | 'monitor';

export interface UserTeam {
  id: number;
  name: string;
  description: string | null;
  canCreate: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TeamPermission {
  id: number;
  teamId: number;
  scope: PermissionScope;
  scopeId: number;
  level: PermissionLevel;
}

export interface UserPermissions {
  canCreate: boolean;
  teams: number[];
  /** map of "group:<id>" or "monitor:<id>" → permission level */
  permissions: Record<string, PermissionLevel>;
}

// ============================================
// Team API types
// ============================================
export interface CreateTeamRequest {
  name: string;
  description?: string | null;
  canCreate?: boolean;
}

export interface UpdateTeamRequest {
  name?: string;
  description?: string | null;
  canCreate?: boolean;
}

export interface SetTeamMembersRequest {
  userIds: number[];
}

export interface SetTeamPermissionsRequest {
  permissions: Array<{
    scope: PermissionScope;
    scopeId: number;
    level: PermissionLevel;
  }>;
}

// ============================================
// User API types
// ============================================
export interface CreateUserRequest {
  username: string;
  password: string;
  displayName?: string | null;
  role?: UserRole;
}

export interface UpdateUserRequest {
  username?: string;
  displayName?: string | null;
  role?: UserRole;
  isActive?: boolean;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  user: User;
}

// ============================================
// Agent threshold types
// ============================================
export interface AgentMetricThreshold {
  enabled: boolean;
  threshold: number;
  op: '>' | '<' | '>=' | '<=';
}

export interface AgentThresholds {
  cpu: AgentMetricThreshold;
  memory: AgentMetricThreshold;
  disk: AgentMetricThreshold;
  netIn: AgentMetricThreshold;
  netOut: AgentMetricThreshold;
}

export const DEFAULT_AGENT_THRESHOLDS: AgentThresholds = {
  cpu:    { enabled: true,  threshold: 90,         op: '>' },
  memory: { enabled: true,  threshold: 90,         op: '>' },
  disk:   { enabled: true,  threshold: 90,         op: '>' },
  // Network thresholds stored in bytes/sec; 100 Mbps = 100 × 125 000 bytes/sec
  netIn:  { enabled: false, threshold: 12_500_000, op: '>' },
  netOut: { enabled: false, threshold: 12_500_000, op: '>' },
};

// ============================================
// Agent types
// ============================================
export interface AgentApiKey {
  id: number;
  name: string;
  key: string;
  createdBy: number | null;
  createdAt: string;
  lastUsedAt: string | null;
  deviceCount?: number;
}

export interface AgentDevice {
  id: number;
  uuid: string;
  hostname: string;
  /** Custom display name — shown instead of hostname when set */
  name: string | null;
  ip: string | null;
  osInfo: {
    platform: string;
    distro: string | null;
    release: string | null;
    arch: string;
  } | null;
  agentVersion: string | null;
  apiKeyId: number | null;
  status: 'pending' | 'approved' | 'refused' | 'suspended';
  /** When false: agent going offline → 'inactive' (grey), no notification */
  heartbeatMonitoring: boolean;
  checkIntervalSeconds: number;
  approvedBy: number | null;
  approvedAt: string | null;
  groupId: number | null;
  createdAt: string;
  updatedAt: string;
}
