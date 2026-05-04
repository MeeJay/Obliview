import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../db';
import { obligateService } from '../services/obligate.service';
import { tenantService } from '../services/tenant.service';
import { appConfigService } from '../services/appConfig.service';
import { permissionSetService } from '../services/permissionSet.service';
import { logger } from '../utils/logger';

const router = Router();

/**
 * GET /auth/callback?code=xxx&state=xxx
 * Called by Obligate after successful authentication.
 * Exchanges the code for user info, auto-provisions, creates session, redirects.
 */
router.get('/callback', async (req, res) => {
  try {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code) {
      res.status(400).json({ success: false, error: 'Missing code' });
      return;
    }

    // Validate CSRF state parameter (RFC 6749 §10.12)
    const expectedState = req.session?.oauthState;
    if (!expectedState || !state || state !== expectedState) {
      logger.warn({ expectedState: !!expectedState, receivedState: !!state }, 'Obligate callback: state mismatch — possible CSRF');
      res.redirect('/login?error=sso_failed');
      return;
    }
    // Clear used state
    delete req.session.oauthState;

    // Build the redirect_uri that was used in the authorize request
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const redirectUri = `${protocol}://${host}/auth/callback`;

    // Exchange code with Obligate
    logger.info({ redirectUri }, 'Obligate callback: exchanging code');
    const assertion = await obligateService.exchangeCode(code, redirectUri);
    if (!assertion) {
      logger.warn('Obligate callback: exchange returned null — code invalid/expired or redirect_uri mismatch');
      res.redirect('/login?error=sso_failed');
      return;
    }
    logger.info({ obligateUserId: assertion.obligateUserId, username: assertion.username }, 'Obligate callback: exchange OK');

    // Find or create local user
    let localUserId: number;
    let needsProvision = false;

    if (assertion.linkedLocalUserId) {
      // Obligate already knows our local user ID (previously linked) — verify it still exists
      const existingUser = await db('users').where({ id: assertion.linkedLocalUserId }).first();
      if (existingUser) {
        localUserId = assertion.linkedLocalUserId;
        await db('users').where({ id: localUserId }).update({
          role: assertion.role === 'admin' ? 'admin' : 'user',
          email: assertion.email,
          display_name: assertion.displayName,
          updated_at: new Date(),
        });
      } else {
        // Stale reference — user was deleted locally. Clean up Obligate's link and re-provision.
        logger.warn(`Obligate linkedLocalUserId ${assertion.linkedLocalUserId} no longer exists — will re-provision`);
        obligateService.reportProvision(assertion.obligateUserId, 0).catch(() => {});
        needsProvision = true;
        localUserId = 0; // will be set below
      }
    } else {
      // Check sso_foreign_users for existing link
      const existingLink = await db('sso_foreign_users')
        .where({ foreign_source: 'obligate', foreign_user_id: assertion.obligateUserId })
        .first() as { local_user_id: number } | undefined;

      if (existingLink) {
        // Verify the linked local user still exists
        const existingUser = await db('users').where({ id: existingLink.local_user_id }).first();
        if (existingUser) {
          localUserId = existingLink.local_user_id;
          await db('users').where({ id: localUserId }).update({
            role: assertion.role === 'admin' ? 'admin' : 'user',
            email: assertion.email,
            display_name: assertion.displayName,
            updated_at: new Date(),
          });
        } else {
          // Stale sso_foreign_users record — clean it up and re-provision
          logger.warn(`sso_foreign_users points to deleted user ${existingLink.local_user_id} — cleaning up and re-provisioning`);
          await db('sso_foreign_users').where({ foreign_source: 'obligate', foreign_user_id: assertion.obligateUserId }).del();
          needsProvision = true;
          localUserId = 0;
        }
      } else {
        needsProvision = true;
        localUserId = 0;
      }
    }

    if (needsProvision) {
      // Create new local user (foreign_source='obligate', no password)
      // SSO users skip local enrollment — mark as fully enrolled immediately
      const [newUser] = await db('users')
        .insert({
          username: `og_${assertion.username}`,
          display_name: assertion.displayName || assertion.username,
          email: assertion.email,
          role: assertion.role === 'admin' ? 'admin' : 'user',
          is_active: true,
          foreign_source: 'obligate',
          foreign_id: assertion.obligateUserId,
          enrollment_version: 999,
        })
        .returning('id') as Array<{ id: number }>;
      localUserId = newUser.id;

      // Record in sso_foreign_users (upsert in case stale record existed)
      await db('sso_foreign_users')
        .insert({ foreign_source: 'obligate', foreign_user_id: assertion.obligateUserId, local_user_id: localUserId })
        .onConflict(['foreign_source', 'foreign_user_id'])
        .merge({ local_user_id: localUserId });

      // Report new local ID back to Obligate
      obligateService.reportProvision(assertion.obligateUserId, localUserId).catch(() => {});
    }

    // Sync tenants + capabilities from Obligate (every SSO login).
    // Collect the local tenant ids the user has access to so we can scope the
    // subsequent team_memberships sync (we only touch memberships in teams
    // visible to one of the user's accessible tenants — admin-added memberships
    // in unrelated tenants are preserved).
    const userTenantIds: number[] = [];
    for (const t of assertion.tenants) {
      const tenant = await db('tenants').where({ slug: t.slug }).first() as { id: number } | undefined;
      if (tenant) {
        userTenantIds.push(tenant.id);
        await db('user_tenants')
          .insert({ user_id: localUserId, tenant_id: tenant.id, role: t.role === 'admin' ? 'admin' : 'member' })
          .onConflict(['user_id', 'tenant_id'])
          .merge({ role: t.role === 'admin' ? 'admin' : 'member' });

        if (t.capabilities?.length) {
          const userTeamIds = await db('team_memberships')
            .join('user_teams', 'user_teams.id', 'team_memberships.team_id')
            .where({ 'team_memberships.user_id': localUserId, 'user_teams.tenant_id': tenant.id })
            .pluck('team_memberships.team_id') as number[];
          for (const teamId of userTeamIds) {
            await db('team_permissions')
              .where({ team_id: teamId })
              .update({ capabilities: JSON.stringify(t.capabilities) });
          }
        }
      }
    }

    // ── Sync team_memberships from assertion.teams (every SSO login) ──────
    // Obligate sends the list of team NAMES the user should belong to (per
    // their permission-group → app role mapping). We resolve those names to
    // local team ids (tenant-local OR global-with-scope), then replace the
    // user's memberships within the in-scope team set. Memberships in teams
    // belonging to tenants the user has no longer has access to are left
    // alone — defence-in-depth so an admin's manual cross-tenant assignment
    // isn't accidentally nuked by a partial assertion.
    if (userTenantIds.length > 0) {
      const teamNames = assertion.teams ?? [];

      // 1. Resolve asserted team names → local ids (within user's tenants).
      let assertedTeamIds: number[] = [];
      if (teamNames.length > 0) {
        const rows = await db('user_teams as ut')
          .leftJoin('team_tenant_scopes as tts', 'tts.team_id', 'ut.id')
          .whereIn('ut.name', teamNames)
          .where((qb) => {
            qb.whereIn('ut.tenant_id', userTenantIds)
              .orWhere((sub) => {
                sub.where('ut.is_global', true).whereIn('tts.tenant_id', userTenantIds);
              });
          })
          .distinct('ut.id')
          .pluck('ut.id') as number[];
        assertedTeamIds = rows;
      }

      // 2. Find every team currently in the user's accessible-tenant scope.
      const inScopeTeamIds = await db('user_teams as ut')
        .leftJoin('team_tenant_scopes as tts', 'tts.team_id', 'ut.id')
        .where((qb) => {
          qb.whereIn('ut.tenant_id', userTenantIds)
            .orWhere((sub) => {
              sub.where('ut.is_global', true).whereIn('tts.tenant_id', userTenantIds);
            });
        })
        .distinct('ut.id')
        .pluck('ut.id') as number[];

      // 3. Drop in-scope memberships that aren't in the assertion, then insert
      //    the asserted set (idempotent via onConflict).
      if (inScopeTeamIds.length > 0) {
        const stale = inScopeTeamIds.filter((id) => !assertedTeamIds.includes(id));
        if (stale.length > 0) {
          await db('team_memberships')
            .where({ user_id: localUserId })
            .whereIn('team_id', stale)
            .del();
        }
      }
      if (assertedTeamIds.length > 0) {
        await db('team_memberships')
          .insert(assertedTeamIds.map((team_id) => ({ user_id: localUserId, team_id })))
          .onConflict(['user_id', 'team_id'])
          .ignore();
      }

      logger.info(
        { userId: localUserId, assertedTeams: teamNames, resolvedTeamIds: assertedTeamIds },
        'Obligate SSO: synced team memberships',
      );
    }

    // Sync preferences from Obligate (theme, language, toast settings)
    if (assertion.preferences) {
      const prefUpdate: Record<string, unknown> = {};
      if (assertion.preferences.preferredLanguage) prefUpdate.preferred_language = assertion.preferences.preferredLanguage;
      if (assertion.preferences.profilePhotoUrl !== undefined) prefUpdate.avatar = assertion.preferences.profilePhotoUrl;
      if (Object.keys(prefUpdate).length > 0) {
        await db('users').where({ id: localUserId }).update(prefUpdate);
      }
      const uiPrefs: Record<string, unknown> = {};
      if (assertion.preferences.preferredTheme) uiPrefs.preferredTheme = assertion.preferences.preferredTheme;
      if (assertion.preferences.toastEnabled !== undefined) uiPrefs.toastEnabled = assertion.preferences.toastEnabled;
      if (assertion.preferences.toastPosition) uiPrefs.toastPosition = assertion.preferences.toastPosition;
      if (assertion.preferences.anonymousMode !== undefined) uiPrefs.anonymousMode = assertion.preferences.anonymousMode;
      if (Object.keys(uiPrefs).length > 0) {
        const existingRow = await db('users').where({ id: localUserId }).select('preferences').first() as { preferences: unknown } | undefined;
        const existing = (typeof existingRow?.preferences === 'string' ? JSON.parse(existingRow.preferences) : existingRow?.preferences) ?? {};
        await db('users').where({ id: localUserId }).update({
          preferences: JSON.stringify({ ...existing, ...uiPrefs }),
        });
      }
    }

    // Establish session
    req.session.userId = localUserId;
    const user = await db('users').where({ id: localUserId }).first() as { username: string; role: string } | undefined;
    if (user) {
      req.session.username = user.username;
      req.session.role = user.role;
    }

    // Set tenant — cross-app handoff: prefer the slug requested by the
    // source Obli* app (set in /auth/sso-redirect from `?tenant=<slug>`)
    // when the user has access to a tenant of that slug. Otherwise fall
    // back to the first available tenant. Spec:
    // D:\Mockup\obli-cross-app-tenant-handoff.md
    let resolvedTenantId: number | null = null;
    const requestedSlug = req.session.requestedTenantSlug;
    if (requestedSlug) {
      const match = await db('tenants as t')
        .join('user_tenants as ut', 'ut.tenant_id', 't.id')
        .where({ 't.slug': requestedSlug, 'ut.user_id': localUserId })
        .select('t.id')
        .first() as { id: number } | undefined;
      if (match) {
        resolvedTenantId = match.id;
        logger.info({ userId: localUserId, slug: requestedSlug }, 'Cross-app handoff: tenant matched');
      } else {
        logger.info({ userId: localUserId, slug: requestedSlug },
          'Cross-app handoff: requested tenant not accessible, falling back');
      }
      // Always clear so the slug does not leak into a subsequent login that
      // did not originate from a cross-app pill click.
      delete req.session.requestedTenantSlug;
    }

    if (resolvedTenantId === null) {
      const tenant = await tenantService.getFirstTenantForUser(localUserId);
      resolvedTenantId = tenant?.id ?? 1;
    }
    req.session.currentTenantId = resolvedTenantId;

    logger.info(`Obligate SSO: user ${assertion.username} (obligate #${assertion.obligateUserId}) → local #${localUserId}`);

    // Save session, then redirect via HTML meta refresh to ensure Set-Cookie header
    // is fully processed by the browser before navigation occurs.
    req.session.save((err) => {
      if (err) { logger.error(err, 'Session save failed'); res.redirect('/login?error=sso_failed'); return; }
      logger.info({ sessionId: req.sessionID, userId: req.session.userId }, 'Session saved, redirecting to /');
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/"><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1117;color:#8b949e;font-family:-apple-system,BlinkMacSystemFont,sans-serif}.s{text-align:center}.d{width:28px;height:28px;border:2.5px solid #30363d;border-top-color:#58a6ff;border-radius:50%;animation:r .6s linear infinite;margin:0 auto 14px}@keyframes r{to{transform:rotate(360deg)}}</style></head><body><div class="s"><div class="d"></div><div>Signing in...</div></div></body></html>`);
    });
  } catch (err) {
    logger.error(err, 'Obligate callback error');
    res.redirect('/login?error=sso_failed');
  }
});

