import { useNavigate } from "@tanstack/react-router";

// ─── Build Skill prompts ──────────────────────────────────────────────────────

const SESSION_API_PROMPT = `Create a vault skill for the hlid session management API.

Read \`hlid.config.toml\` to find \`server.port\`. The data API runs on that port + 1.

## DB Session Endpoints (persistent history)

  GET  /db/sessions?page=N&size=N
    — Paginated session history. Returns { rows: SessionRow[], total, page, size }.

  GET  /db/session-row?id=ID
    — Single session by DB session ID. Returns SessionRow or null.

  GET  /db/recent-sessions?limit=N
    — Most recent N sessions (default 14, max 100).

  GET  /db/current-session
    — Returns { session_id } for the currently active session, or null.

  GET  /db/active-session
    — Returns the active SessionRow (current or most recent). Null-safe fallback.

  GET  /db/session-messages?session_id=ID
    — Full message history for a session, enriched with tool events and attachments.

  GET  /db/session-context?session_id=ID
    — Context window snapshot from the last query in the session.

  GET  /db/session-permissions?session_id=ID
    — Permission events (allow/deny decisions) for a session.

  GET  /db/session-plan-proposals?session_id=ID
    — Plan mode proposals history for a session.

  GET  /db/stats
    — Aggregated usage stats + last 10 sessions.

  GET  /db/weekly-stats
    — Query counts grouped by day of week.

  GET  /db/thirty-day-stats
    — Daily query counts for the last 30 days.

  GET  /db/usage-windows
    — Provider rate-limit window utilization (live in-memory overlay + DB fallback).

  PATCH  /db/session?id=ID   { label: string }
    — Rename a DB session. Body must include \`label\`.

  DELETE /db/session?id=ID
    — Delete a DB session and all related rows (messages, tool events, attachments, etc.).

  POST /db/sessions/cleanup  { older_than_days: number }
    — Bulk-delete sessions older than N days. Returns { deleted: count }.
    — Default: 30 days. Also accepted as query param ?older_than_days=N.

## Live Session Endpoints (in-memory pool, resets on server restart)

  GET  /db/live-sessions
    — List all currently active pool sessions.
    — Returns array of: { session_id, agent_cwd, agent_name, state, model,
        hasPendingPermissions, hasDbSession, db_session_id, lastLabel }
    — state: "idle" | "running" | "error"

  POST /db/live-sessions/stop  { session_id: string }
    — Abort the currently running turn for a live session.
    — The session stays in the pool (can resume); only the in-flight turn is cancelled.
    — Returns { ok: true } or 404 if not found.

  POST /db/live-sessions/close  { session_id: string }
    — Remove a live session from the pool entirely.
    — The vault session cannot be closed (returns 403).
    — Returns { ok: true } or 404/403 on error.

Create a skill file in the vault's skills folder (\`vault.skills\` in config). Add YAML frontmatter with \`name\` and \`description\` fields.

The skill should be able to: list live sessions, stop/close sessions, rename sessions, delete old sessions, and run cleanup by age.

Register the skill in the vault's skills/index.md under an appropriate section using the pipe table format:
## Section Name
| \`skill-name\` | one-line description |`;

const CONFIG_API_PROMPT = `Create a vault skill for the hlid configuration API.

All endpoints are served at http://localhost:3000.

Endpoints:
  GET  /api/config           — Read the full hlid configuration object
  POST /api/config           — Write/replace the full configuration (body: HlidConfig JSON)
  GET  /api/pricing          — Read the merged built-in and local pricing catalog
  POST /api/pricing          — Validate/write pricing-overrides.toml (body: { text: string })

The config object includes: vault (path, name, style, folder names), server (port, TLS, access), claude (model, effort, max_turns, permission_mode), ui (theme, enter_to_submit), status_vocabulary, agents array. Pricing overrides use effective_from/effective_until UTC dates and are returned alongside read-only built-ins.

Create a skill file in the vault's skills folder (\`vault.skills\` in config). Add YAML frontmatter with \`name\` and \`description\` fields. Include request/response shapes and usage examples for an AI agent.

Register the skill in the vault's skills/index.md under an appropriate section using the pipe table format:
## Section Name
| \`skill-name\` | one-line description |`;

