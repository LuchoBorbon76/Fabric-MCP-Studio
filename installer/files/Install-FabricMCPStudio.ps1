<#
.SYNOPSIS
    Installs (or updates) Fabric MCP Studio from its GitHub repository.

.DESCRIPTION
    1. Checks the prerequisites and shows which are there and which are missing: Windows, PowerShell, internet access,
       disk space, Git, Node.js (with npm), and the optional Azure CLI and GitHub CLI.
    2. Installs what is missing (with winget, or straight from the vendor when winget isn't available) - it asks first.
    3. Downloads the app from the repository (git clone; an existing install is updated with git pull - your projects,
       chats and settings in studio\data are kept). A private repository asks you to sign in to GitHub once.
    4. Installs the app's Node.js packages, creates the desktop shortcut, and can start the studio.

    Nothing is hard-coded: the repository, branch, folder and shortcut name come from installer.config.json next to
    this script, and every one of them can be overridden with a parameter.

.PARAMETER RepoUrl
    The Git repository to install from (default: repoUrl in installer.config.json).
.PARAMETER Branch
    The branch to install (default: branch in installer.config.json, else main).
.PARAMETER InstallDir
    Where the app goes (default: installDir in installer.config.json, else %LOCALAPPDATA%\FabricMCPStudio).
.PARAMETER ShortcutName
    Name of the desktop shortcut (default: shortcutName in installer.config.json, else "Fabric MCP Studio").
.PARAMETER CheckOnly
    Only show the prerequisites (found, missing, too old). Changes nothing.
.PARAMETER Yes
    Answer yes to every question (unattended install). Optional tools are installed only with -InstallOptional.
.PARAMETER InstallOptional
    Also install the optional tools that are missing (Azure CLI, GitHub CLI) without asking.
.PARAMETER SkipOptional
    Never offer the optional tools.
.PARAMETER StartMenu
    Also add the shortcut to the Start menu.
.PARAMETER NoShortcut
    Don't create shortcuts.
.PARAMETER Launch
    Start the studio when the install is done (without asking).
.PARAMETER GitHubToken
    Only for downloading without Git from a private repository: a token with read access (or set GITHUB_TOKEN).
.PARAMETER Uninstall
    Remove the shortcuts and the app folder. Prerequisites (Git, Node.js...) stay. Use -KeepData to keep studio\data.
.PARAMETER KeepData
    With -Uninstall: move studio\data (projects, chats, settings) next to the app folder instead of deleting it.

.EXAMPLE
    .\Install-FabricMCPStudio.ps1
.EXAMPLE
    .\Install-FabricMCPStudio.ps1 -CheckOnly
.EXAMPLE
    .\Install-FabricMCPStudio.ps1 -Yes -InstallOptional -StartMenu -Launch
.EXAMPLE
    .\Install-FabricMCPStudio.ps1 -Uninstall -KeepData
#>
[CmdletBinding()]
param(
    [string]$RepoUrl,
    [string]$Branch,
    [string]$InstallDir,
    [string]$ShortcutName,
    [switch]$CheckOnly,
    [switch]$Yes,
    [switch]$InstallOptional,
    [switch]$SkipOptional,
    [switch]$StartMenu,
    [switch]$NoShortcut,
    [switch]$Launch,
    [string]$GitHubToken,
    [switch]$Uninstall,
    [switch]$KeepData
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

# ---------------------------------------------------------------- settings

$here = $PSScriptRoot
$config = $null
$configFile = Join-Path $here 'installer.config.json'
if (Test-Path -LiteralPath $configFile) {
    try { $config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { throw "installer.config.json can't be read: $($_.Exception.Message)" }
}
function Get-Setting([string]$Value, [string]$Key, [string]$Default) {
    if ($Value) { return $Value }
    if ($config -and ($config.PSObject.Properties.Name -contains $Key) -and $config.$Key) { return [Environment]::ExpandEnvironmentVariables([string]$config.$Key) }
    return $Default
}
$RepoUrl = Get-Setting $RepoUrl 'repoUrl' ''
$Branch = Get-Setting $Branch 'branch' 'main'
$InstallDir = Get-Setting $InstallDir 'installDir' (Join-Path $env:LOCALAPPDATA 'FabricMCPStudio')
$ShortcutName = Get-Setting $ShortcutName 'shortcutName' 'Fabric MCP Studio'
$appName = Get-Setting '' 'appName' 'Fabric MCP Studio'
$minNode = [version](Get-Setting '' 'minNodeVersion' '20.19.0')
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$studioDir = Join-Path $InstallDir 'studio'

# ---------------------------------------------------------------- output and log

$logFile = Join-Path $env:TEMP ("FabricMCPStudio-install-{0:yyyyMMdd-HHmmss}.log" -f (Get-Date))
$transcript = $false
try { Start-Transcript -LiteralPath $logFile -Force | Out-Null; $transcript = $true } catch { }

function Write-Step([string]$Text) { Write-Host ''; Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "    [ok] $Text" -ForegroundColor Green }
function Write-Note([string]$Text) { Write-Host "    $Text" }
function Write-Warn([string]$Text) { Write-Host "    [!]  $Text" -ForegroundColor Yellow }
function Write-Bad([string]$Text) { Write-Host "    [x]  $Text" -ForegroundColor Red }

function Confirm-Step([string]$Question, [bool]$Default = $true) {
    if ($Yes) { return $true }
    $hint = if ($Default) { '[Y/n]' } else { '[y/N]' }
    while ($true) {
        $a = Read-Host "    $Question $hint"
        if (-not $a) { return $Default }
        if ($a -match '^(y|yes|s|si)$') { return $true }
        if ($a -match '^(n|no)$') { return $false }
    }
}

function Close-Log { if ($script:transcript) { try { Stop-Transcript | Out-Null } catch { } } }

function Stop-Installer([string]$Message, [int]$Code = 1) {
    Write-Host ''
    if ($Code) { Write-Bad $Message } else { Write-Note $Message }
    if ($transcript) { Write-Host "    Log: $logFile" -ForegroundColor DarkGray }
    Close-Log
    exit $Code
}

# ---------------------------------------------------------------- native commands (Windows PowerShell 5.1 safe)

# A native command that writes to stderr (git, npm and winget do) must not turn into a terminating error.
function Invoke-Native([string]$File, [string[]]$Arguments, [string]$WorkingDirectory, [switch]$Quiet) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    if ($WorkingDirectory) { Push-Location -LiteralPath $WorkingDirectory }
    try { if ($Quiet) { & $File @Arguments | Out-Null } else { & $File @Arguments | Out-Host }; return $LASTEXITCODE }
    finally { if ($WorkingDirectory) { Pop-Location }; $ErrorActionPreference = $old }
}
function Get-NativeOutput([string]$File, [string[]]$Arguments) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $File @Arguments 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        return (($out | ForEach-Object { "$_" }) -join "`n").Trim()
    } catch { return $null }
    finally { $ErrorActionPreference = $old }
}

