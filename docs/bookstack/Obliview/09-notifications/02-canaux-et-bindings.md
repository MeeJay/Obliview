Les notifications Obliview reposent sur deux entités distinctes : le **canal** (`notification_channels`), qui décrit *comment* envoyer une alerte (type de plugin + config), et le **binding** (`notification_bindings`), qui décrit *à quel niveau de la hiérarchie* ce canal doit s'appliquer. Cette séparation permet de réutiliser un même canal Discord ou SMTP sur plusieurs groupes, moniteurs ou agents avec des règles d'héritage différentes.

## Modèle de données

Migration d'origine `server/src/db/migrations/007_create_notifications.ts` :

```ts
// notification_channels
t.increments('id').primary();
t.string('name', 255).notNullable();
t.string('type', 50).notNullable();      // plugin type: 'webhook', 'discord', ...
t.jsonb('config').notNullable().defaultTo('{}');
t.boolean('is_enabled').notNullable().defaultTo(true);
t.integer('created_by').references('id').inTable('users').onDelete('SET NULL');

// notification_bindings
t.increments('id').primary();
t.integer('channel_id').references('id').inTable('notification_channels').onDelete('CASCADE');
t.string('scope', 20).notNullable();     // 'global', 'group', 'monitor' (+ 'agent' ajouté plus tard)
t.integer('scope_id').nullable();        // null pour 'global'
t.string('override_mode', 10).notNullable().defaultTo('merge'); // 'merge' | 'replace'
t.unique(['channel_id', 'scope', 'scope_id']);
```

Le multi-tenant (Phase 13) ajoute `tenant_id` sur `notification_channels`, et la migration `041_notification_channel_tenants.ts` introduit la table de jonction `notification_channel_tenants` (clé composite `channel_id`/`tenant_id`) pour le **partage cross-tenant** d'un canal : un canal appartient à un tenant propriétaire mais peut être exposé à d'autres tenants sans duplication.

Les scopes de binding possibles, validés côté serveur (`server/src/validators/notification.schema.ts`) :

```ts
export const addBindingSchema = z.object({
  channelId: z.number().int().positive(),
  scope: z.enum(['global', 'group', 'monitor', 'agent']),
  scopeId: z.number().int().positive().nullable(),
  overrideMode: z.enum(['merge', 'replace', 'exclude']).optional(),
});
```

Trois modes d'override existent : `merge` (ajoute au set hérité), `replace` (efface le set hérité à ce niveau puis ajoute), `exclude` (retire un canal précis du set hérité sans toucher au reste).

## CRUD des canaux

Toutes les routes de `server/src/routes/notifications.routes.ts` sont protégées par `requireAuth` + `requireRole('admin')` :

| Méthode | Route | Contrôleur | Description |
|---|---|---|---|
| GET | `/api/notifications/plugins` | `plugins` | Liste les métadonnées des 10 plugins (`configFields`) |
| GET | `/api/notifications/channels` | `listChannels` | Canaux visibles pour le tenant courant (propres + partagés) |
| GET | `/api/notifications/channels/:id` | `getChannel` | Détail d'un canal |
| POST | `/api/notifications/channels` | `createChannel` | Création (validé par `createChannelSchema`) |
| PUT | `/api/notifications/channels/:id` | `updateChannel` | Mise à jour partielle |
| DELETE | `/api/notifications/channels/:id` | `deleteChannel` | Suppression (cascade sur les bindings) |
| POST | `/api/notifications/channels/:id/test` | `testChannel` | Envoie un `sendTest()` avec un payload factice |
| GET | `/api/notifications/channels/:id/tenants` | `getChannelTenants` | Liste des tenants avec qui le canal est partagé |
| PUT | `/api/notifications/channels/:id/tenants` | `setChannelTenants` | Remplace intégralement la liste de partage |
| GET | `/api/notifications/bindings/resolved` | `resolvedBindings` | Bindings résolus avec source (UI) |
| GET | `/api/notifications/bindings` | `listBindings` | Bindings bruts pour un scope |
| POST | `/api/notifications/bindings` | `addBinding` | Ajoute/`upsert` un binding |
| DELETE | `/api/notifications/bindings` | `removeBinding` | Retire un binding |

`notificationService.getAllChannels(tenantId)` (`server/src/services/notification.service.ts`) retourne, pour un tenant non-null, l'union des canaux dont `tenant_id` correspond et de ceux référencés dans `notification_channel_tenants` — avec un flag `isShared` calculé (`row.tenant_id !== currentTenantId`) pour l'affichage UI.

Le partage cross-tenant est géré par une transaction *full-replace* (pas additive) :

```ts
async setChannelTenants(channelId: number, tenantIds: number[]): Promise<void> {
  await db.transaction(async (trx) => {
    await trx('notification_channel_tenants').where({ channel_id: channelId }).del();
    if (tenantIds.length > 0) {
      await trx('notification_channel_tenants').insert(
        tenantIds.map((tenant_id) => ({ channel_id: channelId, tenant_id })),
      );
    }
  });
}
```

## Bindings : ajout / retrait

`addBinding` fait un `upsert` sur la contrainte unique `(channel_id, scope, scope_id)` — un binding existant voit simplement son `override_mode` mis à jour :

```ts
async addBinding(channelId: number, scope: string, scopeId: number | null, overrideMode: OverrideMode = 'merge') {
  const [row] = await db<BindingRow>('notification_bindings')
    .insert({ channel_id: channelId, scope, scope_id: scopeId, override_mode: overrideMode })
    .onConflict(['channel_id', 'scope', 'scope_id'])
    .merge({ override_mode: overrideMode })
    .returning('*');
  return rowToBinding(row);
}
```

