# Hlið

*Short for Hliðskjálf, Óðinn's high seat from which he could see all nine realms.*

Hlið is a local command center for working with an Obsidian vault through AI
agents. Chat with Claude, Codex, or an installed Agent Client Protocol provider,
watch tool use, answer permission prompts, browse the vault, and manage agent
settings from one desktop- and mobile-friendly interface.

It runs on your Windows machine, keeps its data local, and can be reached from
your other devices over Tailscale. Hlið is built for personal use and works with
PARA vaults, LLM wiki vaults, and custom folder vocabularies.

![Hlið Watch overview showing activity, sessions, and vault skills](docs/images/watch-overview.png)

## What Hlið provides

- Persistent agent sessions with live streaming, visible tool calls, approvals,
  attachments, queued follow-ups, inline agent questions, plan review, and
  subagent activity.
- A vault browser, project/status views, skill discovery, attachment management,
  and usage/cost reporting.
- Claude, Codex, and installed ACP providers behind one session interface.
- Local Whisper transcription with no cloud audio upload.
- An optional project shell in Raven and an interactive Claude CLI mode.
- Forge settings for vaults, providers, permissions, MCP servers, ACP agents,
  Umbod tool policy, networking, updates, lifecycle controls, and diagnostics.
- Update checks for Hlið itself plus installed agent CLIs (Claude, Codex) and
  enabled ACP agents, with per-platform update guidance — Hlið never runs
  installers automatically.
- A responsive PWA with dark and light themes, pull-to-refresh, and a privacy
  mode that obscures sensitive paths and filenames.

![Hlið Raven conversation on a mobile display](docs/images/raven-mobile.png)

## Download and install

Hlið is Windows-first and distributed as a single x64 executable.

1. Download the latest `hlid-vX.Y.Z-windows-x64.exe` from
   [GitHub Releases](https://github.com/Kyle-Undefined/hlid/releases/latest).
2. Run the downloaded file. Hlið is currently unsigned, so Windows may show a
   SmartScreen prompt; review it, choose **More info**, then **Run anyway** if
   you trust the release.
3. Hlið copies itself to `%LOCALAPPDATA%\Hlid\hlid.exe`, adds a Start Menu
   shortcut, starts the local service, and opens it in your browser.
4. Create the app password on the Windows machine running Hlið. Use 12–256
   characters; there is no uppercase, number, or symbol composition rule.
5. Select your Obsidian vault in the setup wizard and confirm the detected
   folder structure, provider permissions, and theme.

The default interface is `http://127.0.0.1:3000`. It listens only on the local
machine until you explicitly enable network access. See the
[user guide](docs/user-guide.md) for the complete first-run flow and optional
Tailscale setup.

## Start here

- Use **WATCH** to run a prompt or skill quickly, optionally in the background
  or in the current session, while keeping recent activity and usage in view.
- Open **RAVEN** for the full conversation, plan-review, and terminal workspace.
- Browse notes, projects, memory, and skills in **VAULT**.
- Open **FORGE** to configure providers, permissions, networking, voice, MCP and
  ACP integrations, Umbod policy, updates, and lifecycle controls.
- Follow the [user guide](docs/user-guide.md) for page explanations and common
  workflows.

## Pages

| Page | Purpose |
|---|---|
| **WATCH** (`/`) | Quick prompt/skill runs, usage, MCP state, recent sessions, and vault context. |
| **VAULT** (`/vault`) | Browse configured folders, projects, notes, memory, and skills. |
| **RELICS** (`/relics`) | Search, inspect, and manage session and vault attachments. |
| **RAVEN** (`/raven`) | Full agent chat with plans, approvals, questions, attachments, queues, and a project terminal. |
| **EINHERJAR** (`/einherjar`) | Register and configure additional working directories or personality contexts. |
| **LEDGER** (`/ledger`) | Inspect token usage, costs, cache behavior, context, and provider limits. |
| **FORGE** (`/forge`) | Configure Hlið, integrations, access, updates, and developer tools. |

## Configuration and data

The packaged app stores its executable, configuration, database, downloaded
voice models, and other runtime data under `%LOCALAPPDATA%\Hlid`.
`hlid.config.toml` controls the vault layout, providers, server and TLS ports,
network access, attachments, voice, UI preferences, and registered agents. Most
settings can be managed in **FORGE**. Settings marked as restart-required take
effect only after Hlið restarts. Forge currently marks server, ACP, and Umbod
configuration changes this way. Reload a provider session after changing the
working context it should receive.

`pricing-overrides.toml`, managed from **FORGE → Developer → Pricing**, adds
validated effective-dated model rates and aliases without modifying built-in
pricing code. Existing priced Ledger rows are not rewritten.

See [`hlid.config.example.toml`](hlid.config.example.toml) for a minimal example.

## Remote access and security

Hlið uses a single-owner app password. Passwords are stored as Argon2id hashes,
and successful unlocks create an opaque HttpOnly trusted-device session with a
fixed 30-day lifetime. Initial password creation is restricted to the Hlið
machine, and remote password login is accepted only over HTTPS.

For remote or mobile access, use **FORGE → Access → Network** to enable network
access and follow the guided Tailscale/TLS setup. By default Hlið accepts only
localhost and Tailscale CGNAT peers; RFC1918 LAN peers require the separate
local-network option. HTTP routes, API requests, chat WebSockets, and terminal
WebSockets enforce the same server-side session.

If the password is lost, run this on the Hlið machine and restart the app:

```powershell
hlid.exe auth reset
```

This deletes the credential and all trusted-device sessions without changing
vault data or application configuration.

## Contributor setup

Prerequisites: [Bun](https://bun.sh/) 1.3.14 or compatible, plus a local
Obsidian vault for interactive testing.

```bash
bun install
bun run dev:all
```

`dev:all` runs the Vite UI and Bun API/WebSocket server. The TLS proxy also
starts when certificate paths are configured in `hlid.config.toml`.

Useful validation commands:

```bash
bun run check          # Biome, TypeScript, and changed-code Fallow analysis
bun run test           # Vitest suite
bun run test:db        # Bun-only database/auth tests
bun run validate       # Static checks, merged coverage, and full Fallow analysis
bun run build:win      # Windows executable build
```

The application uses TanStack Start/Router, React, a Bun server, SQLite,
WebSockets, and an `AgentProvider` abstraction. The Vite client and required
runtime assets are embedded into the compiled executable, so a release does not
need a sibling `dist` directory.

Tagged releases validate on Linux, build and smoke-test the executable on
Windows, and publish the executable plus a SHA-256 checksum. See
[the release workflow](.github/workflows/release.yml) for the authoritative
pipeline.

## License

[MIT](LICENSE)
