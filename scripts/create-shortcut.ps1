<#
.SYNOPSIS
    Create a "Fabric MCP Studio" shortcut on the desktop (and optionally in the Start menu).

.DESCRIPTION
    The shortcut runs Start-Studio.cmd from this repository in a minimized window and opens the studio in your
    browser. If the studio is already running, it opens the running copy instead of starting a second one.
    Installs the studio's Node.js dependencies first (if needed) so the first launch is quick.

.EXAMPLE
    .\scripts\create-shortcut.ps1
    Desktop shortcut.

.EXAMPLE
    .\scripts\create-shortcut.ps1 -StartMenu
    Desktop and Start menu shortcuts.

.EXAMPLE
    .\scripts\create-shortcut.ps1 -Remove
    Remove the shortcuts.
#>
[CmdletBinding()]
param(
    [switch]$StartMenu,
    [switch]$Remove,
    [switch]$SkipInstall,
    [string]$Name = 'Fabric MCP Studio'
)

. "$PSScriptRoot\common.ps1"

if ($env:OS -ne 'Windows_NT') { throw 'Shortcuts are created on Windows only. On macOS or Linux run ./studio/start-studio.sh.' }

$launcher = Join-Path $script:RepoRoot 'Start-Studio.cmd'
$studio = Join-Path $script:RepoRoot 'studio'
$icon = Join-Path $studio 'assets\fabric-mcp-studio.ico'
$locations = @([Environment]::GetFolderPath('Desktop'))
if ($StartMenu) { $locations += [Environment]::GetFolderPath('Programs') }

if ($Remove) {
    Write-Step 'Removing shortcuts'
    foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
        $lnk = Join-Path $dir "$Name.lnk"
        if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force; Write-Ok "Removed $lnk" }
    }
    return
}

Write-Step 'Checking prerequisites'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 20 or later is required. Install the LTS version from https://nodejs.org and run this again.' }
Write-Ok "Node.js $(node --version)"
if (-not (Test-Path -LiteralPath $launcher)) { throw "Start-Studio.cmd was not found at $launcher." }

if (-not $SkipInstall -and -not (Test-Path -LiteralPath (Join-Path $studio 'node_modules\@github\copilot-sdk'))) {
    Write-Step 'Installing studio dependencies (first run only)'
    Push-Location $studio
    try {
        & npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'npm install failed. Check your network or proxy settings and try again.' }
    } finally { Pop-Location }
    Write-Ok 'Dependencies installed'
}

Write-Step "Creating the ""$Name"" shortcut"
$shell = New-Object -ComObject WScript.Shell
foreach ($dir in $locations) {
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $path = Join-Path $dir "$Name.lnk"
    $lnk = $shell.CreateShortcut($path)
    $lnk.TargetPath = $launcher
    $lnk.WorkingDirectory = $studio
    $lnk.WindowStyle = 7   # minimized - the studio opens in your browser
    $lnk.Description = 'Build Fabric workspaces, semantic models and ontologies with the Copilot you already use.'
    if (Test-Path -LiteralPath $icon) { $lnk.IconLocation = "$icon,0" }
    $lnk.Save()
    Write-Ok $path
}
Write-Info 'Double-click the shortcut to open the studio. Close it with "Shut down" in the app (or close its taskbar window).'
