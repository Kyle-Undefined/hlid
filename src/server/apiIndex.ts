import type { HlidApiEndpoint, HlidApiIndex } from "../lib/apiIndex";

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

export type ApiEndpoint = HlidApiEndpoint;

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
		desc: "Vault session state (idle, running, or error), selected model, permission mode, effort, and active turn ID when running.",
	},
	{
		method: "GET",
		path: "/providers?refresh=1&host_capabilities=1&provider_capabilities=1",
		server: "api",
		desc: "Provider availability and server-owned model and capability catalog. Normal reads use a roughly 60-second stale-while-revalidate snapshot backed by cached model and provider evidence; refresh=1 forces live discovery, host_capabilities=1 includes host-only readiness, and host_capabilities_wait=1 performs only the bounded host-readiness recovery without refreshing models. provider_capabilities=1 includes the bounded support, integration, readiness, and resolved-availability snapshot. capability_cwd may select an exact absolute workspace for workspace-scoped evidence, while provider_capabilities_wait=1 awaits an uncached discovery result. Includes input modalities, per-model effort and service tiers, permission modes, exact-fork support, and structured, realtime, and workflow capabilities.",
	},
	{
		method: "GET",
		path: "/provider-apps?provider_id=codex&limit=50&refresh=1",
		server: "api",
		desc: "Bounded provider-native Apps and connector inventory. Reports installed, configured, authentication, usable, OAuth completion, and MCP tool/resource health separately. cursor pages the available catalog; cwd selects the exact provider workspace; refresh=1 requests a live provider refresh.",
	},
	{
		method: "POST",
		path: "/provider-apps/authenticate",
		server: "api",
		desc: 'Start provider-native app or MCP authentication and open the authorization URL on the Hlid host without returning or persisting it. Body: {"providerId": string, "kind": "app" | "mcp", "id": string, "cwd"?: string}.',
	},
	{
		method: "GET",
		path: "/acp/registry?refresh=1",
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
		method: "POST",
		path: "/acp/preflight",
		server: "api",
		desc: "Validate a draft Hlid config against resolved ACP invocation environments before Forge persists it.",
	},
	{
		method: "GET",
		path: "/acp/models?id=opencode",
		server: "api",
		desc: "Inspect an enabled ACP agent's live model catalog without Hlid's OpenCode model-visibility overlay. Used on demand by Forge so filtered-out models remain editable.",
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
		desc: "Last known MCP server statuses for the vault session's currently selected provider; empty until observed.",
	},
	{
		method: "GET",
		path: "/skills/catalog",
		server: "api",
		desc: "Installed-registry and workspace skill packages available for review and import; source paths remain server-side.",
	},
	{
		method: "POST",
		path: "/skills/refresh",
		server: "api",
		desc: "Reload provider-native skills in already-live Claude sessions without starting hidden provider processes, then refresh Hlid's installed-skill catalog and picker snapshot for review and optional import.",
	},
	{
		method: "GET",
		path: "/extensions/catalog?refresh=1",
		server: "api",
		desc: "Claude and Codex plugin inventory plus configured native marketplace snapshots across detected Windows and WSL provider homes. The server caches discovery for five seconds; refresh=1 invalidates that snapshot.",
	},
	{
		method: "GET",
		path: "/extensions/review?id=...",
		server: "api",
		desc: "Lazy read-only trust review for one opaque marketplace listing ID, using locally cached package files when available and clearly labeling metadata-only results.",
	},
	{
		method: "POST",
		path: "/extensions/mutate",
		server: "api",
		desc: "Install, update, enable or disable, or uninstall provider extensions; add, upgrade, or remove Claude or Codex marketplace sources. Body action is install, update, uninstall, set_enabled, add_marketplace, upgrade_marketplace, or remove_marketplace, with the required opaque environment IDs and review, version, enabled-state, or source guards.",
	},
	{
		method: "GET",
		path: "/skills/managed",
		server: "api",
		desc: "Agent skill packages currently managed by Hlid, including provenance and package summaries.",
	},
	{
		method: "GET",
		path: "/skills/managed/content?id=",
		server: "api",
		desc: "Read one Hlid-managed SKILL.md by opaque managed ID.",
	},
	{
		method: "POST",
		path: "/skills/discover",
		server: "api",
		desc: 'Discover SKILL.md packages from owner/repo, GitHub, or skills.sh sources before staging. Body: {"source": string}.',
	},
	{
		method: "POST",
		path: "/skills/stage",
		server: "api",
		desc: 'Download a GitHub skill into temporary review storage. Body: {"sourceUrl": string}.',
	},
	{
		method: "GET",
		path: "/skills/staged/content?id=&path=",
		server: "api",
		desc: "Read one text file from a staged skill before deciding whether to install it.",
	},
	{
		method: "POST",
		path: "/skills/install",
		server: "api",
		desc: 'Approve one staged skill and move it into Hlid-managed storage. Body: {"id": string}.',
	},
	{
		method: "POST",
		path: "/skills/discard",
		server: "api",
		desc: 'Decline one staged skill and delete its temporary review copy. Body: {"id": string}.',
	},
	{
		method: "GET",
		path: "/skills/content?id=",
		server: "api",
		desc: "Read one discovered SKILL.md by opaque catalog ID; source paths remain server-side.",
	},
	{
		method: "POST",
		path: "/skills/import",
		server: "api",
		desc: 'Copy selected provider- or configured-agent-discovered packages into the Hlid library. Body: {"ids": string[]} with 1 to 100 opaque IDs.',
	},
	{
		method: "POST",
		path: "/skills/remove",
		server: "api",
		desc: 'Remove one Hlid-managed skill by its opaque managed ID. Body: {"id": string}.',
	},
	{
		method: "GET",
		path: "/voice?refresh=1",
		server: "api",
		desc: "Local Whisper runtime status, cached model catalog, and observed Codex realtime backend readiness; ?refresh=1 refreshes the Whisper catalog.",
	},
	{
		method: "POST",
		path: "/voice/sync",
		server: "api",
		desc: "Apply the saved Whisper configuration and load or stop its runtime.",
	},
	{
		method: "POST",
		path: "/voice/download",
		server: "api",
		desc: 'Start a checksummed Whisper model download. Body: {"model": string}.',
	},
	{
		method: "POST",
		path: "/voice/download/cancel",
		server: "api",
		desc: "Cancel the active Whisper model download.",
	},
	{
		method: "DELETE",
		path: "/voice/model?model=",
		server: "api",
		desc: "Delete one installed Whisper model that is not loaded.",
	},
	{
		method: "GET",
		path: "/tts",
		server: "api",
		desc: "Local neural speech runtime status and model catalog.",
	},
	{
		method: "POST",
		path: "/tts/sync",
		server: "api",
		desc: "Apply the saved local neural speech configuration and load or stop its runtime.",
	},
	{
		method: "POST",
		path: "/tts/download",
		server: "api",
		desc: 'Start the checksummed runtime and model download. Body: {"model": string}.',
	},
	{
		method: "POST",
		path: "/tts/download/cancel",
		server: "api",
		desc: "Cancel the active local neural speech download.",
	},
	{
		method: "DELETE",
		path: "/tts/model?model=",
		server: "api",
		desc: "Delete one installed local neural speech model that is not loaded.",
	},
	// ── Codex app-server maintenance (api port) ───────────────────────────────
	{
		method: "GET",
		path: "/claude/warmup",
		server: "api",
		desc: "Latest cached Claude provider metadata: discovered commands/skills, agents, MCP status, and timings. Null before startup discovery completes.",
	},
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
		path: "/db/sessions?page=&size=&q=&agent=&model=&provider=&stop=&archived=&range=&from=&to=&sort=",
		server: "api",
		desc: 'Paginated active sessions by default; archived=1 or true lists archived sessions. Optional label search (q), owner (agent="vault" or an exact agent cwd), model, provider, stop reason, range (today|7d|30d|90d|all|custom), custom YYYY-MM-DD from/to dates, and sort (recent|cost|tokens). Page size is 1–100.',
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
		desc: "Most recent active, non-imported sessions, pinned first; limit is 1–100 (default 14).",
	},
	{
		method: "GET",
		path: "/db/session-messages?session_id=&before_seq=&before_id=&min_seq=&min_id=&limit=&tool_event_page_size=",
		server: "api",
		desc: "Message transcript enriched with assistant tool-event summaries and user attachments. Supports exclusive backward cursors with before_seq/before_id and inclusive forward refresh cursors with min_seq/min_id; row IDs disambiguate equal sequence values. Optional tool_event_page_size compacts eligible settled assistant tool histories; omitting it preserves the full legacy response.",
	},
	{
		method: "GET",
		path: "/db/session-context?session_id=&limit=&before_seq=",
		server: "api",
		desc: "Last-query context plus actual model and paginated Hlid context-receipt history for one session.",
	},
	{
		method: "GET",
		path: "/db/session-tool-event?session_id=&tool_id=",
		server: "api",
		desc: "Full persisted detail for one session-owned tool event; returns 404 when absent.",
	},
	{
		method: "GET",
		path: "/db/session-tool-events?session_id=&assistant_seq=&before_id=&limit=",
		server: "api",
		desc: "Exclusive backwards page of lightweight tool-event summaries for one assistant response, returned in ascending transcript order with total/error metadata.",
	},
	{
		method: "POST",
		path: "/db/session/fork",
		server: "api",
		desc: 'Create a provider-native exact fork from an idle source session. Body: {"id": string, "messageId"?: number}; omitting messageId forks the whole session, while messageId must identify an assistant row and requires through-message capability.',
	},
	{
		method: "PATCH",
		path: "/db/session?id=",
		server: "api",
		desc: 'Rename, pin or unpin, and archive or restore a session. Body: {"label": string}, {"pinned": boolean}, or {"archived": boolean}. Live labels and pins update immediately; running sessions cannot be archived.',
	},
	{
		method: "DELETE",
		path: "/db/session?id=",
		server: "api",
		desc: "Delete a non-running session. Removes session-retained ephemeral attachments and detaches retained or vault attachments; protected delegation lineages return a conflict.",
	},
	{
		method: "GET",
		path: "/db/sessions/cleanup/preview?older_than_days=",
		server: "api",
		desc: "Preview the exact current impact of age-based session cleanup, including sessions, messages, tool events, estimated database bytes, managed attachments and Relics, detached vault links, and preserved usage-query totals. Excludes live sessions and protected delegation lineages. Returns a short-lived, one-use preview_id required by the non-cataloged cleanup mutation, which rechecks the exact impact before deleting.",
	},
	{
		method: "GET",
		path: "/db/live-sessions",
		server: "api",
		desc: "Live provider and terminal sessions with provider, model, effort, permission, labels, pins, rich attention, fork and delegation provenance, and durable restart-interrupted child state.",
	},
	{
		method: "POST",
		path: "/db/live-sessions/stop",
		server: "api",
		desc: 'Abort a live session\'s in-flight work while keeping it in the pool. A child whose control remains owned by Hlid delegation returns a conflict. Body: {"session_id": string}.',
	},
	{
		method: "POST",
		path: "/db/live-sessions/close",
		server: "api",
		desc: 'Close and remove a live session (vault session refused). Closing a resumable restart-interrupted delegated child abandons that continuation as cancelled while retaining its Raven transcript and Ledger provenance. Body: {"session_id": string}.',
	},
	{
		method: "POST",
		path: "/hlid-agents/delegate",
		server: "api",
		desc: "Create a durable Raven child, bounded to depth three, four active direct children per parent, and twelve active delegated children across Hlid. Internal tool body includes parent_session_id, task, explicit provider, and optional model, effort, service_tier, exact configured cwd, narrower permission_mode, or explicit current-turn handoff switches. Hlid imposes no elapsed-time or inactivity cap because cross-provider silence is not proof of failure. New runs accept no timeout input and never transition automatically to timed_out. Provider availability is checked before launch; native launch, transport, or process failures settle naturally, and explicit cancellation stops work. Token and cost usage are recorded passively rather than accepted as lifecycle caps. Scheduled Routines may delegate only in their approved workspace after the call passes the Routine grant envelope and Umbod.",
	},
	{
		method: "GET",
		path: "/hlid-agents?parent_session_id=&limit=",
		server: "api",
		desc: "List direct parent-owned Hlid delegations and their bounded lifecycle snapshots.",
	},
	{
		method: "GET",
		path: "/hlid-agents/:id?parent_session_id=",
		server: "api",
		desc: "Inspect one parent-owned Hlid delegation, including bounded active progress and any bounded terminal result or partial result plus error.",
	},
	{
		method: "POST",
		path: "/hlid-agents/:id/wait",
		server: "api",
		desc: 'Wait up to 60 seconds for one parent-owned Hlid delegation, then return bounded active progress and any bounded terminal result or partial result plus error. Body: {"parent_session_id": string, "wait_seconds"?: number}.',
	},
	{
		method: "POST",
		path: "/hlid-agents/:id/steer",
		server: "api",
		desc: 'Use the active child provider\'s native same-turn steering primitive. Body: {"parent_session_id": string, "instruction": string}. No fresh-turn fallback.',
	},
	{
		method: "POST",
		path: "/hlid-agents/:id/cancel",
		server: "api",
		desc: 'Request cancellation of the addressed parent-owned delegation and all active nested descendants immediately. Hlid retains provider control, delegation ownership, and active capacity until each provider turn settles, then persists terminal cancelled state. A terminal ancestor remains terminal while active descendants stop. Body: {"parent_session_id": string}.',
	},
	{
		method: "POST",
		path: "/hlid-agents/:id/resume",
		server: "api",
		desc: "Start an explicit new turn in a restart-interrupted non-Routine child with a remaining attempt. Requires a live running parent turn, the recorded configured workspace, revalidated recorded provider/model/effort/service tier, inherited or narrower permissions, and active-capacity admission. Supplies bounded visible child transcript context without references or Relics. Body includes parent_session_id, required instruction, and optional permission_mode. Hlid imposes no elapsed-time or inactivity cap; native launch, transport, or process failures settle naturally, and explicit cancellation stops work. Token and cost usage remain passive observations.",
	},
	{
		method: "GET",
		path: "/db/attachments?kind=&category=&retention=&origin=&session_id=&search=&type=&since=&until=&sort=&dir=&limit=&offset=",
		server: "api",
		desc: "Paginated safe attachment metadata with total count and bytes. Filters: kind (ephemeral|vault), category (upload|plan|report|media|visualization|other), retention (session|retained|linked), origin (upload|generated|imported|vault|legacy), session ID, filename search, MIME class (image|pdf|text|other), and inclusive Unix-second since/until. Sort by created_at|size_bytes with asc|desc; limit is 1–500 (default 100) plus offset. Filesystem paths, storage keys, hashes, and agent workspace paths are omitted.",
	},
	{
		method: "POST",
		path: "/db/provider-history/import",
		server: "api",
		desc: "Start an asynchronous Claude and Codex provider-history import with a checked SQLite backup; returns the current or new job with status 202.",
	},
	{
		method: "GET",
		path: "/db/provider-history/import/status?job_id=",
		server: "api",
		desc: "Inspect the current provider-history import job, or one matching job_id; reports idle, running, completed, or failed state.",
	},
	// ── Usage & stats (api port) ──────────────────────────────────────────────
	{
		method: "GET",
		path: "/db/stats",
		server: "api",
		desc: "All-time, today, and this-month aggregate usage totals plus ten recent active sessions.",
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
		desc: "Local-week query counts by weekday, Sunday through Saturday.",
	},
	{
		method: "GET",
		path: "/db/thirty-day-stats",
		server: "api",
		desc: "Daily query counts for the last 30 local-calendar days.",
	},
	{
		method: "GET",
		path: "/db/activity",
		server: "api",
		desc: "Aggregate top tools, hour-of-day activity, latency, model split, and stop-reason split.",
	},
	{
		method: "GET",
		path: "/db/ledger-analytics?range=&agent=&provider=&model=&from=&to=",
		server: "api",
		desc: "Filterable Ledger usage overview, daily trend, top tools, time heatmaps, model and stop-reason breakdowns, and filter facets. Range is today|7d|30d|90d|all|custom (default 30d); custom requires YYYY-MM-DD from and to dates.",
	},
	{
		method: "GET",
		path: "/db/storage",
		server: "api",
		desc: "Database, WAL, reclaimable, tracked attachment, Hlid library, session, message, and usage-query storage totals.",
	},
	{
		method: "POST",
		path: "/db/storage/optimize",
		server: "api",
		desc: "Run a passive WAL checkpoint and SQLite optimize, then return refreshed storage totals.",
	},
	// ── Logs (api port) ───────────────────────────────────────────────────────
	{
		method: "GET",
		path: "/db/logs?page=&size=&level=",
		server: "api",
		desc: "Paginated server log entries with filtered total and all-level counts; size is 1–200 (default 50) and level is all|error|warn|info (default all). Console output is redirected here in the compiled executable.",
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
		desc: "Return the persisted Hlid-release and provider-CLI update snapshot immediately and refresh stale discovery in the background. Use POST action check for a forced blocking refresh.",
	},
	{
		method: "POST",
		path: "/api/updates",
		server: "ui",
		desc: 'Body: {"action": "check"|"download"|"apply"}, or {"action": "prepare_cli"|"apply_cli", "id": string}. CLI actions are restricted to local or authenticated Tailscale requests.',
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
		desc: "Read the validated public Hlid config projection. Existing CLIProxy credentials and ACP environment values are replaced with the __HLID_SECRET_SET__ sentinel.",
	},
	{
		method: "POST",
		path: "/api/config",
		server: "ui",
		desc: "Validate and replace the complete Hlid config, not a partial patch. Secret sentinels preserve existing CLIProxy and ACP environment values; voice, CLIProxy, and changed ACP runtimes synchronize immediately, while other changes may require a session reload or restart.",
	},
	{
		method: "GET",
		path: "/api/pricing",
		server: "ui",
		desc: "Read the merged built-in and local effective-dated pricing catalog.",
	},
	{
		method: "POST",
		path: "/api/pricing",
		server: "ui",
		desc: 'Validate and write pricing-overrides.toml. Body: {"text": string}.',
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
		method: "POST",
		path: "/api/agents",
		server: "ui",
		desc: "Validate and replace the complete registered-agent list. Body: AgentSchema[].",
	},
	{
		method: "GET",
		path: "/api/agents/validate?path=",
		server: "ui",
		desc: "Inspect a candidate agent path: existence, instruction file, suggested name, vault containment, external-agent policy, and resolved path.",
	},
	{
		method: "GET",
		path: "/api/agents/claudemd?path=",
		server: "ui",
		desc: "Read AGENTS.md, falling back to CLAUDE.md, for an exact registered agent path.",
	},
	{
		method: "GET",
		path: "/api/mcp/vault",
		server: "ui",
		desc: "MCP servers configured for the vault session.",
	},
	{
		method: "POST",
		path: "/api/mcp/vault",
		server: "ui",
		desc: 'Write the vault MCP server map. Body: {"servers": object}.',
	},
	{
		method: "POST",
		path: "/api/mcp/vault/toggle",
		server: "ui",
		desc: 'Enable or disable one vault MCP server. Body: {"name": string, "disabled": boolean}.',
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
	{
		method: "POST",
		path: "/api/mcp/agent/toggle",
		server: "ui",
		desc: 'Enable or disable one registered agent MCP server. Body: {"agentPath": string, "name": string, "disabled": boolean}.',
	},
];

