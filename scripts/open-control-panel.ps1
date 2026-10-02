<#
.SYNOPSIS
    Open the demo control panel in your browser, linked to your own Fabric workspace.

.DESCRIPTION
    Copies control-panel/index.html to control-panel/local.html (git-ignored), injects the IDs from
    config/demo.state.json so the "Open workspace / lakehouse / ontology" buttons and the Ontology
    MCP URL point at your tenant, and opens it. Works fully offline; nothing is sent anywhere.

.EXAMPLE
    .\scripts\open-control-panel.ps1
.EXAMPLE
    .\scripts\open-control-panel.ps1 -Client m365-copilot -NoOpen
#>
[CmdletBinding()]
param(
    [ValidateSet('vscode', 'copilot-cli', 'claude-code', 'cursor', 'm365-copilot', 'copilot-studio', 'foundry')]
    [string]$Client,
    [switch]$NoOpen
)

. "$PSScriptRoot\common.ps1"

$source = Join-Path $script:RepoRoot 'control-panel\index.html'
$target = Join-Path $script:RepoRoot 'control-panel\local.html'
$html = [IO.File]::ReadAllText($source, [Text.Encoding]::UTF8)

$state = Get-DemoState
$safe = [ordered]@{}
foreach ($k in 'workspaceId', 'workspaceName', 'lakehouseId', 'ontologyId') {
    if ($state.Contains($k) -and $state[$k]) { $safe[$k] = [string]$state[$k] }
}
$marker = 'const DEMO_STATE = null;'
if (-not $html.Contains($marker)) { throw "Marker '$marker' not found in control-panel/index.html." }
if ($safe.Count -gt 0) {
    $json = (ConvertTo-PrettyJson $safe -Compress).Replace('</', '<\/')
    $html = $html.Replace($marker, "const DEMO_STATE = $json;")
    Write-Ok "Linked to workspace '$(if ($safe.Contains('workspaceName')) { $safe.workspaceName } else { $safe.workspaceId })'"
} else {
    Write-Warn2 'No config/demo.state.json yet - Fabric links appear after deploy-fabric.ps1 or the lakehouse act.'
}
[IO.File]::WriteAllText($target, $html, (New-Object System.Text.UTF8Encoding($false)))

$uri = ([Uri]$target).AbsoluteUri
if ($Client) { $uri += "#client=$Client" }
Write-Ok "Control panel: $target"
if (-not $NoOpen) { Start-Process $uri }
