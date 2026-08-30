La multi-tenance a été introduite en Phase 13 : chaque table métier porte une colonne `tenant_id`, la session HTTP garde le tenant courant, et un middleware `requireTenant` scope automatiquement les routes. Cette page détaille le schéma, le middleware, et le fonctionnement du switch de tenant côté client.

## Schéma de données

Migration fondatrice : `server/src/db/migrations/039_tenants.ts`.

```sql
CREATE TABLE tenants (
  id SERIAL PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  slug VARCHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_tenants (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role VARCHAR(16) NOT NULL DEFAULT 'member', -- 'admin' | 'member'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id)
);
```

Un tenant `Default` (`id=1`, `slug='default'`) est seedé — c'est le **tenant maître** (`MASTER_TENANT_ID = 1`, `shared/src/tenants.ts`). Tous les utilisateurs existants y sont migrés (`role='admin'` → rôle tenant `'admin'`, sinon `'member'`).

La colonne `tenant_id` (`NOT NULL DEFAULT 1`, FK `ON DELETE CASCADE`) est ajoutée à :

```
monitors, monitor_groups, settings, notification_channels,
user_teams, agent_api_keys, agent_devices,
remediation_actions, maintenance_windows
```

`smtp_servers` reçoit `tenant_id` **nullable** (`ON DELETE SET NULL`) : `NULL` signifie un SMTP au niveau plateforme (2FA/reset de mot de passe uniquement), une valeur non nulle un SMTP scopé à un tenant (canaux de notification). Des migrations ultérieures étendent le périmètre : `041_notification_channel_tenants.ts` (association many-to-many canaux/tenants), `042_agent_notification_types.ts`, `043_groups_slug_unique_per_tenant.ts` (unicité du slug de groupe par tenant plutôt que globale).

## Résolution du tenant courant

Le tenant actif est stocké dans la session (`req.session.currentTenantId`), initialisé lors du login (`setSessionTenant()` dans `server/src/controllers/auth.controller.ts`) via `tenantService.getFirstTenantForUser(userId)`, avec repli sur le tenant `1`.

### Middleware `requireTenant`

Fichier : `server/src/middleware/tenant.ts`.

```ts
export function requireTenant(req: Request, _res: Response, next: NextFunction): void {
  const tid = req.session?.currentTenantId;
  if (!tid) {
    next(new AppError(400, 'No tenant selected'));
    return;
  }
  req.tenantId = tid;
  next();
}
```

Il doit être appliqué **après** `requireAuth`. Dans `server/src/routes/index.ts`, les routes sont scindées :

```ts
// Global (pas de tenant requis)
router.use('/auth', authRoutes);
router.use('/tenants', tenantRoutes); // CRUD tenants + switch — requireAuth mais PAS requireTenant
router.use('/tenant', tenantRoutes);

// Scopées tenant : requireAuth + requireTenant
const tenantRouter = Router();
tenantRouter.use(requireAuth);
tenantRouter.use(requireTenant);
tenantRouter.use('/monitors', monitorsRoutes);
tenantRouter.use('/groups', groupsRoutes);
tenantRouter.use('/settings', settingsRoutes);
tenantRouter.use('/notifications', notificationsRoutes);
tenantRouter.use('/users', usersRoutes);
tenantRouter.use('/profile', profileRoutes);
tenantRouter.use('/teams', teamsRoutes);
tenantRouter.use('/admin', importExportRoutes);
tenantRouter.use('/remediation', remediationRoutes);
tenantRouter.use('/admin/smtp-servers', smtpServerRoutes);
tenantRouter.use('/maintenance', maintenanceRoutes);
```

`/api/live-alerts` (`liveAlert.routes.ts`) est un cas mixte : la route `/all` fait un fan-out cross-tenant, le reste est scopé — la logique est gérée à l'intérieur même du routeur plutôt que via le middleware global.

### « God View » — fan-out cross-tenant pour les admins plateforme

Fichier : `server/src/utils/tenantScope.ts`. Un admin plateforme (`users.role === 'admin'`) connecté au tenant maître (`isMasterTenant(req.tenantId)`) bascule en vue cross-tenant :

```ts
export function getEffectiveTenantScope(req: Request): number | null {
  if (req.session?.role === 'admin' && isMasterTenant(req.tenantId)) {
    return null; // pas de WHERE tenant_id = ? — fan-out sur tous les tenants
  }
  return req.tenantId;
}

export function isGodView(req: Request): boolean {
  return req.session?.role === 'admin' && isMasterTenant(req.tenantId);
}
```

