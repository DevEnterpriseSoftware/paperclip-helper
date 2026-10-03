# Paperclip Helper's `pch` command: https://github.com/DevEnterpriseSoftware/paperclip-helper
#
# The installer copies this file next to compose.yml, and `pch update` refreshes it.
# `pch update` runs here, on the host, because the helper's container can't pull its
# own image. Every other command runs in a throwaway container:
# docker compose run --rm helper <command>.

# Native commands report problems through exit codes; Windows PowerShell 5.1 would
# otherwise turn their redirected stderr into terminating errors.
$ErrorActionPreference = 'Continue'
$composeFile = Join-Path $PSScriptRoot 'compose.yml'

if ($args.Count -eq 0 -or $args[0] -ne 'update') {
  docker compose -f $composeFile run --rm helper @args
  exit $LASTEXITCODE
}

function Fail([string]$Text) { Write-Host "x $Text" -ForegroundColor Red; exit 1 }

# The release an image was built from, or its short id for a local build.
function Get-ImageVersion([string]$Image) {
  $json = (docker image inspect -f '{{json .Config.Labels}}' $Image 2>$null) -join "`n"
  if ($LASTEXITCODE -eq 0 -and $json -and $json -ne 'null') {
    $version = (ConvertFrom-Json $json).'org.opencontainers.image.version'
    if ($version) { return $version }
  }
  $id = $Image -replace '^sha256:', ''
  return $id.Substring(0, [Math]::Min(12, $id.Length))
}

# "<state> <image id>" of the service's container when it's running, or restarting
# after a crash (when an update matters most); '' when it's stopped or absent.
function Get-ServiceState {
  foreach ($id in @(docker compose -f $composeFile ps -aq helper 2>$null)) {
    $state = [string]@(docker inspect -f '{{.State.Status}} {{.Image}}' $id 2>$null)[0]
    if ($state -match '^(running|restarting) ') { return $state }
  }
  return ''
}

$image = [string]@(docker compose -f $composeFile config --images 2>$null)[0]
if (-not $image) { Fail "Couldn't read $composeFile." }
$envFile = Join-Path $PSScriptRoot '.env'
if ((Test-Path $envFile) -and (Select-String -Path $envFile -Pattern '^PCH_IMAGE=.+' -Quiet)) {
  Write-Host "PCH_IMAGE in .env pins $image, so updates follow that tag."
}

$before = (Get-ServiceState) -replace '^[a-z]+ ', ''
$beforeVersion = if ($before) { Get-ImageVersion $before } else { '' }

Write-Host "Pulling $image"
docker compose -f $composeFile pull helper
if ($LASTEXITCODE -ne 0) { Fail "Couldn't pull $image." }

# Refresh this script from the new image. PowerShell has already read it, so this run is unaffected.
$text = @(docker run --rm --network none $image wrapper ps1 2>$null)
if ($LASTEXITCODE -eq 0 -and $text.Count -gt 0) {
  [System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'pch.ps1'), (($text -join "`r`n") + "`r`n"), (New-Object System.Text.UTF8Encoding $true))
}

if (-not $before) {
  Write-Host "Pulled Paperclip Helper $(Get-ImageVersion $image). The service isn't running; start it with:"
  Write-Host "  docker compose -f `"$composeFile`" up -d"
  exit 0
}

docker compose -f $composeFile up -d
if ($LASTEXITCODE -ne 0) { Fail 'docker compose up failed.' }
$state = Get-ServiceState
if (($state -replace '^[a-z]+ ', '') -ne $before) {
  Start-Sleep -Seconds 5  # long enough for a new version that crashes on start to show it
  $state = Get-ServiceState
}
$after = $state -replace '^[a-z]+ ', ''
if (-not $after) { Fail "The service didn't start: docker compose -f `"$composeFile`" logs --tail 50" }
if ($before -eq $after) {
  Write-Host "Paperclip Helper $(Get-ImageVersion $after) is up to date."
} else {
  Write-Host "Updated Paperclip Helper: $beforeVersion -> $(Get-ImageVersion $after)."
}
if ($state -like 'restarting *') {
  Write-Host "! The service keeps restarting: docker compose -f `"$composeFile`" logs --tail 50" -ForegroundColor Yellow
}
