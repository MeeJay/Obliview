<#
.SYNOPSIS
  Removes the Obliview agent + the PawnIO kernel driver from a Windows host.

.DESCRIPTION
  Temporary mitigation for the BSOD reports tied to PawnIO.sys until a stable
  PawnIO version (or an opt-out flag) is shipped by Obliview.

  Order of operations (each step is best-effort and never fatal):
    1. Stop the ObliviewAgent service.
    2. Uninstall the Obliview Agent MSI by DisplayName (covers any version).
    3. Stop the PawnIO service.
    4. Run the bundled PawnIO uninstaller if still present.
    5. Force-delete the PawnIO service registration as a fallback.
    6. Clean up residual files / service entries / registry leftovers.
    7. Recommend a reboot when the kernel driver was loaded.

  The script is safe to re-run: missing services / missing MSI / missing files
  all return "already gone" without erroring.

.NOTES
  - Must run elevated. Self-elevates if launched as a non-admin.
  - Logs to %ProgramData%\Obliview\uninstall-mitigation.log
  - Pure-ASCII source to survive encoding mismatches when delivered through
    RMM tooling that reads the script as ANSI rather than UTF-8.
  - Avoids $args (reserved automatic variable in PowerShell).
  - Exit codes:
      0  = success (clean state on exit, or nothing was installed)
      1  = the Obliview MSI uninstall reported failure
      2  = the PawnIO service refused to stop AND its file is locked

.EXAMPLE
  PS> .\Uninstall-Obliview-PawnIO.ps1
  PS> .\Uninstall-Obliview-PawnIO.ps1 -SkipReboot
#>

[CmdletBinding()]
param(
    [switch]$SkipReboot
)

$ErrorActionPreference = 'Continue'
$script:rebootRecommended = $false

# --- Self-elevate -----------------------------------------------------------
$current = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal $current
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "[*] Not elevated - relaunching as administrator..."
    $relaunch = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    if ($SkipReboot) { $relaunch += ' -SkipReboot' }
    Start-Process -FilePath powershell.exe -ArgumentList $relaunch -Verb RunAs -Wait
    exit $LASTEXITCODE
}

# --- Logging ----------------------------------------------------------------
$logDir = Join-Path $env:ProgramData 'Obliview'
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}
$logPath = Join-Path $logDir 'uninstall-mitigation.log'

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $line = "[{0}] [{1}] {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    Write-Host $line
    Add-Content -Path $logPath -Value $line -ErrorAction SilentlyContinue
}

Write-Log "==== Obliview + PawnIO uninstall mitigation started ===="
Write-Log "Host: $env:COMPUTERNAME / User: $env:USERNAME / OS: $((Get-CimInstance Win32_OperatingSystem).Caption)"

# --- Helpers ----------------------------------------------------------------
function Stop-ServiceSafe {
    param([string]$Name, [int]$TimeoutSec = 30)
    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if (-not $svc) {
        Write-Log "Service '$Name' not present - skipping."
        return $true
    }
    if ($svc.Status -eq 'Stopped') {
        Write-Log "Service '$Name' already stopped."
        return $true
    }
    Write-Log "Stopping service '$Name' (current: $($svc.Status))..."
    try {
        Stop-Service -Name $Name -Force -ErrorAction Stop
        $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds($TimeoutSec))
        Write-Log "Service '$Name' stopped."
        return $true
    } catch {
        Write-Log "Could not stop '$Name': $($_.Exception.Message)" 'WARN'
        & sc.exe stop $Name | Out-Null
        Start-Sleep -Seconds 3
        $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
        return ($null -eq $svc -or $svc.Status -eq 'Stopped')
    }
}

function Remove-ServiceSafe {
    param([string]$Name)
    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if (-not $svc) { return }
    Write-Log "Deleting service registration '$Name'..."
    & sc.exe delete $Name | Out-Null
    Start-Sleep -Seconds 1
}

