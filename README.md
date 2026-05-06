# Hlið

*Short for Hliðskjálf, Óðinn's high seat from which he could see all nine realms.*

`Hlid` is a local command center for your Obsidian vault, powered by the Claude Code Agent SDK. So you don't need a terminal inside Obsidian, or a `/remote-control` session that breaks on approval prompts while mobile. Chat with Claude, watch tool use, manage your vault and Claude settings from one place.

Windows-first, distributed as a single compiled `hlid.exe`. Accessible anywhere via Tailscale. Built for personal use but configurable enough to adapt to other vault setups.

PWA for app-like experience, both desktop and mobile friendly design. Pull to refresh on mobile. There's a privacy toggle that blurs sensitive data like paths and filenames, handy for screenshots. Uses what's on your machine. Dark and light themes (dark theme based on other project [nerdsnipe.wtf](https://nerdsnipe.wtf)).

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

Turn recaps (`claude.turn_recaps`) are on by default. They mimic the CLI recap feature by running a summary against Haiku.

## Pages

Routes are named after Norse concepts; the sidebar uses the labels in caps.

- **WATCH** (`/`): inbox count, active projects, session status, last query cost. Also has a 7-day and 30-day cumulative token chart, a recent sessions list, and a skills directory pulled from your vault and global Claude skills.
- **VAULT** (`/vault`): file browser with tree navigation. Projects get grouped by status pulled from their YAML front-matter; it uses your custom `status_vocabulary` from config so it matches whatever labels your vault actually uses.
- **RELICS** (`/relics`): attachment management. Ephemeral attachments are scoped to the session they were uploaded in; vault attachments persist. Search by filename or filter by date range.
- **RAVEN** (`/raven`): full back-and-forth with Claude, tool use shown inline and collapsible, tap-to-approve permission cards, attachments. Drag-drop files onto the chat, load a skill context before sending, switch between sessions. Submit while Claude is running to queue the message; queued entries show in-chat with a cancel option, and the send button switches to `QUEUE →`.
- **EINHERJAR** (`/einherjar`): registered sub-agents. Two modes: `context` loads a `CLAUDE.md` from the agent path as a personality overlay on the main session, `cwd` runs Claude with that folder as its working directory.
- **LEDGER** (`/ledger`): token usage, cache hit rate, cost per query, context window usage. Also tracks Anthropic rate limit windows (5-hour, 7-day, Sonnet weekly) and shows you utilization percentage and a reset countdown, so you're not just guessing when capacity comes back.
- **FORGE** (`/forge`): vault config, Claude model and permissions, server config, autostart, restart/shutdown, Tailscale status, session reload. Also has a live logs viewer, session cleanup by age, and a full MCP management panel (covered below).

## Attachments

Files uploaded in `RAVEN` are either ephemeral (scoped to the current session) or vault attachments (persistent). Default upload limit is 25 MB. Allowed types out of the box: images, PDF, plain text, markdown, CSV, and JSON. Both limits are configurable in `hlid.config.toml` under `[attachments]`.

## Permissions

When Claude wants to run a tool you haven't pre-approved, `RAVEN` shows a permission card inline. Approve or deny, and pick a scope: session only (forgets when you clear), or save to local (persists across sessions). The three permission modes in config control the baseline before any cards appear: `default` asks for everything, `acceptEdits` auto-approves file writes, `bypassPermissions` skips all prompts.

## MCP

Drop a `.mcp.json` in your vault root and `FORGE` picks it up. Each server shows a status indicator (pending, connected, failed). You can enable/disable individual servers, edit their stdio command or HTTP URL, and add new ones without touching the file directly. MCP changes need a session reload to take effect.

## Build & Release

```bash
bun run build
```

Runs `vite build`, then `scripts/embed-client.ts` walks `dist/client` and emits `src/server/embedded-client.ts`; every static asset becomes a `with { type: "file" }` import so `bun build --compile` bakes the bytes into the executable. No sibling `dist/` folder needed at runtime.

The release workflow (`.github/workflows/release.yml`) tags trigger a Windows build that produces `hlid-vX.Y.Z-windows-x64.exe` plus a `sha256` checksum file, attached to a GitHub Release.

## Updates

Automatically checks GitHub Releases for new versions on launch. A manual check option is available in Forge. After downloading an update, the server automatically reloads.

## Windows Autostart

Managed from `FORGE`. Install/uninstall writes `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\Hlid` pointing at the running `hlid.exe` with `--background`. Only available when running from a compiled `.exe`. Restart and shutdown live in the same panel; restart re-spawns detached via `cmd /c start` to escape the parent's job object.

## Auth

Tailscale is the auth layer. `Hlid` binds to `0.0.0.0` so it's reachable from any device on your tailnet. The TLS proxy and HTTP server gate requests through `lib/allowedOrigin.ts`: by default only localhost and Tailscale CGNAT (`100.64.0.0/10`) are allowed; flip `server.local_network_access = true` in config to also accept RFC1918 ranges.

A per-install token (`lib/token.ts`) is embedded in the page head and sent on WebSocket connect to gate the streaming session. `FORGE` shows live Tailscale state (binary detected, backend state, MagicDNS name, IPs) via the local `tailscale` CLI.
