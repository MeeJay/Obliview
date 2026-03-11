import { Router } from 'express';
import { appConfigController } from '../controllers/appConfig.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';

const router = Router();

// GET is available to all authenticated users (needed for profile page to check allow_2fa)
router.get('/', requireAuth, appConfigController.getAll);
// PUT is admin only
router.put('/:key', requireAuth, requireRole('admin'), appConfigController.set);

// Agent global defaults — admin only
router.get('/agent-global', requireAuth, requireRole('admin'), appConfigController.getAgentGlobal);
router.patch('/agent-global', requireAuth, requireRole('admin'), appConfigController.patchAgentGlobal);

// Obliguard integration config — admin only (includes apiKey)
router.get('/obliguard', requireAuth, requireRole('admin'), appConfigController.getObliguardConfig);
router.put('/obliguard', requireAuth, requireRole('admin'), appConfigController.setObliguardConfig);

export default router;
