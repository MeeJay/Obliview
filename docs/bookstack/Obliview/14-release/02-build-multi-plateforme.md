L'agent Go et le launcher ObliTools sont distribués sur plusieurs plateformes (Windows, Linux, FreeBSD, macOS). Comme certaines fonctionnalités natives (capteurs matériels, CPU par cœur) nécessitent CGO et ne se cross-compilent pas fiablement, les builds non-Windows sont délégués à des machines distantes réelles via SSH, orchestrées depuis `000-RegularUpdate.bat`.

## Topologie des hôtes de build

`000-RegularUpdate.bat` déclare deux hôtes distants :

```bat
set MAC_HOST=192.168.1.5
set MAC_PORT=22
set MAC_USER=meejay
set MAC_REPO_DIR=~/obliview

set LINUX_HOST=10.0.0.152
set LINUX_PORT=22
set LINUX_USER=meejay
set LINUX_REPO_DIR=~/obliview

set REPO_URL=https://github.com/MeeJay/obliview.git
set SSH_KEY=%USERPROFILE%\.ssh\id_ed25519
```

`10.0.0.152` (DEVLINUX) sert à la fois de démon Docker distant (`_DH=-H tcp://10.0.0.152:2375`, utilisé pour les builds `server`/`client`) et d'hôte de build natif pour l'agent Linux/FreeBSD.

## Synchronisation du dépôt avant build distant

Avant de lancer un build sur Mac ou Linux, le script pousse d'abord la branche courante sur `origin`, puis synchronise chaque dépôt distant par SSH :

```bat
ssh -i "!SSH_KEY!" -p !LINUX_PORT! !LINUX_USER!@!LINUX_HOST! ^
  "bash -l -c 'if [ -d !LINUX_REPO_DIR!/.git ]; then ^
     git -C !LINUX_REPO_DIR! fetch && ^
     git -C !LINUX_REPO_DIR! checkout -f !BRANCH! -- && ^
     git -C !LINUX_REPO_DIR! reset --hard origin/!BRANCH! && ^
     git -C !LINUX_REPO_DIR! clean -fd; ^
   else git clone -b !BRANCH! !REPO_URL! !LINUX_REPO_DIR!; fi'"
```

Le résultat (`LINUX_SYNC_OK` / `MAC_SYNC_OK`) conditionne l'exécution des builds : si le push ou la sync échoue, les builds distants sont sautés (`SUM_AGENT=... + Linux:SKIP`) pour éviter de packager du code obsolète.

## Build Linux + FreeBSD (`agent/build-linux.sh`)

Exécuté à distance sur DEVLINUX via :

```bat
ssh -i "!SSH_KEY!" -p !LINUX_PORT! !LINUX_USER!@!LINUX_HOST! ^
  "bash -l -c 'cd !LINUX_REPO_DIR!/agent && bash build-linux.sh'"
```

Le script `agent/build-linux.sh` compile trois cibles avec `CGO_ENABLED=0` (cross-compilation pure, pas de dépendance sur des bibliothèques C locales) :

```bash
export CGO_ENABLED=0
GOOS=linux   GOARCH=amd64   go build -ldflags="-s -w -X main.agentVersion=${VERSION}" -o dist/obliview-agent-linux-amd64 .
GOOS=linux   GOARCH=arm64   go build -ldflags="-s -w -X main.agentVersion=${VERSION}" -o dist/obliview-agent-linux-arm64 .
GOOS=freebsd GOARCH=amd64   go build -ldflags="-s -w -X main.agentVersion=${VERSION}" -o dist/obliview-agent-freebsd-amd64 .
```

La version est lue depuis le fichier `agent/VERSION` (source de vérité unique, partagée avec le build Windows) et injectée via `-X main.agentVersion=`. Les flags `-s -w` retirent les symboles de debug/DWARF pour réduire la taille du binaire.

Après le build distant, les trois binaires sont rapatriés vers l'hôte Windows via `scp` :

```bat
scp -i "!SSH_KEY!" -P !LINUX_PORT! !LINUX_USER!@!LINUX_HOST!:!LINUX_REPO_DIR!/agent/dist/obliview-agent-linux-amd64   agent\dist\obliview-agent-linux-amd64
scp ... obliview-agent-linux-arm64   agent\dist\obliview-agent-linux-arm64
scp ... obliview-agent-freebsd-amd64 agent\dist\obliview-agent-freebsd-amd64
```