/**
 * GET /auth/sso-redirect
 * Server-side redirect to Obligate authorize endpoint (browser redirect).
 * The server knows the API key — the client never sees it.
 */
router.get('/sso-redirect', async (req, res) => {
  try {
    // Cross-app tenant handoff: the source Obli* app appends ?tenant=<slug>
    // when the user clicks the topbar switcher pill. Stash it in the session
    // so /auth/callback can apply it once the user comes back from Obligate.
    // Validate against the same regex the tenants table enforces — anything
    // else is dropped silently (defence-in-depth, untrusted query input).
    // Spec: D:\Mockup\obli-cross-app-tenant-handoff.md
    const requestedTenant = req.query.tenant;
    if (typeof requestedTenant === 'string' && /^[a-z0-9-]{1,64}$/.test(requestedTenant)) {
      req.session.requestedTenantSlug = requestedTenant;
    }

    const raw = await (await import('../services/appConfig.service')).appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) {
      res.redirect('/login');
      return;
    }
    // Verify Obligate is reachable before redirecting (prevents redirect loop when Gate is down)
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const healthRes = await fetch(`${raw.url}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!healthRes.ok) { res.redirect('/login?error=sso_failed'); return; }
    } catch {
      res.redirect('/login?error=sso_failed');
      return;
    }
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const selfUrl = `${protocol}://${host}`;
    // Safety: never redirect to ourselves (misconfigured obligate_url pointing to this app)
    if (raw.url.replace(/\/$/, '') === selfUrl.replace(/\/$/, '')) {
      logger.error({ obligateUrl: raw.url, selfUrl }, 'sso-redirect: obligate_url points to this app — aborting to prevent loop');
      res.redirect('/login?error=sso_misconfigured');
      return;
    }
    const redirectUri = `${selfUrl}/auth/callback`;
    // Generate CSRF state token and store in session (RFC 6749 §10.12)
    const oauthState = crypto.randomBytes(32).toString('hex');
    req.session.oauthState = oauthState;
    const obligateUrl = `${raw.url}/authorize?client_id=${encodeURIComponent(raw.apiKey)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(oauthState)}`;
    logger.info({ obligateUrl: raw.url, redirectUri }, 'sso-redirect: redirecting to Obligate');
    // Save session before redirect to ensure state is persisted
    req.session.save(() => {
      res.redirect(obligateUrl);
    });
  } catch {
    res.redirect('/login');
  }
});

