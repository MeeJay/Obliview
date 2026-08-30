Obliview centralise l'envoi de notifications derrière un système de plugins uniforme. Chaque canal (`notification_channels`) référence un `type` de plugin, et le worker de monitoring ne connaît que l'interface commune `NotificationPlugin` — jamais le détail d'un provider spécifique.

## Interface commune

Tous les plugins implémentent `NotificationPlugin` (`server/src/notifications/types.ts`) :

```ts
export interface NotificationPlugin {
  type: string;
  name: string;
  description: string;
  configFields: NotificationConfigField[];

  send(config: Record<string, unknown>, payload: NotificationPayload): Promise<void>;
  sendTest(config: Record<string, unknown>): Promise<void>;
}
```

Le `NotificationPayload` (`server/src/notifications/types.ts`) transporte l'état du moniteur (nom, ancien/nouveau statut, message, timestamp) ainsi que des champs dédiés aux notifications de groupe : `groupName`, `groupId`, `downMonitors`, `failingMonitors`, `totalFailingCount`, `isGroupNotification`.

## Registre des plugins

Les 10 plugins sont enregistrés dans `server/src/notifications/registry.ts` sous forme de `Map<string, NotificationPlugin>` indexée par `type` :

```ts
const plugins = new Map<string, NotificationPlugin>();

[
  webhookPlugin, discordPlugin, telegramPlugin, slackPlugin, teamsPlugin,
  gotifyPlugin, ntfyPlugin, pushoverPlugin, smtpPlugin, freemobilePlugin,
].forEach((plugin) => plugins.set(plugin.type, plugin));

export function getPlugin(type: string): NotificationPlugin | undefined {
  return plugins.get(type);
}

export function getPluginMetas(): NotificationPluginMeta[] {
  return getAllPlugins().map((p) => ({
    type: p.type, name: p.name, description: p.description, configFields: p.configFields,
  }));
}
```

`getPlugin(type)` est appelé par `notification.service.ts` au moment de l'envoi effectif. `getPluginMetas()` alimente l'endpoint `GET /api/notifications/plugins` (`notificationsController.plugins`), qui sert à construire dynamiquement le formulaire de configuration côté client à partir des `configFields` (type de champ : `text`, `url`, `password`, `number`, `smtp_server_select`, requis ou non).

## Les 10 plugins (`server/src/notifications/plugins/`)

| Type | Fichier | Nom affiché | Transport | Champs de config principaux |
|---|---|---|---|---|
| `webhook` | `webhook.ts` | Webhook | `POST` JSON générique vers une URL | `url`, `secret` (injecté en header `Authorization`) |
| `discord` | `discord.ts` | Discord | Webhook Discord, embed avec couleur et champs | `webhookUrl`, `username` (optionnel) |
| `telegram` | `telegram.ts` | Telegram | Bot API `sendMessage` (HTML) | `botToken`, `chatId` |
| `slack` | `slack.ts` | Slack | Webhook Slack, message `attachments`/`blocks` | `webhookUrl`, `channel` (optionnel) |
| `teams` | `teams.ts` | Microsoft Teams | Webhook Teams, Adaptive Card v1.4 | `webhookUrl` |
| `gotify` | `gotify.ts` | Gotify | `POST /message?token=` sur un serveur Gotify auto-hébergé | `serverUrl`, `appToken`, `priority` (0-10) |
| `ntfy` | `ntfy.ts` | ntfy | `POST` texte brut sur ntfy.sh ou instance self-hosted | `serverUrl`, `topic`, `token` (optionnel), `priority` (1-5) |
| `pushover` | `pushover.ts` | Pushover | API Pushover (`api.pushover.net/1/messages.json`) | `userKey`, `appToken`, `priority` (-2 à 2) |
| `smtp` | `smtp.ts` | Email (SMTP) | `nodemailer` via un serveur SMTP configuré globalement | `smtpServerId`, `fromOverride`, `to` |
| `freemobile` | `freemobile.ts` | Free Mobile SMS | API SMS Free Mobile (France) | `userId`, `apiKey` |

