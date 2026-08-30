Le contrôle d'accès d'Obliview combine trois mécanismes distincts appliqués à des granularités différentes : le rôle plateforme (`users.role`), les permissions d'équipe scope group/monitor (`team_permissions`), et depuis la Phase 21, les **équipes globales** capables d'agir au-delà de leur tenant d'origine. Le middleware central est `server/src/middleware/rbac.ts`.

## Les fonctions du middleware

| Fonction | Usage |
|---|---|
| `requireRole(...roles)` | Vérifie `req.session.role` contre une liste de rôles plateforme autorisés (401 si non authentifié, 403 sinon) |
| `requireMonitorWrite()` | Admin passe toujours ; sinon délègue à `permissionService.canWriteMonitor` |
| `requireGroupWrite()` | Idem pour un groupe |
| `requireCanCreate()` | Vérifie le flag `can_create` porté par une des équipes de l'utilisateur |
| `requireTenantCapability(capability)` | Résout la capacité tenant-wide via `permission_sets` (voir plus bas) |
| `requirePlatformAdmin()` | Porte d'entrée admin globale, distincte du rôle tenant `admin` |
| `requireMasterTenant()` | Restreint à `isMasterTenant(req.tenantId)` — utilisé pour les endpoints fan-out cross-tenant (God View) |

```ts
export function requireTenantCapability(capability: string) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    if (req.session.role === 'admin') return next(); // platform admin bypass
    const ok = await permissionService.userHasTenantCapability(
      req.session.userId!, req.tenantId, capability,
    );
    if (!ok) return next(new AppError(403, `Missing capability: ${capability}`));
    next();
  };
}
```

## Permission sets (capacités tenant-wide)

La migration `049_permission_sets.ts` introduit la table `permission_sets` : `name`, `slug` (unique, référencé par `user_tenants.role`), `capabilities` (JSONB, tableau de chaînes), `is_default`. Trois sets sont seedés : `admin` (toutes capacités : `monitoring`, `monitors.manage`, `groups.manage`, `agents.manage`, `remediation`, `settings`, `users.manage`), `user` (`monitoring`, `monitors.manage`, `groups.manage`) et `viewer` (`monitoring` seul).

La résolution se fait dans `permissionService.userHasTenantCapability` (`server/src/services/permission.service.ts`) : le rôle tenant `admin` court-circuite la vérification ; sinon on charge le `permission_sets` correspondant au slug `user_tenants.role` et on teste l'appartenance de la capacité au tableau JSONB.

## Permissions fines par équipe (group/monitor)

La table `team_permissions` (scope `group` | `monitor`, `scope_id`, `level` `ro`/`rw`) porte les permissions granulaires. `permissionService` calcule la permission effective en tenant compte de l'héritage via la table de fermeture transitive `group_closure` :

```ts
async _getGroupPermissionViaClosure(userId: number, groupId: number): Promise<PermissionLevel | null> {
  const rows = await db('team_permissions')
    .join('team_memberships', 'team_permissions.team_id', 'team_memberships.team_id')
    .join('group_closure', 'group_closure.ancestor_id', 'team_permissions.scope_id')
    .where('team_memberships.user_id', userId)
    .where('team_permissions.scope', 'group')
    .where('group_closure.descendant_id', groupId)
    .select('team_permissions.level');
  if (rows.length === 0) return null;
  return rows.some((r) => r.level === 'rw') ? 'rw' : 'ro';
}
```

Les groupes marqués `is_general` sont toujours lisibles par tout utilisateur authentifié (minimum RO), y compris sans permission explicite.

## Global Teams

Migration `047_global_teams.ts` : ajout de `user_teams.is_global` (boolean, défaut `false`) et création de la table de jonction `team_tenant_scopes` (`team_id`, `tenant_id`, clé primaire composite), qui liste les tenants cibles auxquels une équipe globale est poussée.

```ts
await knex.schema.alterTable('user_teams', (t) => {
  t.boolean('is_global').defaultTo(false).notNullable();
});
await knex.schema.createTable('team_tenant_scopes', (t) => {
  t.integer('team_id').notNullable().references('id').inTable('user_teams').onDelete('CASCADE');
  t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
  t.primary(['team_id', 'tenant_id']);
});
```

Une équipe globale n'est en réalité rattachée qu'à un seul tenant « propriétaire » (`user_teams.tenant_id`, généralement le tenant par défaut), mais ses permissions (`team_permissions`) peuvent référencer des groupes/moniteurs appartenant à n'importe lequel de ses tenants cibles. `teamService.getAll(tenantId)` reflète cette logique : pour un tenant non-défaut, la liste retournée fusionne les équipes locales et les équipes globales dont `team_tenant_scopes` contient ce tenant :

```ts
const globalTeams = await db('user_teams')
  .join('tenants', 'user_teams.tenant_id', 'tenants.id')
  .join('team_tenant_scopes', 'user_teams.id', 'team_tenant_scopes.team_id')
  .where('user_teams.is_global', true)
  .where('team_tenant_scopes.tenant_id', tenantId)
  .whereNot('user_teams.tenant_id', tenantId)
  .select('user_teams.*', 'tenants.name as tenant_name')
  .orderBy('user_teams.name');
```

`teamService.getCrossTenantPermissions(teamId)` résout, pour une équipe globale, l'ensemble de ses `team_permissions` regroupées par `tenant_id` réel du groupe/moniteur ciblé (résolution via `monitor_groups.tenant_id` / `monitors.tenant_id`), ce qui alimente le panneau « permissions cross-tenant » de l'UI.

## Endpoints dédiés

| Méthode | Route | Description |
|---|---|---|
| GET / PUT | `/api/teams/:id/target-tenants` | Liste / remplace les tenants cibles d'une équipe globale |
| GET / PUT | `/api/teams/:id/cross-tenant-permissions` | Lecture / écriture des permissions groupées par tenant |

## UI — badge et panneau

Dans `client/src/pages/AdminUsersPage.tsx`, le badge visuel des équipes globales utilise la couleur `#D3AB52` :

```tsx
<span className="inline-flex items-center gap-1 rounded-full bg-[#D3AB52]/15 border border-[#D3AB52]/40 px-1.5 py-0.5 text-[10px] font-medium text-[#D3AB52]">
  Global
</span>
```

Le panneau « Tenants cibles » (onglet `rightTab === 'tenants'`) n'est affiché que si `selectedTeam.isGlobal && isDefaultTenant` — seul le tenant maître peut administrer la portée d'une équipe globale, cohérent avec le principe « God View » du reste de la plateforme (`requireMasterTenant`).

## Références

- `server/src/middleware/rbac.ts`
- `server/src/services/permission.service.ts`
- `server/src/services/team.service.ts`
- `server/src/db/migrations/047_global_teams.ts`
- `server/src/db/migrations/049_permission_sets.ts`
- `client/src/pages/AdminUsersPage.tsx`
