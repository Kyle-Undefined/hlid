import { getDb } from "./schema";
import type {
	AggStats,
	ProviderUsageSnapshot,
	ProviderWindowEntry,
	ThirtyDayStats,
	UsageWindows,
	WeeklyStats,
} from "./types";

export async function getAggregatedStats(): Promise<AggStats> {
	const db = await getDb();

	type AllTimeRow = {
		cost: number;
		queries: number;
		input_tokens: number;
		output_tokens: number;
		cache_read_tokens: number;
		cache_creation_tokens: number;
		turns: number;
	};
	type WindowRow = {
		cost: number;
		queries: number;
		turns: number;
		tokens: number;
		input_tokens: number;
		output_tokens: number;
		cache_read_tokens: number;
		cache_creation_tokens: number;
	};

	const EMPTY_ALLTIME: AllTimeRow = {
		cost: 0,
		queries: 0,
		input_tokens: 0,
		output_tokens: 0,
		cache_read_tokens: 0,
		cache_creation_tokens: 0,
		turns: 0,
	};
	const EMPTY_WINDOW: WindowRow = {
		cost: 0,
		queries: 0,
		turns: 0,
		tokens: 0,
		input_tokens: 0,
		output_tokens: 0,
		cache_read_tokens: 0,
		cache_creation_tokens: 0,
	};

	const allTime =
		db
			.query<AllTimeRow, []>(`
    SELECT
      COALESCE(SUM(cost), 0) as cost,
      COALESCE(SUM(queries), 0) as queries,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
      COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens,
      COALESCE(SUM(turns), 0) as turns
    FROM usage_daily
  `)
			.get() ?? EMPTY_ALLTIME;

	const sessionCount =
		db.query<{ n: number }, []>(`SELECT COUNT(*) as n FROM sessions`).get()
			?.n ?? 0;

	const today =
		db
			.query<WindowRow, []>(`
    SELECT
      COALESCE(SUM(cost), 0) as cost,
      COALESCE(SUM(queries), 0) as queries,
      COALESCE(SUM(turns), 0) as turns,
      COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) as tokens,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
      COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens
    FROM usage_daily
    WHERE date = DATE('now', 'localtime')
  `)
			.get() ?? EMPTY_WINDOW;

	const thisMonth =
		db
			.query<WindowRow, []>(`
    SELECT
      COALESCE(SUM(cost), 0) as cost,
      COALESCE(SUM(queries), 0) as queries,
      COALESCE(SUM(turns), 0) as turns,
      COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) as tokens,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
      COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens
    FROM usage_daily
    WHERE date >= DATE('now', 'localtime', 'start of month')
  `)
			.get() ?? EMPTY_WINDOW;

	return { allTime: { ...allTime, sessions: sessionCount }, today, thisMonth };
}

