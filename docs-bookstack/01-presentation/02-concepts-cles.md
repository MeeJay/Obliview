Cette page définit le vocabulaire utilisé dans le reste de la documentation Obliview. Chaque terme renvoie aux tables PostgreSQL et fichiers de service qui l'implémentent réellement, pour éviter toute ambiguïté entre le nom fonctionnel et le nom technique.

## Tenant

Unité d'isolation multi-client. Table `tenants` (`id`, `name`, `slug`), avec jonction `user_tenants` (`user_id`, `tenant_id`, `role` — `admin` ou `member`). Introduit en migration `039_tenants.ts`. Toutes les tables métier (`monitors`, `monitor_groups`, `settings`, `notification_channels`, `user_teams`, `agent_api_keys`, `agent_devices`, `remediation_actions`, `maintenance_windows`) portent une colonne `tenant_id NOT NULL DEFAULT 1`.

Le tenant d'`id = 1` (slug `default`) est le **tenant maître** (`MASTER_TENANT_ID` dans `shared/src/tenants.ts`, testé via `isMasterTenant()`). Il sert de vue globale (« God View ») pour les administrateurs plateforme, notamment pour les endpoints qui agrègent plusieurs tenants (`requireMasterTenant()` dans `server/src/middleware/rbac.ts`).

Le changement de tenant actif se fait via `POST /tenant/switch`, suivi d'un rechargement complet de page côté client (`tenantStore.setCurrentTenant()`).

## Groupe (monitor group) et closure table

Un groupe (`monitor_groups`) organise des monitors en arborescence (`parent_id`). Les requêtes d'ascendance/descendance (« tous les monitors de ce groupe et de ses sous-groupes ») sont résolues via la table `group_closure` :

```sql
-- group_closure(ancestor_id, descendant_id, depth)
-- une ligne (g, g, 0) existe pour chaque groupe (réflexivité)
-- une ligne (a, d, n) existe pour chaque ancêtre a de d à distance n
```

Cette approche (closure table) évite les requêtes récursives coûteuses pour retrouver tous les descendants ou ancêtres d'un nœud. Un groupe marqué `is_general = true` est visible par tous les utilisateurs sans permission explicite (lecture seule minimum).

Les réglages (`settings`), les liaisons de notification (`notification_bindings`) et les liaisons de remédiation (`remediation_bindings`) utilisent la même logique de portée (`scope = 'global' | 'group' | 'monitor'`, `scope_id`) et un mode d'héritage `merge` ou `replace` par niveau.

## Monitor

Sonde de supervision. 14 types déclarés dans `shared/src/monitorTypes.ts` (`MONITOR_TYPES`) : `http`, `ping`, `tcp`, `dns`, `ssl`, `smtp`, `docker`, `game_server`, `push`, `script`, `json_api`, `browser`, `value_watcher`, `agent`. Chaque exécution produit un **heartbeat**.

États possibles (`MONITOR_STATUS`) : `up`, `down`, `pending`, `maintenance`, `paused`, `ssl_warning`, `ssl_expired`, `alert` (dépassement de seuil sur un monitor agent), `inactive` (agent hors ligne avec `heartbeat_monitoring=false`, gris, sans notification), `updating` (auto-mise à jour de l'agent en cours, bleu, non comptabilisé dans l'uptime).

## Heartbeat

Résultat horodaté d'une vérification, table `heartbeats` (`monitor_id`, `status`, `response_time`, `status_code`, `message`, `ping`, `created_at`), indexée sur `(monitor_id, created_at DESC)`. Des statistiques agrégées sont pré-calculées dans `heartbeat_stats` par période (`1h`, `24h`, `7d`, `30d`, `365d`). Chaque transition de statut produit un enregistrement dans `incidents` (`previous_status`, `new_status`, `duration_sec`).

## Agent device

