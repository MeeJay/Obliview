Obliview est un monorepo npm workspaces regroupant quatre modules TypeScript/Node.js et deux binaires Go, orchestrés depuis la racine `D:\Obliview`.

## Stack technique

| Couche | Technologie | Détail |
|---|---|---|
| Runtime serveur | Node.js 24 LTS | exécuté via `npx tsx` en dev (pas `ts-node`, qui ne résout pas les `.d.ts` custom) |
| Langage | TypeScript | strict mode activé sur `server/tsconfig.json` et `shared/tsconfig.json` |
| API HTTP | Express | `server/src/app.ts` |
| Temps réel | Socket.io + `ws` | Socket.io pour la UI, un `WebSocketServer` (`ws`) dédié pour le canal de commandes agent |
| Frontend | React 18 + Vite 5 | `client/` |
| Style | Tailwind CSS 3 | classes utilitaires, thème clair/sombre |
| État client | Zustand 4 | stores dans `client/src/store/` |
| i18n | react-i18next | 18 langues, `client/src/i18n/` |
| Base de données | PostgreSQL + Knex | requêtes construites via Knex, pas d'ORM |
| Sessions | express-session + connect-pg-simple | table `session` en PostgreSQL |
| Agent natif | Go 1.22 | `agent/`, binaire cross-platform |
| Launcher desktop | Go 1.21 + WebView2 | `obli.tools/`, module `oblitools-desktop` |

## Structure du monorepo

```
D:\Obliview
├── shared/     @obliview/shared  — types, constantes, enums partagés
├── server/     @obliview/server  — API Express, workers, migrations Knex
├── client/     @obliview/client  — SPA React + Vite
├── agent/      module Go github.com/obliview/agent — agent natif Windows/Linux/macOS
└── obli.tools/ module Go oblitools-desktop — launcher WebView2 multi-app
```

Le `package.json` racine déclare les workspaces npm :

```json
"workspaces": ["shared", "server", "client", "agent"]
```

(`agent` est listé comme workspace npm mais ne contient pas de code Node — c'est un vestige d'outillage ; le code Go est autonome avec son propre `go.mod`.)

## Package `shared`

`shared/src/` expose les types et constantes utilisés à la fois par le serveur et le client :

- `types.ts` — interfaces `Monitor`, `Heartbeat`, `User`, `UserPermissions`, etc.
- `socketEvents.ts` — `SOCKET_EVENTS` et `CLIENT_EVENTS`, la liste exhaustive des noms d'événements Socket.io
- `monitorTypes.ts` — définitions des 13 types de moniteurs
- `settingsDefaults.ts` — valeurs par défaut de la chaîne de résolution des settings
- `sensorLabels.ts`, `tenants.ts` — helpers partagés (ex. `isMasterTenant`)

`shared/package.json` compile via `tsc` simple (pas de bundler) :

```json
"scripts": { "build": "tsc", "dev": "tsc --watch" }
```

Le résultat est écrit dans `shared/dist/` (`main`/`types` pointent vers `dist/index.js` / `dist/index.d.ts`).

## Ordre de build impératif

Le package `shared` DOIT être compilé avant `server`, car `server/tsconfig.json` ne déclare **aucun** alias `paths` pour `@obliview/shared` — la résolution se fait uniquement via le symlink npm workspaces vers `shared/dist/`. Si `dist/` est absent ou périmé, le serveur ne compile pas et ne démarre pas (`Cannot find module '@obliview/shared'` ou types obsolètes).

```bash
cd shared && npx tsc
# puis seulement
cd server && npx tsx src/index.ts
```

Le script racine formalise cet ordre :

```json
"build": "npm run build:shared && npm run build:server && npm run build:client"
```

À l'inverse, `client/vite.config.ts` résout `@obliview/shared` directement vers les **sources** TypeScript (`../shared/src`), pas vers `dist/` :

```ts
resolve: {
  alias: {
    '@': path.resolve(__dirname, './src'),
    '@obliview/shared': path.resolve(__dirname, '../shared/src'),
  },
},
```

Cela signifie que le client n'a pas besoin que `shared` soit compilé pour dev (Vite transpile les sources à la volée), contrairement au serveur.

## Démarrage en développement

- `npm run dev:server` → `cd server && npm run dev` (tsx en watch)
- `npm run dev:client` → `cd client && npm run dev` (Vite, proxy `/api` et `/socket.io` vers `http://localhost:3001`, voir `client/vite.config.ts`)
- `npm run dev` → lance la stack complète via Docker Compose (`docker-compose.build.yml` + `docker-compose.dev.yml`)

En Windows, Node.js est installé dans `C:\Program Files\nodejs\` ; les scripts bash du projet préfixent le `PATH` en conséquence (`PATH="/c/Program Files/nodejs:$PATH"`).

## Binaires Go

- `agent/` (module `github.com/obliview/agent`, Go 1.22) — agent natif compilé pour Windows (MSI via WiX v4+ CLI `wix build`), Linux et macOS. Dépendances notables : `gopsutil/v3` (métriques système), `lxn/walk` (UI Windows tray).
- `obli.tools/` (module `oblitools-desktop`, Go 1.21) — launcher desktop basé sur `webview/webview_go`, sert de shell multi-fenêtres WebView2 pour les apps Obli*.

Ces deux modules sont buildés et signés (Certum SimplySign, `D:\Sign\Sign.ps1`) en dehors du pipeline Docker — les Dockerfiles ne construisent plus les binaires Go, ils sont produits localement puis copiés/déployés.

## Références

- `package.json` (racine)
- `shared/package.json`, `shared/src/index.ts`, `shared/src/socketEvents.ts`
- `server/tsconfig.json`
- `client/vite.config.ts`, `client/package.json`
- `agent/go.mod`
- `obli.tools/go.mod`
- `CLAUDE.md` (racine du projet)