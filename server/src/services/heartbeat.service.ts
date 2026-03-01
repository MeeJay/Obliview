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
    const query = db('heartbeats').where({ monitor_id: monitorId });
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
   */
  async getStatsForAllMonitors(since?: Date): Promise<
    Map<number, { uptimePct: number; avgResponseTime: number | null }>
  > {
    const query = db('heartbeats');
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
   * Returns Map<groupId, { total, up }>
   */
  async getRawStatsPerGroup(since?: Date): Promise<Map<number, { total: number; up: number }>> {
    const query = db('heartbeats')
      .join('monitors', 'heartbeats.monitor_id', 'monitors.id')
      .whereNotNull('monitors.group_id');

    if (since) {
      query.where('heartbeats.created_at', '>=', since);
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
   * Keeps all non-UP heartbeats to preserve incident visibility.
   */
  async getByMonitorSince(
    monitorId: number,
    since: Date,
    maxPoints: number = 500,
  ): Promise<Heartbeat[]> {
    // Count total heartbeats in the period
    const [{ count }] = await db('heartbeats')
      .where({ monitor_id: monitorId })
      .where('created_at', '>=', since)
      .count('* as count');

    const total = Number(count);

    if (total <= maxPoints) {
      // No downsampling needed — return all
      const rows = await db<HeartbeatRow>('heartbeats')
        .where({ monitor_id: monitorId })
        .where('created_at', '>=', since)
        .orderBy('created_at', 'asc');
      return rows.map(rowToHeartbeat);
    }

    // Downsample: use nth-row sampling but keep ALL non-UP heartbeats
    const nth = Math.ceil(total / maxPoints);
    const result = await db.raw(`
      SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (ORDER BY created_at ASC) as rn
        FROM heartbeats
        WHERE monitor_id = ? AND created_at >= ?
      ) sub
      WHERE rn % ? = 1 OR status != 'up'
      ORDER BY created_at ASC
      LIMIT ?
    `, [monitorId, since, nth, maxPoints]);

    return (result.rows as HeartbeatRow[]).map(rowToHeartbeat);
  },

  /**
   * Get the N most recent heartbeats for every monitor (single query).
   * Uses a window function to rank heartbeats per monitor and keep only the top N.
   */
  async getRecentForAllMonitors(count: number = 50): Promise<Map<number, Heartbeat[]>> {
    const result = await db.raw(`
      SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY monitor_id ORDER BY created_at DESC) as rn
        FROM heartbeats
      ) sub
      WHERE rn <= ?
      ORDER BY monitor_id, created_at ASC
    `, [count]);

    const map = new Map<number, Heartbeat[]>();
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
      .whereIn('monitors.group_id', descendantSubquery);

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
