Le routage des notifications suit le même principe d'héritage hiérarchique que les settings (global → groupe → moniteur/agent), mais avec une sémantique plus riche : chaque liaison (binding) déclare un `overrideMode` (`merge`, `replace` ou `exclude`) qui contrôle comment elle interagit avec l'ensemble hérité du niveau parent.

## Modèle de données

Migration `server/src/db/migrations/007_create_notifications.ts` :

```sql
CREATE TABLE notification_channels (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL,        -- plugin: 'webhook', 'discord', 'smtp', ...
  config JSONB NOT NULL DEFAULT '{}',
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
);

CREATE TABLE notification_bindings (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER REFERENCES notification_channels(id) ON DELETE CASCADE,
  scope VARCHAR(20) NOT NULL,        -- 'global' | 'group' | 'monitor' | 'agent'
  scope_id INTEGER,                  -- NULL pour global
  override_mode VARCHAR(10) NOT NULL DEFAULT 'merge',
  UNIQUE (channel_id, scope, scope_id)
);

CREATE TABLE notification_log (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER REFERENCES notification_channels(id) ON DELETE CASCADE,
  monitor_id INTEGER REFERENCES monitors(id) ON DELETE SET NULL,
  event_type VARCHAR(50) NOT NULL,   -- 'status_change', 'test', 'agent_status_change', 'group_status_change'
  success BOOLEAN NOT NULL,
  message TEXT, error TEXT,
  created_at TIMESTAMPTZ
);
```

Des migrations ultérieures ajoutent le partage cross-tenant des canaux : `notification_channel_tenants` (`041_notification_channel_tenants.ts`, table de jonction channel↔tenant pour les canaux partagés depuis un autre tenant) et les surcharges de type de notification par agent (`042_agent_notification_types.ts`).

## Service — `notificationService` (`server/src/services/notification.service.ts`)

### CRUD des canaux

`getAllChannels(tenantId)` retourne les canaux propres au tenant **plus** ceux partagés via `notification_channel_tenants` :

```ts
.where(function () {
  this.where('notification_channels.tenant_id', tenantId)
    .orWhereIn('notification_channels.id',
      db('notification_channel_tenants').select('channel_id').where({ tenant_id: tenantId }));
})
```

`createChannel` valide le `type` contre le registre de plugins (`getPlugin(type)`, `server/src/notifications/registry.ts`) avant insertion. `resolveChannelConfig(channel)` gère un cas particulier : les canaux `smtp` peuvent référencer un `smtpServerId` plutôt que stocker des identifiants en dur — la config effective (host/port/credentials) est alors récupérée via `smtpServerService.getTransportConfig()`.

### Bindings et résolution merge/replace/exclude

La fonction pivot est `_applyBindings(channelIds, bindings)` :

```ts
_applyBindings(channelIds: Set<number>, bindings: NotificationBinding[]): Set<number> {
  if (bindings.length === 0) return channelIds;
  const hasReplace = bindings.some((b) => b.overrideMode === 'replace');
  if (hasReplace) channelIds = new Set();          // 'replace' vide l'ensemble hérité
  for (const b of bindings) {
    if (b.overrideMode !== 'exclude') channelIds.add(b.channelId);   // merge/replace ajoutent
  }
  for (const b of bindings) {
    if (b.overrideMode === 'exclude') channelIds.delete(b.channelId); // exclude retire un canal précis
  }
  return channelIds;
}
```

Sémantique des trois modes, appliqués **par niveau** (global, puis chaque groupe ancêtre racine→feuille, puis moniteur/agent) :

| Mode | Effet |
|---|---|
| `merge` | Ajoute le canal à l'ensemble hérité du niveau parent, sans le vider |
| `replace` | Vide entièrement l'ensemble hérité à ce niveau avant d'ajouter les canaux de ce niveau (si au moins un binding du niveau est en `replace`) |
| `exclude` | Retire un canal précis de l'ensemble hérité, sans toucher aux autres (permet de désactiver sélectivement un canal global sur un sous-groupe) |

`resolveChannelsForMonitor(monitorId, groupId, agentDeviceId?)` applique la chaîne dans l'ordre : **Global → ancêtres de groupe (racine→feuille, via `group_closure` trié `depth DESC`) → moniteur → device agent** (si le moniteur est adossé à un agent, ses bindings `scope='agent'` sont appliqués en dernier et gagnent sur les bindings moniteur).

`resolveChannelsForGroup(groupId)` fait la même chose mais s'arrête au niveau groupe (inclut le groupe lui-même, sans bindings moniteur) — utilisé pour les notifications consolidées de groupe.

`resolveChannelsForAgent(deviceId)` : Global → groupe agent ancêtres → bindings `scope='agent'` propres au device.

