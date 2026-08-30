Contrairement aux autres types de moniteurs qui interrogent activement une cible à intervalle régulier, un moniteur de type `push` est passif : c'est le système externe surveillé qui doit contacter Obliview périodiquement pour signaler qu'il est vivant. C'est le modèle classique "dead man's switch", utile pour superviser des cron jobs, des scripts batch ou tout processus qui n'expose pas d'interface interrogeable.

## Génération et stockage du token

À la création d'un moniteur de type `push`, `monitor.service.ts` génère automatiquement un token aléatoire de 16 octets et le stocke dans la colonne `monitors.push_token` :

```ts
// server/src/services/monitor.service.ts
if (data.type === 'push') {
  rowData.push_token = generateToken(16);
}
```

Ce token constitue à lui seul le secret d'authentification — il n'y a pas d'autre vérification d'identité sur l'endpoint de heartbeat. Le champ `pushMaxIntervalSec` du moniteur définit la fenêtre de tolérance : au-delà de ce délai sans réception d'un push, le moniteur passe `down`.

## Endpoint public `POST /api/heartbeat/:token`

Défini dans `server/src/routes/heartbeat.routes.ts`, monté sans middleware d'authentification (le token dans l'URL fait office de secret) :

```http
POST /api/heartbeat/{token} HTTP/1.1
```

```ts
router.all('/:token', async (req, res) => {
  const monitor = await db('monitors')
    .where({ push_token: token, type: 'push' })
    .first('id', 'is_active', 'status');

  if (!monitor) return res.status(404).json({ success: false, error: 'Invalid push token' });
  if (!monitor.is_active || monitor.status === 'paused') {
    return res.status(200).json({ success: true, message: 'Monitor is paused' });
  }

  PushMonitorWorker.recordPush(monitor.id);
  res.json({ success: true, message: 'OK' });
});
```

Points notables :

- La route accepte **toute méthode HTTP** (`router.all`) — `GET` et `POST` fonctionnent tous les deux, pour compatibilité avec des outils qui ne peuvent émettre qu'un simple `curl` ou une requête de navigateur planifiée.
- Un moniteur inconnu répond `404`.
- Un moniteur mis en pause répond `200` sans enregistrer le push (évite de fausser l'état `paused`).
- Le succès n'écrit *pas* directement en base — il alimente une structure en mémoire process (voir ci-dessous), le heartbeat réel étant créé au prochain `beat()` du worker.

## `PushMonitorWorker` — vérification passive du délai écoulé

`server/src/workers/PushMonitorWorker.ts` ne contacte jamais la cible : à chaque `beat()` planifié par `BaseMonitorWorker` (toutes les `intervalSeconds`), il compare l'horodatage du dernier push reçu à l'instant présent.

```ts
export class PushMonitorWorker extends BaseMonitorWorker {
  static lastPushTimes = new Map<number, number>();

  async performCheck(): Promise<CheckResult> {
    const maxInterval = (this.config.pushMaxIntervalSec as number) || 300;
    const lastPush = PushMonitorWorker.lastPushTimes.get(this.config.id);

    if (!lastPush) {
      return { status: 'down', message: 'Waiting for first push...' };
    }

    const elapsed = (Date.now() - lastPush) / 1000;
    if (elapsed > maxInterval) {
      return { status: 'down', message: `No push received for ${Math.round(elapsed)}s (max: ${maxInterval}s)` };
    }

    return { status: 'up', responseTime: Math.round(elapsed * 1000), message: `Last push ${Math.round(elapsed)}s ago` };
  }

  static recordPush(monitorId: number): void {
    PushMonitorWorker.lastPushTimes.set(monitorId, Date.now());
  }
}
```

`lastPushTimes` est une `Map` **statique**, partagée par toutes les instances du worker — c'est le pont entre la route HTTP (`recordPush`, appelée sans lien direct avec l'instance de worker du moniteur concerné) et le `performCheck()` de l'instance active correspondante.

## Conséquences architecturales

- **État en mémoire, non persistant** : `lastPushTimes` vit dans le process Node. Un redémarrage du serveur perd le dernier timestamp de push connu — c'est pourquoi `BaseMonitorWorker.start()` restaure `previousStatus`/`confirmedStatus` depuis la colonne `monitors.status` en DB et marque le premier beat comme `isStartupBeat`, afin d'éviter une notification `down` intempestive juste après un redémarrage alors que le système externe continue de pousser normalement.
- **`responseTime` détourné** : pour un push monitor, `responseTime` ne représente pas un temps de requête réseau mais le nombre de millisecondes écoulées depuis le dernier push — réutilisé tel quel pour l'affichage du graphique de latence.
- **Import/Export** : `importExport.controller.ts` référence également `push_token`/`pushToken` lors de l'export/import de la configuration des moniteurs, afin de préserver l'URL de heartbeat externe d'un moniteur push d'une instance à l'autre.
- **Cycle retry/notification identique aux autres types** : bien que le check soit passif, le moniteur passe par le même mécanisme de retry (`maxRetries`), de debounce de notification (`notificationCooldownSeconds`) et de suppression en maintenance que tout autre `BaseMonitorWorker` — seule l'implémentation de `performCheck()` diffère.

## Références
- `server/src/workers/PushMonitorWorker.ts`
- `server/src/routes/heartbeat.routes.ts`
- `server/src/services/monitor.service.ts`
- `server/src/controllers/importExport.controller.ts`
- `server/src/workers/BaseMonitorWorker.ts`