export async function getUsageWindows(): Promise<UsageWindows> {
	const db = await getDb();

	type WindowRow = {
		tokens: number;
		sessions: number;
		queries: number;
		cost: number;
	};
	const EMPTY: WindowRow = { tokens: 0, sessions: 0, queries: 0, cost: 0 };

	const fiveHourRow =
		db
			.query<WindowRow, []>(`
      SELECT
        COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) as tokens,
        COUNT(DISTINCT session_id) as sessions,
        COUNT(*) as queries,
        COALESCE(SUM(cost), 0) as cost
      FROM usage_queries
      WHERE timestamp >= strftime('%s', 'now', '-5 hours')
    `)
			.get() ?? EMPTY;

	const weeklyRow =
		db
			.query<WindowRow, []>(`
      SELECT
        COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) as tokens,
        COUNT(DISTINCT session_id) as sessions,
        COUNT(*) as queries,
        COALESCE(SUM(cost), 0) as cost
      FROM usage_queries
      WHERE timestamp >= strftime('%s', 'now', '-7 days')
    `)
			.get() ?? EMPTY;

	type SettingsRow = { value: string };
	type RlState = {
		utilization: number | null;
		resetsAt: number | null;
		rateLimitType: string | null;
	};
	const NULL_RL: RlState = {
		utilization: null,
		resetsAt: null,
		rateLimitType: null,
	};

	const parseRl = (row: SettingsRow | null): RlState => {
		if (!row) return NULL_RL;
		try {
			const parsed = JSON.parse(row.value) as unknown;
			if (typeof parsed !== "object" || parsed === null) return NULL_RL;
			const obj = parsed as Record<string, unknown>;
			const resetsAt =
				typeof obj.resetsAt === "number"
					? obj.resetsAt
					: typeof obj.resetsAt === "string"
						? Number(obj.resetsAt)
						: null;
			if (resetsAt != null && resetsAt < Date.now() / 1000) return NULL_RL;
			return {
				utilization:
					typeof obj.utilization === "number" ? obj.utilization : null,
				resetsAt,
				rateLimitType:
					typeof obj.rateLimitType === "string" ? obj.rateLimitType : null,
			};
		} catch {
			return NULL_RL;
		}
	};

	const rl5hr = db
		.query<SettingsRow, [string]>(`SELECT value FROM settings WHERE key = ?`)
		.get("rl_5hr");
	const rlWeekly = db
		.query<SettingsRow, [string]>(`SELECT value FROM settings WHERE key = ?`)
		.get("rl_weekly");
	const rlWeeklySonnet = db
		.query<SettingsRow, [string]>(`SELECT value FROM settings WHERE key = ?`)
		.get("rl_weekly_sonnet");

	const sonnetRl = parseRl(rlWeeklySonnet);
	return {
		fiveHour: { ...fiveHourRow, ...parseRl(rl5hr) },
		weekly: { ...weeklyRow, ...parseRl(rlWeekly) },
		weeklySonnet:
			sonnetRl.utilization !== null
				? { utilization: sonnetRl.utilization, resetsAt: sonnetRl.resetsAt }
				: null,
	};
}

/** A single rolling time-window definition for a provider. */
export type ProviderWindowDef = {
	windowId: string;
	label: string;
	windowSecs: number;
};

/**
 * Window definitions per provider — mutable so new providers (e.g. Codex,
 * Gemini) can register their own windows at server init without editing this
 * file. Keyed by providerId.
 */
const providerWindows = new Map<string, ProviderWindowDef[]>([
	[
		"claude",
		[
			{ windowId: "five_hour", label: "5-HOUR", windowSecs: 5 * 3600 },
			{ windowId: "weekly", label: "7-DAY", windowSecs: 7 * 86400 },
			{ windowId: "weekly_sonnet", label: "SONNET", windowSecs: 7 * 86400 },
		],
	],
]);

/** Human-readable label shown in the provider tab selector. */
const providerLabels = new Map<string, string>([
	["claude", "Claude"],
	["openai", "OpenAI"],
	["gemini", "Gemini"],
]);

/**
 * Register a new provider's window definitions and display label.
 * Call this at server startup for each non-Claude provider before any
 * getProviderUsage() calls. Safe to call multiple times (last write wins).
 *
 * @example
 * registerProvider("openai", "OpenAI", [
 *   { windowId: "hourly", label: "1-HOUR", windowSecs: 3600 },
 * ]);
 */
export function registerProvider(
	id: string,
	label: string,
	windows: ProviderWindowDef[],
): void {
	providerLabels.set(id, label);
	providerWindows.set(id, windows);
}

/**
 * Returns a ProviderUsageSnapshot for the given provider, reading DB query rows
 * (for counts/cost) and settings keys (for utilization/remaining from headers).
 */