`resolveBindingsWithSources(scope, scopeId, groupId?)` et `resolveBindingsWithSourcesForAgent(deviceId)` refont la même résolution mais conservent, pour chaque canal actif, sa provenance (`source`, `sourceId`, `sourceName`, `isDirect`, `isExcluded`) — c'est l'API consommée par l'écran d'administration pour afficher « Hérité de Global », « Hérité du groupe X », « Direct », ou « Exclu ici ».

### Envoi des notifications

- `sendForMonitor(monitorId, groupId, payload, agentDeviceId?)` : résout les canaux, filtre sur `is_enabled = true`, envoie via le plugin correspondant (`getPlugin(channel.type).send(...)`), journalise chaque tentative dans `notification_log` via `logNotification()`.
- `sendForGroup(groupId, groupName, payload)` : variante pour les notifications consolidées (une seule notification pour tout un groupe en panne, cf. `groupNotificationService`).
- `sendForAgent(deviceId, deviceName, newStatus, previousStatus, violations?, notifType?)` : ne notifie que sur transition d'état, vérifie d'abord les préférences résolues via `resolveNotificationTypesForDevice()` (chaîne device → `agent_group_config.notificationTypes` des groupes ancêtres, triée `depth ASC` cette fois car on cherche la première valeur non nulle en partant de la feuille → global → défauts codés en dur `DEFAULT_NOTIFICATION_TYPES`).

## Intégration avec les notifications consolidées de groupe

`server/src/services/groupNotification.service.ts` (`groupNotificationService`) maintient en mémoire (`Map<number, GroupNotifState>`) l'état des moniteurs en panne par groupe ayant `group_notifications = true`. Le worker de base consulte `shouldSuppressIndividual(monitorId, groupId)` — qui appelle `groupService.findGroupNotificationAncestor(groupId)` — pour savoir si la notification individuelle doit être supprimée au profit d'une notification de groupe consolidée (`handleMonitorDown` / `handleMonitorUp` renvoient `'first_down'`/`'all_recovered'` pour déclencher l'envoi, ou `'already_down'`/`'still_down'` pour le supprimer). `initialize()` reconstruit cet état au démarrage du serveur à partir des heartbeats existants.

## API et endpoints

Routes dans `server/src/routes/notifications.routes.ts`, toutes sous `requireAuth` + `requireRole('admin')` :

| Méthode | Route | Contrôleur |
|---|---|---|
| GET | `/notifications/plugins` | `notificationsController.plugins` |
| GET | `/notifications/channels` | `notificationsController.listChannels` |
| GET | `/notifications/channels/:id` | `notificationsController.getChannel` |
| POST | `/notifications/channels` | `notificationsController.createChannel` |
| PUT | `/notifications/channels/:id` | `notificationsController.updateChannel` |
| DELETE | `/notifications/channels/:id` | `notificationsController.deleteChannel` |
| POST | `/notifications/channels/:id/test` | `notificationsController.testChannel` |
| GET/PUT | `/notifications/channels/:id/tenants` | `getChannelTenants` / `setChannelTenants` |
| GET | `/notifications/bindings/resolved` | `notificationsController.resolvedBindings` |
| GET | `/notifications/bindings` | `notificationsController.listBindings` |
| POST | `/notifications/bindings` | `notificationsController.addBinding` |
| DELETE | `/notifications/bindings` | `notificationsController.removeBinding` |

## Client — NotificationBindingsPanel

`client/src/components/notifications/NotificationBindingsPanel.tsx` affiche, pour un scope donné (`group` ou `monitor`), la liste des canaux actifs avec leur provenance (obtenue via `resolveBindingsWithSources`). Un sélecteur permet de choisir le mode d'override (`merge`/`replace`) appliqué à **tous les bindings directs non-exclude** de ce scope (`changeOverrideMode()` met à jour chaque binding existant) :

```ts
const replaceBinding = scopeBindings.find((b) => b.overrideMode === 'replace');
if (replaceBinding) setOverrideMode('replace');
```

Pour chaque canal hérité, le composant propose un bouton « Unbind » qui crée un binding local en mode `exclude` (`excludeChannel()` → `notificationsApi.addBinding(channelId, scope, scopeId, 'exclude')`) plutôt que de supprimer le binding parent (qui reste intact pour les autres groupes/moniteurs qui en héritent). Ce panneau est intégré directement dans `GroupManagePage.tsx` à côté de `SettingsPanel`, permettant d'éditer settings et notifications d'un même groupe sans changer d'écran.

## Références

- `server/src/db/migrations/007_create_notifications.ts`
- `server/src/db/migrations/041_notification_channel_tenants.ts`
- `server/src/db/migrations/042_agent_notification_types.ts`
- `server/src/services/notification.service.ts`
- `server/src/services/groupNotification.service.ts`
- `server/src/services/group.service.ts` (`findGroupNotificationAncestor`)
- `server/src/controllers/notifications.controller.ts`
- `server/src/routes/notifications.routes.ts`
- `server/src/notifications/registry.ts`
- `client/src/components/notifications/NotificationBindingsPanel.tsx`
- `client/src/pages/GroupManagePage.tsx`
