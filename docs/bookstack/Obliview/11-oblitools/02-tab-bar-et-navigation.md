ObliTools injecte deux couches de JavaScript dans chaque WebView d'application, via `v.Init()` (exécuté à chaque chargement de page, avant que le contenu ne s'affiche) : `overlayJS` (drapeaux natifs, sons, navigation cross-app) puis `tabBarJS` (barre d'onglets par tenant). Les deux constantes vivent dans `obli.tools/main.go`.

## overlayJS — drapeaux natifs et interceptions

`overlayJS` s'auto-garde contre une double injection (`window.__ov_injected`) et ignore les pages non http(s) ainsi que la page shell (`127.0.0.1`/`localhost`). Il pose d'abord des drapeaux globaux reconnus par toutes les apps React Obli* pour masquer leurs bannières de téléchargement web :

```js
window.__obliview_is_native_app=window.__obliance_is_native_app=
  window.__oblimap_is_native_app=window.__obliguard_is_native_app=true;
```

### Suivi de la dernière URL visitée

`overlayJS` patche `history.pushState`/`history.replaceState` et écoute `popstate` pour appeler `reportURL()` après chaque navigation SPA. Le chemin courant (`pathname + search + hash`) est envoyé au binding Go `__go_saveAppLastURL(origin, path)`, sauf sur les routes d'authentification (`/auth/*`, `/login`, `/enrollment`, `/forgot-password`, `/reset-password`, `/reset`) pour ne jamais persister une URL de callback SSO. Côté Go (`setupAppBindings`), ce binding met à jour `AppEntry.LastURL` dans la config et la sauvegarde — c'est ce qui permet de rouvrir une app exactement sur la page quittée.

### Comptage d'alertes non lues

Toutes les 30 secondes (après un délai initial de 4 s), `reportAlerts()` interroge `GET /api/live-alerts/all` et calcule le nombre d'alertes non lues (`!a.read_at && !a.readAt && !a.read`). Ce compte est transmis à Go via `__go_reportAlertCount(origin, n)`, qui alimente `alertCache` (map `url → int`, protégée par `alertCacheMu`) — lu ensuite par la barre d'onglets shell via `getAlertCounts()`. La fonction détecte aussi les *nouvelles* alertes (IDs absents de `_seenAlertIds`) pour déclencher une notification native via `__go_nativeNotify`.

### Interception de navigation cross-app

Quand une app React appelle `location.replace()`, `location.assign()`, ou modifie `location.href`, ou encore `window.open()` avec une URL d'origine différente, `overlayJS` intercepte l'appel plutôt que de laisser la WebView courante naviguer hors de son app :

```js
function maybeIntercept(href){
  if(!href)return false;
  try{
    var u=new URL(String(href),location.href);
    if(u.origin!==location.origin&&/^https?:$/.test(u.protocol)){
      if(typeof window.__go_openInAppTab==='function')
        window.__go_openInAppTab(u.href).catch(function(){});
      return true;
    }
  }catch(e){}
  return false;
}
```

L'interception patche `Location.prototype.href` (setter), `location.replace`, `location.assign` et `window.open`. Côté Go, `__go_openInAppTab(rawURL)` (dans `setupAppBindings`) : résout l'origine cible, retrouve l'`AppView` correspondante dans `allAppViews` (comparaison `sameOrigin`), navigue cette WebView vers l'URL complète via `tv.Dispatch(func(){ tv.Navigate(navURL) })`, met à jour `activeAppIdx`/`cfg.ActiveEnvIdx`, appelle `shellView.Eval("window.__ot_setActiveTab(idx)")` pour rafraîchir visuellement l'onglet actif dans le shell, puis affiche/masque les fenêtres d'app en conséquence. C'est le mécanisme utilisé par les liens croisés (ex. « Ouvrir dans Obliguard » sur `AgentDetailPage`) : ils ouvrent dans la fenêtre d'app existante plutôt que de casser la navigation.

## tabBarJS — barre d'onglets par tenant (multi-tenant)

`tabBarJS` s'exécute après `overlayJS` et gère un cas différent de la barre du shell : le multi-tenant *au sein d'une même app*. Elle se désactive dans plusieurs situations : page shell (`127.0.0.1`), pages d'authentification, exécution dans un iframe (`window!==window.top` — le shell ObliTools gère déjà le changement d'app dans ce cas), ou lorsqu'un seul tenant est disponible (`tenants.length<=1`).

Bootstrap asynchrone : appel parallèle à `GET /api/tenants` et `GET /api/auth/me`, puis à `window.__go_getTabConfig()` pour récupérer `TabConfig`. Une fois les tenants connus, `window.__ov_native_tabs=true` est posé (ce qui permet au `TenantSwitcher` React de se masquer côté app, la barre native le remplaçant), et `#root` est décalé de 40 px vers le bas via une balise `<style>` injectée.

### Construction de la barre