# Tools installed a moment ago are on the machine and user PATH, not yet on this window's. This window's own entries
# stay first (so the same programs keep winning); what is new is added after them.
function Update-SessionPath {
    $parts = New-Object System.Collections.Generic.List[string]
    $parts.AddRange([string[]]$env:Path.Split(';'))
    foreach ($scope in 'Machine', 'User') {
        $p = [Environment]::GetEnvironmentVariable('Path', $scope)
        if ($p) { $parts.AddRange([string[]]([Environment]::ExpandEnvironmentVariables($p)).Split(';')) }
    }
    $seen = @{}
    $keep = foreach ($x in $parts) { $k = $x.TrimEnd('\').ToLowerInvariant(); if ($x -and -not $seen.ContainsKey($k)) { $seen[$k] = $true; $x } }
    $env:Path = ($keep -join ';')
}

function Find-Tool([string]$Name) {
    $c = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { return $c.Source }
    return $null
}

function ConvertTo-Version([string]$Text) {
    if ($Text -and ($Text -match '(\d+)\.(\d+)(?:\.(\d+))?')) {
        $patch = if ($Matches[3]) { $Matches[3] } else { '0' }
        return [version]("{0}.{1}.{2}" -f $Matches[1], $Matches[2], $patch)
    }
    return $null
}

# ---------------------------------------------------------------- prerequisites

$tools = @(
    [pscustomobject]@{ Id = 'git'; Name = 'Git'; Required = $true; Command = 'git'; Args = @('--version'); Min = [version]'2.30.0'; Winget = 'Git.Git'
        Why = 'Downloads the app from GitHub and keeps it up to date (Git Credential Manager signs you in to GitHub).'; Url = 'https://git-scm.com/download/win' }
    [pscustomobject]@{ Id = 'node'; Name = 'Node.js (LTS)'; Required = $true; Command = 'node'; Args = @('--version'); Min = $minNode; Winget = 'OpenJS.NodeJS.LTS'
        Why = "Runs the studio and its MCP servers (includes npm and npx). Version $minNode or later."; Url = 'https://nodejs.org/en/download' }
    [pscustomobject]@{ Id = 'npm'; Name = 'npm'; Required = $true; Command = 'npm'; Args = @('--version'); Min = $null; Winget = $null
        Why = 'Installs the app''s packages. Comes with Node.js.'; Url = 'https://nodejs.org/en/download' }
    [pscustomobject]@{ Id = 'az'; Name = 'Azure CLI (optional)'; Required = $false; Command = 'az'; Args = @('version', '-o', 'json'); Min = $null; Winget = 'Microsoft.AzureCLI'
        Why = 'Optional: the studio can reuse your "az login" to sign in to Microsoft Fabric. Without it, you sign in in the browser.'; Url = 'https://aka.ms/installazurecliwindows' }
    [pscustomobject]@{ Id = 'gh'; Name = 'GitHub CLI (optional)'; Required = $false; Command = 'gh'; Args = @('--version'); Min = $null; Winget = 'GitHub.cli'
        Why = 'Optional: sign in to GitHub Copilot as the AI provider (Settings > AI provider > Sign in with GitHub CLI). Other AI providers don''t need it.'; Url = 'https://cli.github.com' }
)

function Get-ToolState($t) {
    $path = Find-Tool $t.Command
    if (-not $path) { return [pscustomobject]@{ Tool = $t; Found = $false; Version = $null; Ok = $false; Status = 'MISSING' } }
    $out = Get-NativeOutput $t.Command $t.Args
    $v = $null
    if ($t.Id -eq 'az' -and $out) { try { $v = ConvertTo-Version (($out | ConvertFrom-Json).'azure-cli') } catch { $v = ConvertTo-Version $out } }
    else { $v = ConvertTo-Version $out }
    $ok = [bool]$v -and ((-not $t.Min) -or ($v -ge $t.Min))
    $status = if ($ok) { 'OK' } elseif (-not $v) { 'UNKNOWN' } else { 'TOO OLD' }
    return [pscustomobject]@{ Tool = $t; Found = $true; Version = $v; Ok = [bool]$ok; Status = $status }
}

function Test-Url([string]$Url) {
    try { Invoke-WebRequest -Uri $Url -Method Head -UseBasicParsing -TimeoutSec 15 | Out-Null; return $true }
    catch {
        # Any HTTP answer (even 404) proves the site can be reached.
        if ($_.Exception.PSObject.Properties.Name -contains 'Response' -and $_.Exception.Response) { return $true }
        return $false
    }
}

function Test-ScriptHost {
    foreach ($hive in 'HKCU:', 'HKLM:') {
        $v = Get-ItemProperty -Path "$hive\Software\Microsoft\Windows Script Host\Settings" -Name Enabled -ErrorAction SilentlyContinue
        if ($v -and "$($v.Enabled)" -eq '0') { return $false }
    }
    return (Test-Path -LiteralPath (Join-Path $env:SystemRoot 'System32\wscript.exe'))
}

function Show-Prerequisites {
    $rows = New-Object System.Collections.Generic.List[object]
    $row = { param($Name, $Status, $Found, $Notes) $rows.Add([pscustomobject]@{ Prerequisite = $Name; Status = $Status; Found = $Found; Notes = $Notes }) }
    $os = [Environment]::OSVersion.Version
    $osOk = ($os.Major -ge 10)
    & $row 'Windows 10 or 11' $(if ($osOk) { 'OK' } else { 'UNSUPPORTED' }) "$os" ''
    $ps = $PSVersionTable.PSVersion
    & $row 'PowerShell 5.1+' $(if ($ps -ge [version]'5.1') { 'OK' } else { 'TOO OLD' }) "$ps" ''
    $gh = Test-Url 'https://github.com'
    # The registry npm is set up to use (a company feed may replace the public one).
    $registry = 'https://registry.npmjs.org/'
    if (Find-Tool 'npm') { $r = Get-NativeOutput 'npm' @('config', 'get', 'registry'); if ($r -match '^https?://') { $registry = $r } }
    $regHost = ([uri]$registry).Host
    $npmReg = Test-Url $registry
    & $row 'Internet: github.com' $(if ($gh) { 'OK' } else { 'BLOCKED' }) '' $(if ($gh) { '' } else { 'Needed to download the app. Check the network or proxy.' })
    & $row "Internet: npm registry" $(if ($npmReg) { 'OK' } else { 'BLOCKED' }) $regHost $(if ($npmReg) { '' } else { 'Needed for the app''s packages. Check the network or proxy (npm config set proxy ...).' })
    $root = [IO.Path]::GetPathRoot($InstallDir)
    $freeGb = $null
    try { $freeGb = [math]::Round((New-Object IO.DriveInfo $root).AvailableFreeSpace / 1GB, 1) } catch { }
    & $row "Free disk space ($root)" $(if ($null -eq $freeGb) { 'UNKNOWN' } elseif ($freeGb -ge 1) { 'OK' } else { 'LOW' }) $(if ($null -ne $freeGb) { "$freeGb GB" } else { '' }) 'About 400 MB with the packages.'
    $wsh = Test-ScriptHost
    & $row 'Windows Script Host' $(if ($wsh) { 'OK' } else { 'OFF' }) '' $(if ($wsh) { 'The shortcut starts the studio without a window.' } else { 'Turned off by policy: the shortcut uses a minimized console window instead.' })
    $wg = Get-NativeOutput 'winget' @('--version')
    & $row 'winget (App Installer)' $(if ($wg) { 'OK' } else { 'MISSING' }) "$wg" $(if ($wg) { 'Installs missing tools.' } else { 'Missing tools are downloaded from the vendor instead.' })
    $states = @()
    foreach ($t in $tools) {
        $s = Get-ToolState $t
        $states += $s
        & $row $t.Name $s.Status $(if ($s.Version) { "$($s.Version)" } else { '' }) $(if ($s.Ok) { '' } else { $t.Why })
    }
    if (Find-Tool 'git') {
        $gcm = Get-NativeOutput 'git' @('credential-manager', '--version')
        & $row 'Git Credential Manager' $(if ($gcm) { 'OK' } else { 'MISSING' }) $(if ($gcm) { ($gcm -split '\+')[0] } else { '' }) $(if ($gcm) { 'Signs you in to GitHub for a private repository.' } else { 'Comes with Git for Windows; needed only for a private repository.' })
    }
    $rows | Format-Table -AutoSize -Wrap | Out-String -Width 160 | ForEach-Object { Write-Host $_.TrimEnd() }
    return [pscustomobject]@{ States = $states; Winget = [bool]$wg; Github = $gh; Npm = $npmReg; OsOk = $osOk; FreeGb = $freeGb }
}

# ---------------------------------------------------------------- installing tools

$WINGET_OK = @(0, -1978335189, -1978335135)   # done, no applicable upgrade (0x8A15002B), already installed (0x8A150061)

function Install-WithWinget($t) {
    Write-Note "winget install $($t.Winget)"
    $code = Invoke-Native 'winget' @('install', '--id', $t.Winget, '--exact', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements', '--silent')
    if ($WINGET_OK -notcontains $code) { Write-Warn "winget exited with $code." }
    return ($WINGET_OK -contains $code)
}

function Get-Download([string]$Url, [string]$File) {
    Write-Note "Downloading $Url"
    Invoke-WebRequest -Uri $Url -OutFile $File -UseBasicParsing
}

function Install-NodeDirect {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
    $lts = $index | Where-Object { $_.lts -and ([version]($_.version.TrimStart('v')) -ge $minNode) } | Select-Object -First 1
    if (-not $lts) { throw 'No Node.js LTS release found on nodejs.org.' }
    $msi = Join-Path $env:TEMP "node-$($lts.version)-$arch.msi"
    Get-Download "https://nodejs.org/dist/$($lts.version)/node-$($lts.version)-$arch.msi" $msi
    Write-Note 'Installing Node.js (Windows asks for permission)...'
    $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', "`"$msi`"", '/passive', '/norestart') -Wait -PassThru
    Remove-Item -LiteralPath $msi -Force -ErrorAction SilentlyContinue
    return ($p.ExitCode -in 0, 3010)
}

function Install-GitDirect {
    $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -UseBasicParsing -Headers @{ 'User-Agent' = 'FabricMCPStudio-Installer' }
    $pattern = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { '^Git-.*-arm64\.exe$' } else { '^Git-.*-64-bit\.exe$' }
    $asset = $rel.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
    if (-not $asset) { throw 'The Git for Windows installer was not found in its latest release.' }
    $exe = Join-Path $env:TEMP $asset.name
    Get-Download $asset.browser_download_url $exe
    Write-Note 'Installing Git (Windows asks for permission)...'
    $p = Start-Process -FilePath $exe -ArgumentList @('/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES', '/SP-') -Verb RunAs -Wait -PassThru
    Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue
    return ($p.ExitCode -eq 0)
}

function Install-Tool($t, [bool]$HaveWinget) {
    Write-Step "Installing $($t.Name)"
    # Installing or updating Node.js closes the programs that run on it (Windows replaces node.exe).
    if ($t.Id -eq 'node') {
        $nodeDir = if (Find-Tool 'node') { Split-Path -Parent (Find-Tool 'node') } else { Join-Path $env:ProgramFiles 'nodejs' }
        $running = @(Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($nodeDir, [StringComparison]::OrdinalIgnoreCase) })
        if ($running.Count) {
            Write-Warn "$($running.Count) program(s) running on Node.js will be closed by the Node.js installer (for example a running $appName or other local tools). Start them again afterwards."
            if (-not (Confirm-Step 'Continue?')) { return $false }
        }
    }
    $done = $false
    try {
        if ($HaveWinget -and $t.Winget) { $done = Install-WithWinget $t }
        elseif ($t.Id -eq 'node') { $done = Install-NodeDirect }
        elseif ($t.Id -eq 'git') { $done = Install-GitDirect }
        else { Write-Warn "Install it from $($t.Url), then run the installer again."; return $false }
    } catch { Write-Warn $_.Exception.Message; $done = $false }
    Update-SessionPath
    $s = Get-ToolState $t
    if ($s.Ok) { Write-Ok "$($t.Name) $($s.Version)"; return $true }
    if ($s.Found -and $t.Min) { Write-Warn "$($t.Name) $($s.Version) is still older than $($t.Min)." }
    else { Write-Warn "$($t.Name) isn't available yet$(if ($done) { ' (it may need a new window or a sign-out)' })." }
    return $false
}

# ---------------------------------------------------------------- the studio itself

function Get-RunningStudio {
    $rt = Join-Path $studioDir 'data\runtime.json'
    if (-not (Test-Path -LiteralPath $rt)) { return $null }
    try { $r = Get-Content -LiteralPath $rt -Raw | ConvertFrom-Json } catch { return $null }
    if (-not ($r.PSObject.Properties.Name -contains 'url') -or -not $r.url) { return $null }
    try {
        $page = Invoke-WebRequest -Uri $r.url -UseBasicParsing -TimeoutSec 5
        $m = [regex]::Match($page.Content, 'name="studio-token" content="([^"]+)"')
        if ($m.Success) { return [pscustomobject]@{ Url = $r.url; Token = $m.Groups[1].Value } }
    } catch { }
    return $null
}

function Stop-RunningStudio([string]$Why = 'update') {
    $s = Get-RunningStudio
    if (-not $s) { return $false }
    Write-Warn "$appName is running ($($s.Url)). It has to be closed to $Why it - running jobs are stopped."
    if (-not (Confirm-Step 'Close it now?')) { Stop-Installer "Close $appName with Shut down in the app, then run the installer again." }
    try { Invoke-WebRequest -Uri "$($s.Url)api/shutdown" -Method Post -Headers @{ 'x-studio-token' = $s.Token } -ContentType 'application/json' -Body '{}' -UseBasicParsing | Out-Null } catch { }
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        if (-not (Get-RunningStudio)) { Start-Sleep -Seconds 2; Write-Ok "$appName closed"; return $true }
    }
    Stop-Installer "$appName didn't close. Use Shut down in the app, then run the installer again."
}

function Get-StudioVersion {
    $pkg = Join-Path $studioDir 'package.json'
    if (-not (Test-Path -LiteralPath $pkg)) { return $null }
    try { return (Get-Content -LiteralPath $pkg -Raw | ConvertFrom-Json).version } catch { return $null }
}

function Test-StudioFolder([string]$Dir) {
    $pkg = Join-Path $Dir 'studio\package.json'
    if (-not (Test-Path -LiteralPath $pkg)) { return $false }
    try { return ((Get-Content -LiteralPath $pkg -Raw | ConvertFrom-Json).name -eq 'fabric-mcp-studio') } catch { return $false }
}

function Get-RepoKey([string]$Url) { return ([string]$Url).Trim().TrimEnd('/') -replace '\.git$', '' -replace '^https://[^@/]+@', 'https://' }

function Get-GitHubRepo([string]$Url) {
    $m = [regex]::Match($Url, 'github\.com[/:]([^/]+)/([^/]+?)(\.git)?/?$')
    if ($m.Success) { return [pscustomobject]@{ Owner = $m.Groups[1].Value; Name = $m.Groups[2].Value } }
    return $null
}

function Get-CodeWithGit {
    if (Test-Path -LiteralPath (Join-Path $InstallDir '.git')) {
        $origin = Get-NativeOutput 'git' @('-C', $InstallDir, 'remote', 'get-url', 'origin')
        if ($origin -and ((Get-RepoKey $origin) -ne (Get-RepoKey $RepoUrl))) { Write-Warn "This folder is a copy of $origin, not $RepoUrl. It is updated from its own repository." }
        Write-Step "Updating $appName from $(if ($origin) { $origin } else { $RepoUrl }) ($Branch)"
        $dirty = Get-NativeOutput 'git' @('-C', $InstallDir, 'status', '--porcelain', '--untracked-files=no')
        if ($dirty) {
            Write-Warn 'Files of the app were changed in this folder:'
            $dirty -split "`n" | Select-Object -First 10 | ForEach-Object { Write-Note "  $_" }
            if (Confirm-Step 'Keep those changes and skip the update?') { Write-Warn 'The code was not updated.'; return }
            Stop-Installer 'Nothing was changed. Undo the changes (git checkout -- .) or choose another -InstallDir.'
        }
        if ((Invoke-Native 'git' @('-C', $InstallDir, 'fetch', '--prune', 'origin', $Branch)) -ne 0) { Stop-Installer "The update couldn't be downloaded. Check that you can open $RepoUrl in a browser with the GitHub account you signed in with." }
        if ((Invoke-Native 'git' @('-C', $InstallDir, 'checkout', '-q', $Branch)) -ne 0) { Stop-Installer "Branch $Branch couldn't be selected." }
        if ((Invoke-Native 'git' @('-C', $InstallDir, 'merge', '--ff-only', '-q', "origin/$Branch")) -ne 0) { Stop-Installer 'The folder has its own commits, so it can''t be updated automatically. Choose another -InstallDir for a clean install.' }
        Write-Ok "Up to date: $(Get-NativeOutput 'git' @('-C', $InstallDir, 'log', '-1', '--format=%h %s'))"
        return
    }
    Write-Step "Downloading $appName from $RepoUrl ($Branch)"
    Write-Note 'A private repository opens a GitHub sign-in window: sign in with an account that has access to it.'
    if ((Invoke-Native 'git' @('ls-remote', '--exit-code', '--heads', $RepoUrl, $Branch) -Quiet) -ne 0) {
        Stop-Installer "The repository or branch can't be read: $RepoUrl ($Branch). Check that your GitHub account has access to it (open it in a browser) and that you signed in with that account, or use -RepoUrl / -Branch."
    }
    $parent = Split-Path -Parent $InstallDir
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    if ((Invoke-Native 'git' @('clone', '--branch', $Branch, '--single-branch', $RepoUrl, $InstallDir)) -ne 0) { Stop-Installer "Downloading $RepoUrl failed (see the messages above)." }
    Write-Ok "Downloaded to $InstallDir ($(Get-NativeOutput 'git' @('-C', $InstallDir, 'log', '-1', '--format=%h %s')))"
}

# Without Git: the branch as a zip from GitHub (no updates in place; run the installer again to update).
function Get-CodeAsZip {
    $gh = Get-GitHubRepo $RepoUrl
    if (-not $gh) { Stop-Installer "Downloading without Git works only for GitHub repositories ($RepoUrl). Install Git and run the installer again." }
    $token = if ($GitHubToken) { $GitHubToken } elseif ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } elseif (Find-Tool 'gh') { Get-NativeOutput 'gh' @('auth', 'token') } else { $null }
    $zip = Join-Path $env:TEMP "FabricMCPStudio-$Branch.zip"
    $headers = @{ 'User-Agent' = 'FabricMCPStudio-Installer' }
    if ($token) { $headers.Authorization = "Bearer $token" }
    Write-Step "Downloading $appName from $RepoUrl ($Branch) without Git"
    try { Invoke-WebRequest -Uri "https://api.github.com/repos/$($gh.Owner)/$($gh.Name)/zipball/$Branch" -Headers $headers -OutFile $zip -UseBasicParsing }
    catch { Stop-Installer "The repository can't be downloaded ($($_.Exception.Message)). A private repository needs Git (it signs you in) or -GitHubToken." }
    $tmp = Join-Path $env:TEMP ("FabricMCPStudio-src-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
    $src = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
    $keep = $null
    if (Test-StudioFolder $InstallDir) {
        $data = Join-Path $studioDir 'data'
        if (Test-Path -LiteralPath $data) { $keep = Join-Path $env:TEMP ("FabricMCPStudio-data-" + [guid]::NewGuid().ToString('N').Substring(0, 8)); Move-Item -LiteralPath $data -Destination $keep }
        Remove-Item -LiteralPath $InstallDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Get-ChildItem -LiteralPath $src.FullName -Force | Move-Item -Destination $InstallDir
    if ($keep) { Move-Item -LiteralPath $keep -Destination (Join-Path $studioDir 'data') }
    Remove-Item -LiteralPath $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Write-Ok "Downloaded to $InstallDir"
}

function Install-Packages {
    Write-Step 'Installing the app''s packages (npm - about 150 MB the first time)'
    $lock = Test-Path -LiteralPath (Join-Path $studioDir 'package-lock.json')
    $npmArgs = if ($lock) { @('ci', '--no-audit', '--no-fund') } else { @('install', '--no-audit', '--no-fund') }
    $code = Invoke-Native 'npm' $npmArgs $studioDir
    if ($code -ne 0 -and $lock) {
        Write-Warn 'npm ci failed - trying npm install.'
        $code = Invoke-Native 'npm' @('install', '--no-audit', '--no-fund') $studioDir
    }
    if ($code -ne 0) { Stop-Installer 'Installing the packages failed. Check the network or proxy (npm config set proxy http://proxy:port), then run the installer again.' }
    if (-not (Test-Path -LiteralPath (Join-Path $studioDir 'node_modules\@github\copilot-sdk'))) { Stop-Installer 'The packages are incomplete (@github/copilot-sdk is missing). Run the installer again.' }
    if ((Invoke-Native 'node' @('--check', (Join-Path $studioDir 'server\main.mjs'))) -ne 0) { Stop-Installer 'The app''s code didn''t pass a syntax check. Run the installer again to download it.' }
    Write-Ok 'Packages installed'
}

function New-Shortcuts {
    $script = Join-Path $InstallDir 'scripts\create-shortcut.ps1'
    if (-not (Test-Path -LiteralPath $script)) { Write-Warn 'scripts\create-shortcut.ps1 is missing - no shortcut created.'; return $null }
    $shortcutArgs = @{ SkipInstall = $true; Name = $ShortcutName }
    if ($StartMenu) { $shortcutArgs.StartMenu = $true }
    & $script @shortcutArgs
    $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) "$ShortcutName.lnk"
    if (Test-Path -LiteralPath $lnk) { return $lnk }
    return $null
}

# Start the studio the way the shortcut does (hidden), or in a minimized console when Windows Script Host is off.
# After an update of a running studio its browser tab is still open (it reconnects), so no new tab then.
function Start-Studio([bool]$OpenBrowser) {
    $wsf = Join-Path $studioDir 'Start-Studio-Silent.wsf'
    $extra = if ($OpenBrowser) { @() } else { @('--no-open') }
    if ((Test-ScriptHost) -and (Test-Path -LiteralPath $wsf)) {
        Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') -ArgumentList (@('//nologo', "`"$wsf`"") + $extra) -WorkingDirectory $studioDir
    } else {
        $sp = @{ FilePath = (Join-Path $InstallDir 'Start-Studio.cmd'); WorkingDirectory = $studioDir; WindowStyle = 'Minimized' }
        if ($extra.Count) { $sp.ArgumentList = $extra }
        Start-Process @sp
    }
}

# ---------------------------------------------------------------- uninstall

function Invoke-Uninstall {
    Write-Step "Uninstalling $appName from $InstallDir"
    if (-not (Test-StudioFolder $InstallDir)) { Stop-Installer "$InstallDir doesn't contain $appName. Nothing was removed (use -InstallDir to point to the right folder)." }
    $what = if ($KeepData) { ' (your projects, chats and settings are kept)' } else { ' including your projects, chats and settings' }
    if (-not (Confirm-Step "Remove the shortcuts and $InstallDir$($what)?" $false)) { Stop-Installer 'Nothing was removed.' 0 }
    Stop-RunningStudio 'remove' | Out-Null
    foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
        $lnk = Join-Path $dir "$ShortcutName.lnk"
        if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force; Write-Ok "Removed $lnk" }
    }
    if ($KeepData -and (Test-Path -LiteralPath (Join-Path $studioDir 'data'))) {
        $dest = "$InstallDir-data-{0:yyyyMMdd-HHmmss}" -f (Get-Date)
        Move-Item -LiteralPath (Join-Path $studioDir 'data') -Destination $dest
        Write-Ok "Your data was moved to $dest"
    }
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
    Write-Ok "Removed $InstallDir"
    Write-Note 'Git, Node.js and the other tools stay installed (other apps may use them).'
}

