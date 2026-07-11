/**
 * Shared createServerFn definitions reused across multiple routes.
 * Co-locating here avoids identical implementations in each route file.
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getConfig } from "#/config";
import type {
	AggStats,
	AttachmentRow,
	HourOfDayBucket,
	LatencyDistribution,
	MessageRow,
	ModelSplitEntry,
	PermissionEventRow,
	ProviderUsageSnapshot,
	SessionRow,
	StopReasonEntry,
	ThirtyDayStats,
	ToolEventRow,
	TopToolCall,
	WeeklyStats,
} from "#/db";
import { dbFetch, dbJson, requireDbOk } from "#/lib/dbClient";
import type { McpServerEntry } from "#/lib/mcp";
import { mapMcpServer } from "#/lib/mcp";
import { sessionIdSchema, terminalSessionSchema } from "#/lib/serverFnSchemas";
import type { SessionStatusEntry } from "#/server/protocol";
import type { VoiceModelInfo, VoiceStatus } from "#/server/voice";

const logClientErrorSchema = z.object({
	message: z
		.string()
		.min(1)
		.transform((s) => s.slice(0, 10_000)),
	componentStack: z
		.string()
		.transform((s) => s.slice(0, 50_000))
		.optional(),
});

const optionalRefreshSchema = z
	.object({ refresh: z.boolean().optional() })
	.optional();
const parseOptionalRefresh = (raw: unknown) => optionalRefreshSchema.parse(raw);
const parseModelName = (raw: string) => z.string().min(1).parse(raw);

/** Write a client-side error to the server event log. Fire-and-forget from ErrorBoundary. */
export const logClientErrorFn = createServerFn({ method: "POST" })
	.validator((raw) => logClientErrorSchema.parse(raw))
	.handler(async ({ data }) => {
		const { appendLog } = await import("#/db");
		await appendLog("error", "ui", data.message, {
			componentStack: data.componentStack,
		});
	});

export type ProviderInfo = {
	id: string;
	label: string;
	available: boolean;
	unavailableReason?: string;
	/**
	 * Models the provider supports. Use to populate model picker in UI.
	 * Strict superset of the original `{value,label}` shape — additive fields
	 * (`description`/`isDefault`/`hidden`/`efforts`) come from the live model
	 * catalog (see ProviderModelInfo in server/agentProvider.ts) when available.
	 */
	models?: Array<{
		value: string;
		label: string;
		description?: string;
		isDefault?: boolean;
		hidden?: boolean;
		efforts?: Array<{
			value: string;
			label: string;
			desc?: string;
			isDefault?: boolean;
		}>;
	}>;
	/** Effort/thinking levels. Absent if the provider has no such concept. */
	effortLevels?: Array<{ value: string; label: string; desc?: string }>;
	/** Permission gate modes the provider honours. */
	permissionModes?: Array<{ value: string; label: string; desc?: string }>;
};

/** Returns the list of compiled-in providers with availability status. */
export const getProvidersFn = createServerFn({ method: "GET" })
	.validator(parseOptionalRefresh)
	.handler(({ data }) =>
		dbJson<{ providers: ProviderInfo[] }>(
			`/providers${data?.refresh ? "?refresh=1" : ""}`,
			{ providers: [] },
		).then((response) => response.providers),
	);

export type AcpCatalogItem = {
	id: string;
	name: string;
	version: string;
	description: string;
	providerId: string;
	enabled: boolean;
	available: boolean;
	unavailableReason?: string;
	command: string;
	args: string[];
	env: Record<string, string>;
	installGuidance: string;
	repository?: string;
	website?: string;
};

export type AcpAuthMethod = {
	id: string;
	name: string;
	type?: "env_var" | "terminal";
	description?: string | null;
	link?: string | null;
	args?: string[];
	vars?: Array<{ name: string; label?: string | null; secret?: boolean }>;
};

