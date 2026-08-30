Les paramètres de supervision (intervalle de check, retries, timeout, cooldown des notifications, rétention des heartbeats) suivent un modèle d'héritage à trois niveaux — global, groupe, moniteur — avec une résolution en chaîne calculée à la volée plutôt que dénormalisée.

## Modèle de données

Migration `server/src/db/migrations/006_create_settings.ts` :

```sql
CREATE TABLE settings (
  id SERIAL PRIMARY KEY,
  scope VARCHAR(20) NOT NULL,       -- 'global' | 'group' | 'monitor'
  scope_id INTEGER,                 -- NULL pour global, sinon group_id / monitor_id
  key VARCHAR(100) NOT NULL,
  value JSONB NOT NULL,
  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
  UNIQUE (scope, scope_id, key)
);
CREATE INDEX ON settings (scope, scope_id);
```

La table ne stocke **que les overrides explicites** — une ligne dans `settings` signifie « à ce niveau, cette clé est surchargée avec cette valeur ». L'absence de ligne signifie « hérite du niveau parent ». C'est ce qui permet à une suppression (`DELETE`) d'agir comme un reset vers la valeur héritée, sans avoir besoin d'un état « reset » explicite.

Les clés valides et leurs bornes sont définies côté `shared` (partagé serveur/client) dans `shared/src/settingsDefaults.ts` :

```ts
export const SETTINGS_KEYS = {
  CHECK_INTERVAL: 'check_interval',
  RETRY_INTERVAL: 'retry_interval',
  MAX_RETRIES: 'max_retries',
  TIMEOUT: 'timeout',
  NOTIFICATION_COOLDOWN: 'notification_cooldown',
  HEARTBEAT_RETENTION_DAYS: 'heartbeat_retention_days',
} as const;
```

Chaque clé a une définition (`SETTINGS_DEFINITIONS`) avec `min`/`max`/`default`, et `HARDCODED_DEFAULTS` fournit le socle de plus bas niveau (utilisé quand ni global, ni groupe, ni moniteur ne surchargent la valeur).

## Service — `settingsService` (`server/src/services/settings.service.ts`)

### CRUD brut

- `getByScope(scope, scopeId)` : `SELECT key, value FROM settings WHERE scope = ? AND scope_id = ?`, retourne un `Record<string, number>`.
- `set(scope, scopeId, key, value)` : valide la clé contre `SETTINGS_DEFINITIONS`, vérifie les bornes `min`/`max`, applique une politique admin additionnelle via variables d'environnement (`MIN_CHECK_INTERVAL`, `MIN_RETRY_INTERVAL` — un plancher serveur qui ne peut pas être contourné même par un override), puis fait un upsert :

```ts
await db('settings')
  .insert({ scope, scope_id: scopeId, key, value: JSON.stringify(value), updated_at: new Date() })
  .onConflict(['scope', 'scope_id', 'key'])
  .merge({ value: JSON.stringify(value), updated_at: new Date() });
```

- `remove(scope, scopeId, key)` : `DELETE` — c'est le mécanisme de **reset vers hérité**.
- `setBulk(scope, scopeId, overrides[])` : boucle sur `set()` (utilisé par l'édition en masse depuis l'UI).

### Résolution de la chaîne d'héritage

`resolveForMonitor(monitorId, groupId)` calcule, pour chaque clé de `SETTINGS_KEYS`, la valeur effective et sa provenance (`ResolvedSettings`, type partagé) :

1. **Défauts codés en dur** (`HARDCODED_DEFAULTS`) → `source: 'default'`.
2. **Overrides globaux** (`scope='global', scope_id=null`) → `source: 'global'`.
3. **Chaîne de groupes, racine → feuille** : récupération des ancêtres via `group_closure` triés par `depth DESC` (le plus lointain ancêtre en premier), puis application successive des overrides de chaque groupe — le groupe le plus proche du moniteur (`depth` le plus faible) écrase donc en dernier :

```ts
const ancestorRows = await db('group_closure')
  .join('monitor_groups', 'monitor_groups.id', 'group_closure.ancestor_id')
  .where('group_closure.descendant_id', groupId)
  .orderBy('group_closure.depth', 'desc')
  .select('monitor_groups.id', 'monitor_groups.name', 'group_closure.depth');
```

