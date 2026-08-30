Le cycle de vie d'un agent Obliview — installation, identité machine, mise à jour, désinstallation — est piloté conjointement par le binaire Go et le serveur, avec un objectif constant : rester stable à travers réinstallations, migrations de VM et mises à jour, sans jamais créer de doublons de device en base.

## Installation initiale

Au premier lancement (`setupConfig()` dans `agent/main.go`), si aucun `config.json` ni entrée registre n'existe, les flags `--url` et `--key` sont obligatoires. L'agent génère alors sa configuration et calcule son UUID via `resolveDeviceUUID("")`, puis persiste `config.json`. Sur Windows, l'installation passe typiquement par le MSI (`msiexec /i obliview-agent.msi SERVERURL="..." APIKEY="..."`), qui enregistre un service `ObliviewAgent` (`Start="auto"`, `Account="LocalSystem"`) avec les arguments `--url`/`--key` injectés dans `ServiceInstall`.

## UUID matériel stable (`machine_uuid.go`)

`resolveDeviceUUID(stored)` applique un ordre de résolution strict, partagé texto entre tous les agents Obli* :

1. **Override cross-produit** — fichier partagé `%PROGRAMDATA%\Oblitools\device-uuid-override` (Windows) ou `/etc/oblitools/device-uuid-override` (Unix). Permet de « re-domicilier » tous les agents Obli* d'une même machine en une seule opération (utile après clonage de VM). Absent par défaut → comportement inchangé.
2. **UUID SMBIOS/matériel** — `readMachineUUID()`, implémenté par plateforme :
   - Windows (`machine_uuid_windows.go`) : requête WMI/BIOS
   - macOS (`machine_uuid_darwin.go`) : IOKit
   - Linux (`machine_uuid_linux.go`) : DMI (`/sys/class/dmi/id/product_uuid`)
   - FreeBSD (`machine_uuid_freebsd.go`) : équivalent DMI
   
   Filtré contre une liste noire de placeholders OEM connus (`badHardwareUUIDs`) — tout zéro, tout F, UUID par défaut ASUS/Dell, etc.
