import { db } from '../db';
import type { Monitor, AgentThresholds } from '@obliview/shared';
import { generateToken } from '../utils/crypto';

// Database row → API model
interface MonitorRow {
  id: number;
  name: string;
  description: string | null;
  type: string;
  group_id: number | null;
  is_active: boolean;
  status: string;
  interval_seconds: number | null;
  retry_interval_seconds: number | null;
  max_retries: number | null;
  timeout_ms: number | null;
  upside_down: boolean;
  url: string | null;
  method: string | null;
  headers: Record<string, string> | null;
  body: string | null;
  expected_status_codes: number[] | null;
  keyword: string | null;
  keyword_is_present: boolean | null;
  ignore_ssl: boolean;
  json_path: string | null;
  json_expected_value: string | null;
  hostname: string | null;
  port: number | null;
  dns_record_type: string | null;
  dns_resolver: string | null;
  dns_expected_value: string | null;
  ssl_warn_days: number | null;
  smtp_host: string | null;
  smtp_port: number | null;
  docker_host: string | null;
  docker_container_name: string | null;
  game_type: string | null;
  game_host: string | null;
  game_port: number | null;
  push_token: string | null;
  push_max_interval_sec: number | null;
  script_command: string | null;
  script_expected_exit: number | null;
  browser_url: string | null;
  browser_keyword: string | null;
  browser_keyword_is_present: boolean | null;
  browser_wait_for_selector: string | null;
  browser_screenshot_on_failure: boolean;
  value_watcher_url: string | null;
  value_watcher_json_path: string | null;
  value_watcher_operator: string | null;
  value_watcher_threshold: number | null;
  value_watcher_threshold_max: number | null;
  value_watcher_previous_value: string | null;
  value_watcher_headers: Record<string, string> | null;
  // Agent Monitor
  agent_device_id: number | null;
  agent_device_name?: string | null;  // from LEFT JOIN with agent_devices (read queries only)
  agent_thresholds: AgentThresholds | null;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
}

/** Base query that LEFT JOINs agent_devices to populate agent_device_name. */
function monitorBaseQuery(tenantId?: number) {
  const q = db('monitors')
    .leftJoin('agent_devices as ad', 'monitors.agent_device_id', 'ad.id')
    .select<MonitorRow[]>('monitors.*', db.raw('ad.name as agent_device_name'));
  if (tenantId !== undefined) {
    q.where('monitors.tenant_id', tenantId);
  }
  return q;
}

