import { getDb } from "./schema";

// ─── shared types ─────────────────────────────────────────────────────────────

export type TopToolCall = {
	name: string;
	count: number;
	/** 0..1 — fraction of invocations where is_error = 1. NULL counts as success. */
	errorRate: number;
};

export type HourOfDayBucket = { hour: number; count: number };

export type LatencyBucket = { label: string; count: number };

export type LatencyDistribution = {
	buckets: LatencyBucket[];
	/** p50 in ms; 0 when no rows. */
	p50: number;
	/** p95 in ms; 0 when no rows. */
	p95: number;
	total: number;
};

export type ModelSplitEntry = { model: string; count: number };

export type StopReasonEntry = { reason: string; count: number };

// ─── latency bucket definitions ───────────────────────────────────────────────

/**
 * Histogram edges (ms). Bucket i covers `[DURATION_BUCKETS_MS[i], DURATION_BUCKETS_MS[i+1])`.
 * Last edge is `Infinity` so the open-ended top bucket catches outliers.
 */
export const DURATION_BUCKETS_MS = [
	0,
	100,
	500,
	1_000,
	5_000,
	15_000,
	60_000,
	Number.POSITIVE_INFINITY,
] as const;

const BUCKET_LABELS: readonly string[] = [
	"<100",
	"100-500",
	"500-1k",
	"1-5k",
	"5-15k",
	"15-60k",
	"60k+",
];

// ─── getTopToolCalls ──────────────────────────────────────────────────────────

export async function getTopToolCalls(limit = 10): Promise<TopToolCall[]> {
	const db = await getDb();
	type Row = { name: string; count: number; errorRate: number };
	const rows = db
		.query<Row, [number]>(
			`SELECT name,
			        COUNT(*) AS count,
			        CAST(SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) AS errorRate
			 FROM tool_events
			 GROUP BY name
			 ORDER BY count DESC, name ASC
			 LIMIT ?`,
		)
		.all(limit);
	return rows.map((r) => ({
		name: r.name,
		count: r.count,
		errorRate: r.errorRate ?? 0,
	}));
}

// ─── getToolErrors ────────────────────────────────────────────────────────────

export type ToolErrorEntry = {
	/** Raw result_text from the tool event. */
	text: string;
	/** How many times this exact message appeared. */
	count: number;
};

/**
 * Returns the top distinct error messages for a given tool name, grouped by
 * result_text so repeated identical errors collapse into a single row.
 */
export async function getToolErrors(
	toolName: string,
	limit = 10,
): Promise<ToolErrorEntry[]> {
	const db = await getDb();
	type Row = { text: string; count: number };
	return db
		.query<Row, [string, number]>(
			`SELECT result_text AS text, COUNT(*) AS count
			 FROM tool_events
			 WHERE name = ? AND is_error = 1 AND result_text IS NOT NULL
			 GROUP BY result_text
			 ORDER BY count DESC
			 LIMIT ?`,
		)
		.all(toolName, limit);
}

// ─── getHourOfDayActivity ─────────────────────────────────────────────────────

export async function getHourOfDayActivity(): Promise<HourOfDayBucket[]> {
	const db = await getDb();
	type Row = { hour: number; count: number };
	const rows = db
		.query<Row, []>(
			`SELECT CAST(strftime('%H', timestamp, 'unixepoch', 'localtime') AS INTEGER) AS hour,
			        COUNT(*) AS count
			 FROM queries
			 GROUP BY hour`,
		)
		.all();
	const counts = new Array<number>(24).fill(0);
	for (const r of rows) {
		if (r.hour >= 0 && r.hour < 24) counts[r.hour] = r.count;
	}
	return counts.map((count, hour) => ({ hour, count }));
}

// ─── getLatencyDistribution ───────────────────────────────────────────────────

/**
 * Bucket counts and p50/p95 are computed entirely in SQL so memory stays
 * O(1) instead of O(N) — important once the queries table grows.
 *
 * Percentile index math:
 *   - JS: `rows[Math.floor(total * p)]` (0-indexed)
 *   - SQL: `ROW_NUMBER() = CAST(total * p AS INTEGER) + 1` (1-indexed)
 * Both pick the same row, so the result matches the original JS-side calc.
 */