3. **UUID dérivé du numéro de série disque système** — si le SMBIOS est invalide/blacklisté, `deriveHardwareUUID()` hash (`SHA-256` → UUID v5, préfixe fixe `"obliview-disk:"`... en réalité `"obliance-disk:"` partagé Obli*) le numéro de série du disque système, après filtrage des valeurs placeholder (`isPlaceholderSerial`, y compris détection heuristique de chaînes composées d'un seul caractère répété).
4. **UUID précédemment stocké** — dernier recours si les deux sources matérielles échouent.
5. **UUID aléatoire généré** — ultime repli, non déterministe, journalisé bruyamment ("WARNING no hardware ID available") car ce cas devrait être extrêmement rare sur du matériel réel.

Ce mécanisme garantit qu'une réinstallation de l'agent (MSI désinstallé puis réinstallé) reproduit le même UUID, donc que le serveur reconnaît le même `agent_devices` plutôt que de créer un doublon.

## Auto-mise à jour

La version est vérifiée au démarrage (`checkForUpdate()` → `GET /api/agent/version`) puis, en régime permanent, elle est « piggybackée » sur chaque réponse de heartbeat/push (`latestVersion` dans `cmdConfigMsg` / `pushResponse`) — pas de round-trip dédié. `applyUpdateIfNewer(cfg, remoteVersion)` compare en semver strict (`isStrictlyNewer`, comparaison major.minor.patch, valeurs malformées traitées comme `0.0.0`).

Si une version plus récente est détectée :

1. `notifyServerUpdating(cfg)` prévient le serveur (endpoint `notifying-update`) — bascule le badge UI sur « updating » et suspend les alertes de mise hors ligne pendant la fenêtre de mise à jour.
2. **Windows** : téléchargement du MSI complet (`obliview-agent.msi`) depuis `/api/agent/download/`, écrit dans un fichier temporaire, puis lancement d'un script batch détaché (`obliview-msi-update.bat`) :

```bat
@echo off
timeout /t 2 /nobreak >nul
msiexec /i "%s" /quiet /norestart SERVERURL="%s" APIKEY="%s" /l*v "%s"
del /q "%s"
del /q "%%~f0"
```

   Le script survit à l'arrêt du process de service (l'agent s'arrête juste après le lancement pour libérer le verrou sur l'exécutable avant que `msiexec` ne l'écrase). `msiexec` arrête le service (`ServiceControl Stop="both"`), remplace les fichiers, exécute les actions différées, puis redémarre le service.
3. **Unix (Linux/macOS)** : téléchargement du binaire brut correspondant à `runtime.GOOS`/`GOARCH`, écriture atomique via `os.Rename(tmpPath, exePath)`, puis `restartWithNewBinary(exePath)` qui `exec`-ute in-place (même PID, sans dépendre d'un gestionnaire de service).

## Désinstallation pilotée serveur

Le serveur peut pousser une commande one-shot `"uninstall"` (queue `agent_devices.pending_command`, délivrée immédiatement via WS ou au prochain push HTTP — voir page 2). Côté agent, `handleUninstallCommand(cfg)` (`agent/uninstall.go`) dispatche par plateforme :

| Plateforme | Mécanisme |
|---|---|
| Windows | Télécharge le MSI, écrit un script batch détaché qui lance `msiexec /x "<msi>" /quiet /norestart /l*v <log>` puis s'auto-supprime |
| Linux | Écrit `/tmp/obliview-uninstall.sh` : `systemctl stop/disable` (ou `service` en repli SysV), suppression de l'unité systemd/init.d, `rm -rf /opt/obliview-agent/`, auto-suppression du script |
| macOS | Écrit `/tmp/obliview-uninstall.sh` : `launchctl unload` du daemon, suppression du plist `com.obliview.agent` et du binaire `/usr/local/bin/obliview-agent` |

Dans les trois cas, le script est lancé **détaché** (`exec.Command(...).Start()`, sans attendre) puis l'agent appelle `os.Exit(0)` immédiatement après — le script doit survivre à l'arrêt du process courant pour terminer le travail (arrêt de service, suppression de fichiers) sans que l'agent lui-même ne bloque la suppression de son propre exécutable :

```go
if err != nil {
    log.Printf("Uninstall: failed to launch uninstall script: %v", err)
    return
}
log.Printf("Uninstall: script launched, shutting down agent...")
os.Exit(0)
```

Config et logs (`/etc/obliview-agent/`, `/var/log/obliview-agent.log`) sont volontairement préservés sur Unix — seuls le service et le binaire sont retirés.

## Nettoyage automatique côté serveur

Lorsque le serveur délivre la commande `uninstall`, il horodate `agent_devices.uninstall_commanded_at` :

```ts
if (pendingCommand === 'uninstall') {
  commandUpdate.uninstall_commanded_at = new Date();
}
```

Un job périodique (`server/src/index.ts`, exécuté aux côtés des jobs de maintenance) appelle toutes les quelques minutes :

```ts
async cleanupUninstalledDevices(): Promise<void> {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes
  const rows = await db('agent_devices')
    .whereNotNull('uninstall_commanded_at')
    .where('uninstall_commanded_at', '<', cutoff)
    .select('id');
  if (rows.length === 0) return;
  await this.bulkDeleteDevices(rows.map(r => r.id));
}
```

Cela laisse à l'agent 10 minutes pour recevoir la commande, exécuter son script de désinstallation et cesser de pousser des métriques, avant que le serveur ne supprime définitivement l'enregistrement `agent_devices` (et le moniteur associé). Le même job appelle aussi `cleanupStuckUpdating()`, qui efface `updating_since` pour tout device resté bloqué en état « mise à jour » plus de 10 minutes sans reconnexion — l'agent retombe alors dans la détection de mise hors ligne standard et reçoit l'alerte normale au lieu de rester indéfiniment masqué en « updating ».

## Références

- `agent/main.go` — `setupConfig`, `checkForUpdate`, `applyUpdateIfNewer`, `applyWindowsMSIUpdate`
- `agent/uninstall.go` — `handleUninstallCommand`, scripts détachés par plateforme
- `agent/machine_uuid.go` + `machine_uuid_windows.go` / `_darwin.go` / `_linux.go` / `_freebsd.go` — résolution UUID matérielle
- `agent/restart_windows.go`, `agent/restart_unix.go` — redémarrage/sortie post-update
- `server/src/services/agent.service.ts` — `cleanupUninstalledDevices`, `cleanupStuckUpdating`, `bulkSendCommand`
- `server/src/index.ts` — planification périodique des jobs de nettoyage agent
- `agent/installer/product.wxs` — `ServiceControl Stop="both" Remove="uninstall"` (désinstallation manuelle via Panneau de configuration)
