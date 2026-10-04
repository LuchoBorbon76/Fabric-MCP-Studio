<#
.SYNOPSIS
    Install the "Contoso Retail Analyst" agent into Microsoft 365 Copilot, Teams and Outlook in YOUR tenant.

.DESCRIPTION
    One command, any Microsoft 365 tenant. The script:
      1. Checks prerequisites (Azure CLI, Node.js, Microsoft 365 Agents Toolkit CLI 'atk').
      2. Creates (or reuses) a single-tenant Microsoft Entra app for the agent's OAuth sign-in:
           - Delegated Power BI Service permissions: Item.Read.All, Item.Execute.All, Dataset.Read.All
           - Redirect URI https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect
           - A client secret (stored only in the git-ignored env/.env.<env>.user file)
         Optionally grants tenant-wide admin consent (-GrantAdminConsent, requires an admin).
      3. Stages the agent project to agents/contoso-retail-analyst/.deploy/ and, with -IncludeOntology,
         adds the Ontology MCP plugin (IDs from config/demo.state.json or parameters).
      4. Runs 'atk provision', which registers the OAuth config in the Enterprise token store and
         sideloads the agent for the signed-in Microsoft 365 user.

    Use -Publish to submit it to the tenant app catalog for admin approval (org-wide rollout), and
    -Uninstall to remove it. Nothing in this repo contains tenant-specific values.

.PARAMETER TenantId
    Entra tenant ID. Defaults to the tenant of your current 'az login'.
.PARAMETER ClientId
    Reuse an existing Entra app (skip app creation). Provide the secret via the FABRIC_OAUTH_CLIENT_SECRET
    environment variable or you will be prompted securely.
.PARAMETER Environment
    Agents Toolkit environment name. Default 'dev'. Use different names for separate installs (e.g. 'demo', 'prod').

.EXAMPLE
    .\scripts\install-teams-agent.ps1
.EXAMPLE
    .\scripts\install-teams-agent.ps1 -IncludeOntology -GrantAdminConsent
.EXAMPLE
    .\scripts\install-teams-agent.ps1 -DryRun
    Show what would be created and validate the app package offline.
.EXAMPLE
    .\scripts\install-teams-agent.ps1 -Publish
.EXAMPLE
    .\scripts\install-teams-agent.ps1 -Uninstall -DeleteEntraApp
#>
[CmdletBinding()]
param(
    [string]$TenantId,
    [string]$ClientId,
    [string]$Environment = 'dev',
    [string]$AppDisplayName = 'Contoso Retail Analyst (Fabric MCP demo)',
    [switch]$IncludeOntology,
    [string]$OntologyWorkspaceId,
    [string]$OntologyItemId,
    [switch]$GrantAdminConsent,
    [int]$SecretValidityMonths = 6,
    [string]$PublisherName,
    [string]$ContactEmail,
    [switch]$Publish,
    [switch]$Uninstall,
    [switch]$DeleteEntraApp,
    [switch]$DryRun
)

. "$PSScriptRoot\common.ps1"

$PowerBIServiceAppId = '00000009-0000-0000-c000-000000000000'
$DelegatedScopes = @('Item.Read.All', 'Item.Execute.All', 'Dataset.Read.All')
$TeamsRedirectUri = 'https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect'
$FabricScope = 'https://api.fabric.microsoft.com/.default offline_access'
$AgentSource = Join-Path $script:RepoRoot 'agents\contoso-retail-analyst'
$Deploy = Join-Path $AgentSource '.deploy'

function Read-EnvFile([string]$Path) {
    $map = [ordered]@{}
    if (Test-Path $Path) {
        foreach ($line in [IO.File]::ReadAllLines($Path)) {
            if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { $map[$Matches[1]] = $Matches[2] }
        }
    }
    $map
}

function Set-EnvValues([string]$Path, [hashtable]$Values) {
    $lines = New-Object System.Collections.Generic.List[string]
    if (Test-Path $Path) { $lines.AddRange([string[]][IO.File]::ReadAllLines($Path)) }
    foreach ($key in $Values.Keys) {
        $idx = -1
        for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match "^\s*$key\s*=") { $idx = $i; break } }
        $entry = "$key=$($Values[$key])"
        if ($idx -ge 0) { $lines[$idx] = $entry } else { $lines.Add($entry) }
    }
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [IO.File]::WriteAllLines($Path, $lines, (New-Object System.Text.UTF8Encoding($false)))
}

function Assert-Tool([string]$Name, [string]$Install) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { throw "$Name not found. $Install" }
}