export async function getProviderUsage(
	providerId: string,
): Promise<ProviderUsageSnapshot> {
	const db = await getDb();

	const windowDefs = providerWindows.get(providerId) ?? [];

	type WindowRow = {
		tokens: number;
		sessions: number;
		queries: number;
		cost: number;
	};
	const EMPTY_ROW: WindowRow = { tokens: 0, sessions: 0, queries: 0, cost: 0 };

	type SettingsRow = { value: string };
	type StoredRl = {
		utilization?: number | null;
		remaining?: number | null;
		limit?: number | null;
		resetsAt?: number | null;
	};

	function parseStoredRl(row: SettingsRow | null): StoredRl {
		if (!row) return {};
		try {
			const parsed = JSON.parse(row.value) as unknown;
			if (typeof parsed !== "object" || parsed === null) return {};
			const obj = parsed as Record<string, unknown>;
			const resetsAt =
				typeof obj.resetsAt === "number"
					? obj.resetsAt
					: typeof obj.resetsAt === "string"
						? Number(obj.resetsAt)
						: null;
			if (resetsAt != null && resetsAt < Date.now() / 1000) return {};
			return {
				utilization:
					typeof obj.utilization === "number" ? obj.utilization : null,
				remaining: typeof obj.remaining === "number" ? obj.remaining : null,
				limit: typeof obj.limit === "number" ? obj.limit : null,
				resetsAt,
			};
		} catch {
			return {};
		}
	}

	const windows: ProviderWindowEntry[] = [];

	for (const def of windowDefs) {
		const row =
			db
				.query<WindowRow, [string, number]>(`
        SELECT
          COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) as tokens,
          COUNT(DISTINCT session_id) as sessions,
          COUNT(*) as queries,
          COALESCE(SUM(cost), 0) as cost
        FROM usage_queries
        WHERE provider_id = ? AND timestamp >= strftime('%s', 'now', ? || ' seconds')
      `)
				.get(providerId, -def.windowSecs) ?? EMPTY_ROW;

		const rl = parseStoredRl(
			db
				.query<SettingsRow, [string]>(
					`SELECT value FROM settings WHERE key = ?`,
				)
				.get(`rl_${providerId}_${def.windowId}`),
		);

		windows.push({
			windowId: def.windowId,
			label: def.label,
			windowSecs: def.windowSecs,
			tokens: row.tokens,
			sessions: row.sessions,
			queries: row.queries,
			cost: row.cost,
			utilization: rl.utilization ?? null,
			remaining: rl.remaining ?? null,
			limit: rl.limit ?? null,
			resetsAt: rl.resetsAt ?? null,
		});
	}

	return {
		providerId,
		providerLabel: providerLabels.get(providerId) ?? providerId,
		windows,
	};
}

export async function getThirtyDayStats(): Promise<ThirtyDayStats> {
	const db = await getDb();
	const rows = db
		.query<{ date: string; count: number }, []>(`
    SELECT date, queries as count
    FROM usage_daily
    WHERE date >= DATE('now', 'localtime', '-29 days')
    ORDER BY date ASC
  `)
		.all();

	const map = new Map(rows.map((r) => [r.date, r.count]));
	const total = rows.reduce((a, r) => a + r.count, 0);
	const days: { date: string; count: number }[] = [];
	for (let i = 29; i >= 0; i--) {
		const d = new Date();
		d.setDate(d.getDate() - i);
		const y = d.getFullYear();
		const mo = String(d.getMonth() + 1).padStart(2, "0");
		const dy = String(d.getDate()).padStart(2, "0");
		const date = `${y}-${mo}-${dy}`;
		days.push({ date, count: map.get(date) ?? 0 });
	}
	return { days, total };
}

export async function getWeeklyStats(): Promise<WeeklyStats> {
	const db = await getDb();

	// Compute start-of-week and today in SQLite using the same `localtime`
	// reference that recordQuery uses to write usage_daily.date — mixing JS
	// `new Date()` with SQLite localtime is unsafe when JS sees a different
	// timezone than the SQLite C runtime (e.g. bun test forces UTC for Intl
	// but SQLite still reads system TZ).
	type Row = { day: number; count: number };
	const rows = db
		.query<Row, []>(
			`SELECT CAST(strftime('%w', date) AS INTEGER) as day,
			        SUM(queries) as count
			 FROM usage_daily
			 WHERE date >= DATE('now', 'localtime',
			                    '-' || CAST(strftime('%w', 'now', 'localtime') AS TEXT) || ' days')
			   AND date <= DATE('now', 'localtime')
			 GROUP BY day`,
		)
		.all();

	const days = Array(7).fill(0) as number[];
	let total = 0;
	for (const row of rows) {
		days[row.day] = row.count;
		total += row.count;
	}
	return { total, days };
}
