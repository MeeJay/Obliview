import { db } from '../db';
import type { Heartbeat } from '@obliview/shared';

interface HeartbeatRow {
  id: number;
  monitor_id: number;
  status: string;
  response_time: number | null;
  status_code: number | null;
  message: string | null;
  ping: number | null;
  is_retrying: boolean;
  value: string | null;
  in_maintenance: boolean;
  created_at: Date;
}

function rowToHeartbeat(row: HeartbeatRow): Heartbeat {
  return {
    id: row.id,
    monitorId: row.monitor_id,
    status: row.status as Heartbeat['status'],
    responseTime: row.response_time,
    statusCode: row.status_code,
    message: row.message,
    ping: row.ping,
    isRetrying: row.is_retrying ?? false,
    value: row.value ?? null,
    inMaintenance: row.in_maintenance ?? false,
    createdAt: row.created_at.toISOString(),
  };
}

export const heartbeatService = {
  async create(data: {
    monitorId: number;
    status: string;
    responseTime?: number;
    statusCode?: number;
    message?: string;
    ping?: number;
    isRetrying?: boolean;
    value?: string;
    inMaintenance?: boolean;
  }): Promise<Heartbeat> {
    const [row] = await db<HeartbeatRow>('heartbeats')
      .insert({
        monitor_id: data.monitorId,
        status: data.status,
        response_time: data.responseTime ?? null,
        status_code: data.statusCode ?? null,
        message: data.message ?? null,
        ping: data.ping ?? null,
        is_retrying: data.isRetrying ?? false,
        value: data.value ?? null,
        in_maintenance: data.inMaintenance ?? false,
      })
      .returning('*');

    return rowToHeartbeat(row);
  },

  async getByMonitor(
    monitorId: number,
    limit: number = 100,
    offset: number = 0,
  ): Promise<Heartbeat[]> {
    const rows = await db<HeartbeatRow>('heartbeats')
      .where({ monitor_id: monitorId })
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset);

    return rows.map(rowToHeartbeat);
  },

  async getLatest(monitorId: number): Promise<Heartbeat | null> {
    const row = await db<HeartbeatRow>('heartbeats')
      .where({ monitor_id: monitorId })
      .orderBy('created_at', 'desc')
      .first();

    if (!row) return null;
    return rowToHeartbeat(row);
  },

  async getRecentByMonitor(monitorId: number, count: number = 50): Promise<Heartbeat[]> {
    const rows = await db<HeartbeatRow>('heartbeats')
      .where({ monitor_id: monitorId })
      .orderBy('created_at', 'desc')
      .limit(count);

    return rows.map(rowToHeartbeat).reverse(); // chronological order
  },

  /**
   * Compute uptime and response time stats for a monitor over a time period.
   */
  async getStats(
    monitorId: number,
    since?: Date,
  ): Promise<{
    total: number;
    up: number;
    down: number;
    uptimePct: number;
    avgResponseTime: number | null;
    minResponseTime: number | null;
    maxResponseTime: number | null;
  }> {
    const query = db('heartbeats').where({ monitor_id: monitorId }).where({ in_maintenance: false });
    if (since) {
      query.where('created_at', '>=', since);
    }

    const [row] = await query.select(
      db.raw('COUNT(*)::int as total'),
      db.raw("COUNT(*) FILTER (WHERE status = 'up')::int as up"),
      db.raw("COUNT(*) FILTER (WHERE status = 'down')::int as down"),
      db.raw('ROUND(AVG(response_time))::int as avg_rt'),
      db.raw('MIN(response_time)::int as min_rt'),
      db.raw('MAX(response_time)::int as max_rt'),
    );

    const total = row.total || 0;
    const up = row.up || 0;

    return {
      total,
      up,
      down: row.down || 0,
      uptimePct: total > 0 ? Math.round((up / total) * 10000) / 100 : 0,
      avgResponseTime: row.avg_rt ?? null,
      minResponseTime: row.min_rt ?? null,
      maxResponseTime: row.max_rt ?? null,
    };
  },

  /**
   * Get stats for all monitors at once (dashboard summary).
   *
   * `monitorIds` restricts the scan to a specific set — this is essential:
   *   - Security: without it, a user in tenant B receives uptime% / RT for
   *     every monitor in tenant A. Ultracode review #2 (critical).
   *   - Perf: idx_heartbeats(monitor_id, created_at) can drive a per-monitor
   *     index range scan when the predicate leads with monitor_id.
   * Passing an empty array short-circuits and returns an empty map.
   */
  async getStatsForAllMonitors(
    since: Date | undefined,
    monitorIds: number[],
  ): Promise<Map<number, { uptimePct: number; avgResponseTime: number | null }>> {
    if (monitorIds.length === 0) return new Map();

    const query = db('heartbeats')
      .where({ in_maintenance: false })
      .whereIn('monitor_id', monitorIds);
    if (since) {
      query.where('created_at', '>=', since);
    }

    const rows = await query
      .groupBy('monitor_id')
      .select(
        'monitor_id',
        db.raw('COUNT(*)::int as total'),
        db.raw("COUNT(*) FILTER (WHERE status = 'up')::int as up"),
        db.raw('ROUND(AVG(response_time))::int as avg_rt'),
      );

    const result = new Map<number, { uptimePct: number; avgResponseTime: number | null }>();
    for (const row of rows) {
      const total = row.total || 0;
      const up = row.up || 0;
      result.set(row.monitor_id, {
        uptimePct: total > 0 ? Math.round((up / total) * 10000) / 100 : 0,
        avgResponseTime: row.avg_rt ?? null,
      });
    }
    return result;
  },

  /**
   * Get raw heartbeat stats per group_id (direct monitors only, no recursion).
   * Returns Map<groupId, { total, up }>.
   *
   * `tenantScope` behaviour:
   *   - number    → WHERE monitors.tenant_id = <scope>  (regular tenant view)
   *   - null      → no tenant filter  (platform-admin God View across all tenants)
   *   - undefined → same as null, preserved for legacy callers
   *
   * The tenant filter is essential — the endpoint is polled every 60s by every
   * logged-in user via GET /groups/stats, and an unfiltered scan of
   * heartbeats × monitors across the whole install was the top source of
   * sustained PG CPU pressure in the perf review.
   */
  async getRawStatsPerGroup(
    since?: Date,
    tenantScope?: number | null,
  ): Promise<Map<number, { total: number; up: number }>> {
    const query = db('heartbeats')
      .join('monitors', 'heartbeats.monitor_id', 'monitors.id')
      .whereNotNull('monitors.group_id')
      .where({ 'heartbeats.in_maintenance': false });

    if (since) {
      query.where('heartbeats.created_at', '>=', since);
    }
    if (typeof tenantScope === 'number') {
      query.where('monitors.tenant_id', tenantScope);
    }

    const rows = await query
      .groupBy('monitors.group_id')
      .select(
        'monitors.group_id',
        db.raw('COUNT(*)::int as total'),
        db.raw("COUNT(*) FILTER (WHERE heartbeats.status = 'up')::int as up"),
      );

    const result = new Map<number, { total: number; up: number }>();
    for (const row of rows) {
      result.set(row.group_id, { total: row.total || 0, up: row.up || 0 });
    }
    return result;
  },

  /**
   * Get heartbeats for a monitor within an explicit date range, with optional downsampling.
   * Used for the zoom-in feature in the chart.
   */
  async getByMonitorRange(
    monitorId: number,
    from: Date,
    to: Date,
    maxPoints: number = 500,
  ): Promise<Heartbeat[]> {
    const [{ count }] = await db('heartbeats')
      .where({ monitor_id: monitorId })
      .where('created_at', '>=', from)
      .where('created_at', '<=', to)
      .count('* as count');

    const total = Number(count);

    if (total <= maxPoints) {
      const rows = await db<HeartbeatRow>('heartbeats')
        .where({ monitor_id: monitorId })
        .where('created_at', '>=', from)
        .where('created_at', '<=', to)
        .orderBy('created_at', 'asc');
      return rows.map(rowToHeartbeat);
    }

    const nth = Math.ceil(total / maxPoints);
    const result = await db.raw(`
      SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (ORDER BY created_at ASC) as rn
        FROM heartbeats
        WHERE monitor_id = ? AND created_at >= ? AND created_at <= ?
      ) sub
      WHERE rn % ? = 1 OR status != 'up'
      ORDER BY created_at ASC
      LIMIT ?
    `, [monitorId, from, to, nth, maxPoints]);

    return (result.rows as HeartbeatRow[]).map(rowToHeartbeat);
  },

  /**
   * Get heartbeats for a monitor since a given date, with optional downsampling.
   * Keeps ~maxPoints sampled "up" rows for the smooth line, plus non-'up' rows
   * (also sampled when there are too many, so a chronically-alerting monitor
   * viewed at long range doesn't return 500k rows and crash the chart).
   */
  async getByMonitorSince(
    monitorId: number,
    since: Date,
    maxPoints: number = 500,
  ): Promise<Heartbeat[]> {
    // Count total + non-'up' rows in one round-trip. The non-'up' count is
    // needed to decide whether incidents themselves need a second modulo pass.
    const [row] = await db('heartbeats')
      .where({ monitor_id: monitorId })
      .where('created_at', '>=', since)
      .select(
        db.raw('COUNT(*)::int as total'),
        db.raw("COUNT(*) FILTER (WHERE status != 'up')::int as non_up"),
      );
    const total = Number(row?.total ?? 0);
    const nonUp = Number(row?.non_up ?? 0);

    if (total <= maxPoints) {
      // No downsampling needed — return all
      const rows = await db<HeartbeatRow>('heartbeats')
        .where({ monitor_id: monitorId })
        .where('created_at', '>=', since)
        .orderBy('created_at', 'asc');
      return rows.map(rowToHeartbeat);
    }

    // Baseline nth-sampling over ALL rows preserves the smooth line.
    // Secondary nth-sampling over non-'up' rows only kicks in when a chronic
    // incident monitor blows past `maxPoints`, so an always-alerting agent at
    // 30 d / 60 s (~43 k rows) or 1 y (~500 k rows) still returns a bounded
    // payload instead of the raw heartbeat torrent that the perf review flagged.
    //
    // Ceiling on payload size: 2 * maxPoints in the worst case (baseline
    // sample fully disjoint from the incident sample). Well within Recharts
    // + client memory limits.
    const nth = Math.ceil(total / maxPoints);
    const nthNonUp = nonUp > maxPoints ? Math.ceil(nonUp / maxPoints) : 1;
    const result = await db.raw(`
      SELECT * FROM (
        SELECT *,
          ROW_NUMBER() OVER (ORDER BY created_at ASC) as rn_all,
          ROW_NUMBER() OVER (
            PARTITION BY (status = 'up')
            ORDER BY created_at ASC
          ) as rn_status
        FROM heartbeats
        WHERE monitor_id = ? AND created_at >= ?
      ) sub
      WHERE rn_all % ? = 1
         OR (status != 'up' AND rn_status % ? = 1)
      ORDER BY created_at ASC
    `, [monitorId, since, nth, nthNonUp]);

    return (result.rows as HeartbeatRow[]).map(rowToHeartbeat);
  },

  /**
   * Get the N most recent heartbeats for a set of monitors.
   *
   * `monitorIds` restricts both the SQL (idx_heartbeats(monitor_id, created_at)
   * → per-monitor index range scan) and the visibility of the response.
   * Ultracode review #5: the previous unbounded version ran a window function
   * over the ENTIRE heartbeats table on every dashboard mount, degrading
   * into a full seq scan + big sort as retention grew (up to ~21 M rows).
   *
   * The LATERAL join pattern lets Postgres jump into the index per monitor
   * and grab just the top N rows, instead of window-numbering the whole
   * table first and filtering afterward.
   */
  async getRecentForAllMonitors(
    monitorIds: number[],
    count: number = 50,
  ): Promise<Map<number, Heartbeat[]>> {
    const map = new Map<number, Heartbeat[]>();
    if (monitorIds.length === 0) return map;

    const result = await db.raw(`
      SELECT h.*
      FROM unnest(?::int[]) AS m(id)
      CROSS JOIN LATERAL (
        SELECT *
        FROM heartbeats
        WHERE monitor_id = m.id
        ORDER BY created_at DESC
        LIMIT ?
      ) h
      ORDER BY h.monitor_id, h.created_at ASC
    `, [monitorIds, count]);

    for (const row of result.rows as HeartbeatRow[]) {
      const hb = rowToHeartbeat(row);
      if (!map.has(hb.monitorId)) {
        map.set(hb.monitorId, []);
      }
      map.get(hb.monitorId)!.push(hb);
    }
    return map;
  },

  /**
   * Delete heartbeats for specific monitor IDs.
   */
  async clearForMonitors(monitorIds: number[]): Promise<number> {
    if (monitorIds.length === 0) return 0;
    const count = await db('heartbeats')
      .whereIn('monitor_id', monitorIds)
      .del();
    return count;
  },

  /**
   * Get aggregated heartbeats for a group and all its descendants.
   * Uses the closure table for group hierarchy. Includes downsampling.
   */
  async getByGroupSince(
    groupId: number,
    since: Date,
    maxPoints: number = 500,
  ): Promise<Heartbeat[]> {
    const descendantSubquery = db('group_closure')
      .where('ancestor_id', groupId)
      .select('descendant_id');

    // Count total
    const [{ count }] = await db('heartbeats')
      .join('monitors', 'heartbeats.monitor_id', 'monitors.id')
      .whereIn('monitors.group_id', descendantSubquery)
      .where('heartbeats.created_at', '>=', since)
      .count('* as count');

    const total = Number(count);

    if (total <= maxPoints) {
      const rows = await db<HeartbeatRow>('heartbeats')
        .join('monitors', 'heartbeats.monitor_id', 'monitors.id')
        .whereIn('monitors.group_id', descendantSubquery)
        .where('heartbeats.created_at', '>=', since)
        .orderBy('heartbeats.created_at', 'asc')
        .select('heartbeats.*');
      return rows.map(rowToHeartbeat);
    }

    // Downsample: nth-row but keep all non-UP heartbeats
    const nth = Math.ceil(total / maxPoints);
    const result = await db.raw(`
      SELECT * FROM (
        SELECT h.*, ROW_NUMBER() OVER (ORDER BY h.created_at ASC) as rn
        FROM heartbeats h
        JOIN monitors m ON h.monitor_id = m.id
        WHERE m.group_id IN (SELECT descendant_id FROM group_closure WHERE ancestor_id = ?)
          AND h.created_at >= ?
      ) sub
      WHERE rn % ? = 1 OR status != 'up'
      ORDER BY created_at ASC
      LIMIT ?
    `, [groupId, since, nth, maxPoints]);

    return (result.rows as HeartbeatRow[]).map(rowToHeartbeat);
  },

  /**
   * Get aggregated stats for a group and all its descendants.
   */
  async getGroupStats(
    groupId: number,
    since?: Date,
  ): Promise<{
    total: number;
    up: number;
    down: number;
    uptimePct: number;
    avgResponseTime: number | null;
    monitorCount: number;
    downMonitorNames: string[];
  }> {
    const descendantSubquery = db('group_closure')
      .where('ancestor_id', groupId)
      .select('descendant_id');

    // Heartbeat stats
    const query = db('heartbeats')
      .join('monitors', 'heartbeats.monitor_id', 'monitors.id')
      .whereIn('monitors.group_id', descendantSubquery)
      .where({ 'heartbeats.in_maintenance': false });

    if (since) {
      query.where('heartbeats.created_at', '>=', since);
    }

    const [row] = await query.select(
      db.raw('COUNT(*)::int as total'),
      db.raw("COUNT(*) FILTER (WHERE heartbeats.status = 'up')::int as up"),
      db.raw("COUNT(*) FILTER (WHERE heartbeats.status = 'down')::int as down"),
      db.raw('ROUND(AVG(heartbeats.response_time))::int as avg_rt'),
    );

    const total = row.total || 0;
    const up = row.up || 0;

    // Monitor counts
    const monitorRows = await db('monitors')
      .whereIn('group_id', descendantSubquery)
      .where({ is_active: true })
      .select('id', 'name', 'status');

    const PROBLEM_STATUSES = new Set(['down', 'ssl_expired', 'ssl_warning', 'alert']);
    const downMonitorNames = monitorRows
      .filter((m: { status: string }) => PROBLEM_STATUSES.has(m.status))
      .map((m: { name: string }) => m.name);

    return {
      total,
      up,
      down: row.down || 0,
      uptimePct: total > 0 ? Math.round((up / total) * 10000) / 100 : 100,
      avgResponseTime: row.avg_rt ?? null,
      monitorCount: monitorRows.length,
      downMonitorNames,
    };
  },

  /**
   * Delete heartbeats older than the given number of days.
   */
  async purgeOlderThan(days: number): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const count = await db('heartbeats')
      .where('created_at', '<', cutoff)
      .del();

    return count;
  },
};