export const getAcpRegistryFn = createServerFn({ method: "GET" })
	.validator(parseOptionalRefresh)
	.handler(({ data }) =>
		dbJson<{ agents: AcpCatalogItem[] }>(
			`/acp/registry${data?.refresh ? "?refresh=1" : ""}`,
			{ agents: [] },
		).then((response) => response.agents),
	);

export const authenticateAcpFn = createServerFn({ method: "POST" })
	.validator((raw) =>
		z
			.object({ id: z.string().min(1), methodId: z.string().optional() })
			.parse(raw),
	)
	.handler(async ({ data }) => {
		const response = await dbFetch("/acp/authenticate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(data),
		});
		await requireDbOk(response, "inspect ACP authentication");
		return (await response.json()) as { authMethods: AcpAuthMethod[] };
	});

export type VoiceInfo = { status: VoiceStatus; models: VoiceModelInfo[] };

export const getVoiceInfoFn = createServerFn({ method: "GET" })
	.validator(parseOptionalRefresh)
	.handler(({ data }) =>
		dbJson<VoiceInfo>(`/voice${data?.refresh ? "?refresh=1" : ""}`, {
			status: {
				state: "unavailable",
				model: "",
				error: "voice service unavailable",
			},
			models: [],
		}),
	);

export const startVoiceDownloadFn = createServerFn({ method: "POST" })
	.validator(parseModelName)
	.handler(async ({ data }) => {
		await requireDbOk(
			await dbFetch("/voice/download", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: data }),
			}),
			"start voice model download",
		);
		return { ok: true };
	});

export const cancelVoiceDownloadFn = createServerFn({ method: "POST" }).handler(
	async () => {
		await requireDbOk(
			await dbFetch("/voice/download/cancel", { method: "POST" }),
			"cancel voice model download",
		);
		return { ok: true };
	},
);

export const deleteVoiceModelFn = createServerFn({ method: "POST" })
	.validator(parseModelName)
	.handler(async ({ data }) => {
		await requireDbOk(
			await dbFetch(`/voice/model?model=${encodeURIComponent(data)}`, {
				method: "DELETE",
			}),
			"delete voice model",
		);
		return { ok: true };
	});

export type AgentListItem = {
	path: string;
	name: string;
	model?: string;
	/** Provider this agent runs on, e.g. "claude" or "codex". Defaults to "claude". */
	provider: string;
};

/** Resolves the list of configured agents with display names. */
export const getAgentListFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const config = await getConfig();
		return (config.agents ?? []).map(
			(a): AgentListItem => ({
				path: a.path,
				name:
					a.name ??
					basename(a.path, extname(a.path))
						.split(/[-_\s]+/)
						.map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
						.join(" "),
				...(a.model ? { model: a.model } : {}),
				provider: a.provider ?? "claude",
			}),
		);
	},
);

/** Account info for the authenticated agent backing a live claude session. */
export type AccountInfo = {
	email?: string;
	organization?: string;
	subscriptionType?: string;
};

/**
 * Returns account info (email/org/subscription) for the first live session
 * whose provider exposes it, or null if none is running. Never spawns a
 * session — see GET /account in server/index.ts.
 */
export const getAccountInfoFn = createServerFn({ method: "GET" }).handler(() =>
	dbJson<AccountInfo | null>("/account", null),
);

/** Returns provider-aware usage snapshots for the given provider IDs. */
export const getProviderUsagesFn = createServerFn({ method: "GET" })
	.validator((raw) => {
		const ids = Array.isArray(raw) ? (raw as string[]) : ["claude"];
		return ids.filter((id): id is string => typeof id === "string");
	})
	.handler((ctx) => {
		const providers = ctx.data.join(",");
		return dbJson<ProviderUsageSnapshot[]>(
			`/db/provider-usage?providers=${encodeURIComponent(providers)}`,
			[],
		);
	});

function providerUsageIds(providers: ProviderInfo[]): string[] {
	const ids = providers.map((provider) => provider.id);
	return ids.length > 0 ? ids : ["claude"];
}

