Cette page dresse l'inventaire des grandes fonctionnalités livrées par Obliview : les 13 types de monitors actifs (+ le type virtuel `agent`), les 10 plugins de notification, le système d'agent natif, la fédération SSO, le multi-tenant et le launcher ObliTools.

## Les 13 types de monitors

Chaque type dispose d'une classe worker dédiée héritant de `BaseMonitorWorker` (`server/src/workers/BaseMonitorWorker.ts`), orchestrées par le singleton `MonitorWorkerManager` (`server/src/workers/MonitorWorkerManager.ts`).

| Type | Worker | Rôle |
|---|---|---|
| `http` | `HttpMonitorWorker` | Requête HTTP(S), code de statut, temps de réponse, contenu attendu |
| `ping` | `PingMonitorWorker` | ICMP ping |
| `tcp` | `TcpMonitorWorker` | Ouverture de port TCP |
| `dns` | `DnsMonitorWorker` | Résolution DNS (type d'enregistrement, valeur attendue) |
| `ssl` | `SslMonitorWorker` | Validité et expiration de certificat (`sslCheck.ts`), statuts `ssl_warning`/`ssl_expired` |
| `smtp` | `SmtpMonitorWorker` | Connexion à un serveur SMTP |
| `docker` | `DockerMonitorWorker` | État d'un conteneur Docker |
| `game_server` | `GameServerMonitorWorker` | Requête de statut serveur de jeu via le paquet `gamedig` (typings custom `server/src/types/gamedig.d.ts`) |
| `push` | `PushMonitorWorker` | Passif : le système externe POST sur `/api/heartbeat/:token`, le worker vérifie le temps écoulé depuis le dernier push |
| `script` | `ScriptMonitorWorker` | Exécution d'un script personnalisé, code de sortie/sortie standard interprétés |
| `json_api` | `JsonApiMonitorWorker` | Requête JSON avec assertions sur le corps de réponse |
| `browser` | `BrowserMonitorWorker` | Rendu Playwright headless, utile pour les SPA nécessitant du JS |
| `value_watcher` | `ValueWatcherMonitorWorker` | Surveillance d'une valeur numérique/texte avec seuils |
| `agent` | `AgentMonitorWorker` | Type virtuel représentant un poste supervisé par l'agent natif (pas de requête réseau active — détection hors-ligne basée sur push) |

Les statuts communs à tous les types sont définis dans `MONITOR_STATUS` (`shared/src/monitorTypes.ts`) : `up`, `down`, `pending`, `maintenance`, `paused`, `ssl_warning`, `ssl_expired`, `alert`, `inactive`, `updating`.

Le bulk edit (`PATCH /api/monitors/bulk`) n'applique que les champs explicitement envoyés, permettant des mises à jour de masse partielles.

## Les 10 plugins de notification

Répertoire `server/src/notifications/plugins/`, enregistrés dans `server/src/notifications/registry.ts` :

| Plugin | Fichier |
|---|---|
| Discord | `discord.ts` |
| Slack | `slack.ts` |
| Telegram | `telegram.ts` |
| Microsoft Teams | `teams.ts` |
| Pushover | `pushover.ts` |
| Gotify | `gotify.ts` |
| ntfy | `ntfy.ts` |
| Webhook générique | `webhook.ts` |
| SMTP (e-mail) | `smtp.ts` |
| Free Mobile (SMS) | `freemobile.ts` |

Chaque canal (`notification_channels.type`) référence un de ces plugins et stocke sa configuration en JSONB (`config`). Les liaisons (`notification_bindings`) déterminent quels canaux s'appliquent à quelle portée, en mode `merge` (cumul avec l'héritage) ou `replace` (remplacement total). Chaque envoi est journalisé (`notification_log`) avec succès/erreur.

Un mécanisme de **debounce de cooldown** est implémenté dans `BaseMonitorWorker.handleStatusChange()` : la première notification part immédiatement, les changements d'état suivants pendant la période de cooldown sont mis en file, le timer se réinitialise à chaque changement, et une notification n'est finalement envoyée que si l'état s'est stabilisé pendant toute la durée du cooldown. La priorité de résolution du cooldown est : device agent > chaîne de groupes > réglages du monitor (défaut 300 s).

## Système d'agent natif

Binaire Go multi-plateforme (`agent/`), installé via MSI (WiX v4+) sur Windows ou en binaire natif sur Linux/macOS.

