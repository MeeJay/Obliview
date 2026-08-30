Depuis la Phase 16, la communication agent ↔ serveur passe par un canal WebSocket bidirectionnel persistant (`agent/cmd_ws.go` côté agent, `server/src/services/agentHub.service.ts` côté serveur), qui remplace le polling HTTP historique pour la livraison de commandes. Le HTTP push (`agent/push.go`, endpoint `POST /api/agent/push`) reste supporté par le serveur pour la compatibilité ascendante avec d'anciens binaires déjà déployés, mais `main.go` n'appelle plus que `runCmdWS()` — le mode WS est le seul chemin actif des agents actuels.

## Connexion et cycle de session (agent)

`runCmdWS(cfg)` boucle indéfiniment sur `cmdWSSession(cfg)` avec un backoff exponentiel en cas d'échec :

```go
const (
    cmdWSReadTimeout   = 60 * time.Second // 3 pings serveur manqués (15s) + marge
    cmdWSReconnectBase = 2 * time.Second
    cmdWSReconnectMax  = 60 * time.Second
)
```

La connexion cible `wss://<serveur>/api/agent/ws?uuid=<DeviceUUID>` avec l'en-tête `X-API-Key`. À la connexion, un premier `cmdHeartbeatMsg` est envoyé immédiatement (`sendCmdHeartbeat`), ce qui enregistre/actualise le device en base et retourne la config résolue + une éventuelle commande en attente. Un timer variable (pas un ticker) gère l'intervalle de heartbeat suivant, afin de pouvoir être réinitialisé à la volée si le serveur pousse un nouveau `checkIntervalSeconds`.

Une goroutine dédiée lit les frames WebSocket en continu et les pousse dans un channel ; le select principal traite en parallèle :

- le timer de heartbeat périodique ;
- les frames entrantes : `0x8` (close serveur → reconnexion propre), `0x9` (ping → répond `pong`), `0x1` (frame texte JSON → `handleCmdWSFrame`).

Toute frame reçue réinitialise le délai d'inactivité (`SetReadDeadline`).

## Types de messages

| Type | Direction | Rôle |
|---|---|---|
| `heartbeat` | agent → serveur | Métriques + info OS, cadence `checkIntervalSeconds` |
| `config` | serveur → agent | Réponse au heartbeat : nouvel intervalle, `latestVersion`, `command` one-shot |
| `proxy_sync` | serveur → agent | Liste des moniteurs proxy à exécuter localement |
| `command` | serveur → agent | Commande structurée avec `id`/`commandType`/`payload` (ex. `proxy_check`) |
| `ack` | agent → serveur | Confirmation d'exécution d'une commande, avec résultat ou erreur |
| `proxy_result` | agent → serveur | Résultat d'un check proxy exécuté par l'agent |

```go
type cmdConfigMsg struct {
    Type                 string `json:"type"`
    CheckIntervalSeconds int    `json:"checkIntervalSeconds,omitempty"`
    LatestVersion        string `json:"latestVersion,omitempty"`
    Command              string `json:"command,omitempty"` // ex: "uninstall"
}
```

`handleConfigMsg()` traite en premier une éventuelle commande one-shot (avant la vérification de version, car `uninstall` termine le processus via `os.Exit`), puis ajuste l'intervalle de heartbeat si modifié, puis déclenche `applyUpdateIfNewer()` si une version plus récente est signalée.

`handleWSCommand()` exécute les commandes structurées de façon asynchrone (`go handleWSCommand(...)`) pour ne jamais bloquer la boucle de lecture — important pour des commandes potentiellement longues (ex. tunnel distant).

## Hub serveur (`agentHub.service.ts`)

`AgentHubService` maintient une map `deviceUuid → AgentConn` (une connexion WS active par device) et une map `pendingAcks` (commandes en attente d'accusé, avec timeout). Un `setInterval` toutes les 15 s envoie un `ping()` à chaque connexion active pour maintenir les connexions ouvertes à travers des proxies inverses qui coupent les connexions inactives.

```ts
async register(apiKeyId, tenantId, deviceUuid, clientIp, ws: WebSocket): Promise<void> {
  const existing = this.byDevice.get(deviceUuid);
  if (existing && existing.ws.readyState === 1) {
    existing.ws.close(1000, 'replaced'); // une seule connexion active par device
  }
  ...
  await this._handleHeartbeat(conn, { type: 'heartbeat' }); // config immédiate, sans attendre le 1er tick
  this.syncProxyMonitors(deviceUuid).catch(...);
}
```

`_handleHeartbeat()` délègue à `agentService.handlePush(apiKeyId, tenantId, deviceUuid, clientIp, payload)` — la même logique métier que l'ancien endpoint HTTP est donc réutilisée telle quelle, garantissant un comportement identique entre WS et HTTP legacy.

`sendCommandAndWait(deviceUuid, commandType, payload, timeoutMs=30000)` permet au serveur (contrôleurs REST) d'envoyer une commande à un agent connecté et d'attendre son `ack` via une `Promise` résolue/rejetée dans `_handleAck()` / au timeout / à la déconnexion (`_unregister` rejette toutes les acks en attente pour ce device).

## HTTP push legacy

```http
POST /api/agent/push
X-API-Key: <clé>
X-Device-UUID: <uuid>
Content-Type: application/json

{ "hostname": "...", "agentVersion": "...", "osInfo": {...}, "metrics": {...} }
```

Réponses possibles : `200` (device approuvé, config + éventuelle `command`), `202` (device en attente d'approbation), `401` (backoff exponentiel côté agent via `backoffSteps = [5m, 10m, 30m, 60m]`). Le champ `command` (one-shot, ex. `"uninstall"`) est traité côté agent dans `push()` avant tout traitement de version — même contrat que côté WS.

## `pending_command` en base

La colonne `agent_devices.pending_command` porte la commande one-shot à délivrer. Elle est consommée (mise à `null`) dès qu'elle est livrée, que ce soit à la connexion WS (`register()` → premier heartbeat) ou au prochain push HTTP :

```ts
let pendingCommand: string | undefined;
if (dev.pendingCommand) {
  pendingCommand = dev.pendingCommand;
  const commandUpdate: Record<string, unknown> = { pending_command: null, updated_at: new Date() };
  if (pendingCommand === 'uninstall') {
    commandUpdate.uninstall_commanded_at = new Date(); // déclenche le job de nettoyage (voir page 5)
  }
  await db('agent_devices').where({ id: dev.id }).update(commandUpdate);
}
```

Le WS a l'avantage de délivrer la commande **immédiatement** (pas d'attente du prochain cycle de push), tandis que le HTTP legacy dépend du prochain `checkIntervalSeconds`.

## Références

- `agent/cmd_ws.go` — session WebSocket, dispatch des frames, heartbeat variable
- `agent/push.go` — HTTP push legacy (conservé pour compatibilité)
- `agent/main.go` — `main()` n'appelle plus que `runCmdWS`
- `server/src/services/agentHub.service.ts` — hub WS, `register`, `sendCommandAndWait`, `syncProxyMonitors`
- `server/src/services/agent.service.ts` — `handlePush()` partagé entre WS et HTTP
- `server/src/routes/agent.routes.ts` — routes `/api/agent/ws`, `/api/agent/push`
