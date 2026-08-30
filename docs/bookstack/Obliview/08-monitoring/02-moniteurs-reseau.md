Les moniteurs "réseau" couvrent les protocoles bas niveau les plus courants d'un outil de supervision : HTTP(S), Ping ICMP, port TCP, résolution DNS, certificat SSL et poignée de main SMTP. Chacun est implémenté comme une sous-classe de `BaseMonitorWorker` dans `server/src/workers/`, qui ne fait qu'implémenter `performCheck(): Promise<CheckResult>` — toute la logique de retry, debounce et notification reste dans la classe de base (voir page *BaseMonitorWorker & MonitorWorkerManager*).

## HTTP(S) — `HttpMonitorWorker.ts`

Utilise `fetch` natif de Node avec un `AbortController` pour le timeout (`config.timeoutMs`). Supporte :

- Méthode HTTP configurable (`GET`/`POST`/`PUT`/`PATCH` avec `body`) et en-têtes personnalisés.
- Certificats auto-signés via un `undici.Agent({ connect: { rejectUnauthorized: false } })` partagé (`insecureAgent`), activé quand `ignoreSsl` est vrai.
- Vérification de code de statut contre `expectedStatusCodes` (défaut `[200, 201, 204, 301, 302]`).
- Recherche de mot-clé (`keyword` / `keywordIsPresent`) dans le corps de la réponse.
- Vérification SSL post-check via `checkSslCertificate()` (voir plus bas) : si le certificat expire dans moins de `sslWarnDays` jours, le statut devient `ssl_warning` ; s'il est expiré ou invalide, `ssl_expired` — même si la requête HTTP elle-même a réussi.

```ts
if (sslResult.daysRemaining < sslWarnDays) {
  return { status: 'ssl_warning', responseTime, statusCode: response.status,
    message: `SSL certificate expires in ${sslResult.daysRemaining} days ...` };
}
```

## Ping ICMP — `PingMonitorWorker.ts`

Délègue au binaire système via `child_process.exec`, car Node n'a pas d'accès ICMP natif sans privilèges root :

```ts
const cmd = isWindows
  ? `ping -n 1 -w ${timeoutMs} ${hostname}`
  : `ping -c 1 -W ${Math.ceil(timeoutMs / 1000)} ${hostname}`;
```

Le temps de ping est extrait de la sortie texte par une regex tolérant les deux formats (Windows `time=12ms` / Linux `time=12.3 ms`). Toute erreur d'exécution (hôte injoignable, timeout) est traduite en `down`.

## Port TCP — `TcpMonitorWorker.ts`

Ouvre un `net.Socket` brut vers `hostname:port`. `up` si `connect` réussit, `down` sur `timeout` (timer manuel + `socket.destroy()`) ou sur l'événement `error` du socket. Aucun protocole applicatif n'est parlé — seul l'établissement de la connexion TCP est vérifié.

## DNS — `DnsMonitorWorker.ts`

Utilise le module `dns/promises`. Un résolveur personnalisé (`dnsResolver`) peut être fourni via `new Resolver().setServers([...])`, sinon le résolveur système par défaut est utilisé. Le type d'enregistrement (`dnsRecordType`) est dispatché vers la bonne méthode :

| Type | Méthode `dns/promises` |
|---|---|
| A | `resolve4` |
| AAAA | `resolve6` |
| CNAME | `resolveCname` |
| MX | `resolveMx` (formaté `priority exchange`) |
| TXT | `resolveTxt` |
| NS | `resolveNs` |
| SOA | `resolveSoa` (formaté `nsname hostmaster`) |
| SRV | `resolveSrv` (formaté `priority weight port name`) |
| PTR | `resolvePtr` |

Un timeout manuel est implémenté via `Promise.race` (le module `dns` n'expose pas d'option timeout native). Si `dnsExpectedValue` est configuré, le résultat doit contenir cette sous-chaîne, sinon le statut passe à `down`.

## SSL Certificate — `SslMonitorWorker.ts` et `sslCheck.ts`

`SslMonitorWorker` ouvre une connexion `tls.connect()` brute avec `rejectUnauthorized: false` (la validation de la chaîne de confiance n'est pas le but — seule la date d'expiration est vérifiée) et lit `socket.getPeerCertificate()`. Le nombre de jours restants est comparé à `sslWarnDays` (défaut 30) : `down` si expiré, `ssl_warning` si sous le seuil, `up` sinon.

`server/src/workers/sslCheck.ts` expose une fonction utilitaire réutilisable `checkSslCertificate(hostname, port, timeoutMs): Promise<SslCheckResult>` (avec `valid`, `daysRemaining`, `expiryDate`, `issuer`), partagée par `HttpMonitorWorker`, `JsonApiMonitorWorker` et implicitement équivalente à la logique embarquée du `SslMonitorWorker` dédié. Elle protège contre le cas `getPeerCertificate()` retournant un objet vide `{}` (absence de certificat).

## SMTP — `SmtpMonitorWorker.ts`

Implémente une poignée de main SMTP minimale sur un `net.Socket` brut, en machine à états (`banner` → `ehlo` → `done`) :

1. Connexion TCP vers `smtpHost:smtpPort` (ou `hostname:port`, défaut port 25).
2. Attente de la bannière serveur `220 ...`.
3. Envoi de `EHLO obliview\r\n`, attente d'une réponse `250 ...`.
4. Envoi de `QUIT\r\n` et résolution `up` dès que l'`EHLO` est accepté.

Toute réponse inattendue (bannière non `220`, `EHLO` rejeté) ou erreur socket entraîne un statut `down` avec le message brut du serveur SMTP.

## Références
- `server/src/workers/HttpMonitorWorker.ts`
- `server/src/workers/PingMonitorWorker.ts`
- `server/src/workers/TcpMonitorWorker.ts`
- `server/src/workers/DnsMonitorWorker.ts`
- `server/src/workers/SslMonitorWorker.ts`
- `server/src/workers/SmtpMonitorWorker.ts`
- `server/src/workers/sslCheck.ts`
- `server/src/workers/BaseMonitorWorker.ts`
