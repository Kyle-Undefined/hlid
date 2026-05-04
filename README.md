# Hlið

*Short for Hliðskjálf, Óðinn's high seat from which he could see all nine realms.*

`Hlid` is a local command center for your Obsidian vault, powered by the Claude Code Agent SDK. So you don't need a terminal inside Obsidian, or a `/remote-control` session that breaks on approval prompts while mobile. Chat with Claude, watch tool use, manage your vault and Claude settings from one place.

Windows-first, distributed as a single compiled `hlid.exe`. Accessible anywhere via Tailscale. Built for personal use but configurable enough to adapt to other vault setups.

PWA for app-like experience, both desktop and mobile friendly design. Privacy setting for showcases. Uses what's on your machine. Dark and light themes (dark theme based on other project [nerdsnipe.wtf](https://nerdsnipe.wtf)).

Session and attachment management, customize agents as personality or working directory, allows vault specific skills and MCP setups.

TLDR: Runs on your Windows machine, works with PARA or LLM Wiki style vaults, allows TailScale setup via Claude, works with WSL, and allows you to control everything from one spot, from anywhere.

Mobile UI:

![alt text](mobile-ui.png)

Desktop UI:

![Desktop UI](desktop-ui.png)

## Skill index.md

Here is how I setup my skills so the home page is split into columns for groupings.

```txt
# Skills Index

Quick reference for all vault skills. Load the full `SKILL.md` only on match.

## Reviews & Routines

| Skill | Triggers on |
|---|---|
| `skill-name` | "use skill x", "process x", "etc" |
```

## Stack

- `Bun` server, single-binary compile (`bun build --compile`) with the Vite client embedded into the executable
- `TanStack Start` + `TanStack Router` for the web UI
- Claude Code Agent SDK for the persistent vault session
- WebSockets for real-time streaming and tool use visibility
- `SQLite` for session and settings storage
- Optional TLS sidecar (`scripts/tls-proxy.ts`) for HTTPS in dev and on the tailnet
- Tailscale for remote access (no cloud needed)

## Setup

```bash
bun install
bun run dev:all
```

`dev:all` runs three processes concurrently: the Vite UI, the Bun API/WS server, and the TLS proxy (only if cert/key paths are configured in `hlid.config.toml`).

First launch opens a setup wizard. Pick your vault folder; `Hlid` scans it and pre-fills the detected structure; you confirm. Config writes to `hlid.config.toml`.

## Config

Everything lives in `hlid.config.toml` at the project root. Vault paths (inbox, projects, areas, resources, archive, skills, memory, outputs), Claude model + reasoning effort + permission mode, server port, TLS cert/key paths, local network access toggle, external agent toggle, attachment limits, and registered sub-agents.

See `hlid.config.example.toml` for a minimal starting point. Most settings hot-reload while the server is running. Vault path and MCP changes need a session reload, which you can trigger from `FORGE`.

## Pages

Routes are named after Norse concepts; the sidebar uses the labels in caps.

- **WATCH** (`/`): inbox count, active projects, session status, session cost
- **VAULT** (`/vault`): projects by status with inline status change, file browser
- **RELICS** (`/relics`): attachment management
- **RAVEN** (`/raven`): full back-and-forth with Claude, tool use shown inline and collapsible, tap-to-approve permission cards, attachments
- **EINHERJAR** (`/einherjar`): registered sub-agents (personalities or working directory)
- **LEDGER** (`/ledger`): token usage, cache hit rate, cost per query, context window usage
- **FORGE** (`/forge`): vault config, Claude model and permissions, server config, autostart, restart/shutdown, Tailscale status, session reload

## Build & Release

```bash
bun run build
```

Runs `vite build`, then `scripts/embed-client.ts` walks `dist/client` and emits `src/server/embedded-client.ts`; every static asset becomes a `with { type: "file" }` import so `bun build --compile` bakes the bytes into the executable. No sibling `dist/` folder needed at runtime.

The release workflow (`.github/workflows/release.yml`) tags trigger a Windows build that produces `hlid-vX.Y.Z-windows-x64.exe` plus a `sha256` checksum file, attached to a GitHub Release.

## Windows Autostart

Managed from `FORGE`. Install/uninstall writes `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\Hlid` pointing at the running `hlid.exe` with `--background`. Only available when running from a compiled `.exe`. Restart and shutdown live in the same panel; restart re-spawns detached via `cmd /c start` to escape the parent's job object.

## Auth

Tailscale is the auth layer. `Hlid` binds to `0.0.0.0` so it's reachable from any device on your tailnet. The TLS proxy and HTTP server gate requests through `lib/allowedOrigin.ts`: by default only localhost and Tailscale CGNAT (`100.64.0.0/10`) are allowed; flip `server.local_network_access = true` in config to also accept RFC1918 ranges.

A per-install token (`lib/token.ts`) is embedded in the page head and sent on WebSocket connect to gate the streaming session. `FORGE` shows live Tailscale state (binary detected, backend state, MagicDNS name, IPs) via the local `tailscale` CLI.