`injectBar()` construit un `<div id="__ov_bar">` fixe en haut (z-index `2147483640`) contenant :
- Un logo SVG (couleur d'accent déterminée par `_appAccent`, calculée depuis `location.hostname` — violet `#a78bfa` pour Obliance, vert `#10b981` pour Oblimap, orange `#fb923c` pour Obliguard, bleu `#3b82f6` par défaut).
- Un onglet par tenant, avec un badge rouge d'alertes non lues (`__ov_tb_<tenantId>`), cliquable → `switchTo(tenantId)`.
- Un bouton « Alerts » texte seul (sans icône cloche), badge global `__ov_nb`, ouvre le panneau de notifications.
- Un bouton engrenage de cycle automatique, dont la couleur reflète l'état actif (`autoCycleEnabled || followAlertsEnabled`).

`switchTo(tenantId)` fait `POST /api/tenant/switch` puis navigue vers `/` (jamais vers la page courante) — choix délibéré : rester sur `/` évite que l'app marque les alertes comme lues avant que le mode *follow-alerts* ait pu les détecter dans un autre tenant.

### Panneau de notifications cross-tenant

`toggleAlertPanel()` affiche un panneau latéral (370 px) qui charge `GET /api/live-alerts/all` (endpoint cross-tenant, sans `requireTenant`), liste jusqu'à 80 alertes avec badge du nom de tenant sur chaque entrée, timestamp relatif (`timeAgo`), et un point de couleur par sévérité (`down`→rouge, `up`→bleu, `warning`→orange, `info`→indigo). Cliquer une alerte marque `PATCH /api/live-alerts/:id/read` ; si l'alerte appartient à un autre tenant, le chemin de destination (`al.navigateTo`) est stocké dans `localStorage['__ov_pnav']` puis `switchTo()` est appelé — au chargement suivant, `tabBarJS` consomme `__ov_pnav` en tout début de script (avant même le bootstrap) pour rediriger directement vers la page ciblée (deep-link cross-tenant).

### Deux modes de cycle automatique, indépendants

`openCycleDlg()` ouvre une modale avec trois interrupteurs indépendants (persistés via `__go_saveTabConfig`) :

| Réglage | Comportement |
|---|---|
| **Changement automatique** | Round-robin toutes les `autoCycleIntervalS` secondes (15 s / 30 s / 1 / 2 / 5 / 10 min) |
| **Suivre les nouvelles alertes** | Bascule immédiatement vers le tenant qui reçoit une alerte non lue |
| **Notifications système** | Déclenche une notification OS native (Windows Toast / macOS Notification Center) sur nouvelle alerte |

`startCyclers()` gère les deux minuteries indépendamment via `setTimeout` (pas `setInterval`, pour pouvoir les annuler/recréer proprement) :

- **AutoCycle** : un seul `setTimeout` qui, à expiration, calcule le tenant suivant (`(idx+1) % tenants.length`) et appelle `switchTo()` — le rechargement de page relance les deux minuteries à zéro.
- **FollowAlerts** : prend d'abord une *baseline* des IDs d'alertes non lues 5 s après le chargement, puis interroge `/api/live-alerts/all` toutes les 15 s ; si une alerte non lue *nouvelle* et provenant d'un *autre* tenant apparaît, il annule l'auto-cycle en cours (`clearTimeout(window.__ov_act)`) et bascule immédiatement.

Les deux modes peuvent être actifs simultanément et sont stockés par appareil (dans `config.json`, pas côté serveur).

## Sons de notification synthétisés

`overlayJS` définit une fonction `tone(freq, type, duration, volume)` basée sur la Web Audio API (`OscillatorNode` + `GainNode` avec `exponentialRampToValueAtTime` pour l'enveloppe de fondu) — aucun fichier audio n'est chargé, tout est généré en mémoire :

| Événement | Séquence de tons |
|---|---|
| `probe_down` | carré 440 Hz (0.12 s) puis carré 290 Hz (0.24 s), décalé de 115 ms |
| `probe_up` | sinus 440 Hz puis sinus 660 Hz, décalé de 125 ms |
| `agent_alert` | triangle 880 Hz × 2 puis triangle 1100 Hz, décalés de 145/290 ms |
| `agent_fixed` | sinus 523/659/784 Hz (do-mi-sol), décalés de 115/230 ms |

Les apps React émettent un `CustomEvent('obliview:notify', { detail: { type: 'probe_down' | ... } })` que `overlayJS` écoute (`window.addEventListener`) pour jouer le son correspondant.

## Notifications OS natives

Indépendamment des sons web, `__go_nativeNotify(origin, title, body)` (bind Go) déclenche une notification système réelle si `TabConfig.NativeNotificationsEnabled` est actif. Un throttle par origine (`notifyThrottle map[string]time.Time`, cooldown 30 s défini par `notifyCooldown`) évite le spam. L'implémentation est spécifique à la plateforme : `obli.tools/notify_windows.go` (Windows Toast) et `obli.tools/notify_darwin.go` (Notification Center macOS), avec un stub `notify_other.go` pour Linux.

## Références

- `obli.tools/main.go` — constantes `overlayJS` et `tabBarJS`, bindings `__go_saveAppLastURL`, `__go_reportAlertCount`, `__go_nativeNotify`, `__go_openInAppTab`, `__go_getTabConfig`, `__go_saveTabConfig`
- `obli.tools/notify_windows.go` / `obli.tools/notify_darwin.go` / `obli.tools/notify_other.go` — notifications OS natives par plateforme
- `obli.tools/config.go` — struct `TabConfig`
- `server/src/services/liveAlert.service.ts` — dédup par `stable_key`, alimentation de `/api/live-alerts/all`