Les méthodes de listing des services (agents, monitors, teams, channels…) acceptent un paramètre `tenantId: number | null` et sautent la clause `WHERE tenant_id = ?` quand il vaut `null`. Un admin connecté à un tenant *non maître* reste scopé à ce tenant — le God View n'est actif que sur le tenant `1`.

## API tenant (`server/src/routes/tenant.routes.ts`)

| Méthode | Route | Accès | Description |
|---|---|---|---|
| POST | `/api/tenant/switch` | authentifié | `{ tenantId }` — change `req.session.currentTenantId` (vérifie `tenantService.userHasAccess` sauf pour les admins plateforme) |
| GET | `/api/tenants` | authentifié | Liste tous les tenants (admin) ou ceux de l'utilisateur avec son rôle (`getTenantsForUser`) |
| POST | `/api/tenants` | admin plateforme | Création `{ name, slug }` |
| GET | `/api/tenants/:id` | authentifié (scope vérifié) | Détail d'un tenant |
| PUT | `/api/tenants/:id` | admin plateforme | Mise à jour `name`/`slug` |
| DELETE | `/api/tenants/:id` | admin plateforme | Suppression — **interdite pour `id === 1`** (tenant par défaut) |
| GET/POST/PUT/DELETE | `/api/tenants/:id/members[/:uid]` | admin plateforme | Gestion des membres et de leur rôle tenant (`admin`/`member`) |

`tenantService` (`server/src/services/tenant.service.ts`) encapsule ces opérations : `getAll`, `getById`, `getBySlug`, `create`, `update`, `delete`, `getFirstTenantForUser`, `getTenantsForUser`, `userHasAccess`, `getMembers`, `addUser` (upsert `onConflict(['user_id','tenant_id']).merge({role})`), `removeUser`, `updateUserRole`.

## Client — `tenantStore` et `TenantSwitcher`

`client/src/store/tenantStore.ts` (Zustand) :

```ts
interface TenantState {
  currentTenantId: number | null;
  tenants: TenantWithRole[];
  fetchTenants: () => Promise<void>;
  setCurrentTenant: (tenantId: number) => Promise<void>;
}
```

`setCurrentTenant` appelle `POST /api/tenant/switch` puis exécute **`window.location.reload()`** — un rechargement complet de la page plutôt qu'un re-fetch sélectif, jugé plus fiable pour rafraîchir l'intégralité des données scopées au tenant (sidebar, monitors, agents, notifications, settings, stats du dashboard, etc.).

`client/src/components/layout/TenantSwitcher.tsx` (le sélecteur affiché dans la topbar) :

- Masqué si `tenants.length <= 1` (pas de multi-tenance visible pour un utilisateur mono-tenant).
- Masqué également dans le shell natif ObliTools quand il y a plusieurs tenants (`window.__obliview_is_native_app === true`) — c'est alors la tab-bar injectée par ObliTools qui gère la présentation multi-tenant, pas le composant React.
- Au clic sur un tenant, `handleSwitch()` appelle `setCurrentTenant()`, puis en parallèle recharge `useMonitorStore.fetchMonitors()` et `useGroupStore.fetchTree()`, et reconnecte le socket Socket.io avec le nouveau `tenantId` (`disconnectSocket()` / `connectSocket(user.id, tenantId)`) — utile en pratique surtout avant que le `reload()` de `setCurrentTenant` ne prenne effet.
- Chaque ligne de tenant affiche un badge `tenant.roleAdmin` quand le rôle tenant de l'utilisateur est `admin`.

`client/src/pages/AdminTenantsPage.tsx` fournit l'interface d'administration complète : création/édition/suppression de tenants, gestion des membres et de leurs rôles, réservée aux admins plateforme (contrôle également fait côté serveur dans `tenant.routes.ts`).

## Références

- `server/src/db/migrations/039_tenants.ts`
- `server/src/db/migrations/041_notification_channel_tenants.ts`
- `server/src/db/migrations/042_agent_notification_types.ts`
- `server/src/db/migrations/043_groups_slug_unique_per_tenant.ts`
- `server/src/middleware/tenant.ts`
- `server/src/utils/tenantScope.ts`
- `server/src/routes/tenant.routes.ts`
- `server/src/routes/index.ts`
- `server/src/services/tenant.service.ts`
- `shared/src/tenants.ts`
- `client/src/store/tenantStore.ts`
- `client/src/components/layout/TenantSwitcher.tsx`
- `client/src/pages/AdminTenantsPage.tsx`
