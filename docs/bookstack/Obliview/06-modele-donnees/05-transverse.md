Cette page couvre les tables qui traversent tout le modèle métier sans appartenir à un domaine unique : notifications, maintenance, remédiation, équipes/RBAC, alertes temps réel et fédération SSO. Toutes partagent un même pattern d'héritage par portée (`scope` + `scope_id` ∈ `global`/`group`/`monitor`, parfois `agent`) initialement conçu pour les notifications (`007_create_notifications.ts`) puis réutilisé tel quel pour les remédiations et la maintenance.

## Notifications

`007_create_notifications.ts` pose trois tables :

```sql
CREATE TABLE notification_channels (
  id serial PRIMARY KEY,
  name varchar(255) NOT NULL,
  type varchar(50) NOT NULL,       -- 'webhook', 'discord', ... (10 plugins)
  config jsonb NOT NULL DEFAULT '{}',
  is_enabled boolean NOT NULL DEFAULT true,
  created_by integer REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE notification_bindings (
  id serial PRIMARY KEY,
  channel_id integer REFERENCES notification_channels(id) ON DELETE CASCADE,
  scope varchar(20) NOT NULL,          -- 'global' | 'group' | 'monitor'
  scope_id integer,                    -- null pour global
  override_mode varchar(10) NOT NULL DEFAULT 'merge',  -- 'merge' | 'replace'
  UNIQUE (channel_id, scope, scope_id)
);

CREATE TABLE notification_log (
  id serial PRIMARY KEY,
  channel_id integer REFERENCES notification_channels(id) ON DELETE CASCADE,
  monitor_id integer REFERENCES monitors(id) ON DELETE SET NULL,
  event_type varchar(50) NOT NULL,     -- 'status_change' | 'test'
  success boolean NOT NULL,
  message text, error text,
  created_at timestamp DEFAULT now()
);
```

`monitor_groups.group_notifications` (012) active la remontée des notifications des enfants vers le groupe. `notification_channels.uuid` (023) sert à l'import/export. `notification_channel_tenants` (041) est une table de partage explicite : un canal peut être exposé à plusieurs tenants (`(channel_id, tenant_id)` clé composite), utile pour les canaux définis au niveau plateforme mais visibles depuis plusieurs espaces de travail.

Le debounce de notification est implémenté en mémoire côté worker (`BaseMonitorWorker.handleStatusChange()`), la persistance de la config de cooldown se répartit entre `agent_devices.notification_cooldown_seconds` (device), `monitor_groups.agent_group_config` (chaîne de groupes) et un défaut de 300s.

## Maintenance windows

`034_maintenance_windows.ts` :

```sql
CREATE TABLE maintenance_windows (
  id serial PRIMARY KEY,
  name varchar(255) NOT NULL,
  scope_type varchar(20) NOT NULL,      -- 'group' | 'monitor' | 'agent' | 'global' (036)
  scope_id integer,                     -- NULL uniquement si scope_type='global' (contrainte CHECK ajoutée en 036)
  is_override boolean NOT NULL DEFAULT false,
  schedule_type varchar(20) NOT NULL,   -- 'one_time' | 'recurring'
  start_at timestamptz, end_at timestamptz,             -- one_time
  start_time varchar(5), end_time varchar(5),            -- recurring, 'HH:MM'
  recurrence_type varchar(20),          -- 'daily' | 'weekly'
  days_of_week integer[],               -- 0=lundi … 6=dimanche
  timezone varchar(100) NOT NULL DEFAULT 'UTC',
  notify_channel_ids integer[] NOT NULL DEFAULT '{}',
  last_notified_start_at timestamptz, last_notified_end_at timestamptz,
  active boolean NOT NULL DEFAULT true
);
```

La migration `036_maintenance_global_scope.ts` ajoute une contrainte `CHECK` explicite : `scope_id` doit être `NULL` si et seulement si `scope_type = 'global'`. `037_maintenance_window_disables.ts` ajoute `maintenance_window_disables` — table d'opt-out permettant à un scope enfant (groupe/monitor/agent) de se désinscrire explicitement d'une fenêtre héritée d'un ancêtre (`UNIQUE(window_id, scope_type, scope_id)`). Les heartbeats produits pendant une fenêtre active sont marqués `heartbeats.in_maintenance = true` (035) et affichés en bleu côté UI.