function Invoke-Atk([string[]]$AtkArgs) {
    Write-Info "atk $($AtkArgs -join ' ')"
    & atk @AtkArgs
    if ($LASTEXITCODE -ne 0) { throw "atk $($AtkArgs[0]) failed (exit $LASTEXITCODE). Re-run with -Verbose or add --debug to see details." }
}

function Invoke-Graph([string]$Method, [string]$Url, $Body) {
    $args2 = @('rest', '--method', $Method, '--url', $Url, '--headers', 'Content-Type=application/json', '-o', 'json')
    $tmp = $null
    if ($null -ne $Body) {
        $tmp = [IO.Path]::GetTempFileName()
        [IO.File]::WriteAllText($tmp, (ConvertTo-PrettyJson $Body -Compress), (New-Object System.Text.UTF8Encoding($false)))
        $args2 += @('--body', "@$tmp")
    }
    try {
        $out = & az @args2 2>&1
        if ($LASTEXITCODE -ne 0) { throw "Graph $Method $Url failed: $out" }
        $text = ($out | Out-String).Trim()
        if ($text) { return $text | ConvertFrom-Json }
        $null
    } finally { if ($tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue } }
}

function Get-PowerBIScopeIds {
    $sp = az ad sp show --id $PowerBIServiceAppId --query 'oauth2PermissionScopes[].{id:id,value:value}' -o json 2>$null | ConvertFrom-Json
    if (-not $sp) { throw 'Could not read the Power BI Service principal in this tenant. Make sure Power BI/Fabric is enabled.' }
    foreach ($s in $DelegatedScopes) {
        $match = $sp | Where-Object { $_.value -eq $s }
        if (-not $match) { throw "Delegated scope '$s' not found on Power BI Service." }
        [pscustomobject]@{ value = $s; id = $match.id }
    }
}

function New-AgentEntraApp {
    $scopeIds = @(Get-PowerBIScopeIds)
    $existing = az ad app list --display-name $AppDisplayName --query '[].appId' -o tsv 2>$null
    if ($existing) {
        $appId = @($existing -split "`n")[0].Trim()
        Write-Ok "Reusing Entra app '$AppDisplayName' ($appId)"
    } else {
        $app = Invoke-Graph POST 'https://graph.microsoft.com/v1.0/applications' ([ordered]@{
                displayName            = $AppDisplayName
                signInAudience         = 'AzureADMyOrg'
                notes                  = 'OAuth client for the Contoso Retail Analyst Microsoft 365 Copilot agent (Fabric MCP demo kit). Delegated, read-only Power BI permissions.'
                web                    = [ordered]@{ redirectUris = @($TeamsRedirectUri) }
                requiredResourceAccess = @([ordered]@{
                        resourceAppId  = $PowerBIServiceAppId
                        resourceAccess = @($scopeIds | ForEach-Object { [ordered]@{ id = $_.id; type = 'Scope' } })
                    })
            })
        $appId = $app.appId
        Write-Ok "Created Entra app '$AppDisplayName' ($appId)"
        $null = az ad sp create --id $appId 2>$null
    }

    $obj = Invoke-Graph GET "https://graph.microsoft.com/v1.0/applications(appId='$appId')?`$select=id,web,requiredResourceAccess" $null
    $uris = @($obj.web.redirectUris)
    if ($uris -notcontains $TeamsRedirectUri) {
        $null = Invoke-Graph PATCH "https://graph.microsoft.com/v1.0/applications/$($obj.id)" ([ordered]@{ web = [ordered]@{ redirectUris = @($uris + $TeamsRedirectUri) } })
        Write-Ok 'Added Teams OAuth redirect URI'
    }

    $end = (Get-Date).ToUniversalTime().AddMonths($SecretValidityMonths).ToString('yyyy-MM-ddTHH:mm:ssZ')
    $cred = Invoke-Graph POST "https://graph.microsoft.com/v1.0/applications/$($obj.id)/addPassword" ([ordered]@{
            passwordCredential = [ordered]@{ displayName = "m365-agent-$Environment-$(Get-Date -Format yyyyMMdd)"; endDateTime = $end }
        })
    Write-Ok "Created client secret (expires $($end.Substring(0,10)))"

    if ($GrantAdminConsent) {
        $null = az ad sp show --id $appId 2>$null
        if ($LASTEXITCODE -ne 0) { $null = az ad sp create --id $appId 2>$null }
        $out = az ad app permission admin-consent --id $appId 2>&1
        if ($LASTEXITCODE -eq 0) { Write-Ok 'Granted tenant-wide admin consent' }
        else { Write-Warn2 "Admin consent failed (needs Privileged Role/Cloud Application Administrator): $out" }
    }
    [pscustomobject]@{ ClientId = $appId; Secret = $cred.secretText }
}

