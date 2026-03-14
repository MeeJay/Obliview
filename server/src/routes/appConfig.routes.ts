import { Router } from 'express';
import { appConfigController } from '../controllers/appConfig.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';

const router = Router();

// GET is available to all authenticated users (needed for profile page to check allow_2fa)
router.get('/', requireAuth, appConfigController.getAll);

// Specific named routes MUST come before /:key (otherwise /:key captures them first)

// Agent global defaults — admin only
router.get('/agent-global', requireAuth, requireRole('admin'), appConfigController.getAgentGlobal);
router.patch('/agent-global', requireAuth, requireRole('admin'), appConfigController.patchAgentGlobal);

// Obliguard integration config — admin only (includes apiKey)
router.get('/obliguard', requireAuth, requireRole('admin'), appConfigController.getObliguardConfig);
router.put('/obliguard', requireAuth, requireRole('admin'), appConfigController.setObliguardConfig);

// Oblimap integration config — admin only
router.get('/oblimap', requireAuth, requireRole('admin'), appConfigController.getOblimapConfig);
router.put('/oblimap', requireAuth, requireRole('admin'), appConfigController.setOblimapConfig);

// Obliance integration config — admin only
router.get('/obliance', requireAuth, requireRole('admin'), appConfigController.getOblianceConfig);
router.put('/obliance', requireAuth, requireRole('admin'), appConfigController.setOblianceConfig);

// Generic key setter — must be LAST among PUT routes
router.put('/:key', requireAuth, requireRole('admin'), appConfigController.set);

export default router;
