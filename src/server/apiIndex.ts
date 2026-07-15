/**
 * Curated, machine-readable catalog of hlid's HTTP surface, served at
 * GET /api-index on the WS/API server. Written for the vault agent so it can
 * operate hlid (sessions, usage, logs, config, lifecycle) through HTTP
 * instead of reading source files or querying the SQLite DB directly.
 *
 * Curated on purpose — UI-internal routes (attachment upload plumbing,
 * SSR data loaders) are omitted. Keep entries in sync when adding routes an
 * agent should know about.
 */

export type ApiEndpoint = {
	method: "GET" | "POST" | "PATCH" | "DELETE";
	path: string;
	/** Which listener serves it: "api" = WS/API port, "ui" = UI port. */
	server: "api" | "ui";
	desc: string;
};

export const API_ENDPOINTS: ApiEndpoint[] = [
	// ── Authentication (UI port) ──────────────────────────────────────────────
	{
		method: "GET",
		path: "/api/auth/status",
		server: "ui",
		desc: "Public authentication state: setup-required, locked, or authenticated.",
	},
	{
		method: "POST",
		path: "/api/auth/setup",
		server: "ui",
		desc: "Create the first app password from loopback only.",
	},
	{
		method: "POST",
		path: "/api/auth/login",
		server: "ui",
		desc: "Unlock a browser; remote requests require HTTPS.",
	},
	{
		method: "POST",
		path: "/api/auth/logout",
		server: "ui",
		desc: "Revoke the current trusted-device session.",
	},
	{
		method: "POST",
		path: "/api/auth/change-password",
		server: "ui",
		desc: "Change the app password and revoke every trusted device.",
	},
	{
		method: "POST",
		path: "/api/auth/revoke-all",
		server: "ui",
		desc: "Revoke every trusted-device session.",
	},
	// ── Discovery / status (api port) ─────────────────────────────────────────
	{
		method: "GET",
		path: "/api-index",
		server: "api",
		desc: "This catalog.",
	},
	{
		method: "GET",
		path: "/status",
		server: "api",
		desc: "Vault session state (idle/running) and active model.",
	},
	{
		method: "GET",
		path: "/providers",
		server: "api",
		desc: "Providers with availability, live model catalog (cached ~6h; ?refresh=1 forces), effort levels, permission modes.",
	},
	{
		method: "GET",
		path: "/acp/registry",
		server: "api",
		desc: "Cached official ACP agent catalog and local availability; ?refresh=1 forces refresh.",
	},
	{
		method: "POST",
		path: "/acp/authenticate",
		server: "api",
		desc: 'Inspect or authenticate an enabled ACP agent. Body: {"id": string, "methodId"?: string}.',
	},
	{
		method: "GET",
		path: "/account",
		server: "api",
		desc: "Account info (email/org/plan) from the first live session exposing it; null when none.",
	},
	{
		method: "GET",
		path: "/mcp-status",
		server: "api",
		desc: "Last known MCP server statuses for the vault session.",
	},
	{
		method: "GET",
		path: "/voice",
		server: "api",
		desc: "Local Whisper runtime status and cached model catalog; ?refresh=1 refreshes the catalog.",
	},
	// ── Codex app-server maintenance (api port) ───────────────────────────────
	{
		method: "GET",
		path: "/codex/app-servers",
		server: "api",
		desc: "Shared codex app-server processes: executable, alive, attached thread count.",
	},
	{
		method: "POST",
		path: "/codex/app-servers/restart",
		server: "api",
		desc: "Kill all shared codex app-servers; they respawn lazily on next use. Use after a codex CLI upgrade. Interrupts running codex sessions.",
	},
	// ── Sessions & history (api port) ─────────────────────────────────────────
	{
		method: "GET",
		path: "/db/sessions?page=&size=&q=&sort=",
		server: "api",
		desc: "Paginated session history. Optional label search (q) and sort (recent|cost|tokens).",
	},
	{
		method: "GET",
		path: "/db/sessions/export",
		server: "api",
		desc: "All session rows (unpaginated) for export.",
	},
	{
		method: "GET",
		path: "/db/recent-sessions?limit=",
		server: "api",
		desc: "Most recent sessions.",
	},
	{
		method: "GET",
		path: "/db/session-messages?session_id=&before_seq=&limit=",
		server: "api",
		desc: "Message/tool-event/attachment transcript; optional backwards cursor paging.",
	},
	{
		method: "PATCH",
		path: "/db/session?id=",
		server: "api",
		desc: 'Rename a session. Body: {"label": string}. Live sessions update immediately.',
	},
	{
		method: "DELETE",
		path: "/db/session?id=",
		server: "api",
		desc: "Delete a session and its ephemeral attachments.",
	},
	{
		method: "POST",
		path: "/db/sessions/cleanup",
		server: "api",
		desc: 'Delete sessions older than N days. Body: {"older_than_days": number}.',
	},
	{
		method: "GET",
		path: "/db/live-sessions",
		server: "api",
		desc: "Live pool + terminal sessions with state, model, labels.",
	},
	{
		method: "POST",
		path: "/db/live-sessions/stop",
		server: "api",
		desc: 'Abort a live session\'s in-flight work (keeps it in the pool). Body: {"session_id": string}.',
	},
	{
		method: "POST",
		path: "/db/live-sessions/close",
		server: "api",
		desc: 'Close and remove a live session (vault session refused). Body: {"session_id": string}.',
	},
	{
		method: "GET",
		path: "/db/attachments?session_id=&search=&type=&sort=&dir=",
		server: "api",
		desc: "Attachments, filterable by session, filename search, MIME class (image|pdf|text|other), sortable by created_at|size_bytes asc|desc.",
	},
	// ── Usage & stats (api port) ──────────────────────────────────────────────
	{
		method: "GET",
		path: "/db/stats",
		server: "api",
		desc: "All-time / today / this-month token and cost totals.",
	},
	{
		method: "GET",
		path: "/db/provider-usage?providers=claude,codex",
		server: "api",
		desc: "Per-provider rolling usage windows: query counts, cost, and live rate-limit utilization.",
	},
	{
		method: "GET",
		path: "/db/weekly-stats",
		server: "api",
		desc: "Per-day usage for the current week.",
	},
	{
		method: "GET",
		path: "/db/thirty-day-stats",
		server: "api",
		desc: "Per-day usage for the last 30 days.",
	},
	{
		method: "GET",
		path: "/db/activity",
		server: "api",
		desc: "Recent query activity feed.",
	},
	// ── Logs (api port) ───────────────────────────────────────────────────────
	{
		method: "GET",
		path: "/db/logs?limit=",
		server: "api",
		desc: "Server log entries (console output is redirected here in the compiled exe).",
	},
	{
		method: "DELETE",
		path: "/db/logs",
		server: "api",
		desc: "Clear stored logs.",
	},
	// ── System (ui port, /api/*) ──────────────────────────────────────────────
	{
		method: "GET",
		path: "/api/health",
		server: "ui",
		desc: "Liveness check.",
	},
	{
		method: "GET",
		path: "/api/version",
		server: "ui",
		desc: "Running hlid version.",
	},
	{
		method: "GET",
		path: "/api/updates",
		server: "ui",
		desc: "Check for a newer hlid release.",
	},
	{
		method: "POST",
		path: "/api/updates",
		server: "ui",
		desc: 'Body action: "check"|"download"|"apply" or loopback-only "prepare_cli"|"apply_cli" with a CLI id.',
	},
	{
		method: "GET",
		path: "/api/lifecycle",
		server: "ui",
		desc: "Autostart registration status and install paths.",
	},
	{
		method: "POST",
		path: "/api/lifecycle",
		server: "ui",
		desc: 'Body: {"action": "install"|"uninstall"|"restart"|"shutdown"|"open_install_dir"} — autostart and process lifecycle management.',
	},
	{
		method: "GET",
		path: "/api/config",
		server: "ui",
		desc: "Read hlid.config.toml (vault paths, providers, agents, server).",
	},
	{
		method: "POST",
		path: "/api/config",
		server: "ui",
		desc: "Write config changes. Most changes need a session reload or restart.",
	},
	{
		method: "GET",
		path: "/api/tailscale",
		server: "ui",
		desc: "Tailscale status for remote access.",
	},
	{
		method: "POST",
		path: "/api/voice/transcribe",
		server: "ui",
		desc: "Transcribe a multipart 16 kHz WAV recording locally with the selected Whisper model.",
	},
	// ── Vault & agents (ui port, /api/*) ──────────────────────────────────────
	{
		method: "GET",
		path: "/api/vault/skills",
		server: "ui",
		desc: "Scan the vault's skills folder.",
	},
	{
		method: "GET",
		path: "/api/vault/memory",
		server: "ui",
		desc: "Scan the vault's memory folder.",
	},
	{
		method: "GET",
		path: "/api/agents",
		server: "ui",
		desc: "Registered einherjar agents.",
	},
	{
		method: "GET",
		path: "/api/mcp/agent?path=",
		server: "ui",
		desc: "MCP servers configured for a registered agent path.",
	},
	{
		method: "POST",
		path: "/api/mcp/agent",
		server: "ui",
		desc: 'Write an agent\'s MCP server map. Body: {"agentPath", "servers"}.',
	},
];

/** Response body for GET /api-index. */
export function buildApiIndex(
	apiPort: number,
	uiPort: number,
): {
	description: string;
	api_port: number;
	ui_port: number;
	endpoints: ApiEndpoint[];
} {
	return {
		description:
			'Curated hlid HTTP API for programmatic/agent use. "api" endpoints are served on api_port, "ui" endpoints on ui_port — both localhost unless local_network_access is enabled. Non-GET requests must omit or match the allowed Origin.',
		api_port: apiPort,
		ui_port: uiPort,
		endpoints: API_ENDPOINTS,
	};
}
