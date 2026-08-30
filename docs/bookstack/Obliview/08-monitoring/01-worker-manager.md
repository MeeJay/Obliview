Chaque moniteur actif dans Obliview est exécuté par une instance de worker qui hérite de la classe abstraite `BaseMonitorWorker` (`server/src/workers/BaseMonitorWorker.ts`). L'orchestration de l'ensemble des workers — démarrage, arrêt, redémarrage suite à un changement de paramètres — est centralisée dans le singleton `MonitorWorkerManager` (`server/src/workers/MonitorWorkerManager.ts`).

## MonitorConfig et le registre de workers

`MonitorWorkerManager` maintient une `Map<number, BaseMonitorWorker>` (un worker par `monitor.id`) et un registre statique associant chaque `MonitorType` à sa classe de worker concrète :

```ts
const WORKER_REGISTRY: Record<string, WorkerConstructor> = {
  http: HttpMonitorWorker,
  ping: PingMonitorWorker,
  tcp: TcpMonitorWorker,
  dns: DnsMonitorWorker,
  ssl: SslMonitorWorker,
  smtp: SmtpMonitorWorker,
  docker: DockerMonitorWorker,
  game_server: GameServerMonitorWorker,
  push: PushMonitorWorker,
  script: ScriptMonitorWorker,
  json_api: JsonApiMonitorWorker,
  browser: BrowserMonitorWorker,
  value_watcher: ValueWatcherMonitorWorker,
  agent: AgentMonitorWorker,
};
```

`startMonitor()` construit un `MonitorConfig` via `buildConfig()`, qui résout la chaîne d'héritage des réglages (`settingsService.resolveForMonitor`) pour `intervalSeconds`, `retryIntervalSeconds`, `maxRetries`, `timeoutMs` et `notificationCooldownSeconds`. La priorité est : valeur explicite dans la table `settings` (scope monitor/groupe/global) > champ direct du moniteur > défaut codé en dur. Toutes les autres propriétés spécifiques à un type (`url`, `hostname`, `dockerHost`, `gameType`, `pushToken`, `agentThresholds`, `proxyAgentDeviceId`, etc.) sont copiées telles quelles dans la config, chaque worker ne lisant que les champs qui le concernent.

`startAll()` est appelé au démarrage du serveur : il récupère tous les moniteurs actifs (`monitorService.getAllActive()`) et démarre un worker par moniteur, puis initialise `groupNotificationService.initialize()` pour restaurer l'état des notifications groupées.

`restartAffectedBySettings(scope, scopeId)` permet de ne redémarrer que les workers concernés par un changement de réglages :

| Scope | Comportement |
|---|---|
| `global` | Redémarre tous les workers en cours d'exécution |
| `group` | Redémarre les moniteurs du groupe et de tous ses descendants (via `group_closure`) |
| `monitor` | Redémarre uniquement ce moniteur |

## Cycle de vie d'un check (`beat()`)

`start()` restaure `previousStatus`/`confirmedStatus` depuis la colonne `monitors.status` en base (pour éviter de renotifier un problème déjà connu après un redémarrage serveur), exécute un premier `beat()`, puis planifie le suivant via `scheduleNext()`.

`scheduleNext()` utilise un intervalle de retry plus court tant que le moniteur est en statut `down` ou `alert` et que `retryCount <= maxRetries` :

```ts
const isRetryableStatus = this.previousStatus === 'down' || this.previousStatus === 'alert';
const interval = isRetryableStatus && this.retryCount <= this.config.maxRetries
  ? this.config.retryIntervalSeconds
  : this.config.intervalSeconds;
```

`beat()` appelle soit `performCheck()` (méthode abstraite implémentée par chaque sous-classe), soit `performCheckViaProxy()` si `config.proxyAgentDeviceId` est défini — dans ce cas, le check n'est pas exécuté localement mais lu depuis un résultat poussé par un agent proxy via `agentHub.service.ts` (`BaseMonitorWorker.proxyResults`, alimenté par `recordProxyResult()`). Si aucun résultat n'a été reçu depuis plus de 3× `intervalSeconds`, l'agent proxy est considéré injoignable et la notification individuelle du moniteur est supprimée (`suppressNotification: true`) au profit d'une alerte unique "proxy hors ligne" côté agent.

