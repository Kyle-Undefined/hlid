import type {
	HourOfDayBucket,
	ModelSplitEntry,
	StopReasonEntry,
	TopToolCall,
} from "./activity";
import { getDb } from "./schema";
import type { AggWindow, ThirtyDayStats } from "./types";

export type LedgerStatsRange =
	| "today"
	| "7d"
	| "30d"
	| "90d"
	| "all"
	| "custom";

export type LedgerAnalyticsFilter = {
	range: LedgerStatsRange;
	agent?: string;
	provider?: string;
	model?: string;
	from?: string;
	to?: string;
};

export type WeekdayHourBucket = {
	weekday: number;
	hour: number;
	count: number;
};

export type LedgerAnalytics = {
	selected: AggWindow & { sessions: number };
	trend: ThirtyDayStats;
	topTools: TopToolCall[];
	hourOfDay: HourOfDayBucket[];
	weekdayHour: WeekdayHourBucket[];
	modelSplit: ModelSplitEntry[];
	stopReasonSplit: StopReasonEntry[];
	facets: { agents: string[]; providers: string[]; models: string[] };
};

const MODEL_SQL =
	"COALESCE(NULLIF(s.actual_model, ''), NULLIF(s.selected_model, ''), NULLIF(s.model, ''))";

function rangeDays(range: LedgerStatsRange): number | null {
	if (range === "7d") return 7;
	if (range === "30d") return 30;
	if (range === "90d") return 90;
	return null;
}

function sessionConditions(
	filter: LedgerAnalyticsFilter,
	timestampSql: string,
	providerSql = "s.provider_id",
): { sql: string; params: (string | number)[] } {
	const conditions: string[] = [];
	const params: (string | number)[] = [];
	const days = rangeDays(filter.range);
	if (filter.range === "today") {
		conditions.push(
			`${timestampSql} >= unixepoch('now', 'localtime', 'start of day', 'utc')`,
		);
	} else if (filter.range === "custom") {
		if (!filter.from || !filter.to) {
			conditions.push("0");
		} else {
			conditions.push(`${timestampSql} >= unixepoch(?, 'start of day', 'utc')`);
			params.push(filter.from);
			conditions.push(
				`${timestampSql} < unixepoch(?, '+1 day', 'start of day', 'utc')`,
			);
			params.push(filter.to);
		}
	} else if (days != null) {
		conditions.push(`${timestampSql} >= unixepoch('now', ?)`);
		params.push(`-${days} days`);
	}
	if (filter.agent === "vault") {
		conditions.push("(s.agent_cwd IS NULL OR TRIM(s.agent_cwd) = '')");
	} else if (filter.agent) {
		conditions.push("s.agent_cwd = ?");
		params.push(filter.agent);
	}
	if (filter.provider) {
		conditions.push(`COALESCE(${providerSql}, s.provider_id) = ?`);
		params.push(filter.provider);
	}
	if (filter.model) {
		conditions.push(`${MODEL_SQL} = ?`);
		params.push(filter.model);
	}
	return {
		sql: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
		params,
	};
}