# ---------------------------------------------------------------- main

Write-Host ''
Write-Host "  $appName - installer" -ForegroundColor White
Write-Host "  Repository: $(if ($RepoUrl) { "$RepoUrl ($Branch)" } else { '(not set)' })" -ForegroundColor DarkGray
Write-Host "  Folder:     $InstallDir" -ForegroundColor DarkGray
if ($transcript) { Write-Host "  Log:        $logFile" -ForegroundColor DarkGray }

# Files from a downloaded zip carry the "from the internet" mark; clear it so the scripts can run.
try { Get-ChildItem -LiteralPath $here -Recurse -File | Unblock-File -ErrorAction SilentlyContinue } catch { }

if ($env:OS -ne 'Windows_NT') { Stop-Installer 'This installer is for Windows. On macOS or Linux: git clone the repository, then run ./studio/start-studio.sh.' }

if ($Uninstall) { Invoke-Uninstall; Close-Log; exit 0 }

Write-Step 'Checking the prerequisites'
$check = Show-Prerequisites
if ($CheckOnly) {
    $missing = @($check.States | Where-Object { $_.Tool.Required -and -not $_.Ok })
    if ($missing.Count) { Write-Warn "Missing or too old: $(($missing | ForEach-Object { $_.Tool.Name }) -join ', '). The installer can install them." }
    else { Write-Ok 'Everything required is installed.' }
    if (Test-StudioFolder $InstallDir) { Write-Note "$appName $(Get-StudioVersion) is installed in $InstallDir." } else { Write-Note "$appName isn't installed in $InstallDir yet." }
    Close-Log
    exit 0
}

