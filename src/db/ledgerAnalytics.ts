import type {
	HourOfDayBucket,
	ModelSplitEntry,
	StopReasonEntry,
	ToolErrorEntry,
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

export type LedgerToolErrorBreakdown = {
	total: number;
	distinct: number;
	groups: ToolErrorEntry[];
};

const SESSION_MODEL_SQL =
	"COALESCE(NULLIF(s.actual_model, ''), NULLIF(s.selected_model, ''), NULLIF(s.model, ''))";
const TOOL_FALLBACK_TIMESTAMP_SQL =
	"COALESCE((SELECT MIN(m.timestamp) FROM messages m WHERE m.session_id = te.session_id AND m.seq = te.assistant_seq AND m.role = 'assistant'), s.started_at)";

type AnalyticsDimensions = {
	agent: string;
	provider: string;
	model: string;
};

const USAGE_DIMENSIONS: AnalyticsDimensions = {
	agent: "uq.agent_cwd",
	provider: "uq.provider_id",
	model: "NULLIF(uq.model, '')",
};

const QUERY_DIMENSIONS: AnalyticsDimensions = {
	agent: "q.agent_cwd",
	provider: "q.provider_id",
	model: "NULLIF(q.model, '')",
};

const TOOL_DIMENSIONS: AnalyticsDimensions = {
	agent: "te.agent_cwd",
	provider: "te.provider_id",
	model: "NULLIF(te.model, '')",
};

function rangeDays(range: LedgerStatsRange): number | null {
	if (range === "7d") return 7;
	if (range === "30d") return 30;
	if (range === "90d") return 90;
	return null;
}

/** Local-calendar boundary shared by Stats analytics and session drill-downs. */
export function ledgerRangeCondition(
	filter: Pick<LedgerAnalyticsFilter, "range" | "from" | "to">,
	timestampSql: string,
): { condition: string | null; params: string[] } {
	if (filter.range === "today") {
		return {
			condition: `${timestampSql} >= unixepoch('now', 'localtime', 'start of day', 'utc')`,
			params: [],
		};
	}
	if (filter.range === "custom") {
		if (!filter.from || !filter.to) return { condition: "0", params: [] };
		return {
			condition: `${timestampSql} >= unixepoch(?, 'start of day', 'utc') AND ${timestampSql} < unixepoch(?, '+1 day', 'start of day', 'utc')`,
			params: [filter.from, filter.to],
		};
	}
	const days = rangeDays(filter.range);
	if (days == null) return { condition: null, params: [] };
	return {
		condition: `${timestampSql} >= unixepoch('now', 'localtime', 'start of day', ?, 'utc')`,
		params: [`-${days - 1} days`],
	};
}

function sessionConditions(
	filter: LedgerAnalyticsFilter,
	timestampSql: string,
	dimensions: AnalyticsDimensions,
): { sql: string; params: (string | number)[] } {
	const conditions: string[] = [];
	const params: (string | number)[] = [];
	const range = ledgerRangeCondition(filter, timestampSql);
	if (range.condition) conditions.push(range.condition);
	params.push(...range.params);
	if (filter.agent === "vault") {
		conditions.push(
			`(${dimensions.agent} IS NULL OR TRIM(${dimensions.agent}) = '')`,
		);
	} else if (filter.agent) {
		conditions.push(`${dimensions.agent} = ?`);
		params.push(filter.agent);
	}
	if (filter.provider) {
		conditions.push(`${dimensions.provider} = ?`);
		params.push(filter.provider);
	}
	if (filter.model) {
		conditions.push(`${dimensions.model} = ?`);
		params.push(filter.model);
	}
	return {
		sql: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
		params,
	};
}

type SqlConditions = ReturnType<typeof sessionConditions>;

function appendCondition(
	conditions: SqlConditions,
	condition: string,
): SqlConditions {
	return {
		sql: `${conditions.sql}${conditions.sql ? " AND" : " WHERE"} ${condition}`,
		params: conditions.params,
	};
}

/**
 * Keep the common timestamped tool-event path on the composite timestamp index.
 * Only the small legacy NULL-timestamp set needs the correlated message fallback.
 */
function toolEventConditions(filter: LedgerAnalyticsFilter): SqlConditions[] {
	if (filter.range === "all") {
		return [sessionConditions(filter, "te.timestamp", TOOL_DIMENSIONS)];
	}
	return [
		appendCondition(
			sessionConditions(filter, "te.timestamp", TOOL_DIMENSIONS),
			"te.timestamp IS NOT NULL",
		),
		appendCondition(
			sessionConditions(filter, TOOL_FALLBACK_TIMESTAMP_SQL, TOOL_DIMENSIONS),
			"te.timestamp IS NULL",
		),
	];
}

export async function getLedgerAnalytics(
	filter: LedgerAnalyticsFilter,
): Promise<LedgerAnalytics> {
	const db = await getDb();
	const usage = sessionConditions(filter, "uq.timestamp", USAGE_DIMENSIONS);
	const query = sessionConditions(filter, "q.timestamp", QUERY_DIMENSIONS);
	const toolSources = toolEventConditions(filter);

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
			`SELECT name, COUNT(*) AS count,
			 SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) AS errorCount,
			 CAST(SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) AS errorRate
			 FROM (${toolSources
					.map(
						(source) =>
							`SELECT te.name, te.is_error
							 FROM tool_events te JOIN sessions s ON s.id = te.session_id
							 ${source.sql}`,
					)
					.join(" UNION ALL ")}) filtered_tool_events
			 GROUP BY name ORDER BY count DESC, name ASC LIMIT 10`,
		)
		.all(...toolSources.flatMap((source) => source.params))
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
			`SELECT ${QUERY_DIMENSIONS.model} AS model, COUNT(DISTINCT q.session_id) AS count
			 FROM queries q JOIN sessions s ON s.id = q.session_id
			 ${query.sql}${query.sql ? " AND" : " WHERE"} ${QUERY_DIMENSIONS.model} IS NOT NULL
			 GROUP BY ${QUERY_DIMENSIONS.model} ORDER BY count DESC, model ASC`,
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
			`SELECT DISTINCT value FROM (
				SELECT agent_cwd AS value FROM sessions
				UNION ALL SELECT agent_cwd FROM queries
				UNION ALL SELECT agent_cwd FROM usage_queries
				UNION ALL SELECT agent_cwd FROM tool_events
			 ) WHERE value IS NOT NULL AND TRIM(value) <> ''
			 ORDER BY value COLLATE NOCASE`,
		)
		.all()
		.map((row) => row.value);
	const providers = db
		.query<{ value: string }, []>(
			`SELECT DISTINCT value FROM (
				SELECT provider_id AS value FROM sessions
				UNION ALL SELECT provider_id FROM queries
				UNION ALL SELECT provider_id FROM usage_queries
				UNION ALL SELECT provider_id FROM tool_events
			 ) WHERE value IS NOT NULL AND TRIM(value) <> ''
			 ORDER BY value COLLATE NOCASE`,
		)
		.all()
		.map((row) => row.value);
	const models = db
		.query<{ value: string }, []>(
			`SELECT DISTINCT value FROM (
				SELECT ${SESSION_MODEL_SQL} AS value FROM sessions s
				UNION ALL SELECT model FROM queries
				UNION ALL SELECT model FROM usage_queries
				UNION ALL SELECT model FROM tool_events
			 ) WHERE value IS NOT NULL AND TRIM(value) <> ''
			 ORDER BY value COLLATE NOCASE`,
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

/** Error groups for one chart row, using the exact same Ledger filters. */
export async function getLedgerToolErrors(
	toolName: string,
	filter: LedgerAnalyticsFilter,
	limit = 50,
): Promise<LedgerToolErrorBreakdown> {
	const db = await getDb();
	const toolSources = toolEventConditions(filter);
	const rowsSql = toolSources
		.map(
			(source) =>
				`SELECT te.name, te.is_error, te.result_text
				 FROM tool_events te JOIN sessions s ON s.id = te.session_id
				 ${source.sql}`,
		)
		.join(" UNION ALL ");
	const sourceParams = toolSources.flatMap((source) => source.params);
	const params = [...sourceParams, toolName];
	const counts = db
		.query<{ total: number; distinctCount: number }, (string | number)[]>(
			`SELECT COUNT(*) AS total,
			        COUNT(DISTINCT COALESCE(result_text, '')) AS distinctCount
			 FROM (${rowsSql}) filtered_tool_events
			 WHERE name = ? AND is_error = 1`,
		)
		.get(...params) ?? { total: 0, distinctCount: 0 };
	const groups = db
		.query<ToolErrorEntry, (string | number)[]>(
			`SELECT COALESCE(result_text, '') AS text, COUNT(*) AS count
			 FROM (${rowsSql}) filtered_tool_events
			 WHERE name = ? AND is_error = 1
			 GROUP BY COALESCE(result_text, '')
			 ORDER BY count DESC, text ASC
			 LIMIT ?`,
		)
		.all(...params, limit);
	return { total: counts.total, distinct: counts.distinctCount, groups };
}
