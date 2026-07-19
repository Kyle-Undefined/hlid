# Hlið

*Short for Hliðskjálf, Óðinn's high seat where he could see all nine realms.*

`Hlið` is a local command center for working with an `Obsidian` vault through
AI agents. It puts `Claude`, `Codex`, and installed `Agent Client Protocol`
providers in one interface, with visible tool use, permission prompts, vault
browsing, and the settings needed to run the whole thing.

It runs on a `Windows` machine, keeps its data local, and works from other
devices over `Tailscale`. The vault can use `PARA`, an LLM wiki layout, or its
own folder vocabulary. `Hlið` does not care as long as the paths are set up.

![Hlið Watch overview showing activity, sessions, and vault skills](docs/images/watch-overview.png)

## What it does

- Keeps agent sessions around with live streaming, visible tool calls,
  approvals, attachments, queued follow-ups, inline questions, plan review,
  and subagent activity. The provider, model, effort, and permission mode stay
  with the chat they belong to.
- Pulls vault skills, Hlid-managed skill imports, and provider-native slash
  commands into `Watch` and `Raven`, including compatible multi-skill runs.
- Browses notes and projects, searches without getting tripped up by accents,
  manages attachments, and tracks usage and cost. It can pause running sessions
  near a provider limit, then pick them back up after the window resets.
- Puts `Claude`, `Codex`, and installed `ACP` providers behind the same session
  interface.
- Can hand a task to a fresh Windows-native `Codex Computer Use` worker, while
  keeping approvals, `Umbod` policy, and usage accounting inside `Hlið`.
- Runs `Whisper` locally for voice input. Audio never gets shipped to a cloud
  transcription service.
- Opens a real project shell in `Raven`, with an optional interactive `Claude
  CLI` mode when the full terminal makes more sense than the structured chat UI.
- Keeps linked vaults and workspaces, provider commands, permissions, scoped
  `MCP` servers, `ACP` agents, `Umbod`, networking, updates, and lifecycle
  controls together without moving source repositories out of `WSL`.
- Checks `Hlið`, `Claude`, `Codex`, and enabled `ACP` agents for updates. It
  shows the right command or in-app flow for the installation, but it does not
  silently run installers.
- Works as a responsive `PWA` with built-in or custom desktop/mobile themes,
  pull-to-refresh, and a privacy mode for paths, filenames, and `Ledger` totals.

![Hlið Raven conversation on a mobile display](docs/images/raven-mobile.png)

## Install it

`Hlið` is Windows-first and ships as one x64 executable.