La logique upside-down (`config.upsideDown`) inverse `up`/`down` après le check (ne s'applique pas aux statuts SSL).

## processResult() — retries, statuts SSL et maintenance

`processResult()` distingue trois familles de statuts :

| Catégorie | Statuts | Comportement |
|---|---|---|
| Retryable | `down`, `alert` | `retryCount++` à chaque échec ; le changement n'est confirmé (et notifié) qu'après `retryCount > maxRetries` |
| SSL (déterministe) | `ssl_warning`, `ssl_expired` | Aucun retry — notification immédiate dès changement |
| Autre | `up`, `inactive`, ... | `confirmedStatus` toujours mis à jour, y compris pendant une fenêtre de maintenance |

À chaque beat, l'état de maintenance est vérifié (`maintenanceService.isInMaintenance('agent'|'monitor', id, groupId)`, résultat mis en cache 60s). En maintenance, `confirmedStatus` n'est PAS avancé pour un problème confirmé, afin qu'à la fin de la fenêtre une notification reparte immédiatement si le problème persiste.

Un heartbeat est toujours créé via `heartbeatService.create()`, avec `isRetrying` et `inMaintenance` comme métadonnées. Le champ `heartbeatStatus` du `CheckResult` permet de découpler le statut logique (ex. `alert` pour un dépassement de seuil agent) du statut de la ligne de heartbeat (`up`), pour que l'onglet Uptime ne reflète que la joignabilité brute.

Un drapeau `isStartupBeat` (premier beat après un redémarrage serveur avec un statut restauré en DB) supprime les notifications et la mise à jour de `confirmedStatus` sur ce seul beat, le temps que l'état en mémoire (agent push, timestamp de push monitor) se reconstitue.

## handleStatusChange() et le debounce de notification

`handleStatusChange(newStatus, message, inMaintenance)` est le point d'entrée unique pour tout changement de statut confirmé. Il émet d'abord `SOCKET_EVENTS.MONITOR_STATUS_CHANGE` (filtré par visibilité), puis applique une cascade de suppressions avant d'envoyer une notification :

1. `inactive` (agent hors-ligne avec heartbeat monitoring désactivé) → aucune notification, ni la transition `inactive → up`.
2. En maintenance → notification et remédiation totalement supprimées.
3. `_suppressNotification` (agent proxy injoignable) → suppression.
4. Debounce de cooldown (voir ci-dessous).

Le debounce (`notificationCooldownSeconds`, résolu par device > chaîne de groupes agent > réglages moniteur, défaut 300s) fonctionne ainsi :

- La toute première notification (`lastNotifiedAt === 0`) part immédiatement.
- Toute transition suivante pendant la fenêtre de cooldown est mise en file (`pendingNotification`), et le timer (`lastStateChangeAt`) est réinitialisé à chaque nouveau changement.
- `flushPendingNotification()` est appelée à chaque beat : elle envoie la notification en attente seulement quand l'état est resté stable pendant toute la durée du cooldown, via `dispatchNotification()`. Si le statut en attente est identique au dernier notifié, il est simplement abandonné (log "pending notification discarded").

`dispatchNotification()` applique ensuite un filtrage supplémentaire spécifique aux moniteurs d'agent (`notificationService.resolveNotificationTypesForDevice`) pour respecter les surcharges de type de notification par device (`agent_down`, `agent_up`, `agent_alert`, `agent_fixed`), puis délègue à `groupNotificationService` (mode groupé) ou `notificationService.sendForMonitor()`, et enregistre une `liveAlertService` pour le fil d'alertes temps réel.

## Références
- `server/src/workers/BaseMonitorWorker.ts`
- `server/src/workers/MonitorWorkerManager.ts`
- `server/src/services/settings.service.ts`
- `server/src/services/maintenance.service.ts`
- `server/src/services/groupNotification.service.ts`
- `server/src/services/liveAlert.service.ts`
- `server/src/services/agentHub.service.ts`
- `shared/src/monitorTypes.ts`