## Icônes et couleurs de statut communes

`server/src/notifications/statusIcons.ts` centralise le mapping statut → emoji/couleur pour éviter la duplication entre plugins :

```ts
export function statusIcon(status: string): string {
  switch (status) {
    case 'up':            return '✅';
    case 'down':           return '🔴';
    case 'alert':          return '🟠';
    case 'ssl_warning':    return '⚠️';
    case 'ssl_expired':    return '🔴';
    case 'inactive':       return '⚫';
    case 'value_changed':  return '🔄';
    case 'paused':         return '⏸️';
    case 'pending':        return '🔵';
    case 'maintenance':    return '🔧';
    default:               return '❓';
  }
}
```

`STATUS_COLORS_HEX` (pour les embeds Discord, en `number` hexadécimal) et `STATUS_COLORS_CSS` (chaînes `#rrggbb` pour Slack) suivent la même table de correspondance.

## Cas particuliers d'implémentation

- **`smtp`** : contrairement aux autres plugins, `config` reçu par `send()` n'est pas la config brute du canal mais une config *résolue* (host/port/secure/username/password/from) injectée par `notificationService.resolveChannelConfig()` à partir de `smtp_servers` (voir `server/src/services/smtpServer.service.ts`). Le champ `smtpServerId` du canal sert de clé de résolution, et `fromOverride` permet de surcharger l'adresse `From` du serveur.
- **`webhook`** reçoit le `NotificationPayload` complet tel quel en JSON — c'est le seul plugin qui n'en fait pas un rendu formaté, il transmet les données brutes pour intégration externe.
- **Notifications de groupe** (`isGroupNotification: true`) : `discord`, `telegram`, `slack`, `teams`, `gotify`, `ntfy`, `pushover`, `smtp` et `freemobile` adaptent tous leur titre/texte pour afficher `groupName` et `totalFailingCount`/`failingMonitors` au lieu du nom du moniteur individuel (voir `groupNotification.service.ts` pour la logique de déclenchement de groupe).
- Tous les appels HTTP sortants utilisent `AbortSignal.timeout(10000)` (10 secondes) pour éviter qu'un provider externe lent ne bloque le worker de monitoring.
- `sendTest(config)` de chaque plugin appelle en interne `this.send(config, ...)` avec un `NotificationPayload` factice (`monitorName: 'Test Monitor'`, transition `up → down`) — utilisé par le bouton "Tester" de l'UI (`POST /api/notifications/channels/:id/test`).

## Ajouter un nouveau plugin

1. Créer `server/src/notifications/plugins/<type>.ts` exportant un objet conforme à `NotificationPlugin`.
2. L'enregistrer dans le tableau de `server/src/notifications/registry.ts`.
3. Aucune autre modification n'est nécessaire : `notification.service.ts`, les routes et l'UI (`AdminNotificationsPage` / `SettingsPanel`) sont génériques et pilotés par `configFields` et `getPluginMetas()`.

## Références

- `server/src/notifications/types.ts` — interface `NotificationPlugin`, `NotificationPayload`
- `server/src/notifications/registry.ts` — enregistrement et résolution des plugins
- `server/src/notifications/statusIcons.ts` — icônes/couleurs communes par statut
- `server/src/notifications/plugins/webhook.ts`
- `server/src/notifications/plugins/discord.ts`
- `server/src/notifications/plugins/telegram.ts`
- `server/src/notifications/plugins/slack.ts`
- `server/src/notifications/plugins/teams.ts`
- `server/src/notifications/plugins/gotify.ts`
- `server/src/notifications/plugins/ntfy.ts`
- `server/src/notifications/plugins/pushover.ts`
- `server/src/notifications/plugins/smtp.ts`
- `server/src/notifications/plugins/freemobile.ts`
- `server/src/services/notification.service.ts` — `getChannelById`, `resolveChannelConfig`, `testChannel`, `sendForMonitor`
- `server/src/controllers/notifications.controller.ts`
- `server/src/db/migrations/007_create_notifications.ts`
