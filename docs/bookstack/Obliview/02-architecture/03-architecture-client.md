Le client Obliview est une SPA React 18 servie par Vite 5, structurée par domaine fonctionnel plutôt que par type de fichier, avec Zustand pour l'état global et Socket.io-client pour le temps réel.

## Structure de `client/src`

```
client/src/
├── api/          clients Axios par domaine (monitors.api.ts, agent.api.ts, teams.api.ts, ...)
├── components/   composants React groupés par domaine (agent/, dashboard/, groups/, layout/, maintenance/, monitors/, notifications/, remediation/, settings/, ui/, common/)
├── hooks/        hooks personnalisés
├── i18n/         config react-i18next + locales/
├── pages/        une page = une route (DashboardPage, MonitorDetailPage, AdminAgentPage, ...)
├── socket/       socketClient.ts — wrapper socket.io-client
├── store/        stores Zustand (authStore, monitorStore, groupStore, tenantStore, socketStore, liveAlertsStore, uiStore)
├── types/        types locaux au client
├── utils/        helpers (theme, sensorLabels, ...)
└── App.tsx       déclaration des routes
```

## Routing (`App.tsx`)

Le routing utilise `react-router-dom` v6 avec `BrowserRouter`. Structure imbriquée :

```tsx
<Route element={<ProtectedRoute />}>
  <Route path="/enroll" element={<EnrollmentPage />} />   {/* hors AppLayout */}
  <Route element={<AppLayout />}>
    <Route path="/" element={<DashboardPage />} />
    <Route path="/monitor/:id" element={<MonitorDetailPage />} />
    ...
    <Route element={<ProtectedRoute requiredRole="admin" />}>
      <Route path="/admin/users" element={<AdminUsersPage />} />
      <Route path="/admin/agents" element={<AdminAgentPage />} />
      ...
    </Route>
  </Route>
</Route>
```

`ProtectedRoute` (imbriqué deux fois : une fois pour l'authentification, une fois avec `requiredRole="admin"`) gate l'accès. `checkSession()` est déclenché une seule fois au montage de `App` via `useEffect`. Un `<Toaster>` global (react-hot-toast) affiche les notifications, stylé avec les classes Tailwind du thème (`!bg-bg-secondary !text-text-primary`).

## Stores Zustand

Chaque store est un module autonome créé via `create<T>(...)`. Pas de store racine unique — composition par import direct entre stores.

| Store | Fichier | Responsabilité |
|---|---|---|
| `authStore` | `store/authStore.ts` | session utilisateur, permissions, login/logout, orchestration au login (connecte le socket, fetch tenants, fetch alertes) |
| `monitorStore` | `store/monitorStore.ts` | `Map<number, Monitor>` + `Map<number, Heartbeat[]>` en mémoire, résumés d'uptime |
| `groupStore` | `store/groupStore.ts` | arbre de groupes, état replié/déplié persistant par utilisateur+tenant |
| `tenantStore` | `store/tenantStore.ts` | tenant courant, switch de tenant (avec reload complet de la page) |
| `socketStore` | `store/socketStore.ts` | statut de connexion (`connected`/`disconnected`/`reconnecting`) |
| `liveAlertsStore` | `store/liveAlertsStore.ts` | alertes temps réel, préférences toast (position, activation) |
| `uiStore` | `store/uiStore.ts` | état UI transverse (sidebar, modales...) |

Exemple — `monitorStore` utilise des `Map` (pas des objets/array) pour un accès O(1) par id, et gère un cas particulier de non-régression de statut :

```ts
addHeartbeat: (monitorId, heartbeat) => {
  // Ne pas écraser 'updating' par 'pending' — l'agent émet des heartbeats
  // 'pending' pendant sa propre mise à jour (exclusion d'uptime), mais le
  // badge UI doit rester sur 'updating' jusqu'à reconnexion.
  const newStatus = (heartbeat.status === 'pending' && monitor.status === 'updating')
    ? 'updating'
    : heartbeat.status;
  ...
}
```

`authStore.login()` illustre l'orchestration inter-stores typique du projet : après un login réussi, il appelle successivement `connectSocket(user.id)`, `useTenantStore.getState().fetchTenants()`, `useLiveAlertsStore.getState().fetchAlerts()`, puis récupère les permissions en tâche de fond (`authApi.me()`), et enfin recharge l'état replié des groupes pour le couple utilisateur/tenant (`useGroupStore.getState().reinitForTenant(...)`).

## Client API (`api/`)

Un fichier `*.api.ts` par domaine encapsule les appels Axios (`client.ts` configure l'instance de base, gère l'injection du header `X-Auth-Token` en contexte ObliTools via `isInObliTools`/`OBLITOOLS_TOKEN_KEY`). Les pages et stores consomment ces clients plutôt que d'appeler `axios` directement.

## i18n

`client/src/i18n/index.ts` configure `react-i18next` avec `SUPPORTED_LANGUAGES` (18 langues) et une fonction `setLanguage()`. La langue est synchronisée depuis les préférences utilisateur au login (`syncPreferencesToStore` dans `authStore.ts` appelle `setLanguage(user.preferredLanguage)`), et pour les utilisateurs SSO, resynchronisée depuis Obligate à chaque connexion.

## Socket.io côté client

`client/src/socket/socketClient.ts` expose `connectSocket(userId, tenantId?)` / `disconnectSocket()` / `getSocket()` :

```ts
socket = io(window.location.origin, {
  auth: { userId, tenantId },
  transports: ['websocket', 'polling'],
  withCredentials: true,
});
```

Particularités notables :
- Le statut de connexion est reflété dans `socketStore` (`connected`/`disconnected`/`reconnecting`) via les événements `connect`, `disconnect`, `connect_error`, et `socket.io.on('reconnect_attempt'|'reconnect')`.
- Détection de mise en veille de l'OS : le client mémorise l'instant où la page devient `hidden` (`document.visibilitychange`). Si la page redevient visible après plus de `STALE_THRESHOLD_MS` (30s) alors que le socket croit être encore connecté, un `disconnect().connect()` forcé est déclenché plutôt que d'attendre jusqu'à 45s le timeout de ping natif de Socket.io.

## Design system

Tailwind CSS est utilisé sans composant UI externe (pas de MUI/Chakra) — un dossier `components/ui/` fournit les primitives internes (boutons, modales, inputs), réutilisées par les composants de domaine (`components/monitors/`, `components/agent/`, `components/dashboard/`, etc.). Le thème clair/sombre est piloté par `utils/theme.ts` (`applyTheme`), avec un `ThemePicker.tsx` dédié.

## Références

- `client/src/App.tsx`
- `client/src/store/authStore.ts`, `monitorStore.ts`, `socketStore.ts`
- `client/src/socket/socketClient.ts`
- `client/src/i18n/index.ts`
- `client/vite.config.ts`
- `client/package.json`