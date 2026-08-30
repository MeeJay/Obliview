L'authentification locale d'Obliview repose sur des sessions Express stockées en PostgreSQL, un flux de connexion en deux étapes lorsque la 2FA est activée (TOTP ou OTP par e-mail), et une réinitialisation de mot de passe par jeton envoyé par e-mail. Cette page décrit l'implémentation réelle : services, contrôleurs, routes, tables et middleware.

## Modèle de session

Les sessions sont gérées par `express-session` avec `connect-pg-simple` comme store, configuré dans `server/src/app.ts`. La table `session` est créée par la migration `server/src/db/migrations/002_create_sessions.ts` (gérée par `connect-pg-simple`, avec un index sur `expire`).

Points clés de la configuration du cookie (`server/src/app.ts`) :

| Option | Valeur | Raison |
|---|---|---|
| `secure` | `config.forceHttps` | Requis avec `SameSite=None` |
| `sameSite` | `'none'` si HTTPS, sinon `'lax'` | Permet l'intégration iframe cross-site d'ObliTools en HTTPS |
| `partitioned` | `config.forceHttps` | CHIPS — nécessaire à Chrome/Edge 115+ pour les cookies tiers partitionnés en iframe |
| `httpOnly` | `true` | Protection XSS |

Comme les navigateurs (notamment le shell WebView2 d'ObliTools, cf. `obli.tools/main.go`) bloquent parfois tous les cookies en contexte iframe cross-site, le serveur retourne aussi `sessionToken` (= `req.sessionID`) dans la réponse de login. Le client peut alors l'envoyer via l'en-tête `X-Auth-Token` sur chaque requête ; un middleware dédié dans `app.ts` relit ce header, recharge la session depuis `sessionStore.get()` et peuple `req.session` comme si le cookie avait été transmis.

```ts
// server/src/app.ts
app.use((req, _res, next) => {
  if (req.session?.userId) return next(); // déjà authentifié via cookie
  const token = req.headers['x-auth-token'];
  if (!token || typeof token !== 'string') return next();
  sessionStore.get(token, (err, sessionData) => { /* ... */ });
});
```

## Service d'authentification

`server/src/services/auth.service.ts` expose `authService` :

- `authenticate(username, password)` — recherche l'utilisateur actif par `username`, refuse si `password_hash` est `null` (compte SSO sans mot de passe local), compare via `comparePassword` (bcrypt, `server/src/utils/crypto.ts`).
- `getUserById(id)`
- `createUser(username, password, role, displayName)`
- `findOrCreateForeignUser(...)` — utilisé par le flux SSO Obligate (voir la page dédiée), gère la table `sso_foreign_users` et lève `AccountLinkRequiredError` en cas de collision de nom d'utilisateur avec un compte local possédant déjà un mot de passe.
- `ensureDefaultAdmin(username, password)` — crée l'admin par défaut au démarrage si aucun `role='admin'` n'existe.

## Flux de connexion (`authController.login`)

Fichier : `server/src/controllers/auth.controller.ts`.

1. `authService.authenticate` valide les identifiants.
2. Si `user.totpEnabled || user.emailOtpEnabled` (MFA active) :
   - `req.session.pendingMfaUserId = user.id` — la session réelle n'est **pas** encore créée.
   - Si l'OTP e-mail est actif et qu'un SMTP OTP (`app_config.otp_smtp_server_id`) est configuré, un code à 6 chiffres est généré (`twoFactorService.generateEmailOtp()`) et stocké dans `req.session.pendingEmailOtp = { code, email, expires }` (expiration 10 minutes), puis envoyé par e-mail.
   - Réponse : `{ requires2fa: true, methods: { totp, email } }`.
3. Sinon, la session est complétée immédiatement : `req.session.userId/username/role`, résolution du tenant via `setSessionTenant()` (`tenantService.getFirstTenantForUser`, fallback tenant `1`), puis réponse avec `user` + `sessionToken`.

## Vérification de la 2FA

Routes : `server/src/routes/twoFactor.routes.ts`, montées sous `/api/profile/2fa` (routes profil, authentifiées) et via les mêmes contrôleurs pour les routes post-login (non authentifiées, la session ne porte que `pendingMfaUserId`).

| Méthode | Route | Contrôleur | Description |
|---|---|---|---|
| GET | `/api/profile/2fa/status` | `status` | État TOTP/e-mail de l'utilisateur connecté |
| POST | `/api/profile/2fa/totp/setup` | `totpSetup` | Génère secret + QR code (stockés en session `pendingTotpSecret`) |
| POST | `/api/profile/2fa/totp/enable` | `totpEnable` | Vérifie le code, persiste `totp_secret`/`totp_enabled=true` |
| DELETE | `/api/profile/2fa/totp` | `totpDisable` | Désactive le TOTP |
| POST | `/api/profile/2fa/email/setup` | `emailSetup` | Envoie un code de vérification à l'adresse fournie |
| POST | `/api/profile/2fa/email/enable` | `emailEnable` | Vérifie le code, persiste `email`/`email_otp_enabled=true` |
| DELETE | `/api/profile/2fa/email` | `emailDisable` | Désactive l'OTP e-mail |
| POST | `/api/profile/2fa/verify` | `verify` | Étape 2 du login — valide le code TOTP ou e-mail |
| POST | `/api/profile/2fa/resend-email` | `resendEmail` | Regénère un code OTP e-mail pendant le login |

Toutes les routes 2FA liées à l'authentification passent par `authLimiter` (`server/src/middleware/rateLimiter.ts`) : fenêtre de 5 minutes, 20 tentatives échouées max, clé = IP + username, `skipSuccessfulRequests: true`.

### TOTP (`server/src/services/twoFactor.service.ts`)

Basé sur la librairie `otpauth` :

```ts
generateTotpSecret(username) // OTPAuth.Secret(size:20) + OTPAuth.TOTP({ issuer: config.appName, algorithm:'SHA1', digits:6, period:30 })
verifyTotp(secret, code)     // totp.validate({ token, window: 2 }) — tolère ±60s de dérive d'horloge
```

Le QR code est généré via `qrcode` (`generateTotpQr` → `QRCode.toDataURL(uri)`).

### OTP e-mail

`generateEmailOtp()` produit un code à 6 chiffres (`100000`–`999999`). `sendEmailOtp(smtpServerId, toEmail, code)` récupère la configuration SMTP via `smtpServerService.getById()` et envoie l'e-mail via `nodemailer`. Le SMTP utilisé pour l'OTP est celui référencé par `app_config.otp_smtp_server_id` (`server/src/services/appConfig.service.ts`), distinct des SMTP servers utilisés comme canaux de notification.

Lors de `verify` (`twoFactorController.verify`), selon `method` :
- `'totp'` → `twoFactorService.verifyTotp(row.totp_secret, code)`
- `'email'` → compare au `pendingEmailOtp` stocké en session (code + expiration)

En cas de succès, la session réelle est établie (`userId`, `username`, `role`), `pendingMfaUserId`/`pendingEmailOtp` sont supprimés, et le tenant est résolu comme pour le login sans MFA.

### Table `users` (colonnes 2FA)

Migration `server/src/db/migrations/031_users_2fa.ts` :

```sql
ALTER TABLE users ADD COLUMN email VARCHAR(255);
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN email_otp_enabled BOOLEAN NOT NULL DEFAULT false;
```

### 2FA forcée (`force_2fa`)

Dans `authController.me`, si `app_config.force_2fa` est actif et que l'utilisateur n'a ni TOTP ni OTP e-mail activés (et que `config.disable2faForce` n'est pas positionné), la réponse renvoie `requires2faSetup: true` pour que le client redirige vers la configuration 2FA.

## Réinitialisation de mot de passe par e-mail

Service : `server/src/services/passwordReset.service.ts`. Table : `password_reset_tokens` (créée par la migration `server/src/db/migrations/038_enrollment_and_language.ts`).

Routes publiques (`server/src/routes/auth.routes.ts`, protégées par `authLimiter` sur `forgot-password`) :

```http
POST /api/auth/forgot-password        { email }
POST /api/auth/reset-password/validate { token }
POST /api/auth/reset-password          { token, newPassword }
```

Détails d'implémentation :

- `requestReset(email)` : ne révèle jamais si l'e-mail existe (anti-énumération, retourne toujours succès). Invalide les jetons existants non utilisés (`used_at IS NULL`) pour l'utilisateur, génère un jeton aléatoire de 32 octets (`crypto.randomBytes`), stocke uniquement son hash SHA-256 (`token_hash`), avec une expiration d'1 heure (`TOKEN_EXPIRY_MS`). L'e-mail contient un lien `${config.appUrl}/reset-password?token=<rawToken>` et est envoyé via le SMTP OTP (`app_config.otp_smtp_server_id`).
- `validateToken(rawToken)` : recherche par hash, exige `used_at IS NULL` et `expires_at > NOW()`.
- `resetPassword(rawToken, newPassword)` : dans une transaction, met à jour `password_hash` et marque le jeton `used_at`.

## Références

- `server/src/services/auth.service.ts`
- `server/src/controllers/auth.controller.ts`
- `server/src/routes/auth.routes.ts`
- `server/src/services/twoFactor.service.ts`
- `server/src/controllers/twoFactor.controller.ts`
- `server/src/routes/twoFactor.routes.ts`
- `server/src/services/passwordReset.service.ts`
- `server/src/controllers/passwordReset.controller.ts`
- `server/src/middleware/auth.ts`
- `server/src/middleware/rateLimiter.ts`
- `server/src/app.ts`
- `server/src/db/migrations/002_create_sessions.ts`
- `server/src/db/migrations/031_users_2fa.ts`
- `server/src/db/migrations/038_enrollment_and_language.ts`