## Remédiation

`024_create_remediations.ts` reprend le même schéma à trois tables que les notifications, avec en plus la notion de déclencheur et de cooldown :

```sql
CREATE TABLE remediation_actions (
  id serial PRIMARY KEY,
  name varchar(100) NOT NULL,
  type varchar(30) NOT NULL,    -- webhook | n8n | script | docker_restart | ssh
  config jsonb NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE remediation_bindings (
  id serial PRIMARY KEY,
  action_id integer REFERENCES remediation_actions(id) ON DELETE CASCADE,
  scope varchar(20) NOT NULL,               -- global | group | monitor
  scope_id integer,
  override_mode varchar(20) NOT NULL DEFAULT 'merge',  -- merge | replace | exclude
  trigger_on varchar(20) NOT NULL DEFAULT 'down',       -- down | up | both
  cooldown_seconds integer NOT NULL DEFAULT 300,
  UNIQUE (action_id, scope, scope_id)
);

CREATE TABLE remediation_runs (
  id serial PRIMARY KEY,
  action_id integer REFERENCES remediation_actions(id) ON DELETE CASCADE,
  monitor_id integer NOT NULL,
  triggered_by varchar(10) NOT NULL,        -- down | up
  status varchar(20) NOT NULL,              -- success | failed | timeout | cooldown_skip
  output text, error text, duration_ms integer,
  triggered_at timestamptz DEFAULT now()
);
```

`remediation_actions.uuid` est ajoutée en 027 pour l'import/export (même pattern que 023).

## Teams / RBAC

`013_create_teams.ts` remplace l'ancien `user_group_assignments` (visibilité binaire par utilisateur, hérité de `005_create_groups.ts`) par un modèle d'équipes :

```sql
CREATE TABLE user_teams (
  id serial PRIMARY KEY,
  name varchar(255) NOT NULL UNIQUE,
  description text,
  can_create boolean NOT NULL DEFAULT false
);

CREATE TABLE team_memberships (
  team_id integer REFERENCES user_teams(id) ON DELETE CASCADE,
  user_id integer REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE team_permissions (
  id serial PRIMARY KEY,
  team_id integer REFERENCES user_teams(id) ON DELETE CASCADE,
  scope varchar(20) NOT NULL,     -- 'group' | 'monitor'
  scope_id integer NOT NULL,
  level varchar(5) NOT NULL,      -- 'ro' | 'rw'
  UNIQUE (team_id, scope, scope_id)
);
```

Évolutions : `user_teams.uuid` (023, import/export) ; `user_teams.is_global` + table junction `team_tenant_scopes(team_id, tenant_id)` (047_global_teams) — une équipe globale (créée dans le tenant par défaut) peut recevoir des permissions sur des groupes/monitors d'autres tenants, affichée avec le badge « Global » (`#D3AB52`) dans `AdminUsersPage` ; `team_permissions.capabilities` (jsonb, 048_team_capabilities) permet des permissions granulaires au-delà du binaire `ro`/`rw`.

`049_permission_sets.ts` introduit un référentiel de rôles nommés, réutilisable par `user_tenants.role` :

```sql
CREATE TABLE permission_sets (
  id serial PRIMARY KEY,
  name varchar(64) NOT NULL,
  slug varchar(64) NOT NULL UNIQUE,
  capabilities jsonb NOT NULL DEFAULT '[]',
  is_default boolean NOT NULL DEFAULT false
);
```

Seedé avec trois rôles par défaut : `admin` (toutes les capacités dont `users.manage`), `user` (`monitoring`, `monitors.manage`, `groups.manage`), `viewer` (`monitoring` seul). C'est ce référentiel qui justifie l'élargissement de `user_tenants.role` de `varchar(16)` à `varchar(64)` en 053.

