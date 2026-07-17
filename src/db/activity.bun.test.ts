/**
 * Activity aggregations — DB integration tests.
 * Requires Bun runtime (uses bun:sqlite).
 * Run with: bun test src/db/activity.bun.test.ts
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import {
	DURATION_BUCKETS_MS,
	getHourOfDayActivity,
	getLatencyDistribution,
	getModelSplit,
	getStopReasonSplit,
	getTopToolCalls,
} from "./activity";
import { appendMessage, appendToolEvent, setToolEventResult } from "./messages";
import { getDb, setDbForTest } from "./schema";
import { createSession, recordQuery, setSessionActualModel } from "./sessions";
import type { QueryData } from "./types";

function freshDb(): Database {
	const db = new Database(":memory:");
	setDbForTest(db);
	return db;
}

function baseQuery(overrides: Partial<QueryData> = {}): QueryData {
	return {
		cost: 0.001,
		input_tokens: 100,
		output_tokens: 50,
		cache_read_tokens: 0,
		cache_creation_tokens: 0,
		duration_ms: 500,
		turns: 1,
		context_window: null,
		stop_reason: "end_turn",
		tokens_in_context: null,
		...overrides,
	};
}

/**
 * Insert a query row with an explicit unix-epoch timestamp.
 * recordQuery() hardcodes unixepoch() so tests can't influence the time;
 * tests that need a specific hour-of-day bucket use this helper instead.
 */
async function insertQueryAt(
	sessionId: string,
	timestamp: number,
	durationMs: number,
	stopReason: string | null = null,
): Promise<void> {
	const db = await getDb();
	db.run(
		`INSERT INTO queries
			(session_id, timestamp, cost, input_tokens, output_tokens,
			 cache_read_tokens, cache_creation_tokens, duration_ms, turns,
			 context_window, stop_reason, tokens_in_context)
		 VALUES (?, ?, 0, 0, 0, 0, 0, ?, 0, NULL, ?, NULL)`,
		[sessionId, timestamp, durationMs, stopReason],
	);
}

async function addToolEvent(
	sessionId: string,
	seq: number,
	toolId: string,
	name: string,
	isError: boolean | null = null,
): Promise<void> {
	await appendToolEvent(sessionId, seq, toolId, name, {});
	if (isError !== null) {
		await setToolEventResult(sessionId, toolId, "result", isError);
	}
}

// ── getTopToolCalls ───────────────────────────────────────────────────────────

describe("activity — getTopToolCalls", () => {
	beforeEach(() => freshDb());

	it("returns [] on empty DB", async () => {
		expect(await getTopToolCalls()).toEqual([]);
	});

	it("groups by name, descending by count", async () => {
		await createSession("s1", "L", "m");
		await appendMessage("s1", 1, "assistant", "x");
		await addToolEvent("s1", 1, "t1", "Read");
		await addToolEvent("s1", 1, "t2", "Read");
		await addToolEvent("s1", 1, "t3", "Read");
		await addToolEvent("s1", 1, "t4", "Bash");
		await addToolEvent("s1", 1, "t5", "Bash");
		await addToolEvent("s1", 1, "t6", "Grep");

		const top = await getTopToolCalls();
		expect(top.map((t) => t.name)).toEqual(["Read", "Bash", "Grep"]);
		expect(top.map((t) => t.count)).toEqual([3, 2, 1]);
	});

	it("computes errorRate from is_error", async () => {
		await createSession("s1", "L", "m");
		await appendMessage("s1", 1, "assistant", "x");
		await addToolEvent("s1", 1, "a", "Bash", false);
		await addToolEvent("s1", 1, "b", "Bash", true);
		await addToolEvent("s1", 1, "c", "Bash", true);
		await addToolEvent("s1", 1, "d", "Bash", true);

		const [bash] = await getTopToolCalls();
		expect(bash.count).toBe(4);
		expect(bash.errorCount).toBe(3);
		expect(bash.errorRate).toBeCloseTo(0.75, 5);
	});

	it("treats NULL is_error as success", async () => {
		await createSession("s1", "L", "m");
		await appendMessage("s1", 1, "assistant", "x");
		await addToolEvent("s1", 1, "a", "Read"); // no setToolEventResult — is_error stays NULL
		await addToolEvent("s1", 1, "b", "Read");

		const [read] = await getTopToolCalls();
		expect(read.count).toBe(2);
		expect(read.errorCount).toBe(0);
		expect(read.errorRate).toBe(0);
	});

	it("respects limit parameter (default 10)", async () => {
		await createSession("s1", "L", "m");
		await appendMessage("s1", 1, "assistant", "x");
		for (let i = 0; i < 15; i++) {
			await addToolEvent("s1", 1, `t${i}`, `Tool${i}`);
		}
		expect((await getTopToolCalls()).length).toBe(10);
		expect((await getTopToolCalls(5)).length).toBe(5);
		expect((await getTopToolCalls(20)).length).toBe(15);
	});
});