export function loadProviderUsages(providers?: ProviderInfo[]) {
	if (providers) {
		return getProviderUsagesFn({ data: providerUsageIds(providers) });
	}
	return getProvidersFn().then((loaded) =>
		getProviderUsagesFn({ data: providerUsageIds(loaded) }),
	);
}

/** Returns the session_id of the currently active/last session, or null. */
export const getCurrentSessionFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const data = await dbJson<{ session_id: string | null } | null>(
			"/db/current-session",
			null,
		);
		return data?.session_id ?? null;
	},
);

/**
 * Returns the SessionRow for the currently active session (from server memory),
 * falling back to the most recent session in the DB if no session is active.
 * Uses a single round-trip to the data API instead of 2-3 sequential requests.
 */
export const getActiveSessionRowFn = createServerFn({
	method: "GET",
}).handler(() => dbJson<SessionRow | null>("/db/active-session", null));

export const getLiveSessionsFn = createServerFn({ method: "GET" }).handler(() =>
	dbJson<SessionStatusEntry[]>("/db/live-sessions", []),
);

export type StorageStats = import("#/db").StorageStats;

const EMPTY_STORAGE_STATS: StorageStats = {
	databaseBytes: 0,
	walBytes: 0,
	reclaimableBytes: 0,
	trackedAttachmentBytes: 0,
	trackedAttachments: 0,
	sessions: 0,
	messages: 0,
	usageQueries: 0,
};

export const getStorageStatsFn = createServerFn({ method: "GET" }).handler(() =>
	dbJson<StorageStats>("/db/storage", EMPTY_STORAGE_STATS),
);

export const optimizeStorageFn = createServerFn({ method: "POST" }).handler(
	async () => {
		const response = await dbFetch("/db/storage/optimize", { method: "POST" });
		await requireDbOk(response, "Optimize storage");
		return (await response.json()) as StorageStats;
	},
);

// ─── Session-specific fns (used by /raven) ───────────────────────────────────

type EnrichedMessageRow = MessageRow & {
	toolEvents?: ToolEventRow[];
	attachments?: AttachmentRow[];
};

export const getSessionDataFn = createServerFn({ method: "GET" })
	.validator((raw) =>
		z
			.string()
			.refine((s) => s.trim().length > 0, "sessionId must be non-empty")
			.parse(raw),
	)
	.handler(({ data: sessionId }) =>
		dbJson<EnrichedMessageRow[]>(
			`/db/session-messages?session_id=${encodeURIComponent(sessionId)}`,
			[],
		),
	);

export const getSessionAgentCwdFn = createServerFn({ method: "GET" })
	.validator((raw) => sessionIdSchema.parse(raw))
	.handler(async ({ data: sessionId }) => {
		const { getSessionAgentCwd } = await import("#/db");
		return getSessionAgentCwd(sessionId);
	});

export const getSessionPermissionsFn = createServerFn({ method: "GET" })
	.validator((raw) => sessionIdSchema.parse(raw))
	.handler(({ data: sessionId }) =>
		dbJson<PermissionEventRow[]>(
			`/db/session-permissions?session_id=${encodeURIComponent(sessionId)}`,
			[],
		),
	);

const getSessionRows = <T>(path: string, sessionId: string) =>
	dbJson<T[]>(`${path}?session_id=${encodeURIComponent(sessionId)}`, []);

type SessionPlanProposalRow = {
	proposal_id: string;
	seq: number;
	plan: string;
	decision: string;
	html_attachment_id: string | null;
	timestamp: number;
};

export const getSessionPlanProposalsFn = createServerFn({ method: "GET" })
	.validator((raw) => sessionIdSchema.parse(raw))
	.handler(({ data: sessionId }) =>
		getSessionRows<SessionPlanProposalRow>(
			"/db/session-plan-proposals",
			sessionId,
		),
	);

type SessionAskUserQuestionRow = {
	request_id: string;
	seq: number;
	questions_json: string;
	answers_json: string | null;
	notes_json: string | null;
	timestamp: number;
};

