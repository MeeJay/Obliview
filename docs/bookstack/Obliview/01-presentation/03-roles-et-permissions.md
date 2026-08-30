Obliview superpose trois couches de contrôle d'accès : un rôle plateforme binaire porté par l'utilisateur, un rôle tenant piloté par des « permission sets » à capacités déclaratives, et un système de teams à granularité fine (groupe/monitor, lecture/écriture). Cette page décrit les trois couches et les middlewares qui les font respecter.

## Rôle plateforme (`users.role`)

Deux valeurs seulement, définies dans `shared/src/monitorTypes.ts` :

```ts
export const USER_ROLES = ['admin', 'user'] as const;
export type UserRole = (typeof USER_ROLES)[number];
```

`admin` est l'**administrateur plateforme** (« platform admin ») : il passe outre toutes les vérifications de permission fines (`if (isAdmin) return true;` répété dans tout `permission.service.ts`) et peut accéder aux endpoints agrégeant plusieurs tenants. Ce rôle est distinct du rôle tenant « admin » — voir plus bas.

Le middleware `requirePlatformAdmin()` (`server/src/middleware/rbac.ts`) vérifie strictement `req.session.role === 'admin'`, indépendamment du tenant actif :

```ts
export function requirePlatformAdmin() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.session.role !== 'admin') {
      next(new AppError(403, 'Platform admin required'));
      return;
    }
    next();
  };
}
```

## Rôle tenant (`user_tenants.role`) & permission sets

Chaque utilisateur a un rôle par tenant, stocké dans `user_tenants.role` (varchar, migré de `admin|member` fixe vers une chaîne libre en `053_user_tenants_role_varchar.ts` pour pointer vers un `permission_sets.slug`). Un **permission set** (`permission_sets`, migration `049_permission_sets.ts`) associe un slug à une liste de capacités JSONB :

```json
{
  "name": "Admin",
  "slug": "admin",
  "capabilities": ["monitoring", "monitors.manage", "groups.manage", "agents.manage", "remediation", "settings", "users.manage"],
  "is_default": true
}
```

Trois sets sont seedés par défaut : `admin` (toutes capacités), `user` (`monitoring`, `monitors.manage`, `groups.manage`), `viewer` (`monitoring` seule). D'autres sets personnalisés peuvent être créés via l'API :

| Méthode | Route | Rôle requis |
|---|---|---|
| GET | `/api/permission-sets` | authentifié |
| GET | `/api/permission-sets/capabilities` | authentifié |
| POST | `/api/permission-sets` | `requireRole('admin')` |
| PUT | `/api/permission-sets/:id` | `requireRole('admin')` |
| DELETE | `/api/permission-sets/:id` | `requireRole('admin')` |

La vérification d'une capacité tenant se fait via `permissionService.userHasTenantCapability(userId, tenantId, capability)` :

```ts
async userHasTenantCapability(userId: number, tenantId: number, capability: string): Promise<boolean> {
  const ut = await db('user_tenants').where({ user_id: userId, tenant_id: tenantId }).first();
  if (!ut) return false;
  if (ut.role === 'admin') return true;               // court-circuit rôle tenant admin
  const set = await db('permission_sets').where({ slug: ut.role }).first();
  if (!set) return false;
  const caps = typeof set.capabilities === 'string' ? JSON.parse(set.capabilities) : set.capabilities;
  return caps.includes(capability);
}
```

Le middleware associé, `requireTenantCapability(capability)`, s'applique **après** `requireAuth` et `requireTenant`, et court-circuite si l'utilisateur est admin plateforme.

## Teams : permissions fines par portée

Indépendamment du rôle tenant, les **teams** (`user_teams`, migration `013_create_teams.ts`) permettent d'accorder des permissions granulaires à un groupe d'utilisateurs sur des portées précises (groupe ou monitor), en lecture seule (`ro`) ou lecture-écriture (`rw`) :

- `user_teams` : `name`, `description`, `can_create` (autorise la création de nouveaux monitors/groupes), `is_global`, `tenant_id`.
- `team_memberships` : jonction `user_id` / `team_id`.
- `team_permissions` : `team_id`, `scope` (`group`|`monitor`), `scope_id`, `level` (`ro`|`rw`), et une colonne `capabilities` JSONB (ajoutée en `048_team_capabilities.ts`) pour des permissions applicatives fines (ex. actions spécifiques sur un agent).

