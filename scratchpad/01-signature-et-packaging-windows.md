La distribution des binaires Windows d'Obliview (agent, MSI, ObliTools) passe par une étape de signature de code obligatoire avant tout packaging final. Le mécanisme repose sur un certificat cloud Certum SimplySign, piloté automatiquement via un script PowerShell partagé situé hors du dépôt applicatif.

## Certificat Certum SimplySign

Le certificat de signature de code n'est pas un fichier `.pfx` local mais une identité **cloud SimplySign** (Certum), déverrouillée par un second facteur TOTP à chaque session de signature. Il n'y a donc pas de secret de signature stocké en clair dans le dépôt : seul `signtool.exe` (Windows SDK) et le client `SimplySignDesktop.exe` interagissent avec le HSM distant.

Le client SimplySign est recherché dynamiquement :

```powershell
$candidates = @(
    "C:\Program Files\Certum\SimplySign Desktop\SimplySignDesktop.exe",
    "C:\Program Files (x86)\Certum\SimplySign Desktop\SimplySignDesktop.exe"
)
```

à défaut, une recherche récursive `Get-ChildItem "C:\Program Files*\Certum" -Filter "SimplySign*.exe"` est effectuée. Le chemin peut aussi être forcé via la variable `CERTUM_EXE_PATH`.

## `D:\Sign\Sign.ps1`

Le script `D:\Sign\Sign.ps1` (hors dépôt Obliview, partagé entre tous les projets Obli*) centralise toute la logique de signature. Il est appelé avec une liste de cibles :

```powershell
powershell -ExecutionPolicy Bypass -Command "& 'D:\Sign\Sign.ps1' -Targets 'dist\obliview-agent.exe'"
```

Étapes internes :

