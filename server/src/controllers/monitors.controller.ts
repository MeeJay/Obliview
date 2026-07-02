import type { Request, Response, NextFunction } from 'express';
import type { Heartbeat } from '@obliview/shared';
import { SOCKET_EVENTS } from '@obliview/shared';
import { monitorService } from '../services/monitor.service';
import { heartbeatService } from '../services/heartbeat.service';
import { permissionService } from '../services/permission.service';
import { teamService } from '../services/team.service';
import { MonitorWorkerManager } from '../workers/MonitorWorkerManager';
import { AppError } from '../middleware/errorHandler';
import type { CreateMonitorInput, BulkUpdateInput } from '../validators/monitor.schema';
import { maintenanceService } from '../services/maintenance.service';
import { agentHub } from '../services/agentHub.service';
import { getEffectiveTenantScope } from '../utils/tenantScope';

/** Broadcast a monitor event to admin clients in the current tenant only. */
function emitMonitorEvent(req: Request, event: string, payload: unknown): void {
  const io = req.app.get('io');
  if (!io || !req.tenantId) return;
  io.to(`tenant:${req.tenantId}:admin`).emit(event, payload);
}

export const monitorsController = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const isAdmin = req.session.role === 'admin';
      const tenantScope = getEffectiveTenantScope(req);
      const visibleIds = await permissionService.getVisibleMonitorIds(req.session.userId!, isAdmin);

      let monitors;
      if (visibleIds === 'all') {
        monitors = await monitorService.getAll(tenantScope);
      } else {
        monitors = await monitorService.getByIds(visibleIds, tenantScope ?? undefined);
      }

      // Batch-resolve maintenance state for all monitors (single DB round-trip)
      const inMaintenanceIds = await maintenanceService.getInMaintenanceMonitorIds(
        monitors.map((m) => ({ id: m.id, groupId: m.groupId })),
      );
      const enriched = monitors.map((m) => ({
        ...m,
        inMaintenance: inMaintenanceIds.has(m.id),
      }));

      res.json({ success: true, data: enriched });
    } catch (err) {
      next(err);
    }
  },

  async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const monitor = await monitorService.getById(id);

      if (!monitor) {
        throw new AppError(404, 'Monitor not found');
      }

      // Check visibility
      const isAdmin = req.session.role === 'admin';
      if (!isAdmin) {
        const canRead = await permissionService.canReadMonitor(req.session.userId!, id, false);
        if (!canRead) throw new AppError(403, 'Access denied');
      }

      res.json({ success: true, data: monitor });
    } catch (err) {
      next(err);
    }
  },

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = req.body as CreateMonitorInput;
      const monitor = await monitorService.create(data, req.session.userId!, req.tenantId);

      // Auto-assign RW to creator's teams that have canCreate
      if (req.session.role !== 'admin') {
        const userTeams = await teamService.getUserTeams(req.session.userId!);
        for (const team of userTeams) {
          if (team.canCreate) {
            await teamService.addPermission(team.id, 'monitor', monitor.id, 'rw');
          }
        }
      }

      // Start worker for this monitor (performs first check immediately)
      const wm = MonitorWorkerManager.getInstance();
      await wm.startMonitor(monitor);

      // If this monitor uses a proxy agent, sync the config to the agent.
      if (monitor.proxyAgentDeviceId) {
        agentHub.syncAllProxyMonitors().catch(() => {});
      }

      // Wait briefly for the first check to complete, then return updated monitor
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const updated = await monitorService.getById(monitor.id);

      emitMonitorEvent(req, SOCKET_EVENTS.MONITOR_CREATED, { monitor: updated ?? monitor });
      res.status(201).json({ success: true, data: updated || monitor });
    } catch (err) {
      next(err);
    }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const monitor = await monitorService.update(id, req.body);

      if (!monitor) {
        throw new AppError(404, 'Monitor not found');
      }

      // Restart worker with new config
      const wm = MonitorWorkerManager.getInstance();
      await wm.restartMonitor(id);

      // Sync proxy configs to agents (covers add, change, and remove of proxy assignment)
      agentHub.syncAllProxyMonitors().catch(() => {});

      emitMonitorEvent(req, SOCKET_EVENTS.MONITOR_UPDATED, { monitorId: id, changes: monitor });
      res.json({ success: true, data: monitor });
    } catch (err) {
      next(err);
    }
  },

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);

      // Stop worker before deleting
      const wm = MonitorWorkerManager.getInstance();
      await wm.stopMonitor(id);

      const deleted = await monitorService.delete(id);
      if (!deleted) {
        throw new AppError(404, 'Monitor not found');
      }

      // Sync proxy configs so agents stop checking this monitor.
      agentHub.syncAllProxyMonitors().catch(() => {});

      emitMonitorEvent(req, SOCKET_EVENTS.MONITOR_DELETED, { monitorId: id });
      res.json({ success: true, message: 'Monitor deleted' });
    } catch (err) {
      next(err);
    }
  },

  async pause(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const monitor = await monitorService.getById(id);

      if (!monitor) {
        throw new AppError(404, 'Monitor not found');
      }

      const wm = MonitorWorkerManager.getInstance();
      const newStatus = monitor.status === 'paused' ? 'pending' : 'paused';
      await monitorService.updateStatus(id, newStatus);

      if (newStatus === 'paused') {
        await wm.stopMonitor(id);
      } else {
        await wm.restartMonitor(id);
      }

      emitMonitorEvent(req, SOCKET_EVENTS.MONITOR_PAUSED, { monitorId: id, isPaused: newStatus === 'paused' });
      res.json({
        success: true,
        data: { id, status: newStatus },
      });
    } catch (err) {
      next(err);
    }
  },

  async bulkDelete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { monitorIds } = req.body as { monitorIds: number[] };
      if (!Array.isArray(monitorIds) || monitorIds.length === 0) {
        throw new AppError(400, 'monitorIds array is required');
      }

      const isAdmin = req.session.role === 'admin';
      if (!isAdmin) {
        for (const mid of monitorIds) {
          const canWrite = await permissionService.canWriteMonitor(req.session.userId!, mid, false);
          if (!canWrite) throw new AppError(403, `No write permission on monitor ${mid}`);
        }
      }

      const wm = MonitorWorkerManager.getInstance();
      for (const id of monitorIds) {
        await wm.stopMonitor(id);
        await monitorService.delete(id);
        emitMonitorEvent(req, SOCKET_EVENTS.MONITOR_DELETED, { monitorId: id });
      }

      res.json({ success: true, message: `${monitorIds.length} monitor(s) deleted` });
    } catch (err) {
      next(err);
    }
  },

  async bulkPause(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { monitorIds, pause } = req.body as { monitorIds: number[]; pause: boolean };
      if (!Array.isArray(monitorIds) || monitorIds.length === 0) {
        throw new AppError(400, 'monitorIds array is required');
      }

      const isAdmin = req.session.role === 'admin';
      if (!isAdmin) {
        for (const mid of monitorIds) {
          const canWrite = await permissionService.canWriteMonitor(req.session.userId!, mid, false);
          if (!canWrite) throw new AppError(403, `No write permission on monitor ${mid}`);
        }
      }

      const wm = MonitorWorkerManager.getInstance();
      const newStatus = pause ? 'paused' : 'pending';

      for (const id of monitorIds) {
        await monitorService.updateStatus(id, newStatus);
        if (pause) {
          await wm.stopMonitor(id);
        } else {
          await wm.restartMonitor(id);
        }
        emitMonitorEvent(req, SOCKET_EVENTS.MONITOR_PAUSED, { monitorId: id, isPaused: pause });
      }

      res.json({ success: true, message: `${monitorIds.length} monitor(s) ${pause ? 'paused' : 'resumed'}` });
    } catch (err) {
      next(err);
    }
  },

  async bulkUpdate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { monitorIds, changes } = req.body as BulkUpdateInput;

      // Check write permission on all monitors
      const isAdmin = req.session.role === 'admin';
      if (!isAdmin) {
        for (const mid of monitorIds) {
          const canWrite = await permissionService.canWriteMonitor(req.session.userId!, mid, false);
          if (!canWrite) throw new AppError(403, `No write permission on monitor ${mid}`);
        }
      }

      const monitors = await monitorService.bulkUpdate(monitorIds, changes);

      // Restart all affected workers
      const wm = MonitorWorkerManager.getInstance();
      await wm.restartMonitors(monitorIds);

      for (const m of monitors) {
        emitMonitorEvent(req, SOCKET_EVENTS.MONITOR_UPDATED, { monitorId: m.id, changes: m });
      }
      res.json({ success: true, data: monitors });
    } catch (err) {
      next(err);
    }
  },

  async stats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const monitorId = parseInt(req.params.id, 10);
      const period = (req.query.period as string) || '24h';

      const monitor = await monitorService.getById(monitorId);
      if (!monitor) throw new AppError(404, 'Monitor not found');

      const isAdmin = req.session.role === 'admin';
      if (!isAdmin) {
        const canRead = await permissionService.canReadMonitor(req.session.userId!, monitorId, false);
        if (!canRead) throw new AppError(403, 'Access denied');
      }

      const since = new Date();
      switch (period) {
        case '1h': since.setHours(since.getHours() - 1); break;
        case '24h': since.setHours(since.getHours() - 24); break;
        case '7d': since.setDate(since.getDate() - 7); break;
        case '30d': since.setDate(since.getDate() - 30); break;
        case '365d': since.setDate(since.getDate() - 365); break;
        default: since.setHours(since.getHours() - 24);
      }

      const stats = await heartbeatService.getStats(monitorId, since);
      res.json({ success: true, data: { ...stats, period } });
    } catch (err) {
      next(err);
    }
  },

  async summary(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const since = new Date();
      since.setHours(since.getHours() - 24);

      // Restrict the aggregate to monitors the user can actually see. This
      // both plugs a cross-tenant data leak (any user was receiving uptime %
      // + avg RT for every monitor in every tenant) and lets Postgres drive
      // the per-monitor index range scan instead of full-scanning the whole
      // heartbeats table on every 60 s dashboard poll.
      const isAdmin = req.session.role === 'admin';
      const tenantScope = getEffectiveTenantScope(req);
      const visibleIds = await permissionService.getVisibleMonitorIds(req.session.userId!, isAdmin);

      let monitorIds: number[];
      if (visibleIds === 'all') {
        // Admin — restrict to the active tenant scope (or all in God View)
        const monitors = await monitorService.getAll(tenantScope);
        monitorIds = monitors.map((m) => m.id);
      } else {
        monitorIds = visibleIds;
      }

      const statsMap = await heartbeatService.getStatsForAllMonitors(since, monitorIds);
      const data: Record<number, { uptimePct: number; avgResponseTime: number | null }> = {};
      for (const [id, s] of statsMap) {
        data[id] = s;
      }
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },

  async allHeartbeats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const count = parseInt(req.query.count as string, 10) || 50;
      const clampedCount = Math.min(Math.max(count, 1), 300);

      const isAdmin = req.session.role === 'admin';
      const tenantScope = getEffectiveTenantScope(req);
      const visibleIds = await permissionService.getVisibleMonitorIds(req.session.userId!, isAdmin);

      // Resolve the concrete monitor id list to push into SQL — the previous
      // implementation window-numbered the whole heartbeats table then
      // filtered in JS, degrading to a full scan on any real install.
      let monitorIds: number[];
      if (visibleIds === 'all') {
        const monitors = await monitorService.getAll(tenantScope);
        monitorIds = monitors.map((m) => m.id);
      } else {
        monitorIds = visibleIds;
      }

      const allMap = await heartbeatService.getRecentForAllMonitors(monitorIds, clampedCount);

      const data: Record<number, Heartbeat[]> = {};
      for (const [id, hbs] of allMap) {
        data[id] = hbs;
      }

      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },

  async heartbeats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const monitorId = parseInt(req.params.id, 10);
      const period = req.query.period as string | undefined;

      const monitor = await monitorService.getById(monitorId);
      if (!monitor) {
        throw new AppError(404, 'Monitor not found');
      }

      const isAdmin = req.session.role === 'admin';
      if (!isAdmin) {
        const canRead = await permissionService.canReadMonitor(req.session.userId!, monitorId, false);
        if (!canRead) throw new AppError(403, 'Access denied');
      }

      // Custom range (zoom): ?from=<ISO>&to=<ISO>
      const fromStr = req.query.from as string | undefined;
      const toStr   = req.query.to   as string | undefined;
      if (fromStr && toStr) {
        const fromDate = new Date(fromStr);
        const toDate   = new Date(toStr);
        if (!isNaN(fromDate.getTime()) && !isNaN(toDate.getTime())) {
          const heartbeats = await heartbeatService.getByMonitorRange(monitorId, fromDate, toDate, 500);
          res.json({ success: true, data: heartbeats });
          return;
        }
      }

      if (period) {
        // Period-based fetch with downsampling
        const since = new Date();
        switch (period) {
          case '1h': since.setHours(since.getHours() - 1); break;
          case '24h': since.setHours(since.getHours() - 24); break;
          case '7d': since.setDate(since.getDate() - 7); break;
          case '30d': since.setDate(since.getDate() - 30); break;
          case '365d': since.setDate(since.getDate() - 365); break;
          default: since.setHours(since.getHours() - 24);
        }
        const heartbeats = await heartbeatService.getByMonitorSince(monitorId, since, 500);
        res.json({ success: true, data: heartbeats });
        return;
      }

      // Legacy pagination-based fetch
      const limit = parseInt(req.query.limit as string, 10) || 100;
      const offset = parseInt(req.query.offset as string, 10) || 0;
      const heartbeats = await heartbeatService.getByMonitor(monitorId, limit, offset);
      res.json({ success: true, data: heartbeats });
    } catch (err) {
      next(err);
    }
  },
};