`permissionService` calcule la permission effective en combinant permission directe sur le monitor/groupe et permission héritée via `group_closure` (la plus haute l'emporte : `rw` > `ro` > aucune) :

```ts
async getMonitorPermission(userId: number, monitorId: number, isAdmin: boolean): Promise<PermissionLevel | null> {
  if (isAdmin) return 'rw';
  // groupe général → RO minimum garanti à tous
  // sinon : max(permission directe sur le monitor, permission héritée du groupe)
}
```

Les groupes marqués `is_general = true` sont visibles en lecture par tout utilisateur, même sans team, avec un passage en `rw` si une team accorde ce niveau explicitement.

Middlewares dérivés dans `server/src/middleware/rbac.ts`, appliqués aux routes CRUD (`monitors.routes.ts`, `groups.routes.ts`, etc.) :

| Middleware | Vérifie |
|---|---|
| `requireMonitorWrite()` | `canWriteMonitor` (admin ou team `rw` sur le monitor/son groupe) |
| `requireGroupWrite()` | `canWriteGroup` |
| `requireCanCreate()` | `can_create` sur au moins une team de l'utilisateur |
| `requireRole(...roles)` | rôle plateforme brut (ex. `requireRole('admin')`) |
| `requireMasterTenant()` | tenant actif = tenant maître (`isMasterTenant`) |

## Global teams (teams cross-tenant)

Une team créée dans le tenant maître (`default`) peut être marquée `is_global = true` (migration `047_global_teams.ts`) et « poussée » vers d'autres tenants via la table de jonction `team_tenant_scopes` (`team_id`, `tenant_id`). Cela permet à une équipe d'administration centrale d'obtenir des permissions sur des groupes/monitors situés dans des tenants clients distincts, sans dupliquer la team.

`teamService.getAll(tenantId)` fusionne les teams locales du tenant courant et les teams globales ciblant ce tenant (en excluant les doublons déjà locaux) :

```ts
const globalTeams = await db('user_teams')
  .join('team_tenant_scopes', 'user_teams.id', 'team_tenant_scopes.team_id')
  .where('user_teams.is_global', true)
  .where('team_tenant_scopes.tenant_id', tenantId)
  .whereNot('user_teams.tenant_id', tenantId);
```

Dans l'UI (`AdminUsersPage`), ces teams globales sont signalées par un badge « Global » (couleur `#D3AB52`). La gestion des tenants cibles se fait via :

| Méthode | Route |
|---|---|
| GET | `/api/teams/:id/target-tenants` |
| PUT | `/api/teams/:id/target-tenants` |
| GET | `/api/teams/:id/cross-tenant-permissions` |
| PUT | `/api/teams/:id/cross-tenant-permissions` |

## Admin plateforme vs admin tenant

Il est essentiel de distinguer :

- **Admin plateforme** (`users.role = 'admin'`) : au-dessus de toute la matrice de capacités, accès à tous les tenants, aux endpoints `/api/system`, `/api/admin/config`, gestion des tenants eux-mêmes.
- **Admin tenant** (`user_tenants.role = 'admin'`) : court-circuite uniquement les capacités du permission set à l'intérieur de **son** tenant ; n'a aucun droit implicite sur les autres tenants.

Un utilisateur peut donc être admin d'un tenant client sans être admin plateforme, et un admin plateforme peut ne pas apparaître explicitement comme « admin » dans `user_tenants` d'un tenant donné (il passe quand même, via le court-circuit `req.session.role === 'admin'` dans chaque middleware).

## Références

- `shared/src/monitorTypes.ts` — `USER_ROLES`
- `server/src/middleware/rbac.ts` — `requireRole`, `requireMonitorWrite`, `requireGroupWrite`, `requireCanCreate`, `requireTenantCapability`, `requirePlatformAdmin`, `requireMasterTenant`
- `server/src/services/permission.service.ts` — `getMonitorPermission`, `getGroupPermission`, `userHasTenantCapability`, `canUseCapability`
- `server/src/services/team.service.ts` — `getAll`, gestion des teams globales
- `server/src/db/migrations/013_create_teams.ts` — `user_teams`, `team_memberships`, `team_permissions`
- `server/src/db/migrations/047_global_teams.ts` — `is_global`, `team_tenant_scopes`
- `server/src/db/migrations/048_team_capabilities.ts` — `team_permissions.capabilities`
- `server/src/db/migrations/049_permission_sets.ts` — `permission_sets`
- `server/src/db/migrations/053_user_tenants_role_varchar.ts` — passage de `role` en varchar libre
- `server/src/routes/teams.routes.ts`, `server/src/routes/permissionSets.routes.ts`
- `client/src/pages/AdminUsersPage.tsx` — badge « Global », affichage des rôles