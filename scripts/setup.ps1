<#
.SYNOPSIS
    Configure the demo MCP servers for the AI client (and Copilot license) you already have.

.DESCRIPTION
    Renders client-specific MCP configuration from config/mcp-servers.json so the same
    Fabric / Power BI MCP servers work with whichever agent the customer is licensed for:

      vscode          GitHub Copilot in VS Code (Free, Pro, Pro+, Business, Enterprise)   -> .vscode/mcp.json
      copilot-cli     GitHub Copilot CLI (same licenses)                                  -> ~/.copilot/mcp-config.json (merged, backed up)
      claude-code     Claude Code (Anthropic plan or API key)                             -> .mcp.json
      cursor          Cursor (any plan with agent mode)                                   -> .cursor/mcp.json
      copilot-studio  Microsoft Copilot Studio / Microsoft 365 Copilot agents             -> prints portal steps
      foundry         Azure AI Foundry agents (bring your own model deployment)           -> prints portal/SDK steps
      m365-copilot    Microsoft 365 Copilot via a Copilot Studio agent                    -> prints portal steps

    Existing, non-demo servers in the target file are preserved. Demo-managed keys
    (fabric-core, fabric-local, powerbi-authoring, fabric-iq, fabric-ontology) are replaced.

.EXAMPLE
    .\scripts\setup.ps1
    Interactive menu.

.EXAMPLE
    .\scripts\setup.ps1 -Client vscode

.EXAMPLE
    .\scripts\setup.ps1 -Client copilot-cli -PowerBIAuthoring plugin
    Use when the 'powerbi-authoring' Skills for Fabric plugin is installed (it bundles the local authoring server).

.EXAMPLE
    .\scripts\setup.ps1 -Client vscode -IncludeOntology
    Adds the Ontology MCP endpoint. IDs come from -OntologyWorkspaceId/-OntologyItemId, from
    config/demo.state.json (written by deploy-ontology.ps1), or VS Code prompts for them.

.EXAMPLE
    .\scripts\setup.ps1 -RenderTemplates
    Maintainers: regenerate the committed default configs for every client.
#>
[CmdletBinding()]
param(
    [ValidateSet('vscode', 'copilot-cli', 'claude-code', 'cursor', 'copilot-studio', 'foundry', 'm365-copilot')]
    [string]$Client,

    [ValidateSet('hosted', 'local', 'plugin')]
    [string]$PowerBIAuthoring = 'hosted',

    [switch]$NoFabricLocal,
    [switch]$IncludeOntology,
    [string]$OntologyWorkspaceId,
    [string]$OntologyItemId,
    [string]$OutputPath,
    [switch]$RenderTemplates
)

. "$PSScriptRoot\common.ps1"

$ManagedKeys = @('fabric-core', 'fabric-local', 'powerbi-authoring', 'fabric-iq', 'fabric-ontology')
$OntologyInputs = @(
    [ordered]@{ type = 'promptString'; id = 'ontology-workspace-id'; description = 'Fabric workspace ID that contains the ontology (from the ontology URL /groups/<id>/...)' },
    [ordered]@{ type = 'promptString'; id = 'ontology-item-id'; description = 'Ontology item ID (from the ontology URL .../ontologies/<id>)' }
)

$Clients = [ordered]@{
    'vscode'         = @{ Label = 'GitHub Copilot in VS Code'; License = 'GitHub Copilot Free / Pro / Pro+ / Business / Enterprise'; Root = 'servers'; Target = '.vscode\mcp.json'; Scope = 'repo' }
    'copilot-cli'    = @{ Label = 'GitHub Copilot CLI'; License = 'GitHub Copilot Pro / Pro+ / Business / Enterprise'; Root = 'mcpServers'; Target = '~\.copilot\mcp-config.json'; Scope = 'user' }
    'claude-code'    = @{ Label = 'Claude Code'; License = 'Anthropic Claude plan or API key'; Root = 'mcpServers'; Target = '.mcp.json'; Scope = 'repo' }
    'cursor'         = @{ Label = 'Cursor'; License = 'Cursor plan with agent mode'; Root = 'mcpServers'; Target = '.cursor\mcp.json'; Scope = 'repo' }
    'copilot-studio' = @{ Label = 'Microsoft Copilot Studio'; License = 'Copilot Studio (capacity or pay-as-you-go)'; Doc = 'clients\copilot-studio\README.md' }
    'm365-copilot'   = @{ Label = 'Microsoft 365 Copilot (Teams/Outlook/Copilot app)'; License = 'Microsoft 365 Copilot + Copilot Studio'; Doc = 'clients\m365-copilot\README.md' }
    'foundry'        = @{ Label = 'Azure AI Foundry agent (bring your own model)'; License = 'Azure subscription with a model deployment'; Doc = 'clients\azure-ai-foundry\README.md' }
}

function Resolve-TargetPath([string]$Target) {
    if ($Target.StartsWith('~')) { return Join-Path $HOME $Target.Substring(2) }
    Join-Path $script:RepoRoot $Target
}