function rowToMonitor(row: MonitorRow): Monitor {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type as Monitor['type'],
    groupId: row.group_id,
    isActive: row.is_active,
    status: row.status as Monitor['status'],
    intervalSeconds: row.interval_seconds,
    retryIntervalSeconds: row.retry_interval_seconds,
    maxRetries: row.max_retries,
    timeoutMs: row.timeout_ms,
    upsideDown: row.upside_down,
    url: row.url,
    method: row.method,
    headers: row.headers,
    body: row.body,
    expectedStatusCodes: row.expected_status_codes,
    keyword: row.keyword,
    keywordIsPresent: row.keyword_is_present,
    ignoreSsl: row.ignore_ssl,
    jsonPath: row.json_path,
    jsonExpectedValue: row.json_expected_value,
    hostname: row.hostname,
    port: row.port,
    dnsRecordType: row.dns_record_type,
    dnsResolver: row.dns_resolver,
    dnsExpectedValue: row.dns_expected_value,
    sslWarnDays: row.ssl_warn_days,
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    dockerHost: row.docker_host,
    dockerContainerName: row.docker_container_name,
    gameType: row.game_type,
    gameHost: row.game_host,
    gamePort: row.game_port,
    pushToken: row.push_token,
    pushMaxIntervalSec: row.push_max_interval_sec,
    scriptCommand: row.script_command,
    scriptExpectedExit: row.script_expected_exit,
    browserUrl: row.browser_url,
    browserKeyword: row.browser_keyword,
    browserKeywordIsPresent: row.browser_keyword_is_present,
    browserWaitForSelector: row.browser_wait_for_selector,
    browserScreenshotOnFailure: row.browser_screenshot_on_failure,
    valueWatcherUrl: row.value_watcher_url,
    valueWatcherJsonPath: row.value_watcher_json_path,
    valueWatcherOperator: row.value_watcher_operator,
    valueWatcherThreshold: row.value_watcher_threshold,
    valueWatcherThresholdMax: row.value_watcher_threshold_max,
    valueWatcherPreviousValue: row.value_watcher_previous_value,
    valueWatcherHeaders: typeof row.value_watcher_headers === 'string' ? JSON.parse(row.value_watcher_headers) : row.value_watcher_headers,
    // Agent Monitor
    agentDeviceId: row.agent_device_id,
    agentDeviceName: row.agent_device_name ?? null,
    agentThresholds: row.agent_thresholds ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// API model → database columns (camelCase → snake_case)
function monitorToRow(data: Partial<Monitor>): Record<string, unknown> {
  const map: Record<string, unknown> = {};

  if (data.name !== undefined) map.name = data.name;
  if (data.description !== undefined) map.description = data.description;
  if (data.type !== undefined) map.type = data.type;
  if (data.groupId !== undefined) map.group_id = data.groupId;
  if (data.isActive !== undefined) map.is_active = data.isActive;
  if (data.status !== undefined) map.status = data.status;
  if (data.intervalSeconds !== undefined) map.interval_seconds = data.intervalSeconds;
  if (data.retryIntervalSeconds !== undefined) map.retry_interval_seconds = data.retryIntervalSeconds;
  if (data.maxRetries !== undefined) map.max_retries = data.maxRetries;
  if (data.timeoutMs !== undefined) map.timeout_ms = data.timeoutMs;
  if (data.upsideDown !== undefined) map.upside_down = data.upsideDown;
  if (data.url !== undefined) map.url = data.url;
  if (data.method !== undefined) map.method = data.method;
  if (data.headers !== undefined) map.headers = data.headers ? JSON.stringify(data.headers) : null;
  if (data.body !== undefined) map.body = data.body;
  if (data.expectedStatusCodes !== undefined) map.expected_status_codes = data.expectedStatusCodes;
  if (data.keyword !== undefined) map.keyword = data.keyword;
  if (data.keywordIsPresent !== undefined) map.keyword_is_present = data.keywordIsPresent;
  if (data.ignoreSsl !== undefined) map.ignore_ssl = data.ignoreSsl;
  if (data.jsonPath !== undefined) map.json_path = data.jsonPath;
  if (data.jsonExpectedValue !== undefined) map.json_expected_value = data.jsonExpectedValue;
  if (data.hostname !== undefined) map.hostname = data.hostname;
  if (data.port !== undefined) map.port = data.port;
  if (data.dnsRecordType !== undefined) map.dns_record_type = data.dnsRecordType;
  if (data.dnsResolver !== undefined) map.dns_resolver = data.dnsResolver;
  if (data.dnsExpectedValue !== undefined) map.dns_expected_value = data.dnsExpectedValue;
  if (data.sslWarnDays !== undefined) map.ssl_warn_days = data.sslWarnDays;
  if (data.smtpHost !== undefined) map.smtp_host = data.smtpHost;
  if (data.smtpPort !== undefined) map.smtp_port = data.smtpPort;
  if (data.dockerHost !== undefined) map.docker_host = data.dockerHost;
  if (data.dockerContainerName !== undefined) map.docker_container_name = data.dockerContainerName;
  if (data.gameType !== undefined) map.game_type = data.gameType;
  if (data.gameHost !== undefined) map.game_host = data.gameHost;
  if (data.gamePort !== undefined) map.game_port = data.gamePort;
  if (data.pushMaxIntervalSec !== undefined) map.push_max_interval_sec = data.pushMaxIntervalSec;
  if (data.scriptCommand !== undefined) map.script_command = data.scriptCommand;
  if (data.scriptExpectedExit !== undefined) map.script_expected_exit = data.scriptExpectedExit;
  if (data.browserUrl !== undefined) map.browser_url = data.browserUrl;
  if (data.browserKeyword !== undefined) map.browser_keyword = data.browserKeyword;
  if (data.browserKeywordIsPresent !== undefined) map.browser_keyword_is_present = data.browserKeywordIsPresent;
  if (data.browserWaitForSelector !== undefined) map.browser_wait_for_selector = data.browserWaitForSelector;
  if (data.browserScreenshotOnFailure !== undefined) map.browser_screenshot_on_failure = data.browserScreenshotOnFailure;
  if (data.valueWatcherUrl !== undefined) map.value_watcher_url = data.valueWatcherUrl;
  if (data.valueWatcherJsonPath !== undefined) map.value_watcher_json_path = data.valueWatcherJsonPath;
  if (data.valueWatcherOperator !== undefined) map.value_watcher_operator = data.valueWatcherOperator;
  if (data.valueWatcherThreshold !== undefined) map.value_watcher_threshold = data.valueWatcherThreshold;
  if (data.valueWatcherThresholdMax !== undefined) map.value_watcher_threshold_max = data.valueWatcherThresholdMax;
  if (data.valueWatcherPreviousValue !== undefined) map.value_watcher_previous_value = data.valueWatcherPreviousValue;
  if (data.valueWatcherHeaders !== undefined) map.value_watcher_headers = data.valueWatcherHeaders ? JSON.stringify(data.valueWatcherHeaders) : null;
  // Agent Monitor
  if (data.agentDeviceId !== undefined) map.agent_device_id = data.agentDeviceId;
  if (data.agentThresholds !== undefined) map.agent_thresholds = data.agentThresholds ? JSON.stringify(data.agentThresholds) : null;

  return map;
}

export const monitorService = {
  async getAll(tenantId: number): Promise<Monitor[]> {
    const rows = await monitorBaseQuery(tenantId).orderBy('monitors.name');
    return rows.map(rowToMonitor);
  },

  async getByIds(ids: number[], tenantId?: number): Promise<Monitor[]> {
    if (ids.length === 0) return [];
    const rows = await monitorBaseQuery(tenantId).whereIn('monitors.id', ids).orderBy('monitors.name');
    return rows.map(rowToMonitor);
  },

  async getAllActive(): Promise<Monitor[]> {
    const rows = await monitorBaseQuery()
      .where({ 'monitors.is_active': true })
      .whereNot({ 'monitors.status': 'paused' })
      .orderBy('monitors.name');
    return rows.map(rowToMonitor);
  },

  async getById(id: number): Promise<Monitor | null> {
    const row = await monitorBaseQuery().where({ 'monitors.id': id }).first();
    if (!row) return null;
    return rowToMonitor(row);
  },

  async create(data: Partial<Monitor>, createdBy: number, tenantId: number): Promise<Monitor> {
    const rowData = monitorToRow(data);
    rowData.created_by = createdBy;
    rowData.tenant_id = tenantId;

    // Generate push token for push monitors
    if (data.type === 'push') {
      rowData.push_token = generateToken(16);
    }

    const [row] = await db<MonitorRow>('monitors').insert(rowData).returning('*');
    return rowToMonitor(row);
  },

  async update(id: number, data: Partial<Monitor>): Promise<Monitor | null> {
    const rowData = monitorToRow(data);
    rowData.updated_at = new Date();

    const [row] = await db<MonitorRow>('monitors')
      .where({ id })
      .update(rowData)
      .returning('*');

    if (!row) return null;
    return rowToMonitor(row);
  },

  async delete(id: number): Promise<boolean> {
    const count = await db('monitors').where({ id }).del();
    return count > 0;
  },

  async bulkUpdate(monitorIds: number[], changes: Partial<Monitor>): Promise<Monitor[]> {
    const rowData = monitorToRow(changes);
    rowData.updated_at = new Date();

    const rows = await db<MonitorRow>('monitors')
      .whereIn('id', monitorIds)
      .update(rowData)
      .returning('*');

    return rows.map(rowToMonitor);
  },

  async updateStatus(id: number, status: string): Promise<void> {
    await db('monitors').where({ id }).update({ status, updated_at: new Date() });
  },
};