/**
 * GET /api/auth/app-info
 * Called by Obligate (Bearer auth) to discover teams + tenants for mapping UI.
 */
router.get('/app-info', async (req, res) => {
  try {
    // Validate Bearer token = our Obligate API key (reverse auth: Obligate calls us)
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ success: false, error: 'Missing Bearer token' });
      return;
    }
    const raw = await appConfigService.getObligateRaw();
    if (!raw.apiKey || authHeader.slice(7) !== raw.apiKey) {
      res.status(401).json({ success: false, error: 'Invalid API key' });
      return;
    }

    // Fetch all local (non-global) teams
    const localTeams = await db('user_teams')
      .join('tenants', 'user_teams.tenant_id', 'tenants.id')
      .where('user_teams.is_global', false)
      .select('user_teams.id', 'user_teams.name', 'tenants.slug as tenant_slug', 'tenants.name as tenant_name')
      .orderBy('tenants.name')
      .orderBy('user_teams.name') as Array<{ id: number; name: string; tenant_slug: string; tenant_name: string }>;

    // Fetch global teams — expand once per target tenant + once for their home tenant
    const globalTeams = await db('user_teams')
      .where('user_teams.is_global', true)
      .select('user_teams.id', 'user_teams.name', 'user_teams.tenant_id') as Array<{ id: number; name: string; tenant_id: number }>;

    const globalTeamEntries: Array<{ id: number; name: string; tenant_slug: string; tenant_name: string }> = [];
    for (const gt of globalTeams) {
      // Home tenant
      const homeTenant = await db('tenants').where({ id: gt.tenant_id }).first() as { slug: string; name: string } | undefined;
      if (homeTenant) {
        globalTeamEntries.push({ id: gt.id, name: gt.name, tenant_slug: homeTenant.slug, tenant_name: homeTenant.name });
      }
      // Target tenants
      const targets = await db('team_tenant_scopes')
        .join('tenants', 'team_tenant_scopes.tenant_id', 'tenants.id')
        .where('team_tenant_scopes.team_id', gt.id)
        .select('tenants.slug', 'tenants.name') as Array<{ slug: string; name: string }>;
      for (const t of targets) {
        if (t.slug !== homeTenant?.slug) {
          globalTeamEntries.push({ id: gt.id, name: gt.name, tenant_slug: t.slug, tenant_name: t.name });
        }
      }
    }

    const allTeams = [...localTeams, ...globalTeamEntries];

    // Fetch all tenants
    const tenants = await db('tenants')
      .select('id', 'name', 'slug')
      .orderBy('name') as Array<{ id: number; name: string; slug: string }>;

    const permissionSets = await permissionSetService.getAll();

    res.json({
      success: true,
      data: {
        roles: ['admin', 'user'],
        teams: allTeams.map(t => ({ id: t.id, name: t.name, tenantSlug: t.tenant_slug, tenantName: t.tenant_name })),
        tenants: tenants.map(t => ({ slug: t.slug, name: t.name })),
        permissionSets,
      },
    });
  } catch (err) {
    logger.error(err, 'app-info error');
    res.status(500).json({ success: false, error: 'Failed to fetch app info' });
  }
});

