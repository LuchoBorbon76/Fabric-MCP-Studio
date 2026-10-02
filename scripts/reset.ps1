<#
.SYNOPSIS
    Tear down what the demo created so it can be re-run from scratch.

.DESCRIPTION
    If deploy-fabric.ps1 created the workspace, the whole workspace is deleted (including anything
    the agent built in it). If the demo ran in a pre-existing workspace, only the items recorded in
    config/demo.state.json are deleted and the remaining items are listed for manual review.

.EXAMPLE
    .\scripts\reset.ps1
.EXAMPLE
    .\scripts\reset.ps1 -Force
#>
[CmdletBinding()]
param([switch]$Force, [switch]$KeepState)

. "$PSScriptRoot\common.ps1"

$state = Get-DemoState
if (-not $state.Contains('workspaceId')) { Write-Warn2 'Nothing to reset: config/demo.state.json has no workspace.'; return }

$token = Get-FabricToken
$wsId = $state.workspaceId
$wsName = if ($state.Contains('workspaceName')) { $state.workspaceName } else { $wsId }
$deleteWorkspace = $state.Contains('createdWorkspace') -and $state.createdWorkspace

if ($deleteWorkspace) {
    Write-Step "This deletes workspace '$wsName' ($wsId) and EVERYTHING in it."
} else {
    Write-Step "Workspace '$wsName' existed before the demo; only demo-tracked items will be deleted."
}
if (-not $Force) {
    $answer = Read-Host "Type the workspace name to confirm"
    if ($answer -ne $wsName) { Write-Warn2 'Confirmation did not match. Nothing deleted.'; return }
}

if ($deleteWorkspace) {
    $null = Invoke-FabricApi -Method DELETE -Path "/workspaces/$wsId" -Token $token
    Write-Ok "Deleted workspace $wsId"
} else {
    foreach ($key in 'ontologyId', 'lakehouseId') {
        if ($state.Contains($key) -and $state[$key]) {
            try { $null = Invoke-FabricApi -Method DELETE -Path "/workspaces/$wsId/items/$($state[$key])" -Token $token; Write-Ok "Deleted $key $($state[$key])" }
            catch { Write-Warn2 "Could not delete $key $($state[$key]): $($_.Exception.Message)" }
        }
    }
    $left = @(Get-FabricCollection -Path "/workspaces/$wsId/items" -Token $token)
    if ($left.Count) {
        Write-Warn2 'Items still in the workspace (review agent-created ones such as the semantic model):'
        $left | ForEach-Object { Write-Info ("  {0,-16} {1}" -f $_.type, $_.displayName) }
    }
}

if (-not $KeepState) { Remove-Item $script:StateFile -ErrorAction SilentlyContinue; Write-Ok 'Removed config/demo.state.json' }
