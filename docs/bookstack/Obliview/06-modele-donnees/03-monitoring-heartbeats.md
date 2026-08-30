La table `monitors` est volontairement large et plate : plutôt que du single-table-inheritance avec des tables filles par type, Obliview stocke toutes les colonnes spécifiques aux 13 types de moniteurs directement sur `monitors`, nullable, et chaque `BaseMonitorWorker` dérivé ne lit que les colonnes de son domaine. Ce choix évite les jointures au prix d'une table large ; il est cohérent avec le modèle de configuration à héritage (settings résolues par scope group/monitor).

## `monitors` — colonnes communes

Posées par `003_create_monitors.ts` :

| Colonne | Type | Rôle |
|---|---|---|
| `id`, `name`, `description` | — | `description` sert aussi de champ « notes » affiché en bannière sur `MonitorCard`/`MonitorCardTile`. |
| `type` | enum `monitor_type` | Voir liste ci-dessous. |
| `group_id` | FK `monitor_groups` | `ON DELETE SET NULL`. |
| `is_active`, `status` | bool / enum `monitor_status` | `status` par défaut `pending`. |
| `interval_seconds`, `retry_interval_seconds`, `max_retries`, `timeout_ms` | int nullable | `NULL` = hérite du groupe/global via la résolution de settings. |
| `upside_down` | bool | Inverse la sémantique up/down (ex. surveiller qu'un service est bien *down*). |
| `created_by` | FK `users` | `ON DELETE SET NULL`. |
| `uuid` | uuid | Ajoutée en 023, clé stable pour import/export. |
| `tenant_id` | FK `tenants` | Ajoutée en 039. |

## Les 13 types et leurs colonnes dédiées

| Type (`monitor_type`) | Colonnes spécifiques | Migration d'origine |
|---|---|---|
| `http` / `json_api` | `url`, `method`, `headers` (jsonb), `body`, `expected_status_codes` (int[]), `keyword`, `keyword_is_present`, `json_path`, `json_expected_value`, `ignore_ssl` | 003, `ignore_ssl` ajoutée en 008 |
| `ping` / `tcp` | `hostname`, `port` | 003 |
| `dns` | `dns_record_type`, `dns_resolver`, `dns_expected_value` | 003 |
| `ssl` | `hostname`, `port`, `ssl_warn_days` (défaut 30) | 003 |
| `smtp` | `smtp_host`, `smtp_port` (défaut 25) | 003 |
| `docker` | `docker_host`, `docker_container_name` | 003 |
| `game_server` | `game_type`, `game_host`, `game_port` (via gamedig) | 003 |
| `push` | `push_token` (unique), `push_max_interval_sec` (défaut 300) | 003 |
| `script` | `script_command`, `script_expected_exit` (défaut 0) | 003 |
| `browser` | `browser_url`, `browser_keyword`, `browser_keyword_is_present`, `browser_wait_for_selector`, `browser_screenshot_on_failure` | 010 (Playwright) |
| `value_watcher` | `value_watcher_url`, `value_watcher_json_path`, `value_watcher_operator`, `value_watcher_threshold`, `value_watcher_threshold_max`, `value_watcher_previous_value`, `value_watcher_headers` (jsonb) | 010 |
| `agent` | `agent_device_id` (FK `agent_devices`), `agent_metric`, `agent_mount`, `agent_threshold`, `agent_threshold_op` (colonnes legacy, remplacées par `agent_thresholds` jsonb en 018) | 016, 018 |

Le type `agent` fait de `monitors` un pont vers le système d'agent : un monitor de ce type surveille une métrique précise (`cpu_percent`, `memory_percent`, `disk_percent`, `network_in_bytes`, `network_out_bytes`, `load_avg`) d'un `agent_devices`. Les colonnes historiques `agent_metric`/`agent_mount`/`agent_threshold`/`agent_threshold_op` (016) sont conservées en base mais remplacées par la colonne unique `agent_thresholds` (jsonb, 018) qui porte l'ensemble des seuils.

`monitors.proxy_agent_device_id` (051) permet à un moniteur d'être exécuté « via » un agent-proxy (device de type `proxy`, stub Node.js + Playwright) plutôt que directement par le worker central — utile pour sonder des réseaux internes non accessibles depuis le serveur.

## Statuts (`monitor_status`)

L'enum de base (003) : `up`, `down`, `pending`, `maintenance`, `paused`. Étendu ensuite :

- `alert`, `inactive` (020) — spécifiques aux moniteurs `agent` : `alert` = dépassement de seuil, `inactive` = agent hors-ligne avec `heartbeat_monitoring=false` (pas de notification, gris dans l'UI).
- `ssl_expired`, `ssl_warning` (022) — produits par `HttpMonitorWorker`, `SslMonitorWorker`, `JsonApiMonitorWorker`.

PostgreSQL ne permettant pas de retirer une valeur d'un type enum, tous les `down()` de ces migrations sont des no-op documentés.

## `heartbeats`

Table d'événements en écriture append-only, créée par `004_create_heartbeats.ts` :

```sql
CREATE TABLE heartbeats (
  id bigserial PRIMARY KEY,
  monitor_id integer REFERENCES monitors(id) ON DELETE CASCADE,
  status monitor_status NOT NULL,
  response_time integer,      -- ms
  status_code integer,
  message text,
  ping float,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_heartbeats_monitor_time ON heartbeats(monitor_id, created_at DESC);
```

Colonnes ajoutées ensuite :

| Colonne | Migration | Rôle |
|---|---|---|
| `is_retrying` | 009 | Marque un heartbeat produit pendant la phase de retry (avant `max_retries` atteint). |
| `value` (text) | 011 | Valeur brute capturée — utilisée notamment par les moniteurs `value_watcher` et pour stocker la valeur d'expiration de certificat SSL des moniteurs `ssl`/`http`. |
| `in_maintenance` | 035 | Marque les heartbeats produits pendant une fenêtre de maintenance active (affichés en bleu côté UI). Index partiel `idx_hb_in_maintenance WHERE in_maintenance = TRUE`. |

## Tables dérivées

- `heartbeat_stats` (004) : agrégats pré-calculés par période (`1h`, `24h`, `7d`, `30d`, `365d`) — `uptime_pct`, `avg_response`, `max_response`, `min_response`, `total_checks/up/down`, contrainte unique `(monitor_id, period)`.
- `incidents` (004) : transitions de statut avec `previous_status`/`new_status`, `started_at`/`resolved_at`, `duration_sec`. Index `idx_incidents_monitor` sur `(monitor_id, started_at DESC)`.

## Références

- `server/src/db/migrations/003_create_monitors.ts`
- `server/src/db/migrations/004_create_heartbeats.ts`
- `server/src/db/migrations/008_add_ignore_ssl.ts`, `009_add_heartbeat_retrying.ts`, `010_add_browser_and_value_watcher.ts`, `011_add_heartbeat_value.ts`
- `server/src/db/migrations/016_agent_monitors.ts`, `018_agent_thresholds.ts`
- `server/src/db/migrations/020_monitor_status_alert_inactive.ts`, `022_monitor_status_ssl_values.ts`
- `server/src/db/migrations/035_heartbeats_in_maintenance.ts`, `051_proxy_agent_device.ts`
- `server/src/types/gamedig.d.ts`
- `client/src/components/monitors/MonitorCard.tsx`, `client/src/components/dashboard/MonitorCardTile.tsx`