## SSO — historique mesh et intégration Obligate

Les tables `sso_tokens` (créée en `044_sso_foreign_users.ts`, avec `users.foreign_source`/`foreign_id`/`foreign_source_url`), `sso_link_tokens` (045) et `sso_foreign_users` (046, table de jointure N:1 `foreign_source`+`foreign_user_id` → `local_user_id`) proviennent de l'ancienne fédération SSO « mesh » entre apps Obli* (`sso.routes.ts`, `ForeignAuthPage`, `obliguard/oblimap/obliance.routes.ts` — **supprimés** du code, cf. CLAUDE.md Phase 20). Le SSO passe désormais intégralement par la gateway Obligate (`server/src/services/obligate.service.ts`, `server/src/routes/obligateCallback.routes.ts`), mais les colonnes et tables `foreign_*`/`sso_foreign_users` restent utilisées en base pour représenter le lien compte-local ↔ identité-fédérée (voir usages dans `auth.service.ts`, `user.service.ts`, `enrollment.controller.ts`). Les utilisateurs SSO ont un username préfixé `og_` (affiché sans préfixe dans l'UI), `enrollment_version: 999` pour sauter l'assistant, et le champ `password_hash` nullable posé en 044 leur permet de ne pas avoir de mot de passe local.

## Alertes temps réel

`040_live_alerts.ts` :

```sql
CREATE TABLE live_alerts (
  id serial PRIMARY KEY,
  tenant_id integer REFERENCES tenants(id) ON DELETE CASCADE,
  severity varchar(16) NOT NULL,     -- down | up | warning | info
  title text NOT NULL, message text NOT NULL,
  navigate_to text,
  stable_key text,                   -- dédup : ignoré si non-lu + même (tenant_id, stable_key)
  read_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX live_alerts_tenant_created ON live_alerts(tenant_id, created_at DESC);
CREATE INDEX live_alerts_stable_key ON live_alerts(tenant_id, stable_key) WHERE stable_key IS NOT NULL;
```

Émises via Socket.io par `liveAlert.service.ts`, avec agrégation cross-tenant côté application desktop ObliTools (tab-bar, badges non-lus, sons de notification synthétisés par type d'événement : `probe_down`, `probe_up`, `agent_alert`, `agent_fixed`).

## Configuration transverse (SMTP / app_config)

- `smtp_servers` (029) : serveurs SMTP nommés (`host`, `port`, `secure`, `username`, `password`, `from_address`) ; `tenant_id` nullable ajouté en 039 (`NULL` = SMTP plateforme réservé au 2FA/reset password, non-`NULL` = scope tenant pour les canaux de notification email).
- `app_config` (030) : table clé/valeur (`key` varchar en primary key, `value` text) seedée avec `allow_2fa`, `force_2fa`, `otp_smtp_server_id`.

## Références

- `server/src/db/migrations/007_create_notifications.ts`, `012_add_group_notifications.ts`, `041_notification_channel_tenants.ts`
- `server/src/db/migrations/034_maintenance_windows.ts`, `035_heartbeats_in_maintenance.ts`, `036_maintenance_global_scope.ts`, `037_maintenance_window_disables.ts`
- `server/src/db/migrations/024_create_remediations.ts`, `027_remediation_action_uuid.ts`
- `server/src/db/migrations/013_create_teams.ts`, `047_global_teams.ts`, `048_team_capabilities.ts`, `049_permission_sets.ts`, `053_user_tenants_role_varchar.ts`
- `server/src/db/migrations/044_sso_foreign_users.ts`, `045_sso_link_tokens.ts`, `046_sso_foreign_users.ts`
- `server/src/db/migrations/040_live_alerts.ts`, `029_smtp_servers.ts`, `030_app_config.ts`
- `server/src/services/maintenance.service.ts`, `liveAlert.service.ts`, `obligate.service.ts`
- `server/src/routes/obligateCallback.routes.ts`
- `client/src/pages/AdminMaintenancePage.tsx`, `AdminUsersPage.tsx`
- `obli.tools/main.go`