function endpointTags(path: string): string[] {
	const pathname = path.split("?", 1)[0];
	const tags = pathname
		.split("/")
		.filter(Boolean)
		.filter((segment) => segment !== "api" && segment !== "db")
		.map((segment) => segment.replace(/[^a-zA-Z0-9_-]/g, ""))
		.filter(Boolean);
	return [...new Set(tags)].slice(0, 6);
}

function endpointSafety(
	endpoint: Pick<ApiEndpoint, "method" | "path">,
): NonNullable<ApiEndpoint["safety"]> {
	if (endpoint.method === "GET") return "observational";
	if (
		endpoint.method === "DELETE" ||
		/cleanup|reclaim|reset|uninstall/.test(endpoint.path)
	) {
		return "destructive";
	}
	return "mutating";
}

for (const endpoint of API_ENDPOINTS) {
	const pathname = endpoint.path.split("?", 1)[0];
	endpoint.id = `${endpoint.method.toLowerCase()}:${pathname}`;
	endpoint.tags = endpointTags(endpoint.path);
	endpoint.safety = endpointSafety(endpoint);
	endpoint.agent_access =
		/^\/(?:db\/(?:sessions|session|attachments|ledger|storage|logs)|api\/project-previews|hlid-agents|routines)/.test(
			pathname,
		)
			? "typed-tool-preferred"
			: "direct-auth-required";
}

/** Response body for GET /api-index. */
export function buildApiIndex(apiPort: number, uiPort: number): HlidApiIndex {
	return {
		description:
			'Curated Hlid HTTP API for programmatic and agent use. "api" endpoints use api_port and "ui" endpoints use ui_port. Loopback and Tailscale peers are allowed; RFC1918 LAN peers additionally require local_network_access. Except public authentication and health routes, requests require an authenticated session or a loopback internal token. Non-GET/HEAD requests must omit Origin or send an allowed Origin.',
		api_port: apiPort,
		ui_port: uiPort,
		endpoints: API_ENDPOINTS,
	};
}
