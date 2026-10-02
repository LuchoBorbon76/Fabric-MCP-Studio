# Shared helpers for the demo scripts. Dot-source it:  . "$PSScriptRoot\common.ps1"
# Compatible with Windows PowerShell 5.1 and PowerShell 7+.

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:FabricApi = 'https://api.fabric.microsoft.com/v1'
$script:OneLakeDfs = 'https://onelake.dfs.fabric.microsoft.com'
$script:StateFile = Join-Path $script:RepoRoot 'config\demo.state.json'

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "    [ok] $Message" -ForegroundColor Green }
function Write-Warn2([string]$Message) { Write-Host "    [!]  $Message" -ForegroundColor Yellow }
function Write-Info([string]$Message) { Write-Host "    $Message" }

#region JSON helpers (deterministic 2-space output on 5.1 and 7)

function ConvertTo-OrderedData {
    param($InputObject)
    if ($null -eq $InputObject) { return $null }
    if ($InputObject -is [System.Management.Automation.PSCustomObject]) {
        $o = [ordered]@{}
        foreach ($p in $InputObject.PSObject.Properties) { $o[$p.Name] = ConvertTo-OrderedData $p.Value }
        return $o
    }
    if ($InputObject -is [System.Collections.IDictionary]) {
        $o = [ordered]@{}
        foreach ($k in $InputObject.Keys) { $o[[string]$k] = ConvertTo-OrderedData $InputObject[$k] }
        return $o
    }
    if (($InputObject -is [System.Collections.IEnumerable]) -and -not ($InputObject -is [string])) {
        return , @($InputObject | ForEach-Object { ConvertTo-OrderedData $_ })
    }
    return $InputObject
}

function ConvertTo-JsonString([string]$Value) {
    if ($Value -notmatch '[\x00-\x1f"\\]') { return '"' + $Value + '"' }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    foreach ($ch in $Value.ToCharArray()) {
        switch ($ch) {
            '"' { [void]$sb.Append('\"') }
            '\' { [void]$sb.Append('\\') }
            "`n" { [void]$sb.Append('\n') }
            "`r" { [void]$sb.Append('\r') }
            "`t" { [void]$sb.Append('\t') }
            default {
                if ([int]$ch -lt 32) { [void]$sb.AppendFormat('\u{0:x4}', [int]$ch) } else { [void]$sb.Append($ch) }
            }
        }
    }
    [void]$sb.Append('"')
    $sb.ToString()
}

function ConvertTo-PrettyJson {
    param($InputObject, [int]$Level = 0, [switch]$Compress)
    $pad = if ($Compress) { '' } else { '  ' * ($Level + 1) }
    $end = if ($Compress) { '' } else { '  ' * $Level }
    $nl = if ($Compress) { '' } else { "`n" }
    $sep = if ($Compress) { ':' } else { ': ' }
    if ($null -eq $InputObject) { return 'null' }
    if ($InputObject -is [bool]) { return $InputObject.ToString().ToLowerInvariant() }
    if ($InputObject -is [string]) { return ConvertTo-JsonString $InputObject }
    if ($InputObject -is [int] -or $InputObject -is [long] -or $InputObject -is [double] -or $InputObject -is [decimal]) {
        return [string]::Format([Globalization.CultureInfo]::InvariantCulture, '{0}', $InputObject)
    }
    if ($InputObject -is [System.Management.Automation.PSCustomObject]) { $InputObject = ConvertTo-OrderedData $InputObject }
    if ($InputObject -is [System.Collections.IDictionary]) {
        if ($InputObject.Count -eq 0) { return '{}' }
        $items = foreach ($k in $InputObject.Keys) {
            $pad + (ConvertTo-JsonString ([string]$k)) + $sep + (ConvertTo-PrettyJson $InputObject[$k] -Level ($Level + 1) -Compress:$Compress)
        }
        return '{' + $nl + ($items -join (',' + $nl)) + $nl + $end + '}'
    }
    if ($InputObject -is [System.Collections.IEnumerable]) {
        $arr = @($InputObject)
        if ($arr.Count -eq 0) { return '[]' }
        $allScalar = -not ($arr | Where-Object { $_ -is [System.Collections.IDictionary] -or $_ -is [System.Management.Automation.PSCustomObject] -or ($_ -is [System.Collections.IEnumerable] -and -not ($_ -is [string])) })
        $items = foreach ($i in $arr) { ConvertTo-PrettyJson $i -Level ($Level + 1) -Compress:$Compress }
        if ($allScalar -and -not $Compress) { return '[' + ($items -join ', ') + ']' }
        return '[' + $nl + (($items | ForEach-Object { $pad + $_ }) -join (',' + $nl)) + $nl + $end + ']'
    }
    return ConvertTo-JsonString ([string]$InputObject)
}

