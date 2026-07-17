import type { Database } from "bun:sqlite";

export type UsageTokenBuckets = {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
};

export type StoredQuery = {
	id: number;
	session_id: string;
	timestamp: number;
	cost: number;
	estimated_cost: number | null;
	cost_known: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
	turns: number;
	context_window: number | null;
	tokens_in_context: number | null;
};

export type StoredUsageQuery = {
	id: number;
	session_id: string | null;
	timestamp: number;
	cost: number;
	estimated_cost: number | null;
	cost_known: number;
	unpriced: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
	turns: number;
	provider_id: string;
};

export type StoredUsageFingerprint = {
	id: number;
	sessionId: string | null;
	timestamp: number;
	cost: number;
	estimatedCost: number | null;
	costKnown: number;
	usage: UsageTokenBuckets;
	turns: number;
};

export const EMPTY_USAGE_BUCKETS: UsageTokenBuckets = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheCreationTokens: 0,
};

export function finiteNumber(value: unknown): number {
	const number = typeof value === "number" ? value : Number(value);
	return Number.isFinite(number) ? number : 0;
}

export function addUsageBuckets(
	a: UsageTokenBuckets,
	b: UsageTokenBuckets,
): UsageTokenBuckets {
	return {
		inputTokens: a.inputTokens + b.inputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
		cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
		cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
	};
}

export function subtractUsageBuckets(
	a: UsageTokenBuckets,
	b: UsageTokenBuckets,
): UsageTokenBuckets {
	return {
		inputTokens: a.inputTokens - b.inputTokens,
		outputTokens: a.outputTokens - b.outputTokens,
		cacheReadTokens: a.cacheReadTokens - b.cacheReadTokens,
		cacheCreationTokens: a.cacheCreationTokens - b.cacheCreationTokens,
	};
}

export function usageBucketsEqual(
	a: UsageTokenBuckets,
	b: UsageTokenBuckets,
): boolean {
	return (
		a.inputTokens === b.inputTokens &&
		a.outputTokens === b.outputTokens &&
		a.cacheReadTokens === b.cacheReadTokens &&
		a.cacheCreationTokens === b.cacheCreationTokens
	);
}

export function usageBucketsPositive(usage: UsageTokenBuckets): boolean {
	return (
		usage.inputTokens > 0 ||
		usage.outputTokens > 0 ||
		usage.cacheReadTokens > 0 ||
		usage.cacheCreationTokens > 0
	);
}

export function storedUsageBuckets(row: {
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
}): UsageTokenBuckets {
	return {
		inputTokens: row.input_tokens,
		outputTokens: row.output_tokens,
		cacheReadTokens: row.cache_read_tokens,
		cacheCreationTokens: row.cache_creation_tokens,
	};
}

export function storedUsageFingerprintMatches(
	row: StoredQuery | StoredUsageQuery,
	fingerprint: StoredUsageFingerprint,
	numberEqual: (a: number | null, b: number | null) => boolean,
): boolean {
	return (
		row.id === fingerprint.id &&
		row.session_id === fingerprint.sessionId &&
		row.timestamp === fingerprint.timestamp &&
		row.cost === fingerprint.cost &&
		numberEqual(row.estimated_cost, fingerprint.estimatedCost) &&
		row.cost_known === fingerprint.costKnown &&
		row.turns === fingerprint.turns &&
		usageBucketsEqual(storedUsageBuckets(row), fingerprint.usage)
	);
}

export function usageTokenTotal(usage: UsageTokenBuckets): number {
	return (
		usage.inputTokens +
		usage.outputTokens +
		usage.cacheReadTokens +
		usage.cacheCreationTokens
	);
}

export function tableHasColumn(
	db: Database,
	table: string,
	column: string,
): boolean {
	return db
		.query<{ name: string }, []>(`PRAGMA table_info(${table})`)
		.all()
		.some((row) => row.name === column);
}

export function costKnownSql(db: Database, table: string): string {
	return tableHasColumn(db, table, "cost_known")
		? "cost_known"
		: "CASE WHEN cost != 0 OR estimated_cost IS NOT NULL THEN 1 ELSE 0 END";
}