/**
 * GET /api/auth/dashboard-stats
 * Called by Obligate (Bearer auth) to display stats on the Obligate dashboard.
 */
router.get('/dashboard-stats', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) { res.status(401).json({ success: false }); return; }
    const raw = await appConfigService.getObligateRaw();
    if (!raw.apiKey || authHeader.slice(7) !== raw.apiKey) { res.status(401).json({ success: false }); return; }

    const [up, down, paused, agents] = await Promise.all([
      db('monitors').where({ status: 'up', is_active: true }).count('id as c').first(),
      db('monitors').where({ status: 'down', is_active: true }).count('id as c').first(),
      db('monitors').where({ is_active: false }).count('id as c').first(),
      db('agent_devices').where({ status: 'approved' }).count('id as c').first(),
    ]);
    res.json({ success: true, data: { stats: [
      { label: 'Monitors Up', value: Number((up as any)?.c ?? 0), color: '#2ea043' },
      { label: 'Monitors Down', value: Number((down as any)?.c ?? 0), color: '#f85149' },
      { label: 'Paused', value: Number((paused as any)?.c ?? 0), color: '#8b949e' },
      { label: 'Agents', value: Number((agents as any)?.c ?? 0), color: '#58a6ff' },
    ] } });
  } catch { res.json({ success: true, data: null }); }
});

