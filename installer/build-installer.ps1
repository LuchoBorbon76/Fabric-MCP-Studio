<#
.SYNOPSIS
    Builds the shareable installer zip (Fabric-MCP-Studio-Installer.zip) for this repository.

.DESCRIPTION
    Copies the installer files, writes files\installer.config.json with the repository to install from, the branch and
    the Node.js version the app needs (from studio\package.json), fills in README.txt, and zips it. Share the zip:
    whoever runs it gets the app straight from the repository (they need read access to it when it is private).

.PARAMETER RepoUrl
    Repository the installer downloads from. Required unless installer\files\installer.config.json already contains a
    share-safe repoUrl. The builder intentionally does not read the local git origin because that can leak a personal
    account in a shareable installer.
.PARAMETER Branch
    Branch to install. Default: main.
.PARAMETER InstallDir
    Default install folder written to the config. Default: %LOCALAPPDATA%\FabricMCPStudio.
.PARAMETER OutDir
    Where the zip goes. Default: dist\ in the repository (git-ignored).

.EXAMPLE
    .\installer\build-installer.ps1 -RepoUrl https://github.com/contoso/Fabric-MCP-Studio.git
.EXAMPLE
    .\installer\build-installer.ps1 -RepoUrl https://github.com/contoso/Fabric-MCP-Studio.git -OutDir $HOME\Desktop
#>
[CmdletBinding()]
param(
    [string]$RepoUrl,
    [string]$Branch = 'main',
    [string]$InstallDir = '%LOCALAPPDATA%\FabricMCPStudio',
    [string]$OutDir
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $repo 'dist' }

$pkg = Get-Content -LiteralPath (Join-Path $repo 'studio\package.json') -Raw | ConvertFrom-Json
$version = $pkg.version
$minNode = '20.19.0'
if ($pkg.PSObject.Properties.Name -contains 'engines' -and $pkg.engines.node -match '(\d+\.\d+(\.\d+)?)') { $minNode = $Matches[1] }

$stage = Join-Path ([IO.Path]::GetTempPath()) ("fms-installer-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$root = Join-Path $stage 'Fabric-MCP-Studio-Installer'
New-Item -ItemType Directory -Path (Join-Path $root 'files') -Force | Out-Null

$crlf = { param($text) ($text -replace "`r?`n", "`r`n") }
$utf8 = New-Object System.Text.UTF8Encoding($false)
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
$configPath = Join-Path $PSScriptRoot 'files\installer.config.json'
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json

if (-not $RepoUrl) {
    $RepoUrl = [string]$config.repoUrl
    if (-not $RepoUrl) {
        throw 'Pass -RepoUrl with the organization-owned repository URL to put in the shareable installer. The builder no longer reads git origin automatically because that can expose a personal account.'
    }
}
# Never ship credentials that may be part of the repository URL.
$RepoUrl = ([string]$RepoUrl).Trim() -replace '^(https?://)[^@/]+@', '$1'

# Double-click files (CRLF for cmd.exe).
foreach ($f in Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.cmd') {
    [IO.File]::WriteAllText((Join-Path $root $f.Name), (& $crlf ([IO.File]::ReadAllText($f.FullName))), [Text.Encoding]::ASCII)
}

# The installer script (BOM, so Windows PowerShell 5.1 reads it as UTF-8).
$ps1 = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'files\Install-FabricMCPStudio.ps1'))
[IO.File]::WriteAllText((Join-Path $root 'files\Install-FabricMCPStudio.ps1'), (& $crlf $ps1), $utf8Bom)

# Its settings.
$config.repoUrl = $RepoUrl
$config.branch = $Branch
$config.installDir = $InstallDir
$config.minNodeVersion = $minNode
[IO.File]::WriteAllText((Join-Path $root 'files\installer.config.json'), (& $crlf ($config | ConvertTo-Json)), $utf8)

# README with the values filled in.
$readme = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'README.txt'))
$readme = $readme.Replace('{{REPO}}', $RepoUrl).Replace('{{BRANCH}}', $Branch).Replace('{{INSTALLDIR}}', $InstallDir).Replace('{{VERSION}}', $version).Replace('{{MINNODE}}', $minNode).Replace('{{BUILT}}', (Get-Date -Format 'yyyy-MM-dd'))
[IO.File]::WriteAllText((Join-Path $root 'README.txt'), (& $crlf $readme), $utf8Bom)

# Non-technical install/use instructions, available before the app is installed.
$guide = Join-Path $repo 'docs\Fabric-MCP-Studio-User-Guide.pdf'
if (Test-Path -LiteralPath $guide) {
    Copy-Item -LiteralPath $guide -Destination (Join-Path $root 'Fabric-MCP-Studio-User-Guide.pdf') -Force
}

if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$zip = Join-Path $OutDir 'Fabric-MCP-Studio-Installer.zip'
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path $root -DestinationPath $zip
Remove-Item -LiteralPath $stage -Recurse -Force

Write-Host "Installer: $zip" -ForegroundColor Green
Write-Host "  Repository: $RepoUrl ($Branch) - people who run it need read access to it." -ForegroundColor DarkGray
Write-Host "  Built from version $version; it always installs the newest version of the branch." -ForegroundColor DarkGray
Get-Item -LiteralPath $zip
