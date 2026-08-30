Les fenêtres de maintenance permettent de suspendre les notifications et remédiations sur un périmètre donné (global, groupe, moniteur ou agent) pendant une période planifiée, ponctuelle ou récurrente. Toute la logique métier est centralisée dans `server/src/services/maintenance.service.ts`.

## Modèle de données

Table `maintenance_windows` (migration `034_maintenance_windows.ts`, étendue par `036_maintenance_global_scope.ts`) :

| Colonne | Type | Rôle |
|---|---|---|
| `scope_type` | string(20) | `global` \| `group` \| `monitor` \| `agent` |
| `scope_id` | integer nullable | `NULL` uniquement si `scope_type = 'global'` (contrainte CHECK `chk_mw_scope`) |
| `schedule_type` | string(20) | `one_time` \| `recurring` |
| `start_at` / `end_at` | timestamp | bornes pour `one_time` |
| `start_time` / `end_time` | string(5) `HH:MM` | plage horaire quotidienne pour `recurring` |
| `recurrence_type` | string(20) | `daily` \| `weekly` |
| `days_of_week` | integer[] | 0=Lundi … 6=Dimanche, pour `weekly` |
| `timezone` | string(100) | fuseau IANA utilisé pour évaluer la plage horaire |
| `notify_channel_ids` | integer[] | canaux notifiés au début/fin de la fenêtre |
| `last_notified_start_at` / `last_notified_end_at` | timestamp | déduplication des notifications de transition |
| `active` | boolean | activation/désactivation de la fenêtre elle-même |

La contrainte SQL ajoutée en 036 garantit l'intégrité du scope global :

```sql
ALTER TABLE maintenance_windows
ADD CONSTRAINT chk_mw_scope CHECK (
  (scope_type = 'global' AND scope_id IS NULL) OR
  (scope_type != 'global' AND scope_id IS NOT NULL)
);
```

Table `maintenance_window_disables` (migration `037`) permet à un scope enfant de **désactiver localement** une fenêtre héritée d'un ancêtre (groupe parent ou global), sans la supprimer : `window_id`, `scope_type`, `scope_id`, contrainte d'unicité sur le triplet.

La colonne `heartbeats.in_maintenance` (migration `035_heartbeats_in_maintenance.ts`) marque chaque heartbeat émis pendant une fenêtre active, avec un index partiel `WHERE in_maintenance = TRUE`.

## Héritage additif

Contrairement au modèle merge/replace des notifications, les fenêtres de maintenance sont **additives** : une fenêtre globale, une fenêtre de groupe (propagée à tous les descendants via `group_closure`) et une fenêtre locale à l'entité s'appliquent toutes simultanément. Un scope enfant peut choisir de **désactiver** (`disableWindowForScope`) une fenêtre héritée spécifique sans affecter les autres.

```ts
export function isWindowActive(window: MaintenanceWindow, now: Date = new Date()): boolean {
  if (!window.active) return false;
  if (window.scheduleType === 'one_time') {
    if (!window.startAt || !window.endAt) return false;
    return now >= new Date(window.startAt) && now <= new Date(window.endAt);
  }
  // recurring
  const currentTime = getNowTimeInTz(window.timezone, now);
  if (window.recurrenceType === 'daily') {
    return isTimeInRange(currentTime, window.startTime!, window.endTime!);
  }
  if (window.recurrenceType === 'weekly') {
    const currentDay = getNowDayOfWeekInTz(window.timezone, now);
    return window.daysOfWeek!.includes(currentDay) && isTimeInRange(currentTime, window.startTime!, window.endTime!);
  }
  return false;
}
```

`isTimeInRange` gère les plages nocturnes (ex. 23:00–01:00) en testant `currentTime >= start || currentTime <= end` quand `start > end`.

## isInMaintenance et cache

`maintenanceService.isInMaintenance(scopeType, scopeId, groupId)` est la méthode consommée à chaud par les workers de monitoring. Elle est mise en cache 60 s (`CACHE_TTL_MS = 60_000`) par clé `scopeType:scopeId:groupId`, le cache étant vidé à chaque écriture (`create`, `update`, `delete`, `disableWindowForScope`, `enableWindowForScope`) et périodiquement par le job de transition.