4. **Overrides du moniteur** (`scope='monitor', scope_id=monitorId`) → `source: 'monitor'`, écrase tout le reste.

Chaque entrée du résultat porte `{ value, source, sourceId, sourceName }`, ce qui permet à l'UI d'afficher « Hérité de <nom du groupe> » ou « Valeur par défaut » sans requête supplémentaire.

`resolveForGroup(groupId)` fait la même chose mais s'arrête **avant** le niveau du groupe cible (n'inclut que les ancêtres, `depth > 0`) et retourne séparément les `overrides` propres au groupe — utile pour l'UI d'édition d'un groupe qui doit distinguer « ce que ce groupe hérite » de « ce que ce groupe surcharge lui-même ».

`resolveGlobal()` est la forme la plus simple : uniquement défauts + overrides globaux.

## API et endpoints

Routes dans `server/src/routes/settings.routes.ts`, toutes sous `requireAuth`, lecture et écriture réservées à `requireRole('admin')` :

| Méthode | Route | Contrôleur |
|---|---|---|
| GET | `/settings/global/resolved` | `settingsController.getGlobalResolved` |
| GET | `/settings/group/:scopeId/resolved` | `settingsController.getGroupResolved` |
| GET | `/settings/monitor/:scopeId/resolved` | `settingsController.getMonitorResolved` |
| PUT | `/settings/:scope/:scopeId` | `settingsController.set` |
| PUT | `/settings/:scope/:scopeId/bulk` | `settingsController.setBulk` |
| DELETE | `/settings/:scope/:scopeId/:key` | `settingsController.remove` |

Pour le scope `global`, `scopeId` est transmis comme la chaîne littérale `"null"` côté client puis mappé à `null` côté service.

## Intégration worker

Les workers de monitoring (`BaseMonitorWorker` et dérivés, ainsi que `AgentMonitorWorker`) appellent `settingsService.resolveForMonitor()` (ou l'équivalent pour les agents via `agent_group_config`) au moment de planifier un check, afin d'utiliser le `check_interval`, `retry_interval`, `max_retries` et `timeout` effectifs plutôt que des constantes codées en dur. Le `notification_cooldown` résolu alimente le mécanisme de debounce de `handleStatusChange()` décrit dans `CLAUDE.md` (Phase 21+, priorité device > groupe > moniteur).

## Client — SettingsPanel

`client/src/components/settings/SettingsPanel.tsx` est un composant générique paramétré par `{ scope, scopeId, title }`, réutilisé pour les trois niveaux (page globale, `GroupManagePage`, page de détail d'un moniteur) :

```tsx
<SettingsPanel scope="group" scopeId={selectedGroupId} title="Paramètres du groupe" />
```

- Au montage (`useEffect` sur `[scope, scopeId]`), appelle `settingsApi.getGlobalResolved()` / `getGroupResolved()` / `getMonitorResolved()` selon le scope, peuple `resolved` (valeurs effectives + provenance) et `overrides` (valeurs propres à ce scope).
- `handleSave(key, value)` → `settingsApi.set(scope, scopeIdStr, key, value)`, recharge ensuite l'état résolu.
- `handleReset(key)` → `settingsApi.remove(scope, scopeIdStr, key)` : supprime l'override, l'UI retombe alors sur la valeur héritée affichée par `resolved[key]`.
- Chaque champ est délégué à `SettingField` (`client/src/components/settings/SettingField.tsx`), qui affiche la valeur héritée en gris avec sa source quand il n'y a pas d'override local, ou un champ éditable avec bouton « reset » quand un override existe.

## Références

- `server/src/db/migrations/006_create_settings.ts`
- `server/src/services/settings.service.ts`
- `server/src/controllers/settings.controller.ts`
- `server/src/routes/settings.routes.ts`
- `shared/src/settingsDefaults.ts`
- `client/src/components/settings/SettingsPanel.tsx`
- `client/src/components/settings/SettingField.tsx`
- `client/src/pages/GroupManagePage.tsx`
- `server/src/workers/AgentMonitorWorker.ts` (consommation de settings résolus pour agents)
