Le serveur Obliview suit une architecture en couches classique Express : `routes` → `controllers` → `services` → `db` (Knex), avec un point d'entrée unique `server/src/index.ts` qui orchestre le boot, et `server/src/app.ts` qui construit l'application Express avec sa chaîne de middleware.

## Couches

| Couche | Répertoire | Rôle |
|---|---|---|
| Routes | `server/src/routes/*.routes.ts` | déclaration des chemins Express, branchement des middlewares (`requireAuth`, `requireTenant`, RBAC, `validate`) |
| Controllers | `server/src/controllers/*.controller.ts` | extraction/validation des paramètres HTTP, appel des services, formatage de la réponse JSON |
| Services | `server/src/services/*.service.ts` | logique métier, accès Knex, émission Socket.io |
| Workers | `server/src/workers/*.ts` | boucles de vérification asynchrones (`BaseMonitorWorker`, `MonitorWorkerManager`, `AgentMonitorWorker`) |
| DB | `server/src/db/` | instance Knex, migrations, `knexfile.ts` |

Exemple représentatif — `monitors.routes.ts` :

```ts
router.use(requireAuth);
router.get('/', monitorsController.list);
router.patch('/bulk', validate(bulkUpdateSchema), monitorsController.bulkUpdate);
router.post('/', requireCanCreate(), validate(createMonitorSchema), monitorsController.create);
router.put('/:id', requireMonitorWrite(), validate(updateMonitorSchema), monitorsController.update);
```

Note d'implémentation : les routes `/bulk` sont déclarées **avant** `/:id` — sinon Express matcherait `bulk` comme un paramètre `:id`.

## `routes/index.ts` — montage central

`server/src/routes/index.ts` distingue trois catégories de routes :

1. **Globales, sans tenant** : `/auth`, `/heartbeat` (push monitors, sans session), `/agent` (auth par clé API), `/admin/config`, `/system`, `/oblitools`, `/permission-sets`.
2. **Gestion de tenant** (`requireAuth` mais PAS `requireTenant`) : `/tenants`, `/tenant/switch` — un utilisateur doit pouvoir lister/changer de tenant avant qu'un tenant courant soit résolu.
3. **Scopées tenant** (`requireAuth` + `requireTenant`), montées sur un sous-router dédié :

```ts
const tenantRouter = Router();
tenantRouter.use(requireAuth);
tenantRouter.use(requireTenant);
tenantRouter.use('/monitors', monitorsRoutes);
tenantRouter.use('/groups', groupsRoutes);
tenantRouter.use('/settings', settingsRoutes);
// ...
router.use('/', tenantRouter);
```

## Chaîne de middleware (`app.ts`)

L'ordre est significatif et documenté en commentaires dans le code :

1. `app.set('trust proxy', 1)` — nécessaire pour que `req.ip` reflète `X-Forwarded-For` derrière Nginx/NPM (rate limiting correct).
2. `helmet()` avec une CSP stricte :

