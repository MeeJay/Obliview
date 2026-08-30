Le cœur relationnel d'Obliview repose sur quatre familles de tables : l'authentification locale (`users`, `session`), le multi-tenant (`tenants`, `user_tenants`), et la hiérarchie de groupes via closure table (`monitor_groups`, `group_closure`). Ces tables sont posées dès `001_create_users.ts`/`002_create_sessions.ts`/`005_create_groups.ts` puis enrichies au fil des phases (2FA, préférences, SSO, multi-tenancy).

## `users`

Table de base créée par `001_create_users.ts`, enrichie par la suite :

| Colonne | Origine | Rôle |
|---|---|---|
| `id`, `username`, `password_hash`, `display_name`, `role`, `is_active` | 001 | Cœur auth. `role` = rôle plateforme legacy (`admin`/`user`), distinct du rôle par tenant. |
| `email`, `totp_secret`, `totp_enabled`, `email_otp_enabled` | 031 | 2FA (TOTP + OTP email). |
| `preferences` (jsonb) | 028 | Thème, langue, toasts — synchronisées depuis Obligate pour les utilisateurs SSO. |
| `preferred_language`, `enrollment_version` | 038 | i18n + suivi de l'assistant d'enrôlement (SSO = `enrollment_version: 999` pour le sauter). |
| `avatar` (text) | 047_user_avatar | Avatar utilisateur encodé. |
| `foreign_source`, `foreign_id`, `foreign_source_url` | 044 | Legacy mesh SSO — `password_hash` devient `nullable().alter()` pour les comptes purement fédérés. |

`password_reset_tokens` (038) référence `users.id` avec `token_hash` unique et expiration — utilisé par le flux de réinitialisation par e-mail.

## Sessions

`session` (002) est gérée par `connect-pg-simple` mais tracée dans les migrations pour cohérence du schéma :

```ts
table.string('sid').primary();
table.json('sess').notNullable();
table.timestamp('expire', { useTz: true }).notNullable();
```

Index `idx_session_expire` sur `expire` pour le garbage collector de sessions expirées.

## Multi-tenancy — `tenants` / `user_tenants`

Introduit en phase 13 (`039_tenants.ts`) :

```sql
CREATE TABLE tenants (
  id serial PRIMARY KEY,
  name varchar(128) NOT NULL,
  slug varchar(64) NOT NULL UNIQUE,
  ...
);

CREATE TABLE user_tenants (
  user_id integer REFERENCES users(id) ON DELETE CASCADE,
  tenant_id integer REFERENCES tenants(id) ON DELETE CASCADE,
  role varchar(64) NOT NULL DEFAULT 'user',
  PRIMARY KEY (user_id, tenant_id)
);
```

- Un tenant `Default`/`default` (id=1) est seedé automatiquement ; tous les utilisateurs existants y sont rattachés (`admin` si `users.role='admin'`, sinon `member` à l'origine).
- `role` était à l'origine `varchar(16)` avec deux valeurs (`admin`/`member`) ; la migration `053_user_tenants_role_varchar.ts` l'élargit à `varchar(64)` pour porter n'importe quel slug de `permission_sets` (voir page « Transverse »), avec backfill `member → user`.
- Toutes les tables métier reçoivent une colonne `tenant_id NOT NULL DEFAULT 1` FK `ON DELETE CASCADE` dans la même migration 039 : `monitors`, `monitor_groups`, `settings`, `notification_channels`, `user_teams`, `agent_api_keys`, `agent_devices`, `remediation_actions`, `maintenance_windows`. `smtp_servers` reçoit un `tenant_id` **nullable** (NULL = SMTP plateforme utilisé pour 2FA/reset password, non-NULL = SMTP scoping un tenant pour ses canaux de notification).
- Le switch de tenant côté client (`tenantStore.setCurrentTenant()`) déclenche un `window.location.reload()` après `POST /tenant/switch`.

## Groupes hiérarchiques — closure table

`005_create_groups.ts` pose le modèle définitif :

```sql
CREATE TABLE monitor_groups (
  id serial PRIMARY KEY,
  name varchar(255) NOT NULL,
  slug varchar(255) NOT NULL UNIQUE,   -- devient UNIQUE(slug, tenant_id) en 043
  description text,
  parent_id integer REFERENCES monitor_groups(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  is_general boolean NOT NULL DEFAULT false
);

CREATE TABLE group_closure (
  ancestor_id integer REFERENCES monitor_groups(id) ON DELETE CASCADE,
  descendant_id integer REFERENCES monitor_groups(id) ON DELETE CASCADE,
  depth integer NOT NULL,
  PRIMARY KEY (ancestor_id, descendant_id)
);
```

Le pattern closure table permet des requêtes d'ascendance/descendance en O(1) jointure (pas de CTE récursive) : pour tous les descendants d'un groupe, `SELECT descendant_id FROM group_closure WHERE ancestor_id = ?`. Chaque groupe est son propre ancêtre à `depth=0` (ligne auto-réflexive insérée à la création).

Colonnes ajoutées ensuite à `monitor_groups` :

| Colonne | Migration | Usage |
|---|---|---|
| `group_notifications` (bool) | 012 | Active la remontée des notifications enfants vers ce groupe. |
| `kind` (varchar) | 017, **supprimée en 054** | À l'origine distinguait groupe « monitor » vs « agent » ; les groupes sont désormais hybrides (un groupe peut contenir monitors et agents simultanément), la colonne devenue inerte a été droppée. |
| `agent_thresholds` (jsonb) | 018 | Seuils par défaut appliqués aux devices approuvés dans ce groupe. |
| `agent_group_config` (jsonb) | 021 | Config par défaut : intervalle de push, `heartbeatMonitoring`, `maxMissedPushes`, cooldown de notification. |
| `uuid` | 023 | Identifiant stable pour import/export. |
| `tenant_id` | 039 | Scoping multi-tenant. |

`user_group_assignments` (visibilité par utilisateur, créée en 005) est **supprimée en `013_create_teams.ts`** au profit du modèle RBAC par équipe (`user_teams` / `team_memberships` / `team_permissions`, voir page « Transverse »).

## Requête type : résoudre les descendants visibles d'un groupe

```sql
SELECT m.*
FROM monitors m
JOIN group_closure gc ON gc.descendant_id = m.group_id
WHERE gc.ancestor_id = :groupId
  AND m.tenant_id = :tenantId;
```

## Références

- `server/src/db/migrations/001_create_users.ts`
- `server/src/db/migrations/002_create_sessions.ts`
- `server/src/db/migrations/005_create_groups.ts`
- `server/src/db/migrations/012_add_group_notifications.ts`
- `server/src/db/migrations/017_group_kind.ts`, `054_drop_group_kind.ts`
- `server/src/db/migrations/018_agent_thresholds.ts`, `021_agent_group_config.ts`
- `server/src/db/migrations/023_add_export_uuids.ts`
- `server/src/db/migrations/028_user_preferences.ts`, `031_users_2fa.ts`, `038_enrollment_and_language.ts`, `047_user_avatar.ts`
- `server/src/db/migrations/039_tenants.ts`, `043_groups_slug_unique_per_tenant.ts`, `053_user_tenants_role_varchar.ts`
- `client/src/pages/AdminTenantsPage.tsx`
- `server/src/services/tenant.service.ts`
