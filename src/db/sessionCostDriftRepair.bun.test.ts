import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { setDbForTest } from "./schema";
import {
	applySessionCostDriftRepair,
	planSessionCostDriftRepair,
} from "./sessionCostDriftRepair";
import { createSession, recordQuery } from "./sessions";
import type { QueryData } from "./types";

let testDb: Database;

function query(estimated_cost: number): QueryData {
	return {
		cost: 0,
		estimated_cost,
		input_tokens: 100,
		output_tokens: 20,
		cache_read_tokens: 80,
		cache_creation_tokens: 0,
		duration_ms: 500,
		turns: 1,
		context_window: null,
		stop_reason: "end_turn",
	};
}

/** Recreate the historical bug: queries rows kept cumulative costs while the
 * repaired usage_queries rows hold correct deltas. */
async function seedDriftedSession(id: string): Promise<void> {
	await createSession(id, "Drifted", "gpt-test");
	await recordQuery(id, query(1), "codex");
	await recordQuery(id, query(0.5), "codex");
	// Second queries row regresses to the cumulative value (1 + 0.5).
	testDb.run(
		`UPDATE queries SET estimated_cost = 1.5
		 WHERE session_id = ? AND id = (SELECT MAX(id) FROM queries WHERE session_id = ?)`,
		[id, id],
	);
	testDb.run(`UPDATE sessions SET total_estimated_cost = 2.5 WHERE id = ?`, [
		id,
	]);
}

describe("session cost drift repair", () => {
	beforeEach(() => {
		testDb = new Database(":memory:");
		setDbForTest(testDb);
	});

	it("plans only drifted sessions and repairs them back to the usage ledger", async () => {
		await seedDriftedSession("drifted");
		await createSession("clean", "Clean", "gpt-test");
		await recordQuery("clean", query(2), "codex");

		const manifest = planSessionCostDriftRepair(testDb, ":memory:");
		expect(manifest.sessions).toEqual([
			{ sessionId: "drifted", driftBefore: 1 },
		]);
		expect(manifest.rows).toHaveLength(1);
		expect(manifest.rows[0].before.estimated_cost).toBe(1.5);
		expect(manifest.rows[0].after.estimated_cost).toBe(0.5);
		expect(manifest.unresolved).toEqual([]);

		const result = applySessionCostDriftRepair(testDb, manifest);
		expect(result).toEqual({ updatedRows: 1, rebuiltSessions: 1 });

		const session = testDb
			.query<{ total_estimated_cost: number }, [string]>(
				`SELECT total_estimated_cost FROM sessions WHERE id = ?`,
			)
			.get("drifted");
		expect(session?.total_estimated_cost).toBe(1.5);
		expect(planSessionCostDriftRepair(testDb, ":memory:").sessions).toEqual([]);
	});

	it("leaves sessions with mismatched row counts unresolved", async () => {
		await seedDriftedSession("mismatch");
		testDb.run(
			`DELETE FROM queries WHERE session_id = ?
			 AND id = (SELECT MIN(id) FROM queries WHERE session_id = ?)`,
			["mismatch", "mismatch"],
		);

		const manifest = planSessionCostDriftRepair(testDb, ":memory:");
		expect(manifest.sessions).toEqual([]);
		expect(manifest.rows).toEqual([]);
		expect(manifest.unresolved).toEqual([
			{
				sessionId: "mismatch",
				reason: "row_count_mismatch:queries=1,usage_queries=2",
			},
		]);
	});

	it("refuses to apply when a row changed after planning", async () => {
		await seedDriftedSession("changed");
		const manifest = planSessionCostDriftRepair(testDb, ":memory:");
		testDb.run(`UPDATE queries SET estimated_cost = 9 WHERE id = ?`, [
			manifest.rows[0].queryId,
		]);
		expect(() => applySessionCostDriftRepair(testDb, manifest)).toThrow(
			/fingerprint changed/,
		);
	});
});