```ts
helmet({
  frameguard: false, // ObliTools embarque l'app en iframe
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"], // Tailwind injecte du style inline
      connectSrc: ["'self'", "wss:", "ws:"],    // Socket.io
      objectSrc: ["'none'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
})
```
`frame-ancestors` n'est volontairement pas fixé pour permettre l'embarquement iframe par ObliTools.
3. `cors({ origin: config.clientOrigin, credentials: true })`.
4. `express.json({ limit: '1mb' })` puis `cookieParser()` (l'ordre compte : la session lit le cookie).
5. `express-session` stocké en PostgreSQL via `connect-pg-simple` (table `session`, `createTableIfMissing: false`). Le cookie est configuré `secure`/`sameSite: 'none'`/`partitioned` uniquement quand `config.forceHttps` est vrai (nécessaire pour l'iframe cross-site d'ObliTools ; sinon `lax` + non sécurisé en dev HTTP).
6. Middleware **iframe token auth** : fallback quand Chrome bloque tous les cookies dans un contexte iframe cross-site (shell WebView2 ObliTools sur `http://127.0.0.1`). Le login renvoie `sessionToken` (= `req.sessionID`), stocké côté client en `sessionStorage` et renvoyé via l'en-tête `X-Auth-Token`. Ce middleware relit la session correspondante dans le store et hydrate `req.session` manuellement.
7. `apiLimiter` (rate limiting global) — appliqué **après** la session pour pouvoir exempter les utilisateurs authentifiés.
8. Montage des routers : `/auth` (callback Obligate SSO, hors `/api`), `/api` (toutes les routes API), `/health` (public).
9. Route `/downloads/:filename` — sert les binaires ObliTools pré-buildés depuis `obli.tools/dist/` via une whitelist stricte (`DESKTOP_FILES`) pour éviter le path traversal.
10. En production (`!config.isDev`) : sert le build statique du client (`client/dist`) et fallback SPA (`app.get('*', ...)`).
11. `errorHandler` en dernier.

## Rate limiting

`server/src/middleware/rateLimiter.ts` définit deux limiteurs distincts :

| Limiteur | Fenêtre | Max | Clé | Exemptions |
|---|---|---|---|---|
| `apiLimiter` | 5 min | 500 req | IP | sessions authentifiées, `/health`, `/api/auth/me`, `/api/agent/*` (clé API), `/api/heartbeat/*` (token) |
| `authLimiter` | 5 min | 20 tentatives échouées | `IP:username` | connexions réussies (`skipSuccessfulRequests`) |

`authLimiter` est appliqué localement dans `auth.routes.ts` sur l'endpoint de login, après que `express.json()` a déjà parsé `req.body`.

## RBAC et scoping tenant

- `middleware/auth.ts` — `requireAuth` vérifie `req.session.userId`.
- `middleware/tenant.ts` — `requireTenant` résout `req.tenantId` depuis `req.session.currentTenantId` (étend `Express.Request`).
- `middleware/rbac.ts` — expose plusieurs gardes composables :

| Fonction | Usage |
|---|---|
| `requireRole(...roles)` | liste blanche de `UserRole` |
| `requireMonitorWrite()` | admin plateforme OU permission RW via équipes (`permissionService.canWriteMonitor`) |
| `requireGroupWrite()` | idem pour un groupe |
| `requireCanCreate()` | droit de création de moniteurs/groupes |
| `requireTenantCapability(cap)` | capacité résolue depuis le `permission_set` attaché au rôle tenant (`user_tenants.role`) |
| `requirePlatformAdmin()` | `users.role === 'admin'` — admin global, distinct du rôle admin *tenant* |
| `requireMasterTenant()` | restreint aux endpoints "God View" du tenant maître (`isMasterTenant`) |

## Enveloppe de réponse standard

Tous les controllers renvoient une enveloppe JSON homogène, gérée soit directement, soit via `errorHandler` :

```ts
// succès
res.json({ success: true, data: enriched });

// erreur métier (AppError)
res.status(err.statusCode).json({ success: false, error: err.message });

// erreur non gérée → 500
res.status(500).json({ success: false, error: 'Internal server error' });
```

`AppError` (`middleware/errorHandler.ts`) est une sous-classe d'`Error` portant un `statusCode` ; les controllers font `next(new AppError(403, '...'))` pour déléguer le formatage au middleware d'erreur central.

## Séquence de démarrage (`index.ts`)

1. Import de `./env` (charge `dotenv` — doit être le tout premier import, avant `config`/`knexfile`).
2. `db.migrate.latest()` — applique les migrations Knex en attente.
3. `authService.ensureDefaultAdmin(...)` — crée l'admin par défaut si absent.
4. `createApp()` — construit l'app Express (middleware ci-dessus).
5. `http.createServer(app)` puis `createSocketServer(server)` (Socket.io) — l'instance `io` est stockée via `app.set('io', io)` et injectée dans `agent.service.ts` (`setAgentServiceIO`) et `liveAlert.service.ts` (`setLiveAlertIO`).
6. Interception de l'événement `upgrade` HTTP : les upgrades vers `/api/agent/ws` sont routés vers un `WebSocketServer` dédié (authentification par `X-Api-Key` + `uuid`), tous les autres upgrades sont transférés aux listeners originaux de Socket.io (`sioUpgradeListeners`).
7. `maintenanceService.startJobs()` puis `MonitorWorkerManager.getInstance(io).startAll()`.
8. `server.listen(config.port)`.
9. Jobs périodiques : purge des heartbeats (`heartbeatService.purgeOlderThan(90)` toutes les 6h), nettoyage des agents désinstallés/bloqués (`agentService.cleanupUninstalledDevices` / `cleanupStuckUpdating` toutes les 5 min).
10. Arrêt propre sur `SIGTERM`/`SIGINT` : clear des timers, arrêt des jobs de maintenance, fermeture du `WebSocketServer` agent, `workerManager.stopAll()`, `server.close()`, `db.destroy()`.

## Références

- `server/src/app.ts`
- `server/src/index.ts`
- `server/src/routes/index.ts`
- `server/src/routes/monitors.routes.ts`
- `server/src/middleware/auth.ts`, `tenant.ts`, `rbac.ts`, `rateLimiter.ts`, `errorHandler.ts`
- `server/src/controllers/monitors.controller.ts`
- `server/src/config.ts`