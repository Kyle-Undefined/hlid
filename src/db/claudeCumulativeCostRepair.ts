import type { Database } from "bun:sqlite";
import { estimateProviderCost } from "../lib/providerPricing";

// v0.0.128 was the first published build after cumulative Claude SDK cost
// delta accounting was accidentally removed.
export const CLAUDE_CUMULATIVE_COST_BUG_STARTED_AT = 1_784_041_886;

type CostRow = {
	id: number;
	session_id: string | null;
	estimated_cost: number;
	timestamp: number;
	model: string | null;
	session_model: string | null;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
};

export type ClaudeCumulativeCostRepairResult = {
	queryRows: number;
	usageQueryRows: number;
};

const COST_EPSILON = 1e-9;

function repairRows(
	db: Database,
	table: "queries" | "usage_queries",
	rows: CostRow[],
): number {
	const previousBySession = new Map<string, number>();
	const update = db.prepare(
		`UPDATE ${table} SET estimated_cost = ? WHERE id = ?`,
	);
	let repaired = 0;

	for (const row of rows) {
		// NULL session ids cannot establish a trustworthy cumulative sequence.
		const sequence = row.session_id;
		if (!sequence) continue;
		const previous = previousBySession.get(sequence);
		const reported = row.estimated_cost;
		const expected = estimateProviderCost(
			"claude",
			row.model ?? row.session_model,
			{
				inputTokens: row.input_tokens,
				outputTokens: row.output_tokens,
				cacheReadTokens: row.cache_read_tokens,
				cacheCreationTokens: row.cache_creation_tokens,
			},
			row.timestamp * 1_000,
		);

		if (previous !== undefined && reported >= previous && expected !== null) {
			const delta = Math.max(0, reported - previous);
			// Token pricing is used only to distinguish an incremental row from a
			// cumulative snapshot. The replacement remains the provider-reported
			// delta, preserving real cache-TTL and billing details.
			if (
				Math.abs(delta - expected) + COST_EPSILON <
				Math.abs(reported - expected)
			) {
				update.run(delta, row.id);
				repaired++;
			}
		}
		previousBySession.set(sequence, reported);
	}

	return repaired;
}

/**
 * Repair cumulative Claude SDK totals stored as per-query estimates.
 *
 * Imported provider history is excluded because those rows were priced from
 * transcript calls rather than Raven's live SDK result stream. Rows without a
 * completed provider stop reason are also excluded because Hlid priced those
 * locally when an interrupted turn had no provider result.
 */
export function repairClaudeCumulativeCosts(
	db: Database,
): ClaudeCumulativeCostRepairResult {
	const queryRows = db
		.query<CostRow, [number]>(`
			SELECT q.id, q.session_id, q.estimated_cost, q.timestamp, q.model,
			       COALESCE(NULLIF(s.actual_model, ''), NULLIF(s.selected_model, ''),
			                NULLIF(s.model, '')) AS session_model,
			       q.input_tokens, q.output_tokens, q.cache_read_tokens,
			       q.cache_creation_tokens
			FROM queries q
			JOIN sessions s ON s.id = q.session_id
			WHERE q.timestamp >= ?
			  AND q.estimated_cost IS NOT NULL
			  AND q.stop_reason IS NOT NULL
			  AND COALESCE(q.provider_id, s.provider_id, 'claude') = 'claude'
			  AND COALESCE(s.history_imported, 0) = 0
			ORDER BY q.session_id, q.timestamp, q.id
		`)
		.all(CLAUDE_CUMULATIVE_COST_BUG_STARTED_AT);

	const usageRows = db
		.query<CostRow, [number]>(`
			SELECT u.id, u.session_id, u.estimated_cost, u.timestamp, u.model,
			       COALESCE(NULLIF(s.actual_model, ''), NULLIF(s.selected_model, ''),
			                NULLIF(s.model, '')) AS session_model,
			       u.input_tokens, u.output_tokens, u.cache_read_tokens,
			       u.cache_creation_tokens
			FROM usage_queries u
			LEFT JOIN sessions s ON s.id = u.session_id
			WHERE u.timestamp >= ?
			  AND u.estimated_cost IS NOT NULL
			  AND u.stop_reason IS NOT NULL
			  AND u.provider_id = 'claude'
			  AND COALESCE(s.history_imported, 0) = 0
			  AND NOT EXISTS (
				SELECT 1 FROM history_import_items h
				WHERE h.imported_usage_query_id = u.id
			  )
			ORDER BY u.session_id, u.timestamp, u.id
		`)
		.all(CLAUDE_CUMULATIVE_COST_BUG_STARTED_AT);

	const repairedQueries = repairRows(db, "queries", queryRows);
	const repairedUsageQueries = repairRows(db, "usage_queries", usageRows);

	db.run(`
		UPDATE sessions SET
			total_estimated_cost = COALESCE((
				SELECT SUM(estimated_cost) FROM queries
				WHERE session_id = sessions.id
			), 0)
		WHERE provider_id = 'claude'
	`);
	db.run(`DELETE FROM usage_daily`);
	db.run(`
		INSERT INTO usage_daily
			(date, cost, estimated_cost, unpriced_queries, queries, input_tokens,
			 output_tokens, cache_read_tokens, cache_creation_tokens, turns)
		SELECT DATE(timestamp, 'unixepoch', 'localtime'),
		       COALESCE(SUM(cost), 0), COALESCE(SUM(estimated_cost), 0),
		       COALESCE(SUM(unpriced), 0), COUNT(*),
		       COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
		       COALESCE(SUM(cache_read_tokens), 0),
		       COALESCE(SUM(cache_creation_tokens), 0), COALESCE(SUM(turns), 0)
		FROM usage_queries
		GROUP BY DATE(timestamp, 'unixepoch', 'localtime')
	`);

	return {
		queryRows: repairedQueries,
		usageQueryRows: repairedUsageQueries,
	};
}
