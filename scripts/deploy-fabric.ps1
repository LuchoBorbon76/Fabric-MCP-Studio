<#
.SYNOPSIS
    Pre-stage (or fully build) the demo lakehouse without an agent. Use it as the "plan B"
    for live demos, or to start the session at the semantic-model step.

.DESCRIPTION
    1. Finds or creates the workspace (on the capacity you choose).
    2. Finds or creates the lakehouse.
    3. Uploads data/retail/parquet/*.parquet to Files/raw/retail/ in OneLake.
    4. (Stage All) Loads each file into a Delta table with the Lakehouse Load Table API.
    5. Saves IDs to config/demo.state.json for deploy-ontology.ps1, setup.ps1 and reset.ps1.

    Uses your Azure CLI sign-in (az login). Typed Parquet files are used so column types are
    deterministic (Load to tables can't take an explicit schema for CSV).

.EXAMPLE
    .\scripts\deploy-fabric.ps1 -CapacityName "my-f2"
.EXAMPLE
    .\scripts\deploy-fabric.ps1 -WorkspaceName "Contoso Retail Demo" -Stage Files
    Only upload raw files; let the agent create the tables live.
.EXAMPLE
    .\scripts\deploy-fabric.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [string]$WorkspaceName = 'Fabric MCP Demo - Retail',
    [string]$CapacityId,
    [string]$CapacityName,
    [string]$LakehouseName = 'RetailLakehouse',
    [ValidateSet('All', 'Files')][string]$Stage = 'All',
    [string]$DataFolder = (Join-Path (Split-Path -Parent $PSScriptRoot) 'data\retail\parquet'),
    [switch]$DryRun
)

. "$PSScriptRoot\common.ps1"

$files = @(Get-ChildItem -Path $DataFolder -Filter '*.parquet' -File | Sort-Object Name)
if ($files.Count -eq 0) { throw "No .parquet files in $DataFolder. Run: python scripts/generate-sample-data.py (requires pyarrow)." }

if ($DryRun) {
    Write-Step 'Dry run - no changes will be made'
    Write-Info "Workspace : $WorkspaceName (capacity: $(if ($CapacityId) { $CapacityId } elseif ($CapacityName) { $CapacityName } else { 'prompt' }))"
    Write-Info "Lakehouse : $LakehouseName"
    foreach ($f in $files) {
        $t = [IO.Path]::GetFileNameWithoutExtension($f.Name)
        Write-Info ("Upload    : {0,-18} -> Files/raw/retail/{0}{1}" -f $f.Name, $(if ($Stage -eq 'All') { "   then load table '$t'" } else { '' }))
    }
    return
}

$token = Get-FabricToken
$state = Get-DemoState

Write-Step "Workspace '$WorkspaceName'"
$ws = Find-FabricWorkspace $WorkspaceName $token
$createdWorkspace = $false
if ($ws) {
    Write-Ok "Found existing workspace $($ws.id)"
    if (-not (Get-Prop $ws 'capacityId')) {
        Write-Warn2 'Workspace has no capacity assigned - lakehouse creation will fail. Assign a Fabric capacity in workspace settings.'
    }
} else {
    if (-not $CapacityId) {
        $caps = @(Get-FabricCollection -Path '/capacities' -Token $token | Where-Object { $_.state -eq 'Active' })
        if ($CapacityName) { $caps = @($caps | Where-Object { $_.displayName -eq $CapacityName }) }
        if ($caps.Count -eq 0) { throw 'No matching active capacity. Pass -CapacityId/-CapacityName or start a Fabric trial.' }
        if ($caps.Count -eq 1) { $CapacityId = $caps[0].id }
        else {
            for ($i = 0; $i -lt $caps.Count; $i++) { Write-Host ("  [{0}] {1} ({2}, {3})" -f ($i + 1), $caps[$i].displayName, $caps[$i].sku, $caps[$i].region) }
            $pick = [int](Read-Host 'Capacity for the new workspace')
            $CapacityId = $caps[$pick - 1].id
        }
    }
    $ws = Invoke-FabricApi -Method POST -Path '/workspaces' -Token $token -Body ([ordered]@{
            displayName = $WorkspaceName
            description = 'Fabric MCP demo (synthetic Contoso Retail data). Safe to delete with scripts/reset.ps1.'
            capacityId  = $CapacityId
        })
    $createdWorkspace = $true
    Write-Ok "Created workspace $($ws.id)"
}

Write-Step "Lakehouse '$LakehouseName'"
$lh = Find-FabricItem $ws.id 'Lakehouse' $LakehouseName $token
if ($lh) { Write-Ok "Found existing lakehouse $($lh.id)" }
else {
    $lh = Invoke-FabricApi -Method POST -Path "/workspaces/$($ws.id)/lakehouses" -Token $token -Body ([ordered]@{
            displayName = $LakehouseName
            description = 'Raw and curated Contoso Retail tables for the Fabric MCP demo.'
        })
    if (-not (Get-Prop $lh 'id')) { $lh = Find-FabricItem $ws.id 'Lakehouse' $LakehouseName $token }
    Write-Ok "Created lakehouse $($lh.id)"
}

Write-Step 'Waiting for the SQL analytics endpoint'
$sql = $null
for ($i = 0; $i -lt 40; $i++) {
    $detail = Invoke-FabricApi -Path "/workspaces/$($ws.id)/lakehouses/$($lh.id)" -Token $token
    $props = Get-Prop $detail 'properties.sqlEndpointProperties'
    if ($props -and (Get-Prop $props 'provisioningStatus') -eq 'Success') { $sql = $props; break }
    Start-Sleep -Seconds 6
}
if ($sql) { Write-Ok "SQL endpoint $($sql.id) @ $($sql.connectionString)" } else { Write-Warn2 'SQL endpoint not ready yet; re-run later to record it.' }

Write-Step 'Uploading Parquet files to OneLake (Files/raw/retail)'
$lakeToken = Get-OneLakeToken
foreach ($f in $files) {
    Send-OneLakeFile -WorkspaceId $ws.id -ItemId $lh.id -LocalPath $f.FullName -RemotePath "Files/raw/retail/$($f.Name)" -Token $lakeToken
    Write-Ok $f.Name
}

if ($Stage -eq 'All') {
    Write-Step 'Loading Delta tables (Lakehouse Load Table API, preview)'
    foreach ($f in $files) {
        $table = [IO.Path]::GetFileNameWithoutExtension($f.Name)
        $null = Invoke-FabricApi -Method POST -Path "/workspaces/$($ws.id)/lakehouses/$($lh.id)/tables/$table/load" -Token $token -Body ([ordered]@{
                relativePath  = "Files/raw/retail/$($f.Name)"
                pathType      = 'File'
                mode          = 'Overwrite'
                recursive     = $false
                formatOptions = [ordered]@{ format = 'Parquet' }
            })
        Write-Ok "table $table"
    }
}

$state.workspaceId = $ws.id
$state.workspaceName = $WorkspaceName
$state.createdWorkspace = ($createdWorkspace -or ($state.Contains('createdWorkspace') -and $state.createdWorkspace -and $state.workspaceId -eq $ws.id))
$state.lakehouseId = $lh.id
$state.lakehouseName = $LakehouseName
if ($sql) { $state.sqlEndpointId = $sql.id; $state.sqlEndpointServer = $sql.connectionString }
Save-DemoState $state

Write-Step 'Done'
Write-Info "State saved to config/demo.state.json"
Write-Info "Open: https://app.fabric.microsoft.com/groups/$($ws.id)/lakehouses/$($lh.id)"
Write-Info 'Next: build the semantic model with your agent (skill: fabric-demo-semantic-model) or run deploy-ontology.ps1.'
