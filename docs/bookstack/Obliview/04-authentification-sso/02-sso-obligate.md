Depuis la Phase 20, l'ensemble du SSO d'Obliview transite par la passerelle Obligate (dépôt séparé `D:\Obligate`). L'ancien mesh SSO (`sso.routes.ts`, `ForeignAuthPage`, `obliguard/oblimap/obliance.routes.ts`) a été supprimé. Cette page décrit le flux OAuth réel implémenté côté Obliview.

## Vue d'ensemble du flux

1. Le client charge `LoginPage.tsx`, qui interroge `GET /api/auth/sso-config`.
2. Si Obligate est activé et joignable, le navigateur est redirigé vers `GET /auth/sso-redirect` (endpoint serveur, jamais appelé en `fetch`).
3. `/auth/sso-redirect` génère un `state` CSRF, le stocke en session, puis redirige vers `<obligateUrl>/authorize?client_id=...&redirect_uri=...&state=...`.
4. Après authentification sur Obligate, l'utilisateur revient sur `GET /auth/callback?code=...&state=...`.
5. Le serveur valide le `state`, échange le `code` contre une assertion utilisateur (`obligateService.exchangeCode`), provisionne/synchronise le compte local, établit la session, puis redirige vers `/`.

## Service `obligate.service.ts`

Fichier : `server/src/services/obligate.service.ts`. Toutes les fonctions dépendent de la config stockée en base (`appConfigService.getObligateRaw()` / `getObligateConfig()`) : URL d'Obligate + clé API (`raw.apiKey`, envoyée en `Authorization: Bearer`).

| Fonction | Endpoint distant appelé | Rôle |
|---|---|---|
| `getSsoConfig()` | `GET <obligateUrl>/health` | Vérifie que Obligate est configuré et joignable (timeout 2s) — utilisé par le login |
| `exchangeCode(code, redirectUri)` | `POST /api/oauth/token/exchange` | Échange le code d'autorisation contre une `ObligateUserAssertion` |
| `reportProvision(obligateUserId, remoteUserId)` | `POST /api/apps/report-provision` | Signale à Obligate l'ID local créé pour un utilisateur SSO |
| `registerDeviceLink(uuid, appPath)` | `POST /api/devices/register` | Enregistrement d'appareil pour la navigation croisée (throttle 10 min) |
| `getDeviceLinks(uuid)` | `GET /api/devices/links` | Liens cross-app pour un appareil |
| `syncUserPreferences(localUserId, obligateUserId)` | `GET /api/apps/user-preferences/:id` | Synchronise thème, langue, toast, avatar (throttle 60s) |
| `getConnectedApps(obligateUserId?)` | `GET /api/apps/connected` | Liste des apps Obli* connectées, filtrée par permissions utilisateur |

L'interface `ObligateUserAssertion` contient : `obligateUserId`, `username`, `email`, `displayName`, `role`, `tenants: {slug, role}[]`, `teams: string[]`, `authSource`, `linkedLocalUserId`, `preferences`.

## Endpoints — `obligateCallback.routes.ts`

Fichier : `server/src/routes/obligateCallback.routes.ts`, monté sous `/auth` (callback/redirect) et `/api/auth` (le reste), voir `server/src/routes/index.ts`.

### `GET /auth/sso-redirect`

- Capture optionnellement `?tenant=<slug>` (validé par la regex `^[a-z0-9-]{1,64}$`) dans `req.session.requestedTenantSlug`, pour le "cross-app tenant handoff" (un clic sur le sélecteur de tenant dans une autre app Obli* transmet le tenant cible).
- Vérifie la joignabilité d'Obligate (`GET /health`, timeout 2s) avant de rediriger — évite une boucle de redirection si Obligate est en panne.
- Garde-fou anti-boucle : si `obligate_url` pointe vers l'app elle-même (comparaison des origines), redirection vers `/login?error=sso_misconfigured`.
- Génère un `state` CSRF (`crypto.randomBytes(32).toString('hex')`), le stocke dans `req.session.oauthState`, puis redirige vers :

```
<obligateUrl>/authorize?client_id=<apiKey>&redirect_uri=<selfUrl>/auth/callback&state=<oauthState>
```