export function storedQueriesForSession(
	db: Database,
	sessionId: string,
): StoredQuery[] {
	return db
		.query<StoredQuery, [string]>(`
			SELECT id, session_id, timestamp, cost, estimated_cost,
			       ${costKnownSql(db, "queries")} AS cost_known,
			       input_tokens, output_tokens, cache_read_tokens,
			       cache_creation_tokens, turns, context_window, tokens_in_context
			FROM queries WHERE session_id = ? ORDER BY timestamp, id
		`)
		.all(sessionId);
}

export function storedUsageQueriesForSession(
	db: Database,
	sessionId: string,
): StoredUsageQuery[] {
	return db
		.query<StoredUsageQuery, [string]>(`
			SELECT id, session_id, timestamp, cost, estimated_cost,
			       ${costKnownSql(db, "usage_queries")} AS cost_known,
			       unpriced, input_tokens, output_tokens, cache_read_tokens,
			       cache_creation_tokens, turns, provider_id
			FROM usage_queries WHERE session_id = ? ORDER BY timestamp, id
		`)
		.all(sessionId);
}

export function selectStoredQueryById(
	db: Database,
	id: number,
): StoredQuery | null {
	return (
		db
			.query<StoredQuery, [number]>(`
				SELECT id, session_id, timestamp, cost, estimated_cost,
				       ${costKnownSql(db, "queries")} AS cost_known,
				       input_tokens, output_tokens, cache_read_tokens,
				       cache_creation_tokens, turns, context_window, tokens_in_context
				FROM queries WHERE id = ?
			`)
			.get(id) ?? null
	);
}

export function selectStoredUsageQueryById(
	db: Database,
	id: number,
): StoredUsageQuery | null {
	return (
		db
			.query<StoredUsageQuery, [number]>(`
				SELECT id, session_id, timestamp, cost, estimated_cost,
				       ${costKnownSql(db, "usage_queries")} AS cost_known,
				       unpriced, input_tokens, output_tokens, cache_read_tokens,
				       cache_creation_tokens, turns, provider_id
				FROM usage_queries WHERE id = ?
			`)
			.get(id) ?? null
	);
}

export function rebuildUsageDate(db: Database, date: string): void {
	db.run(`DELETE FROM usage_daily WHERE date = ?`, [date]);
	db.run(
		`INSERT INTO usage_daily
			(date, cost, estimated_cost, unpriced_queries, queries, input_tokens,
			 output_tokens, cache_read_tokens, cache_creation_tokens, turns)
		 SELECT DATE(timestamp, 'unixepoch', 'localtime'),
		        COALESCE(SUM(cost), 0), COALESCE(SUM(estimated_cost), 0),
		        COALESCE(SUM(unpriced), 0), COUNT(*),
		        COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
		        COALESCE(SUM(cache_read_tokens), 0),
		        COALESCE(SUM(cache_creation_tokens), 0), COALESCE(SUM(turns), 0)
		 FROM usage_queries
		 WHERE DATE(timestamp, 'unixepoch', 'localtime') = ?
		 GROUP BY DATE(timestamp, 'unixepoch', 'localtime')`,
		[date],
	);
}

export function ensureUsageRepairRunsTable(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS usage_repair_runs (
			manifest_sha256 TEXT PRIMARY KEY,
			version INTEGER NOT NULL,
			created_at INTEGER NOT NULL DEFAULT (unixepoch()),
			planned_rows INTEGER NOT NULL,
			applied_rows INTEGER NOT NULL,
			already_correct_rows INTEGER NOT NULL,
			unresolved_rows INTEGER NOT NULL,
			before_tokens INTEGER NOT NULL,
			after_tokens INTEGER NOT NULL
		)
	`);
}

export function recordUsageRepairRun(
	db: Database,
	args: {
		manifest: unknown;
		version: number;
		plannedRows: number;
		appliedRows: number;
		alreadyCorrectRows: number;
		unresolvedRows: number;
		beforeTokens: number;
		afterTokens: number;
	},
): void {
	const manifestSha = new Bun.CryptoHasher("sha256")
		.update(JSON.stringify(args.manifest))
		.digest("hex");
	db.run(
		`INSERT OR REPLACE INTO usage_repair_runs
		 (manifest_sha256, version, planned_rows, applied_rows,
		  already_correct_rows, unresolved_rows, before_tokens, after_tokens)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			manifestSha,
			args.version,
			args.plannedRows,
			args.appliedRows,
			args.alreadyCorrectRows,
			args.unresolvedRows,
			args.beforeTokens,
			args.afterTokens,
		],
	);
}