function Read-JsonFile([string]$Path) {
    if (-not (Test-Path $Path)) { return $null }
    $raw = [IO.File]::ReadAllText($Path)
    if ([string]::IsNullOrWhiteSpace($raw)) { return [ordered]@{} }
    ConvertTo-OrderedData ($raw | ConvertFrom-Json)
}

function Write-JsonFile([string]$Path, $Data) {
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [IO.File]::WriteAllText($Path, (ConvertTo-PrettyJson $Data) + "`n", (New-Object System.Text.UTF8Encoding($false)))
}

#endregion

#region Auth

function Assert-AzLogin {
    if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
        throw 'Azure CLI (az) is required. Install from https://aka.ms/installazurecli and run "az login".'
    }
    $null = az account show 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Not signed in to Azure CLI. Run "az login" (add --tenant <id> for a specific tenant).' }
}

function Get-AzToken([string]$Resource) {
    Assert-AzLogin
    $token = az account get-access-token --resource $Resource --query accessToken -o tsv 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $token) { throw "Could not get a token for $Resource. Run 'az login' again." }
    $token.Trim()
}

function Get-FabricToken { Get-AzToken 'https://api.fabric.microsoft.com' }
function Get-OneLakeToken { Get-AzToken 'https://storage.azure.com' }

#endregion

#region HTTP

function Get-HttpErrorDetail($ErrorRecord) {
    $response = $null
    if ($ErrorRecord.Exception.PSObject.Properties['Response']) { $response = $ErrorRecord.Exception.Response }
    $status = $null
    if ($response) { try { $status = [int]$response.StatusCode } catch { $status = $null } }
    $body = $null
    if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) { $body = $ErrorRecord.ErrorDetails.Message }
    elseif ($response -and $response.PSObject.Methods['GetResponseStream']) {
        try { $body = (New-Object IO.StreamReader($response.GetResponseStream())).ReadToEnd() } catch { $body = $null }
    }
    if (-not $body) { $body = $ErrorRecord.Exception.Message }
    $retry = $null
    if ($response) {
        try { $retry = @($response.Headers['Retry-After'])[0] } catch { $retry = $null }
        if (-not $retry) { try { $retry = $response.Headers.RetryAfter.Delta.TotalSeconds } catch { $retry = $null } }
    }
    [pscustomobject]@{ Status = $status; Body = $body; RetryAfter = $retry }
}

function Get-HeaderValue($Response, [string]$Name) {
    foreach ($key in @($Response.Headers.Keys)) {
        if ($key -eq $Name) { return [string](@($Response.Headers[$key])[0]) }
    }
    $null
}

function Invoke-WithRetry {
    param([hashtable]$Params, [int]$MaxAttempts = 6)
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try { return Invoke-WebRequest @Params -UseBasicParsing }
        catch {
            $d = Get-HttpErrorDetail $_
            if (($d.Status -eq 429 -or $d.Status -ge 500) -and $attempt -lt $MaxAttempts) {
                $wait = if ($d.RetryAfter) { [int][double]$d.RetryAfter } else { [Math]::Min(60, 5 * $attempt) }
                Write-Info "HTTP $($d.Status) - retrying in $wait s (attempt $attempt/$MaxAttempts)"
                Start-Sleep -Seconds $wait
                continue
            }
            throw "$($Params.Method) $($Params.Uri) failed (HTTP $($d.Status)): $($d.Body)"
        }
    }
}

