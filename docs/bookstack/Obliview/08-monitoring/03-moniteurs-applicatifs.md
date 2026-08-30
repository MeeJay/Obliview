Au-delà des protocoles réseau bas niveau, Obliview propose des moniteurs "applicatifs" capables d'interroger un conteneur Docker, un serveur de jeu, une API JSON, d'exécuter un script arbitraire, de piloter un navigateur headless ou de surveiller l'évolution d'une valeur numérique dans le temps. Tous héritent de `BaseMonitorWorker` et vivent dans `server/src/workers/`.

## Docker — `DockerMonitorWorker.ts`

Interroge l'API Docker Engine (`/containers/:name/json`) pour lire `State.Running` / `State.Status`. Deux modes de transport selon la valeur de `dockerHost` :

- `tcp://` ou `http(s)://` → requête `fetch` classique (le préfixe `tcp://` est réécrit en `http://`).
- Chemin de socket Unix (ex. `/var/run/docker.sock`) → `fetch` ne supportant pas nativement les sockets Unix côté Node, le worker bascule sur `checkViaUnixSocket()` qui utilise le module `http` avec l'option `socketPath`.

Le conteneur est considéré `up` si `State.Running === true`, `down` sinon (conteneur arrêté, absent, ou erreur de connexion au démon Docker).

## Game Server — `GameServerMonitorWorker.ts` et `gamedig`

S'appuie sur le package npm `gamedig`, qui ne fournit pas de typings TypeScript officiels adaptés à l'usage du projet — un fichier de déclaration custom est donc maintenu dans `server/src/types/gamedig.d.ts` :

```ts
declare module 'gamedig' {
  interface QueryOptions {
    type: string; host: string; port?: number;
    maxRetries?: number; socketTimeout?: number; attemptTimeout?: number;
  }
  interface QueryResult {
    name: string; map: string; password: boolean;
    numplayers: number; maxplayers: number;
    players: Array<{ name?: string; raw?: unknown }>;
    ping: number; connect: string; raw?: unknown;
  }
  export class GameDig {
    static query(options: QueryOptions): Promise<QueryResult>;
  }
}
```

Le worker appelle `GameDig.query({ type: gameType, host: gameHost, port: gamePort, maxRetries: 1, socketTimeout: timeoutMs, attemptTimeout: timeoutMs })`. `gameType` correspond aux identifiants de protocole supportés par gamedig (ex. `minecraft`, `csgo`, `valheim`, ...). En cas de succès le message affiche le nom du serveur et l'occupation (`numplayers/maxplayers`) ; toute exception (protocole non supporté, serveur injoignable) devient `down`.

## JSON API — `JsonApiMonitorWorker.ts`

Proche d'`HttpMonitorWorker` (même agent `undici` pour ignorer SSL, même vérification de certificat post-check via `checkSslCertificate`), mais orienté validation de contenu JSON plutôt que mot-clé texte :

- Parse la réponse en JSON, puis résout un chemin (`jsonPath`) via `resolvePath()`, un mini-résolveur dot-notation maison supportant `data.status`, `$.data.status` et `data[0].name`.
- Si `jsonExpectedValue` est fourni, la valeur résolue (convertie en chaîne) doit correspondre exactement ; sinon on vérifie simplement que la valeur existe et n'est pas "falsy" (`undefined`/`null`/`false`/`''`).
- La vérification SSL est effectuée après la validation JSON et peut faire passer un check autrement réussi en `ssl_warning` / `ssl_expired`.

## Script — `ScriptMonitorWorker.ts`

Exécute une commande shell arbitraire (`scriptCommand`) via `child_process.exec`, avec un `timeout` et un `maxBuffer` de 1 Mo. Le code de sortie du processus est comparé à `scriptExpectedExit` (défaut `0`) :

- Timeout (`error.killed === true`) → `down` avec message dédié.
- Code de sortie conforme → `up`, message = 200 premiers caractères de `stdout`.
- Code de sortie différent → `down`, message = `stderr` (ou `stdout` à défaut), tronqué à 200 caractères.

Ce type de moniteur exécute du code arbitraire côté serveur avec les droits du processus Node — à réserver à des administrateurs de confiance.

## Browser (Playwright) — `BrowserMonitorWorker.ts`

Utilise `playwright-chromium` en mode headless pour vérifier qu'une page se charge réellement (rendu JS compris), au-delà d'une simple requête HTTP :

- Un navigateur Chromium **partagé** (`sharedBrowser`) est lancé paresseusement et réutilisé par toutes les instances de `BrowserMonitorWorker` (`chromium.launch({ headless: true, args: ['--no-sandbox', ...] })`), avec relance automatique sur l'évènement `disconnected`.
- Chaque check crée un `BrowserContext` isolé (`browser.newContext()`), navigue vers `browserUrl` (`waitUntil: 'domcontentloaded'`), attend optionnellement un sélecteur CSS (`browserWaitForSelector`), puis vérifie un mot-clé dans `page.content()` (`browserKeyword` / `browserKeywordIsPresent`).
- Le contexte est systématiquement fermé dans un bloc `finally` pour libérer les ressources, même en cas d'erreur.
- `browserScreenshotOnFailure` (champ du moniteur) est prévu pour capturer une capture d'écran en cas d'échec.

## ValueWatcher — `ValueWatcherMonitorWorker.ts`

Interroge une URL JSON à intervalle régulier et évalue une condition numérique ou un changement de valeur, sans jamais faire passer le moniteur en `down` pour un simple changement (sauf condition numérique non remplie) :

- Résout `valueWatcherJsonPath` via son propre petit résolveur JSONPath (`resolveJsonPath`, regex `([^.\[\]]+)|\[(\d+)\]`).
- Opérateurs supportés : `>`, `<`, `>=`, `<=`, `==`, `!=`, `between` (avec `valueWatcherThresholdMax`), et `changed`.
- Pour `changed` : compare à `previousValue` (en mémoire, initialisé depuis `valueWatcherPreviousValue` en DB au premier run) ; si la valeur diffère, retourne `valueChanged: true` — un drapeau traité spécifiquement par `BaseMonitorWorker.processResult()` : il déclenche une notification dédiée (`newStatus: 'value_changed'`) **sans** faire changer le statut du moniteur (qui reste `up`).
- Pour les opérateurs numériques : `evaluateCondition()` retourne `up` si la condition est vraie, `down` sinon.
- La valeur courante est persistée après chaque check via `persistPreviousValue()` (`UPDATE monitors SET value_watcher_previous_value = ...`), pour survivre à un redémarrage du serveur.

## Références
- `server/src/workers/DockerMonitorWorker.ts`
- `server/src/workers/GameServerMonitorWorker.ts`
- `server/src/types/gamedig.d.ts`
- `server/src/workers/JsonApiMonitorWorker.ts`
- `server/src/workers/ScriptMonitorWorker.ts`
- `server/src/workers/BrowserMonitorWorker.ts`
- `server/src/workers/ValueWatcherMonitorWorker.ts`
- `server/src/workers/BaseMonitorWorker.ts`
