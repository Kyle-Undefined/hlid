/**
 * Repairs sessions whose cached totals drifted from the immutable usage ledger.
 *
 * The 2026-07-13 cumulative-cost repair corrected `usage_queries` rows but a
 * few sessions kept stale `queries` rows (and therefore stale
 * `sessions.total_*` caches rebuilt from them). `usage_queries` is the
 * authoritative source: this repair copies its cost/token values back onto the
 * paired `queries` rows and rebuilds the session totals.
 *
 * Rows pair by per-session insert order — recordQuery writes both tables in
 * one transaction, so the Nth `queries` row of a session is always the Nth
 * `usage_queries` row. Sessions whose row counts disagree are left untouched
 * and reported as unresolved.
 */
import type { Database } from "bun:sqlite";

export const SESSION_COST_DRIFT_REPAIR_VERSION = 1;

const COST_EPSILON = 1e-6;

type RowValues = {
	cost: number;
	estimated_cost: number | null;
	cost_known: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
};

export type SessionCostDriftRow = {
	sessionId: string;
	queryId: number;
	usageQueryId: number;
	before: RowValues;
	after: RowValues;
};

export type SessionCostDriftManifest = {
	version: typeof SESSION_COST_DRIFT_REPAIR_VERSION;
	databasePath: string;
	sessions: Array<{ sessionId: string; driftBefore: number }>;
	rows: SessionCostDriftRow[];
	unresolved: Array<{ sessionId: string; reason: string }>;
};

export type ApplySessionCostDriftResult = {
	updatedRows: number;
	rebuiltSessions: number;
};

type StoredRow = RowValues & { id: number };

function rowValues(row: StoredRow): RowValues {
	return {
		cost: row.cost,
		estimated_cost: row.estimated_cost,
		cost_known: row.cost_known,
		input_tokens: row.input_tokens,
		output_tokens: row.output_tokens,
		cache_read_tokens: row.cache_read_tokens,
		cache_creation_tokens: row.cache_creation_tokens,
	};
}

function numberEqual(a: number | null, b: number | null): boolean {
	if (a == null || b == null) return a == null && b == null;
	return Math.abs(a - b) < COST_EPSILON;
}

function valuesEqual(a: RowValues, b: RowValues): boolean {
	return (
		numberEqual(a.cost, b.cost) &&
		numberEqual(a.estimated_cost, b.estimated_cost) &&
		a.cost_known === b.cost_known &&
		a.input_tokens === b.input_tokens &&
		a.output_tokens === b.output_tokens &&
		a.cache_read_tokens === b.cache_read_tokens &&
		a.cache_creation_tokens === b.cache_creation_tokens
	);
}

const ROW_COLUMNS = `id, COALESCE(cost, 0) AS cost, estimated_cost,
	COALESCE(cost_known, 0) AS cost_known,
	COALESCE(input_tokens, 0) AS input_tokens,
	COALESCE(output_tokens, 0) AS output_tokens,
	COALESCE(cache_read_tokens, 0) AS cache_read_tokens,
	COALESCE(cache_creation_tokens, 0) AS cache_creation_tokens`;

function sessionRows(
	db: Database,
	table: "queries" | "usage_queries",
	sessionId: string,
): StoredRow[] {
	return db
		.query<StoredRow, [string]>(
			`SELECT ${ROW_COLUMNS} FROM ${table} WHERE session_id = ? ORDER BY id`,
		)
		.all(sessionId);
}

