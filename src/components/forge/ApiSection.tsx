import { useNavigate } from "@tanstack/react-router";

// ─── Build Skill prompts ──────────────────────────────────────────────────────

const SESSION_API_PROMPT = `Create a vault skill for the hlid session management API.

Read \`hlid.config.toml\` to find \`server.port\`. The data API runs on that port + 1.

Endpoints:
  GET  /db/sessions?page=N&size=N
  GET  /db/session-messages?session_id=ID
  GET  /db/session-row?id=ID
  GET  /db/recent-sessions?limit=N
  GET  /db/stats
  GET  /db/current-session
  GET  /db/active-session
  GET  /db/session-context?session_id=ID
  GET  /db/session-permissions?session_id=ID
  GET  /db/session-plan-proposals?session_id=ID
  GET  /db/weekly-stats
  GET  /db/thirty-day-stats
  GET  /db/usage-windows
  PATCH  /db/session?id=ID   { label: string }
  DELETE /db/session?id=ID
  POST /db/sessions/cleanup  { older_than_days: N }

Create a skill file in the vault's skills folder (\`vault.skills\` in config). Add YAML frontmatter with \`name\` and \`description\` fields.

Register the skill in the vault's skills/index.md under an appropriate section using the pipe table format:
## Section Name
| \`skill-name\` | one-line description |`;

const CONFIG_API_PROMPT = `Create a vault skill for the hlid configuration API.

All endpoints are served at http://localhost:3000.

Endpoints:
  GET  /api/config           — Read the full hlid configuration object
  POST /api/config           — Write/replace the full configuration (body: HlidConfig JSON)

The config object includes: vault (path, name, style, folder names), server (port, TLS, access), claude (model, effort, max_turns, permission_mode), ui (theme, enter_to_submit), status_vocabulary, agents array.

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
    — Returns: Array<{ path, name, mode, provider, hasClaudemd, dirExists, model?, effort?, maxTurns?, permissionMode?, recapModel? }>

  POST /api/agents
    — Body: Agent[]  (full replacement array)
    — Saves the entire agents list to hlid.config.toml

  GET  /api/agents/validate?path={agentPath}
    — Returns: { dirExists, hasClaudemd, suggestedName, inVault, externalAllowed, resolvedPath }
    — Validates a filesystem path as a potential agent

  GET  /api/agents/claudemd?path={agentPath}
    — Returns: { content: string | null }
    — Reads the agent's CLAUDE.md file (path must be a registered agent)

Create a skill file in the vault's skills folder (\`vault.skills\` in config). Add YAML frontmatter with \`name\` and \`description\` fields. Include examples for listing agents and reading CLAUDE.md.

Register the skill in the vault's skills/index.md under an appropriate section using the pipe table format:
## Section Name
| \`skill-name\` | one-line description |`;

const VAULT_API_PROMPT = `Create a vault skill for the hlid vault data API.

All endpoints are served at http://localhost:3000.

Endpoints:
  GET  /api/vault/projects
    — Returns: Project[]  (each with name, status, tags, content, dates)

  GET  /api/vault/skills
    — Returns: { skills: Skill[], sectionOrder: string[] }

  GET  /api/vault/memory?folder={optional}
    — Returns: MemoryFile[]  (defaults to vault.memory folder; pass ?folder=inbox etc. for other folders)

  GET  /api/vault/folder-groups?folder={optional}
    — Returns: FolderGroup[]  (hierarchical folder tree; defaults to vault.areas)

Create a skill file in the vault's skills folder (\`vault.skills\` in config). Add YAML frontmatter with \`name\` and \`description\` fields. Include examples for reading vault data from an AI agent perspective.

Register the skill in the vault's skills/index.md under an appropriate section using the pipe table format:
## Section Name
| \`skill-name\` | one-line description |`;

// ─── API group data ───────────────────────────────────────────────────────────

const API_GROUPS = [
	{
		id: "session",
		label: "Session API",
		description: "Session CRUD, messages, stats, usage",
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
		],
		prompt: SESSION_API_PROMPT,
	},
	{
		id: "config",
		label: "Config API",
		description: "Read and write full hlid configuration",
		endpoints: ["GET  /api/config", "POST /api/config"],
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
		description: "List, save, validate agents and read CLAUDE.md",
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
		description: "Read projects, skills, memory, and folder groups",
		endpoints: [
			"GET  /api/vault/projects",
			"GET  /api/vault/skills",
			"GET  /api/vault/memory?folder=",
			"GET  /api/vault/folder-groups?folder=",
		],
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
