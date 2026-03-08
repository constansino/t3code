# Remote Access and Multi-Host Codex Setup

This fork supports three practical Codex topologies:

1. **Local only**: T3 Code and Codex CLI run on the same machine.
2. **Remote backend**: T3 Code runs locally, but uses a remote `codex app-server` over WebSocket.
3. **Multi-host mirror**: T3 Code runs locally and mirrors Codex history from multiple hosts, such as a LAN MacBook and cloud servers.

## Supported source types

| Source type | Live backend | History listing | Notes |
| --- | --- | --- | --- |
| Local | Yes | Yes | Reads local `~/.codex/sessions` |
| Remote SSH | Yes | Yes | Best option for mirrored history |
| Remote WebSocket | Yes | Not yet | Use when you only need a live backend |

## CLI -> env option map

| CLI flag | Env var | Notes |
| --- | --- | --- |
| `--mode <web|desktop>` | `T3CODE_MODE` | Runtime mode |
| `--port <number>` | `T3CODE_PORT` | HTTP / WebSocket port |
| `--host <address>` | `T3CODE_HOST` | Bind interface / address |
| `--codex-app-server-url <url>` | `T3CODE_CODEX_APP_SERVER_URL` | Use a remote Codex app-server |
| `--state-dir <path>` | `T3CODE_STATE_DIR` | State directory |
| `--dev-url <url>` | `VITE_DEV_SERVER_URL` | Dev web URL redirect / proxy target |
| `--no-browser` | `T3CODE_NO_BROWSER` | Disable auto-open browser |
| `--auth-token <token>` | `T3CODE_AUTH_TOKEN` | WebSocket auth token |

## Security first

- Always set `--auth-token` before exposing the server outside localhost.
- Treat the auth token like a password.
- Prefer LAN IP / Tailnet IP binding instead of opening everything publicly.
- Prefer SSH tunnels instead of directly exposing the Codex app-server.

## Windows local server + remote Mac Codex quick start

This is the recommended workflow when you want the Windows browser UI but the actual Codex session runtime on the Mac.

### On the Mac

Make sure the Mac can start the official Codex app-server. A typical manual command looks like this:

```bash
codex app-server --listen ws://127.0.0.1:4500
```

In this fork's helper workflow, Windows expects the Mac to expose helper scripts such as:

- `~/.local/bin/t3-remote-codex-app-server-start.sh`
- `~/.local/bin/t3-remote-codex-app-server-stop.sh`

The Windows helper uses the SSH alias `mac-codex` by default.

### On Windows

Run:

```powershell
.\start-remote-codex.ps1
```

This helper will:

- ensure build artifacts exist
- call the Mac start script through SSH
- open a local tunnel `127.0.0.1:14500 -> Mac 127.0.0.1:4500`
- start the local T3 server on `127.0.0.1:3773`
- point T3 at `ws://127.0.0.1:14500`

Stop it with:

```powershell
.\stop-remote-codex.ps1
```

## Manual remote backend setup

If you do not want to use the helper scripts, you can do it manually.

### Start the remote Codex backend

On the remote host:

```bash
codex app-server --listen ws://127.0.0.1:4500
```

### Open the tunnel from Windows

```powershell
ssh -N -L 4500:127.0.0.1:4500 user@remote-host
```

### Start T3 against the tunneled backend

```powershell
$env:T3CODE_CODEX_APP_SERVER_URL = 'ws://127.0.0.1:4500'
cd apps/server
node dist/index.mjs --host 127.0.0.1 --port 3773 --no-browser
```

## Multi-host mirrored history

Use **Settings -> Codex Sources** to add hosts.

For a remote SSH source, configure:

- **Source ID**: a stable host id, such as `192.168.10.99` or `111.91.18.5`
- **Source name**: the display name shown in the UI
- **SSH host**: an SSH alias or `user@host`
- **App server URL**: the local tunneled WebSocket endpoint used by T3
- **Remote Codex home**: usually `~/.codex`

Once added, the source can:

- list remote Codex sessions
- mirror them into a host-specific top-level folder
- bind mirrored threads to the correct host automatically
- sync a session's full content when you open that mirrored thread

## Notes about history parity

This fork tries to match `codex resume` more closely by:

- reading real session files from `~/.codex/sessions`
- preferring created-time ordering for mirrored source threads
- filtering transient `codex exec` sessions from the local history view
- cleaning up duplicate and stale mirrored threads

## Known limitations

- Remote WebSocket sources do not support history crawling yet.
- Remote SSH history assumes the remote machine stores Codex history in a readable `~/.codex` directory.
- This project is still early-stage, so operational polish is improving but not final yet.
