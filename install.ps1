# Paperclip Helper installer for Windows (PowerShell 5.1 or 7).
#
#   irm https://raw.githubusercontent.com/DevEnterpriseSoftware/paperclip-helper/main/install.ps1 | iex
#
# Re-run it any time to change settings: it offers your current values and keeps
# your board key and webhook secret. Unattended installs take every answer from
# environment variables (see the README), e.g.:
#
#   $env:PCH_NONINTERACTIVE = '1'; $env:GITHUB_OWNER_LOGIN = 'me'; irm .../install.ps1 | iex
#
# It needs no administrator rights. It writes only to the install directory and,
# for the `pch` command, your PowerShell profile.

function Install-PaperclipHelper {
  # Native commands report problems through exit codes; Windows PowerShell 5.1 would
  # otherwise turn their redirected stderr into terminating errors.
  $ErrorActionPreference = 'Continue'
  $DefaultImage = 'ghcr.io/deventerprisesoftware/paperclip-helper:1'
  $RepoUrl = 'https://github.com/DevEnterpriseSoftware/paperclip-helper'
  $NonInteractive = [bool]$env:PCH_NONINTERACTIVE
  $OnWindows = ($PSVersionTable.PSEdition -ne 'Core') -or $IsWindows

  # ---------------------------------------------------------------- output and input

  function Say([string]$Text) { Write-Host $Text }
  function Note([string]$Text) { Write-Host "  $Text" }
  function Warn([string]$Text) { Write-Host "! $Text" -ForegroundColor Yellow }
  function Die([string]$Text) { Write-Host "x $Text" -ForegroundColor Red; $script:PchDied = $true; throw $Text }
  function Step([string]$Text) { Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }

  function Ask([string]$Question, [string]$Default) {
    if ($NonInteractive) { return $Default }
    $prompt = if ($Default) { "$Question [$Default]" } else { $Question }
    $answer = Read-Host $prompt
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
    return $answer.Trim()
  }

  function Mask([string]$Value) {
    if ($Value.Length -gt 8) { return "$($Value.Substring(0, 4))...($($Value.Length) chars)" }
    return '***'
  }

  # Like Ask, but typing is hidden and the current value is shown masked. Enter keeps it.
  function Ask-Secret([string]$Question, [string]$Current) {
    if ($NonInteractive) { return $Current }
    $prompt = if ($Current) { "$Question [keep $(Mask $Current)]" } else { $Question }
    $secure = Read-Host $prompt -AsSecureString
    $answer = [System.Net.NetworkCredential]::new('', $secure).Password
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Current }
    return ($answer -replace '\s', '')
  }

  function Confirm([string]$Question, [bool]$Default = $true) {
    if ($NonInteractive) { return $Default }
    $hint = if ($Default) { '[Y/n]' } else { '[y/N]' }
    $answer = Read-Host "$Question $hint"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
    return $answer.Trim().ToLower().StartsWith('y')
  }

  function Truthy([string]$Value) { return $Value -match '^(1|true|yes|on)$' }

  $script:ExistingEnv = @{}
  function Read-ExistingEnv([string]$Path) {
    $script:ExistingEnv = @{}
    if (Test-Path $Path) {
      foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        if ($line -match '^([A-Z_][A-Z0-9_]*)=(.*)$') { $script:ExistingEnv[$Matches[1]] = $Matches[2].Trim('"', "'") }
      }
    }
  }

  # The first non-empty of: environment variable, existing .env, fallback.
  function Pick([string]$Name, [string]$Fallback = '') {
    $value = [Environment]::GetEnvironmentVariable($Name)
    if (-not $value) { $value = $script:ExistingEnv[$Name] }
    if (-not $value) { $value = $Fallback }
    return $value
  }

  function New-Secret {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
  }

  function Write-Utf8File([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text.Replace("`r`n", "`n"), (New-Object System.Text.UTF8Encoding $false))
  }

  # ---------------------------------------------------------------- docker

  function Invoke-Docker {
    $output = & docker @args 2>&1
    return @{ Code = $LASTEXITCODE; Text = (($output | ForEach-Object { "$_" }) -join "`n") }
  }

  function Get-NetArgs([string]$Mode) {
    if ($Mode -eq 'host') { return @('--network', 'host') }
    if ($Mode -eq 'bridge') { return @('--add-host', 'host.docker.internal:host-gateway') }
    if ($Mode -like 'net:*') { return @('--network', $Mode.Substring(4)) }
    return @()
  }

  function Get-DataMount { return @('--mount', "type=bind,source=$(Join-Path $Dir 'data'),target=/data") }

  function Get-UserArgs {
    if ($OnWindows) { return @() }
    return @('--user', "$($script:Settings.PCH_UID):$($script:Settings.PCH_GID)")
  }

  # docker run arguments for a one-off helper command, on the network the service will use.
  function Get-HelperArgs {
    return @('run', '--rm') + (Get-NetArgs $script:NetMode) + (Get-UserArgs) + (Get-DataMount) + @(
      '-e', "PAPERCLIP_API=$($script:Settings.PAPERCLIP_API)",
      '-e', "PAPERCLIP_PUBLIC_URL=$($script:Settings.PAPERCLIP_PUBLIC_URL)",
      '-e', 'LOG_LEVEL=warn', $Image)
  }

  # Runs a helper command and returns its exit code and output.
  function Invoke-Helper {
    $dockerArgs = (Get-HelperArgs) + $args
    return Invoke-Docker @dockerArgs
  }

  function Invoke-Probe([string]$Url, [string]$Mode) {
    $dockerArgs = @('run', '--rm') + (Get-NetArgs $Mode) + @($Image, 'probe', $Url)
    $result = Invoke-Docker @dockerArgs
    $line = ($result.Text -split "`n" | Where-Object { $_ -like '{*' } | Select-Object -Last 1)
    if (-not $line) { return [pscustomobject]@{ ok = $false; code = 'no answer' } }
    return ($line | ConvertFrom-Json)
  }

  # ---------------------------------------------------------------- finding Paperclip

  function Get-Candidates([string]$CurrentMode) {
    $list = New-Object System.Collections.ArrayList
    if ($script:Settings.PAPERCLIP_API) { [void]$list.Add(@($script:Settings.PAPERCLIP_API, $CurrentMode)) }
    $mode = 'host'; $base = '127.0.0.1'
    if ($script:VmEngine) { $mode = 'bridge'; $base = 'host.docker.internal' }
    [void]$list.Add(@("http://${base}:3100", $mode))
    $ps = Invoke-Docker ps --format '{{.Names}} {{.Image}}'
    foreach ($row in ($ps.Text -split "`n")) {
      $parts = $row.Trim() -split ' '
      if ($parts.Count -lt 2) { continue }
      $name = $parts[0]; $img = $parts[1].ToLower()
      if ($img -notlike '*paperclip*' -or $img -like '*paperclip-helper*') { continue }
      $port = (Invoke-Docker port $name '3100/tcp').Text -split "`n" | Select-Object -First 1
      if ($port -match ':(\d+)\s*$') { [void]$list.Add(@("http://${base}:$($Matches[1])", $mode)) }
      # JSON out, filtered here: Windows PowerShell 5.1 strips quotes inside native arguments.
      $service = $null; $nets = @()
      try { $service = ((Invoke-Docker inspect -f '{{json .Config.Labels}}' $name).Text | ConvertFrom-Json).'com.docker.compose.service' } catch {}
      if (-not $service) { $service = $name }
      try { $nets = @(((Invoke-Docker inspect -f '{{json .NetworkSettings.Networks}}' $name).Text | ConvertFrom-Json).PSObject.Properties.Name) } catch {}
      foreach ($net in $nets) {
        if ($net -and $net -ne 'host' -and $net -ne 'none') { [void]$list.Add(@("http://${service}:3100", "net:$net")) }
      }
    }
    return ,$list
  }

  function Find-Paperclip([string]$CurrentMode) {
    $seen = @{}; $guard = $null
    foreach ($candidate in (Get-Candidates $CurrentMode)) {
      $url = $candidate[0]; $mode = $candidate[1]
      if ($seen.ContainsKey("$url|$mode")) { continue }
      $seen["$url|$mode"] = $true
      $result = Invoke-Probe $url $mode
      if ($result.ok) {
        $script:Settings.PAPERCLIP_API = $url; $script:NetMode = $mode
        Note "Found Paperclip at $url ($($result.deploymentMode) mode, $($mode -replace '^net:', 'network '))"
        return $true
      }
      if ($result.code -eq 'hostname_guard') {
        Note "$url answers, but Paperclip refuses the hostname `"$($result.hostname)`"."
        # Prefer suggesting a container's own name over host.docker.internal.
        if (-not $guard -or $mode -like 'net:*') { $guard = $result.hostname }
      } else {
        Note "${url}: $($result.code)"
      }
    }
    if ($guard) {
      Say ''
      Warn "Paperclip only accepts hostnames it has been told about. Allow `"$guard`" where Paperclip runs:"
      Say "    npx paperclipai allowed-hostname $guard        # then restart Paperclip"
      Say '  For a Paperclip container, add it to PAPERCLIP_ALLOWED_HOSTNAMES in its environment and recreate it.'
      Say "  (That variable replaces the config file's list: include hostnames you already allowed.)"
    }
    return $false
  }

  # ---------------------------------------------------------------- files

  $Managed = @('PCH_UID', 'PCH_GID', 'PCH_IMAGE', 'PAPERCLIP_API', 'PAPERCLIP_PUBLIC_URL', 'RELAY', 'GITHUB_WEBHOOK_SECRET',
    'GITHUB_OWNER_LOGIN', 'GITHUB_REPOS', 'ISSUE_PREFIXES', 'RELAY_LINK_PRS', 'RELAY_FIX_CONFLICTS', 'GITHUB_TOKEN', 'RELAY_HOST', 'RELAY_PORT', 'RELAY_PATH',
    'WATCHDOG', 'WATCHDOG_INTERVAL_SEC', 'WATCHDOG_STALL_SEC', 'WATCHDOG_MAX_NUDGES', 'WATCHDOG_HEAL_FAILED_FINALIZE',
    'WATCHDOG_RETRY_DEFERRED', 'WATCHDOG_RELEASE_HOLDS', 'COST_SYNC', 'COST_SYNC_SINCE')

  function Get-EnvText {
    $lines = @(
      "# Paperclip Helper settings, written by install.ps1. Every setting: $RepoUrl/blob/main/.env.example",
      '# Change them by re-running the installer, or edit this file and run: docker compose up -d')
    foreach ($key in $Managed) { $lines += "$key=$($script:Settings[$key])" }
    $extra = @()
    foreach ($key in $script:ExistingEnv.Keys) { if ($Managed -notcontains $key) { $extra += "$key=$($script:ExistingEnv[$key])" } }
    if ($extra.Count) { $lines += ''; $lines += '# Your other settings'; $lines += $extra }
    return ($lines -join "`n") + "`n"
  }

  function Get-ComposeText {
    $ports = ''
    if (Truthy $script:Settings.RELAY) { $ports = "`n    ports: [`"127.0.0.1:`${RELAY_PORT:-3110}:`${RELAY_PORT:-3110}`"]" }
    if ($script:NetMode -eq 'host') { $network = '    network_mode: host' }
    elseif ($script:NetMode -eq 'bridge') { $network = "    extra_hosts: [`"host.docker.internal:host-gateway`"]$ports" }
    else { $network = "    networks: [paperclip]$ports" }
    $text = @"
# Paperclip Helper: $RepoUrl
# Written by install.ps1. Upgrade: docker compose pull; docker compose up -d
services:
  helper:
    image: `${PCH_IMAGE:-$DefaultImage}
    container_name: paperclip-helper
    restart: unless-stopped
    stop_grace_period: 30s
    user: "`${PCH_UID:-1000}:`${PCH_GID:-1000}"
$network
    env_file: .env
    volumes:
      - ./data:/data
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
"@
    if ($script:NetMode -like 'net:*') {
      $text += "`nnetworks:`n  paperclip:`n    external: true`n    name: $($script:NetMode.Substring(4))"
    }
    return $text + "`n"
  }

  function Show-File([string]$Label, [string]$Text) {
    Say "---- $Label"
    foreach ($line in ($Text -split "`n")) {
      if ($line -match '^(GITHUB_WEBHOOK_SECRET|GITHUB_TOKEN)=(.{8,})$') { $line = "$($Matches[1])=$(Mask $Matches[2])" }
      if ($line) { Say "  $line" }
    }
  }

  # pch.ps1 comes from the image. `pch update` runs it on the host; every other command
  # goes to the container. An image older than 1.1 doesn't have it.
  function Write-Wrapper {
    $text = @(& docker run --rm --network none $Image wrapper ps1 2>$null)
    if ($LASTEXITCODE -ne 0 -or $text.Count -eq 0) { return $false }
    # With a BOM, like the profile, for Windows PowerShell 5.1.
    [System.IO.File]::WriteAllText($wrapperPath, (($text -join "`r`n") + "`r`n"), (New-Object System.Text.UTF8Encoding $true))
    return $true
  }

  function Install-Alias([bool]$Wrapper) {
    $line = if ($Wrapper) { "function pch { & `"$wrapperPath`" @args }" }
    else { "function pch { docker compose -f `"$composePath`" run --rm helper @args }" }
    $profiles = @($PROFILE.CurrentUserCurrentHost)
    if ($OnWindows) {
      $docs = [Environment]::GetFolderPath('MyDocuments')
      foreach ($p in @((Join-Path $docs 'WindowsPowerShell\Microsoft.PowerShell_profile.ps1'), (Join-Path $docs 'PowerShell\Microsoft.PowerShell_profile.ps1'))) {
        if ($profiles -notcontains $p -and (Test-Path $p)) { $profiles += $p }
      }
    }
    foreach ($p in $profiles) {
      $dir = Split-Path $p -Parent
      if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
      $content = if (Test-Path $p) { [System.IO.File]::ReadAllText($p) } else { '' }
      if ($content.Contains($line)) { Note "The pch command is already in $p."; continue }
      $kept = ($content -split "`r?`n" | Where-Object { $_ -notmatch '^function pch \{' }) -join "`r`n"
      $kept = $kept.TrimEnd() + "`r`n`r`n# Paperclip Helper`r`n$line`r`n"
      # With a BOM: Windows PowerShell 5.1 reads a BOM-less profile as ANSI, which garbles non-ASCII paths.
      [System.IO.File]::WriteAllText($p, $kept.TrimStart(), (New-Object System.Text.UTF8Encoding $true))
      Note "Added the pch command to $p (open a new PowerShell window to use it)."
    }
    if ($OnWindows) {
      $policy = Get-ExecutionPolicy
      if ($policy -eq 'Restricted' -or $policy -eq 'AllSigned') {
        Warn "PowerShell's execution policy ($policy) stops profiles from loading, so pch won't be defined."
        Note 'Allow local scripts for your account with: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned'
      }
    }
  }

  # ---------------------------------------------------------------- webhook

  function Test-WebhookUrl([string]$Url) {
    Add-Type -AssemblyName System.Net.Http
    $client = New-Object System.Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromSeconds(15)
    try {
      $response = $client.GetAsync($Url).GetAwaiter().GetResult()
      $code = [int]$response.StatusCode
      $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    } catch {
      Warn "$Url didn't answer ($($_.Exception.GetBaseException().Message))."
      return
    } finally { $client.Dispose() }
    if ($code -eq 405 -and $body -like '*POST only*') { Note "$Url reaches the relay."; return }
    if ($body -match 'cloudflareaccess|cf-access|<form|sign in|log in') {
      Warn "$Url shows a login page: an access policy (e.g. Cloudflare Access) is in the way."
      Note 'Add a bypass for exactly this path. GitHub has no identity to log in with; the webhook signature is the lock.'
    } elseif ($code -eq 404 -or $body -match '<html') {
      Warn "$Url reached something other than the relay (HTTP $code)."
      Note "Route this path to the relay (http://localhost:$($script:Settings.RELAY_PORT)) in your tunnel or proxy, above Paperclip's own rule."
    } else {
      Warn "$Url didn't answer as expected (HTTP $code)."
    }
  }

  function New-Webhooks([string]$Url) {
    $s = $script:Settings
    foreach ($repo in ($s.GITHUB_REPOS -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
      $common = @('-F', 'active=true', '-f', 'events[]=pull_request', '-f', 'events[]=pull_request_review', '-f', 'events[]=issue_comment',
        '-f', "config[url]=$Url", '-f', 'config[content_type]=json', '-f', "config[secret]=$($s.GITHUB_WEBHOOK_SECRET)")
      $id = $null
      # ForEach-Object unrolls the array: Windows PowerShell 5.1's ConvertFrom-Json emits it as one object.
      try { $id = ((& gh api "repos/$repo/hooks" 2>$null) -join "`n" | ConvertFrom-Json) | ForEach-Object { $_ } | Where-Object { $_.config.url -eq $Url } | Select-Object -First 1 -ExpandProperty id } catch {}
      if ($id) { $out = & gh api -X PATCH "repos/$repo/hooks/$id" @common 2>&1; $verb = 'updated the existing webhook.' }
      else { $out = & gh api "repos/$repo/hooks" -f name=web @common 2>&1; $verb = 'webhook created (GitHub sends a ping now).' }
      if ($LASTEXITCODE -eq 0) { Note "${repo}: $verb"; continue }
      $text = ($out | ForEach-Object { "$_" }) -join "`n"
      Warn "${repo}: $(($text -split "`n")[-1])"
      if ($text -match 'HTTP 404') {
        Note "gh needs the admin:repo_hook scope, and you need admin rights on ${repo}: run"
        Note '  gh auth refresh -h github.com -s admin:repo_hook'
        Note 'then re-run the installer.'
      }
    }
  }

  function Show-ManualWebhook([string]$Url) {
    $s = $script:Settings
    if (-not $Url) { $Url = "https://<your public host>$($s.RELAY_PATH)" }
    Say '  Add the webhook by hand in each repository: Settings -> Webhooks -> Add webhook'
    Say "    Payload URL:   $Url"
    Say '    Content type:  application/json'
    Say "    Secret:        $($s.GITHUB_WEBHOOK_SECRET)"
    Say '    Events:        Pull requests, Pull request reviews, Issue comments'
  }

  # ---------------------------------------------------------------- main

  Write-Host 'Paperclip Helper installer' -ForegroundColor White
  Say 'Merge-to-approve relay, stalled-work watchdog and subscription cost sync for Paperclip.'

  Step 'Checking Docker'
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Die 'Docker is required: install Docker Desktop (https://docs.docker.com/desktop/) or another Docker engine.' }
  if ((Invoke-Docker compose version).Code -ne 0) { Die 'Docker Compose v2 (`docker compose`) is required.' }
  if ((Invoke-Docker info).Code -ne 0) { Die "Docker isn't answering. Start Docker Desktop (or your engine) and re-run." }
  $endpoint = $env:DOCKER_HOST
  if (-not $endpoint) { $endpoint = (Invoke-Docker context inspect --format '{{.Endpoints.docker.Host}}').Text.Trim() }
  if ($endpoint -match '^(ssh|tcp)://') {
    Warn "Docker here talks to a remote engine ($endpoint). The helper must run on the machine Paperclip runs on,"
    Warn 'and .\data would be a path on that machine. Run the installer there instead.'
    if (-not (Confirm 'Continue anyway?' $false)) { return }
  }
  $engineOs = (Invoke-Docker info --format '{{.OperatingSystem}}').Text.Trim()
  $script:VmEngine = $OnWindows -or $IsMacOS -or ($engineOs -match 'docker desktop|rancher|colima|orbstack|lima|podman')
  $vmNote = if ($script:VmEngine) { ' (runs in a VM: bridge networking)' } else { '' }
  Note "Docker: $((Invoke-Docker version --format '{{.Server.Version}}').Text.Trim()) on $engineOs$vmNote"

  Step 'Install directory'
  $defaultDir = if ($env:PCH_DIR) { $env:PCH_DIR } else { Join-Path $HOME 'paperclip-helper' }
  $Dir = Ask 'Install into' $defaultDir
  New-Item -ItemType Directory -Path (Join-Path $Dir 'data') -Force -ErrorAction Stop | Out-Null
  $Dir = (Resolve-Path $Dir).Path
  $envPath = Join-Path $Dir '.env'
  $composePath = Join-Path $Dir 'compose.yml'
  $wrapperPath = Join-Path $Dir 'pch.ps1'
  Read-ExistingEnv $envPath
  if (Test-Path $envPath) { Note 'Found an existing install: its settings are the defaults.' }
  $script:Settings = @{}
  $s = $script:Settings
  if ($OnWindows) { $s.PCH_UID = '1000'; $s.PCH_GID = '1000' }
  else { $s.PCH_UID = (& id -u).Trim(); $s.PCH_GID = (& id -g).Trim(); if ($s.PCH_UID -eq '0') { $s.PCH_UID = '1000'; $s.PCH_GID = '1000' } }

  $s.PCH_IMAGE = Pick 'PCH_IMAGE'
  $Image = if ($s.PCH_IMAGE) { $s.PCH_IMAGE } else { $DefaultImage }
  Step "Pulling $Image"
  $pull = Invoke-Docker pull $Image
  if ($pull.Code -ne 0) {
    if ((Invoke-Docker image inspect $Image).Code -ne 0) { Die "Couldn't pull ${Image}: $(($pull.Text -split "`n")[-1])" }
    Warn "Couldn't pull $Image; using the copy already on this machine."
  }
  Note "Image $((Invoke-Docker run --rm $Image version).Text.Trim())"

  Step 'Finding Paperclip'
  $s.PAPERCLIP_API = Pick 'PAPERCLIP_API'
  $currentMode = if ($script:VmEngine) { 'bridge' } else { 'host' }
  if (Test-Path $composePath) {
    $compose = [System.IO.File]::ReadAllText($composePath)
    if ($compose -match 'network_mode: host') { $currentMode = 'host' }
    elseif ($compose -match 'external: true' -and $compose -match '(?m)^\s*name:\s*(\S+)\s*$') { $currentMode = "net:$($Matches[1])" }
    else { $currentMode = 'bridge' }
  }
  if ($env:PCH_NETWORK) { $currentMode = $env:PCH_NETWORK }
  $script:NetMode = ''
  while (-not (Find-Paperclip $currentMode)) {
    if ($NonInteractive) { Die "Couldn't reach Paperclip. Set PAPERCLIP_API (and PCH_NETWORK=host|bridge|net:<network>)." }
    Say ''
    $s.PAPERCLIP_API = Ask "Paperclip's URL as the helper container should reach it (Enter to retry)" $s.PAPERCLIP_API
    $currentMode = Ask 'Network: host, bridge, or net:<docker network>' $currentMode
  }
  $defaultPublic = Pick 'PAPERCLIP_PUBLIC_URL'
  if (-not $defaultPublic) { $defaultPublic = $s.PAPERCLIP_API -replace 'host\.docker\.internal', 'localhost' -replace '127\.0\.0\.1', 'localhost' }
  $s.PAPERCLIP_PUBLIC_URL = (Ask 'The address you open Paperclip at in your browser' $defaultPublic).TrimEnd('/')

  Step 'Board API key'
  Say 'The helper acts as you in Paperclip, with a board API key of your own.'
  $tokenPath = Join-Path (Join-Path $Dir 'data') 'paperclip-token'
  if ($env:PCH_TOKEN) { Write-Utf8File $tokenPath "$($env:PCH_TOKEN)`n" }
  $haveKey = $false
  if ((Test-Path $tokenPath) -and (Get-Item $tokenPath).Length -gt 0) {
    $checked = Invoke-Helper check
    if ($checked.Code -eq 0) {
      $checked.Text -split "`n" | ForEach-Object { Note $_ }
      $haveKey = Confirm 'Keep this key?' $true
    }
  }
  if (-not $haveKey) {
    # Not Invoke-Helper: login's approval link must show while it waits.
    $loginArgs = (Get-HelperArgs) + @('login')
    & docker @loginArgs
    if ($LASTEXITCODE -ne 0) { Die 'Login failed. Re-run the installer to try again.' }
    (Invoke-Helper check).Text -split "`n" | ForEach-Object { Note $_ }
  }

  Step 'Relay: merge a PR to approve its issue'
  foreach ($key in @('RELAY', 'GITHUB_OWNER_LOGIN', 'GITHUB_REPOS', 'GITHUB_WEBHOOK_SECRET', 'ISSUE_PREFIXES', 'RELAY_LINK_PRS', 'RELAY_FIX_CONFLICTS', 'GITHUB_TOKEN')) { $s[$key] = Pick $key }
  $s.RELAY_PORT = Pick 'RELAY_PORT' '3110'
  $s.RELAY_PATH = Pick 'RELAY_PATH' '/hooks/github'
  $s.RELAY_HOST = if ($script:NetMode -eq 'host') { '127.0.0.1' } else { '0.0.0.0' }
  $relayDefault = $true
  if ($NonInteractive -and -not $s.GITHUB_OWNER_LOGIN) { $relayDefault = $false }
  if ($s.RELAY -and -not (Truthy $s.RELAY)) { $relayDefault = $false }
  Say "It takes signed GitHub webhooks: merging an agent's PR approves the Paperclip issue waiting on you,"
  Say 'and "Request changes" sends it back to the engineer. It needs a public HTTPS route to one path.'
  if (Confirm 'Set up the relay?' $relayDefault) {
    $s.RELAY = 'true'
    if (-not $s.GITHUB_OWNER_LOGIN -and (Get-Command gh -ErrorAction SilentlyContinue)) {
      $s.GITHUB_OWNER_LOGIN = (& gh api user --jq .login 2>$null)
    }
    $s.GITHUB_OWNER_LOGIN = Ask 'Your GitHub login (only your merges and reviews decide)' $s.GITHUB_OWNER_LOGIN
    $s.GITHUB_REPOS = Ask 'Repositories, comma-separated (owner/repo)' $s.GITHUB_REPOS
    if (-not $s.GITHUB_OWNER_LOGIN -or -not $s.GITHUB_REPOS) { Die 'The relay needs your GitHub login and at least one repository.' }
    $detected = (Invoke-Helper prefixes).Text.Trim()
    if ($detected) { Note "Your companies' issue prefixes: $detected (used when the next answer is empty)." }
    $s.ISSUE_PREFIXES = Ask "Issue prefixes to look for (empty = all of your companies')" $s.ISSUE_PREFIXES
    $linkDefault = -not ($s.RELAY_LINK_PRS -and -not (Truthy $s.RELAY_LINK_PRS))
    $s.RELAY_LINK_PRS = if (Confirm "Post each new PR's URL on its issue, so Paperclip links the PR?" $linkDefault) { 'true' } else { 'false' }
    Say 'Each merge can leave other open PRs conflicting with the base branch. The relay can send those back'
    Say 'to their agents and say so on the PR. For that it needs a GitHub token.'
    if (Confirm 'Send PRs with merge conflicts back to their agents automatically?' (Truthy $s.RELAY_FIX_CONFLICTS)) {
      $s.RELAY_FIX_CONFLICTS = 'true'
      if (-not $s.GITHUB_TOKEN) {
        Note 'Create a fine-grained token at https://github.com/settings/personal-access-tokens/new'
        Note "  Repository access: Only select repositories -> $($s.GITHUB_REPOS)"
        Note '  Repository permissions: Pull requests -> Read and write'
        Note "  (A classic token with the `"repo`" scope works too. Steps: $RepoUrl/blob/main/docs/relay.md#the-github-token)"
      }
      $s.GITHUB_TOKEN = Ask-Secret 'GitHub token' $s.GITHUB_TOKEN
      if (-not $s.GITHUB_TOKEN) {
        Warn "No token given: PRs with merge conflicts won't be sent back. Re-run the installer to add one."
        $s.RELAY_FIX_CONFLICTS = 'false'
      }
    } else {
      $s.RELAY_FIX_CONFLICTS = 'false'
    }
    $s.RELAY_PORT = Ask 'Relay port' $s.RELAY_PORT
    $s.RELAY_PATH = Ask 'Webhook path' $s.RELAY_PATH
    if ($s.GITHUB_WEBHOOK_SECRET -and -not (Confirm 'Keep the existing webhook secret?' $true)) { $s.GITHUB_WEBHOOK_SECRET = '' }
    if (-not $s.GITHUB_WEBHOOK_SECRET) { $s.GITHUB_WEBHOOK_SECRET = New-Secret }
  } else {
    $s.RELAY = 'false'
    $s.RELAY_FIX_CONFLICTS = 'false'
  }

  Step 'Watchdog: wake agents whose work stalled'
  $s.WATCHDOG = Pick 'WATCHDOG' 'true'
  $s.WATCHDOG_INTERVAL_SEC = Pick 'WATCHDOG_INTERVAL_SEC' '60'
  $s.WATCHDOG_STALL_SEC = Pick 'WATCHDOG_STALL_SEC' '180'
  $s.WATCHDOG_MAX_NUDGES = Pick 'WATCHDOG_MAX_NUDGES' '2'
  $s.WATCHDOG_HEAL_FAILED_FINALIZE = Pick 'WATCHDOG_HEAL_FAILED_FINALIZE' 'true'
  $s.WATCHDOG_RETRY_DEFERRED = Pick 'WATCHDOG_RETRY_DEFERRED' 'true'
  $s.WATCHDOG_RELEASE_HOLDS = Pick 'WATCHDOG_RELEASE_HOLDS' 'true'
  Say 'It comments on issues whose hand-off wake Paperclip dropped, or whose blockers finished without'
  Say 'anything picking them up, and repairs blockers stuck on a failed workspace clean-up.'
  if (Confirm 'Turn the watchdog on?' (Truthy $s.WATCHDOG)) {
    $s.WATCHDOG = 'true'
    if (Confirm 'Adjust its timing?' $false) {
      $s.WATCHDOG_INTERVAL_SEC = Ask 'Check every (seconds)' $s.WATCHDOG_INTERVAL_SEC
      $s.WATCHDOG_STALL_SEC = Ask 'Act after an issue has been quiet for (seconds)' $s.WATCHDOG_STALL_SEC
      $s.WATCHDOG_MAX_NUDGES = Ask 'Nudge comments per stalled issue' $s.WATCHDOG_MAX_NUDGES
    }
    $s.WATCHDOG_HEAL_FAILED_FINALIZE = if (Confirm 'Repair blockers stuck on a failed workspace clean-up?' (Truthy $s.WATCHDOG_HEAL_FAILED_FINALIZE)) { 'true' } else { 'false' }
    Say 'A wake deferred behind a stopped run waits forever. Paperclip''s "send queued messages now" retries it.'
    $s.WATCHDOG_RETRY_DEFERRED = if (Confirm 'Press it for such wakes (never interrupts a running run)?' (Truthy $s.WATCHDOG_RETRY_DEFERRED)) { 'true' } else { 'false' }
    Say 'A run that stopped without a record Paperclip can verify leaves its issue held for good.'
    $s.WATCHDOG_RELEASE_HOLDS = if (Confirm 'Release such holds (the run has stopped; the agent checks its branch before continuing)?' (Truthy $s.WATCHDOG_RELEASE_HOLDS)) { 'true' } else { 'false' }
  } else {
    $s.WATCHDOG = 'false'
  }

  Step 'Cost sync: what subscription runs would have cost'
  $s.COST_SYNC = Pick 'COST_SYNC' 'true'
  $s.COST_SYNC_SINCE = Pick 'COST_SYNC_SINCE'
  Say 'Paperclip records $0 for runs on a Claude or ChatGPT subscription. Cost sync posts each run''s'
  Say 'API-equivalent cost (Claude Code''s own figure; Codex estimated from tokens at OpenAI list prices).'
  Say 'Runs billed to an API key are never touched. Posted amounts count toward budgets and can''t be deleted.'
  Say 'What it would post now:'
  (Invoke-Helper costs).Text -split "`n" | ForEach-Object { Note $_ }
  if (Confirm 'Turn cost sync on?' (Truthy $s.COST_SYNC)) {
    $s.COST_SYNC = 'true'
    if (-not $s.COST_SYNC_SINCE -and -not (Test-Path (Join-Path (Join-Path $Dir 'data') 'cost-synced.json'))) {
      # Unattended, nobody saw the preview: only runs from now on, unless COST_SYNC_SINCE says otherwise.
      if (-not (Confirm 'Include runs that already finished (the list above)?' (-not $NonInteractive))) {
        $s.COST_SYNC_SINCE = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ', [Globalization.CultureInfo]::InvariantCulture)
      }
    }
  } else {
    $s.COST_SYNC = 'false'
  }

  Step 'Writing files'
  $envText = Get-EnvText
  $composeText = Get-ComposeText
  Show-File $composePath $composeText
  Show-File $envPath $envText
  if (-not (Confirm 'Write these files and start the helper?' $true)) { Die 'Nothing written.' }
  Write-Utf8File $composePath $composeText
  Write-Utf8File $envPath $envText

  Step 'Starting'
  $up = Invoke-Docker compose -f $composePath up -d --remove-orphans
  if ($up.Code -ne 0) { Say $up.Text; Die 'docker compose up failed.' }
  Start-Sleep -Seconds 6
  (Invoke-Docker compose -f $composePath logs --no-log-prefix --tail 20 helper).Text -split "`n" | ForEach-Object { Note $_ }

  if ((Truthy $s.RELAY) -and (Truthy $s.RELAY_FIX_CONFLICTS)) {
    # Prints nothing with an image older than 1.2.
    (Invoke-Docker compose -f $composePath run --rm helper check).Text -split "`n" | Where-Object { $_ -like 'GitHub:*' } | ForEach-Object { Note $_ }
  }

  if (Truthy $s.RELAY) {
    Step 'Webhook'
    $local = "http://127.0.0.1:$($s.RELAY_PORT)$($s.RELAY_PATH)"
    try {
      Add-Type -AssemblyName System.Net.Http
      $client = New-Object System.Net.Http.HttpClient
      $body = $client.GetAsync($local).GetAwaiter().GetResult().Content.ReadAsStringAsync().GetAwaiter().GetResult()
      $client.Dispose()
      if ($body -like '*POST only*') { Note "The relay answers on this machine at $local." } else { throw 'unexpected answer' }
    } catch { Warn "The relay doesn't answer on $local yet: check ``docker compose logs``." }
    Say "GitHub must reach that path over HTTPS: forward exactly $($s.RELAY_PATH) to http://localhost:$($s.RELAY_PORT)"
    Say "with a tunnel or reverse proxy (see $RepoUrl#networking)."
    $webhookUrl = $env:PCH_WEBHOOK_URL
    if (-not $webhookUrl -and $s.PAPERCLIP_PUBLIC_URL -like 'https://*') { $webhookUrl = "$($s.PAPERCLIP_PUBLIC_URL)$($s.RELAY_PATH)" }
    $webhookUrl = Ask 'Public webhook URL (empty to skip)' $webhookUrl
    if ($webhookUrl) {
      Test-WebhookUrl $webhookUrl
      $ghReady = $false
      if (Get-Command gh -ErrorAction SilentlyContinue) { & gh auth status *> $null; $ghReady = ($LASTEXITCODE -eq 0) }
      if ($ghReady -and (Confirm "Create or update the webhook on $($s.GITHUB_REPOS) with gh?" $true)) {
        New-Webhooks $webhookUrl
        Start-Sleep -Seconds 4
        if ((Invoke-Docker compose -f $composePath logs --no-log-prefix --since 30s helper).Text -match '"event":"ping"') { Note "The relay received GitHub's ping." }
      } else {
        Show-ManualWebhook $webhookUrl
      }
    } else {
      Show-ManualWebhook ''
    }
  }

  Step 'The pch command'
  $hasWrapper = Write-Wrapper
  if (-not $env:PCH_NO_ALIAS) { Install-Alias $hasWrapper }
  # Usable in this window too.
  $pchBody = if ($hasWrapper) { [scriptblock]::Create("& `"$wrapperPath`" @args") }
  else { [scriptblock]::Create("docker compose -f `"$composePath`" run --rm helper @args") }
  Set-Item -Path Function:global:pch -Value $pchBody

  Step 'Done'
  Say 'The helper runs in the background and restarts with Docker. Try:'
  Say '  pch status         what it is doing'
  Say '  pch why ISSUE-1    why nobody is working on an issue'
  Say '  pch help           every command'
  if ($hasWrapper) { Say 'Update:    pch update' }
  else { Say "Update:    cd `"$Dir`"; docker compose pull; docker compose up -d" }
  Say "Settings:  re-run this installer, or edit $envPath and run docker compose up -d"
}

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {}
try {
  Install-PaperclipHelper
} catch {
  if (-not $script:PchDied) { Write-Host "x $($_.Exception.Message)" -ForegroundColor Red; Write-Host $_.ScriptStackTrace }
  if ($env:PCH_NONINTERACTIVE) { exit 1 }
}