function Select-Servers {
    $catalog = Read-JsonFile (Join-Path $script:RepoRoot 'config\mcp-servers.json')
    foreach ($s in $catalog.servers) {
        switch ($s.id) {
            'fabric-local' { if (-not $NoFabricLocal) { $s } }
            'powerbi-authoring' { if ($s.variant -eq $PowerBIAuthoring) { $s } }
            'fabric-ontology' { if ($IncludeOntology) { $s } }
            default { $s }
        }
    }
}

function New-ServerEntry($Server, [string]$ClientId, [switch]$Portable) {
    $e = [ordered]@{}
    if ($Server.transport -eq 'http') {
        $url = $Server.url
        if ($Server.id -eq 'fabric-ontology') {
            if ($script:OntologyIds) {
                $url = $url.Replace('{workspaceId}', $script:OntologyIds.WorkspaceId).Replace('{ontologyId}', $script:OntologyIds.ItemId)
            } else {
                $url = $url.Replace('{workspaceId}', '${input:ontology-workspace-id}').Replace('{ontologyId}', '${input:ontology-item-id}')
            }
        }
        switch ($ClientId) {
            'cursor' { $e.url = $url }
            'copilot-cli' { $e.type = 'http'; $e.url = $url; $e.tools = [object[]]$(if ($Server.Contains('tools')) { @($Server.tools) } else { @('*') }) }
            default { $e.type = 'http'; $e.url = $url }
        }
        return $e
    }
    $command = $Server.command
    $cmdArgs = @($Server.args)
    $isWindowsHost = ($env:OS -eq 'Windows_NT')
    if ($ClientId -eq 'claude-code' -and $isWindowsHost -and -not $Portable) {
        $cmdArgs = @('/c', $command) + $cmdArgs
        $command = 'cmd'
    }
    switch ($ClientId) {
        'cursor' { $e.command = $command; $e.args = $cmdArgs }
        'copilot-cli' { $e.type = 'local'; $e.command = $command; $e.args = $cmdArgs; $e.tools = @('*') }
        default { $e.type = 'stdio'; $e.command = $command; $e.args = $cmdArgs }
    }
    $e
}

function Write-ClientConfig([string]$ClientId, [string]$Path, [switch]$Portable) {
    $meta = $Clients[$ClientId]
    $existing = Read-JsonFile $Path
    $config = if ($existing) { $existing } else { [ordered]@{} }
    $rootKey = $meta.Root
    $servers = [ordered]@{}
    if ($config.Contains($rootKey) -and $config[$rootKey]) {
        foreach ($k in $config[$rootKey].Keys) { if ($ManagedKeys -notcontains $k) { $servers[$k] = $config[$rootKey][$k] } }
    }
    $usesInputs = $false
    foreach ($s in Select-Servers) {
        $servers[$s.id] = New-ServerEntry $s $ClientId -Portable:$Portable
        if ($s.id -eq 'fabric-ontology' -and -not $script:OntologyIds) { $usesInputs = $true }
    }

    $out = [ordered]@{}
    if ($ClientId -eq 'vscode') {
        $inputs = @()
        if ($config.Contains('inputs')) { $inputs = @($config.inputs | Where-Object { $_.id -notlike 'ontology-*' }) }
        if ($usesInputs) { $inputs += $OntologyInputs }
        if ($inputs.Count -gt 0) { $out.inputs = $inputs }
    }
    foreach ($k in $config.Keys) { if ($k -ne $rootKey -and $k -ne 'inputs') { $out[$k] = $config[$k] } }
    $out[$rootKey] = $servers

    if ($existing -and $meta.Scope -eq 'user') {
        $backup = "$Path.bak-$(Get-Date -Format 'yyyyMMddHHmmss')"
        Copy-Item $Path $backup
        Write-Info "Backed up existing config to $backup"
    }
    Write-JsonFile $Path $out
    Write-Ok "$($meta.Label): wrote $($servers.Count) server(s) to $Path"
}

function Copy-SkillsForClaude {
    $src = Join-Path $script:RepoRoot '.github\skills'
    $dst = Join-Path $script:RepoRoot '.claude\skills'
    if (-not (Test-Path $src)) { return }
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force
    Write-Ok "Mirrored demo skills to .claude\skills (git-ignored) for Claude Code"
}

