# Hlið user guide

Hlið is a local web interface for working with an Obsidian vault through Claude,
Codex, or another installed Agent Client Protocol provider. This guide covers
the packaged Windows app. For source development, see the contributor section
in the [README](../README.md#contributor-setup).

## Install and first launch

1. Download the current `hlid-vX.Y.Z-windows-x64.exe` from
   [GitHub Releases](https://github.com/Kyle-Undefined/hlid/releases/latest).
2. Run the executable. Hlið is currently unsigned, so Windows may display a
   SmartScreen warning. Review the publisher and filename, choose **More info**,
   and then **Run anyway** if you trust the release.
3. The downloaded executable installs the canonical copy at
   `%LOCALAPPDATA%\Hlid\hlid.exe`, refreshes the **Hlið** Start Menu shortcut,
   starts the service, and opens `http://127.0.0.1:3000` in your browser.

Future launches should use the Start Menu shortcut. Starting Hlið again while
it is already running simply opens the existing interface. Autostart is
optional and can be enabled later in Forge.

### Create the app password

The first browser on the Hlið machine displays **Create app password**. The
password must contain 12–256 characters; Hlið does not require a particular mix
of uppercase letters, numbers, or symbols.

Initial password creation is allowed only from the host machine. After setup,
other trusted devices can sign in over the configured HTTPS endpoint. A login
remains trusted for 30 days unless you lock that browser, change the password,
or revoke every device in Forge.

![First-run vault selection and structure setup](images/first-run-vault-setup.png)

*Select the local Obsidian vault that Hlið should use, then review the detected structure.*

## Connect a vault

The first-run wizard walks through five short stages:

1. **Welcome** explains the application's page names.
2. **Vault** selects an existing local Obsidian vault. Hidden folders are not
   shown in the folder picker.
3. **Structure** detects either a PARA or wiki-style layout and pre-fills known
   folders. Review the vault name, folder mappings, provider permission mode,
   and theme before saving. Empty optional mappings are allowed.
4. **Primer** explains how Hlið works with the vault and its skills.
5. **Done** opens the main interface.

The wizard writes `hlid.config.toml` beside the installed executable. You can
later change the same settings under **FORGE → Workspace**. A moved, renamed, or
inaccessible vault path must be corrected there before vault pages can load.

## Your first session

Open **RAVEN** and choose the provider you want to use. The provider must already
be available and authenticated in its configured runtime (Windows or a configured
WSL wrapper). Select an existing session or create a new one, optionally load a
vault or global skill, then send a prompt.

![Raven conversation showing agent output and tool activity](images/raven-tool-activity.png)

*Tool calls and their results remain inline with the conversation so you can inspect what the agent did.*

While an agent is working:

- Tool activity appears inline and can be expanded or collapsed.
- A tool requiring approval displays a permission card. Approve it for the
  current session or save the approval locally; a denial can include feedback.
- Sending another prompt queues it. The queued item appears in the conversation
  and can be canceled before it runs.
- Agent questions appear as inline choices with an optional note field.
- Plan mode presents a plan for approval, revision, or cancellation before the
  implementation turn. The optional HTML toggle opens agent-authored plans in a
  sandboxed viewer.
- Supported providers show subagent progress inline, including status, current
  step, runtime, and usage details.
- The copy action on a message copies its rendered text.

Drag files onto the composer or use its attachment control before sending.
Uploads can be temporary for that session or persistent vault attachments.

## Page guide

### Watch

![Watch overview with activity, sessions, and skills](images/watch-overview.png)

*Watch is the landing page for recent work and quick vault context.*

**WATCH** is both the landing dashboard and the quickest way to start work. Its
composer can run a prompt or discovered vault/global skill, target a registered
agent, attach files, use voice input, continue the current session, or leave the
run in the background. It also shows live session state, provider usage, recent
query cost, seven- and thirty-day activity, MCP status, and recent sessions.

### Raven

**RAVEN** is the main agent workspace. It combines conversation history,
session/provider selection, skills, attachments, voice input, tool activity,
permission requests, agent questions, plan review, subagent activity, and queued
follow-ups. The model menu also exposes provider-supported model, effort, and
permission choices.

Use the **Plan** composer toggle when the agent should propose work before
implementing it. Enable **HTML** alongside it for a styled plan preview; approve,
cancel, or send revision feedback from the same plan card or viewer.

The **Terminal** toggle opens a real login shell in the current vault or
registered-agent directory. Desktop layouts show it in a split panel below the
chat; mobile layouts switch between Chat and Terminal tabs. Closing the terminal
disconnects and ends that shell. If Claude interactive mode is enabled in Forge,
Raven uses the Claude CLI in a full terminal instead of the structured chat
timeline.

![Raven conversation adapted to a mobile display](images/raven-mobile.png)

*The same session controls and conversation are available from the responsive mobile interface.*

### Vault

![Vault browser showing configured note and project groupings](images/vault-browser.png)

*Vault follows the folder mappings and status vocabulary selected during setup.*

**VAULT** browses the configured note, project, memory, and skill directories.
Project grouping uses YAML front matter and the custom status vocabulary in
your configuration rather than imposing fixed project labels.

### Relics

![Relics attachment management view](images/relics-attachments.png)

*Relics searches and filters the files that have moved through Hlið sessions.*

**RELICS** manages attachments. Ephemeral files belong to the session in which
they were uploaded; vault attachments persist in the configured vault. Search
by filename or narrow the list by date. Deleting a vault attachment removes the
managed record by default; deleting the source file is a separate opt-in Forge
setting.

### Ledger

**LEDGER** reports token usage, query cost, cache behavior, context-window use,
tool activity, and supported provider limit windows. It also manages session
names and old session records.

### Einherjar

**EINHERJAR** registers other agent directories. A `context` entry loads either
`AGENTS.md` or `CLAUDE.md` as a personality/instruction overlay while keeping
the vault as the working directory. When both exist, `AGENTS.md` takes
precedence because it is the provider-neutral ACP contract; `CLAUDE.md` remains
the compatibility fallback. A `cwd` entry runs the agent from the registered
directory. Paths outside the vault require the external-agent option in Forge.

### Forge

![Forge overview and category navigation](images/forge-overview.png)

*Forge groups settings by task and marks changes that need a restart.*

**FORGE** is organized into task-focused categories:

- **Overview** summarizes the current configuration and service state.
- **Workspace** configures the vault, folder mappings, and vocabulary.
- **Agents** configures the default provider, model, effort, permissions, usage
  limits, recaps, and automatic usage-window sleep/resume behavior.
- **Access** contains network, TLS, password, and trusted-device settings.
- **Experience** controls themes, input behavior, HTML-plan defaults, voice, and
  browser-local privacy mode.
- **Integrations** manages MCP servers, Umbod tool policy, and the ACP catalog.
- **Developer** switches between the event log, local API reference, and pricing
  catalog.
- **Advanced** contains database maintenance, provider-session reload, restart,
  and shutdown controls.

Most edits save automatically. A visible restart marker means the server must
restart before the new value applies; server, ACP, and Umbod configuration
changes currently set that marker. MCP edits are synchronized to the live vault
session. Reload a provider session after changing the working context it should
receive; reloading clears that live provider conversation while its recorded
Ledger history remains available.

Developer → Pricing shows Hlið's read-only built-in model and alias timelines
and edits `pricing-overrides.toml`. Local model rates or aliases can be bounded
with UTC `effective_from` and `effective_until` dates, so a moving label such as
`codex-auto-review` can change without an application update. Saving validates
the whole file before replacing it. Existing priced Ledger rows remain frozen;
new fallback estimates use the rule active at the query timestamp.

## Remote and mobile access

Hlið binds to `127.0.0.1` by default. Do not expose port 3000 directly to an
untrusted network.

To use Hlið from another device:

1. Install and authenticate Tailscale on the Windows host and the other device.
2. Open **FORGE → Access → Network** and use **Set up with agent**, or follow
   the displayed manual steps.
3. Generate a Tailscale certificate for the host's MagicDNS name and store the
   certificate and private key under `%LOCALAPPDATA%\Hlid`.
4. Set the TLS certificate/key paths, enable network access, and restart Hlið.
5. Open the HTTPS MagicDNS address shown in Forge. The default TLS proxy port is
   `3443`.
6. Sign in with the app password, then install Hlið from the browser's PWA action
   if an app-like mobile or desktop window is desired.

Remote password login and remote microphone capture both require HTTPS. Hlið
accepts localhost and Tailscale CGNAT peers by default. Enable RFC1918 local
network access only on a network you trust.

## Voice and attachments

### Voice input

Open **FORGE → Experience → Voice**, download a Whisper model, select it, and
enable voice. The chosen model is loaded locally and remains available for fast
repeated transcription. Changing the selected model hot-loads it without a
server restart.

In Watch or Raven, tap the microphone once to begin and again to stop. On
desktop, the configured recording shortcut (default `Alt+Shift+V`) controls the
same action. The browser converts audio to mono 16 kHz WAV, and the Hlið host
transcribes it locally. Audio is not stored as an attachment or database record.
Transcribed text can be inserted into the editable draft or sent immediately,
depending on the Forge setting.

Microphone capture on another device requires the configured HTTPS endpoint. If
the microphone is unavailable, verify browser permission, HTTPS, the selected
model, and the Forge voice toggle.

### Attachments

The default upload limit is 25 MB. The default allowlist includes images, PDF,
plain text, Markdown, CSV, and JSON. Both the byte limit and allowed MIME types
can be changed in `hlid.config.toml`.

Use ephemeral attachments for short-lived session context. Use vault
attachments when the file should remain available in the vault after the
session ends.

## Maintenance and troubleshooting

### Updates and SmartScreen

Hlið checks GitHub Releases at launch and can check manually from Forge. An
update downloads a versioned executable and launches it through Windows so you
can respond to SmartScreen. Accepting the launch replaces the canonical copy
and restarts Hlið; dismissing it leaves the current version running.

Hlið also detects the installed Claude and Codex CLI versions and, for enabled
ACP agents, compares each agent's self-reported version with the ACP registry.
Available agent updates appear in the global update banner and under
**FORGE → Overview**, along with the update command for that installation.
From a browser on the Hlið computer or an authenticated Tailscale connection,
select **UPDATE** for a user-writable installation. Hlið warns before stopping
active provider sessions, releases shared app-server processes, runs the known
update command, and rechecks the installed version. Terminal sessions remain
open.

Installations that require elevation, including a root-owned WSL global npm
install, show **OPEN TERMINAL** instead. Hlið releases provider processes,
copies the exact command, and opens an embedded terminal in the matching WSL
distro and configured workspace. Paste the command there so `sudo` can prompt
inside Forge. Hlið never asks for, stores, or relays the sudo password. Custom
ACP executables continue to use their original installer.

CLI update actions are available from a loopback browser on the Hlið computer
or an authenticated Tailscale connection. Other LAN clients can view versions
and copy the displayed guidance, but cannot stop sessions or start an update.

Installed PWA clients pick up new releases automatically: the service worker
detects the new build, replaces previously cached assets, and refreshes on the
next load. No manual cache clearing is needed.

### Autostart and lifecycle

Forge can add or remove the current executable from the Windows per-user Run
key. Restart and shutdown controls are available in the same area. Autostart
runs Hlið in the background without opening a browser.

### Session reloads

Reload a session after changing its vault context or MCP configuration. A
browser refresh only reloads the interface and is not a substitute for a server
restart or provider session reload.

### Reset a lost password

Run the following command on the Windows host, then restart Hlið:

```powershell
%LOCALAPPDATA%\Hlid\hlid.exe auth reset
```

The reset deletes the password credential and all trusted-device sessions. It
does not remove vault data or application configuration. The next local visit
returns to **Create app password**.

### Remote login does not work

Check that the URL uses HTTPS, the device is connected to the same Tailscale
network, Forge reports the expected MagicDNS name and certificate paths, network
access is enabled, and Hlið was restarted after the network change. LAN IPs
outside Tailscale additionally require the explicit local-network option.

### The vault cannot be opened

Open **FORGE → Workspace** on the host and verify that the vault path still
exists and is a directory. Update moved or renamed folder mappings, save, and
reload the affected session.