/**
 * GET /api/auth/sso-config
 * Returns Obligate SSO config for the LoginPage (public, no auth required).
 */
router.get('/sso-config', async (_req, res) => {
  try {
    const config = await obligateService.getSsoConfig();
    res.json({ success: true, data: config });
  } catch (err) {
    res.json({ success: true, data: { obligateUrl: null, obligateReachable: false, obligateEnabled: false } });
  }
});

/**
 * GET /api/auth/sso-logout-url
 * Returns the Obligate logout URL so the client can redirect there after local logout.
 */
router.get('/sso-logout-url', async (req, res) => {
  try {
    const cfg = await appConfigService.getObligateRaw();
    if (!cfg.url) {
      res.json({ success: true, data: null });
      return;
    }
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const redirectUri = `${protocol}://${host}/login`;
    const logoutUrl = `${cfg.url}/logout?redirect_uri=${encodeURIComponent(redirectUri)}`;
    res.json({ success: true, data: logoutUrl });
  } catch {
    res.json({ success: true, data: null });
  }
});

/**
 * GET /api/auth/connected-apps
 * Returns list of connected apps from Obligate (for cross-app nav buttons).
 */
router.get('/connected-apps', async (req, res) => {
  try {
    if (!req.session?.userId) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }
    const apps = await obligateService.getConnectedApps();
    res.json({ success: true, data: apps });
  } catch (err) {
    res.json({ success: true, data: [] });
  }
});

