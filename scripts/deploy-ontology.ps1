<#
.SYNOPSIS
    Deploy an ontology TMDL folder (default: ontology/retail) as a Fabric Ontology item.

.DESCRIPTION
    Packs every file under -SourceFolder into item-definition parts (InlineBase64), injects the
    lakehouse SQL analytics endpoint into expressions.tmdl, then creates the Ontology item or
    updates its definition if it already exists. Prints the Ontology MCP endpoint at the end.

    The same TMDL is what an agent writes during the "ontology as code" demo, so this script is
    both the fallback and the reference for what a good definition looks like.

.EXAMPLE
    .\scripts\deploy-ontology.ps1
    Uses workspace / lakehouse IDs from config/demo.state.json (written by deploy-fabric.ps1).
.EXAMPLE
    .\scripts\deploy-ontology.ps1 -DryRun
    Builds the payload into config/ontology.payload.json without calling Fabric.
.EXAMPLE
    .\scripts\deploy-ontology.ps1 -SourceFolder .\ontology\my-domain -OntologyName "My Domain"
#>
[CmdletBinding()]
param(
    [string]$WorkspaceId,
    [string]$LakehouseId,
    [string]$OntologyName = 'Contoso_Retail_Ontology',
    [string]$SourceFolder = (Join-Path (Split-Path -Parent $PSScriptRoot) 'ontology\retail'),
    [switch]$DryRun,
    [string]$PayloadFile = (Join-Path (Split-Path -Parent $PSScriptRoot) 'config\ontology.payload.json')
)

. "$PSScriptRoot\common.ps1"

$SourceFolder = (Resolve-Path $SourceFolder).Path
# Ontology item names allow only letters, numbers and underscores, and must start with a letter.
$OntologyName = ($OntologyName -replace '[^A-Za-z0-9_]+', '_').Trim('_')
if ($OntologyName -notmatch '^[A-Za-z]') { $OntologyName = "Ontology_$OntologyName" }
if ($OntologyName.Length -gt 89) { $OntologyName = $OntologyName.Substring(0, 89) }
$state = Get-DemoState
if (-not $WorkspaceId -and $state.Contains('workspaceId')) { $WorkspaceId = $state.workspaceId }
if (-not $LakehouseId -and $state.Contains('lakehouseId')) { $LakehouseId = $state.lakehouseId }

$sqlServer = if ($state.Contains('sqlEndpointServer')) { $state.sqlEndpointServer } else { $null }
$sqlId = if ($state.Contains('sqlEndpointId')) { $state.sqlEndpointId } else { $null }
$token = $null

if (-not $DryRun) {
    if (-not $WorkspaceId -or -not $LakehouseId) { throw 'Need -WorkspaceId and -LakehouseId (or run deploy-fabric.ps1 first).' }
    $token = Get-FabricToken
    if (-not $sqlServer -or -not $sqlId -or ($state.Contains('lakehouseId') -and $state.lakehouseId -ne $LakehouseId)) {
        $lh = Invoke-FabricApi -Path "/workspaces/$WorkspaceId/lakehouses/$LakehouseId" -Token $token
        $sqlServer = Get-Prop $lh 'properties.sqlEndpointProperties.connectionString'
        $sqlId = Get-Prop $lh 'properties.sqlEndpointProperties.id'
    }
    if (-not $sqlServer -or -not $sqlId) { throw 'Lakehouse SQL analytics endpoint is not provisioned yet. Wait a minute and retry.' }
}

Write-Step "Packing ontology definition from $SourceFolder"
$parts = @()
foreach ($file in Get-ChildItem -Path $SourceFolder -Recurse -File -Force | Sort-Object FullName) {
    $relative = $file.FullName.Substring($SourceFolder.Length + 1).Replace('\', '/')
    $text = [IO.File]::ReadAllText($file.FullName, [Text.Encoding]::UTF8)
    if ($relative -eq 'expressions.tmdl') {
        $text = $text.Replace('{{SQL_ENDPOINT_SERVER}}', $(if ($sqlServer) { $sqlServer } else { '{{SQL_ENDPOINT_SERVER}}' }))
        $text = $text.Replace('{{SQL_ENDPOINT_ID}}', $(if ($sqlId) { $sqlId } else { '{{SQL_ENDPOINT_ID}}' }))
    }
    if ($relative -eq '.platform') {
        $platform = ConvertTo-OrderedData ($text | ConvertFrom-Json)
        $platform.metadata.displayName = $OntologyName
        $text = ConvertTo-PrettyJson $platform
    }
    $parts += [ordered]@{
        path        = $relative
        payload     = [Convert]::ToBase64String((New-Object System.Text.UTF8Encoding($false)).GetBytes($text))
        payloadType = 'InlineBase64'
    }
    Write-Info ("{0,-34} {1,6} bytes" -f $relative, $text.Length)
}
foreach ($required in '.platform', 'database.tmdl') {
    if (-not ($parts | Where-Object { $_.path -eq $required })) { throw "Missing required part '$required' in $SourceFolder." }
}
$definition = [ordered]@{ parts = $parts }

if ($DryRun) {
    Write-JsonFile $PayloadFile ([ordered]@{ displayName = $OntologyName; type = 'Ontology'; definition = $definition })
    Write-Ok "Dry run: $($parts.Count) parts written to $PayloadFile (no Fabric calls)."
    return
}

Write-Step "Deploying '$OntologyName' to workspace $WorkspaceId"
$existing = Find-FabricItem $WorkspaceId 'Ontology' $OntologyName $token
if ($existing) {
    $null = Invoke-FabricApi -Method POST -Path "/workspaces/$WorkspaceId/items/$($existing.id)/updateDefinition?updateMetadata=True" -Token $token -Body ([ordered]@{ definition = $definition })
    $ontologyId = $existing.id
    Write-Ok "Updated definition of ontology $ontologyId"
} else {
    $created = Invoke-FabricApi -Method POST -Path "/workspaces/$WorkspaceId/items" -Token $token -Body ([ordered]@{
            displayName = $OntologyName
            type        = 'Ontology'
            description = 'Contoso Retail business ontology (synthetic data) deployed from ontology/ TMDL.'
            definition  = $definition
        })
    $ontologyId = if (Get-Prop $created 'id') { $created.id } else { (Find-FabricItem $WorkspaceId 'Ontology' $OntologyName $token).id }
    Write-Ok "Created ontology $ontologyId"
}

$state.workspaceId = $WorkspaceId
$state.lakehouseId = $LakehouseId
$state.ontologyId = $ontologyId
$state.ontologyName = $OntologyName
Save-DemoState $state

Write-Step 'Done'
Write-Info "Open:          https://app.fabric.microsoft.com/groups/$WorkspaceId/ontologies/$ontologyId"
Write-Info "Ontology MCP:  https://api.fabric.microsoft.com/v1/mcp/dataPlane/workspaces/$WorkspaceId/items/$ontologyId/ontologyEndpoint"
Write-Info 'Add it to your client:  .\scripts\setup.ps1 -Client <client> -IncludeOntology'
