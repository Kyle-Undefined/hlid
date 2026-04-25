# Hlið

*Short for Hliðskjálf, Óðinn's high seat from which he could see all nine realms.*

`Hlid` is a local command center for your Obsidian vault, powered by Claude Code Agent SDK. So you don't need a terminal inside of Obsidian, or a `/remote-control` session that approval prompts break while mobile. Chat with Claude, watch tool use, manage your vault and Claude settings from one place.

Windows-first. Accessible anywhere via Tailscale. Built for personal use but configurable enough to adapt to other vault setups.

## Stack

- `Bun` server with startup on boot
- `TanStack Start` + `TanStack Router` for the web UI
- Claude Code Agent SDK for the persistent vault session
- WebSockets for real-time streaming and tool use visibility
- `SQLite` for settings storage
- Tailscale for remote access (no cloud needed)

## Setup

```bash
bun install
bun run dev:all
```

First run kicks off a setup wizard. Pick your vault folder, `Hlid` scans it and pre-fills the structure it detects, you confirm. Config writes to `hlid.config.toml`.

## Config

Everything lives in `hlid.config.toml` at the project root. Vault path, inbox folder, projects folder, skills location, Claude model and permission mode, server host and port. All configurable without touching code.

Most settings hot-reload while the server is running. Vault path and MCP changes need a session reload, which you can trigger from the Settings page.

## Pages

- **Cockpit**: inbox count, active projects, session status, session cost
- **Chat**: full back-and-forth with Claude, tool use shown inline and collapsible, tap-to-approve permission cards
- **Vault**: projects by status with inline status change, skills browser with Run button, memory viewer
- **Stats**: token usage, cache hit rate, cost per query, context window usage
- **Settings**: vault config, Claude model and permissions, server config, session reload

## Windows Startup

```powershell
.\scripts\Register-HlidTask.ps1
```

Registers a Windows Task Scheduler job that starts `Hlid` at login. Runs whether the user is logged on or not, restarts on failure.

## Auth

Tailscale is the auth layer. `Hlid` binds to `0.0.0.0` so it's reachable from any device on your Tailscale network.