if (-not $RepoUrl) { Stop-Installer 'No repository is set. Put repoUrl in installer.config.json or use -RepoUrl https://github.com/<owner>/<repo>.git' }
if (-not $check.OsOk) { Stop-Installer 'Windows 10 or 11 is required.' }
if (-not $check.Github) { Stop-Installer 'github.com can''t be reached. Check the network or proxy, then run the installer again.' }
if ($null -ne $check.FreeGb -and $check.FreeGb -lt 1) { Write-Warn "Only $($check.FreeGb) GB free on the drive of $InstallDir." }
if ($env:OneDrive -and $InstallDir.StartsWith($env:OneDrive, [StringComparison]::OrdinalIgnoreCase)) { Write-Warn 'The folder is in OneDrive: syncing the app''s packages is slow. A folder outside OneDrive is better (-InstallDir).' }
if ((Test-Path -LiteralPath $InstallDir) -and -not (Test-StudioFolder $InstallDir) -and @(Get-ChildItem -LiteralPath $InstallDir -Force -ErrorAction SilentlyContinue).Count) {
    Stop-Installer "$InstallDir already has other files. Choose another folder with -InstallDir (or empty it)."
}

# Required tools that are missing or too old.
$useZip = $false
foreach ($s in @($check.States | Where-Object { $_.Tool.Required -and -not $_.Ok -and $_.Tool.Id -ne 'npm' })) {
    $t = $s.Tool
    $what = if ($s.Found) { "$($t.Name) $($s.Version) is older than $($t.Min)" } else { "$($t.Name) is missing" }
    Write-Warn "$what. $($t.Why)"
    if (Confirm-Step "Install $($t.Name) now?") {
        if (Install-Tool $t $check.Winget) { continue }
    }
    if ($t.Id -eq 'git') { Write-Warn 'Without Git the app is downloaded as a zip file (to update it, run the installer again).'; $useZip = $true; continue }
    Stop-Installer "$($t.Name) is required. Install it from $($t.Url), open a new window and run the installer again."
}
Update-SessionPath
$npm = Get-ToolState ($tools | Where-Object { $_.Id -eq 'npm' })
if (-not $npm.Ok) { Stop-Installer 'npm (part of Node.js) wasn''t found. Reinstall Node.js LTS from https://nodejs.org, open a new window and run the installer again.' }