La session est sauvegardée explicitement (`req.session.save()`) avant la redirection pour garantir la persistance du `state`.

### `GET /auth/callback`

Implémente la validation du paramètre `state` conformément à la **RFC 6749 §10.12** (protection CSRF du flux d'autorisation) :

```ts
const expectedState = req.session?.oauthState;
if (!expectedState || !state || state !== expectedState) {
  logger.warn(..., 'Obligate callback: state mismatch — possible CSRF');
  res.redirect('/login?error=sso_failed');
  return;
}
delete req.session.oauthState;
```

Étapes suivantes :

1. Reconstruit `redirectUri` à partir de `x-forwarded-proto`/`x-forwarded-host` (ou `req.protocol`/`req.headers.host`).
2. `obligateService.exchangeCode(code, redirectUri)` — échec → redirection `/login?error=sso_failed`.
3. Résolution de l'utilisateur local, par ordre de priorité :
   - `assertion.linkedLocalUserId` si présent et que l'utilisateur existe encore (sinon re-provisioning, avec `reportProvision(obligateUserId, 0)` pour signaler la référence obsolète à Obligate).
   - Sinon recherche dans `sso_foreign_users` par `(foreign_source='obligate', foreign_user_id)`.
   - Sinon création d'un nouvel utilisateur local (provisioning).
4. **Provisioning** d'un nouvel utilisateur SSO :

```ts
await db('users').insert({
  username: `og_${assertion.username}`,
  display_name: assertion.displayName || assertion.username,
  email: assertion.email,
  role: assertion.role === 'admin' ? 'admin' : 'user',
  is_active: true,
  foreign_source: 'obligate',
  foreign_id: assertion.obligateUserId,
  enrollment_version: 999, // saute l'assistant d'enrôlement
});
```

Le préfixe `og_` (Obligate) est systématique sur le `username` stocké — il est retiré à l'affichage côté client (voir plus bas). Un enregistrement est aussi inséré/mis à jour dans `sso_foreign_users` (`onConflict(['foreign_source','foreign_user_id']).merge(...)`), et `reportProvision` renvoie le nouvel ID local à Obligate.

5. **Synchronisation des tenants** : pour chaque `{slug, role}` de `assertion.tenants`, upsert dans `user_tenants` (le `role` correspond à un slug de `permission_set` défini côté Obligate — un slug inconnu ne donne aucune capacité, fail-closed par conception).
6. **Synchronisation des équipes** (`team_memberships`) : résout les noms d'équipes envoyés par Obligate vers des IDs locaux (équipes tenant-locales ou globales via `team_tenant_scopes`), supprime les appartenances obsolètes **dans le périmètre des tenants accessibles à l'utilisateur uniquement** (les affectations manuelles d'un admin dans un tenant hors périmètre ne sont jamais touchées), puis insère les nouvelles.
7. **Synchronisation des préférences** (thème, langue, toast, avatar) directement dans `users.preferences` (JSON) et les colonnes dédiées.
8. Établit la session (`userId`, `username`, `role`).
9. **Tenant handoff cross-app** : si `req.session.requestedTenantSlug` est défini, tente de résoudre ce slug vers un tenant accessible (les admins plateforme ont un accès implicite à tous les tenants, non matérialisé dans `user_tenants` — vérification directe sur `tenants.slug`). Sinon, fallback sur `tenantService.getFirstTenantForUser`.
10. Réponse : redirection HTML via `<meta http-equiv="refresh">` (et non `res.redirect`) pour garantir que le `Set-Cookie` de session est bien traité par le navigateur avant la navigation.

### Autres endpoints exposés

| Méthode | Route | Auth | Rôle |
|---|---|---|---|
| GET | `/api/auth/sso-config` | publique | Config SSO pour `LoginPage` |
| GET | `/api/auth/sso-logout-url` | publique | URL de logout Obligate (`<obligateUrl>/logout?redirect_uri=...`) |
| GET | `/api/auth/app-info` | Bearer (clé API Obligate) | Teams/tenants/permission-sets pour l'UI de mapping côté Obligate |
| GET | `/api/auth/dashboard-stats` | Bearer | Stats agrégées (monitors up/down/paused, agents) pour le dashboard Obligate |
| GET | `/api/auth/connected-apps` | session | Apps Obli* connectées, filtrées par permissions de l'utilisateur |
| GET | `/api/auth/device-links?uuid=` | session | Liens cross-app pour un appareil (ObliTools) |
| POST | `/api/auth/sso-user-sync` | Bearer | Callback Obligate : `deactivate` / `reactivate` / `delete` / `update-role` sur un utilisateur SSO |

Les endpoints à Bearer valident la clé via `authHeader.slice(7) !== raw.apiKey` — authentification inversée (c'est Obligate qui appelle Obliview).

## Côté client — `LoginPage.tsx`

Fichier : `client/src/pages/LoginPage.tsx`. Machine à états `ssoState` : `'checking' | 'redirecting' | 'unavailable' | 'local'`.

- Au montage, vérifie d'abord une session existante (`GET /api/auth/me`) ; si valide, redirection immédiate vers `/`.
- Sinon, appelle `checkSso()` → `GET /api/auth/sso-config`. Si Obligate est activé et joignable, redirection navigateur complète vers `/auth/sso-redirect` (pas un `fetch`, car il faut suivre la redirection 302 jusqu'à Obligate).
- **Garde anti-boucle** : un timestamp `_sso_redirect_ts` est posé dans `sessionStorage` avant la redirection ; si l'utilisateur revient sur `/login` moins de 15 secondes après, l'état passe à `'unavailable'` au lieu de rediriger à nouveau (évite une boucle infinie si Obligate redirige en échec silencieux).
- Si `?error=sso_failed` est présent dans l'URL (renvoyé par `/auth/callback` en cas d'échec), l'état est forcé à `'unavailable'` et aucune redirection SSO automatique n'est tentée — l'utilisateur peut se connecter en local.
- En état `'unavailable'`, un `setInterval` de 60s relance `checkSso()` pour rediriger dès qu'Obligate redevient joignable.

## Traitement des utilisateurs SSO côté UI

Dans `client/src/pages/AdminUsersPage.tsx` :

- Le préfixe `og_` est retiré à l'affichage : `user.username.startsWith('og_') ? user.username.slice(3) : user.username`.
- Un badge **« SSO »** est affiché quand `user.foreignSource === 'obligate'`.
- Le champ nom d'utilisateur du formulaire d'édition est désactivé pour les utilisateurs SSO : `disabled={userFormMode === 'edit' && !!editingUser?.foreignSource}` — le nom d'utilisateur est **immuable** pour ces comptes (la mise à jour du username a également été retirée de `user.service.ts` côté serveur).
- Les actions de suppression/désactivation et le bouton d'assignation de tenant sont masqués pour `foreignSource === 'obligate'` (gérées depuis Obligate).
- Le changement de mot de passe est bloqué pour les utilisateurs SSO.

## Points de conception à retenir

- **Skip enrôlement** : les utilisateurs SSO sont créés avec `enrollment_version: 999`, une valeur volontairement au-delà de la dernière version de l'assistant d'enrôlement, ce qui fait que `ProtectedRoute` (qui compare `enrollmentVersion` à la version courante) considère l'enrôlement comme terminé. `ProtectedRoute` vérifie en complément `foreignSource !== 'obligate'` pour ne jamais renvoyer un utilisateur SSO vers l'assistant.
- **CSRF state** : implémenté aux 4 apps Obli* (Obliview, Obliguard, Oblimap, Obliance) selon le même schéma — génération dans `sso-redirect`, validation dans `callback`, stockage en session.
- Les préférences (thème, langue, toast) sont resynchronisées à **chaque** connexion SSO, pas seulement à la création du compte, via `assertion.preferences` dans le callback et `syncUserPreferences` (appelée en tâche de fond depuis `authController.me`).

## Références

- `server/src/services/obligate.service.ts`
- `server/src/routes/obligateCallback.routes.ts`
- `client/src/pages/LoginPage.tsx`
- `client/src/pages/AdminUsersPage.tsx`
- `client/src/pages/ProfilePage.tsx`
- `client/nginx.conf`
- `server/src/services/auth.service.ts` (`findOrCreateForeignUser`, `AccountLinkRequiredError`)
- `server/src/services/user.service.ts`
