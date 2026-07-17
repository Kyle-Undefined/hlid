import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { getLedgerAnalytics } from "./ledgerAnalytics";
import { appendMessage, appendToolEvent, setToolEventResult } from "./messages";
import { setDbForTest } from "./schema";
import {
	createSession,
	recordQuery,
	setSessionAgentCwd,
	setSessionProviderId,
} from "./sessions";
import type { QueryData } from "./types";

let testDb: Database;

function query(stop_reason: string, cost: number): QueryData {
	return {
		cost,
		estimated_cost: 0,
		input_tokens: 100,
		output_tokens: 20,
		cache_read_tokens: 80,
		cache_creation_tokens: 0,
		duration_ms: 500,
		turns: 1,
		context_window: null,
		stop_reason,
	};
}

describe("Ledger filtered analytics", () => {
	beforeEach(() => {
		testDb = new Database(":memory:");
		setDbForTest(testDb);
	});

	it("applies agent, provider, and model filters to every breakdown", async () => {
		await createSession("codex-raven", "Codex", "gpt-5.6");
		await setSessionAgentCwd("codex-raven", "/agents/raven");
		await setSessionProviderId("codex-raven", "codex");
		await appendMessage("codex-raven", 1, "assistant", "done");
		await appendToolEvent("codex-raven", 1, "tool-1", "Bash", {});
		await setToolEventResult("codex-raven", "tool-1", "failed", true);
		await recordQuery("codex-raven", query("max_tokens", 2), "codex");

		await createSession("claude-vault", "Claude", "claude-sonnet");
		await setSessionProviderId("claude-vault", "claude");
		await recordQuery("claude-vault", query("end_turn", 1), "claude");

		const result = await getLedgerAnalytics({
			range: "all",
			agent: "/agents/raven",
			provider: "codex",
			model: "gpt-5.6",
		});

		expect(result.selected.queries).toBe(1);
		expect(result.selected.sessions).toBe(1);
		expect(result.selected.cost).toBe(2);
		expect(result.modelSplit).toEqual([{ model: "gpt-5.6", count: 1 }]);
		expect(result.stopReasonSplit).toEqual([
			{ reason: "max_tokens", count: 1 },
		]);
		expect(result.topTools).toEqual([{ name: "Bash", count: 1, errorRate: 1 }]);
		expect(result.weekdayHour.reduce((sum, row) => sum + row.count, 0)).toBe(1);
		expect(result.facets.providers).toEqual(["claude", "codex"]);
	});

	it("treats Today as the current local calendar day", async () => {
		await createSession("today", "Today", "current-model");
		await recordQuery("today", query("end_turn", 1), "codex");
		await createSession("yesterday", "Yesterday", "old-model");
		await recordQuery("yesterday", query("end_turn", 2), "codex");

		testDb
			.query(
				"UPDATE usage_queries SET timestamp = unixepoch('now', '-1 day') WHERE session_id = ?",
			)
			.run("yesterday");
		testDb
			.query(
				"UPDATE queries SET timestamp = unixepoch('now', '-1 day') WHERE session_id = ?",
			)
			.run("yesterday");

		const result = await getLedgerAnalytics({ range: "today" });

		expect(result.selected.queries).toBe(1);
		expect(result.selected.cost).toBe(1);
		expect(result.modelSplit).toEqual([{ model: "current-model", count: 1 }]);
		expect(result.trend.total).toBe(1);
	});

	it("uses inclusive local dates for a custom range", async () => {
		await createSession("in-range", "In range", "included-model");
		await recordQuery("in-range", query("end_turn", 1), "codex");
		await createSession("out-of-range", "Out of range", "excluded-model");
		await recordQuery("out-of-range", query("end_turn", 2), "codex");

		for (const [sessionId, timestamp] of [
			["in-range", Date.parse("2026-07-10T16:00:00Z") / 1000],
			["out-of-range", Date.parse("2026-07-11T16:00:00Z") / 1000],
		] as const) {
			testDb
				.query("UPDATE usage_queries SET timestamp = ? WHERE session_id = ?")
				.run(timestamp, sessionId);
			testDb
				.query("UPDATE queries SET timestamp = ? WHERE session_id = ?")
				.run(timestamp, sessionId);
		}

		const result = await getLedgerAnalytics({
			range: "custom",
			from: "2026-07-10",
			to: "2026-07-10",
		});

		expect(result.selected.queries).toBe(1);
		expect(result.selected.cost).toBe(1);
		expect(result.modelSplit).toEqual([{ model: "included-model", count: 1 }]);
		expect(result.trend.days).toEqual([{ date: "2026-07-10", count: 1 }]);
	});
});
