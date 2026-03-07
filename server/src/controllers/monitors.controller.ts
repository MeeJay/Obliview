import type { Request, Response, NextFunction } from 'express';
import type { Heartbeat } from '@obliview/shared';
import { monitorService } from '../services/monitor.service';
import { heartbeatService } from '../services/heartbeat.service';
import { permissionService } from '../services/permission.service';
import { teamService } from '../services/team.service';
import { MonitorWorkerManager } from '../workers/MonitorWorkerManager';
import { AppError } from '../middleware/errorHandler';
import type { CreateMonitorInput, BulkUpdateInput } from '../validators/monitor.schema';
import { maintenanceService } from '../services/maintenance.service';

export const monitorsController = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const isAdmin = req.session.role === 'admin';
      const visibleIds = await permissionService.getVisibleMonitorIds(req.session.userId!, isAdmin);

      let monitors;
      if (visibleIds === 'all') {
        monitors = await monitorService.getAll(req.tenantId);
      } else {
        monitors = await monitorService.getByIds(visibleIds, req.tenantId);
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

      // Wait briefly for the first check to complete, then return updated monitor
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const updated = await monitorService.getById(monitor.id);

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

      res.json({
        success: true,
        data: { id, status: newStatus },
      });
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

  async summary(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const since = new Date();
      since.setHours(since.getHours() - 24);
      const statsMap = await heartbeatService.getStatsForAllMonitors(since);
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
      const visibleIds = await permissionService.getVisibleMonitorIds(req.session.userId!, isAdmin);

      const allMap = await heartbeatService.getRecentForAllMonitors(clampedCount);

      // Filter to only visible monitors
      const data: Record<number, Heartbeat[]> = {};
      if (visibleIds === 'all') {
        for (const [id, hbs] of allMap) {
          data[id] = hbs;
        }
      } else {
        for (const id of visibleIds) {
          const hbs = allMap.get(id);
          if (hbs) data[id] = hbs;
        }
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
