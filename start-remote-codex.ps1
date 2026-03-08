$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSCommandPath
$StateDir = Join-Path $env:LOCALAPPDATA 'T3RemoteCodex'
$TunnelPidFile = Join-Path $StateDir 'ssh-tunnel.pid'
$ServerPidFile = Join-Path $StateDir 't3-server.pid'
$ServerOutLog = Join-Path $StateDir 't3-server.out.log'
$ServerErrLog = Join-Path $StateDir 't3-server.err.log'
$TunnelOutLog = Join-Path $StateDir 'ssh-tunnel.out.log'
$TunnelErrLog = Join-Path $StateDir 'ssh-tunnel.err.log'
$TunnelLocalPort = 14500
$RemoteAppServerPort = 4500
$WebPort = 3773
$RemoteAlias = 'mac-codex'
$RemoteStartCommand = '~/.local/bin/t3-remote-codex-app-server-start.sh'

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

function Get-BunPath {
  $command = Get-Command bun -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $fallback = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
  if (Test-Path $fallback) {
    return $fallback
  }

  throw 'bun.exe not found. Install Bun first.'
}

function Test-TcpPort {
  param(
    [string] $HostName,
    [int] $Port,
    [int] $TimeoutMs = 1500
  )

  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect($HostName, $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
      return $false
    }

    $client.EndConnect($iar)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Wait-TcpPort {
  param(
    [string] $HostName,
    [int] $Port,
    [int] $Attempts = 20,
    [int] $DelayMs = 500
  )

  for ($index = 0; $index -lt $Attempts; $index++) {
    if (Test-TcpPort -HostName $HostName -Port $Port) {
      return $true
    }

    Start-Sleep -Milliseconds $DelayMs
  }

  return $false
}

function Start-RemoteAppServer {
  Write-Host 'Starting remote Codex app-server on Mac...'
  & ssh -o BatchMode=yes $RemoteAlias $RemoteStartCommand
}

function Start-SshTunnel {
  if (Test-TcpPort -HostName '127.0.0.1' -Port $TunnelLocalPort) {
    Write-Host "SSH tunnel already listening on 127.0.0.1:$TunnelLocalPort"
    return
  }

  Write-Host "Opening SSH tunnel 127.0.0.1:$TunnelLocalPort -> Mac 127.0.0.1:$RemoteAppServerPort ..."
  $forwardSpec = "${TunnelLocalPort}:127.0.0.1:${RemoteAppServerPort}"
  $process = Start-Process ssh `
    -ArgumentList @('-o', 'BatchMode=yes', '-N', '-L', $forwardSpec, $RemoteAlias) `
    -WindowStyle Hidden `
    -RedirectStandardError $TunnelErrLog `
    -RedirectStandardOutput $TunnelOutLog `
    -PassThru
  $process.Id | Set-Content -Path $TunnelPidFile -Encoding ascii

  if (-not (Wait-TcpPort -HostName '127.0.0.1' -Port $TunnelLocalPort -Attempts 30 -DelayMs 500)) {
    throw "SSH tunnel did not come up on 127.0.0.1:$TunnelLocalPort. See $TunnelErrLog"
  }
}

function Ensure-BuildArtifacts {
  param([string] $Bun)

  $webDist = Join-Path $RepoRoot 'apps\web\dist\index.html'
  $serverDist = Join-Path $RepoRoot 'apps\server\dist\index.mjs'

  if ((Test-Path $webDist) -and (Test-Path $serverDist)) {
    return
  }

  Write-Host 'Build artifacts missing; building web + server...'
  & $Bun run --cwd (Join-Path $RepoRoot 'apps\web') build
  if ($LASTEXITCODE -ne 0) {
    throw 'apps/web build failed.'
  }

  & $Bun run --cwd (Join-Path $RepoRoot 'apps\server') build
  if ($LASTEXITCODE -ne 0) {
    throw 'apps/server build failed.'
  }
}

function Start-T3Server {
  param([string] $Bun)

  if (Test-TcpPort -HostName '127.0.0.1' -Port $WebPort) {
    Write-Host "T3 Code already listening on http://127.0.0.1:$WebPort"
    return
  }

  $remoteUrl = "ws://127.0.0.1:$TunnelLocalPort"
  Write-Host "Starting local T3 Code server with remote Codex backend $remoteUrl ..."
  $process = Start-Process $Bun `
    -ArgumentList @(
      'run',
      '--cwd',
      (Join-Path $RepoRoot 'apps\server'),
      'start',
      '--',
      '--host',
      '127.0.0.1',
      '--port',
      $WebPort,
      '--no-browser',
      '--codex-app-server-url',
      $remoteUrl
    ) `
    -WorkingDirectory $RepoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $ServerOutLog `
    -RedirectStandardError $ServerErrLog `
    -PassThru
  $process.Id | Set-Content -Path $ServerPidFile -Encoding ascii

  if (-not (Wait-TcpPort -HostName '127.0.0.1' -Port $WebPort -Attempts 40 -DelayMs 500)) {
    throw "T3 Code did not start on http://127.0.0.1:$WebPort. See $ServerErrLog"
  }
}

$bun = Get-BunPath
$env:PATH = "$(Split-Path $bun -Parent);$env:PATH"
Ensure-BuildArtifacts -Bun $bun
Start-RemoteAppServer
Start-SshTunnel
Start-T3Server -Bun $bun

$url = "http://127.0.0.1:$WebPort"
Write-Host "Opening $url"
Start-Process $url | Out-Null
Write-Host ''
Write-Host 'Remote Codex is ready.'
Write-Host "- UI: $url"
Write-Host "- Mac backend: ws://127.0.0.1:$RemoteAppServerPort (via local tunnel ws://127.0.0.1:$TunnelLocalPort)"
Write-Host "- Tunnel stdout: $TunnelOutLog"
Write-Host "- Tunnel stderr: $TunnelErrLog"
Write-Host "- Server stdout: $ServerOutLog"
Write-Host "- Server stderr: $ServerErrLog"
