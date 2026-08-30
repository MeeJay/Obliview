Les groupes de moniteurs permettent d'organiser l'arborescence de supervision (sites, environnements, services) et servent de support à l'héritage des paramètres et des notifications. La hiérarchie est stockée en base via une **table de fermeture transitive** (closure table), un modèle qui permet de répondre en une seule requête SQL aux questions « quels sont tous les ancêtres/descendants de ce groupe » sans requêtes récursives coûteuses (`WITH RECURSIVE`).

## Modèle de données

Migration `server/src/db/migrations/005_create_groups.ts` :

```sql
CREATE TABLE monitor_groups (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,
  parent_id INTEGER REFERENCES monitor_groups(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_general BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
);

CREATE TABLE group_closure (
  ancestor_id INTEGER REFERENCES monitor_groups(id) ON DELETE CASCADE,
  descendant_id INTEGER REFERENCES monitor_groups(id) ON DELETE CASCADE,
  depth INTEGER NOT NULL,
  PRIMARY KEY (ancestor_id, descendant_id)
);
```

`monitor_groups.parent_id` reste la source de vérité pour l'arbre "direct" (affichage), tandis que `group_closure` matérialise **tous les couples (ancêtre, descendant)** avec leur profondeur (`depth`), y compris l'auto-référence (`depth = 0`, un groupe est son propre ancêtre/descendant). Cela permet de retrouver instantanément la chaîne complète d'un nœud sans remonter récursivement `parent_id`.

Des colonnes complémentaires ont été ajoutées par des migrations ultérieures : `group_notifications` (`012_add_group_notifications.ts`, notifications consolidées au niveau groupe), `agent_group_config` (`021_agent_group_config.ts`, config de polling/push pour les devices agent) et `tenant_id` + unicité du slug par tenant (`043_groups_slug_unique_per_tenant.ts`). Le champ `kind` introduit en `017_group_kind.ts` a depuis été retiré (`054_drop_group_kind.ts`).

## Maintenance de la closure table

Toute la logique vit dans `server/src/services/group.service.ts` (export `groupService`).

**Création** (`groupService.create`) : insertion du groupe, puis :
1. Insertion de l'auto-référence `(id, id, depth=0)`.
2. Si un `parentId` est fourni, copie de tous les chemins ancêtres du parent vers le nouveau nœud, profondeur + 1 :

```sql
INSERT INTO group_closure (ancestor_id, descendant_id, depth)
SELECT gc.ancestor_id, ?, gc.depth + 1
FROM group_closure gc
WHERE gc.descendant_id = ?  -- parentId
```

**Déplacement** (`groupService.move`) — l'opération la plus délicate : déplacer un sous-arbre entier tout en préservant sa cohérence interne.
1. Garde-fou anti-cycle : vérifie via `group_closure` que le nouveau parent n'est pas un descendant du groupe déplacé (`Cannot move group into its own descendant`).
2. Récupère tous les IDs du sous-arbre (`descendant_id` où `ancestor_id = id`).
3. Supprime toutes les entrées de closure reliant l'extérieur du sous-arbre vers l'intérieur (`whereIn('descendant_id', descIds).whereNotIn('ancestor_id', descIds)`), ce qui « détache » le sous-arbre du reste de l'arbre sans toucher aux relations internes.
4. Reconnecte le sous-arbre à la nouvelle branche par un produit cartésien : pour chaque ancêtre du nouveau parent × chaque nœud du sous-arbre, insertion d'une entrée `depth = depth(ancêtre→nouveauParent) + depth(id→nœud) + 1`.
5. Met à jour `parent_id` en base.

**Suppression** (`groupService.delete`) : simple `DELETE` sur `monitor_groups` — les `ON DELETE CASCADE` sur `group_closure.ancestor_id`/`descendant_id` et `monitor_groups.parent_id` nettoient automatiquement les enfants et les liens de fermeture.

## Requêtes d'arbre

