Le système de remédiation exécute automatiquement une action correctrice (webhook, script shell, redémarrage Docker, commande SSH) lorsqu'un moniteur change d'état. Il reprend le modèle d'héritage merge/replace/exclude déjà utilisé pour les notifications, mais l'applique à un pool d'« actions » réutilisables liées à des « bindings » scopés. Implémentation : `server/src/services/remediation.service.ts`.

## Modèle de données

Trois tables (migration `024_create_remediations.ts`, UUID ajoutés en `027_remediation_action_uuid.ts`) :

**`remediation_actions`** — pool global d'actions réutilisables :

| Colonne | Rôle |
|---|---|
| `name` | Libellé |
| `type` | `webhook` \| `n8n` \| `script` \| `docker_restart` \| `ssh` |
| `config` | JSONB, structure dépendante du type |
| `enabled` | Désactivation sans suppression |

**`remediation_bindings`** — rattache une action à un scope :

| Colonne | Rôle |
|---|---|
| `action_id` | FK vers `remediation_actions`, `ON DELETE CASCADE` |
| `scope` | `global` \| `group` \| `monitor` |
| `scope_id` | `NULL` pour `global` |
| `override_mode` | `merge` \| `replace` \| `exclude` |
| `trigger_on` | `down` \| `up` \| `both` |
| `cooldown_seconds` | anti-spam, défaut 300 |

Contrainte d'unicité `['action_id', 'scope', 'scope_id']` — une action ne peut être liée qu'une fois par scope exact.

**`remediation_runs`** — journal d'exécution : `action_id`, `monitor_id`, `triggered_by` (`down`/`up`), `status` (`success` \| `failed` \| `timeout` \| `cooldown_skip`), `output`, `error`, `duration_ms`, `triggered_at`. Indexée sur `(monitor_id, triggered_at)` et `(action_id, triggered_at)` pour l'historique par moniteur ou par action.

## Chiffrement des identifiants SSH

Les actions de type `ssh` stockent leur identifiant (mot de passe ou clé privée) chiffré en AES-256-GCM, dérivé de `ENCRYPTION_KEY` (ou à défaut `config.sessionSecret`) via `scryptSync` :

```ts
function encryptCredential(plaintext: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}
```

La valeur brute n'est jamais renvoyée par l'API : `rowToAction` remplace systématiquement `credentialEnc` par le sentinel `'[set]'`. `_execSsh` re-fetch la config chiffrée directement en base (contournant le mapping masquant) au moment de l'exécution, puis la déchiffre en mémoire.

## Résolution des bindings (héritage)

`resolveBindingsForMonitor(monitorId, groupId)` applique successivement : bindings `global` → bindings de chaque groupe ancêtre (du plus général au plus proche, via `group_closure` triée `depth desc`) → bindings du moniteur lui-même. À chaque niveau, `applyBindings` :

```ts
function applyBindings(current: BindingSet, bindings: RemediationBinding[]): BindingSet {
  if (bindings.length === 0) return current;
  const next = new Map(current);
  const hasReplace = bindings.some(b => b.overrideMode === 'replace');
  if (hasReplace) next.clear();
  for (const b of bindings) if (b.overrideMode !== 'exclude') next.set(b.actionId, b);
  for (const b of bindings) if (b.overrideMode === 'exclude') next.delete(b.actionId);
  return next;
}
```

`replace` purge tout ce qui a été accumulé aux niveaux précédents ; `merge` (défaut) ajoute/écrase par `actionId` ; `exclude` retire une action spécifique héritée d'un niveau supérieur. `resolveBindingsWithSources` fournit la même résolution enrichie de métadonnées (`source`, `sourceId`, `isDirect`) pour l'affichage d'héritage côté UI.

## Déclenchement

`triggerForMonitor(...)` est appelé depuis le pipeline de changement de statut du moniteur (après suppression le cas échéant par une fenêtre de maintenance active). Le déclencheur logique (`down`/`up`) est dérivé du nouveau statut :

```ts
const trigger: 'down' | 'up' = (
  newStatus === 'down' || newStatus === 'ssl_expired' || newStatus === 'ssl_warning' || newStatus === 'alert'
) ? 'down' : 'up';
```

Pour chaque binding résolu : filtrage par `triggerOn` (`both` ou correspondance exacte), puis vérification du cooldown — une exécution récente non `cooldown_skip` dans la fenêtre `cooldownSeconds` fait insérer un run `cooldown_skip` et passe au binding suivant. Sinon, `_executeAction` est lancée de façon asynchrone (fire-and-forget, ne bloque pas `handleStatusChange`).

## Exécuteurs

| Type | Méthode | Comportement |
|---|---|---|
| `webhook` / `n8n` | `_execWebhook` | Requête `fetch` avec `AbortController` (timeout configurable), payload `{ event, monitor, status, previousStatus, triggeredAt }` fusionné avec `bodyExtra` |
| `script` | `_execScript` | `child_process.exec` avec variables d'environnement (`MONITOR_ID`, `STATUS`, `TRIGGER`…), timeout + kill de sécurité (`SIGTERM` + 2 s de marge) |
| `docker_restart` | `_execDockerRestart` | Requête HTTP brute sur le socket Docker (`/var/run/docker.sock` par défaut) vers `/containers/:name/restart` |
| `ssh` | `_execSsh` | Connexion via `ssh2`, déchiffrement de l'identifiant, injection des variables de contexte en préfixe de commande shell, timeout 15 s par défaut |

Chaque exécution produit un enregistrement `remediation_runs` avec `status`, `output` (tronqué à 2000 caractères), `error` et `duration_ms`.

## Endpoints

`server/src/routes/remediation.routes.ts` :

| Méthode | Route | Accès |
|---|---|---|
| GET / POST | `/api/remediation/actions` | admin (GET) / admin (POST) |
| PUT / DELETE | `/api/remediation/actions/:id` | admin |
| GET | `/api/remediation/bindings` | tout utilisateur authentifié |
| GET | `/api/remediation/resolved` | tout utilisateur authentifié (résolution avec sources) |
| POST / PATCH / DELETE | `/api/remediation/bindings(/:id)` | admin |
| GET | `/api/remediation/runs` | tout utilisateur authentifié |

La lecture des bindings et de l'historique est ouverte à tout utilisateur connecté (utile pour l'affichage en lecture seule sur une fiche moniteur), tandis que la création d'actions/bindings reste strictement réservée aux administrateurs via `requireRole('admin')`.

## AdminRemediationsPage

`client/src/pages/AdminRemediationsPage.tsx` gère le pool d'actions (formulaires spécifiques par `type`), la matrice de bindings par scope avec sélection du `overrideMode`/`triggerOn`/`cooldownSeconds`, et l'historique des `remediation_runs` pour audit.

## Références

- `server/src/services/remediation.service.ts`
- `server/src/db/migrations/024_create_remediations.ts`
- `server/src/db/migrations/027_remediation_action_uuid.ts`
- `server/src/routes/remediation.routes.ts`
- `client/src/pages/AdminRemediationsPage.tsx`