// ── getHourOfDayActivity ──────────────────────────────────────────────────────

describe("activity — getHourOfDayActivity", () => {
	beforeEach(() => freshDb());

	it("returns length-24 zero array on empty DB", async () => {
		const hod = await getHourOfDayActivity();
		expect(hod.length).toBe(24);
		expect(hod.every((h, i) => h.hour === i && h.count === 0)).toBe(true);
	});

	it("buckets queries by local hour and accumulates", async () => {
		await createSession("s1", "L", "m");
		// We can't predict the JS-runner TZ vs the SQLite C-runtime TZ
		// (bun test forces UTC for Intl but SQLite reads system TZ), so use
		// timestamps spaced 7 hours apart and assert the bucketing shape
		// rather than specific hour indices.
		const t0 = 1_700_000_000;
		await insertQueryAt("s1", t0, 100);
		await insertQueryAt("s1", t0 + 60, 100);
		await insertQueryAt("s1", t0 + 120, 100);
		await insertQueryAt("s1", t0 + 7 * 3600, 100);
		await insertQueryAt("s1", t0 + 7 * 3600 + 60, 100);

		const hod = await getHourOfDayActivity();
		expect(hod.length).toBe(24);
		expect(hod.reduce((a, h) => a + h.count, 0)).toBe(5);
		const nonZero = hod.filter((h) => h.count > 0);
		expect(nonZero.length).toBe(2);
		expect(nonZero.map((h) => h.count).sort((a, b) => b - a)).toEqual([3, 2]);
	});
});

// ── getLatencyDistribution ────────────────────────────────────────────────────

describe("activity — getLatencyDistribution", () => {
	beforeEach(() => freshDb());

	it("returns all-zero on empty DB", async () => {
		const d = await getLatencyDistribution();
		expect(d.total).toBe(0);
		expect(d.p50).toBe(0);
		expect(d.p95).toBe(0);
		expect(d.buckets.length).toBe(DURATION_BUCKETS_MS.length - 1);
		expect(d.buckets.every((b) => b.count === 0)).toBe(true);
	});

	it("skips rows where duration_ms is 0 or NULL", async () => {
		await createSession("s1", "L", "m");
		await insertQueryAt("s1", 1_700_000_000, 0);
		const db = await getDb();
		db.run(
			`INSERT INTO queries (session_id, timestamp, duration_ms) VALUES (?, ?, NULL)`,
			["s1", 1_700_000_001],
		);
		const d = await getLatencyDistribution();
		expect(d.total).toBe(0);
	});

	it("places values into correct buckets at boundaries", async () => {
		await createSession("s1", "L", "m");
		// Bucket edges [0, 100, 500, 1000, 5000, 15000, 60000, Infinity]
		// 99 → <100, 100 → 100-500, 499 → 100-500, 500 → 500-1k,
		// 60000 → 60k+, 60001 → 60k+
		const vals = [99, 100, 499, 500, 60_000, 60_001];
		for (let i = 0; i < vals.length; i++) {
			await insertQueryAt("s1", 1_700_000_000 + i, vals[i]);
		}
		const d = await getLatencyDistribution();
		expect(d.total).toBe(6);
		expect(d.buckets[0].count).toBe(1); // <100
		expect(d.buckets[1].count).toBe(2); // 100-500
		expect(d.buckets[2].count).toBe(1); // 500-1k
		expect(d.buckets[6].count).toBe(2); // 60k+
	});

	it("computes p50 and p95 over [10..100]", async () => {
		await createSession("s1", "L", "m");
		const vals = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
		for (let i = 0; i < vals.length; i++) {
			await insertQueryAt("s1", 1_700_000_000 + i, vals[i]);
		}
		const d = await getLatencyDistribution();
		// floor(10 * 0.5) = 5 → vals[5] = 60; floor(10 * 0.95) = 9 → vals[9] = 100
		expect(d.p50).toBe(60);
		expect(d.p95).toBe(100);
		expect(d.total).toBe(10);
	});
});

