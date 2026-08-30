Pour éviter le spam de notifications lorsqu'une métrique oscille autour d'un seuil (CPU qui monte/descend juste au-dessus de la limite, par exemple), `BaseMonitorWorker` implémente un mécanisme complet de debounce/cooldown au-dessus de la logique de retry. La logique est entièrement contenue dans `server/src/workers/BaseMonitorWorker.ts`.

## Vue d'ensemble : deux couches distinctes

1. **Retry (confirmation)** : un changement de statut brut (`down`/`alert`) doit persister sur `maxRetries` vérifications consécutives avant d'être considéré comme confirmé (`confirmedStatus`). Ceci est géré dans `processResult()` en amont, indépendamment du cooldown.
2. **Cooldown (debounce des notifications)** : une fois un changement confirmé, `handleStatusChange()` décide d'envoyer la notification immédiatement ou de la mettre en file selon le temps écoulé depuis la dernière notification.

Ces deux couches sont cumulatives : un moniteur peut retarder la confirmation d'un `down` via les retries, *puis* retarder encore la notification elle-même via le cooldown si l'état oscille.

## État interne du worker

```ts
protected confirmedStatus: MonitorStatus = 'pending';
/** Unix-ms timestamp of the last notification sent (for cooldown) */
protected lastNotifiedAt: number = 0;
/** The status that was last actually notified to the user */
protected lastNotifiedStatus: MonitorStatus = 'pending';
/** Unix-ms timestamp of the last confirmed status change (for debounce) */
protected lastStateChangeAt: number = 0;
/** Pending notification queued during cooldown (sent when state is stable for cooldown duration) */
protected pendingNotification: { status: MonitorStatus; message?: string; inMaintenance?: boolean } | null = null;
```

## Première notification : envoi immédiat

Dans `handleStatusChange(newStatus, message, inMaintenance)`, après les vérifications de suppression (maintenance, `inactive`, proxy agent down), la décision de debounce est prise ainsi :

```ts
const cooldownMs = (this.config.notificationCooldownSeconds ?? 0) * 1000;
if (cooldownMs > 0 && this.lastNotifiedAt > 0) {
  // We already sent at least one notification — debounce subsequent ones
  this.lastStateChangeAt = Date.now();
  this.pendingNotification = { status: newStatus, message, inMaintenance };
  return;
}
// First notification or cooldown disabled — send immediately
this.lastNotifiedAt = Date.now();
this.lastNotifiedStatus = newStatus;
this.lastStateChangeAt = Date.now();
await this.dispatchNotification(oldStatus, newStatus, message, inMaintenance);
```

Le test `this.lastNotifiedAt > 0` est la clé : tant qu'aucune notification n'a jamais été envoyée pour ce moniteur (worker qui démarre, ou cooldown désactivé via `notificationCooldownSeconds = 0`), l'envoi est immédiat. Ce n'est qu'à partir de la **deuxième** notification potentielle que le debounce entre en jeu.

## Changements suivants : mise en file + reset du timer

Chaque appel ultérieur à `handleStatusChange()` pendant la fenêtre de cooldown écrase simplement `pendingNotification` avec le nouveau statut et **réinitialise** `lastStateChangeAt` à `Date.now()`. Il n'y a qu'une seule notification en attente à la fois — la plus récente écrase la précédente, ce qui a pour effet de repousser indéfiniment l'envoi tant que l'état continue de changer :

```ts
this.lastStateChangeAt = Date.now();          // reset du timer de stabilité
this.pendingNotification = { status: newStatus, message, inMaintenance };
```

Il n'y a pas de file au sens FIFO — seule la dernière transition en attente est conservée, car c'est l'état final qui doit être notifié, pas l'historique des oscillations intermédiaires.

## Flush : envoi quand l'état est stable

`flushPendingNotification()` est appelée à **chaque** `beat()`, juste après le traitement du changement d'état courant, indépendamment du fait qu'un nouveau changement ait eu lieu ce tick-là :

```ts
private async flushPendingNotification(): Promise<void> {
  if (!this.pendingNotification) return;
  const cooldownMs = (this.config.notificationCooldownSeconds ?? 0) * 1000;
  if (cooldownMs <= 0) return;
  const elapsed = Date.now() - this.lastStateChangeAt;
  if (elapsed < cooldownMs) return; // still in debounce window

  const pending = this.pendingNotification;
  this.pendingNotification = null;

  // Skip if the pending status is the same as what we last notified
  if (pending.status === this.lastNotifiedStatus) {
    return; // rien à signaler : retour à l'état déjà notifié
  }

  this.lastNotifiedAt = Date.now();
  this.lastNotifiedStatus = pending.status;
  await this.dispatchNotification(this.confirmedStatus, pending.status, pending.message, pending.inMaintenance);
}
```

Deux garde-fous importants :

- **Stabilité totale requise** : `elapsed = Date.now() - lastStateChangeAt` doit dépasser `cooldownMs`. Comme `lastStateChangeAt` est remis à zéro à chaque nouveau changement (voir section précédente), la notification en attente n'est envoyée que si l'état **n'a pas bougé** pendant toute la durée du cooldown — c'est un vrai debounce, pas un simple throttle périodique.
- **Annulation silencieuse si retour à l'état déjà connu** : si le statut en attente est identique à `lastNotifiedStatus` (ex. l'état est reparti en oscillation et revenu à sa valeur d'origine avant la fin du cooldown), la notification est purement et simplement abandonnée — aucun bruit envoyé pour un non-événement.

