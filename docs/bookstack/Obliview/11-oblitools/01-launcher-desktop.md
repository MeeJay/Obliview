ObliTools est le client lourd multi-plateforme (Windows + macOS) qui héberge les applications de l'écosystème Obli* (Obliview, Obliance, Oblimap, Obliguard) dans des fenêtres natives, avec une barre d'onglets custom au-dessus. Il est écrit en Go, sans Electron ni Tauri : **WebView2** sur Windows, **WKWebView** sur macOS, via le binding `github.com/webview/webview_go`. Le code source vit dans `obli.tools/` (module Go séparé du monorepo npm).

## Architecture générale

Chaque application enregistrée obtient sa propre fenêtre OS (une instance WebView2/WKWebView), avec un cookie store et des connexions WebSocket indépendants. La barre d'onglets (shell) est elle-même une WebView légère, distincte des WebViews d'application :

```
┌─────────────────────────────────────┐  ← Shell WebView (40 px, tab bar HTML)
│  [● App1]  [  App2]  [+ Add]  [⚙]  │    Servie via http://127.0.0.1
├─────────────────────────────────────┤    (voir plus bas : pourquoi localhost)
│                                     │
│        AppView WebView              │  ← Fenêtre séparée, frameless (WS_POPUP)
│    (fenêtre native sans chrome)     │    positionnée sous la tab bar via Win32
│                                     │    Owner = shell HWND → suit minimize/close
└─────────────────────────────────────┘
```

- **Shell** : fenêtre principale avec chrome natif (barre de titre, bordure DWM colorée), contient uniquement la barre d'onglets HTML.
- **AppView** : une fenêtre par app, `WS_POPUP + WS_THICKFRAME` (sans titre, sans entrée dans la taskbar), dont le owner Win32 est le HWND du shell — elle suit donc automatiquement le minimize/close/déplacement du shell.
- `stripWindowChrome()` (`obli.tools/platform_windows.go`) retire la caption et le système menu de la fenêtre tout en conservant `WS_THICKFRAME` pour permettre le redimensionnement par les bords.
- `positionAppWindow()` place la fenêtre d'app à `Y = 40px` sous la barre, avec largeur/hauteur = client shell moins 40 px.
- Un `startPositionSyncLoop()` (goroutine, `time.NewTicker(50 * time.Millisecond)`) repositionne en continu les fenêtres d'app sous le shell, les cache quand le shell est minimisé, et les cache aussi pendant que le panneau de gestion des environnements est ouvert (`managePanelOpen` atomic bool).

Chaque `AppView` (struct Go dans `main.go`) encapsule :

```go
type AppView struct {
    Entry AppEntry
    mu    sync.Mutex
    view  webview.WebView
    hwnd  uintptr
}
```

Le lancement d'une fenêtre d'app (`launchAppView`) tourne sur sa propre goroutine avec `runtime.LockOSThread()` (obligatoire : chaque WebView a besoin de sa propre boucle de messages Win32), puis bloque dans `v.Run()` jusqu'à ce que la fenêtre soit détruite.

## Pourquoi un serveur localhost pour le shell

WebView2 bloque silencieusement l'exécution des `<script>` inline sur les pages chargées via `about:`, `data:` ou `file://` dans de nombreuses configurations. Pour contourner cela, `startLocalServer()` (`main.go`) démarre un mini serveur HTTP Go sur `127.0.0.1:0` (port aléatoire) qui sert le HTML de la barre d'onglets :

```go
func startLocalServer() {
    mux := http.NewServeMux()
    mux.HandleFunc("/", func(rw http.ResponseWriter, r *http.Request) {
        shellMu.Lock()
        content := shellHTMLStore
        shellMu.Unlock()
        rw.Header().Set("Content-Type", "text/html; charset=utf-8")
        rw.Header().Set("Cache-Control", "no-store")
        fmt.Fprint(rw, content)
    })
    ln, _ := net.Listen("tcp", "127.0.0.1:0")
    shellServeURL = fmt.Sprintf("http://127.0.0.1:%d/", ln.Addr().(*net.TCPAddr).Port)
    go func() { _ = http.Serve(ln, mux) }()
}
```

`navigateShell(html)` stocke le HTML courant dans `shellHTMLStore` (protégé par `shellMu`), incrémente `shellNavSeq`, puis appelle `shellView.Navigate("http://127.0.0.1:<port>/?v=<seq>")` — le `?v=` force une vraie navigation à chaque changement d'état (sinon WebView2 pourrait servir une version en cache).

Tous les scripts injectés (`overlayJS`, `tabBarJS`) commencent par vérifier `location.hostname==='127.0.0.1'||location.hostname==='localhost'` et sortent immédiatement : ils ne doivent jamais s'exécuter sur la page shell elle-même, seulement dans les WebViews d'application.

## Configuration persistée

Chemin : `%APPDATA%\ObliTools\config.json` (Windows) / `~/Library/Application Support/ObliTools/config.json` (macOS), résolu par `configPath()` dans `obli.tools/config.go` via `os.UserConfigDir()`.

```json
{
  "url": "https://obliview.example.com",
  "environments": [
    {
      "name": "Default",
      "apps": [
        { "name": "Obliview", "url": "https://obliview.example.com", "color": "#00d4ff", "lastUrl": "/monitors" }
      ]
    }
  ],
  "activeEnvIdx": 0,
  "width": 1440,
  "height": 900,
  "downloadDir": "C:\\Users\\user\\Downloads",
  "tabConfig": {
    "autoCycleEnabled": false,
    "autoCycleIntervalS": 30,
    "followAlertsEnabled": false,
    "nativeNotificationsEnabled": false
  }
}
```

Structures Go (`config.go`) :

