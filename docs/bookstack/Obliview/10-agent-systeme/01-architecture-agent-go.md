L'agent Obliview est un binaire Go unique (`agent/`), compilé pour Windows, Linux, macOS et FreeBSD, qui collecte des métriques système (CPU, RAM, disques, réseau, température, GPU) et les transmet au serveur via un canal WebSocket persistant ou, en repli, du HTTP push. Un même binaire gère l'enregistrement, la remontée de métriques, l'auto-mise à jour et la désinstallation, sans dépendance externe autre que PowerShell sur Windows pour l'accès aux capteurs matériels.

## Point d'entrée et configuration

Le point d'entrée (`agent/main.go`) parse les flags `--url` et `--key`, puis appelle `setupConfig()` qui charge ou crée `config.json` :

- Windows : `%PROGRAMDATA%\ObliviewAgent\config.json` (avec repli sur le registre `HKLM\SOFTWARE\ObliviewAgent` via `agent/registry_windows.go`)
- Unix : `/etc/obliview-agent/config.json`

```go
type Config struct {
    ServerURL            string `json:"serverUrl"`
    APIKey               string `json:"apiKey"`
    DeviceUUID           string `json:"deviceUuid"`
    CheckIntervalSeconds int    `json:"checkIntervalSeconds"`
    AgentVersion         string `json:"agentVersion"`
    BackoffUntil         int64  `json:"_backoffUntil,omitempty"`
}
```

À chaque démarrage, `resolveDeviceUUID()` (`agent/machine_uuid.go`) recalcule l'UUID matériel — ce fichier est volontairement partagé texto entre tous les agents Obli* (Obliview, Obliguard, Oblimap, Obliance) pour que l'identité machine soit cohérente entre outils. Voir la page dédiée « Cycle de vie » pour le détail de cette résolution.

Après configuration, `main()` appelle `runAsService()` (bascule en mode service Windows via `golang.org/x/sys/windows/svc` si lancé par le SCM) puis `runCmdWS(cfg)` — la boucle principale du canal de commandes WebSocket (voir page 2).

## Build cross-platform

| Plateforme | Script | Sortie |
|---|---|---|
| Windows (service + MSI) | `agent/build-msi.bat` | `dist\obliview-agent.exe` (`GOOS=windows GOARCH=amd64`), puis `wix build` |
| Linux (SSH sur DEVLINUX) | `agent/build-linux.sh` | `obliview-agent-linux-amd64`, `-arm64`, `obliview-agent-freebsd-amd64` |
| macOS | `agent/build-mac.sh` | `obliview-agent-darwin-arm64` (natif) + `obliview-agent-darwin-amd64` (cross via `clang -arch`), `CGO_ENABLED=1` |