const MCP_API_PROMPT = `Create a vault skill for the hlid MCP (Model Context Protocol) management API.

All endpoints are served at http://localhost:3000.

Vault MCP endpoints:
  GET  /api/mcp/vault
    — Returns: { servers: Array<{ name, config, disabled }> }

  POST /api/mcp/vault
    — Body: { servers: Record<string, McpServerConfig> }
    — Replaces the vault's .mcp.json entirely

  POST /api/mcp/vault/toggle
    — Body: { name: string, disabled: boolean }
    — Enables or disables a single vault MCP server

Agent MCP endpoints (requires agentPath to be a registered agent in hlid config):
  GET  /api/mcp/agent?path={agentPath}
    — Returns: { servers: Array<{ name, config, disabled }> }

  POST /api/mcp/agent
    — Body: { agentPath: string, servers: Record<string, McpServerConfig> }
    — Replaces the agent's .mcp.json

  POST /api/mcp/agent/toggle
    — Body: { agentPath: string, name: string, disabled: boolean }
    — Enables or disables a single agent MCP server

Create a skill file in the vault's skills folder (\`vault.skills\` in config). Add YAML frontmatter with \`name\` and \`description\` fields. Include examples for listing, adding, and toggling MCP servers.

Register the skill in the vault's skills/index.md under an appropriate section using the pipe table format:
## Section Name
| \`skill-name\` | one-line description |`;

const AGENT_API_PROMPT = `Create a vault skill for the hlid agent management API.

All endpoints are served at http://localhost:3000.

Endpoints:
  GET  /api/agents
    — Returns: Array<{ path, name, mode, provider, instructionFile, dirExists, model?, effort?, maxTurns?, permissionMode?, recapModel? }>

  POST /api/agents
    — Body: Agent[]  (full replacement array)
    — Saves the entire agents list to hlid.config.toml

  GET  /api/agents/validate?path={agentPath}
    — Returns: { dirExists, instructionFile, suggestedName, inVault, externalAllowed, resolvedPath }
    — Validates a filesystem path as a potential agent

  GET  /api/agents/claudemd?path={agentPath}
    — Returns: { filename: "AGENTS.md" | "CLAUDE.md" | null, content: string | null }
    — Reads the agent's context instruction file (path must be a registered agent)

Create a skill file in the vault's skills folder (\`vault.skills\` in config). Add YAML frontmatter with \`name\` and \`description\` fields. Include examples for listing agents and reading its AGENTS.md or CLAUDE.md instructions.

Register the skill in the vault's skills/index.md under an appropriate section using the pipe table format:
## Section Name
| \`skill-name\` | one-line description |`;

const VAULT_API_PROMPT = `Create a vault skill for the hlid vault data API.

All endpoints are served at http://localhost:3000.

Endpoints:
  GET  /api/vault/skills
    — Returns: { skills: Skill[], sectionOrder: string[] }

  GET  /api/vault/memory
    — Returns: MemoryFile[]

Create a skill file in the vault's skills folder (\`vault.skills\` in config). Add YAML frontmatter with \`name\` and \`description\` fields. Include examples for reading vault data from an AI agent perspective.

Register the skill in the vault's skills/index.md under an appropriate section using the pipe table format:
## Section Name
| \`skill-name\` | one-line description |`;

const SYSTEM_API_PROMPT = `Create a vault skill for the hlid system and maintenance API.

Read \`hlid.config.toml\` to find \`server.port\`. The data API runs on that port + 1; /api/* endpoints run on the port itself.

## Discovery & status (data API, port + 1)

  GET  /api-index
    — Machine-readable catalog of hlid's full HTTP surface: method, path, which port serves it, and a description per endpoint. Fetch this first to discover everything else.

  GET  /status
    — Vault session state ("idle" | "running") and active model.

  GET  /providers
    — Providers with availability, live model catalog (cached ~6h; ?refresh=1 forces a refetch), effort levels, permission modes.

  GET  /account
    — Account info (email/org/plan) from the first live session exposing it, or null.

  GET  /mcp-status
    — Last known MCP server statuses for the vault session.

  GET  /db/provider-usage?providers=claude,codex
    — Per-provider rolling usage windows: query counts, cost, live rate-limit utilization.

  GET  /db/logs?limit=N
    — Server log entries (console output is stored here in the compiled exe).

  DELETE /db/logs
    — Clear stored logs.

## Codex app-server maintenance (data API, port + 1)

  GET  /codex/app-servers
    — Shared codex app-server processes: Array<{ executable, alive, threads }>.

  POST /codex/app-servers/restart
    — Kill all shared codex app-servers; they respawn lazily on next use. Run after a codex CLI upgrade so hlid picks up the new binary without a restart. Interrupts running codex sessions.

## System (UI port)

  GET  /api/health     — Liveness check.
  GET  /api/version    — Running hlid version.
  GET  /api/updates    — Check Hlið, provider CLI, and desktop app versions.
  POST /api/updates    — Download/apply Hlið updates; local or Tailscale browsers can prepare/apply known CLI updates.
  GET  /api/lifecycle  — Autostart status and install paths.
  POST /api/lifecycle  — Body: { action: "install" | "uninstall" | "restart" | "shutdown" | "open_install_dir" }.
  GET  /api/tailscale  — Tailscale status for remote access.

Create a skill file in the vault's skills folder (\`vault.skills\` in config). Add YAML frontmatter with \`name\` and \`description\` fields.

The skill should be able to: discover the API via /api-index, check health/version/status, read provider usage and rate limits, view and clear logs, and restart codex app-servers after CLI upgrades.

Register the skill in the vault's skills/index.md under an appropriate section using the pipe table format:
## Section Name
| \`skill-name\` | one-line description |`;

