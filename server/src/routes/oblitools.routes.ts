/**
 * ObliTools manifest endpoint.
 * Called by the ObliTools desktop app after login to discover:
 *   - This app's display name, color, and SSO token path
 *   - All configured linked apps (URL + identity) for tab creation
 *
 * GET /api/oblitools/manifest   (requires session auth)
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { appConfigService } from '../services/appConfig.service';

const router = Router();

const SELF = { name: 'Obliview', color: '#6366f1' };

const LINKED: Record<string, { name: string; color: string }> = {
  obliguard: { name: 'Obliguard', color: '#8b5cf6' },
  oblimap:   { name: 'Oblimap',   color: '#10b981' },
  obliance:  { name: 'Obliance',  color: '#f59e0b' },
};

router.get('/manifest', requireAuth, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const [og, om, oa] = await Promise.all([
      appConfigService.getObliguardRaw(),
      appConfigService.getOblimapRaw(),
      appConfigService.getOblianceRaw(),
    ]);

    type LinkedApp = { name: string; url: string; color: string };
    const linkedApps: LinkedApp[] = [];
    if (og?.url) linkedApps.push({ ...LINKED.obliguard, url: og.url });
    if (om?.url) linkedApps.push({ ...LINKED.oblimap,   url: om.url });
    if (oa?.url) linkedApps.push({ ...LINKED.obliance,  url: oa.url });

    res.json({
      success: true,
      data: {
        ...SELF,
        ssoPath: '/api/sso/generate-token',
        linkedApps,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
