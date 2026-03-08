$ErrorActionPreference = 'Stop'

$StateDir = Join-Path $env:LOCALAPPDATA 'T3RemoteCodex'
$TunnelPidFile = Join-Path $StateDir 'ssh-tunnel.pid'
$ServerPidFile = Join-Path $StateDir 't3-server.pid'
$RemoteAlias = 'mac-codex'
$RemoteStopCommand = '~/.local/bin/t3-remote-codex-app-server-stop.sh'

function Stop-ProcessFromPidFile {
  param([string] $PidFile)

  if (-not (Test-Path $PidFile)) {
    return
  }

  $raw = (Get-Content -Raw $PidFile).Trim()
  if (-not $raw) {
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    return
  }

  $processId = [int] $raw
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($process) {
    Stop-Process -Id $processId -Force
  }

  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

Stop-ProcessFromPidFile -PidFile $ServerPidFile
Stop-ProcessFromPidFile -PidFile $TunnelPidFile

try {
  & ssh -o BatchMode=yes $RemoteAlias $RemoteStopCommand | Out-Host
} catch {
  Write-Warning "Failed to stop remote app-server cleanly: $($_.Exception.Message)"
}

Write-Host 'Remote Codex tunnel and local T3 server stopped.'