export function planSessionCostDriftRepair(
	db: Database,
	databasePath: string,
): SessionCostDriftManifest {
	const drifted = db
		.query<{ id: string; drift: number }, []>(
			`SELECT s.id,
				COALESCE(s.total_cost, 0) + COALESCE(s.total_estimated_cost, 0)
					- COALESCE(u.total, 0) AS drift
			 FROM sessions s
			 LEFT JOIN (
				SELECT session_id, SUM(COALESCE(cost, 0) + COALESCE(estimated_cost, 0)) AS total
				FROM usage_queries GROUP BY session_id
			 ) u ON u.session_id = s.id
			 WHERE ABS(COALESCE(s.total_cost, 0) + COALESCE(s.total_estimated_cost, 0)
				- COALESCE(u.total, 0)) > ${COST_EPSILON}
			 ORDER BY s.id`,
		)
		.all();

	const manifest: SessionCostDriftManifest = {
		version: SESSION_COST_DRIFT_REPAIR_VERSION,
		databasePath,
		sessions: [],
		rows: [],
		unresolved: [],
	};

	for (const session of drifted) {
		const queries = sessionRows(db, "queries", session.id);
		const usage = sessionRows(db, "usage_queries", session.id);
		if (queries.length !== usage.length) {
			manifest.unresolved.push({
				sessionId: session.id,
				reason: `row_count_mismatch:queries=${queries.length},usage_queries=${usage.length}`,
			});
			continue;
		}
		manifest.sessions.push({
			sessionId: session.id,
			driftBefore: session.drift,
		});
		for (let index = 0; index < queries.length; index++) {
			const before = rowValues(queries[index]);
			const after = rowValues(usage[index]);
			if (valuesEqual(before, after)) continue;
			manifest.rows.push({
				sessionId: session.id,
				queryId: queries[index].id,
				usageQueryId: usage[index].id,
				before,
				after,
			});
		}
	}
	return manifest;
}

function rebuildSessionTotals(db: Database, sessionId: string): void {
	db.run(
		`UPDATE sessions SET
			total_cost = COALESCE((SELECT SUM(cost) FROM queries WHERE session_id = ?), 0),
			total_estimated_cost = COALESCE((SELECT SUM(estimated_cost) FROM queries WHERE session_id = ?), 0),
			total_input_tokens = COALESCE((SELECT SUM(input_tokens) FROM queries WHERE session_id = ?), 0),
			total_output_tokens = COALESCE((SELECT SUM(output_tokens) FROM queries WHERE session_id = ?), 0),
			total_cache_read_tokens = COALESCE((SELECT SUM(cache_read_tokens) FROM queries WHERE session_id = ?), 0),
			total_cache_creation_tokens = COALESCE((SELECT SUM(cache_creation_tokens) FROM queries WHERE session_id = ?), 0),
			unpriced_query_count = COALESCE((
				SELECT SUM(CASE WHEN estimated_cost IS NULL AND cost_known = 0 THEN 1 ELSE 0 END)
				FROM queries WHERE session_id = ?), 0)
		 WHERE id = ?`,
		[
			sessionId,
			sessionId,
			sessionId,
			sessionId,
			sessionId,
			sessionId,
			sessionId,
			sessionId,
		],
	);
}

export function applySessionCostDriftRepair(
	db: Database,
	manifest: SessionCostDriftManifest,
): ApplySessionCostDriftResult {
	if (manifest.version !== SESSION_COST_DRIFT_REPAIR_VERSION) {
		throw new Error(
			`Unsupported session cost drift repair version: ${manifest.version}`,
		);
	}
	let updatedRows = 0;
	const transaction = db.transaction(() => {
		for (const row of manifest.rows) {
			const current = db
				.query<StoredRow, [number]>(
					`SELECT ${ROW_COLUMNS} FROM queries WHERE id = ?`,
				)
				.get(row.queryId);
			if (!current) {
				throw new Error(`Repair target disappeared for query ${row.queryId}`);
			}
			if (valuesEqual(rowValues(current), row.after)) continue;
			if (!valuesEqual(rowValues(current), row.before)) {
				throw new Error(
					`Repair fingerprint changed for query ${row.queryId}; no rows were updated`,
				);
			}
			db.run(
				`UPDATE queries SET cost = ?, estimated_cost = ?, cost_known = ?,
					input_tokens = ?, output_tokens = ?,
					cache_read_tokens = ?, cache_creation_tokens = ?
				 WHERE id = ?`,
				[
					row.after.cost,
					row.after.estimated_cost,
					row.after.cost_known,
					row.after.input_tokens,
					row.after.output_tokens,
					row.after.cache_read_tokens,
					row.after.cache_creation_tokens,
					row.queryId,
				],
			);
			updatedRows++;
		}
		for (const session of manifest.sessions) {
			rebuildSessionTotals(db, session.sessionId);
		}
	});
	transaction();
	return { updatedRows, rebuiltSessions: manifest.sessions.length };
}
