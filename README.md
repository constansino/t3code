# T3 Code

T3 Code is a Codex-first web GUI for coding agents.

This fork focuses on one thing: letting a Windows machine use a Codex-style UI to browse, mirror, and operate Codex sessions from multiple hosts, including the local machine, a LAN MacBook, and remote Linux servers.

It stays compatible with upstream T3 Code concepts, but adds a stronger remote-Codex workflow on top.

## What this fork adds

### Multi-host Codex sources

- Local Codex source
- Remote SSH Codex sources
- Remote WebSocket Codex sources
- Per-source connection settings from the Settings page
- Built-in default sources for the current local machine, LAN Mac, and cloud server
- Manual add/remove/edit workflow for more hosts

### Host-style session browser

- One top-level source/project per host
- Source-specific folder labels derived from the real host/home path
- Collapsible source folders in the sidebar
- Source threads bound to the correct host automatically
- A layout that behaves more like a Codex host/session browser instead of a single local-only list

### Codex history mirroring

- Auto-bootstrap of Codex history for local and remote SSH sources
- Manual history refresh from Settings
- Bulk import of recent sessions
- Manual import by session id
- Per-session mirrored thread ids so history stays stable across refreshes
- Legacy duplicate mirror cleanup
- Stale mirror cleanup when the source no longer exposes a session

### Better parity with `codex resume`

- Reads real local session files from `~/.codex/sessions`
- Uses created-time ordering for mirrored source threads so the sidebar matches `codex resume` more closely
- Filters out transient `codex exec` sessions from the local history view
- Preserves real session titles instead of falling back to short placeholder ids whenever possible

### On-demand content sync

- Mirrored history rows appear quickly from metadata import
- Opening a mirrored source thread triggers a full content sync for that session
- Messages, reasoning items, and activity summaries are imported into the T3 thread model
- Source folder labels are refreshed from the synced session metadata

### Windows + Mac remote workflow

- Included `start-remote-codex.ps1` / `start-remote-codex.cmd` helpers
- Included `stop-remote-codex.ps1` / `stop-remote-codex.cmd` helpers
- SSH tunnel workflow for exposing a Mac-hosted `codex app-server` as a local Windows WebSocket endpoint
- A practical setup for `Windows UI -> Mac Codex backend`

## Upstream T3 capabilities still available

This fork keeps the regular T3 Code app model and still supports the core upstream experience, including:

- Web UI for Codex-backed threads and projects
- Local or remote Codex app-server runtime selection
- Diff panel / chat layout integration
- Project and thread orchestration model
- Custom model / service-tier app settings
- Terminal, git, and worktree-oriented T3 flows already present upstream

## Quick start

### 1) Local-only usage

Requirements:

- Bun
- Node.js
- Codex CLI installed and already authenticated

Run:

```bash
bun install
bun run build --filter=t3
cd apps/server
node dist/index.mjs --host 127.0.0.1 --port 3773 --no-browser
```

Open:

- [http://127.0.0.1:3773/](http://127.0.0.1:3773/)

### 2) Windows UI + Mac Codex backend

If you already prepared the `mac-codex` SSH alias and the remote start/stop scripts on the Mac, use the bundled helpers:

```powershell
.\start-remote-codex.ps1
```

or:

```bat
start-remote-codex.cmd
```

That script:

- starts the remote Mac Codex app-server
- opens the SSH tunnel to Windows
- starts the local T3 web server
- opens [http://127.0.0.1:3773/](http://127.0.0.1:3773/)

Stop everything with:

```powershell
.\stop-remote-codex.ps1
```

## Managing hosts and history

Use **Settings -> Codex Sources** to:

- add a local / remote SSH / remote WS source
- configure `sshHost`, `appServerUrl`, and `remoteCodexHome`
- list Codex history for that source
- import selected history rows
- import recent history in bulk
- bind mirrored projects and threads back to the correct host

## Current limitations

- Full history crawling is currently implemented for **local** and **remote SSH** sources.
- **Remote WebSocket** sources can be used as a live backend, but history crawling is not implemented there yet.
- This is still a fork of a very early-stage project, so you should expect rough edges.

## Remote setup notes

For the detailed remote setup guide, see `REMOTE.md`.

## Upstream

- Upstream project: [pingdotgg/t3code](https://github.com/pingdotgg/t3code)
- Codex CLI / app-server reference: [openai/codex](https://github.com/openai/codex)