// ─── API group data ───────────────────────────────────────────────────────────

const API_GROUPS = [
	{
		id: "system",
		label: "System API",
		description:
			"API discovery, server status, provider usage, logs, codex app-server maintenance, lifecycle",
		endpoints: [
			"GET  /api-index",
			"GET  /status",
			"GET  /providers",
			"GET  /account",
			"GET  /mcp-status",
			"GET  /db/provider-usage?providers=",
			"GET  /db/logs?limit=N",
			"DELETE /db/logs",
			"GET  /codex/app-servers",
			"POST /codex/app-servers/restart",
			"GET  /api/health",
			"GET  /api/version",
			"GET  /api/updates",
			"POST /api/updates",
			"GET  /api/lifecycle",
			"POST /api/lifecycle",
			"GET  /api/tailscale",
		],
		prompt: SYSTEM_API_PROMPT,
	},
	{
		id: "session",
		label: "Session API",
		description: "Session CRUD, messages, stats, usage, live pool management",
		endpoints: [
			"GET  /db/sessions?page=N&size=N",
			"GET  /db/session-messages?session_id=ID",
			"GET  /db/session-row?id=ID",
			"GET  /db/stats",
			"GET  /db/current-session",
			"GET  /db/weekly-stats",
			"GET  /db/thirty-day-stats",
			"GET  /db/usage-windows",
			"PATCH  /db/session?id=ID",
			"DELETE /db/session?id=ID",
			"POST /db/sessions/cleanup",
			"GET  /db/live-sessions",
			"POST /db/live-sessions/stop",
			"POST /db/live-sessions/close",
		],
		prompt: SESSION_API_PROMPT,
	},
	{
		id: "config",
		label: "Config & Pricing API",
		description: "Read and write configuration and pricing overrides",
		endpoints: [
			"GET  /api/config",
			"POST /api/config",
			"GET  /api/pricing",
			"POST /api/pricing",
		],
		prompt: CONFIG_API_PROMPT,
	},
	{
		id: "mcp",
		label: "MCP API",
		description: "Manage vault and agent MCP servers",
		endpoints: [
			"GET  /api/mcp/vault",
			"POST /api/mcp/vault",
			"POST /api/mcp/vault/toggle",
			"GET  /api/mcp/agent?path=",
			"POST /api/mcp/agent",
			"POST /api/mcp/agent/toggle",
		],
		prompt: MCP_API_PROMPT,
	},
	{
		id: "agents",
		label: "Agent API",
		description: "List, save, validate agents and read context instructions",
		endpoints: [
			"GET  /api/agents",
			"POST /api/agents",
			"GET  /api/agents/validate?path=",
			"GET  /api/agents/claudemd?path=",
		],
		prompt: AGENT_API_PROMPT,
	},
	{
		id: "vault",
		label: "Vault API",
		description: "Read skills and memory",
		endpoints: ["GET  /api/vault/skills", "GET  /api/vault/memory"],
		prompt: VAULT_API_PROMPT,
	},
] as const;

// ─── Component ────────────────────────────────────────────────────────────────

export function ApiSection() {
	const navigate = useNavigate();

	function buildSkill(prompt: string) {
		void navigate({ to: "/raven", search: { prompt } });
	}

	return (
		<div className="space-y-4">
			<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
				API Reference
			</div>
			<p className="text-xs text-muted-foreground">
				REST endpoints available to the vault agent. Each group has a{" "}
				<span className="font-mono text-[10px]">Build Skill →</span> button that
				pre-fills a chat prompt to create a SKILL.md for that API group.
			</p>

			<div className="space-y-3">
				{API_GROUPS.map((group) => (
					<div
						key={group.id}
						className="border border-border bg-card p-4 space-y-3"
					>
						<div className="flex items-start justify-between gap-4">
							<div>
								<div className="text-[10px] tracking-widest font-semibold uppercase text-foreground">
									{group.label}
								</div>
								<div className="text-[10px] text-muted-foreground mt-0.5">
									{group.description}
								</div>
							</div>
							<button
								type="button"
								onClick={() => buildSkill(group.prompt)}
								className="shrink-0 text-[8px] tracking-widest text-primary hover:opacity-70 uppercase transition-opacity"
							>
								Build Skill →
							</button>
						</div>

						<div className="space-y-0.5">
							{group.endpoints.map((ep) => (
								<div
									key={ep}
									className="font-mono text-[10px] text-muted-foreground/70"
								>
									{ep}
								</div>
							))}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