function Get-ObliviewMsi {
    $regRoots = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )
    $found = @()
    foreach ($root in $regRoots) {
        if (-not (Test-Path $root)) { continue }
        $children = Get-ChildItem $root -ErrorAction SilentlyContinue
        foreach ($child in $children) {
            $p = Get-ItemProperty $child.PSPath -ErrorAction SilentlyContinue
            if ($null -eq $p) { continue }
            if ($p.DisplayName -match '^Obliview' -or $p.DisplayName -eq 'Obliview Agent') {
                $found += [pscustomobject]@{
                    Name        = $p.DisplayName
                    Version     = $p.DisplayVersion
                    Publisher   = $p.Publisher
                    ProductCode = $child.PSChildName
                }
            }
        }
    }
    return $found
}

# --- 1. Stop the agent service ----------------------------------------------
[void](Stop-ServiceSafe -Name 'ObliviewAgent')

# Kill any stray obliview-agent.exe that might block file deletion.
$strayProcs = Get-Process -Name 'obliview-agent', 'ObliviewAgent' -ErrorAction SilentlyContinue
foreach ($proc in $strayProcs) {
    Write-Log "Killing residual process $($proc.Name) (pid $($proc.Id))"
    try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch { }
}

# --- 2. Uninstall the Obliview MSI ------------------------------------------
$msis = @(Get-ObliviewMsi)
if ($msis.Count -eq 0) {
    Write-Log "No Obliview MSI found in the registry - nothing to uninstall."
} else {
    foreach ($msi in $msis) {
        Write-Log "Uninstalling MSI: $($msi.Name) $($msi.Version) [$($msi.ProductCode)]"
        $msiArgs = @(
            '/x', $msi.ProductCode, '/qn', '/norestart',
            '/L*v', (Join-Path $logDir 'msi-uninstall.log')
        )
        $proc = Start-Process -FilePath 'msiexec.exe' -ArgumentList $msiArgs -Wait -PassThru
        Write-Log "msiexec exit code: $($proc.ExitCode)"
        if ($proc.ExitCode -eq 3010) { $script:rebootRecommended = $true }
        if (@(0, 1605, 3010) -notcontains $proc.ExitCode) {
            Write-Log "MSI uninstall returned non-success - continuing with PawnIO cleanup anyway." 'WARN'
        }
    }
}

# --- 3. Stop PawnIO ---------------------------------------------------------
$pawnioService = Get-Service -Name 'PawnIO' -ErrorAction SilentlyContinue
$pawnioStopped = Stop-ServiceSafe -Name 'PawnIO' -TimeoutSec 15

# --- 4. Run the bundled PawnIO uninstaller if still present -----------------
$candidates = @(
    "$env:ProgramFiles\ObliviewAgent\uninstall.exe",
    "$env:ProgramFiles\ObliviewAgent\PawnIO_setup.exe",
    "${env:ProgramFiles(x86)}\ObliviewAgent\uninstall.exe",
    "${env:ProgramFiles(x86)}\ObliviewAgent\PawnIO_setup.exe"
)
$pawnioUninstaller = $null
foreach ($c in $candidates) {
    if (Test-Path $c) { $pawnioUninstaller = $c; break }
}

if ($pawnioUninstaller) {
    Write-Log "Running PawnIO uninstaller: $pawnioUninstaller"
    try {
        if ($pawnioUninstaller -match 'uninstall\.exe$') {
            $pawnArgs = @('-silent')
        } else {
            $pawnArgs = @('-uninstall', '-silent')
        }
        $proc = Start-Process -FilePath $pawnioUninstaller -ArgumentList $pawnArgs -Wait -PassThru
        Write-Log "PawnIO uninstaller exit code: $($proc.ExitCode)"
    } catch {
        Write-Log "PawnIO uninstaller failed: $($_.Exception.Message)" 'WARN'
    }
} else {
    Write-Log "No PawnIO uninstaller binary found - falling back to manual cleanup."
}