function Wait-FabricOperation {
    param($Response, [string]$Token, [int]$TimeoutSeconds = 900)
    $location = Get-HeaderValue $Response 'Location'
    $opId = Get-HeaderValue $Response 'x-ms-operation-id'
    if (-not $location -and $opId) { $location = "$script:FabricApi/operations/$opId" }
    if (-not $location) { return $null }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $delay = Get-HeaderValue $Response 'Retry-After'
    $delay = if ($delay) { [int]$delay } else { 3 }
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds $delay
        $poll = Invoke-WithRetry @{ Method = 'GET'; Uri = $location; Headers = @{ Authorization = "Bearer $Token" } }
        $state = $poll.Content | ConvertFrom-Json
        $status = if ($state.PSObject.Properties['status']) { $state.status } else { 'Succeeded' }
        switch ($status) {
            { $_ -in 'Succeeded', 'Completed' } {
                if ($location -match '/operations/[^/]+$') {
                    try {
                        $r = Invoke-WebRequest -UseBasicParsing -Method GET -Uri "$location/result" -Headers @{ Authorization = "Bearer $Token" }
                        if ($r.Content) { return $r.Content | ConvertFrom-Json }
                    } catch { }
                }
                return $state
            }
            { $_ -in 'Failed', 'Cancelled' } { throw "Operation failed: $($poll.Content)" }
            default { $delay = [Math]::Min(15, $delay + 2) }
        }
    }
    throw "Timed out after $TimeoutSeconds s waiting for $location"
}

function Invoke-FabricApi {
    param(
        [ValidateSet('GET', 'POST', 'PATCH', 'PUT', 'DELETE')][string]$Method = 'GET',
        [Parameter(Mandatory)][string]$Path,
        $Body,
        [Parameter(Mandatory)][string]$Token
    )
    $uri = if ($Path -match '^https://') { $Path } else { "$script:FabricApi$Path" }
    $params = @{ Method = $Method; Uri = $uri; Headers = @{ Authorization = "Bearer $Token" } }
    if ($null -ne $Body) {
        $json = if ($Body -is [string]) { $Body } else { ConvertTo-PrettyJson $Body -Compress }
        $params.Body = [Text.Encoding]::UTF8.GetBytes($json)
        $params.ContentType = 'application/json; charset=utf-8'
    }
    $resp = Invoke-WithRetry $params
    if ($resp.StatusCode -eq 202) { return Wait-FabricOperation -Response $resp -Token $Token }
    if ($resp.Content) { return $resp.Content | ConvertFrom-Json }
    $null
}

function Get-FabricCollection {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Token)
    $results = @()
    $next = $Path
    while ($next) {
        $page = Invoke-FabricApi -Path $next -Token $Token
        if ($page.PSObject.Properties['value']) { $results += @($page.value) }
        $next = $null
        if ($page.PSObject.Properties['continuationUri'] -and $page.continuationUri) { $next = $page.continuationUri }
    }
    $results
}

#endregion

#region Fabric helpers

function Find-FabricWorkspace([string]$Name, [string]$Token) {
    Get-FabricCollection -Path '/workspaces' -Token $Token | Where-Object { $_.displayName -eq $Name } | Select-Object -First 1
}

function Find-FabricItem([string]$WorkspaceId, [string]$Type, [string]$Name, [string]$Token) {
    Get-FabricCollection -Path "/workspaces/$WorkspaceId/items?type=$Type" -Token $Token |
        Where-Object { $_.displayName -eq $Name } | Select-Object -First 1
}

function Send-OneLakeFile {
    param([string]$WorkspaceId, [string]$ItemId, [string]$LocalPath, [string]$RemotePath, [string]$Token)
    $base = "$script:OneLakeDfs/$WorkspaceId/$ItemId/$RemotePath"
    $headers = @{ Authorization = "Bearer $Token"; 'x-ms-version' = '2023-11-03' }
    $bytes = [IO.File]::ReadAllBytes($LocalPath)
    $null = Invoke-WithRetry @{ Method = 'PUT'; Uri = "${base}?resource=file"; Headers = $headers }
    $null = Invoke-WithRetry @{ Method = 'PATCH'; Uri = "${base}?action=append&position=0"; Headers = $headers; Body = $bytes; ContentType = 'application/octet-stream' }
    $null = Invoke-WithRetry @{ Method = 'PATCH'; Uri = "${base}?action=flush&position=$($bytes.Length)"; Headers = $headers }
}

function Get-Prop($Object, [string]$Path) {
    $current = $Object
    foreach ($name in $Path.Split('.')) {
        if ($null -eq $current) { return $null }
        if ($current -is [System.Collections.IDictionary]) {
            if (-not $current.Contains($name)) { return $null }
            $current = $current[$name]
        } else {
            $p = $current.PSObject.Properties[$name]
            if (-not $p) { return $null }
            $current = $p.Value
        }
    }
    $current
}

function Get-DemoState { $s = Read-JsonFile $script:StateFile; if ($null -eq $s) { [ordered]@{} } else { $s } }
function Save-DemoState($State) { Write-JsonFile $script:StateFile $State }

#endregion
