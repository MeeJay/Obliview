import type { Request, Response, NextFunction } from 'express';
import { appConfigService } from '../services/appConfig.service';
import { AppError } from '../middleware/errorHandler';

const ALLOWED_KEYS = [
  'allow_2fa', 'force_2fa', 'otp_smtp_server_id',
  'enable_foreign_sso', 'enable_oblimap_sso', 'enable_obliance_sso',
] as const;

export const appConfigController = {
  async getAll(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const cfg = await appConfigService.getAll();
      res.json({ success: true, data: cfg });
    } catch (err) { next(err); }
  },

  async set(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const key = req.params.key as typeof ALLOWED_KEYS[number];
      if (!ALLOWED_KEYS.includes(key)) throw new AppError(400, `Unknown config key: ${key}`);
      const { value } = req.body;
      if (value === undefined) throw new AppError(400, 'Missing value');
      await appConfigService.set(key, String(value));
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  /** GET /admin/config/agent-global */
  async getAgentGlobal(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const cfg = await appConfigService.getAgentGlobal();
      res.json({ success: true, data: cfg });
    } catch (err) { next(err); }
  },

  /** PATCH /admin/config/agent-global */
  async patchAgentGlobal(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { checkIntervalSeconds, heartbeatMonitoring, maxMissedPushes, notificationTypes } = req.body;
      const patch: Record<string, unknown> = {};
      if ('checkIntervalSeconds' in req.body) patch.checkIntervalSeconds = checkIntervalSeconds;
      if ('heartbeatMonitoring' in req.body) patch.heartbeatMonitoring = heartbeatMonitoring;
      if ('maxMissedPushes' in req.body) patch.maxMissedPushes = maxMissedPushes;
      if ('notificationTypes' in req.body) patch.notificationTypes = notificationTypes;
      const updated = await appConfigService.setAgentGlobal(patch);
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },

  /** GET /admin/config/obliguard — returns full config incl. apiKey (admin only) */
  async getObliguardConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const cfg = await appConfigService.getObliguardConfig();
      res.json({ success: true, data: cfg ?? { url: '', apiKey: '' } });
    } catch (err) { next(err); }
  },

  /** PUT /admin/config/obliguard — save url + apiKey (admin only) */
  async setObliguardConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { url, apiKey } = req.body as { url?: string; apiKey?: string };
      if (typeof url !== 'string' || typeof apiKey !== 'string') {
        throw new AppError(400, 'url and apiKey are required');
      }
      await appConfigService.setObliguardConfig({ url: url.trim(), apiKey: apiKey.trim() });
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // ── Oblimap ────────────────────────────────────────────────────────────────

  async getOblimapConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const cfg = await appConfigService.getOblimapConfig();
      res.json({ success: true, data: cfg ?? { url: '', apiKey: '' } });
    } catch (err) { next(err); }
  },

  async setOblimapConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { url, apiKey } = req.body as { url?: string; apiKey?: string };
      if (typeof url !== 'string' || typeof apiKey !== 'string') throw new AppError(400, 'url and apiKey are required');
      await appConfigService.setOblimapConfig({ url: url.trim(), apiKey: apiKey.trim() });
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // ── Obliance ───────────────────────────────────────────────────────────────

  async getOblianceConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const cfg = await appConfigService.getOblianceConfig();
      res.json({ success: true, data: cfg ?? { url: '', apiKey: '' } });
    } catch (err) { next(err); }
  },

  async setOblianceConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { url, apiKey } = req.body as { url?: string; apiKey?: string };
      if (typeof url !== 'string' || typeof apiKey !== 'string') throw new AppError(400, 'url and apiKey are required');
      await appConfigService.setOblianceConfig({ url: url.trim(), apiKey: apiKey.trim() });
      res.json({ success: true });
    } catch (err) { next(err); }
  },
};