## Résolution de la chaîne d'héritage

La fonction interne `_applyBindings(channelIds, bindings)` implémente les trois modes en une passe :

```ts
_applyBindings(channelIds: Set<number>, bindings: NotificationBinding[]): Set<number> {
  if (bindings.length === 0) return channelIds;

  const hasReplace = bindings.some((b) => b.overrideMode === 'replace');
  if (hasReplace) channelIds = new Set();          // 1. 'replace' vide le set hérité

  for (const b of bindings) {                       // 2. ajoute merge + replace
    if (b.overrideMode !== 'exclude') channelIds.add(b.channelId);
  }
  for (const b of bindings) {                       // 3. retire les exclude
    if (b.overrideMode === 'exclude') channelIds.delete(b.channelId);
  }
  return channelIds;
}
```

Cette fonction est appliquée successivement à chaque niveau de la hiérarchie, du plus général au plus spécifique. Quatre chaînes de résolution existent selon le type de cible :

### Pour un moniteur — `resolveChannelsForMonitor(monitorId, groupId, agentDeviceId?)`

```
Global → Groupe (chaîne d'ancêtres, racine → feuille) → Moniteur → Agent (si moniteur adossé à un device)
```

La chaîne de groupes est obtenue via la table de fermeture transitive (closure table) :

```ts
const ancestorRows = await db('group_closure')
  .where('descendant_id', groupId)
  .orderBy('depth', 'desc')   // depth élevé = racine, depth 0 = le groupe lui-même
  .select('ancestor_id');
```

Le niveau `agent` (scope `'agent'`, `scope_id = deviceId`) est appliqué **après** le niveau `monitor`, afin que la configuration au niveau du device gagne sur celle du moniteur — utile lorsqu'un même moniteur proxy est piloté par un agent avec ses propres canaux.

### Pour un groupe — `resolveChannelsForGroup(groupId)`

```
Global → Chaîne de groupes (racine → feuille, y compris le groupe lui-même)
```

Utilisé exclusivement par les notifications de groupe agrégées (voir `groupNotificationService`), sans jamais inclure de bindings de niveau `monitor`.

### Pour un agent — `resolveChannelsForAgent(deviceId)`

```
Global → Groupe agent (chaîne d'ancêtres) → Agent (bindings directs sur le device)
```

### Résolution avec sources (UI) — `resolveBindingsWithSources` / `resolveBindingsWithSourcesForAgent`

Utilisées par l'écran d'administration pour afficher, pour chaque canal actif, sa provenance (`global`/`group`/`monitor`/`agent`), si le binding est direct (`isDirect`) et s'il est explicitement exclu à ce niveau (`isExcluded`) — ce qui permet à l'UI de proposer un bouton « Débinder » distinct d'un simple retrait.

## Envoi effectif

`sendForMonitor`, `sendForGroup` et `sendForAgent` partagent le même schéma :

1. Résoudre la liste de `channelIds` via la chaîne appropriée.
2. Charger les canaux `is_enabled = true` correspondants.
3. Pour chaque canal, récupérer le plugin via `getPlugin(channel.type)`, résoudre la config effective (`resolveChannelConfig`, important pour `smtp`), appeler `plugin.send(...)`.
4. Journaliser chaque tentative dans `notification_log` via `logNotification(channelId, monitorId, eventType, success, error?)`.

```ts
for (const row of channels) {
  const channel = rowToChannel(row);
  const plugin = getPlugin(channel.type);
  if (!plugin) { logger.warn(`No plugin for notification type "${channel.type}"`); continue; }
  try {
    const resolvedConfig = await this.resolveChannelConfig(channel);
    await plugin.send(resolvedConfig, enrichedPayload);
    await this.logNotification(channel.id, monitorId, 'status_change', true);
  } catch (error) {
    await this.logNotification(channel.id, monitorId, 'status_change', false, errMsg);
  }
}
```

Si aucun canal n'est résolu pour un moniteur, un `logger.warn` explicite invite à vérifier les bindings global/groupe/moniteur — comportement volontaire pour diagnostiquer un moniteur muet.

## Types de notification par agent

Indépendamment des bindings de canal, les agents disposent d'un filtre supplémentaire par *type d'événement* (`global`, `down`, `up`, `alert`, `update`), résolu par `resolveNotificationTypesForDevice(deviceId)` selon la chaîne :

```
Device (agent_devices.notification_types) → Groupe agent (agent_group_config.notificationTypes, feuille → racine) → app_config global → DEFAULT_NOTIFICATION_TYPES (constantes partagées)
```

Chaque champ booléen est résolu indépendamment — le premier niveau à fournir une valeur non-nulle gagne, contrairement aux canaux qui empilent des ensembles.

## Références

- `server/src/services/notification.service.ts` — CRUD canaux, bindings, `_applyBindings`, `resolveChannelsForMonitor/Group/Agent`, `sendForMonitor/Group/Agent`
- `server/src/controllers/notifications.controller.ts`
- `server/src/routes/notifications.routes.ts`
- `server/src/validators/notification.schema.ts`
- `server/src/db/migrations/007_create_notifications.ts`
- `server/src/db/migrations/012_add_group_notifications.ts`
- `server/src/db/migrations/041_notification_channel_tenants.ts`
- `server/src/services/groupNotification.service.ts`
- `server/src/services/smtpServer.service.ts`