export async function getLatencyDistribution(): Promise<LatencyDistribution> {
	const db = await getDb();
	type Row = {
		total: number;
		p50: number;
		p95: number;
		b0: number;
		b1: number;
		b2: number;
		b3: number;
		b4: number;
		b5: number;
		b6: number;
	};
	const row = db
		.query<Row, []>(
			`WITH ordered AS (
					SELECT duration_ms,
					       ROW_NUMBER() OVER (ORDER BY duration_ms ASC) AS rn,
					       COUNT(*) OVER () AS total
					FROM queries
					WHERE duration_ms > 0
				)
				SELECT
					COALESCE(MAX(total), 0) AS total,
					COALESCE(MAX(CASE WHEN rn = CAST(total * 0.5 AS INTEGER) + 1 THEN duration_ms END), 0) AS p50,
					COALESCE(MAX(CASE WHEN rn = CAST(total * 0.95 AS INTEGER) + 1 THEN duration_ms END), 0) AS p95,
					COALESCE(SUM(CASE WHEN duration_ms <    100 THEN 1 ELSE 0 END), 0) AS b0,
					COALESCE(SUM(CASE WHEN duration_ms >=   100 AND duration_ms <   500 THEN 1 ELSE 0 END), 0) AS b1,
					COALESCE(SUM(CASE WHEN duration_ms >=   500 AND duration_ms <  1000 THEN 1 ELSE 0 END), 0) AS b2,
					COALESCE(SUM(CASE WHEN duration_ms >=  1000 AND duration_ms <  5000 THEN 1 ELSE 0 END), 0) AS b3,
					COALESCE(SUM(CASE WHEN duration_ms >=  5000 AND duration_ms < 15000 THEN 1 ELSE 0 END), 0) AS b4,
					COALESCE(SUM(CASE WHEN duration_ms >= 15000 AND duration_ms < 60000 THEN 1 ELSE 0 END), 0) AS b5,
					COALESCE(SUM(CASE WHEN duration_ms >= 60000 THEN 1 ELSE 0 END), 0) AS b6
				FROM ordered`,
		)
		.get() ?? {
		total: 0,
		p50: 0,
		p95: 0,
		b0: 0,
		b1: 0,
		b2: 0,
		b3: 0,
		b4: 0,
		b5: 0,
		b6: 0,
	};

	const counts = [row.b0, row.b1, row.b2, row.b3, row.b4, row.b5, row.b6];
	const buckets: LatencyBucket[] = BUCKET_LABELS.map((label, i) => ({
		label,
		count: counts[i],
	}));
	return { buckets, p50: row.p50, p95: row.p95, total: row.total };
}

// ─── getModelSplit ────────────────────────────────────────────────────────────

export async function getModelSplit(): Promise<ModelSplitEntry[]> {
	const db = await getDb();
	type Row = { model: string; count: number };
	const rows = db
		.query<Row, []>(
			`SELECT COALESCE(actual_model, model) AS model, COUNT(*) AS count
			 FROM sessions
			 WHERE COALESCE(actual_model, model) IS NOT NULL
			 GROUP BY COALESCE(actual_model, model)
			 ORDER BY count DESC, COALESCE(actual_model, model) ASC`,
		)
		.all();
	return rows.map((r) => ({ model: r.model, count: r.count }));
}

// ─── getStopReasonSplit ───────────────────────────────────────────────────────

/**
 * Note: user-cancelled queries never call recordQuery() — they produce no row.
 * Filter is purely "exclude NULL stop_reason" (rows from incomplete inserts).
 */
export async function getStopReasonSplit(): Promise<StopReasonEntry[]> {
	const db = await getDb();
	type Row = { reason: string; count: number };
	const rows = db
		.query<Row, []>(
			`SELECT stop_reason AS reason, COUNT(*) AS count
			 FROM queries
			 WHERE stop_reason IS NOT NULL
			 GROUP BY stop_reason
			 ORDER BY count DESC, reason ASC`,
		)
		.all();
	return rows.map((r) => ({ reason: r.reason, count: r.count }));
}
