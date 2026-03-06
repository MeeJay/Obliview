import { Router } from 'express';
import authRoutes from './auth.routes';
import monitorsRoutes from './monitors.routes';
import groupsRoutes from './groups.routes';
import settingsRoutes from './settings.routes';
import notificationsRoutes from './notifications.routes';
import heartbeatRoutes from './heartbeat.routes';
import usersRoutes from './users.routes';
import profileRoutes from './profile.routes';
import teamsRoutes from './teams.routes';
import agentRoutes from './agent.routes';
import importExportRoutes from './importExport.routes';
import remediationRoutes from './remediation.routes';
import smtpServerRoutes from './smtpServer.routes';
import appConfigRoutes from './appConfig.routes';
import twoFactorRoutes from './twoFactor.routes';
import maintenanceRoutes from './maintenance.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/monitors', monitorsRoutes);
router.use('/groups', groupsRoutes);
router.use('/settings', settingsRoutes);
router.use('/notifications', notificationsRoutes);
router.use('/heartbeat', heartbeatRoutes);
router.use('/users', usersRoutes);
router.use('/profile/2fa', twoFactorRoutes); // must be before /profile (more specific first)
router.use('/profile', profileRoutes);
router.use('/teams', teamsRoutes);
router.use('/agent', agentRoutes);
router.use('/admin', importExportRoutes);
router.use('/remediation', remediationRoutes);
router.use('/admin/smtp-servers', smtpServerRoutes);
router.use('/admin/config', appConfigRoutes);
router.use('/maintenance', maintenanceRoutes);

export { router as routes };