Poste ou serveur supervisé par l'agent natif Go. Table `agent_devices` : `uuid` (identifiant matériel stable, généré à partir du BIOS/WMI Windows, IOKit macOS, DMI Linux — stable même après réinstallation), `hostname`, `os_info`, `agent_version`, `status` (`pending`/`approved`/`refused`), `check_interval_seconds`, `group_id` (rattachement à un groupe d'agents), `pending_command` (commande en attente, ex. `'uninstall'`), `uninstall_commanded_at`, `notes`. Un agent communique soit par push HTTP (`POST /api/agent/push`), soit via le canal WebSocket temps réel (`agentHub.service.ts`).

## Canal de notification & binding

Un **canal** (`notification_channels`) encapsule la configuration d'un plugin (`type` = `webhook`, `discord`, `slack`, `telegram`, `teams`, `pushover`, `gotify`, `ntfy`, `smtp`, `freemobile`) et son état (`is_enabled`). Un **binding** (`notification_bindings`) rattache un canal à une portée (`scope` = `global`/`group`/`monitor`, `scope_id`) avec un `override_mode` (`merge` ajoute aux canaux hérités, `replace` les remplace). Chaque envoi est journalisé dans `notification_log` (`event_type`, `success`, `error`).

## Remédiation

Action corrective automatique déclenchée par un changement d'état de monitor. Trois tables (`server/src/db/migrations/024_create_remediations.ts`) :

| Table | Rôle |
|---|---|
| `remediation_actions` | pool global d'actions (`type` : webhook, n8n, script, docker_restart, ssh) |
| `remediation_bindings` | portée (global/groupe/monitor), `override_mode` (merge/replace/exclude), `trigger_on` (down/up/both), `cooldown_seconds` |
| `remediation_runs` | journal d'exécution (`status` : success/failed/timeout/cooldown_skip, `duration_ms`) |

## Maintenance window

Fenêtre de suppression d'alertes, table `maintenance_windows`. Portée via `scope_type` (`group`/`monitor`/`agent`) + `scope_id`, avec `is_override` pour exclure un enfant d'une fenêtre héritée. Deux modes de planification (`schedule_type`) :

- `one_time` : `start_at` / `end_at` (timestamps).
- `recurring` : `start_time`/`end_time` (`HH:MM`), `recurrence_type` (`daily`/`weekly`), `days_of_week` (tableau d'entiers, 0=lundi).

Pendant une fenêtre active, les heartbeats sont marqués (cf. `035_heartbeats_in_maintenance.ts`) et affichés en bleu, sans déclencher de notification. Des notifications de début/fin optionnelles peuvent être envoyées (`notify_channel_ids`, avec déduplication via `last_notified_start_at`/`last_notified_end_at`).

## Live alert

Événement temps réel poussé aux clients connectés, table `live_alerts` (`tenant_id`, `severity` — `down`/`up`/`warning`/`info`, `title`, `message`, `navigate_to`, `stable_key`, `read_at`). La déduplication repose sur `stable_key` : une nouvelle alerte avec la même clé qu'une alerte non lue du même tenant est ignorée (index partiel `WHERE stable_key IS NOT NULL`). Émis en Socket.io et agrégé cross-tenant côté ObliTools pour les badges de notification.

## Références

- `shared/src/monitorTypes.ts` — `MONITOR_TYPES`, `MONITOR_STATUS`, `USER_ROLES`
- `shared/src/tenants.ts` — `MASTER_TENANT_ID`, `isMasterTenant`
- `server/src/db/migrations/005_create_groups.ts` — `monitor_groups`, `group_closure`
- `server/src/db/migrations/004_create_heartbeats.ts` — `heartbeats`, `heartbeat_stats`, `incidents`
- `server/src/db/migrations/007_create_notifications.ts` — `notification_channels`, `notification_bindings`, `notification_log`
- `server/src/db/migrations/024_create_remediations.ts` — `remediation_actions`, `remediation_bindings`, `remediation_runs`
- `server/src/db/migrations/034_maintenance_windows.ts` — `maintenance_windows`
- `server/src/db/migrations/040_live_alerts.ts` — `live_alerts`
- `server/src/db/migrations/015_agent_devices.ts` — `agent_devices`
- `server/src/db/migrations/039_tenants.ts` — `tenants`, `user_tenants`
- `server/src/services/agentHub.service.ts` — canal WebSocket agent
