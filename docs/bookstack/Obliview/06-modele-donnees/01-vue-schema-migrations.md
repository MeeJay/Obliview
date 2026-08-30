Le schéma PostgreSQL d'Obliview est entièrement piloté par des migrations Knex écrites en TypeScript, situées dans `server/src/db/migrations/`. Chaque fichier exporte deux fonctions `up()`/`down()` et porte un préfixe numérique à trois chiffres qui fixe l'ordre d'exécution (`001_create_users.ts` → `054_drop_group_kind.ts`). Le fichier `server/src/db/knexfile.ts` charge `env.ts` en premier (dotenv) puis expose la config de connexion utilisée par la CLI `knex migrate:latest`.

## Convention de nommage

- Préfixe `NNN_` (3 chiffres, zéro-paddé) suivi d'un nom en `snake_case` décrivant l'intention (`agent_thresholds`, `maintenance_global_scope`, `drop_group_kind`).
- Une migration = une intention fonctionnelle, pas nécessairement une seule table : `005_create_groups.ts` crée à la fois `monitor_groups`, la closure table `group_closure` et `user_group_assignments` en une seule passe transactionnelle logique.
- Les migrations additives sur enum PostgreSQL (`monitor_type`, `monitor_status`) utilisent `ALTER TYPE ... ADD VALUE IF NOT EXISTS`, avec un commentaire explicite rappelant que PostgreSQL ne permet pas de retirer une valeur d'enum — le `down()` de ces migrations est donc un no-op assumé.
- Certaines paires de numéros sont dupliquées (`040_agent_updating.ts` / `040_live_alerts.ts`, `047_global_teams.ts` / `047_user_avatar.ts`, `048_agent_notification_cooldown.ts` / `048_team_capabilities.ts`) : elles ont été committées en parallèle sur des branches différentes puis fusionnées. Knex les exécute par ordre alphabétique de nom de fichier au sein d'un même préfixe, ce qui est sans risque ici car elles touchent des tables disjointes.

## Regroupement par étapes (Phases du CLAUDE.md)

| Plage | Thème | Fichiers clés |
|---|---|---|
| 001-004 | Cœur : utilisateurs, sessions, monitors, heartbeats | `001_create_users.ts`, `002_create_sessions.ts`, `003_create_monitors.ts`, `004_create_heartbeats.ts` |
| 005-007 | Groupes hiérarchiques, settings, notifications | `005_create_groups.ts` (closure table), `006_create_settings.ts`, `007_create_notifications.ts` |
| 008-012 | Ajustements monitors/heartbeats + types Browser/ValueWatcher | `008_add_ignore_ssl.ts`, `009_add_heartbeat_retrying.ts`, `010_add_browser_and_value_watcher.ts`, `011_add_heartbeat_value.ts`, `012_add_group_notifications.ts` |
| 013-022 | Teams RBAC + fondations agent | `013_create_teams.ts`, `014_agent_api_keys.ts`, `015_agent_devices.ts`, `016_agent_monitors.ts`, `017_group_kind.ts`, `018_agent_thresholds.ts`, `019_agent_device_extras.ts`, `020_monitor_status_alert_inactive.ts`, `021_agent_group_config.ts`, `022_monitor_status_ssl_values.ts` |
| 023-037 | Fonctionnalités : export UUID, remédiation, 2FA, maintenance | `023_add_export_uuids.ts`, `024_create_remediations.ts`, `025_agent_sensor_display_names.ts`, `026_agent_settings_override.ts`, `027_remediation_action_uuid.ts`, `028_user_preferences.ts`, `029_smtp_servers.ts`, `030_app_config.ts`, `031_users_2fa.ts`, `032_agent_display_config.ts`, `033_agent_pending_command.ts`, `034_maintenance_windows.ts`, `035_heartbeats_in_maintenance.ts`, `036_maintenance_global_scope.ts`, `037_maintenance_window_disables.ts` |
| 038 | Enrollment + langue | `038_enrollment_and_language.ts` (`preferred_language`, `enrollment_version`, `password_reset_tokens`) |
| 039-043 | Multi-tenancy | `039_tenants.ts`, `040_live_alerts.ts`, `040_agent_updating.ts`, `041_notification_channel_tenants.ts`, `042_agent_notification_types.ts`, `043_groups_slug_unique_per_tenant.ts` |
| 044-046 | SSO (historique fédération mesh, désormais relayé par Obligate) | `044_sso_foreign_users.ts` (colonnes `foreign_source`/`foreign_id` + `sso_tokens`), `045_sso_link_tokens.ts`, `046_sso_foreign_users.ts` (table `sso_foreign_users`, N:1) |
| 047-049 | Global teams + RBAC granulaire | `047_global_teams.ts` (`is_global`, `team_tenant_scopes`), `047_user_avatar.ts`, `048_team_capabilities.ts`, `048_agent_notification_cooldown.ts`, `049_permission_sets.ts` |
| 050-054 | Notes, proxy agent, ajustements post-hoc | `050_monitor_agent_notes.ts`, `051_proxy_agent_device.ts`, `052_agent_device_type.ts`, `053_user_tenants_role_varchar.ts`, `054_drop_group_kind.ts` |

Le compteur a dépassé les « 50 migrations » indiquées historiquement dans `CLAUDE.md` : au 2026-07-03 le dépôt en compte 54 (numérotation non strictement séquentielle à cause des doublons de préfixe évoqués plus haut).

## Exécution

```bash
cd server
npx knex migrate:latest --knexfile src/db/knexfile.ts
```

Le `shared/` package (types partagés `@obliview/shared`) doit être compilé (`cd shared && npx tsc`) avant de lancer le serveur, mais les migrations elles-mêmes ne dépendent que de `knex` et de la config PostgreSQL (`192.168.1.1:5432`, db `betterkuma`).

## Types PostgreSQL personnalisés

Deux enums structurent la base :

```sql
CREATE TYPE monitor_type AS ENUM (
  'http', 'ping', 'tcp', 'dns', 'ssl', 'smtp',
  'docker', 'game_server', 'push', 'script', 'json_api'
  -- + 'browser', 'value_watcher' (010), 'agent' (016)
);

CREATE TYPE monitor_status AS ENUM (
  'up', 'down', 'pending', 'maintenance', 'paused'
  -- + 'ssl_expired', 'ssl_warning' (022)
  -- + 'alert', 'inactive' (020)
);
```

Chaque ajout de statut/type est documenté dans le commentaire d'en-tête du fichier de migration correspondant, avec la justification métier (ex. `alert` = dépassement de seuil agent, `inactive` = agent hors-ligne avec `heartbeat_monitoring=false`).

## Références

- `server/src/db/migrations/001_create_users.ts` à `054_drop_group_kind.ts`
- `server/src/db/knexfile.ts`
- `server/src/env.ts`
- `CLAUDE.md` (section « Database Migrations (50 total) »)
