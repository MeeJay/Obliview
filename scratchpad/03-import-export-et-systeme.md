Deux fonctionnalités transverses facilitent l'exploitation d'Obliview en production : l'import/export JSON d'une configuration de tenant (groupes, moniteurs, notifications, équipes, remédiations) et un endpoint de diagnostic système exposé pour l'écran « À propos ».

## Import/Export

### Routes et montage

```ts
// server/src/routes/importExport.routes.ts
router.use(requireAuth);
router.use(requireRole('admin'));
router.get('/export', importExportController.exportData);
router.post('/import', importExportController.importData);
```

Montées sous le routeur tenant-scopé (`server/src/routes/index.ts`) :

```ts
tenantRouter.use(requireAuth);
tenantRouter.use(requireTenant);
tenantRouter.use('/admin', importExportRoutes);
```

d'où les endpoints effectifs :

| Méthode | Route | Rôle requis | Description |
|---|---|---|---|
| GET | `/api/admin/export?sections=...` | admin | Exporte les sections demandées du tenant courant en JSON |
| POST | `/api/admin/import` | admin | Importe un payload JSON dans le tenant courant |

Le tenant est résolu via `req.session.currentTenantId` (fallback `1`), donc l'export/import est toujours scopé au tenant actif de la session — aucune donnée d'un autre tenant n'est exportée, et un import ne peut pas écrire en dehors du tenant courant.

### Sections exportables

```ts
type ExportSection =
  | 'monitorGroups' | 'monitors' | 'settings' | 'notificationChannels'
  | 'agentGroups' | 'teams' | 'remediationActions' | 'remediationBindings';
```