1. **Chargement d'un `.env` local** (`D:\Sign\.env`) contenant `CERTUM_OTP_URI` (ou l'ancien nom `CERTUM_OTP_SECRET`) — une URI `otpauth://totp/...` complète (secret, algorithme, digits, période) ou un secret Base32 brut.
2. **Résolution de `signtool.exe`** via une recherche dans `C:\Program Files (x86)\Windows Kits`, en préférant la variante `x64`.
3. **Génération TOTP locale** — un générateur TOTP est compilé à la volée en C# (`Add-Type -Language CSharp`) supportant SHA1/SHA256/SHA512, decodage Base32 manuel, calcul HMAC sur le compteur de fenêtre temporelle (période configurable, défaut 30 s).
4. **Automatisation UI de SimplySign Desktop** :
   - Lancement de l'exécutable (`Start-Process`) — un second lancement alors que l'app tourne déjà en tray fait réapparaître la fenêtre de login si elle est déconnectée, ou ne fait rien si déjà connectée.
   - Détection de la fenêtre de login via **UI Automation** (`System.Windows.Automation.AutomationElement`), poll jusqu'à 8 s.
   - Comme SimplySign est une application WinForms historique (contrôles `WindowsForms10.*`, pas de vrais `Edit` UIA), le code ne peut pas utiliser `ValuePattern` : il active la fenêtre via `WScript.Shell.AppActivate` puis **tape le code TOTP au clavier** (`SendKeys("$otp{ENTER}")`).
   - Poll de disparition de la fenêtre (jusqu'à 30 s) pour confirmer l'acceptation du code.
5. **Signature effective** — pour chaque cible :

```powershell
& $signtool sign /tr http://time.certum.pl /td sha256 /fd sha256 /a $target
```

(horodatage RFC 3161 sur `time.certum.pl`, hash SHA-256 pour la signature et le digest du timestamp).

Si aucune cible n'est passée en argument, le script se contente d'ouvrir la session SimplySign (valable ~2 h) et affiche la commande `signtool` à copier manuellement.

## Ordre : signature avant packaging MSI

Le point critique est que la signature du binaire `.exe` doit intervenir **avant** la construction du MSI, afin que l'exécutable embarqué dans l'installeur soit lui-même signé (le MSI final est ensuite signé une seconde fois séparément). Cet ordre est visible dans `000-RegularUpdate.bat`, sous-routine `:BUILD_AGENT_WIN` :

```bat
echo    [2/5] Building exe...
call go build -ldflags="-s -w -X main.agentVersion=!AGENT_VER!" -o dist\obliview-agent.exe .

echo    [3/5] Signing exe...
powershell ... "& 'D:\Sign\Sign.ps1' -Targets 'dist\obliview-agent.exe'"

echo    [4/5] Building MSI...
node -e "...remplace AGENT_VERSION_PLACEHOLDER..."
call wix build installer\_product_versioned.wxs -b . -arch x64 -out dist\obliview-agent.msi

echo    [5/5] Signing MSI...
powershell ... "& 'D:\Sign\Sign.ps1' -Targets 'dist\obliview-agent.msi'"
```

Le même schéma (exe signé → build MSI → MSI signé) s'applique à `obli.tools/build-windows.ps1` pour ObliTools : le binaire Go (`dist\ObliTools.exe`) est produit, puis le MSI est généré via `wix build` en patchant `installer.wxs` (remplacement du placeholder `DESKTOP_VERSION_PLACEHOLDER` par la version lue depuis le fichier `VERSION`).

Un échec de signature ne bloque pas systématiquement le build : dans `000-RegularUpdate.bat`, un échec de `Sign.ps1` sur l'exe est loggé (`ATTENTION : Signature exe echouee.`) mais le pipeline continue jusqu'au MSI, dont l'échec de signature est également non bloquant (résumé final marqué `Sign:ECHEC`).

## Dockerfiles : plus de build Go local

Les `Dockerfile` (`server/Dockerfile`, `client/Dockerfile`, `agent/Dockerfile`) restent présents dans le dépôt mais **ne sont plus le chemin de production pour les binaires Go signés** : `agent/Dockerfile` compile toujours un binaire Linux non signé en image multi-stage (`golang:1.22-alpine` → `alpine:latest`), utile pour des déploiements conteneurisés simples, mais tous les artefacts distribués (agent Windows MSI, ObliTools EXE/MSI/DMG) sont désormais **construits et signés localement**, hors Docker, car :

- `signtool.exe` et SimplySign Desktop ne peuvent pas tourner dans un conteneur Linux Alpine ;
- WiX v4 (`wix build`) nécessite le SDK .NET installé sur l'hôte de build ;
- la signature doit avoir lieu sur la machine qui possède la session SimplySign active.

Seuls `server/Dockerfile` et `client/Dockerfile` (images Node.js pour le backend Express et le frontend React servi par nginx) continuent d'être construits via Docker dans `000-RegularUpdate.bat` (`docker build -f server/Dockerfile ... && docker push`), car ce sont des artefacts serveur sans signature de code Windows requise.

## Références

- `D:\Sign\Sign.ps1` — script de signature partagé (TOTP + SimplySign + signtool)
- `D:\Obliview\000-RegularUpdate.bat` — sous-routine `:BUILD_AGENT_WIN` (ordre build/signature/MSI/signature)
- `D:\Obliview\obli.tools\build-windows.ps1` — build ObliTools EXE + MSI (WiX v4)
- `D:\Obliview\agent\Dockerfile` — build Linux non signé (usage conteneurisé uniquement)
- `D:\Obliview\server\Dockerfile`, `D:\Obliview\client\Dockerfile` — images Docker toujours buildées via CI locale
- `D:\Obliview\agent\installer\product.wxs` — template WiX de l'installeur agent (placeholder `AGENT_VERSION_PLACEHOLDER`)
- `D:\Obliview\obli.tools\installer.wxs` — template WiX ObliTools (placeholder `DESKTOP_VERSION_PLACEHOLDER`)
