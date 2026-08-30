Obliview utilise deux canaux temps réel distincts sur le même port HTTP : Socket.io pour la UI web (heartbeats, changements de statut, alertes live), et un `WebSocketServer` (librairie `ws`) dédié pour le canal de commandes bidirectionnel avec les agents natifs, qui a remplacé le polling HTTP historique.

## Partage du port HTTP entre les deux canaux

`server/src/index.ts` intercepte manuellement l'événement `upgrade` du serveur HTTP pour aiguiller les connexions WebSocket entrantes selon le chemin demandé :

```ts
const agentWss = new WebSocketServer({ noServer: true });
const sioUpgradeListeners = server.rawListeners('upgrade').slice();
server.removeAllListeners('upgrade');

const AGENT_WS_RE = /^\/api\/agent\/ws$/;

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (AGENT_WS_RE.test(pathname)) {
    // authentification par X-Api-Key + query param uuid, puis agentHub.register(...)
    return;
  }
  // sinon, transfert vers les listeners originaux de Socket.io
  for (const listener of sioUpgradeListeners) listener.call(server, request, socket, head);
});
```

Cela évite de devoir ouvrir un second port pour le canal agent : `/api/agent/ws` est intercepté avant que Socket.io ne voie la requête d'upgrade, tout le reste (y compris `/socket.io/`) continue vers Engine.io normalement.

## Canal de commandes agent (`agentHub.service.ts`)

### Authentification et enregistrement