/**
 * GET /api/auth/device-links?uuid=xxx
 * Returns cross-app links for a device UUID via Obligate.
 */
router.get('/device-links', async (req, res) => {
  try {
    if (!req.session?.userId) { res.status(401).json({ success: false }); return; }
    const uuid = req.query.uuid as string;
    if (!uuid) { res.json({ success: true, data: [] }); return; }
    const links = await obligateService.getDeviceLinks(uuid);
    res.json({ success: true, data: links });
  } catch {
    res.json({ success: true, data: [] });
  }
});

/**
 * POST /api/auth/sso-user-sync
 * Called by Obligate (Bearer auth) when an SSO user is deactivated, reactivated, deleted, or role-changed.
 */
router.post('/sso-user-sync', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) { res.status(401).json({ success: false }); return; }
    const raw = await appConfigService.getObligateRaw();
    if (!raw.apiKey || authHeader.slice(7) !== raw.apiKey) { res.status(401).json({ success: false }); return; }

    const { remoteUserId, action, role } = req.body as {
      obligateUserId: number; obligateUsername: string; remoteUserId: number;
      action: 'deactivate' | 'reactivate' | 'delete' | 'update-role'; role?: string;
    };

    if (!remoteUserId || !action) { res.status(400).json({ success: false, error: 'Missing fields' }); return; }

    const user = await db('users').where({ id: remoteUserId }).first();
    if (!user) { res.json({ success: true }); return; } // Already gone

    switch (action) {
      case 'deactivate':
        await db('users').where({ id: remoteUserId }).update({ is_active: false, updated_at: new Date() });
        logger.info(`SSO sync: deactivated user #${remoteUserId}`);
        break;
      case 'reactivate':
        await db('users').where({ id: remoteUserId }).update({ is_active: true, updated_at: new Date() });
        logger.info(`SSO sync: reactivated user #${remoteUserId}`);
        break;
      case 'delete':
        await db('sso_foreign_users').where({ local_user_id: remoteUserId }).del();
        await db('users').where({ id: remoteUserId }).del();
        logger.info(`SSO sync: deleted user #${remoteUserId}`);
        break;
      case 'update-role':
        if (role) {
          await db('users').where({ id: remoteUserId }).update({ role: role === 'admin' ? 'admin' : 'user', updated_at: new Date() });
          logger.info(`SSO sync: updated role of user #${remoteUserId} to ${role}`);
        }
        break;
    }

    res.json({ success: true });
  } catch (err) {
    logger.error(err, 'sso-user-sync error');
    res.status(500).json({ success: false, error: 'Sync failed' });
  }
});

export default router;