export const getSessionAskUserQuestionsFn = createServerFn({ method: "GET" })
	.validator((raw) => sessionIdSchema.parse(raw))
	.handler(({ data: sessionId }) =>
		getSessionRows<SessionAskUserQuestionRow>(
			"/db/session-ask-user-questions",
			sessionId,
		),
	);

export const getSessionContextFn = createServerFn({ method: "GET" })
	.validator((raw) => sessionIdSchema.parse(raw))
	.handler(({ data: sessionId }) =>
		dbJson<{
			context_window: number | null;
			last_context_used: number | null;
			actual_model: string | null;
		} | null>(
			`/db/session-context?session_id=${encodeURIComponent(sessionId)}`,
			null,
		),
	);

// ─── Cockpit fns ─────────────────────────────────────────────────────────────

const EMPTY_AGG_WINDOW = {
	cost: 0,
	queries: 0,
	turns: 0,
	tokens: 0,
	input_tokens: 0,
	output_tokens: 0,
	cache_read_tokens: 0,
	cache_creation_tokens: 0,
};

export const EMPTY_AGG: AggStats = {
	allTime: {
		cost: 0,
		queries: 0,
		sessions: 0,
		input_tokens: 0,
		output_tokens: 0,
		cache_read_tokens: 0,
		cache_creation_tokens: 0,
		turns: 0,
	},
	today: { ...EMPTY_AGG_WINDOW },
	thisMonth: { ...EMPTY_AGG_WINDOW },
};

export const getCockpitData = createServerFn({ method: "GET" }).handler(
	async () => {
		const { scanProjects, scanSkills } = await import("#/lib/vault");
		const config = await getConfig();
		const { vault, status_vocabulary } = config;

		let inboxCount = 0;
		if (vault.path && vault.inbox) {
			try {
				inboxCount = readdirSync(join(vault.path, vault.inbox)).filter((f) =>
					f.endsWith(".md"),
				).length;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
					console.warn("Failed to read inbox directory:", err);
				}
			}
		}

		let activeCount = 0;
		let totalCount = 0;
		if (vault.path && vault.projects) {
			const projects = scanProjects(
				vault.path,
				vault.projects,
				status_vocabulary,
			);
			totalCount = projects.length;
			activeCount = projects.filter((p) => p.status === "active").length;
		}

		const { skills: vaultSkills, sectionOrder } =
			vault.path && vault.skills
				? scanSkills(vault.path, vault.skills, config.ui.hide_skills_index)
				: { skills: [], sectionOrder: [] };

		const claudeSkillsDir = resolve(homedir(), ".claude", "skills");
		const { skills: rawClaudeSkills } = scanSkills(claudeSkillsDir, ".", false);

		// Deduplicate: skip claude skills whose name already appears in vault skills.
		// This prevents doubles when the vault skills path overlaps ~/.claude/skills/.
		const vaultSkillNames = new Set(
			vaultSkills.map((s) => s.name.toLowerCase()),
		);
		const claudeSkills = rawClaudeSkills
			.filter((s) => !vaultSkillNames.has(s.name.toLowerCase()))
			.map((s) => ({ ...s, section: "claude" }));

		const skills = [...vaultSkills, ...claudeSkills];
		const allSectionOrder =
			claudeSkills.length > 0 ? [...sectionOrder, "claude"] : sectionOrder;

		return {
			inboxCount,
			activeCount,
			totalCount,
			skills,
			sectionOrder: allSectionOrder,
		};
	},
);

export const getRecentSessionsFn = createServerFn({ method: "GET" }).handler(
	() => dbJson<SessionRow[]>("/db/recent-sessions?limit=5", []),
);

export const getCockpitStatsFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const data = await dbJson<{
			agg: AggStats;
			sessions: SessionRow[];
		} | null>("/db/stats", null);
		return { agg: data?.agg ?? EMPTY_AGG };
	},
);

export const getWeeklyStatsFn = createServerFn({ method: "GET" }).handler(() =>
	dbJson<WeeklyStats>("/db/weekly-stats", {
		total: 0,
		days: [0, 0, 0, 0, 0, 0, 0],
	}),
);

