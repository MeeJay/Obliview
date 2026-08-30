Le système d'agent (Go, cross-platform) s'appuie sur deux tables principales — `agent_api_keys` et `agent_devices` — posées en phase 9 (`014_agent_api_keys.ts`, `015_agent_devices.ts`) puis considérablement enrichies au fil des phases suivantes (seuils, config d'affichage, commandes serveur→agent, cooldown de notification, notes). Toutes les évolutions se font par `ALTER TABLE agent_devices` successifs plutôt que par nouvelles tables, ce qui en fait la table la plus « chargée en migrations » du projet.

## `agent_api_keys`

```sql
CREATE TABLE agent_api_keys (
  id serial PRIMARY KEY,
  name varchar(255) NOT NULL,
  key uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  last_used_at timestamp
);
```

Clé d'authentification que le binaire agent embarque à l'installation (MSI ou binaire natif) pour s'enregistrer auprès du serveur. `tenant_id` y est ajouté en 039 (scoping multi-tenant des clés).

## `agent_devices` — colonnes fondatrices (015)

| Colonne | Rôle |
|---|---|
| `uuid` (varchar 64, unique) | Identifiant matériel stable généré par l'agent (WMI/BIOS sur Windows, IOKit sur macOS, DMI sur Linux) — survit à une réinstallation. |
| `hostname`, `ip`, `os_info` (jsonb), `agent_version` | Métadonnées rapportées à chaque push. |
| `api_key_id` | FK `agent_api_keys`, `ON DELETE SET NULL`. |
| `status` (varchar) | `pending` / `approved` / `refused` (puis `suspended` ajouté sans contrainte enum, colonne varchar libre). |
| `check_interval_seconds` (défaut 60) | Intervalle renvoyé à l'agent dans chaque réponse de push. |
| `approved_by`, `approved_at` | Traçabilité de l'approbation admin. |
| `group_id` | FK `monitor_groups`, `ON DELETE SET NULL` — rattachement optionnel à un groupe agent. |

## Colonnes ajoutées ensuite (par ordre de migration)

| Colonne | Migration | Détail |
|---|---|---|
| `name`, `heartbeat_monitoring` | 019 | `name` = nom d'affichage custom (sinon hostname). `heartbeat_monitoring=false` → un agent hors-ligne passe en `inactive` (gris) sans notification — cas des postes qui s'éteignent volontairement. |
| `agent_max_missed_pushes` | 021 | Override par device du nombre de pushes manqués avant offline (défaut système/groupe = 2). |
| `sensor_display_names` (jsonb) | 025 | Map `sensorKey → libellé humain` (clé au format `"temp:<raw_label>"`), pour renommer les sondes de température cryptiques (`acpitz-acpi-0` → « Carte mère »). Voir `client/src/utils/sensorLabels.ts` (`prettifySensorLabel()`) pour la prettification automatique côté client en l'absence d'override. |
| `override_group_settings` (bool, défaut false) | 026 | Bascule explicite « Override group settings » : quand `false`, le device hérite de `checkIntervalSeconds`/`heartbeatMonitoring`/`maxMissedPushes` depuis `agent_group_config` du groupe parent. |
| `display_config` (jsonb) | 032 | Préférences d'affichage UI par device : cœurs masqués, vue groupée par thread, sondes masquées, disques renommés, graphiques combinés. `null` = tous les défauts s'appliquent. |
| `pending_command` (varchar 50), `uninstall_commanded_at` (timestamp) | 033 | Commande serveur→agent en file d'attente, livrée à la prochaine connexion WebSocket ou au prochain push HTTP (ex. `'uninstall'`). Le job de nettoyage supprime automatiquement le device si `uninstall_commanded_at < now() - 10 min` sans reconnexion. |
| `updating_since` (timestamptz) | 040_agent_updating | Posé quand l'agent signale une auto-mise-à-jour imminente ; nettoyé à la reconnexion ou par le job de cleanup après 10 min (mise à jour considérée en échec). |
| `notification_types` (jsonb) | 042 | Override par device des types de notification (`agent_down`/`agent_up`/`agent_alert`/`agent_fixed`) ; `null` = hérite de la chaîne de groupes. La config **groupe** équivalente vit dans `monitor_groups.agent_group_config` (pas de colonne dédiée). |
| `notification_cooldown_seconds` | 048_agent_notification_cooldown | Priorité de résolution : device > chaîne de groupes > défaut (300s). Alimente le debounce complet de `BaseMonitorWorker.handleStatusChange()`. |
| `notes` (text) | 050 | Notes libres, éditables en ligne sur `AgentDetailPage`, affichées en bannière sous les infos système. |
| `device_type` (varchar 16, défaut `'agent'`) | 052 | `'agent'` = binaire Go léger, `'proxy'` = stub Node.js + Playwright complet (voir `monitors.proxy_agent_device_id`, migration 051). |
| `tenant_id` | 039 | Scoping multi-tenant. |

## Seuils (`agent_thresholds`)

Colonne jsonb posée en 018 sur **`monitors`** (seuil effectif d'un monitor de type `agent`) et sur **`monitor_groups`** (défauts appliqués à l'approbation d'un device dans le groupe). Elle remplace les anciennes colonnes scalaires `agent_metric`/`agent_mount`/`agent_threshold`/`agent_threshold_op` de la migration 016 (conservées en base mais inertes). Hiérarchie de résolution documentée dans `CLAUDE.md` :

```
monitor.agent_thresholds → device.groupThresholds (agent_group_config) → DEFAULT_AGENT_THRESHOLDS
```

## Commandes et canal WebSocket

`pending_command` est le mécanisme de commande asynchrone serveur→agent : posé par un contrôleur admin, drainé soit au moment de la connexion WebSocket (`agentHub.service.ts`, canal `/api/agent/ws`), soit livré dans la prochaine réponse de push HTTP legacy (`/api/agent/push`). Le flux d'auto-mise-à-jour suit le même schéma : l'agent télécharge le nouveau binaire/MSI depuis `/api/agent/download/`, se réinstalle silencieusement, et le champ `updating_since` sert de garde-fou côté serveur.

## Références

- `server/src/db/migrations/014_agent_api_keys.ts`, `015_agent_devices.ts`
- `server/src/db/migrations/016_agent_monitors.ts`, `018_agent_thresholds.ts`, `019_agent_device_extras.ts`, `021_agent_group_config.ts`
- `server/src/db/migrations/025_agent_sensor_display_names.ts`, `026_agent_settings_override.ts`, `032_agent_display_config.ts`, `033_agent_pending_command.ts`
- `server/src/db/migrations/040_agent_updating.ts`, `042_agent_notification_types.ts`, `048_agent_notification_cooldown.ts`
- `server/src/db/migrations/050_monitor_agent_notes.ts`, `051_proxy_agent_device.ts`, `052_agent_device_type.ts`
- `server/src/services/agent.service.ts`
- `server/src/services/agentHub.service.ts`
- `server/src/workers/AgentMonitorWorker.ts`
- `client/src/pages/AgentDetailPage.tsx`, `client/src/pages/AdminAgentPage.tsx`
- `client/src/utils/sensorLabels.ts`
- `agent/cmd_ws.go`, `agent/temps_windows.go`, `agent/uninstall.go`