# Optional tools.
if (-not $SkipOptional) {
    foreach ($s in @($check.States | Where-Object { -not $_.Tool.Required -and -not $_.Ok })) {
        $t = $s.Tool
        Write-Host ''
        Write-Note "$($t.Name) isn't installed. $($t.Why)"
        $go = if ($InstallOptional) { $true } elseif ($Yes) { $false } else { Confirm-Step "Install $($t.Name)?" $false }
        if ($go) { Install-Tool $t $check.Winget | Out-Null }
    }
}

# The app.
$before = Get-StudioVersion
$wasRunning = $false
if (Test-StudioFolder $InstallDir) {
    Write-Step "$appName $before is installed in $InstallDir - updating it"
    $wasRunning = Stop-RunningStudio
}
if ($useZip -or -not (Find-Tool 'git')) { Get-CodeAsZip } else { Get-CodeWithGit }
if (-not (Test-StudioFolder $InstallDir)) { Stop-Installer "The download doesn't contain $appName (studio\package.json is missing). Check -RepoUrl and -Branch." }
Install-Packages

$lnk = $null
if (-not $NoShortcut) { $lnk = New-Shortcuts }

# Summary.
$after = Get-StudioVersion
Write-Step 'Prerequisites now'
Show-Prerequisites | Out-Null
Write-Step 'Done'
Write-Ok "$appName $after$(if ($before -and $before -ne $after) { " (was $before)" }) in $InstallDir"
if ($lnk) { Write-Ok "Desktop shortcut: $lnk" }
Write-Note 'Your projects, chats and settings are kept in studio\data when you update (run the installer again).'
Write-Note "Next: start $appName, sign in with your Microsoft Entra work account and choose your AI provider in Settings."
if ($transcript) { Write-Host "    Log: $logFile" -ForegroundColor DarkGray }

$start = $Launch -or $wasRunning -or ((-not $Yes) -and (Confirm-Step "Start $appName now?"))
if ($start) {
    Start-Studio (-not $wasRunning)
    Write-Ok $(if ($wasRunning) { "$appName is starting again - its page in your browser reconnects." } else { "$appName is starting - it opens in your browser." })
}
Close-Log
exit 0
