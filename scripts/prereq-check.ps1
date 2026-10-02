<#
.SYNOPSIS
    Check local tools and (optionally) Fabric access before running the demo.

.EXAMPLE
    .\scripts\prereq-check.ps1
.EXAMPLE
    .\scripts\prereq-check.ps1 -CheckFabric
    Also signs in with Azure CLI and lists your Fabric capacities (read-only).
#>
[CmdletBinding()]
param([switch]$CheckFabric)

. "$PSScriptRoot\common.ps1"

$results = New-Object System.Collections.Generic.List[object]
function Add-Result([string]$Check, [string]$Status, [string]$Detail) {
    $results.Add([pscustomobject]@{ Check = $Check; Status = $Status; Detail = $Detail })
}

function Test-Tool([string]$Name, [string]$VersionArg, [string]$Need, [string]$Why) {
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $cmd) { Add-Result $Name $Need "Not found. $Why"; return $null }
    $v = (& $Name $VersionArg 2>$null | Select-Object -First 1)
    Add-Result $Name 'OK' "$v"
    $v
}

Write-Step 'Checking local tools'
Add-Result 'PowerShell' 'OK' $PSVersionTable.PSVersion.ToString()

$node = Test-Tool 'node' '--version' 'MISSING' 'Install Node.js LTS - needed for the local Fabric MCP server (npx).'
if ($node -and ($node -match '^v(\d+)') -and [int]$Matches[1] -lt 20) {
    $last = $results[$results.Count - 1]; $last.Status = 'WARN'; $last.Detail += ' (Node 20+ recommended)'
}
$null = Test-Tool 'npx' '--version' 'MISSING' 'Ships with Node.js.'
$null = Test-Tool 'git' '--version' 'MISSING' 'Install Git.'
$null = Test-Tool 'az' '--version' 'WARN' 'Install Azure CLI - only needed for the scripts/deploy-*.ps1 fallbacks.'
$null = Test-Tool 'code' '--version' 'INFO' 'VS Code CLI not on PATH (fine if you use another client).'
$null = Test-Tool 'copilot' '--version' 'INFO' 'GitHub Copilot CLI not installed (npm install -g @github/copilot).'
$null = Test-Tool 'python' '--version' 'INFO' 'Only needed to regenerate sample data.'

$dataOk = (Test-Path (Join-Path $script:RepoRoot 'data\retail\parquet\sales.parquet'))
Add-Result 'Sample data' ($(if ($dataOk) { 'OK' } else { 'MISSING' })) ($(if ($dataOk) { 'data/retail (CSV + Parquet)' } else { 'Run: python scripts/generate-sample-data.py (pip install pyarrow)' }))

if ($CheckFabric) {
    Write-Step 'Checking Fabric access (read-only)'
    try {
        $token = Get-FabricToken
        $account = az account show --query '{user:user.name, tenant:tenantId}' -o json | ConvertFrom-Json
        Add-Result 'Azure CLI sign-in' 'OK' "$($account.user) (tenant $($account.tenant))"
        $caps = @(Get-FabricCollection -Path '/capacities' -Token $token)
        $active = @($caps | Where-Object { $_.state -eq 'Active' })
        if ($active.Count -gt 0) {
            Add-Result 'Fabric capacities' 'OK' (($active | ForEach-Object { "$($_.displayName) [$($_.sku)]" }) -join '; ')
            if (-not ($active | Where-Object { $_.sku -match '^(F([2-9]|\d{2,})|P\d|FT1)$' })) {
                Add-Result 'Ontology MCP' 'WARN' 'Ontology MCP needs a paid F2+ or P1+ capacity.'
            }
        } else {
            Add-Result 'Fabric capacities' 'MISSING' 'No active capacity you can use. Start a Fabric trial or ask an admin for capacity access.'
        }
        $ws = @(Get-FabricCollection -Path '/workspaces' -Token $token)
        Add-Result 'Fabric workspaces' 'OK' "$($ws.Count) workspace(s) visible"
    } catch {
        Add-Result 'Fabric API' 'FAIL' $_.Exception.Message
    }
}

$results | Format-Table -AutoSize -Wrap
Write-Host 'Tenant settings and Copilot policies cannot be checked from here - see docs/prerequisites.md.' -ForegroundColor DarkGray
if ($results | Where-Object { $_.Status -in 'MISSING', 'FAIL' }) { exit 1 }
