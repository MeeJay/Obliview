Les liens croisés entre applications de l'écosystème Obli* (Obliview, Obliance, Oblimap, Obliguard) reposaient historiquement sur des routes dédiées côté serveur (`obliguard.routes.ts`, `oblimap.routes.ts`, `obliance.routes.ts`) avec configuration statique d'URLs et clés API par app. Cette architecture a été **supprimée en Phase 20** au profit d'une intégration centralisée via la gateway **Obligate** (dépôt séparé `D:\Obligate`). ObliTools et Obliview interrogent désormais Obligate pour découvrir dynamiquement les apps liées, au lieu de coder en dur des URLs par app.

## Configuration Obligate (appConfig)

La configuration de la gateway est stockée dans la table `app_config` (clé/valeur), gérée par `server/src/services/appConfig.service.ts` :

```ts
const OBLIGATE_CONFIG_KEY = 'obligate_config';

async getObligateConfig(): Promise<ObligateConfig> {
  const raw = await this.get(OBLIGATE_CONFIG_KEY);
  const enabled = await this.get('obligate_enabled');
  if (!raw) return { url: null, apiKeySet: false, enabled: enabled === 'true' };
  const cfg = JSON.parse(raw) as { url?: string; apiKey?: string };
  return { url: cfg.url ?? null, apiKeySet: !!cfg.apiKey, enabled: enabled === 'true' };
}

async getObligateRaw(): Promise<{ url: string | null; apiKey: string | null }> {
  // ... renvoie l'apiKey en clair, réservé à un usage serveur-à-serveur
}
```

`getObligateConfig()` ne renvoie jamais la clé API en clair (seulement `apiKeySet: boolean`) — utilisé pour l'écran d'admin de configuration. `getObligateRaw()` renvoie la clé en clair et n'est appelé que côté serveur pour signer les requêtes sortantes vers Obligate (`Authorization: Bearer <apiKey>`).

## Le service obligate.service.ts

`server/src/services/obligate.service.ts` centralise tous les appels sortants vers Obligate :

| Fonction | Endpoint Obligate | Rôle |
|---|---|---|
| `getSsoConfig()` | `GET /health` | Vérifie que la gateway est joignable (timeout 2 s) |
| `exchangeCode(code, redirectUri)` | `POST /api/oauth/token/exchange` | Échange un code OAuth contre l'identité utilisateur (login SSO) |
| `reportProvision(obligateUserId, remoteUserId)` | `POST /api/apps/report-provision` | Signale qu'un utilisateur SSO a été provisionné localement |
| `registerDeviceLink(uuid, appPath)` | `POST /api/devices/register` | Enregistre un lien "device UUID → chemin dans cette app", pour navigation croisée |
| `getDeviceLinks(uuid)` | `GET /api/devices/links?uuid=` | Récupère les liens vers d'autres apps pour un device donné |
| `syncUserPreferences(localUserId, obligateUserId)` | `GET /api/apps/user-preferences/:id` | Synchronise thème / langue / toast / avatar depuis Obligate (throttle 60 s) |
| `getConnectedApps(obligateUserId?)` | `GET /api/apps/connected` | Liste des apps connectées, filtrée par permissions utilisateur si `obligateUserId` fourni |

Toutes les méthodes échouent silencieusement (`catch { return [] }` / `return null`) si Obligate n'est pas configuré ou injoignable — l'app continue de fonctionner sans intégration cross-app.

## Enregistrement des liens d'appareil (agents)

Quand un agent pousse ses métriques, `server/src/services/agent.service.ts` enregistre (de façon asynchrone et non bloquante) un lien device → page de détail :

```ts
obligateService.registerDeviceLink(deviceUuid, `/agents/${device.id}`).catch(() => {});
```

`registerDeviceLink` est throttlé à un appel toutes les 10 minutes par UUID (`_linkThrottle: Map<string, number>`), et ne met à jour le throttle qu'en cas de succès — un échec réseau relance automatiquement une tentative au prochain push. Cela permet à Obligate de savoir, pour un appareil physique donné (identifié par son UUID matériel stable), quelle page de quelle app il faut ouvrir dans chaque application connectée (typiquement : Obliview a le détail de l'agent, une autre app peut avoir une vue liée sur le même device).

## Récupération et affichage des liens croisés

### Route serveur

`server/src/routes/obligateCallback.routes.ts` expose :

