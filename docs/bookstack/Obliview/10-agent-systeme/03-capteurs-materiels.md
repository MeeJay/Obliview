Sur Windows, l'agent va au-delà de ce que `gopsutil` expose nativement (uniquement les zones thermiques ACPI) en interrogeant trois sources complémentaires, implémentées dans `agent/temps_windows.go` : les températures NVMe/SATA natives, LibreHardwareMonitor (LHM) et le WMI ACPI propriétaire ASUS ATK. `agent/temps_windows_lhm.go` gère l'extraction et le chargement des DLL LHM embarquées dans le binaire.

## Vue d'ensemble : `collectPlatformTemps()`

```go
func collectPlatformTemps() []TempSensor {
    var out []TempSensor
    out = append(out, collectNVMeTemps()...)
    out = append(out, collectLHMTemps()...)
    out = append(out, collectAsusATKTemps()...)
    return out
}
```

Les températures GPU (NVIDIA/AMD/Intel) sont collectées séparément par `collectGPUs()` et ajoutées à la liste `Temps` dans `collectMetrics()` — aucune duplication entre les deux mécanismes.

## Source 1 — NVMe/SATA via `Get-StorageReliabilityCounter`

`collectNVMeTemps()` exécute un script PowerShell utilisant le module Storage natif de Windows 10/11 (`Get-PhysicalDisk` + `Get-StorageReliabilityCounter`), sans aucun pilote additionnel. Les valeurs hors plage `]0, 120]°C` sont ignorées ; chaque capteur est libellé `drive_<nom_normalisé>`.

## Source 2 — LibreHardwareMonitor (embarqué par réflexion .NET)

C'est la source principale pour CPU et carte mère. `ensureLHMExtracted()` (`agent/temps_windows_lhm.go`) extrait au premier lancement les DLL LHM embarquées (`//go:embed lhm_dlls`, build net472 v0.9.6 : `LibreHardwareMonitorLib.dll`, `HidSharp.dll`, `DiskInfoToolkit.dll`, `RAMSPDToolkit-NDD.dll`, shims de compatibilité .NET Framework) vers `%ProgramData%\ObliviewAgent\lhm\`, avec un fichier marqueur versionné (`.lhm-v0.9.6-net472`) pour éviter une ré-extraction inutile à chaque démarrage (et éviter de déclencher Windows Defender sur des écritures répétées du même binaire).

`collectLHMByDLL()` charge `LibreHardwareMonitorLib.dll` via un script PowerShell utilisant la réflexion .NET :

```powershell
$h=[System.ResolveEventHandler]{
    param($s,$e)
    $n=[System.Reflection.AssemblyName]::new($e.Name).Name
    $p=[System.IO.Path]::Combine($d,"$n.dll")
    if([System.IO.File]::Exists($p)){return[System.Reflection.Assembly]::LoadFrom($p)}
    return $null
}
[System.AppDomain]::CurrentDomain.add_AssemblyResolve($h)
[System.Reflection.Assembly]::LoadFrom(...LibreHardwareMonitorLib.dll)|Out-Null
$c=New-Object LibreHardwareMonitor.Hardware.Computer
$c.IsCpuEnabled=$true; $c.IsMotherboardEnabled=$true
$c.Open()
```

Un `AssemblyResolve` handler résout les dépendances directement depuis le dossier d'extraction, sans toucher au PATH système ni au GAC. Le script émet des lignes préfixées :

- `T|hw|sensor|celsius` — capteur de température (CPU, carte mère, et sous-matériels)
- `C|hw|Core #N|mhz` — vitesse d'horloge effective par cœur physique (turbo)

`parseLHMOutputAll()` construit à la fois la liste de `TempSensor` (label `lhm_<hw>_<sensor>`, dédupliqué par suffixe numérique en cas de collision) et un slice dense de fréquences par cœur, normalisé pour que le premier cœur physique soit toujours à l'indice 0 (certains CPU AMD/Intel numérotent les cœurs LHM à partir de 1, ce qui décalerait sinon l'affichage `C0`).

**Sur le pilote noyau** : `LibreHardwareMonitorLib.dll` embarque et installe lui-même son pilote WinRing0 au premier appel à `computer.Open()` — l'agent doit tourner en Administrateur/SYSTEM (cas standard pour un service Windows). **Aucun pilote PawnIO n'est plus installé par l'agent** (retiré en 1.6.8, voir page 1 — c'était une croyance erronée, source de BSOD en flotte).

### Repli WMI

Si l'extraction ou le chargement des DLL échoue, `collectLHMByWMI()` interroge l'espace de noms `root\LibreHardwareMonitor`, disponible uniquement si LibreHardwareMonitor tourne séparément comme service (`LibreHardwareMonitor.exe --service`). Ce chemin est un simple repli de compatibilité, pas le mode nominal.

## Source 3 — ASUS ATK WMI (`AsusAtkWmi_WMNB`)

`collectAsusATKTemps()` interroge la méthode `DSTS` de la classe WMI `root\wmi\AsusAtkWmi_WMNB`, présente sur les cartes mères ASUS. Le format retourné est `0x00010000 | (temp × 10)` quand l'ID de capteur est supporté par la carte, `0` sinon :

```powershell
if (($s -band 0xFFFF0000) -eq 0x00010000) {
    $tenths = $s -band 0x0000FFFF
    $c = $tenths / 10.0
}
```

Cette méthode fonctionne de façon fiable sur les cartes pré-AM5 ; sur les cartes AM5 Zen 4/5 récentes, l'interface DSTS renvoie systématiquement 0 pour tous les IDs — LHM (source 2) est alors la seule source viable. La table des IDs est référencée depuis `AsusWmiIO.cs` de LibreHardwareMonitor.

## Normalisation des labels

Toutes les sources passent par `sanitizeLabel()`, qui met en minuscules, remplace espaces/`/`/`\`/`-`/`.`/parenthèses/`:`/`,` par des underscores, et compacte les underscores répétés — garantissant des clés stables côté serveur (`agent_devices.sensorDisplayNames`, `prettifySensorLabel()` côté client pour l'affichage).

## Références

- `agent/temps_windows.go` — orchestration des 3 sources, parsing PowerShell
- `agent/temps_windows_lhm.go` — extraction des DLL LHM embarquées, cache version
- `agent/installer/product.wxs` — commentaire documentant le retrait de PawnIO en 1.6.8
- `agent/installer/Uninstall-Obliview-PawnIO.ps1` — script de nettoyage legacy
- `agent/temps_stub.go` — no-op sur plateformes non-Windows
- `client/src/utils/sensorLabels.ts` — `prettifySensorLabel()` pour l'affichage UI
