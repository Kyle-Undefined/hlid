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
	MessageRow,
	PermissionEventRow,
	SessionRow,
	ThirtyDayStats,
	ToolEventRow,
	UsageWindows,
	WeeklyStats,
} from "#/db";
import { dbFetch, dbJson } from "#/lib/dbClient";
import type { McpServerEntry } from "#/lib/mcp";
import { mapMcpServer } from "#/lib/mcp";

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

/** Write a client-side error to the server event log. Fire-and-forget from ErrorBoundary. */
export const logClientErrorFn = createServerFn({ method: "POST" })
	.inputValidator((raw) => logClientErrorSchema.parse(raw))
	.handler(async ({ data }) => {
		const { appendLog } = await import("#/db");
		await appendLog("error", "ui", data.message, {
			componentStack: data.componentStack,
		});
	});

export type AgentListItem = {
	path: string;
	name: string;
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
			}),
		);
	},
);

/** Returns current usage windows (5hr / weekly rate-limit data). */
export const getUsageWindowsFn = createServerFn({ method: "GET" }).handler(() =>
	dbJson<UsageWindows | null>("/db/usage-windows", null),
);

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

// ─── Session-specific fns (used by /raven) ───────────────────────────────────

export type EnrichedMessageRow = MessageRow & {
	toolEvents?: ToolEventRow[];
	attachments?: AttachmentRow[];
};

export const getSessionDataFn = createServerFn({ method: "GET" })
	.inputValidator((raw) =>
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
	.inputValidator((sessionId: string) => sessionId)
	.handler(async ({ data: sessionId }) => {
		try {
			const { getSessionAgentCwd } = await import("#/db");
			return await getSessionAgentCwd(sessionId);
		} catch {
			return null as string | null;
		}
	});

export const getSessionPermissionsFn = createServerFn({ method: "GET" })
	.inputValidator((sessionId: string) => sessionId)
	.handler(({ data: sessionId }) =>
		dbJson<PermissionEventRow[]>(
			`/db/session-permissions?session_id=${encodeURIComponent(sessionId)}`,
			[],
		),
	);

export const getSessionContextFn = createServerFn({ method: "GET" })
	.inputValidator((sessionId: string) => sessionId)
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

export const EMPTY_AGG: AggStats = {
	allTime: {
		cost: 0,
		queries: 0,
		input_tokens: 0,
		output_tokens: 0,
		cache_read_tokens: 0,
		cache_creation_tokens: 0,
		turns: 0,
	},
	today: { cost: 0, queries: 0, tokens: 0 },
	thisMonth: { cost: 0, queries: 0, tokens: 0 },
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
		const { skills: rawClaudeSkills } = scanSkills(claudeSkillsDir, "", false);
		const claudeSkills = rawClaudeSkills.map((s) => ({
			...s,
			section: "claude",
		}));

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