```ts
// GET /api/auth/device-links?uuid=xxx
router.get('/device-links', async (req, res) => {
  if (!req.session?.userId) { res.status(401).json({ success: false }); return; }
  const uuid = req.query.uuid as string;
  if (!uuid) { res.json({ success: true, data: [] }); return; }
  const links = await obligateService.getDeviceLinks(uuid);
  res.json({ success: true, data: links });
});

// GET /api/auth/connected-apps (implicite plus haut dans le fichier)
// résout obligateUserId depuis users.foreign_source==='obligate' && foreign_id,
// puis appelle obligateService.getConnectedApps(obligateUserId)
```

`getConnectedApps` reçoit l'`obligateUserId` de l'utilisateur courant (résolu via `users.foreign_source` / `foreign_id`) afin qu'Obligate ne renvoie que les apps sur lesquelles l'utilisateur a au moins une permission (ou toutes les apps s'il est admin plateforme).

### Consommation côté client — AgentDetailPage

`client/src/pages/AgentDetailPage.tsx` affiche ces liens sous forme de petits boutons colorés dans la barre d'outils de la page :

```tsx
const [crossAppLinks, setCrossAppLinks] = useState<Array<{ appType: string; name: string; url: string; color: string | null }>>([]);

useEffect(() => {
  if (!device?.uuid) return;
  fetch(`/api/auth/device-links?uuid=${encodeURIComponent(device.uuid)}`, { credentials: 'include' })
    .then(r => r.json())
    .then(d => { if (d.success && d.data) setCrossAppLinks(d.data); })
    .catch(() => {});
}, [device?.uuid]);
```

```tsx
{crossAppLinks.map(link => (
  <a key={link.appType} href={link.url} target="_blank" rel="noopener noreferrer"
     title={`Open in ${link.name}`}
     style={{ color: link.color ?? '#58a6ff', borderColor: `${link.color ?? '#58a6ff'}40`,
              backgroundColor: `${link.color ?? '#58a6ff'}0d` }}>
    <ArrowLeftRight size={12} />
    {link.name}
  </a>
))}
```

Chaque lien pointe vers l'URL exacte de la page équivalente dans l'app cible (ex. la même fiche agent/device dans Obliguard). Le lien s'ouvre normalement en nouvel onglet navigateur (`target="_blank"`) — mais quand la page est rendue **à l'intérieur d'une fenêtre ObliTools**, l'interception cross-app de `overlayJS` (voir page précédente, `maybeIntercept`/`__go_openInAppTab`) capture la navigation avant qu'elle n'atteigne le navigateur système, et l'ouvre dans la fenêtre native de l'app cible si elle est déjà enregistrée dans l'environnement courant du launcher.

## Manifeste ObliTools et découverte d'apps liées

Le pont entre « ce que le serveur Obliview sait des apps connectées via Obligate » et « ce qu'ObliTools affiche comme onglets » est la route `GET /api/oblitools/manifest` (voir page 1) : elle réutilise `obligateService.getConnectedApps()` pour construire dynamiquement la liste `linkedApps` consommée par `__go_proposeLinkedApps` côté launcher. Il n'existe donc plus, dans le code actuel, de configuration séparée « appConfig pour URLs+API keys par app Obliguard/Oblimap/Obliance » : une unique configuration Obligate (`obligate_config` dans `app_config`) sert de source pour toute la découverte cross-app, que ce soit pour le SSO, les liens d'agents, ou les onglets du launcher desktop.

## Références

- `server/src/services/obligate.service.ts` — `getConnectedApps`, `registerDeviceLink`, `getDeviceLinks`, `exchangeCode`
- `server/src/services/appConfig.service.ts` — `getObligateConfig`, `getObligateRaw`, `patchObligateConfig`, clé `obligate_config` dans `app_config`
- `server/src/routes/obligateCallback.routes.ts` — `/api/auth/device-links`, `/api/auth/connected-apps`, `/api/auth/sso-user-sync`
- `server/src/routes/oblitools.routes.ts` — `GET /api/oblitools/manifest`
- `server/src/services/agent.service.ts` — appel `registerDeviceLink` lors du push agent
- `client/src/pages/AgentDetailPage.tsx` — affichage des `crossAppLinks`
- `obli.tools/main.go` — interception de navigation cross-app (`maybeIntercept`, `__go_openInAppTab`)