function Copy-AgentProject {
    if (Test-Path $Deploy) {
        Get-ChildItem $Deploy -Force | Where-Object { $_.Name -ne 'env' } | Remove-Item -Recurse -Force
    } else { New-Item -ItemType Directory -Path $Deploy | Out-Null }
    foreach ($item in 'm365agents.yml', 'appPackage', 'evals') {
        Copy-Item (Join-Path $AgentSource $item) $Deploy -Recurse -Force
    }
    $envDir = Join-Path $Deploy 'env'
    if (-not (Test-Path $envDir)) { New-Item -ItemType Directory -Path $envDir | Out-Null }
    $committed = Join-Path $AgentSource 'env\.env.dev'
    $target = Join-Path $envDir ".env.$Environment"
    if (-not (Test-Path $target)) {
        $text = [IO.File]::ReadAllText($committed).Replace('TEAMSFX_ENV=dev', "TEAMSFX_ENV=$Environment")
        [IO.File]::WriteAllText($target, $text, (New-Object System.Text.UTF8Encoding($false)))
    }
    Remove-Item (Join-Path $Deploy 'appPackage\build') -Recurse -Force -ErrorAction SilentlyContinue
    # The instructions name the semantic model: use the project's model (the studio names it with the naming standard).
    $state = Get-DemoState
    $model = if ($state.Contains('semanticModelName')) { [string]$state.semanticModelName } else { '' }
    if ($model -and $model -ne 'Retail_SM_Sales_DEMO') {
        $path = Join-Path $Deploy 'appPackage\instruction.txt'
        [IO.File]::WriteAllText($path, [IO.File]::ReadAllText($path).Replace('"Retail_SM_Sales_DEMO"', "`"$model`""), (New-Object System.Text.UTF8Encoding($false)))
        $path = Join-Path $Deploy 'appPackage\manifest.json'
        [IO.File]::WriteAllText($path, [IO.File]::ReadAllText($path).Replace('the Retail_SM_Sales_DEMO Power BI semantic model', "the $model Power BI semantic model"), (New-Object System.Text.UTF8Encoding($false)))
        Write-Ok "Agent instructions use the semantic model '$model'"
    }
}

function Add-OntologyPlugin {
    $yml = Join-Path $Deploy 'm365agents.yml'
    $text = [IO.File]::ReadAllText($yml)
    $block = @"
  # Ontology MCP (Fabric IQ ontology, preview) - added by install-teams-agent.ps1 -IncludeOntology
  - uses: oauth/register
    with:
      name: fabric-ontology-mcp
      appId: `${{TEAMS_APP_ID}}
      applicableToApps: AnyApp
      targetAudience: HomeTenant
      flow: authorizationCode
      identityProvider: Custom
      authorizationUrl: https://login.microsoftonline.com/`${{AAD_TENANT_ID}}/oauth2/v2.0/authorize
      tokenUrl: https://login.microsoftonline.com/`${{AAD_TENANT_ID}}/oauth2/v2.0/token
      refreshUrl: https://login.microsoftonline.com/`${{AAD_TENANT_ID}}/oauth2/v2.0/token
      baseUrl: https://api.fabric.microsoft.com/v1/mcp/dataPlane/workspaces/`${{ONTOLOGY_WORKSPACE_ID}}/items/`${{ONTOLOGY_ITEM_ID}}/ontologyEndpoint
      clientId: `${{FABRIC_OAUTH_CLIENT_ID}}
      clientSecret: `${{SECRET_FABRIC_OAUTH_CLIENT_SECRET}}
      scope: $FabricScope
      isPKCEEnabled: true
    writeToEnvironmentFile:
      configurationId: ONTOLOGY_AUTH_ID

"@
    $anchor = '  - uses: teamsApp/zipAppPackage'
    $i = $text.IndexOf($anchor)
    if ($i -lt 0) { throw 'Could not find the zipAppPackage step in m365agents.yml.' }
    $text = $text.Substring(0, $i) + $block + $text.Substring($i)
    [IO.File]::WriteAllText($yml, $text, (New-Object System.Text.UTF8Encoding($false)))

    $daPath = Join-Path $Deploy 'appPackage\declarativeAgent.json'
    $da = Read-JsonFile $daPath
    $da.actions = @($da.actions) + @([ordered]@{ id = 'retailOntology'; file = 'ontology-plugin.json' })
    Write-JsonFile $daPath $da
    Write-Ok 'Added the Retail Ontology MCP plugin'
}

# --- main --------------------------------------------------------------------------------

Write-Step 'Checking prerequisites'
Assert-Tool 'az' 'Install Azure CLI: https://aka.ms/installazurecli'
Assert-Tool 'node' 'Install Node.js LTS: https://nodejs.org'
if (-not (Get-Command atk -ErrorAction SilentlyContinue)) {
    if ($DryRun) { Write-Warn2 "atk not found - install with: npm install -g @microsoft/m365agentstoolkit-cli" }
    else {
        Write-Info 'Installing Microsoft 365 Agents Toolkit CLI (npm install -g @microsoft/m365agentstoolkit-cli)...'
        npm install -g @microsoft/m365agentstoolkit-cli | Out-Null
        Assert-Tool 'atk' 'npm install -g @microsoft/m365agentstoolkit-cli'
    }
}
Write-Ok 'Azure CLI, Node.js and Agents Toolkit CLI found'

if ($Uninstall) {
    if (-not (Test-Path $Deploy)) { throw "Nothing to uninstall: $Deploy not found." }
    Write-Step "Uninstalling the agent (environment '$Environment')"
    Invoke-Atk @('uninstall', '--mode', 'env', '--env', $Environment, '--folder', $Deploy, '--options', 'm365-app,app-registration', '--interactive', 'false')
    if ($DeleteEntraApp) {
        $envMap = Read-EnvFile (Join-Path $Deploy "env\.env.$Environment")
        if ($envMap.Contains('FABRIC_OAUTH_CLIENT_ID') -and $envMap.FABRIC_OAUTH_CLIENT_ID) {
            az ad app delete --id $envMap.FABRIC_OAUTH_CLIENT_ID
            Write-Ok "Deleted Entra app $($envMap.FABRIC_OAUTH_CLIENT_ID)"
        }
    }
    Write-Info 'OAuth client registrations can be removed in the Teams developer portal (Tools > OAuth client registration).'
    return
}

Assert-AzLogin
if (-not $TenantId) { $TenantId = (az account show --query tenantId -o tsv).Trim() }
$user = (az account show --query user.name -o tsv).Trim()
Write-Ok "Azure CLI signed in as $user (tenant $TenantId)"

$ontologyIds = $null
if ($IncludeOntology) {
    $state = Get-DemoState
    if (-not $OntologyWorkspaceId -and $state.Contains('workspaceId')) { $OntologyWorkspaceId = $state.workspaceId }
    if (-not $OntologyItemId -and $state.Contains('ontologyId')) { $OntologyItemId = $state.ontologyId }
    if (-not ($OntologyWorkspaceId -and $OntologyItemId)) { throw '-IncludeOntology needs -OntologyWorkspaceId and -OntologyItemId (or run deploy-ontology.ps1 first).' }
    $ontologyIds = @{ WorkspaceId = $OntologyWorkspaceId; ItemId = $OntologyItemId }
}

if ($DryRun) {
    Write-Step 'Dry run - nothing will be created in Entra ID or Microsoft 365'
    Write-Info "Entra app       : '$AppDisplayName' (single tenant, $TenantId)"
    Write-Info "  permissions   : Power BI Service delegated $($DelegatedScopes -join ', ')"
    Write-Info "  redirect URI  : $TeamsRedirectUri"
    Write-Info "  admin consent : $(if ($GrantAdminConsent) { 'yes' } else { 'no (users consent on first sign-in, if tenant policy allows)' })"
    Write-Info "OAuth scope     : $FabricScope"
    Write-Info "MCP servers     : Fabric IQ$(if ($ontologyIds) { " + Ontology ($($ontologyIds.WorkspaceId)/$($ontologyIds.ItemId))" })"
    Copy-AgentProject
    if ($ontologyIds) { Add-OntologyPlugin }
    Set-EnvValues (Join-Path $Deploy "env\.env.$Environment") @{
        AAD_TENANT_ID = $TenantId; FABRIC_OAUTH_CLIENT_ID = '00000000-0000-0000-0000-000000000000'
        TEAMS_APP_ID = '00000000-0000-0000-0000-000000000000'; FABRIC_IQ_AUTH_ID = 'dry-run'
        ONTOLOGY_WORKSPACE_ID = $(if ($ontologyIds) { $ontologyIds.WorkspaceId } else { '' }); ONTOLOGY_ITEM_ID = $(if ($ontologyIds) { $ontologyIds.ItemId } else { '' })
        ONTOLOGY_AUTH_ID = $(if ($ontologyIds) { 'dry-run' } else { '' })
    }
    if (Get-Command atk -ErrorAction SilentlyContinue) {
        Push-Location $Deploy
        try { Invoke-Atk @('package', '--env', $Environment, '--interactive', 'false') }
        finally { Pop-Location }
        $zip = Join-Path $Deploy "appPackage\build\appPackage.$Environment.zip"
        Write-Ok "App package built: $zip"
        if (Get-Command python -ErrorAction SilentlyContinue) {
            Write-Info 'Validating against the published manifest schemas (offline; atk validate needs Microsoft 365 sign-in)'
            python (Join-Path $PSScriptRoot 'validate-agent-package.py') $zip
            if ($LASTEXITCODE -ne 0) { throw 'App package failed schema validation.' }
        }
    }
    Remove-Item (Join-Path $Deploy "env\.env.$Environment") -Force
    return
}

Write-Step 'Microsoft Entra app for the agent sign-in'
Copy-AgentProject
$envFile = Join-Path $Deploy "env\.env.$Environment"
$userFile = Join-Path $Deploy "env\.env.$Environment.user"
$envMap = Read-EnvFile $envFile
$secret = $null
if ($ClientId) {
    $secret = $env:FABRIC_OAUTH_CLIENT_SECRET
    if (-not $secret) {
        $sec = Read-Host -AsSecureString "Client secret for app $ClientId"
        $secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    }
} elseif ($envMap.Contains('FABRIC_OAUTH_CLIENT_ID') -and $envMap.FABRIC_OAUTH_CLIENT_ID -and (Read-EnvFile $userFile).Contains('SECRET_FABRIC_OAUTH_CLIENT_SECRET')) {
    $ClientId = $envMap.FABRIC_OAUTH_CLIENT_ID
    Write-Ok "Reusing app $ClientId and secret from a previous install"
} else {
    $app = New-AgentEntraApp
    $ClientId = $app.ClientId
    $secret = $app.Secret
}

$values = @{ AAD_TENANT_ID = $TenantId; FABRIC_OAUTH_CLIENT_ID = $ClientId }
if ($PublisherName) { $values.AGENT_PUBLISHER_NAME = $PublisherName }
if ($ContactEmail) { $values.AGENT_CONTACT_EMAIL = $ContactEmail }
if ($ontologyIds) {
    Add-OntologyPlugin
    $values.ONTOLOGY_WORKSPACE_ID = $ontologyIds.WorkspaceId
    $values.ONTOLOGY_ITEM_ID = $ontologyIds.ItemId
}
Set-EnvValues $envFile $values
if ($secret) { Set-EnvValues $userFile @{ SECRET_FABRIC_OAUTH_CLIENT_SECRET = $secret } }
$secret = $null
Write-Ok "Wrote env/.env.$Environment (IDs) and env/.env.$Environment.user (secret, git-ignored)"

Write-Step 'Signing in to Microsoft 365 (Agents Toolkit)'
$m365 = atk auth list 2>&1 | Out-String
if ($m365 -notmatch 'Microsoft 365[^\r\n]*(signed in|logged in)|is signed in|Logged in as') {
    Write-Info 'A browser window will open - sign in with a Microsoft 365 account that can upload custom apps.'
    Invoke-Atk @('auth', 'login', 'm365')
}

Push-Location $Deploy
try {
    Write-Step "Provisioning the agent (environment '$Environment')"
    Invoke-Atk @('provision', '--env', $Environment, '--interactive', 'false')
    if ($Publish) {
        Write-Step 'Submitting to the tenant app catalog for admin approval'
        Invoke-Atk @('publish', '--env', $Environment, '--interactive', 'false')
    }
} finally { Pop-Location }

$final = Read-EnvFile $envFile
Write-Step 'Done'
Write-Info 'Open https://m365.cloud.microsoft/chat (or Teams > Copilot) and pick "Contoso Retail Analyst" under Agents.'
Write-Info 'First use: select Sign in when the agent asks, and accept the Power BI permissions.'
if ($final.Contains('M365_TITLE_ID') -and $final.M365_TITLE_ID) { Write-Info "Title ID: $($final.M365_TITLE_ID)" }
if (-not $Publish) { Write-Info 'Only you can see it now. Roll out to others with: .\scripts\install-teams-agent.ps1 -Publish' }
if (-not $GrantAdminConsent) { Write-Info ('If users see "Need admin approval", an admin can run: az ad app permission admin-consent --id ' + $ClientId) }
