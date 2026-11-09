<#
.SYNOPSIS
    Update Fabric MCP Studio in place, refresh dependencies, and optionally start it.

.DESCRIPTION
    For customer machines that already have a local copy of this repository.
    Default behavior:
      1) git fetch + pull (fast-forward only)
      2) npm ci in the studio folder
      3) start the app

    Optional corporate TLS support:
      -CertPath C:\path\corp-root.pem
    sets NODE_EXTRA_CA_CERTS for this run and writes npm's cafile setting.

    Demo-only fallback:
      -DemoInsecureTls
    sets NODE_TLS_REJECT_UNAUTHORIZED=0 for this run.

    To update only (no launch):
      -StartMode none
#>
[CmdletBinding()]
param(
    [string]$CertPath,
    [switch]$SkipGitPull,
    [ValidateSet('none', 'start', 'start-no-open')]
    [string]$StartMode = 'start',
    [switch]$DemoInsecureTls
)

. "$PSScriptRoot\common.ps1"

$repo = $script:RepoRoot
$studio = Join-Path $repo 'studio'
$gitDir = Join-Path $repo '.git'
$packageJson = Join-Path $studio 'package.json'

if ($env:OS -ne 'Windows_NT') { throw 'This updater is for Windows. On macOS/Linux, pull and run ./studio/start-studio.sh.' }
if (-not (Test-Path -LiteralPath $packageJson)) { throw "Studio package.json was not found at $packageJson." }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 20 or later is required. Install Node.js LTS from https://nodejs.org and run this updater again.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm was not found. Reinstall Node.js LTS and run this updater again.' }

function Stop-RunningStudio {
    param([int]$Port = 4870)
    $uri = "http://127.0.0.1:$Port/api/shutdown"
    try {
        $null = Invoke-WebRequest -UseBasicParsing -Method POST -Uri $uri -TimeoutSec 2
        Write-Info "Asked the running studio on port $Port to shut down."
        Start-Sleep -Seconds 2
    } catch [System.Net.WebException] {
        # No local studio on this port (or it is already stopping) - continue.
    }
}

function Stop-StudioProcesses {
    param([string]$StudioPath)
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $root = @($all | Where-Object {
            $_.ProcessId -ne $PID -and (
                ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($StudioPath, [StringComparison]::OrdinalIgnoreCase)) -or
                ($_.CommandLine -and $_.CommandLine.IndexOf($StudioPath, [StringComparison]::OrdinalIgnoreCase) -ge 0)
            )
        })

    if (-not $root) { return }

    $kill = New-Object System.Collections.Generic.HashSet[int]
    $queue = New-Object System.Collections.Generic.Queue[int]
    foreach ($p in $root) { $null = $kill.Add([int]$p.ProcessId); $queue.Enqueue([int]$p.ProcessId) }
    while ($queue.Count -gt 0) {
        $parent = $queue.Dequeue()
        foreach ($c in $all | Where-Object { $_.ParentProcessId -eq $parent }) {
            if ($kill.Add([int]$c.ProcessId)) { $queue.Enqueue([int]$c.ProcessId) }
        }
    }

    foreach ($pidToStop in (@($kill) | Sort-Object -Descending)) {
        try {
            Stop-Process -Id $pidToStop -Force -ErrorAction Stop
            Write-Info "Stopped local studio process $pidToStop."
        } catch {
            Write-Warn2 "Could not stop process ${pidToStop}: $($_.Exception.Message)"
        }
    }
}

if (-not $SkipGitPull) {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw 'Git was not found. Install Git and run again, or rerun the installer. If files were already copied manually, use -SkipGitPull.'
    }
    if (-not (Test-Path -LiteralPath $gitDir)) {
        throw "No .git folder found at $repo. Run this from a cloned repository, or use -SkipGitPull if the new files were copied manually."
    }

    $dirty = & git -C $repo status --porcelain
    if ($LASTEXITCODE -ne 0) { throw 'git status failed. Check repository access and try again.' }
    if ($dirty) {
        throw 'Local repository changes were found. Commit/stash/discard them before updating, or rerun with -SkipGitPull.'
    }

    Write-Step 'Pulling latest code'
    & git -C $repo fetch --all --prune
    if ($LASTEXITCODE -ne 0) { throw 'git fetch failed. Check network/proxy access to GitHub and try again.' }
    & git -C $repo pull --ff-only
    if ($LASTEXITCODE -ne 0) { throw 'git pull --ff-only failed. Resolve branch/upstream issues and rerun.' }
    Write-Ok 'Repository updated'
} else {
    Write-Info 'Skipping git pull (-SkipGitPull).'
}

if ($CertPath) {
    $resolvedCert = (Resolve-Path -LiteralPath $CertPath).Path
    Write-Step 'Applying corporate TLS certificate settings'
    $env:NODE_EXTRA_CA_CERTS = $resolvedCert
    Write-Ok "NODE_EXTRA_CA_CERTS = $resolvedCert"
    & npm config set cafile $resolvedCert
    if ($LASTEXITCODE -ne 0) { throw 'npm config set cafile failed. Check npm configuration permissions and rerun.' }
    Write-Ok "npm cafile set to $resolvedCert"
}

if ($DemoInsecureTls) {
    Write-Warn2 'Demo-only fallback enabled: NODE_TLS_REJECT_UNAUTHORIZED=0'
    $env:NODE_TLS_REJECT_UNAUTHORIZED = '0'
}

Stop-RunningStudio
Stop-StudioProcesses -StudioPath $studio

Write-Step 'Installing studio dependencies'
& npm --prefix $studio ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
    Write-Warn2 'npm ci failed once. Retrying after stopping local studio processes.'
    Stop-StudioProcesses -StudioPath $studio
    Start-Sleep -Seconds 2
    & npm --prefix $studio ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed. Check certificate/proxy/network settings and rerun.' }
}
Write-Ok 'Dependencies updated'

switch ($StartMode) {
    'none' {
        Write-Ok 'Update complete (no launch).'
        Write-Info "Start the app with: $repo\Start-Studio.cmd"
    }
    'start' {
        Write-Step 'Starting Fabric MCP Studio'
        & npm --prefix $studio start
        exit $LASTEXITCODE
    }
    'start-no-open' {
        Write-Step 'Starting Fabric MCP Studio (no browser auto-open)'
        & npm --prefix $studio run start:no-open
        exit $LASTEXITCODE
    }
}