À la connexion, le serveur exige un header `X-Api-Key` et un paramètre de requête `uuid` (identifiant matériel stable de l'appareil). La clé est validée contre la table `agent_api_keys` ; en cas d'échec la socket est fermée avec un code applicatif (`4003` clé invalide, `4000` paramètre manquant).

```ts
async register(apiKeyId, tenantId, deviceUuid, clientIp, ws) {
  const existing = this.byDevice.get(deviceUuid);
  if (existing?.ws.readyState === 1) existing.ws.close(1000, 'replaced');
  this.byDevice.set(deviceUuid, { ws, apiKeyId, tenantId, deviceUuid, clientIp });
  ...
  await this._handleHeartbeat(conn, { type: 'heartbeat' }); // config immédiate, sans attendre le 1er heartbeat périodique
  this.syncProxyMonitors(deviceUuid).catch(...);
}
```

Une seule connexion active par `deviceUuid` — une reconnexion remplace proprement l'ancienne socket (`close(1000, 'replaced')`).

### Protocole de messages (JSON sur WebSocket)

| Type | Sens | Contenu |
|---|---|---|
| `heartbeat` | agent → serveur | `hostname`, `agentVersion`, `deviceType` (`agent`\|`proxy`), `osInfo`, `metrics` |
| `config` | serveur → agent | `checkIntervalSeconds`, `latestVersion` (pour auto-update), `command` (commande en attente) |
| `command` | serveur → agent | `{ type: 'command', id, commandType, payload }` — envoyé via `sendCommandAndWait` |
| `ack` | agent → serveur | `{ type: 'ack', id, commandType, success, result?, error? }` — acquitte une commande |
| `proxy_sync` | serveur → agent | liste des configurations de moniteurs proxy assignés à cet agent |
| `proxy_result` | agent → serveur | résultat d'un check exécuté par l'agent pour le compte d'un moniteur proxy |

Côté agent Go, ces messages sont gérés dans `agent/cmd_ws.go` (`cmdHeartbeatMsg`, `cmdConfigMsg`, `cmdCommandMsg`, `cmdAckMsg`, fonctions `cmdWSSession`, `handleCmdWSFrame`, `sendCmdHeartbeat`).

### Commandes avec accusé de réception

`sendCommandAndWait(deviceUuid, commandType, payload, timeoutMs = 30000)` implémente un aller-retour requête/réponse par-dessus un canal asynchrone : une `Promise` est enregistrée dans `pendingAcks` (clé = UUID de commande généré par `crypto.randomUUID()`), résolue ou rejetée dès réception de l'`ack` correspondant, avec un timeout de secours. À la déconnexion d'un agent, toutes ses acks en attente sont rejetées immédiatement (`_unregister`) plutôt que de laisser l'appelant attendre le timeout complet.

### Keep-alive

Un ping WebSocket natif est envoyé à toutes les connexions actives toutes les 15 secondes (`setInterval` dans le constructeur du service), pour éviter la fermeture de connexions inactives par des reverse proxies intermédiaires.

### Compatibilité HTTP legacy

Le endpoint historique `POST /api/agent/push` (HTTP, sans session) reste supporté pour les agents ne supportant pas encore le canal WS — mêmes champs de configuration en retour (`checkIntervalSeconds`, `command`), traités par le même service `agent.service.ts` (`handlePush`), appelé indifféremment depuis `agentHub.service.ts._handleHeartbeat` (canal WS) ou depuis le contrôleur HTTP `agent.controller.ts`.

### Synchronisation des moniteurs proxy

Quand un moniteur de type "proxy" (exécuté par un agent pour le compte du serveur, ex. check réseau interne) est créé/modifié/supprimé, `syncProxyMonitors(deviceUuid)` (ou `syncAllProxyMonitors()` pour fan-out) repousse en push la configuration complète des moniteurs assignés à un agent donné, filtrée par tenant en défense en profondeur :

```ts
const monitors = await db('monitors')
  .where({ proxy_agent_device_id: device.id, is_active: true, tenant_id: device.tenant_id })
  .select('id', 'type', 'interval_seconds', 'timeout_ms', 'url', ...);
conn.ws.send(JSON.stringify({ type: 'proxy_sync', monitors: configs }));
```

## Socket.io — temps réel pour la UI

### Authentification et rooms (`server/src/socket.ts`)

Socket.io utilise un middleware `io.use(...)` qui lit `userId`/`tenantId` depuis `socket.handshake.auth` (pas de cookie — transmis explicitement par le client à la connexion), vérifie l'utilisateur en base (`authService.getUserById`), puis fait rejoindre plusieurs rooms :

| Room | Portée |
|---|---|
| `user:{userId}` | messages ciblés à un utilisateur précis |
| `tenant:{tenantId}` | tous les connectés du tenant courant |
| `tenant:{tenantId}:admin` | admins du tenant courant uniquement |
| `tenant:{tid}:notifications` | rejoint pour **tous** les tenants accessibles à l'utilisateur (via `user_tenants`), pour recevoir les alertes live cross-tenant même en visualisant un autre tenant |
| `general` | broadcast global (tous les utilisateurs authentifiés) |

Un commentaire du code souligne qu'une ancienne room globale `role:admin` (cross-tenant) a été supprimée à la suite d'une revue de sécurité — elle exposait les événements de tous les tenants à tous les admins de tous les tenants. Tous les points d'émission ciblent désormais explicitement `tenant:{id}:admin`.

### Catalogue des événements (`shared/src/socketEvents.ts`)

```ts
export const SOCKET_EVENTS = {
  INITIAL_DATA: 'initialData',
  MONITOR_HEARTBEAT: 'monitor:heartbeat',
  MONITOR_STATUS_CHANGE: 'monitor:statusChange',
  MONITOR_CREATED: 'monitor:created',
  MONITOR_UPDATED: 'monitor:updated',
  MONITOR_DELETED: 'monitor:deleted',
  MONITOR_PAUSED: 'monitor:paused',
  GROUP_CREATED: 'group:created', GROUP_UPDATED: 'group:updated', GROUP_DELETED: 'group:deleted', GROUP_MOVED: 'group:moved',
  NOTIFICATION_SENT: 'notification:sent',
  SETTINGS_UPDATED: 'settings:updated',
  AGENT_DEVICE_UPDATED: 'agent:deviceUpdated',
  AGENT_STATUS_CHANGED: 'agent:statusChanged',
  AGENT_DEVICE_DELETED: 'agent:deviceDeleted',
  MAINTENANCE_CHANGED: 'maintenance:changed',
  NOTIFICATION_NEW: 'notification:new',
} as const;

export const CLIENT_EVENTS = {
  MONITOR_SUBSCRIBE: 'monitor:subscribe',
  MONITOR_UNSUBSCRIBE: 'monitor:unsubscribe',
  MONITOR_REQUEST_HISTORY: 'monitor:requestHistory',
} as const;
```

### Filtrage de visibilité à l'émission

`BaseMonitorWorker.emitToVisibleUsers(event, payload)` (`server/src/workers/BaseMonitorWorker.ts`) est le point d'émission central pour les heartbeats et changements de statut de moniteur. Il ne diffuse pas en broadcast global mais cible précisément :

```ts
private async emitToVisibleUsers(event: string, payload: unknown): Promise<void> {
  const tenantId = await this.resolveTenantId();
  if (tenantId !== null) {
    this.io.to(`tenant:${tenantId}:admin`).emit(event, payload);
  }
  const userIds = await permissionService.getUsersWithMonitorAccess(this.config.id);
  for (const userId of userIds) {
    this.io.to(`user:${userId}`).emit(event, payload);
  }
}
```

Les admins du tenant reçoivent tout ; les utilisateurs non-admins ne reçoivent l'événement que si `permissionService.getUsersWithMonitorAccess` les identifie comme ayant un accès (via appartenance à une équipe avec permission sur le moniteur ou son groupe). Ce helper est appelé pour `MONITOR_HEARTBEAT` et `MONITOR_STATUS_CHANGE`.

### Alertes live (`liveAlert.service.ts`)

Les alertes persistées en base (table `live_alerts`) sont dédupliquées par `stable_key` : une insertion est ignorée si une alerte non lue avec la même paire `(tenant_id, stable_key)` existe déjà. Après insertion, l'événement est émis à toute la room de notifications du tenant :

```ts
_io.to(`tenant:${tenantId}:notifications`).emit(SOCKET_EVENTS.NOTIFICATION_NEW, enriched);
```

Seules les 200 alertes les plus récentes par tenant sont conservées (purge SQL immédiate après insertion). C'est cette même room `tenant:{tid}:notifications` — rejointe pour tous les tenants de l'utilisateur au moment de la connexion socket — qui permet l'agrégation cross-tenant dans le launcher ObliTools (badges de notifications non lues par onglet/tenant).

### Client (`socketClient.ts`)

Côté client, `connectSocket(userId, tenantId?)` établit la connexion avec `auth: { userId, tenantId }` et gère explicitement la détection de réveil de veille système (voir page "Architecture client") pour forcer une reconnexion plutôt que d'attendre le timeout de ping Socket.io (jusqu'à 45s).

## Références

- `server/src/index.ts`
- `server/src/socket.ts`
- `server/src/services/agentHub.service.ts`
- `server/src/services/liveAlert.service.ts`
- `server/src/workers/BaseMonitorWorker.ts`
- `shared/src/socketEvents.ts`
- `client/src/socket/socketClient.ts`
- `agent/cmd_ws.go`