`dispatchNotification()` (partagée entre l'envoi immédiat et l'envoi différé) est le point d'entrée unique vers `notificationService.sendForMonitor`/`sendForGroup`, `remediationService.triggerForMonitor` et `liveAlertService.add` — le debounce ne change que le *moment* de l'appel, jamais sa logique métier (filtrage par type de notification agent, suppression de groupe, etc.).

## Résolution de la valeur de cooldown : priorité device > groupe > défaut

`notificationCooldownSeconds` fait partie de `MonitorConfig` et est résolu différemment selon le type de moniteur.

### Moniteurs classiques

`MonitorWorkerManager` (`server/src/workers/MonitorWorkerManager.ts`) construit la config à partir des settings résolus par héritage standard (global → groupe → moniteur) :

```ts
notificationCooldownSeconds: resolved[SETTINGS_KEYS.NOTIFICATION_COOLDOWN].value,
```

La valeur par défaut système est définie dans `shared/src/settingsDefaults.ts` :

```ts
export const SETTINGS_KEYS = {
  ...
  NOTIFICATION_COOLDOWN: 'notification_cooldown',
};

export const SETTINGS_DEFAULTS = {
  ...
  [SETTINGS_KEYS.NOTIFICATION_COOLDOWN]: 300,   // 300 secondes = 5 minutes
};
```

### Moniteurs agent — chaîne complète device > groupe > défaut

`AgentMonitorWorker` (`server/src/workers/AgentMonitorWorker.ts`) réévalue `notificationCooldownSeconds` à **chaque** `performCheck()`, car la config du groupe agent peut changer dynamiquement sans redémarrage du worker. Trois niveaux sont appliqués dans cet ordre :

```ts
// 1. Reset à la valeur de référence (résolue une seule fois à la construction du worker)
this.config.notificationCooldownSeconds = this.baselineNotificationCooldownSeconds;

// 2. Chaîne de groupes agent (racine → feuille), seulement si override_group_settings = false
if (!device.override_group_settings && device.group_id !== null) {
  const ancestorRows = await db('group_closure')
    .join('monitor_groups', 'monitor_groups.id', 'group_closure.ancestor_id')
    .where('group_closure.descendant_id', device.group_id)
    .orderBy('group_closure.depth', 'desc')   // root first → direct group last
    .select('monitor_groups.agent_group_config');

  for (const row of ancestorRows) {
    const cfg = /* parse agent_group_config JSON */;
    if (cfg.notificationCooldownSeconds != null) {
      this.config.notificationCooldownSeconds = cfg.notificationCooldownSeconds;
    }
  }
}

// 3. Override par device — s'applique TOUJOURS quand défini, prioritaire sur tout
if (device.notification_cooldown_seconds != null) {
  this.config.notificationCooldownSeconds = device.notification_cooldown_seconds;
}
```

Priorité effective : **`agent_devices.notification_cooldown_seconds` (niveau device) > `monitor_groups.agent_group_config.notificationTypes`/`notificationCooldownSeconds` (chaîne de groupe, la config la plus spécifique — depth le plus bas — gagne) > valeur baseline résolue via les settings globaux (défaut 300 s)**.

Le reset systématique à `baselineNotificationCooldownSeconds` avant de rejouer la chaîne d'ancêtres est un correctif explicite (commenté « ultracode #6 correctness bug ») : sans ce reset, effacer la valeur de cooldown au niveau d'un groupe laissait la dernière valeur non-nulle « collée » sur le worker en mémoire jusqu'au redémarrage du process, au lieu de revenir correctement au défaut.

La colonne `notification_cooldown_seconds` sur `agent_devices` a été ajoutée par la migration `048_agent_notification_cooldown.ts` :

```ts
t.integer('notification_cooldown_seconds').nullable();
```

`null` signifie explicitement « hériter du groupe/global » — ce n'est pas une valeur de cooldown de zéro.

## Récapitulatif du flux

```
Check → statut brut
  → (down/alert) retries jusqu'à maxRetries → confirmedStatus mis à jour
  → handleStatusChange(newStatus)
       → lastNotifiedAt == 0 ou cooldown désactivé ?  → dispatch immédiat
       → sinon → pendingNotification = {...}, lastStateChangeAt = now
  → flushPendingNotification() (à chaque beat)
       → stable depuis >= cooldownMs ?
            → statut inchangé vs lastNotifiedStatus → abandon silencieux
            → sinon → dispatch (notifications, remédiation, live alert)
```

## Références

- `server/src/workers/BaseMonitorWorker.ts` — `handleStatusChange`, `flushPendingNotification`, `dispatchNotification`, état `lastNotifiedAt`/`lastStateChangeAt`/`pendingNotification`
- `server/src/workers/AgentMonitorWorker.ts` — résolution device > groupe > baseline, `baselineNotificationCooldownSeconds`
- `server/src/workers/MonitorWorkerManager.ts` — résolution `notificationCooldownSeconds` via les settings hérités pour les moniteurs classiques
- `shared/src/settingsDefaults.ts` — `SETTINGS_KEYS.NOTIFICATION_COOLDOWN`, défaut 300 s
- `server/src/db/migrations/048_agent_notification_cooldown.ts` — colonne `notification_cooldown_seconds` sur `agent_devices`
- `server/src/services/notification.service.ts` — `sendForMonitor`, `sendForAgent` appelés en aval du dispatch