// ── getModelSplit ─────────────────────────────────────────────────────────────

describe("activity — getModelSplit", () => {
	beforeEach(() => freshDb());

	it("returns [] on empty DB", async () => {
		expect(await getModelSplit()).toEqual([]);
	});

	it("groups by COALESCE(actual_model, model) descending", async () => {
		await createSession("s1", "L", "claude-sonnet-4-5");
		await createSession("s2", "L", "claude-sonnet-4-5");
		await createSession("s3", "L", "claude-opus-4-1");

		const split = await getModelSplit();
		expect(split[0].model).toBe("claude-sonnet-4-5");
		expect(split[0].count).toBe(2);
		expect(split[1].model).toBe("claude-opus-4-1");
		expect(split[1].count).toBe(1);
	});

	it("actual_model overrides model", async () => {
		await createSession("s1", "L", "claude-sonnet-4-5");
		await setSessionActualModel("s1", "claude-opus-4-7");
		await createSession("s2", "L", "claude-sonnet-4-5");

		const split = await getModelSplit();
		const byModel = new Map(split.map((m) => [m.model, m.count]));
		expect(byModel.get("claude-opus-4-7")).toBe(1);
		expect(byModel.get("claude-sonnet-4-5")).toBe(1);
	});

	it("excludes sessions where both model and actual_model are NULL", async () => {
		const db = await getDb();
		db.run(`INSERT INTO sessions (id, started_at) VALUES (?, unixepoch())`, [
			"null-session",
		]);
		await createSession("s1", "L", "claude-sonnet-4-5");

		const split = await getModelSplit();
		expect(split.length).toBe(1);
		expect(split[0].model).toBe("claude-sonnet-4-5");
	});
});

// ── getStopReasonSplit ────────────────────────────────────────────────────────

describe("activity — getStopReasonSplit", () => {
	beforeEach(() => freshDb());

	it("returns [] on empty DB", async () => {
		expect(await getStopReasonSplit()).toEqual([]);
	});

	it("groups by stop_reason descending, excludes NULL", async () => {
		await createSession("s1", "L", "m");
		await recordQuery("s1", baseQuery({ stop_reason: "end_turn" }));
		await recordQuery("s1", baseQuery({ stop_reason: "end_turn" }));
		await recordQuery("s1", baseQuery({ stop_reason: "tool_use" }));
		await recordQuery("s1", baseQuery({ stop_reason: "max_tokens" }));
		await recordQuery("s1", baseQuery({ stop_reason: null }));

		const split = await getStopReasonSplit();
		// Ties broken by reason ASC, so end_turn (count 2) first,
		// then max_tokens, then tool_use (both count 1).
		expect(split.map((s) => s.reason)).toEqual([
			"end_turn",
			"max_tokens",
			"tool_use",
		]);
		expect(split.map((s) => s.count)).toEqual([2, 1, 1]);
	});
});
