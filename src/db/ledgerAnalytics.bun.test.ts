import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { getLedgerAnalytics, getLedgerToolErrors } from "./ledgerAnalytics";
import { appendMessage, appendToolEvent, setToolEventResult } from "./messages";
import { setDbForTest } from "./schema";
import {
	createSession,
	deleteSession,
	recordQuery,
	setSessionAgentCwd,
	setSessionModel,
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
		expect(result.topTools).toEqual([
			{ name: "Bash", count: 1, errorCount: 1, errorRate: 1 },
		]);
		await appendMessage("claude-vault", 1, "assistant", "failed");
		await appendToolEvent("claude-vault", 1, "tool-2", "Bash", {});
		await setToolEventResult("claude-vault", "tool-2", "other", true);
		const errors = await getLedgerToolErrors("Bash", {
			range: "all",
			agent: "/agents/raven",
			provider: "codex",
			model: "gpt-5.6",
		});
		expect(errors).toEqual({
			total: 1,
			distinct: 1,
			groups: [{ text: "failed", count: 1 }],
		});
		expect(result.weekdayHour.reduce((sum, row) => sum + row.count, 0)).toBe(1);
		expect(result.facets.providers).toEqual(["claude", "codex"]);
	});

	it("keeps every section attributed to the dimensions captured for that turn", async () => {
		await createSession("mixed", "Mixed", "model-a");
		await setSessionAgentCwd("mixed", "/agents/a");
		await setSessionProviderId("mixed", "claude");
		await appendMessage("mixed", 1, "assistant", "first");
		await appendToolEvent("mixed", 1, "tool-a", "Read", {}, undefined, {
			providerId: "claude",
			model: "model-a",
			agentCwd: "/agents/a",
		});
		await recordQuery(
			"mixed",
			{
				...query("end_turn", 1),
				model: "model-a",
				agent_cwd: "/agents/a",
			},
			"claude",
		);

		await setSessionAgentCwd("mixed", "/agents/b");
		await setSessionProviderId("mixed", "codex");
		await setSessionModel("mixed", "model-b");
		await appendMessage("mixed", 2, "assistant", "second");
		await appendToolEvent("mixed", 2, "tool-b", "Bash", {}, undefined, {
			providerId: "codex",
			model: "model-b",
			agentCwd: "/agents/b",
		});
		await recordQuery(
			"mixed",
			{
				...query("max_tokens", 2),
				model: "model-b",
				agent_cwd: "/agents/b",
			},
			"codex",
		);

		const first = await getLedgerAnalytics({
			range: "all",
			agent: "/agents/a",
			provider: "claude",
			model: "model-a",
		});
		expect(first.selected.queries).toBe(1);
		expect(first.modelSplit).toEqual([{ model: "model-a", count: 1 }]);
		expect(first.stopReasonSplit).toEqual([{ reason: "end_turn", count: 1 }]);
		expect(first.topTools).toEqual([
			{ name: "Read", count: 1, errorCount: 0, errorRate: 0 },
		]);
		expect(first.weekdayHour.reduce((sum, row) => sum + row.count, 0)).toBe(1);

		const second = await getLedgerAnalytics({
			range: "all",
			agent: "/agents/b",
			provider: "codex",
			model: "model-b",
		});
		expect(second.selected.queries).toBe(1);
		expect(second.stopReasonSplit).toEqual([
			{ reason: "max_tokens", count: 1 },
		]);
		expect(second.topTools[0]?.name).toBe("Bash");
	});

	it("reports exact filtered error totals independently from grouped detail limits", async () => {
		await createSession("errors", "Errors", "gpt-test");
		await setSessionProviderId("errors", "codex");
		await appendMessage("errors", 1, "assistant", "failed");
		for (const id of ["tool-1", "tool-2", "tool-3"]) {
			await appendToolEvent("errors", 1, id, "Bash", {});
		}
		await setToolEventResult("errors", "tool-1", "same error", true);
		await setToolEventResult("errors", "tool-2", "same error", true);
		testDb
			.query(
				"UPDATE tool_events SET is_error = 1, result_text = NULL WHERE tool_id = ?",
			)
			.run("tool-3");

		const result = await getLedgerToolErrors(
			"Bash",
			{ range: "all", provider: "codex" },
			1,
		);

		expect(result).toEqual({
			total: 3,
			distinct: 2,
			groups: [{ text: "same error", count: 2 }],
		});
	});

	it("keeps deleted-session usage in every split, matching the cost tiles", async () => {
		await createSession("kept", "Kept", "kept-model");
		await recordQuery("kept", query("end_turn", 1), "claude");
		await createSession("deleted", "Deleted", "deleted-model");
		await recordQuery("deleted", query("max_tokens", 2), "claude");
		await deleteSession("deleted");

		const result = await getLedgerAnalytics({ range: "all" });

		expect(result.selected.queries).toBe(2);
		expect(result.selected.cost).toBe(3);
		expect(result.selected.sessions).toBe(2);
		expect(result.modelSplit).toEqual([
			{ model: "deleted-model", count: 1 },
			{ model: "kept-model", count: 1 },
		]);
		expect(result.stopReasonSplit).toEqual([
			{ reason: "end_turn", count: 1 },
			{ reason: "max_tokens", count: 1 },
		]);
		expect(result.weekdayHour.reduce((sum, row) => sum + row.count, 0)).toBe(2);
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

	it("combines indexed tool timestamps with the legacy message fallback", async () => {
		await createSession("fast-tool", "Fast tool", "gpt-test");
		await appendMessage("fast-tool", 1, "assistant", "fast");
		await appendToolEvent("fast-tool", 1, "fast-1", "Read", {});

		await createSession("legacy-current", "Legacy current", "gpt-test");
		await appendMessage("legacy-current", 1, "assistant", "current");
		await appendToolEvent("legacy-current", 1, "legacy-1", "Read", {});
		testDb
			.query("UPDATE tool_events SET timestamp = NULL WHERE tool_id = ?")
			.run("legacy-1");

		await createSession("legacy-old", "Legacy old", "gpt-test");
		await appendMessage("legacy-old", 1, "assistant", "old");
		await appendToolEvent("legacy-old", 1, "legacy-old-1", "Read", {});
		testDb
			.query("UPDATE tool_events SET timestamp = NULL WHERE tool_id = ?")
			.run("legacy-old-1");
		testDb
			.query(
				"UPDATE messages SET timestamp = unixepoch('now', '-1 day') WHERE session_id = ?",
			)
			.run("legacy-old");

		const result = await getLedgerAnalytics({ range: "today" });

		expect(result.topTools).toEqual([
			{ name: "Read", count: 2, errorCount: 0, errorRate: 0 },
		]);
	});

	for (const [range, includedOffset, excludedOffset] of [
		["7d", "-6 days", "-7 days"],
		["30d", "-29 days", "-30 days"],
		["90d", "-89 days", "-90 days"],
	] as const) {
		it(`treats ${range} as exactly that many local calendar days`, async () => {
			await createSession("included", "Included", "included-model");
			await recordQuery("included", query("end_turn", 1), "codex");
			await createSession("excluded", "Excluded", "excluded-model");
			await recordQuery("excluded", query("end_turn", 2), "codex");

			for (const [sessionId, offset] of [
				["included", includedOffset],
				["excluded", excludedOffset],
			] as const) {
				testDb
					.query(
						`UPDATE usage_queries
						 SET timestamp = unixepoch('now', 'localtime', 'start of day', ?, 'utc')
						 WHERE session_id = ?`,
					)
					.run(offset, sessionId);
				testDb
					.query(
						`UPDATE queries
						 SET timestamp = unixepoch('now', 'localtime', 'start of day', ?, 'utc')
						 WHERE session_id = ?`,
					)
					.run(offset, sessionId);
			}

			const result = await getLedgerAnalytics({ range });

			expect(result.selected.queries).toBe(1);
			expect(result.selected.cost).toBe(1);
			expect(result.modelSplit).toEqual([
				{ model: "included-model", count: 1 },
			]);
		});
	}
});