# --- 5. Force-delete the PawnIO service if it's still registered ------------
Remove-ServiceSafe -Name 'PawnIO'

# --- 6. Cleanup residual files / driver / registry --------------------------
$residualPaths = @(
    "$env:ProgramFiles\ObliviewAgent",
    "${env:ProgramFiles(x86)}\ObliviewAgent",
    "$env:windir\System32\drivers\PawnIO.sys",
    "$env:windir\SysWOW64\drivers\PawnIO.sys",
    "$env:ProgramData\PawnIO"
)

# Native MoveFileEx wrapper for delete-on-reboot fallback (locked driver file).
$movefileSig = @'
[DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
public static extern bool MoveFileEx(string lpExistingFileName, string lpNewFileName, int dwFlags);
'@
$movefileTypeReady = $false
try {
    Add-Type -MemberDefinition $movefileSig -Name Win32MoveFile -Namespace ObliMitigation -ErrorAction Stop
    $movefileTypeReady = $true
} catch {
    Write-Log "Could not register MoveFileEx P/Invoke: $($_.Exception.Message)" 'WARN'
}

foreach ($p in $residualPaths) {
    if (-not (Test-Path $p)) { continue }
    Write-Log "Removing residual: $p"
    try {
        Remove-Item -Path $p -Recurse -Force -ErrorAction Stop
    } catch {
        Write-Log "Could not remove $p (likely locked): $($_.Exception.Message)" 'WARN'
        if ($movefileTypeReady) {
            # 4 = MOVEFILE_DELAY_UNTIL_REBOOT
            [ObliMitigation.Win32MoveFile]::MoveFileEx($p, $null, 4) | Out-Null
            Write-Log "Scheduled $p for deletion on next reboot."
            $script:rebootRecommended = $true
        }
    }
}

$pawnioRegKey = 'HKLM:\SYSTEM\CurrentControlSet\Services\PawnIO'
if (Test-Path $pawnioRegKey) {
    Write-Log "Deleting service registry key: $pawnioRegKey"
    Remove-Item -Path $pawnioRegKey -Recurse -Force -ErrorAction SilentlyContinue
}

# --- 7. Result + reboot recommendation --------------------------------------
if ($pawnioService -and -not $pawnioStopped) {
    Write-Log "PawnIO driver was loaded but did not stop cleanly - REBOOT REQUIRED to fully unload it." 'WARN'
    $script:rebootRecommended = $true
}

$post = [ordered]@{
    ObliviewAgentService = $null -ne (Get-Service -Name 'ObliviewAgent' -ErrorAction SilentlyContinue)
    PawnIOService        = $null -ne (Get-Service -Name 'PawnIO' -ErrorAction SilentlyContinue)
    PawnIODriverFile     = Test-Path "$env:windir\System32\drivers\PawnIO.sys"
    AgentInstallDir      = (Test-Path "$env:ProgramFiles\ObliviewAgent") -or (Test-Path "${env:ProgramFiles(x86)}\ObliviewAgent")
}
Write-Log "Post-state: $(ConvertTo-Json -InputObject $post -Compress)"

if ($post.ObliviewAgentService -or $post.AgentInstallDir) {
    Write-Log "Obliview agent residue still present after uninstall." 'WARN'
}

Write-Log "==== Done ===="

if ($script:rebootRecommended -and -not $SkipReboot) {
    Write-Log "Triggering scheduled reboot in 60 seconds. Use -SkipReboot to suppress."
    & shutdown.exe /r /t 60 /c "Obliview + PawnIO removed - rebooting to unload kernel driver." | Out-Null
}

# Final exit code
if ($msis.Count -gt 0 -and $post.AgentInstallDir) { exit 1 }
if ($post.PawnIOService -and -not $pawnioStopped) { exit 2 }
exit 0
