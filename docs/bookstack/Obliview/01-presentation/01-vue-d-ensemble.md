Obliview est une plateforme de supervision (monitoring) multi-tenant, conçue sur le modèle d'Uptime Kuma mais réécrite pour un usage en environnement d'entreprise multi-clients : hiérarchie de groupes avec héritage de configuration, système de notifications à plugins, agent natif pour la supervision matérielle des postes/serveurs, fédération SSO inter-applications, et un launcher de bureau qui regroupe plusieurs applications « Obli* » dans une seule fenêtre. Le code vit dans un monorepo unique (`D:\Obliview`) avec workspaces npm (`shared/`, `server/`, `client/`) plus deux modules Go indépendants (`agent/`, `obli.tools/`).

## Positionnement

Obliview n'est pas un simple clone d'Uptime Kuma : c'est la brique de supervision d'un écosystème plus large de logiciels « Obli* » (Obliguard, Oblimap, Obliance) partageant une identité SSO commune via **Obligate** (gateway d'authentification, dépôt séparé `D:\Obligate`). Un utilisateur s'authentifie une fois sur Obligate et peut naviguer entre toutes les applications Obli* sans ressaisir ses identifiants, y compris depuis un client lourd (**ObliTools**) qui héberge chaque application dans un WebView2 avec une barre d'onglets commune.

## Stack technique

| Composant | Technologies |
|---|---|
| Backend | Node.js 24 LTS, TypeScript, Express, Socket.io |
| Frontend | React + Vite, Tailwind CSS, Zustand |
| Base de données | PostgreSQL (via Knex, 192.168.1.1:5432, db `betterkuma`) |
| Agent natif | Go, cross-plateforme (Windows MSI via WiX v4+, binaire Linux/macOS) |
| Launcher de bureau | Go + WebView2 (`obli.tools/`) |
| SSO | Obligate (gateway OAuth-like externe) |

Le paquet `shared/` (types TypeScript partagés) doit être compilé (`npx tsc`) avant que le serveur ne démarre — le `server/tsconfig.json` ne déclare pas de `paths` pour `@obliview/shared`, la résolution passe par le symlink de workspace npm vers `shared/dist/`. Côté client, la résolution passe par un alias Vite.

## Grandes capacités fonctionnelles

- **Monitors** : 13 types de sondes actives/passives (HTTP, Ping, TCP, DNS, SSL, SMTP, Docker, Game Server, Push, Script, JSON API, Browser/Playwright, Value Watcher) plus un 14ᵉ type virtuel `agent` représentant un poste supervisé par l'agent natif.
- **Groupes hiérarchiques** : arborescence de `monitor_groups` avec table de fermeture transitive (`group_closure`) pour les requêtes d'ascendance/descendance en O(1) jointure, et héritage de réglages/notifications par niveau.
- **Notifications** : 10 plugins (`server/src/notifications/plugins/`) — Discord, Slack, Telegram, Teams, Pushover, Gotify, ntfy, Webhook, SMTP, Free Mobile — avec liaisons (`notification_bindings`) en mode `merge` ou `replace` par portée (global/groupe/monitor).
- **Agents** : binaire Go installé sur les postes/serveurs, remonte des métriques matérielles (température CPU/carte mère via LibreHardwareMonitor sur Windows), communique en push HTTP ou via un canal WebSocket bidirectionnel temps réel.
- **Multi-tenant** : toutes les tables métier portent un `tenant_id`, un tenant « maître » (`MASTER_TENANT_ID = 1`, slug `default`) sert de vue globale plateforme (« God View ») pour les administrateurs.
- **SSO fédéré** : authentification déléguée à Obligate, jetons d'échange, provisioning distant des utilisateurs (`sso_foreign_users`).
- **Remédiation** : actions automatiques déclenchées sur changement d'état d'un monitor (webhook, script, redémarrage Docker, SSH, n8n).
- **Fenêtres de maintenance** : suppression programmée des alertes par portée (global/groupe/monitor/agent), one-shot ou récurrente.
- **Alertes live** : flux d'événements dédupliqués (`live_alerts`) poussés en Socket.io, agrégés cross-tenant pour l'application desktop.

## Écosystème Obli*

```
Obligate (SSO gateway, repo séparé D:\Obligate)
   │  jetons OAuth-like, provisioning utilisateurs
   ▼
┌────────────┬────────────┬────────────┬────────────┐
│ Obliview   │ Obliguard  │ Oblimap    │ Obliance   │
│ (monitoring)│           │            │            │
└────────────┴────────────┴────────────┴────────────┘
        ▲ hébergées ensemble par
        │
   ObliTools (obli.tools/, Go + WebView2)
   barre d'onglets, notifications sonores, navigation croisée
```

Sur Obliview, l'intégration Obligate est portée par `server/src/services/obligate.service.ts` (fonctions `getSsoConfig`, `exchangeCode`, `reportProvision`, `getConnectedApps`) et par `server/src/routes/obligateCallback.routes.ts` qui expose `/auth/callback`, `/auth/sso-redirect`, `/api/auth/sso-config`, `/api/auth/connected-apps`, entre autres. Historiquement, une SSO « en maillage » directe entre applications (`sso.routes.ts`, `obliguard/oblimap/obliance.routes.ts`) existait mais a été entièrement supprimée au profit de ce modèle centralisé via Obligate.

## Découpage du dépôt

| Répertoire | Rôle |
|---|---|
| `shared/` | Types TypeScript partagés serveur/client (monitor types, rôles, tenants…) |
| `server/` | API Express, workers de supervision, migrations Knex, sockets |
| `client/` | SPA React (dashboard, administration, pages agent) |
| `agent/` | Agent natif Go (Windows MSI, binaire Linux/macOS) |
| `obli.tools/` | Launcher desktop Go/WebView2 |
| `docs/` | Documentation projet |

## Références

- `CLAUDE.md` — contexte projet, phases d'implémentation, décisions d'architecture
- `server/src/services/obligate.service.ts`
- `server/src/routes/obligateCallback.routes.ts`
- `shared/src/tenants.ts` (`MASTER_TENANT_ID`, `isMasterTenant`)
- `shared/src/monitorTypes.ts` (`MONITOR_TYPES`, `MONITOR_STATUS`, `USER_ROLES`)
- `server/src/notifications/plugins/`
- `obli.tools/main.go`
- `agent/cmd_ws.go`