Le paramètre `?sections=monitors,settings` filtre les sections ; `all` (ou l'absence de paramètre) exporte tout. La section `agentGroups` est conservée côté import pour compatibilité descendante, mais n'est plus jamais **émise** à l'export : depuis l'unification des groupes hybrides, chaque groupe (`monitor_groups`) porte déjà ses champs JSONB agent (`agent_thresholds`, `agent_group_config`) et est exporté sous `monitorGroups`.

### Résolution par UUID plutôt que par ID

Toutes les entités exportées portent un `uuid` stable, et les références inter-entités (groupe parent, groupe/moniteur cible d'un binding) sont sérialisées en `parentUuid` / `scopeUuid` plutôt qu'en ID numérique — ce qui rend un export portable entre deux instances/bases différentes. Le champ `_note` du payload documente cette convention :

```json
{
  "version": 1,
  "exportedAt": "2026-07-03T12:00:00.000Z",
  "_note": "UUIDs are optional — omit them to always create new records on import. ...",
  "sections": ["monitorGroups", "monitors", "settings", "..."]
}
```

### Stratégie de conflit à l'import

```ts
type ConflictStrategy = 'update' | 'generateNew' | 'ignore';
```

Pour chaque entité importée portant un UUID déjà présent en base **dans le tenant courant**, `resolveConflict()` (`server/src/controllers/importExport.controller.ts`) applique :

- `update` (défaut) — écrase l'enregistrement existant ;
- `generateNew` — crée un doublon avec un nouvel UUID aléatoire ;
- `ignore` — ignore l'entrée (mais l'enregistre quand même dans la table de résolution batch pour que les enfants — ex. sous-groupes — puissent toujours résoudre leur parent).

Un garde-fou spécifique gère la **collision inter-tenant** : si l'UUID importé appartient à un enregistrement d'un *autre* tenant (vérifié via `whereNot({ tenant_id: tenantId })` sur `monitor_groups`, `monitors`, `notification_channels`, `user_teams`, `remediation_actions`), la stratégie choisie par l'utilisateur est **ignorée** et l'entité est forcée en `create` avec un UUID neuf — impossible de réutiliser ou muter l'UUID d'un tenant tiers, car la contrainte `UNIQUE` sur `uuid` est globale à la table, pas par tenant.

L'import s'exécute dans une seule transaction Knex (`db.transaction`) ; les groupes sont triés topologiquement (`topoSort`, parents avant enfants) pour que les `parent_id` se résolvent dans l'ordre, y compris quand `generateNew` change l'UUID d'un parent en cours de batch (table `batchGroupByOrigUuid`). Les workers des moniteurs importés/mis à jour sont redémarrés après commit via `MonitorWorkerManager.getInstance().restartMonitors(...)`, en fire-and-forget.

### Redaction des secrets

Les actions de remédiation de type `ssh` voient leurs identifiants (`credentialEnc`, `password`, `privateKey`) remplacés par `'[redacted]'` à l'export, sauf si le paramètre `includeSSHCredentials=true` est explicitement passé à la requête d'export.

### Client

`client/src/pages/ImportExportPage.tsx` propose un sélecteur de sections (composant `SectionSelector` avec toggles indéterminés pour les sélections partielles) et pilote les deux appels via `apiClient` (`client/src/api/client.ts`), avec retour toast (`react-hot-toast`) sur succès/erreur.

## Endpoint système (`GET /api/system`)

### Route et sécurité

```ts
// server/src/routes/system.routes.ts
router.get('/', requireAuth, requireRole('admin'), async (_req, res) => { ... });
```

Monté directement à la racine, hors du routeur tenant-scopé :

```ts
router.use('/system', systemRoutes); // system info / about (admin only, no tenant required)
```

d'où `GET /api/system` — accessible à tout administrateur quel que soit son tenant courant, car les informations retournées (version, mémoire, CPU) sont globales au processus serveur et non liées à un tenant.

### Contenu de la réponse

```ts
res.json({
  appVersion, nodeVersion, agentVersion, uptimeSeconds,
  memory: { processRssMb, processHeapMb, systemTotalMb, systemFreeMb },
  cpu:    { loadAvg1, loadAvg5, loadAvg15, cores },
  environment: { isDocker, platform, dbStatus },
});
```

- `appVersion` — lu depuis `package.json` à la racine (`process.cwd()`), fallback `'dev'` si absent/illisible.
- `agentVersion` — lu depuis `../agent/VERSION` relatif au `cwd` du serveur (le même fichier `VERSION` que celui bumpé par `000-RegularUpdate.bat` et injecté dans les binaires Go).
- `memory` — `process.memoryUsage()` pour le process Node (RSS, heap utilisé, en Mo arrondis) + `os.totalmem()`/`os.freemem()` pour la machine hôte.
- `cpu` — `os.loadavg()` (charge moyenne 1/5/15 min, arrondie à 2 décimales) et `os.cpus().length` pour le nombre de cœurs. Note : `loadavg()` retourne toujours `[0, 0, 0]` sur Windows natif — une valeur significative n'apparaît qu'en environnement Linux/Docker.
- `environment.isDocker` — détection par présence du fichier `/.dockerenv`.
- `environment.dbStatus` — `'ok'` si `await db.raw('SELECT 1')` réussit, `'error'` sinon (aucune exception ne remonte au client, la vérification est encapsulée dans un `try/catch` silencieux).

### Client

`client/src/api/system.api.ts` expose `systemApi.getInfo()`, typé par l'interface `SystemInfo` (miroir exact du JSON ci-dessus), consommé par l'écran « À propos » de l'admin pour afficher versions, ressources serveur et état de la base de données sans exposer ces informations aux utilisateurs non-admin.

## Références

- `server/src/routes/importExport.routes.ts` — déclaration des routes `/export` et `/import`, garde `requireRole('admin')`
- `server/src/controllers/importExport.controller.ts` — `exportData`, `importData`, `resolveConflict`, `topoSort`, `insertGroupClosure`
- `server/src/routes/index.ts` — montage `tenantRouter.use('/admin', importExportRoutes)` et `router.use('/system', systemRoutes)`
- `server/src/routes/system.routes.ts` — endpoint `GET /api/system`
- `client/src/pages/ImportExportPage.tsx` — UI de sélection de sections et déclenchement export/import
- `client/src/api/system.api.ts` — client typé `SystemInfo` / `systemApi.getInfo()`
- `server/src/workers/MonitorWorkerManager.ts` — `restartMonitors()` appelé après un import réussi