1. Grab the latest `hlid-vX.Y.Z-windows-x64.exe` from
   [GitHub Releases](https://github.com/Kyle-Undefined/hlid/releases/latest).
2. Run it. The executable is currently unsigned, so `Windows SmartScreen` may
   complain. Check the filename, choose **More info**, then **Run anyway** if
   you trust the release.
3. `Hlið` copies itself to `%LOCALAPPDATA%\Hlid\hlid.exe`, refreshes the Start
   Menu shortcut, starts the local service, and opens the app in a browser.
4. Create the app password on the machine running `Hlið`. It needs 12–256
   characters, with no uppercase, number, or symbol ceremony.
5. Pick the `Obsidian` vault, check the detected folders, choose the default
   provider and permissions, then pick a theme.

The default address is `http://127.0.0.1:3000`. It stays on the local machine
until network access is turned on. The [user guide](docs/user-guide.md) covers
the full first-run flow and the optional `Tailscale` setup.

## Where to start

- **WATCH** is for quick prompts, skills, and slash commands. A run can stay in
  the current session or head into the background while the dashboard keeps an
  eye on it.
- **RAVEN** is the full chat workspace. This is where the per-chat provider
  controls, plans, approvals, attachments, and project terminal live.
- **VAULT** browses notes, projects, memory, and skills.
- **FORGE** is where all the setup lives: providers, permissions, networking,
  voice, `MCP`, `ACP`, `Umbod`, updates, and lifecycle controls.

The [user guide](docs/user-guide.md) gets into the meat and potatoes of each
page and the workflows that connect them.

## Pages

| Page | What it is for |
|---|---|
| **WATCH** (`/`) | Quick prompts, skills, slash commands, usage, `MCP` state, recent sessions, and vault context. |
| **VAULT** (`/vault`) | Notes, projects, memory, skills, and whatever folder vocabulary the vault uses. |
| **RELICS** (`/relics`) | Searching, filtering, sorting, previewing, and cleaning up attachments. |
| **RAVEN** (`/raven`) | Full agent chat with provider controls, commands, plans, approvals, questions, queues, and a real project terminal. |
| **EINHERJAR** (`/einherjar`) | Extra working directories or personality/context overlays. |
| **LEDGER** (`/ledger`) | Live-session controls plus recorded sessions and analytics for tokens, cost, cache behavior, tools, stop reasons, context, and provider limits. |
| **FORGE** (`/forge`) | Settings, integrations, access, updates, maintenance, and developer tools. |

## Configuration and data

The packaged app keeps its executable, config, database, downloaded voice
models, and runtime data under `%LOCALAPPDATA%\Hlid`.

`hlid.config.toml` holds the vault layout, providers, server and `TLS` ports,
network access, attachments, voice, UI preferences, and registered agents. Most
of that can be changed in `Forge`. If a setting shows a restart marker, it does
not take effect until `Hlið` restarts. Server, `ACP`, and `Umbod` changes are the
main ones that need it.

Changing the working context is different. Reload that provider session so the
agent gets the new context. A browser refresh only reloads the UI.

`pricing-overrides.toml`, managed from **FORGE → Developer → Pricing**, adds
effective-dated model rates and aliases without touching the built-in pricing
code. Old priced `Ledger` rows stay frozen, which keeps historical accounting
honest.

`Forge` can also keep separate custom palettes for desktop and mobile. `Codex
Computer Use` model and effort defaults live under **FORGE → Agents → Computer
Use** and apply to the next one-shot Windows worker.

There is a small starting point in
[`hlid.config.example.toml`](hlid.config.example.toml).

## Remote access and security

`Hlið` uses one owner password. It stores an `Argon2id` hash, then gives a
successful browser an opaque `HttpOnly` trusted-device session for 30 days.
The first password can only be created on the `Hlið` machine, and remote
password login only works over `HTTPS`.

For another device, open **FORGE → Access → Network** and follow the guided
`Tailscale`/`TLS` setup. By default, `Hlið` accepts localhost and `Tailscale
CGNAT` peers. Regular `RFC1918` LAN devices need the separate local-network
switch. The same server-side session protects HTTP routes, APIs, chat
`WebSockets`, and terminal `WebSockets`.

Lost the password? Run this on the `Hlið` machine and restart it:

```powershell
hlid.exe auth reset
```

That removes the credential and every trusted-device session. It leaves the
vault and app config alone.

## Working from source

You need [Bun](https://bun.sh/) `1.3.14` or something compatible, plus a local
`Obsidian` vault for interactive testing.

```bash
bun install
bun run dev:all
```

`dev:all` starts the `Vite` UI and the `Bun` API/WebSocket server. The `TLS`
proxy joins in when certificate paths exist in `hlid.config.toml`.

The useful checks are pretty straightforward:

```bash
bun run check          # Biome, TypeScript, and changed-code Fallow analysis
bun run test           # Vitest suite
bun run test:db        # Bun-only database and auth tests
bun run validate       # Static checks, merged coverage, and full Fallow analysis
bun run build:win      # Windows executable build
```

For OpenAI Build Week evidence, generate a self-contained interactive report
that correlates Codex transcript commit output with the signed Git history:

```bash
bun run report:build-week
```

The default report is `reports/openai-build-week-provenance.html`. It includes
session/model IDs, commit links, verification commands, and transcript hashes,
but excludes prompts, developer instructions, arbitrary tool output, and
personal home paths. Run the script with `--help` to change the repository, Codex
roots, evidence window, baseline, title, or output path.

Ledger's **Import provider history** action discovers Claude CLI/SDK/Cowork and
Codex CLI/Desktop/editor sessions, stores their transcripts in Hlid, and makes
imported rows resumable in Raven. Sessions created through Hlid's Codex bridge
are always excluded. The dry-run-first CLI remains available for advanced
recovery work.

```bash
bun scripts/import-provider-history.ts --db /path/to/hlid.db \
  --codex-root /path/to/.codex/sessions \
  --claude-root /path/to/.claude/projects

# Discover Claude and Codex history automatically.
bun scripts/import-provider-history.ts --db /path/to/hlid.db \
  --discover-claude --discover-codex

bun scripts/repair-codex-usage.ts --db /path/to/hlid.db \
  --rollout-root /path/to/.codex/sessions

bun scripts/repair-claude-usage.ts --db /path/to/hlid.db \
  --transcript-root /path/to/.claude/projects
```

Each one writes a `JSON` manifest first. Read it. If the plan looks right, run
the same command with `--apply`. Apply mode verifies a standalone `SQLite`
backup before it touches `hlid.db`. Imported history remains non-resumable, but
its `Ledger` rows can be renamed or deleted and retain their source surface.
The same Claude discovery/import is available from `Ledger`'s actions menu.

Under the hood, `Hlið` uses `TanStack Start/Router`, `React`, a `Bun` server,
`SQLite`, `WebSockets`, and an `AgentProvider` abstraction. The `Vite` client
and runtime assets get embedded into the executable, so a release does not need
a loose `dist` folder sitting beside it.

Tagged releases validate on `Linux`, build and smoke-test the executable on
`Windows`, then publish the executable and its `SHA-256` checksum. The
[release workflow](.github/workflows/release.yml) is the source of truth there.

## License

[MIT](LICENSE)