export const getThirtyDayStatsFn = createServerFn({
	method: "GET",
}).handler(() =>
	dbJson<ThirtyDayStats>("/db/thirty-day-stats", { days: [], total: 0 }),
);

// ─── Activity (charts) ───────────────────────────────────────────────────────

export type ActivityStats = {
	topTools: TopToolCall[];
	hourOfDay: HourOfDayBucket[];
	latency: LatencyDistribution;
	modelSplit: ModelSplitEntry[];
	stopReasonSplit: StopReasonEntry[];
};

const EMPTY_LATENCY_BUCKETS = [
	{ label: "<100", count: 0 },
	{ label: "100-500", count: 0 },
	{ label: "500-1k", count: 0 },
	{ label: "1-5k", count: 0 },
	{ label: "5-15k", count: 0 },
	{ label: "15-60k", count: 0 },
	{ label: "60k+", count: 0 },
];

const EMPTY_ACTIVITY: ActivityStats = {
	topTools: [],
	hourOfDay: Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 })),
	latency: { buckets: EMPTY_LATENCY_BUCKETS, p50: 0, p95: 0, total: 0 },
	modelSplit: [],
	stopReasonSplit: [],
};

export const getActivityStatsFn = createServerFn({ method: "GET" }).handler(
	() => dbJson<ActivityStats>("/db/activity", EMPTY_ACTIVITY),
);

export const getToolErrorsFn = createServerFn({ method: "GET" })
	.validator((raw) => z.string().min(1).parse(raw))
	.handler(async ({ data: toolName }) => {
		const { getToolErrors } = await import("#/db");
		return getToolErrors(toolName, 10);
	});

export const getMcpServersFn = createServerFn({ method: "GET" }).handler(
	async () => {
		// Try live status from the WS server (populated after any session runs)
		try {
			const res = await dbFetch("/mcp-status");
			if (res.ok) {
				const servers = (await res.json()) as Array<{
					name: string;
					status: string;
					scope?: string;
					error?: string;
				}>;
				if (servers.length > 0) {
					return servers.map(mapMcpServer);
				}
			}
		} catch {
			// Server not running yet; fall through to static file read
		}

		// Fallback: read static config files (no live status available)
		const config = await getConfig();

		type McpServersMap = Record<string, unknown>;

		function parseMcpServers(filePath: string): string[] {
			try {
				const content = readFileSync(filePath, "utf8");
				const parsed = JSON.parse(content) as {
					mcpServers?: McpServersMap;
				};
				return Object.keys(parsed.mcpServers ?? {});
			} catch {
				return [];
			}
		}

		const globalPath = join(homedir(), ".claude", "settings.json");
		const globalServers = parseMcpServers(globalPath);

		const vaultServers: string[] = [];
		if (config.vault.path) {
			const vaultMcpPath = join(config.vault.path, ".mcp.json");
			vaultServers.push(...parseMcpServers(vaultMcpPath));
		}

		const seen = new Set<string>();
		const result: McpServerEntry[] = [];
		for (const name of vaultServers) {
			seen.add(name);
			result.push({
				name,
				displayName: name,
				source: "vault",
				status: "unknown",
			});
		}
		for (const name of globalServers) {
			if (!seen.has(name)) {
				result.push({
					name,
					displayName: name,
					source: "global",
					status: "unknown",
				});
			}
		}
		return result;
	},
);

// ─── Terminal mode fns ────────────────────────────────────────────────────────

/**
 * Ensure a DB session row exists for the given session ID.
 * Terminal sessions don't write messages/tool_events but do need a row so
 * the Ledger shows an entry and resume works when switching back to custom UI.
 */
export const ensureSessionFn = createServerFn({ method: "POST" })
	.validator((raw) => terminalSessionSchema.parse(raw))
	.handler(async ({ data: { id, label, model } }) => {
		const { createSession } = await import("#/db");
		await createSession(id, label, model);
	});