Le binaire macOS est compilé avec CGO activé (accès à IOKit pour l'UUID matériel et les capteurs), ce qui impose une compilation native ou un cross-compilateur clang configuré — d'où le fallback documenté dans `build-mac.sh` en cas d'échec de cross-compilation.

La version est injectée au build via `-ldflags="-X main.agentVersion=x.y.z"`, la source de vérité étant `agent/VERSION`. Tous les binaires Windows (.exe et .msi) sont signés localement via le certificat cloud Certum SimplySign (`D:\Sign\Sign.ps1`) **avant** l'empaquetage MSI, afin que l'exécutable interne au MSI soit déjà signé.

## Installateur Windows (MSI, WiX v4+)

`agent/installer/product.wxs` définit un `Package` avec `UpgradeCode` fixe et `MajorUpgrade` pour les mises à niveau in-place. Le composant principal :

```xml
<Component Id="AgentExe" Guid="A1B2C3D4-E5F6-7890-ABCD-EF1234560001">
  <File Id="AgentExeFile" Source="dist\obliview-agent.exe" Name="obliview-agent.exe"
        DefaultVersion="65535.0.0.0" />
  <ServiceInstall Id="AgentSvc" Name="ObliviewAgent"
                  DisplayName="Obliview Monitoring Agent"
                  Start="auto" Type="ownProcess" Account="LocalSystem"
                  Arguments='--url "[SERVERURL]" --key "[APIKEY]"' />
  <ServiceControl Id="AgentSvcStart" Name="ObliviewAgent" Start="install" />
  <ServiceControl Id="AgentSvcStop"  Name="ObliviewAgent" Stop="both" Remove="uninstall" Wait="yes" />
</Component>
```

Points notables :

- `DefaultVersion="65535.0.0.0"` force MSI à toujours écraser l'exécutable, même si le binaire Go sur disque n'a pas de ressource de version Win32 (les binaires Go n'en ont pas par défaut) — sans cela, MSI peut considérer un fichier « modifié mais non versionné » comme à jour et sauter la copie.
- Les propriétés `SERVERURL` et `APIKEY` sont marquées `Secure="yes"` pour rester disponibles lors des exécutions différées (deferred custom actions) qui tournent avec des droits élevés.
- Un composant `AgentConfig` écrit aussi `SERVERURL`/`APIKEY` dans le registre `HKLM\SOFTWARE\ObliviewAgent` comme repli si `config.json` est absent au premier démarrage.
- Build : `dotnet tool install -g wix` puis `wix build` (v4+, remplace l'ancien duo `candle`/`light`).

Le pilote noyau **PawnIO n'est plus embarqué par le MSI** depuis la version 1.6.8 : il avait été installé par erreur en croyant que LibreHardwareMonitorLib.dll en avait besoin, ce qui a causé des BSOD en flotte (confirmés par analyse WinDbg `!analyze -v` pointant vers `PawnIO.sys`). LHM embarque et charge son propre pilote WinRing0 à l'exécution. Le script `agent/installer/Uninstall-Obliview-PawnIO.ps1` reste fourni pour nettoyer les hôtes ayant une version antérieure encore installée.

## Installateurs Linux / macOS / FreeBSD

Pour les plateformes non-Windows, l'installation passe par des scripts shell servis dynamiquement, avec injection des identifiants dans le script téléchargé :

```http
GET /api/agent/installer/linux?key=<apikey>
GET /api/agent/installer/macos?key=<apikey>
GET /api/agent/installer/freebsd?key=<apikey>
```

`agent/installer/install.sh` détecte l'architecture, télécharge le binaire correspondant depuis `/api/agent/download/:filename`, l'installe dans `/opt/obliview-agent/`, écrit sa configuration dans `/etc/obliview-agent/` et enregistre un service systemd (ou init.d en repli) nommé `obliview-agent`.

## Endpoints de distribution

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/agent/version` | Dernière version publiée (utilisé par `checkForUpdate()` au démarrage) |
| GET | `/api/agent/download/:filename` | Sert le binaire/MSI depuis `agent/dist/`, filtré par une liste blanche `ALLOWED_AGENT_BINARIES` |
| GET | `/api/agent/installer/windows.msi` | Sert le MSI prêt à l'emploi |
| GET | `/api/agent/installer/linux` \| `/macos` \| `/freebsd` | Scripts shell avec clé injectée |
| GET | `/api/agent/installer/wizard.exe` | Assistant d'installation (auth admin requise) |

Le contrôleur `agentDownload()` (`server/src/controllers/agent.controller.ts`) résout `filename` via `ALLOWED_AGENT_BINARIES` avant de servir le fichier depuis `agent/dist/` — aucune traversée de chemin arbitraire n'est possible.

## Références

- `agent/main.go` — point d'entrée, configuration, auto-update
- `agent/machine_uuid.go` — résolution UUID matériel partagée Obli*
- `agent/installer/product.wxs` — installateur MSI WiX v4
- `agent/installer/Uninstall-Obliview-PawnIO.ps1` — nettoyage PawnIO legacy
- `agent/installer/install.sh` — installateur Linux/FreeBSD
- `agent/build-msi.bat`, `agent/build-linux.sh`, `agent/build-mac.sh` — scripts de build
- `server/src/controllers/agent.controller.ts` — `agentDownload`, `agentInstallerLinux/Windows/Macos/Freebsd`
- `server/src/routes/agent.routes.ts` — déclaration des routes de distribution
