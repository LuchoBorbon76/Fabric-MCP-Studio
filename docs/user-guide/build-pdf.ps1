# Builds docs\Fabric-MCP-Studio-User-Guide.pdf from user-guide.html with Microsoft Edge (or Chrome) in headless mode.
# Usage: .\docs\user-guide\build-pdf.ps1
[CmdletBinding()]
param([string]$Out)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Out) { $Out = Join-Path (Split-Path $here -Parent) 'Fabric-MCP-Studio-User-Guide.pdf' }
$html = Join-Path $here 'user-guide.html'
$browsers = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
)
$browser = $browsers | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $browser) { throw 'Microsoft Edge or Google Chrome is needed to build the PDF.' }

$url = 'file:///' + ($html -replace '\\', '/')
$profile = Join-Path $env:TEMP "fms-guide-pdf-$PID"
if (Test-Path $Out) { Remove-Item $Out -Force }
$args = @('--headless=new', '--disable-gpu', '--no-first-run', '--allow-file-access-from-files', "--user-data-dir=$profile",
  '--no-pdf-header-footer', '--virtual-time-budget=15000', "--print-to-pdf=$Out", $url)
$p = Start-Process -FilePath $browser -ArgumentList $args -PassThru -WindowStyle Hidden
$p.WaitForExit(120000) | Out-Null
Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
if (-not (Test-Path $Out)) { throw "The PDF wasn't created. Open $html in the browser and print it to PDF instead." }
Write-Host "Created $Out ($([math]::Round((Get-Item $Out).Length / 1MB, 1)) MB)"