Deux méthodes batch évitent les requêtes N+1 : `getInMaintenanceMonitorIds(monitors)` et `getInMaintenanceAgentIds(devices)`, utilisées respectivement par la liste des moniteurs et `/agent/devices`, qui pré-chargent en une seule requête l'ensemble des fenêtres actives, la fermeture transitive des groupes concernés et les désactivations, puis évaluent chaque entité en mémoire.

## Intégration worker

`server/src/workers/BaseMonitorWorker.ts` interroge la maintenance à chaque battement :

```ts
const inMaintenance = agentDeviceId != null
  ? await maintenanceService.isInMaintenance('agent', agentDeviceId, this.config.groupId)
  : await maintenanceService.isInMaintenance('monitor', this.config.id, this.config.groupId);
```

Effets observés :

- Le heartbeat est stocké avec `in_maintenance = true`, ce qui déclenche l'affichage **bleu** côté client (`HeartbeatBar.tsx` : `updating: 'bg-blue-500'`, appliqué quand `hb.inMaintenance && hb.status !== 'up'`, avec le libellé `· In maintenance`).
- `confirmedStatus` n'avance pas pendant la maintenance si le moniteur est en panne — la valeur pré-maintenance est conservée pour que la transition redevienne détectable une fois la fenêtre terminée.
- Un changement de statut survenant en maintenance est explicitement **suppressé** avant d'atteindre notifications et remédiations : `status change ${oldStatus} → ${newStatus} suppressed (in maintenance)`.

## Jobs planifiés

`maintenanceService.startJobs()` (appelé au démarrage serveur) lance deux timers :

| Job | Intervalle | Rôle |
|---|---|---|
| `cleanupExpiredOneTime` | 5 min | Supprime les fenêtres `one_time` dont `end_at` date de plus de 30 jours (conservées 30 j pour consultation historique) |
| `checkMaintenanceTransitions` | 60 s | Vide le cache et envoie les notifications de début/fin de fenêtre, en dédupliquant via `last_notified_start_at`/`last_notified_end_at` |

`_sendMaintenanceNotification` réutilise le registre de plugins de notification (`getPlugin(ch.type)`) avec un payload synthétique (`oldStatus`/`newStatus` = `up`/`maintenance`), y compris la résolution SMTP par serveur externe (`smtpServer.service`).

## Endpoints

`server/src/routes/maintenance.routes.ts` — tous protégés par `requireAuth` + `requireRole('admin')` :

| Méthode | Route | Description |
|---|---|---|
| GET / POST | `/api/maintenance` | Liste (filtrable par `scopeType`/`scopeId`) / création |
| GET | `/api/maintenance/effective/:type/:id` | Fenêtres effectives pour un scope (avec métadonnées `source`, `isDisabledHere`, `canDisable`…) |
| POST | `/api/maintenance/:id/disable` | Désactive une fenêtre héritée pour ce scope |
| DELETE | `/api/maintenance/:id/disable` | Réactive |
| GET / PUT / DELETE | `/api/maintenance/:id` | CRUD standard |

Note : les routes nommées (`/effective/:type/:id`, `/:id/disable`) sont déclarées **avant** les routes génériques `/:id` pour éviter les conflits de paramètres Express.

## AdminMaintenancePage

`client/src/pages/AdminMaintenancePage.tsx` construit la liste des scopes possibles (moniteurs, agents, groupes) et affiche par entité les fenêtres effectives avec leur origine (`local` / `group` / `global`) et les actions disponibles (`canEdit`, `canDelete`, `canDisable`, `canEnable`) retournées par `getEffectiveWindows`.

## Références

- `server/src/services/maintenance.service.ts`
- `server/src/db/migrations/034_maintenance_windows.ts`
- `server/src/db/migrations/035_heartbeats_in_maintenance.ts`
- `server/src/db/migrations/036_maintenance_global_scope.ts`
- `server/src/db/migrations/037_maintenance_window_disables.ts`
- `server/src/workers/BaseMonitorWorker.ts`
- `server/src/routes/maintenance.routes.ts`
- `client/src/pages/AdminMaintenancePage.tsx`
- `client/src/components/monitors/HeartbeatBar.tsx`