- **Enregistrement** : chaque agent génère un UUID matériel stable (WMI/BIOS sur Windows, IOKit sur macOS, DMI sur Linux) qui survit à une réinstallation. Stocké dans `agent_devices.uuid`.
- **Communication** : legacy en push HTTP (`POST /api/agent/push`, réponse contenant config + commande optionnelle) ou via le **canal WebSocket** `/api/agent/ws` (`agentHub.service.ts`), temps réel et bidirectionnel — c'est la voie recommandée, le HTTP restant supporté pour compatibilité.
- **Commandes** : mises en file dans `agent_devices.pending_command`, livrées à la connexion WS ou au prochain push HTTP (ex. `'uninstall'` déclenche un désinstalleur MSI via script batch détaché puis `os.Exit(0)`).
- **Capteurs matériels (Windows)** : DLLs LibreHardwareMonitor (LHM) embarquées dans le binaire, invoquées via réflexion .NET en PowerShell (`agent/temps_windows.go`), plus pilote noyau **PawnIO** installé par le WiX pour le support WinRing0 de LHM.
- **Seuils** : hiérarchie de résolution `monitor.agent_thresholds` → `device.groupThresholds` → `DEFAULT_AGENT_THRESHOLDS` (constante définie dans `shared/src/types.ts`).
- **Réglages surchargeables par groupe** (`override_group_settings`) : uniquement `checkIntervalSeconds`, `heartbeatMonitoring`, `maxMissedPushes`, `notificationCooldownSeconds` — jamais les seuils eux-mêmes.
- **Détection hors-ligne** : `AgentMonitorWorker` utilise les réglages effectifs résolus (héritage de groupe si `override=false`).
- **Auto-update** : téléchargement du nouveau binaire/MSI depuis `/api/agent/download/`, réinstallation silencieuse.
- **Nettoyage** : job périodique (toutes les 5 min) supprimant les devices dont `uninstall_commanded_at` date de plus de 10 min, et purge des agents bloqués en état `updating`.
- **Notifications par device** : surcharges individuelles des types de notification (`agent_down`, `agent_up`, `agent_alert`, `agent_fixed`) en plus de la config de groupe.
- **Signature de code** : tous les binaires Windows (`.exe` + `.msi`) sont signés via certificat cloud Certum SimplySign (`D:\Sign\Sign.ps1`), signature effectuée **avant** la construction du MSI.

## SSO / fédération (Obligate)

Depuis la Phase 20, toute la SSO passe par la gateway externe **Obligate** (dépôt séparé `D:\Obligate`) :

- `server/src/services/obligate.service.ts` : `getSsoConfig`, `exchangeCode`, `reportProvision`, `getConnectedApps`.
- `server/src/routes/obligateCallback.routes.ts` : `/auth/callback`, `/auth/sso-redirect`, `/api/auth/sso-config`, `/api/auth/connected-apps`, `/api/auth/app-info`, `/api/auth/dashboard-stats`, `/api/auth/sso-logout-url`.
- Utilisateurs fédérés stockés dans `sso_foreign_users`, avec username préfixé `og_` (masqué à l'affichage dans `AdminUsersPage`, `Header`, `Sidebar`) et badge « SSO ».
- Les utilisateurs SSO sautent l'assistant d'enrôlement (`enrollment_version: 999`), ont leur nom d'utilisateur immuable et le changement de mot de passe bloqué côté Obliview (géré par Obligate).
- Protection CSRF OAuth : paramètre `state` (RFC 6749 §10.12) généré lors du `sso-redirect`, validé au callback, stocké en session.
- Préférences (thème, langue, notifications toast) resynchronisées depuis Obligate à chaque connexion SSO.

## Multi-tenant

- Table `tenants` + jonction `user_tenants` (rôle par tenant).
- Toutes les tables métier portent `tenant_id`, middleware `requireTenant` sur les routes tenant-scopées.
- Tenant maître (`id=1`, slug `default`) sert de vue plateforme globale, protégé par `requireMasterTenant()`.
- Bascule de tenant : `POST /tenant/switch` suivi d'un `window.location.reload()`.
- UI : `AdminTenantsPage` (gestion des workspaces), `TenantSwitcher` (sélecteur dans le header).

## ObliTools — launcher desktop

Application Go + WebView2 (`obli.tools/main.go`) qui héberge plusieurs applications Obli* dans des fenêtres séparées :

- **Barre d'onglets** (40 px, injectée en JS) : un onglet par tenant, badges de compteur d'alertes non lues, modes auto-cycle et follow-alerts (bascule automatique vers l'onglet ayant une alerte active).
- **Overlay JS** injecté dans chaque application : pose `window.__obliview_is_native_app = true`, patch l'historique pour le suivi de la dernière URL visitée par app.
- **Navigation croisée** : intercepte les liens vers d'autres applications Obli* et les ouvre dans la fenêtre correspondante plutôt que de naviguer dans l'onglet courant.
- **Sons de notification** : tonalités synthétisées pour `probe_down`, `probe_up`, `agent_alert`, `agent_fixed`.
- **Découverte du manifeste** : `GET /api/oblitools/manifest` (`server/src/routes/oblitools.routes.ts`) renvoie le nom/couleur de l'app courante, le chemin SSO (`/auth/sso-redirect`) et la liste des applications liées (`obligateService.getConnectedApps()`, filtrée pour exclure Obliview elle-même).
- **Configuration** : stockée dans `%APPDATA%\ObliTools\config.json` sous Windows.
- **Builds** : `ObliTools.exe`, `ObliTools.dmg`, installeurs MSI.

## Références

- `server/src/workers/BaseMonitorWorker.ts`, `MonitorWorkerManager.ts` — orchestration des workers de monitoring
- `server/src/workers/AgentMonitorWorker.ts` — détection hors-ligne agent
- `shared/src/monitorTypes.ts` — `MONITOR_TYPES`, `MONITOR_STATUS`
- `shared/src/types.ts` — `DEFAULT_AGENT_THRESHOLDS`
- `server/src/notifications/plugins/` — 10 plugins de notification
- `server/src/notifications/registry.ts`
- `server/src/services/agent.service.ts` — push, commandes, nettoyage
- `server/src/services/agentHub.service.ts` — canal WebSocket agent
- `agent/temps_windows.go`, `agent/uninstall.go`, `agent/cmd_ws.go`
- `server/src/services/obligate.service.ts`, `server/src/routes/obligateCallback.routes.ts`
- `server/src/routes/oblitools.routes.ts`
- `obli.tools/main.go`
- `client/src/pages/AdminTenantsPage.tsx`, `client/src/pages/AdminAgentPage.tsx`, `client/src/pages/AgentDetailPage.tsx`