function Show-NextSteps([string]$ClientId) {
    Write-Host ''
    Write-Step 'Next steps'
    switch ($ClientId) {
        'vscode' {
            Write-Info '1. code .   (open this folder in VS Code)'
            Write-Info '2. Open Chat, switch to Agent, pick a deep-reasoning model.'
            Write-Info '3. Open .vscode/mcp.json and select Start on each server; sign in with your Entra ID work account.'
            Write-Info '   Business/Enterprise: an org admin must enable the "MCP servers in Copilot" policy.'
            Write-Info '4. Ask: "Use the fabric-demo-verify skill to check my MCP connections."'
        }
        'copilot-cli' {
            Write-Info '1. Run "copilot" from this folder (skills in .github/skills load automatically).'
            Write-Info '2. Run "/mcp" and authenticate each HTTP server with your Entra ID work account.'
            Write-Info '3. Optional: /plugin marketplace add microsoft/skills-for-fabric'
            Write-Info '            /plugin install fabric-skills@fabric-collection'
            Write-Info '            /plugin install powerbi-authoring@fabric-collection   (then re-run setup with -PowerBIAuthoring plugin)'
            Write-Info '4. Ask: "Use the fabric-demo-verify skill to check my MCP connections."'
        }
        'claude-code' {
            Write-Info '1. Run "claude" from this folder and approve the project MCP servers.'
            Write-Info '2. Run "/mcp" to authenticate the HTTP servers. If OAuth fails, see docs/troubleshooting.md (app registration).'
            Write-Info '3. Ask: "Use the fabric-demo-verify skill to check my MCP connections."'
        }
        'cursor' {
            Write-Info '1. Open this folder in Cursor. Settings > MCP: enable the demo servers and sign in.'
            Write-Info '2. In Agent chat, follow docs/walkthrough.md (Cursor reads AGENTS.md).'
        }
    }
}

# --- main -------------------------------------------------------------------------------

if ($RenderTemplates) {
    Write-Step 'Rendering committed default templates (hosted authoring, Fabric local, no ontology)'
    $IncludeOntology = $false
    $script:OntologyIds = $null
    foreach ($c in 'vscode', 'claude-code', 'cursor') {
        $p = Resolve-TargetPath $Clients[$c].Target
        if (Test-Path $p) { Remove-Item $p }
        Write-ClientConfig $c $p -Portable
    }
    $cli = Join-Path $script:RepoRoot 'clients\copilot-cli\mcp-config.json'
    if (Test-Path $cli) { Remove-Item $cli }
    Write-ClientConfig 'copilot-cli' $cli -Portable
    return
}

if (-not $Client) {
    Write-Step 'Which AI client / Copilot license will you use for the demo?'
    $keys = @($Clients.Keys)
    for ($i = 0; $i -lt $keys.Count; $i++) {
        $m = $Clients[$keys[$i]]
        Write-Host ("  [{0}] {1,-48} {2}" -f ($i + 1), $m.Label, $m.License)
    }
    $choice = Read-Host 'Choose 1-7'
    $n = 0
    if (-not [int]::TryParse($choice, [ref]$n) -or $n -lt 1 -or $n -gt $keys.Count) { throw "Invalid choice '$choice'." }
    $Client = $keys[$n - 1]
    if ($Clients[$Client].Contains('Root')) {
        $pbi = Read-Host 'Power BI authoring server: [1] hosted (recommended)  [2] local (Desktop/PBIP)  [3] none, I use the powerbi-authoring plugin   (Enter = 1)'
        $PowerBIAuthoring = switch ($pbi) { '2' { 'local' } '3' { 'plugin' } default { 'hosted' } }
    }
}

$meta = $Clients[$Client]
if (-not $meta.Contains('Root')) {
    Write-Step "$($meta.Label) is configured in its portal, not with a local file."
    Write-Info "Follow: $(Join-Path $script:RepoRoot $meta.Doc)"
    Write-Info 'Endpoints to register:'
    foreach ($s in (Read-JsonFile (Join-Path $script:RepoRoot 'config\mcp-servers.json')).servers) {
        if ($s.transport -eq 'http') { Write-Info ("  {0,-18} {1}" -f $s.id, $s.url) }
    }
    return
}

$script:OntologyIds = $null
if ($IncludeOntology) {
    if (-not ($OntologyWorkspaceId -and $OntologyItemId)) {
        $state = Get-DemoState
        if ($state.Contains('workspaceId') -and $state.Contains('ontologyId')) {
            $OntologyWorkspaceId = $state.workspaceId
            $OntologyItemId = $state.ontologyId
            Write-Info "Using ontology IDs from config/demo.state.json"
        }
    }
    if ($OntologyWorkspaceId -and $OntologyItemId) {
        $script:OntologyIds = @{ WorkspaceId = $OntologyWorkspaceId; ItemId = $OntologyItemId }
    } elseif ($Client -ne 'vscode') {
        throw 'Ontology endpoint needs -OntologyWorkspaceId and -OntologyItemId (or run deploy-ontology.ps1 first).'
    }
    if ($Client -ne 'copilot-cli') {
        Write-Info "Ontology questions are turned off in this kit for now: in your client's tool list, keep list_ontology_entities and list_ontology_rules and turn off ask_ontology."
    }
}

if ($PowerBIAuthoring -eq 'plugin') { Write-Info 'Skipping powerbi-authoring server (provided by the Skills for Fabric plugin).' }
if ($PowerBIAuthoring -eq 'local') { Write-Info 'Local authoring server selected: requires XMLA endpoint = Read Write on the capacity.' }

$target = if ($OutputPath) { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath) } else { Resolve-TargetPath $meta.Target }
Write-Step "Configuring $($meta.Label)  [$($meta.License)]"
Write-ClientConfig $Client $target
if ($Client -eq 'claude-code') { Copy-SkillsForClaude }
Show-NextSteps $Client