| Fonction | Requête | Usage |
|---|---|---|
| `getAncestors(groupId)` | jointure `monitor_groups` ⋈ `group_closure` sur `descendant_id = groupId`, `depth > 0`, tri `depth DESC` | fil d'ariane, résolution de settings/notifications (racine → feuille) |
| `getDescendantIds(groupId)` | `SELECT descendant_id FROM group_closure WHERE ancestor_id = groupId` | inclusion des sous-groupes dans les stats, les notifications consolidées |
| `getChildren(parentId)` | `monitor_groups` filtré par `parent_id` | affichage plat |
| `getTree(tenantId)` | charge tous les groupes puis reconstruit l'arbre en mémoire via une `Map<number, GroupTreeNode>` | endpoint `GET /groups/tree`, `GroupTree.tsx` |
| `findGroupNotificationAncestor(groupId)` | jointure ordonnée par `depth ASC`, filtrée sur `group_notifications = true` | trouve le plus proche ancêtre (ou soi-même) activant les notifications consolidées de groupe |

`getTree` ne repasse pas par `group_closure` : il construit l'arbre à partir de `parent_id` en mémoire (`Map`), car c'est la structure d'affichage attendue par le client (`GroupTreeNode { ...group, children, monitors }`).

## API et endpoints

Routes déclarées dans `server/src/routes/groups.routes.ts`, toutes protégées par `requireAuth` :

| Méthode | Route | Middleware | Contrôleur |
|---|---|---|---|
| GET | `/groups` | — (filtrage visibilité) | `groupsController.list` |
| GET | `/groups/tree` | — | `groupsController.tree` |
| GET | `/groups/stats` | — | `groupsController.stats` |
| GET | `/groups/:id` | — | `groupsController.getById` |
| GET | `/groups/:id/monitors` | — | `groupsController.getMonitors` |
| GET | `/groups/:id/heartbeats` | — | `groupsController.heartbeats` |
| POST | `/groups` | `requireCanCreate()` | `groupsController.create` |
| PUT | `/groups/:id` | `requireGroupWrite()` | `groupsController.update` |
| POST | `/groups/reorder` | `requireRole('admin')` | `groupsController.reorder` |
| POST | `/groups/:id/move` | `requireGroupWrite()` | `groupsController.move` |
| DELETE | `/groups/:id` | `requireGroupWrite()` | `groupsController.delete` |
| PATCH | `/groups/:id/agent-config` | `requireRole('admin')` | `groupsController.updateAgentGroupConfig` |

Les middlewares `requireGroupWrite` et `requireCanCreate` (`server/src/middleware/rbac.ts`) autorisent soit un rôle `admin`, soit une équipe (team) disposant d'un droit RW explicite sur le groupe (RBAC introduit en Phase 10).

## Client — GroupTree et GroupManagePage

- `client/src/components/groups/GroupTree.tsx` : composant d'affichage principal de la sidebar/dashboard. Consomme `useGroupStore().tree` (peuplé via `fetchTree()` qui appelle `GET /groups/tree`), gère le glisser-déposer (dnd-kit, `DragStartEvent`/`DragEndEvent`) pour déplacer un moniteur ou un device agent d'un groupe à un autre (appel `groupsApi`/`agentApi` au drop), le regroupement par tenant en mode « vue globale » (`isGodView`), et le filtrage par recherche (`hasMatchingMonitor`).
- `client/src/pages/GroupManagePage.tsx` : page d'administration des groupes (CRUD complet). Aplati l'arbre via `flattenTree()` pour l'affichage en liste indentée, empêche via `isDescendantOf()` de choisir un parent qui créerait un cycle (double garde-fou avec le service), gère le drag-and-drop de réordonnancement (`groupsApi.reorder`) et le déplacement inter-parent (`groupsApi.move`). Intègre directement `SettingsPanel` et `NotificationBindingsPanel` pour éditer, dans le même écran, les paramètres et notifications hérités du groupe sélectionné.

## Références

- `server/src/db/migrations/005_create_groups.ts`
- `server/src/db/migrations/012_add_group_notifications.ts`
- `server/src/db/migrations/021_agent_group_config.ts`
- `server/src/db/migrations/043_groups_slug_unique_per_tenant.ts`
- `server/src/services/group.service.ts`
- `server/src/controllers/groups.controller.ts`
- `server/src/routes/groups.routes.ts`
- `server/src/middleware/rbac.ts`
- `client/src/components/groups/GroupTree.tsx`
- `client/src/pages/GroupManagePage.tsx`
- `shared/src` — type `GroupTreeNode`, `MonitorGroup`, `AgentGroupConfig`