Chaque `scp` est indépendant : l'échec de l'un (ex. `linux-arm64`) n'empêche pas la récupération des autres, seul un avertissement est affiché.

## Build macOS (`agent/build-mac.sh`)

Contrairement au Linux, le build macOS **ne peut pas être cross-compilé sans CGO** : `gopsutil` utilise `cpu.Percent(percpu=true)`, qui appelle l'API Mach `host_processor_info`, disponible uniquement via CGO. Un binaire cross-compilé retomberait sur un appel à `top`, qui ne fournit qu'un pourcentage CPU global (pas de barres par cœur dans l'UI de l'agent).

`agent/build-mac.sh` doit donc tourner **sur une vraie machine Mac** (Apple Silicon ou Intel) :

1. Détection de l'architecture native via `go env GOARCH`.
2. Build natif complet avec `CGO_ENABLED=1` pour l'architecture native.
3. Tentative de cross-compilation vers l'architecture opposée via `clang -arch` (`CGO_CFLAGS`/`CGO_LDFLAGS`), avec repli silencieux (warning, pas d'échec du script) si le cross-compile échoue :

```bash
CGO_ENABLED=1 GOOS=darwin GOARCH="$CROSS_GOARCH" \
  CGO_CFLAGS="-arch $CROSS_CLANG_ARCH" \
  CGO_LDFLAGS="-arch $CROSS_CLANG_ARCH" \
  go build -ldflags="-s -w -X main.agentVersion=$VERSION" \
  -o "$OUT_DIR/obliview-agent-darwin-$CROSS_GOARCH" .
```

Invocation depuis `000-RegularUpdate.bat` (sous-routine `:BUILD_AGENT_MAC`), suivie de deux `scp` pour rapatrier `obliview-agent-darwin-arm64` et `obliview-agent-darwin-amd64`.

## Assemblage final : image Docker de l'agent

`agent/Dockerfile` copie en dernière étape le contenu de `agent/dist/` — c'est pourquoi tous les binaires (Windows signé, Linux, FreeBSD, macOS) doivent être présents dans ce dossier avant le build Docker de l'image agent : le rapatriement SCP alimente ce répertoire partagé.

## Builds ObliTools (Windows/macOS)

`obli.tools/build-windows.ps1` produit `dist\ObliTools.exe` (build Go avec `CGO_ENABLED=1`, `-H windowsgui` pour supprimer la fenêtre console, WebView2 + stub `EventToken.h` pour MinGW) puis `dist\ObliToolsSetup.msi` via `wix build` en patchant le placeholder de version dans `installer.wxs`. `obli.tools/build-mac.sh` (exécuté sur Mac, hors du flux `000-RegularUpdate.bat` de l'agent) produit les binaires `amd64`/`arm64` et les `.dmg` correspondants. Dans les deux cas, `VERSION` est la source de vérité unique du numéro de version, injectée à la fois dans le binaire (`-X main.appVersion=`) et dans l'installeur.

## Références

- `D:\Obliview\000-RegularUpdate.bat` — orchestrateur : questions de bump, sync SSH, sous-routines `:BUILD_AGENT_WIN`, `:BUILD_AGENT_MAC`, `:BUILD_AGENT_LINUX`
- `D:\Obliview\agent\build-linux.sh` — build Linux amd64/arm64 + FreeBSD amd64, `CGO_ENABLED=0`
- `D:\Obliview\agent\build-mac.sh` — build macOS natif (CGO) + cross-arch via clang
- `D:\Obliview\agent\Dockerfile` — image Docker agent, assemble les binaires de `agent/dist/`
- `D:\Obliview\agent\VERSION` — source de vérité de version de l'agent
- `D:\Obliview\obli.tools\build-windows.ps1` — build EXE + MSI ObliTools (WiX v4)
- `D:\Obliview\obli.tools\build-mac.sh` — build DMG ObliTools (amd64/arm64)
- `D:\Obliview\obli.tools\VERSION` — source de vérité de version d'ObliTools
