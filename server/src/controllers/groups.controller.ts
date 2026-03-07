import type { Request, Response, NextFunction } from 'express';
import { groupService } from '../services/group.service';
import { heartbeatService } from '../services/heartbeat.service';
import { permissionService } from '../services/permission.service';
import { teamService } from '../services/team.service';
import { groupNotificationService } from '../services/groupNotification.service';
import { AppError } from '../middleware/errorHandler';
import type { CreateGroupInput, UpdateGroupInput, MoveGroupInput } from '../validators/group.schema';

export const groupsController = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const isAdmin = req.session.role === 'admin';
      const allGroups = await groupService.getAll(req.tenantId);

      if (isAdmin) {
        res.json({ success: true, data: allGroups });
        return;
      }

      const visibleIds = await permissionService.getVisibleGroupIds(req.session.userId!, false);
      if (visibleIds === 'all') {
        res.json({ success: true, data: allGroups });
        return;
      }

      const visibleSet = new Set(visibleIds);
      const filtered = allGroups.filter((g) => visibleSet.has(g.id));
      res.json({ success: true, data: filtered });
    } catch (err) {
      next(err);
    }
  },

  async tree(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const isAdmin = req.session.role === 'admin';
      const tree = await groupService.getTree(req.tenantId);

      if (isAdmin) {
        res.json({ success: true, data: tree });
        return;
      }

      const visibleIds = await permissionService.getVisibleGroupIds(req.session.userId!, false);
      if (visibleIds === 'all') {
        res.json({ success: true, data: tree });
        return;
      }

      // Filter tree to only include visible groups
      const visibleSet = new Set(visibleIds);
      function filterTree(nodes: typeof tree): typeof tree {
        return nodes
          .filter((n) => visibleSet.has(n.id))
          .map((n) => ({ ...n, children: filterTree(n.children) }));
      }
      res.json({ success: true, data: filterTree(tree) });
    } catch (err) {
      next(err);
    }
  },

  async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const group = await groupService.getById(id);
      if (!group) throw new AppError(404, 'Group not found');

      const isAdmin = req.session.role === 'admin';
      if (!isAdmin) {
        const canRead = await permissionService.canReadGroup(req.session.userId!, id, false);
        if (!canRead) throw new AppError(403, 'Access denied');
      }

      res.json({ success: true, data: group });
    } catch (err) {
      next(err);
    }
  },

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = req.body as CreateGroupInput;

      // Validate parent exists if specified
      if (data.parentId) {
        const parent = await groupService.getById(data.parentId);
        if (!parent) throw new AppError(400, 'Parent group not found');
      }

      const group = await groupService.create(data, req.tenantId);

      // Auto-assign RW to creator's teams that have canCreate
      if (req.session.role !== 'admin') {
        const userTeams = await teamService.getUserTeams(req.session.userId!);
        for (const team of userTeams) {
          if (team.canCreate) {
            await teamService.addPermission(team.id, 'group', group.id, 'rw');
          }
        }
      }

      // Broadcast via Socket.io
      const io = req.app.get('io');
      if (io) {
        io.to('role:admin').emit('group:created', { group });
      }

      res.status(201).json({ success: true, data: group });
    } catch (err) {
      next(err);
    }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const data = req.body as UpdateGroupInput;
      const group = await groupService.update(id, data);

      if (!group) throw new AppError(404, 'Group not found');

      if (data.groupNotifications !== undefined) {
        groupNotificationService.removeGroup(id);
      }

      const io = req.app.get('io');
      if (io) {
        io.to('role:admin').emit('group:updated', { group });
      }

      res.json({ success: true, data: group });
    } catch (err) {
      next(err);
    }
  },

  async move(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const { newParentId } = req.body as MoveGroupInput;

      // Also check write permission on target parent if non-admin
      const isAdmin = req.session.role === 'admin';
      if (!isAdmin && newParentId !== null) {
        const canWriteTarget = await permissionService.canWriteGroup(req.session.userId!, newParentId, false);
        if (!canWriteTarget) throw new AppError(403, 'No write permission on target group');
      }

      const group = await groupService.move(id, newParentId);
      if (!group) throw new AppError(404, 'Group not found');

      const io = req.app.get('io');
      if (io) {
        io.to('role:admin').emit('group:moved', { group });
      }

      res.json({ success: true, data: group });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('circular')) {
        next(new AppError(400, err.message));
      } else {
        next(err);
      }
    }
  },

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);

      groupNotificationService.removeGroup(id);

      const deleted = await groupService.delete(id);
      if (!deleted) throw new AppError(404, 'Group not found');

      const io = req.app.get('io');
      if (io) {
        io.to('role:admin').emit('group:deleted', { groupId: id });
      }

      res.json({ success: true, message: 'Group deleted' });
    } catch (err) {
      next(err);
    }
  },

  async stats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const since = new Date();
      since.setHours(since.getHours() - 24);

      const rawStats = await heartbeatService.getRawStatsPerGroup(since);

      const { db: database } = await import('../db');
      const closureRows = await database('group_closure')
        .select('ancestor_id', 'descendant_id');

      const descendantsMap = new Map<number, number[]>();
      for (const row of closureRows) {
        if (!descendantsMap.has(row.ancestor_id)) {
          descendantsMap.set(row.ancestor_id, []);
        }
        descendantsMap.get(row.ancestor_id)!.push(row.descendant_id);
      }

      const isAdmin = req.session.role === 'admin';
      const visibleIds = await permissionService.getVisibleGroupIds(req.session.userId!, isAdmin);

      const allGroups = await groupService.getAll(req.tenantId);
      const result: Record<number, { uptimePct: number; total: number; up: number }> = {};

      for (const group of allGroups) {
        // Skip if not visible
        if (visibleIds !== 'all' && !visibleIds.includes(group.id)) continue;

        const descendants = descendantsMap.get(group.id) || [group.id];
        let total = 0;
        let up = 0;

        for (const descId of descendants) {
          const stats = rawStats.get(descId);
          if (stats) {
            total += stats.total;
            up += stats.up;
          }
        }

        result[group.id] = {
          total,
          up,
          uptimePct: total > 0 ? Math.round((up / total) * 10000) / 100 : 100,
        };
      }

      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  },

  async clearHeartbeats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const groupId = parseInt(req.params.id, 10);
      const group = await groupService.getById(groupId);
      if (!group) throw new AppError(404, 'Group not found');

      const { db: database } = await import('../db');
      const closureRows = await database('group_closure')
        .where({ ancestor_id: groupId })
        .select('descendant_id');
      const groupIds = closureRows.map((r: any) => r.descendant_id);

      const monitorRows = await database('monitors')
        .whereIn('group_id', groupIds)
        .select('id');
      const monitorIds = monitorRows.map((r: any) => r.id);

      const deleted = await heartbeatService.clearForMonitors(monitorIds);

      res.json({ success: true, data: { deleted, monitorCount: monitorIds.length } });
    } catch (err) {
      next(err);
    }
  },

  async reorder(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const items = req.body.items as { id: number; sortOrder: number }[];
      if (!Array.isArray(items) || items.length === 0) {
        throw new AppError(400, 'items array is required');
      }
      await groupService.reorder(items);

      const io = req.app.get('io');
      if (io) {
        io.to('role:admin').emit('group:reordered', { items });
      }

      res.json({ success: true, message: 'Groups reordered' });
    } catch (err) {
      next(err);
    }
  },

  async getMonitors(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const groupId = parseInt(req.params.id, 10);
      const group = await groupService.getById(groupId);
      if (!group) throw new AppError(404, 'Group not found');

      // Check read permission
      const isAdmin = req.session.role === 'admin';
      if (!isAdmin) {
        const canRead = await permissionService.canReadGroup(req.session.userId!, groupId, false);
        if (!canRead) throw new AppError(403, 'Access denied');
      }

      const { db: database } = await import('../db');
      const descendants = req.query.descendants === 'true';

      let rows;
      if (descendants) {
        const descendantIds = await groupService.getDescendantIds(groupId);
        rows = await database('monitors')
          .whereIn('group_id', descendantIds)
          .orderBy('name');
      } else {
        rows = await database('monitors')
          .where({ group_id: groupId })
          .orderBy('name');
      }

      // For non-admin users, further filter to only visible monitors
      if (!isAdmin) {
        const visibleMonitorIds = await permissionService.getVisibleMonitorIds(req.session.userId!, false);
        if (visibleMonitorIds !== 'all') {
          const visibleSet = new Set(visibleMonitorIds);
          rows = rows.filter((r: any) => visibleSet.has(r.id));
        }
      }

      res.json({ success: true, data: rows });
    } catch (err) {
      next(err);
    }
  },

  async heartbeats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const groupId = parseInt(req.params.id, 10);
      const period = (req.query.period as string) || '24h';

      const group = await groupService.getById(groupId);
      if (!group) throw new AppError(404, 'Group not found');

      const isAdmin = req.session.role === 'admin';
      if (!isAdmin) {
        const canRead = await permissionService.canReadGroup(req.session.userId!, groupId, false);
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

      const heartbeats = await heartbeatService.getByGroupSince(groupId, since);
      res.json({ success: true, data: heartbeats });
    } catch (err) {
      next(err);
    }
  },

  async groupDetailStats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const groupId = parseInt(req.params.id, 10);
      const period = (req.query.period as string) || '24h';

      const group = await groupService.getById(groupId);
      if (!group) throw new AppError(404, 'Group not found');

      const isAdmin = req.session.role === 'admin';
      if (!isAdmin) {
        const canRead = await permissionService.canReadGroup(req.session.userId!, groupId, false);
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

      const stats = await heartbeatService.getGroupStats(groupId, since);
      res.json({ success: true, data: stats });
    } catch (err) {
      next(err);
    }
  },

  /** PATCH /groups/:id/agent-config — update agent group config (thresholds + group settings) */
  async updateAgentGroupConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const groupId = parseInt(req.params.id, 10);
      if (req.session.role !== 'admin') throw new AppError(403, 'Admin only');

      const group = await groupService.getById(groupId);
      if (!group) throw new AppError(404, 'Group not found');
      if (group.kind !== 'agent') throw new AppError(400, 'Not an agent group');

      const { agentGroupConfig, agentThresholds } = req.body as {
        agentGroupConfig?: { pushIntervalSeconds?: number | null; heartbeatMonitoring?: boolean | null; maxMissedPushes?: number | null };
        agentThresholds?: unknown;
      };

      let updated = group;
      if (agentGroupConfig !== undefined) {
        updated = (await groupService.updateAgentGroupConfig(groupId, agentGroupConfig)) ?? updated;
      }
      if (agentThresholds !== undefined) {
        updated = (await groupService.updateAgentThresholds(groupId, agentThresholds as any)) ?? updated;
      }

      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  },
};
