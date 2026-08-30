Les agents remontent des métriques évaluées côté serveur, à la volée, à chaque réception (push HTTP ou heartbeat WS) — `AgentMonitorWorker` n'exécute lui-même aucune vérification active, il se contente de détecter l'absence de remontée (« device offline ») et de refléter le dernier statut calculé au moment du push.

## Hiérarchie des seuils de métriques

Les seuils (CPU, RAM, disque, réseau entrant/sortant, température) suivent une résolution en cascade, appliquée dans `agent.service.ts::_storeMetricsAsHeartbeat()` :

```ts
// Threshold hierarchy: agent's explicitly saved thresholds always win;
// group thresholds are the default when the agent has none;
// system defaults are the last resort.
const thresholds: AgentThresholds =
  monitor.agent_thresholds ?? device.groupThresholds ?? DEFAULT_AGENT_THRESHOLDS;
```

1. `monitor.agent_thresholds` — seuils explicitement enregistrés sur le moniteur agent (colonne JSON) ;
2. `device.groupThresholds` — seuils hérités du groupe agent auquel le device appartient (résolus par ailleurs depuis la config de groupe) ;
3. `DEFAULT_AGENT_THRESHOLDS` (`shared/src/types.ts`) — valeurs système par défaut, dernier recours.

```ts
export const DEFAULT_AGENT_THRESHOLDS: AgentThresholds = {
  cpu:    { enabled: true,  threshold: 90,         op: '>' },
  memory: { enabled: true,  threshold: 90,         op: '>' },
  disk:   { enabled: true,  threshold: 90,         op: '>' },
  netIn:  { enabled: false, threshold: 12_500_000, op: '>' }, // 100 Mbps en octets/s
  netOut: { enabled: false, threshold: 12_500_000, op: '>' },
  temp:   { globalEnabled: false, op: '>', threshold: 85, overrides: {} },
};
```

Chaque métrique génère, en cas de dépassement, une entrée `violations[]` (message lisible) et `violationKeys[]` (clé stable pour la déduplication côté client — ex. `cpu`, `ram`, `disk:<mount>`, `net_in`, `net_out`). Le champ `temp` supporte un seuil global (`globalEnabled`) et des overrides par capteur individuel.

**Important** : cette hiérarchie de seuils est totalement indépendante du flag `override_group_settings` décrit ci-dessous — les seuils de métriques ne sont jamais affectés par ce flag.

## `override_group_settings` : ce qu'il contrôle (et ne contrôle pas)

La colonne `agent_devices.override_group_settings` (booléen, ajoutée en migration `026_agent_settings_override.ts`, défaut `false`) contrôle **uniquement** :

- `checkIntervalSeconds` — cadence de push/heartbeat de l'agent ;
- `heartbeatMonitoring` — activation de la détection de mise hors ligne ;
- `maxMissedPushes` — nombre de pushs manqués avant de déclarer le device hors ligne ;
- `notificationCooldownSeconds` — délai de debounce des notifications.

Elle **ne contrôle jamais** les seuils de métriques (`agent_thresholds`), qui suivent leur propre hiérarchie décrite plus haut.

```ts
// override_group_settings = false (défaut) → héritage complet de la config de groupe
// override_group_settings = true → les valeurs du device gagnent toujours
const override = row.override_group_settings ?? false;
```

## Résolution en temps réel dans `AgentMonitorWorker`

`AgentMonitorWorker.performCheck()` (`server/src/workers/AgentMonitorWorker.ts`) résout ces quatre réglages à chaque cycle en remontant la chaîne complète de groupes (via `group_closure`), de la racine vers la feuille — même logique de fusion que `settingsService.resolveForMonitor` :

```ts
// device own values → global default
// group chain root→leaf each overrides previous
// device override_group_settings=true → device values always win
if (!device.override_group_settings && device.group_id !== null) {
  const ancestorRows = await db('group_closure')
    .join('monitor_groups', 'monitor_groups.id', 'group_closure.ancestor_id')
    .where('group_closure.descendant_id', device.group_id)
    .orderBy('group_closure.depth', 'desc') // racine d'abord → groupe direct en dernier
    .select('monitor_groups.agent_group_config');

  for (const row of ancestorRows) {
    const cfg = /* parse JSON */;
    if (cfg.pushIntervalSeconds != null) effectiveCheckInterval = cfg.pushIntervalSeconds;
    if (cfg.heartbeatMonitoring  != null) effectiveHeartbeatMonitoring = cfg.heartbeatMonitoring;
    if (cfg.maxMissedPushes      != null) effectiveMaxMissedPushes = cfg.maxMissedPushes;
    if (cfg.notificationCooldownSeconds != null) this.config.notificationCooldownSeconds = cfg.notificationCooldownSeconds;
  }
}
// Override par device — s'applique toujours quand défini (null = hériter)
if (device.notification_cooldown_seconds != null) {
  this.config.notificationCooldownSeconds = device.notification_cooldown_seconds;
}
```

Le worker réinitialise `this.config.notificationCooldownSeconds` à une valeur de référence (`baselineNotificationCooldownSeconds`, capturée à la construction) avant chaque parcours d'ancêtres — sinon un cooldown de groupe effacé laisserait la dernière valeur non nulle « collée » au worker jusqu'au redémarrage du process (bug corrigé, documenté en commentaire dans le code).

## Détection de mise hors ligne

`maxStaleMs = effectiveCheckInterval * effectiveMaxMissed * 1000` (avec `effectiveMaxMissedPushes ?? 2` par défaut). États possibles retournés :

| Condition | Statut | Message |
|---|---|---|
| Device introuvable | `down` | "Agent device not found" |
| `status = refused` | `down` | "Agent device is refused" |
| `status = suspended` | `paused` | "Agent device is suspended" |
| `status = pending` | `pending` | "Waiting for device approval" |
| `updating_since` < 10 min | `pending` (badge `updating` côté UI) | "Agent is self-updating..." |
| Aucun push depuis le démarrage serveur, dans la période de grâce | statut confirmé précédent | — (no-op anti-spam) |
| Aucun push, hors période de grâce | `down` ou `inactive` | selon `effectiveHeartbeatMonitoring` |
| Push trop ancien (> `maxStaleMs`) | `down` ou `inactive` | "Device offline (last seen Xs ago)" |
| Push récent | statut calculé au moment du push (`snapshot.overallStatus`) | violations jointes ou "All metrics OK" |

La période de grâce au démarrage serveur (`gracePeriodMs = 60_000 + effectiveCheckInterval * effectiveMaxMissed * 1000`) évite de spammer des notifications de mise hors ligne pendant que les agents se reconnectent après un redémarrage serveur.

Une subtilité : quand un agent est en ligne mais dépasse un seuil (CPU/RAM/température), le statut de heartbeat reste épinglé à `up` (`heartbeatStatus: 'up'`) — les dépassements de seuil ne comptent jamais comme une interruption de service dans l'onglet Uptime, qui mesure uniquement la joignabilité.

## Références

- `server/src/workers/AgentMonitorWorker.ts` — résolution effective, détection offline
- `server/src/services/agent.service.ts` — `_storeMetricsAsHeartbeat`, hiérarchie des seuils
- `shared/src/types.ts` — `DEFAULT_AGENT_THRESHOLDS`, `AgentThresholds`
- `server/src/db/migrations/026_agent_settings_override.ts` — colonne `override_group_settings`
- `client/src/pages/AgentDetailPage.tsx` — éditeur de seuils, config d'affichage
