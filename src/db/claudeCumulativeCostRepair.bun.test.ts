import { describe, expect, it } from "bun:test";
import {
	CLAUDE_CUMULATIVE_COST_BUG_STARTED_AT,
	repairClaudeCumulativeCosts,
} from "./claudeCumulativeCostRepair";
import { freshDb } from "./db.test-utils";
import { initializeSchema } from "./schema";
import { createSession, recordQuery } from "./sessions";

const OPUS_MODEL = "claude-opus-5";

async function addClaudeQuery(
	sessionId: string,
	estimatedCost: number,
	inputTokens: number,
): Promise<void> {
	await recordQuery(
		sessionId,
		{
			cost: 0,
			cost_known: true,
			estimated_cost: estimatedCost,
			input_tokens: inputTokens,
			output_tokens: 0,
			cache_read_tokens: 0,
			cache_creation_tokens: 0,
			duration_ms: 100,
			turns: 1,
			context_window: null,
			stop_reason: "end_turn",
			tokens_in_context: inputTokens,
			model: OPUS_MODEL,
		},
		"claude",
	);
}

function costs(
	db: ReturnType<typeof freshDb>,
	table: "queries" | "usage_queries",
	sessionId: string,
): number[] {
	return db
		.query<{ estimated_cost: number }, [string]>(
			`SELECT estimated_cost FROM ${table}
			 WHERE session_id = ? ORDER BY timestamp, id`,
		)
		.all(sessionId)
		.map((row) => Number(row.estimated_cost.toFixed(12)));
}

describe("Claude cumulative cost repair", () => {
	it("repairs cumulative snapshots while preserving resets and incremental history", async () => {
		const db = freshDb();
		await createSession("affected", "Affected", OPUS_MODEL);
		// Expected per-query costs from fresh input are 0.1, 0.2, 0.5, 0.1.
		// The provider stream reports 0.1, 0.3, then resets before 0.5, 0.6.
		await addClaudeQuery("affected", 0.1, 20_000);
		await addClaudeQuery("affected", 0.3, 40_000);
		await addClaudeQuery("affected", 0.5, 100_000);
		await addClaudeQuery("affected", 0.6, 20_000);

		await createSession("correct", "Correct", OPUS_MODEL);
		await addClaudeQuery("correct", 0.1, 20_000);
		await addClaudeQuery("correct", 0.2, 40_000);

		await createSession("imported", "Imported", OPUS_MODEL);
		await addClaudeQuery("imported", 0.1, 20_000);
		await addClaudeQuery("imported", 0.3, 40_000);
		db.run(`UPDATE sessions SET history_imported = 1 WHERE id = 'imported'`);

		await createSession("old", "Old", OPUS_MODEL);
		await addClaudeQuery("old", 0.1, 20_000);
		await addClaudeQuery("old", 0.3, 40_000);
		db.run(`UPDATE queries SET timestamp = ? WHERE session_id = 'old'`, [
			CLAUDE_CUMULATIVE_COST_BUG_STARTED_AT - 1,
		]);
		db.run(`UPDATE usage_queries SET timestamp = ? WHERE session_id = 'old'`, [
			CLAUDE_CUMULATIVE_COST_BUG_STARTED_AT - 1,
		]);

		db.run(
			`DELETE FROM settings
			 WHERE key = '_migrated_claude_cumulative_cost_deltas_v2'`,
		);
		initializeSchema(db);
		expect(
			db
				.query<{ value: string }, []>(
					`SELECT value FROM settings
					 WHERE key = '_migrated_claude_cumulative_cost_deltas_v2'`,
				)
				.get(),
		).toEqual({ value: "1" });
		expect(costs(db, "queries", "affected")).toEqual([0.1, 0.2, 0.5, 0.1]);
		expect(costs(db, "usage_queries", "affected")).toEqual([
			0.1, 0.2, 0.5, 0.1,
		]);
		expect(costs(db, "queries", "correct")).toEqual([0.1, 0.2]);
		expect(costs(db, "queries", "imported")).toEqual([0.1, 0.3]);
		expect(costs(db, "queries", "old")).toEqual([0.1, 0.3]);
		expect(
			db
				.query<{ total_estimated_cost: number }, []>(
					`SELECT total_estimated_cost FROM sessions WHERE id = 'affected'`,
				)
				.get()?.total_estimated_cost,
		).toBeCloseTo(0.9);

		// Reapplying is safe even if a database is restored around migration state.
		expect(repairClaudeCumulativeCosts(db)).toEqual({
			queryRows: 0,
			usageQueryRows: 0,
		});
	});

	it("repairs the immutable Ledger rows of a deleted live session", async () => {
		const db = freshDb();
		await createSession("deleted", "Deleted", OPUS_MODEL);
		await addClaudeQuery("deleted", 0.1, 20_000);
		await addClaudeQuery("deleted", 0.3, 40_000);
		db.run(`DELETE FROM queries WHERE session_id = 'deleted'`);
		db.run(`DELETE FROM sessions WHERE id = 'deleted'`);

		expect(costs(db, "queries", "deleted")).toEqual([]);
		expect(repairClaudeCumulativeCosts(db)).toEqual({
			queryRows: 0,
			usageQueryRows: 1,
		});
		expect(costs(db, "usage_queries", "deleted")).toEqual([0.1, 0.2]);
	});
});
