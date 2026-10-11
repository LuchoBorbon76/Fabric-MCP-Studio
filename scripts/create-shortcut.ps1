<#
.SYNOPSIS
    Create a "Fabric MCP Studio" shortcut on the desktop (and optionally in the Start menu).

.DESCRIPTION
    The shortcut starts the studio in the background (no console window) and opens it in your browser. If the
    studio is already running, it opens the running copy instead of starting a second one. Stop the studio with
    "Shut down" in the app; server output is written to studio\data\studio.log.
    Installs the studio's Node.js dependencies first (if needed) so the first launch is quick.

    If Windows Script Host is turned off on this computer (some organizations do that), or you use -ShowConsole,
    the shortcut runs Start-Studio.cmd in a minimized console window instead.

.EXAMPLE
    .\scripts\create-shortcut.ps1
    Desktop shortcut.

.EXAMPLE
    .\scripts\create-shortcut.ps1 -StartMenu
    Desktop and Start menu shortcuts.

.EXAMPLE
    .\scripts\create-shortcut.ps1 -ShowConsole
    Desktop shortcut that runs the studio in a minimized console window (useful for troubleshooting).

.EXAMPLE
    .\scripts\create-shortcut.ps1 -Remove
    Remove the shortcuts to this copy of the studio (a shortcut with the same name to another copy stays).
#>
[CmdletBinding()]
param(
    [switch]$StartMenu,
    [switch]$Remove,
    [switch]$SkipInstall,
    [switch]$ShowConsole,
    [string]$Name = 'Fabric MCP Studio'
)

. "$PSScriptRoot\common.ps1"

if ($env:OS -ne 'Windows_NT') { throw 'Shortcuts are created on Windows only. On macOS or Linux run ./studio/start-studio.sh.' }

$launcher = Join-Path $script:RepoRoot 'Start-Studio.cmd'
$studio = Join-Path $script:RepoRoot 'studio'
$silent = Join-Path $studio 'Start-Studio-Silent.wsf'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$icon = Join-Path $studio 'assets\fabric-mcp-studio-v2.ico'
$locations = @([Environment]::GetFolderPath('Desktop'))
if ($StartMenu) { $locations += [Environment]::GetFolderPath('Programs') }

if ($Remove) {
    Write-Step 'Removing shortcuts'
    $shell = New-Object -ComObject WScript.Shell
    $root = $script:RepoRoot.TrimEnd('\') + '\'
    foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
        $lnk = Join-Path $dir "$Name.lnk"
        if (-not (Test-Path -LiteralPath $lnk)) { continue }
        # Only a shortcut to this copy of the studio: another copy (installed elsewhere) keeps its shortcut.
        $s = $shell.CreateShortcut($lnk)
        $points = "$($s.TargetPath)|$($s.Arguments)|$($s.WorkingDirectory.TrimEnd('\'))\"
        if ($points.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
            Write-Info "Kept $lnk - it opens another copy of the studio ($($s.WorkingDirectory))"
            continue
        }
        Remove-Item -LiteralPath $lnk -Force; Write-Ok "Removed $lnk"
    }
    return
}

Write-Step 'Checking prerequisites'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 20 or later is required. Install the LTS version from https://nodejs.org and run this again.' }
Write-Ok "Node.js $(node --version)"
if (-not (Test-Path -LiteralPath $launcher)) { throw "Start-Studio.cmd was not found at $launcher." }

function Test-ScriptHostEnabled {
    foreach ($hive in 'HKCU:', 'HKLM:') {
        $v = Get-ItemProperty -Path "$hive\Software\Microsoft\Windows Script Host\Settings" -Name Enabled -ErrorAction SilentlyContinue
        if ($v -and "$($v.Enabled)" -eq '0') { return $false }
    }
    return (Test-Path -LiteralPath $wscript)
}
$useSilent = -not $ShowConsole -and (Test-Path -LiteralPath $silent) -and (Test-ScriptHostEnabled)
if (-not $ShowConsole -and -not $useSilent) { Write-Warn2 'Windows Script Host is turned off on this computer, so the shortcut uses a minimized console window.' }

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
    if ($useSilent) {
        $lnk.TargetPath = $wscript
        $lnk.Arguments = "//nologo `"$silent`""
        $lnk.WindowStyle = 1
    } else {
        $lnk.TargetPath = $launcher
        $lnk.Arguments = ''
        $lnk.WindowStyle = 7   # minimized - the studio opens in your browser
    }
    $lnk.WorkingDirectory = $studio
    $lnk.Description = 'Build Fabric workspaces, semantic models and ontologies with your AI assistant.'
    if (Test-Path -LiteralPath $icon) { $lnk.IconLocation = "$icon,0" }
    $lnk.Save()
    Write-Ok $path
}
if ($useSilent) { Write-Info 'Double-click the shortcut to open the studio. It runs in the background; stop it with "Shut down" in the app.' }
else { Write-Info 'Double-click the shortcut to open the studio. Stop it with "Shut down" in the app (or close its taskbar window).' }
