La gestion des utilisateurs et des équipes repose sur deux entités distinctes : `users` (comptes individuels, authentification) et `user_teams` (groupements logiques porteurs de permissions). Toute la gestion est centralisée côté client dans `client/src/pages/AdminUsersPage.tsx`, qui combine CRUD utilisateurs, assignation de groupes/tenants et administration des équipes dans une seule page à onglets.

## Modèle de données

La table `users` stocke `username`, `password_hash`, `display_name`, `role` (`admin` | `user`), `is_active`, `foreign_source` (rempli à `'obligate'` pour les comptes SSO fédérés — voir la doc Phase 20). Le rôle `admin` ici est le rôle **plateforme**, distinct du rôle tenant porté par `user_tenants.role` (voir la page RBAC).

Les équipes (`user_teams`) portent : `name`, `description`, `can_create` (autorise la création de moniteurs/groupes), `tenant_id`, et depuis la Phase Global Teams, `is_global`. L'appartenance utilisateur ↔ équipe passe par `team_memberships` (simple table de jonction `team_id` / `user_id`).

## Service utilisateurs

`server/src/services/user.service.ts` expose les opérations CRUD de base ainsi que la gestion des assignations multi-tenant :

```ts
async setUserTenantAssignments(
  userId: number,
  assignments: { tenantId: number; role: 'admin' | 'member' }[],
): Promise<void> {
  await db.transaction(async (trx) => {
    await trx('user_tenants').where({ user_id: userId }).del();
    if (assignments.length > 0) {
      await trx('user_tenants').insert(assignments.map((a) => ({
        user_id: userId, tenant_id: a.tenantId, role: a.role, created_at: new Date(),
      })));
    }
  });
}
```

Cette méthode remplace intégralement (delete + insert transactionnel) les appartenances tenant d'un utilisateur — pas de diff incrémental.

## Endpoints

Tous les endpoints `users` exigent `requireAuth` puis `requireRole('admin')` (`server/src/routes/users.routes.ts`) :

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/users` | Liste tous les utilisateurs |
| GET | `/api/users/:id` | Détail d'un utilisateur |
| POST | `/api/users` | Création (username, password, displayName, role) |
| PUT | `/api/users/:id` | Mise à jour (displayName, role, isActive) |
| PUT | `/api/users/:id/password` | Changement de mot de passe |
| DELETE | `/api/users/:id` | Suppression |
| GET | `/api/users/:id/teams` | Équipes dont l'utilisateur est membre |
| GET / PUT | `/api/users/:id/tenants` | Lecture / remplacement des assignations tenant |

Les routes équipes (`server/src/routes/teams.routes.ts`), également admin-only :

| Méthode | Route | Description |
|---|---|---|
| GET / POST | `/api/teams` | Liste / création |
| PUT / DELETE | `/api/teams/:id` | Mise à jour / suppression |
| GET / PUT | `/api/teams/:id/members` | Membres de l'équipe |
| GET / PUT | `/api/teams/:id/permissions` | Permissions (scope group/monitor) |
| DELETE | `/api/teams/:id/permissions/:permId` | Retrait d'une permission ponctuelle |
| GET / PUT | `/api/teams/:id/target-tenants` | Tenants cibles pour une équipe globale |
| GET / PUT | `/api/teams/:id/cross-tenant-permissions` | Permissions cross-tenant d'une équipe globale |

## Protections admin

`server/src/controllers/users.controller.ts` implémente plusieurs garde-fous appliqués avant toute écriture :

- **Comptes SSO (`foreignSource === 'obligate'`)** : changement de `role`/`isActive` bloqué (`Cannot modify SSO user — manage from Obligate`), changement de `username` bloqué, changement de mot de passe bloqué, suppression bloquée. La gestion de ces comptes se fait exclusivement depuis Obligate.
- **Dernier administrateur** : impossible de rétrograder (`role: 'user'`) ou désactiver (`isActive: false`) le dernier compte `role: 'admin'` actif — la mise à jour recompte les admins actifs restants (hors la cible) et lève `Cannot remove the last active admin` si le compte est nul.
- **Auto-suppression** : un utilisateur ne peut pas supprimer son propre compte (`id === req.session.userId`).
- **Suppression du dernier admin** : même vérification que pour la rétrogradation, appliquée à `delete`.

```ts
// Prevent demoting the last admin
if (data.role === 'user' || data.isActive === false) {
  const currentUser = await userService.getById(id);
  if (currentUser?.role === 'admin') {
    const allUsers = await userService.getAll();
    const activeAdmins = allUsers.filter((u) => u.role === 'admin' && u.isActive && u.id !== id);
    if (activeAdmins.length === 0) {
      throw new AppError(400, 'Cannot remove the last active admin');
    }
  }
}
```

## AdminUsersPage

`client/src/pages/AdminUsersPage.tsx` gère dans une seule page :

- La liste des utilisateurs avec badge « SSO » (couleur `#D3AB52`) pour les comptes fédérés, et le préfixe `og_` du username strippé à l'affichage.
- Le panneau de détail par utilisateur : édition du profil, changement de mot de passe (désactivé pour les comptes SSO), assignation aux tenants via la matrice `role: admin | member`.
- Un onglet Équipes : création/édition (`formIsGlobal` pilote la case à cocher « équipe globale »), gestion des membres, et pour les équipes globales, un panneau « Tenants cibles » (visible uniquement si `team.isGlobal && isDefaultTenant`) qui appelle `PUT /api/teams/:id/target-tenants`.

## Références

- `server/src/services/user.service.ts`
- `server/src/services/team.service.ts`
- `server/src/controllers/users.controller.ts`
- `server/src/routes/users.routes.ts`
- `server/src/routes/teams.routes.ts`
- `client/src/pages/AdminUsersPage.tsx`