export async function getLedgerAnalytics(
	filter: LedgerAnalyticsFilter,
): Promise<LedgerAnalytics> {
	const db = await getDb();
	const usage = sessionConditions(filter, "uq.timestamp", "uq.provider_id");
	const query = sessionConditions(filter, "q.timestamp");
	const tool = sessionConditions(
		filter,
		"COALESCE((SELECT MIN(m.timestamp) FROM messages m WHERE m.session_id = te.session_id AND m.seq = te.assistant_seq AND m.role = 'assistant'), s.started_at)",
	);

	type SelectedRow = AggWindow & { sessions: number };
	const selected = db
		.query<SelectedRow, (string | number)[]>(
			`SELECT
				COALESCE(SUM(uq.cost), 0) AS cost,
				COALESCE(SUM(uq.estimated_cost), 0) AS estimated_cost,
				COALESCE(SUM(uq.unpriced), 0) AS unpriced_queries,
				COUNT(*) AS queries,
				COALESCE(SUM(uq.turns), 0) AS turns,
				COALESCE(SUM(uq.input_tokens) + SUM(uq.output_tokens), 0) AS tokens,
				COALESCE(SUM(uq.input_tokens), 0) AS input_tokens,
				COALESCE(SUM(uq.output_tokens), 0) AS output_tokens,
				COALESCE(SUM(uq.cache_read_tokens), 0) AS cache_read_tokens,
				COALESCE(SUM(uq.cache_creation_tokens), 0) AS cache_creation_tokens,
				COUNT(DISTINCT uq.session_id) AS sessions
			 FROM usage_queries uq
			 LEFT JOIN sessions s ON s.id = uq.session_id
			 ${usage.sql}`,
		)
		.get(...usage.params) ?? {
		cost: 0,
		estimated_cost: 0,
		unpriced_queries: 0,
		queries: 0,
		turns: 0,
		tokens: 0,
		input_tokens: 0,
		output_tokens: 0,
		cache_read_tokens: 0,
		cache_creation_tokens: 0,
		sessions: 0,
	};

	const dailyRows = db
		.query<{ date: string; count: number }, (string | number)[]>(
			`SELECT DATE(uq.timestamp, 'unixepoch', 'localtime') AS date, COUNT(*) AS count
			 FROM usage_queries uq LEFT JOIN sessions s ON s.id = uq.session_id
			 ${usage.sql}
			 GROUP BY date ORDER BY date ASC`,
		)
		.all(...usage.params);
	const trend: ThirtyDayStats = {
		days: dailyRows,
		total: dailyRows.reduce((sum, row) => sum + row.count, 0),
	};

	const topTools = db
		.query<TopToolCall, (string | number)[]>(
			`SELECT te.name, COUNT(*) AS count,
			 CAST(SUM(CASE WHEN te.is_error = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) AS errorRate
			 FROM tool_events te JOIN sessions s ON s.id = te.session_id
			 ${tool.sql}
			 GROUP BY te.name ORDER BY count DESC, te.name ASC LIMIT 10`,
		)
		.all(...tool.params)
		.map((row) => ({ ...row, errorRate: row.errorRate ?? 0 }));

	const weekdayHour = db
		.query<WeekdayHourBucket, (string | number)[]>(
			`SELECT CAST(strftime('%w', q.timestamp, 'unixepoch', 'localtime') AS INTEGER) AS weekday,
			 CAST(strftime('%H', q.timestamp, 'unixepoch', 'localtime') AS INTEGER) AS hour,
			 COUNT(*) AS count
			 FROM queries q JOIN sessions s ON s.id = q.session_id
			 ${query.sql}
			 GROUP BY weekday, hour`,
		)
		.all(...query.params);
	const hourCounts = new Array<number>(24).fill(0);
	for (const row of weekdayHour) hourCounts[row.hour] += row.count;

	const modelSplit = db
		.query<ModelSplitEntry, (string | number)[]>(
			`SELECT ${MODEL_SQL} AS model, COUNT(DISTINCT q.session_id) AS count
			 FROM queries q JOIN sessions s ON s.id = q.session_id
			 ${query.sql}${query.sql ? " AND" : " WHERE"} ${MODEL_SQL} IS NOT NULL
			 GROUP BY ${MODEL_SQL} ORDER BY count DESC, model ASC`,
		)
		.all(...query.params);
	const stopReasonSplit = db
		.query<StopReasonEntry, (string | number)[]>(
			`SELECT q.stop_reason AS reason, COUNT(*) AS count
			 FROM queries q JOIN sessions s ON s.id = q.session_id
			 ${query.sql}${query.sql ? " AND" : " WHERE"} q.stop_reason IS NOT NULL
			 GROUP BY q.stop_reason ORDER BY count DESC, reason ASC`,
		)
		.all(...query.params);

	const agents = db
		.query<{ value: string }, []>(
			"SELECT DISTINCT agent_cwd AS value FROM sessions WHERE agent_cwd IS NOT NULL AND TRIM(agent_cwd) <> '' ORDER BY value COLLATE NOCASE",
		)
		.all()
		.map((row) => row.value);
	const providers = db
		.query<{ value: string }, []>(
			"SELECT DISTINCT provider_id AS value FROM sessions WHERE provider_id IS NOT NULL AND TRIM(provider_id) <> '' ORDER BY value COLLATE NOCASE",
		)
		.all()
		.map((row) => row.value);
	const models = db
		.query<{ value: string }, []>(
			`SELECT DISTINCT ${MODEL_SQL} AS value FROM sessions s WHERE ${MODEL_SQL} IS NOT NULL ORDER BY value COLLATE NOCASE`,
		)
		.all()
		.map((row) => row.value);

	return {
		selected,
		trend,
		topTools,
		hourOfDay: hourCounts.map((count, hour) => ({ hour, count })),
		weekdayHour,
		modelSplit,
		stopReasonSplit,
		facets: { agents, providers, models },
	};
}