| Type | Champs clés | Rôle |
|---|---|---|
| `AppEntry` | `Name`, `URL`, `Color`, `LastURL` | Une application enregistrée |
| `Environment` | `Name`, `Apps []AppEntry` | Groupe d'apps (ex. "Perso", "Taff") — correspond typiquement à un déploiement |
| `TabConfig` | `AutoCycleEnabled`, `AutoCycleIntervalS`, `FollowAlertsEnabled`, `NativeNotificationsEnabled` | Préférences de cycling multi-tenant (voir page 2) |
| `Config` | `URL` (déprécié), `Apps` (déprécié), `Environments`, `ActiveEnvIdx`, `Width`, `Height`, `DownloadDir`, `TabConfig` | Racine persistée |

Points importants :

- **`color` n'est jamais stocké comme source de vérité** : `loadConfig()` recalcule `appColorFromURL()` pour chaque app à chaque démarrage, afin de corriger automatiquement toute valeur obsolète.
- **Migration automatique** : les anciennes configs à plat (`Apps []AppEntry`, sans `Environments`) sont migrées en un environnement unique `"Default"` lors du chargement. Si seul `URL` était renseigné (version encore plus ancienne), un environnement + une app sont synthétisés à partir de cette URL.
- `Config.AllApps()` aplatit toutes les apps de tous les environnements ; `GlobalAppIndex(envIdx, localIdx)` / `EnvOfGlobalIdx(globalIdx)` convertissent entre index local (par environnement) et index global (liste aplatie) — utilisés partout où le shell doit savoir "quel est l'onglet actif dans la liste globale".
- `saveConfig()` écrit le fichier avec permission `0o600` (lecture/écriture propriétaire uniquement).

## Découverte du manifeste applicatif

Après connexion, le script `overlayJS` injecté dans chaque WebView d'application interroge `GET /api/oblitools/manifest` (route serveur `server/src/routes/oblitools.routes.ts`, protégée par `requireAuth`) :

```ts
router.get('/manifest', requireAuth, async (_req, res, next) => {
  const apps = await obligateService.getConnectedApps();
  const linkedApps = apps
    .filter(a => a.appType !== 'obliview')
    .map(a => ({ name: a.name, url: a.baseUrl, color: a.color ?? '#6366f1' }));
  res.json({ success: true, data: { name: 'Obliview', color: '#6366f1', ssoPath: '/auth/sso-redirect', linkedApps } });
});
```

La liste des apps liées provient désormais de `obligateService.getConnectedApps()` (gateway Obligate — voir `D:\Obligate\CLAUDE.md`), et non plus d'une configuration statique obliguard/oblimap/obliance codée en dur (ancienne architecture SSO supprimée en Phase 20). Côté client, la fonction `__go_proposeLinkedApps` (bindée par Go) reçoit ce tableau 4 secondes après le chargement de page et ajoute automatiquement les apps non déjà connues dans le même `Environment` que l'app appelante :

```js
setTimeout(function(){
  fetch('/api/oblitools/manifest',{credentials:'include'})
    .then(function(r){if(!r.ok)throw r;return r.json();})
    .then(function(d){
      var linked=d&&d.data&&d.data.linkedApps;
      if(!Array.isArray(linked)||!linked.length)return;
      if(typeof window.__go_proposeLinkedApps==='function')
        window.__go_proposeLinkedApps(linked).catch(function(){});
    }).catch(function(){});
},4000);
```

Côté Go, `__go_proposeLinkedApps` (bind dans `setupAppBindings`, `main.go`) retrouve l'environnement de l'app appelante via son origine (`originOf(av.Entry.URL)`), ajoute les apps proposées absentes (comparaison par `sameOrigin`), sauvegarde la config, relance `reconcileAppViews()` puis reconstruit la barre d'onglets shell.

## Cycle de vie d'une fenêtre d'application

`reconcileAppViews(newApps, cfg)` (`main.go`) fait le diff entre la liste d'apps courante et la nouvelle liste (ajout d'app, suppression d'app, changement de config d'un environnement) :

- Une app dont l'origine existe déjà → l'`AppView` existante est mise à jour en place (WebView conservée, pas de rechargement).
- Une app nouvelle → une nouvelle goroutine `launchAppView` est démarrée.
- Une app retirée → `tv.Destroy()` est appelé sur sa WebView, ce qui fait sortir `v.Run()` et termine la goroutine.

`launchAppView` applique dans l'ordre : suppression du chrome Win32, définition du shell comme owner, couleur de bordure DWM (`setWindowBorderColor` via `DWMWA_BORDER_COLOR`, no-op silencieux sur Windows 10), positionnement initial (visible seulement si c'est l'app active), icône de fenêtre, bindings JS↔Go (`setupAppBindings`), injection de `overlayJS` + `tabBarJS` via `v.Init()`, puis navigation vers l'URL de l'app — en restaurant `LastURL` si disponible (sauf chemins `/auth/*`, exclus pour éviter de rejouer un callback SSO).

## Références

- `obli.tools/main.go` — shell WebView, serveur localhost, AppView, bindings JS↔Go, reconcileAppViews, position sync loop
- `obli.tools/config.go` — `AppEntry`, `Environment`, `TabConfig`, `Config`, migration, `loadConfig`/`saveConfig`
- `obli.tools/platform_windows.go` — Win32 : `stripWindowChrome`, `positionAppWindow`, bordure DWM
- `obli.tools/download.go` — téléchargement et révélation de fichiers natifs
- `obli.tools/CLAUDE.md` — documentation d'architecture du launcher
- `server/src/routes/oblitools.routes.ts` — `GET /api/oblitools/manifest`
- `server/src/services/obligate.service.ts` — `getConnectedApps()`
