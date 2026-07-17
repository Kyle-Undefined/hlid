/**
 * DB layer integration tests.
 * Requires Bun runtime (uses bun:sqlite).
 * Run with: bun test src/db/
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import {
	ANALYTICS_SCOPES,
	getAnalyticsRevision,
	resetAnalyticsRevisionForTest,
} from "./analyticsRevision";
import {
	createAttachment,
	deleteAttachment,
	getAttachment,
	getAttachmentsForSession,
	linkAttachmentToMessage,
	listAttachments,
} from "./attachments";
import { appendLog, clearLogs, getLogs } from "./logs";
import {
	appendAskUserQuestion,
	appendMessage,
	appendPlanProposal,
	appendToolEvent,
	getSessionAskUserQuestions,
	getSessionMessages,
	getSessionNextMessageSeq,
	getSessionPlanProposals,
	getSessionToolEventDetail,
	getSessionToolEventSummaries,
	setAskUserQuestionResolution,
	setMessageRecap,
	setToolEventResult,
	setToolEventSubagent,
} from "./messages";
import {
	getSessionPermissionEvents,
	recordPermissionEvent,
} from "./permissions";
import { setDbForTest } from "./schema";
import {
	createSession,
	deleteSession,
	deleteSessionsOlderThan,
	getRecentSessions,
	getSessionActualModel,
	getSessionAgentCwd,
	getSessionClaudeId,
	getSessionLastQueryContext,
	getSessionModel,
	getSessionProviderId,
	getSessionProviderSession,
	getSessionSelection,
	getSessionsPaginated,
	recordQuery,
	setSessionActualModel,
	setSessionAgentCwd,
	setSessionClaudeId,
	setSessionEffort,
	setSessionModel,
	setSessionPermissionMode,
	setSessionProviderId,
	setSessionProviderSession,
} from "./sessions";
import {
	clearCurrentSessionId,
	getCurrentSessionId,
	getSetting,
	saveSetting,
	setCurrentSessionId,
} from "./settings";
import type { QueryData } from "./types";
import {
	getAggregatedStats,
	getProviderUsage,
	getThirtyDayStats,
	getUsageWindows,
	getWeeklyStats,
	registerProvider,
} from "./usage";

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

describe("analytics revisions", () => {
	beforeEach(() => {
		freshDb();
		resetAnalyticsRevisionForTest();
	});

	it("advances every aggregate scope after a query commits", async () => {
		await createSession("revision-query", "Query", "sonnet");
		resetAnalyticsRevisionForTest();

		await recordQuery("revision-query", baseQuery());

		for (const scope of ANALYTICS_SCOPES) {
			expect(getAnalyticsRevision(scope)).toBeGreaterThan(0);
		}
	});

	it("invalidates only activity aggregates for a tool event", async () => {
		await createSession("revision-tool", "Tool", "sonnet");
		resetAnalyticsRevisionForTest();

		await appendToolEvent("revision-tool", 1, "tool-1", "Read", {});

		expect(getAnalyticsRevision("activity")).toBeGreaterThan(0);
		expect(getAnalyticsRevision("stats")).toBe(0);
		expect(getAnalyticsRevision("providerUsage")).toBe(0);
	});

	it("invalidates Ledger activity snapshots when agent or provider metadata changes", async () => {
		await createSession("revision-session", "Session", "sonnet");
		for (const mutate of [
			() => setSessionAgentCwd("revision-session", "/agents/raven"),
			() => setSessionProviderId("revision-session", "codex"),
			() =>
				setSessionProviderSession(
					"revision-session",
					"claude",
					"claude-session",
				),
		]) {
			resetAnalyticsRevisionForTest();
			await mutate();
			expect(getAnalyticsRevision("stats")).toBeGreaterThan(0);
			expect(getAnalyticsRevision("activity")).toBeGreaterThan(0);
		}
	});

	it("invalidates provider snapshots for rate-limit settings only", async () => {
		await saveSetting("theme", "dark");
		expect(getAnalyticsRevision("providerUsage")).toBe(0);

		await saveSetting("rl_claude_weekly", "{}");
		expect(getAnalyticsRevision("providerUsage")).toBeGreaterThan(0);
	});
});

// ── settings ──────────────────────────────────────────────────────────────────

describe("settings", () => {
	beforeEach(() => freshDb());

	it("returns null for missing key", async () => {
		expect(await getSetting("nonexistent")).toBeNull();
	});

	it("saves and retrieves a setting", async () => {
		await saveSetting("theme", "dark");
		expect(await getSetting("theme")).toBe("dark");
	});

	it("overwrites existing setting on save", async () => {
		await saveSetting("theme", "light");
		await saveSetting("theme", "dark");
		expect(await getSetting("theme")).toBe("dark");
	});

	it("setCurrentSessionId / getCurrentSessionId roundtrip", async () => {
		await setCurrentSessionId("sess-abc");
		expect(await getCurrentSessionId()).toBe("sess-abc");
	});

	it("clearCurrentSessionId removes the value", async () => {
		await setCurrentSessionId("sess-abc");
		await clearCurrentSessionId();
		expect(await getCurrentSessionId()).toBeNull();
	});
});

// ── sessions ──────────────────────────────────────────────────────────────────

describe("sessions — create & fetch", () => {
	beforeEach(() => freshDb());

	it("creates a session and retrieves it", async () => {
		await createSession("s1", "HELLO WORLD", "claude-sonnet");
		const rows = await getRecentSessions();
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe("s1");
		expect(rows[0].label).toBe("HELLO WORLD");
		expect(rows[0].model).toBe("claude-sonnet");
	});

	it("INSERT OR IGNORE: duplicate createSession is silent", async () => {
		await createSession("s1", "FIRST", "model-a");
		await createSession("s1", "SECOND", "model-b");
		const rows = await getRecentSessions();
		expect(rows).toHaveLength(1);
		expect(rows[0].label).toBe("FIRST");
	});

	it("getRecentSessions respects limit", async () => {
		for (let i = 0; i < 5; i++) {
			await createSession(`s${i}`, `S${i}`, "m");
		}
		const rows = await getRecentSessions(3);
		expect(rows).toHaveLength(3);
	});

	it("getSessionsPaginated returns correct page", async () => {
		for (let i = 0; i < 5; i++) {
			await createSession(`s${i}`, `S${i}`, "m");
		}
		const { sessions, total } = await getSessionsPaginated(1, 3);
		expect(total).toBe(5);
		expect(sessions).toHaveLength(3);
	});

	it("getSessionsPaginated filters by label search with LIKE escaping", async () => {
		await createSession("s1", "refactor auth", "m");
		await createSession("s2", "100% done", "m");
		await createSession("s3", "unrelated", "m");

		const byWord = await getSessionsPaginated(1, 10, { search: "refactor" });
		expect(byWord.total).toBe(1);
		expect(byWord.sessions[0].id).toBe("s1");
		// filtered total, but oldest reflects all sessions
		expect(byWord.oldest_started_at).not.toBeNull();

		const byPercent = await getSessionsPaginated(1, 10, { search: "100%" });
		expect(byPercent.total).toBe(1);
		expect(byPercent.sessions[0].id).toBe("s2");
	});

	it("getSessionsPaginated searches labels without requiring accents", async () => {
		await createSession("grimr", "Grímr planning", "m");
		await createSession("other", "Other project", "m");

		const result = await getSessionsPaginated(1, 10, { search: "Grimr" });
		expect(result.total).toBe(1);
		expect(result.sessions[0].id).toBe("grimr");
	});

	it("getSessionsPaginated sorts by cost and tokens", async () => {
		await createSession("cheap", "A", "m");
		await createSession("pricey", "B", "m");
		await recordQuery("cheap", baseQuery({ cost: 0.1, input_tokens: 10 }));
		await recordQuery("pricey", baseQuery({ cost: 5, input_tokens: 9000 }));

		const byCost = await getSessionsPaginated(1, 10, { sort: "cost" });
		expect(byCost.sessions[0].id).toBe("pricey");
		const byTokens = await getSessionsPaginated(1, 10, { sort: "tokens" });
		expect(byTokens.sessions[0].id).toBe("pricey");
	});

	it("getSessionsPaginated filters Vault and Einherjar sessions, then model", async () => {
		await createSession("vault", "Vault chat", "claude-sonnet");
		await createSession("raven-fast", "Raven fast", "configured-model");
		await setSessionAgentCwd("raven-fast", "/agents/raven");
		await setSessionActualModel("raven-fast", "gpt-5.4");
		await createSession("raven-deep", "Raven deep", "gpt-5.4-pro");
		await setSessionAgentCwd("raven-deep", "/agents/raven");
		await createSession("forge", "Forge chat", "claude-opus");
		await setSessionAgentCwd("forge", "/agents/forge");

		const vault = await getSessionsPaginated(1, 10, { agent: "vault" });
		expect(vault.sessions.map((row) => row.id)).toEqual(["vault"]);
		expect(vault.models).toEqual(["claude-sonnet"]);

		const raven = await getSessionsPaginated(1, 10, {
			agent: "/agents/raven",
		});
		expect(raven.total).toBe(2);
		expect(raven.models).toEqual(["gpt-5.4", "gpt-5.4-pro"]);
		expect(raven.agent_cwds).toEqual(["/agents/forge", "/agents/raven"]);

		const exactModel = await getSessionsPaginated(1, 10, {
			agent: "/agents/raven",
			model: "gpt-5.4",
		});
		expect(exactModel.sessions.map((row) => row.id)).toEqual(["raven-fast"]);
		// The facet remains owner-scoped so the user can switch models directly.
		expect(exactModel.models).toEqual(["gpt-5.4", "gpt-5.4-pro"]);
	});

	it("getSessionsPaginated keeps model and stop drill-downs inside the selected dates", async () => {
		const database = freshDb();
		for (const [id, model, stopReason] of [
			["inside-stop", "model-a", "max_tokens"],
			["outside-stop", "model-a", "max_tokens"],
			["inside-other", "model-a", "end_turn"],
		] as const) {
			await createSession(id, id, model);
			await recordQuery(id, baseQuery({ stop_reason: stopReason }));
		}
		for (const [id, timestamp] of [
			["inside-stop", Date.parse("2026-07-10T16:00:00Z") / 1000],
			["outside-stop", Date.parse("2026-07-11T16:00:00Z") / 1000],
			["inside-other", Date.parse("2026-07-10T17:00:00Z") / 1000],
		] as const) {
			database
				.query("UPDATE queries SET timestamp = ? WHERE session_id = ?")
				.run(timestamp, id);
		}

		const byModel = await getSessionsPaginated(1, 10, {
			model: "model-a",
			range: "custom",
			from: "2026-07-10",
			to: "2026-07-10",
		});
		expect(byModel.sessions.map((row) => row.id).sort()).toEqual([
			"inside-other",
			"inside-stop",
		]);

		const byStop = await getSessionsPaginated(1, 10, {
			stop: "max_tokens",
			range: "custom",
			from: "2026-07-10",
			to: "2026-07-10",
		});
		expect(byStop.sessions.map((row) => row.id)).toEqual(["inside-stop"]);

		const allMatchingStop = await getSessionsPaginated(1, 10, {
			stop: "max_tokens",
			range: "all",
		});
		expect(allMatchingStop.total).toBe(2);
	});

	it("Stats drill-downs use query dimensions after a session switches", async () => {
		await createSession("mixed", "Mixed", "model-a");
		await recordQuery(
			"mixed",
			baseQuery({ model: "model-a", agent_cwd: "/agents/a" }),
			"claude",
		);
		await setSessionModel("mixed", "model-b");
		await setSessionAgentCwd("mixed", "/agents/b");
		await setSessionProviderId("mixed", "codex");

		const historical = await getSessionsPaginated(1, 10, {
			agent: "/agents/a",
			model: "model-a",
			provider: "claude",
			range: "all",
		});
		expect(historical.sessions.map((row) => row.id)).toEqual(["mixed"]);

		const currentMetadata = await getSessionsPaginated(1, 10, {
			agent: "/agents/b",
			model: "model-b",
			provider: "codex",
			range: "all",
		});
		expect(currentMetadata.total).toBe(0);
	});

	it("getSessionsPaginated reports null oldest_started_at when empty", async () => {
		const { oldest_started_at, total } = await getSessionsPaginated(1, 10);
		expect(total).toBe(0);
		expect(oldest_started_at).toBeNull();
	});
});

describe("sessions — claude_session_id", () => {
	beforeEach(() => freshDb());

	it("returns null when never set", async () => {
		await createSession("s1", "L", "m");
		expect(await getSessionClaudeId("s1")).toBeNull();
	});

	it("sets and gets claude_session_id", async () => {
		await createSession("s1", "L", "m");
		await setSessionClaudeId("s1", "claude-uuid-123");
		expect(await getSessionClaudeId("s1")).toBe("claude-uuid-123");
	});

	it("setSessionClaudeId(null) clears the value", async () => {
		await createSession("s1", "L", "m");
		await setSessionClaudeId("s1", "claude-uuid-123");
		await setSessionClaudeId("s1", null);
		expect(await getSessionClaudeId("s1")).toBeNull();
	});
});

describe("sessions — provider sessions", () => {
	beforeEach(() => freshDb());

	it("persists the active provider id separately from provider session id", async () => {
		await createSession("s1", "L", "m");
		await setSessionProviderId("s1", "codex");
		expect(await getSessionProviderId("s1")).toBe("codex");
		expect(await getSessionProviderSession("s1")).toBeNull();
	});

	it("stores and gates resume ids by provider", async () => {
		await createSession("s1", "L", "m");
		await setSessionProviderSession("s1", "codex", "codex-thread-123");
		expect(await getSessionProviderId("s1")).toBe("codex");
		expect(await getSessionProviderSession("s1")).toBe("codex-thread-123");
		expect(await getSessionProviderSession("s1", "codex")).toBe(
			"codex-thread-123",
		);
		expect(await getSessionProviderSession("s1", "claude")).toBeNull();
		expect(await getSessionClaudeId("s1")).toBeNull();
	});

	it("keeps the legacy Claude helper compatible", async () => {
		await createSession("s1", "L", "m");
		await setSessionClaudeId("s1", "claude-uuid-123");
		expect(await getSessionProviderId("s1")).toBe("claude");
		expect(await getSessionProviderSession("s1", "claude")).toBe(
			"claude-uuid-123",
		);
	});
});

describe("sessions — agent_cwd & actual_model", () => {
	beforeEach(() => freshDb());

	it("sets and gets agent_cwd", async () => {
		await createSession("s1", "L", "m");
		await setSessionAgentCwd("s1", "/home/kyle/agents/bot");
		expect(await getSessionAgentCwd("s1")).toBe("/home/kyle/agents/bot");
	});

	it("returns null agent_cwd when unset", async () => {
		await createSession("s1", "L", "m");
		expect(await getSessionAgentCwd("s1")).toBeNull();
	});

	it("sets and gets the session-selected model", async () => {
		await createSession("s1", "L", "gpt-5.6-sol");
		expect(await getSessionModel("s1")).toBe("gpt-5.6-sol");
		await setSessionModel("s1", "claude-fable-5");
		expect(await getSessionModel("s1")).toBe("claude-fable-5");
	});

	it("persists and reads all Raven session controls together", async () => {
		await createSession("s1", "L", "gpt-5.6-sol", {
			effort: "high",
			permissionMode: "bypassPermissions",
		});
		await setSessionAgentCwd("s1", "/home/kyle/agents/hlid");
		await setSessionProviderId("s1", "codex");

		expect(await getSessionSelection("s1")).toEqual({
			agentCwd: "/home/kyle/agents/hlid",
			providerId: "codex",
			model: "gpt-5.6-sol",
			effort: "high",
			permissionMode: "bypassPermissions",
		});

		await setSessionModel("s1", "gpt-5.6-terra");
		await setSessionEffort("s1", "xhigh");
		await setSessionPermissionMode("s1", "default");
		expect(await getSessionSelection("s1")).toMatchObject({
			model: "gpt-5.6-terra",
			effort: "xhigh",
			permissionMode: "default",
		});
	});

	it("leaves legacy session controls null so configured defaults can apply", async () => {
		await createSession("s1", "L", "gpt-5.6-sol");
		expect(await getSessionSelection("s1")).toEqual({
			agentCwd: null,
			providerId: "claude",
			model: "gpt-5.6-sol",
			effort: null,
			permissionMode: null,
		});
	});

	it("falls back to the actual model for a legacy session", async () => {
		const database = freshDb();
		await createSession("s1", "L", "gpt-5.6-sol");
		database.run(
			`UPDATE sessions SET selected_model = NULL, actual_model = ? WHERE id = ?`,
			["claude-fable-5", "s1"],
		);
		expect(await getSessionModel("s1")).toBe("claude-fable-5");
	});

	it("sets and gets actual_model", async () => {
		await createSession("s1", "L", "m");
		await setSessionActualModel("s1", "claude-opus-4-5");
		expect(await getSessionActualModel("s1")).toBe("claude-opus-4-5");
	});
});

describe("sessions — recordQuery", () => {
	beforeEach(() => freshDb());

	it("increments session counters on recordQuery", async () => {
		await createSession("s1", "L", "m");
		await recordQuery(
			"s1",
			baseQuery({ cost: 0.05, input_tokens: 200, output_tokens: 80, turns: 2 }),
		);
		const rows = await getRecentSessions();
		expect(rows[0].query_count).toBe(1);
		expect(rows[0].total_cost).toBeCloseTo(0.05);
		expect(rows[0].total_input_tokens).toBe(200);
		expect(rows[0].total_turns).toBe(2);
	});

	it("accumulates across multiple queries", async () => {
		await createSession("s1", "L", "m");
		await recordQuery("s1", baseQuery({ cost: 0.01, input_tokens: 100 }));
		await recordQuery("s1", baseQuery({ cost: 0.02, input_tokens: 200 }));
		const rows = await getRecentSessions();
		expect(rows[0].query_count).toBe(2);
		expect(rows[0].total_cost).toBeCloseTo(0.03);
		expect(rows[0].total_input_tokens).toBe(300);
	});

	it("stores Codex API estimates separately from provider-reported cost", async () => {
		await createSession("s1", "L", "gpt-5.6-terra");
		await recordQuery(
			"s1",
			baseQuery({ cost: 0, estimated_cost: 0.125 }),
			"codex",
		);
		const rows = await getRecentSessions();
		expect(rows[0].total_cost).toBe(0);
		expect(rows[0].total_estimated_cost).toBeCloseTo(0.125);
		expect(rows[0].unpriced_query_count).toBe(0);
		const agg = await getAggregatedStats();
		expect(agg.today.cost).toBe(0);
		expect(agg.today.estimated_cost).toBeCloseTo(0.125);
	});

	it("stores Claude per-run estimates without subtracting prior queries", async () => {
		await createSession("s1", "L", "claude-fable-5");
		const first = await recordQuery(
			"s1",
			baseQuery({ cost: 0, estimated_cost: 3.81798 }),
			"claude",
		);
		const second = await recordQuery(
			"s1",
			baseQuery({ cost: 0, estimated_cost: 2.225037 }),
			"claude",
		);

		expect(first.estimatedCost).toBeCloseTo(3.81798);
		expect(second.estimatedCost).toBeCloseTo(2.225037);
		const rows = await getRecentSessions();
		expect(rows[0].total_estimated_cost).toBeCloseTo(6.043017);
		const agg = await getAggregatedStats();
		expect(agg.today.estimated_cost).toBeCloseTo(6.043017);
	});

	it("migrates historical Claude CLI cost into the estimated bucket", async () => {
		const database = freshDb();
		await createSession("s1", "L", "claude-opus-4-6");
		await recordQuery(
			"s1",
			baseQuery({ cost: 0.25, estimated_cost: null }),
			"claude",
		);

		// Simulate a database created before the provenance correction by making
		// just this migration pending, then initialize the schema again.
		database.run(
			`DELETE FROM settings WHERE key = '_migrated_claude_costs_to_estimates'`,
		);
		setDbForTest(database);

		const rows = await getRecentSessions();
		expect(rows[0].total_cost).toBe(0);
		expect(rows[0].total_estimated_cost).toBeCloseTo(0.25);
		const agg = await getAggregatedStats();
		expect(agg.today.cost).toBe(0);
		expect(agg.today.estimated_cost).toBeCloseTo(0.25);
	});

	it("marks Codex queries whose model has no published price", async () => {
		await createSession("s1", "L", "gpt-5.3-codex-spark");
		await recordQuery(
			"s1",
			baseQuery({ cost: 0, estimated_cost: null }),
			"codex",
		);
		const rows = await getRecentSessions();
		expect(rows[0].unpriced_query_count).toBe(1);
		const agg = await getAggregatedStats();
		expect(agg.today.unpriced_queries).toBe(1);
	});

	it("marks missing pricing telemetry unpriced for every provider", async () => {
		const database = freshDb();
		await createSession("s1", "L", "provider-model");
		await recordQuery(
			"s1",
			baseQuery({ cost: 0, cost_known: false, estimated_cost: null }),
			"acp:example",
		);

		const rows = await getRecentSessions();
		expect(rows[0].unpriced_query_count).toBe(1);
		expect(
			database
				.query(`SELECT cost_known, unpriced, provider_id FROM usage_queries`)
				.get(),
		).toEqual({
			cost_known: 0,
			unpriced: 1,
			provider_id: "acp:example",
		});
	});

	it("preserves a provider-reported known zero cost", async () => {
		const database = freshDb();
		await createSession("s1", "L", "local-model");
		await recordQuery(
			"s1",
			baseQuery({ cost: 0, cost_known: true, estimated_cost: null }),
			"acp:local",
		);

		expect((await getRecentSessions())[0].unpriced_query_count).toBe(0);
		expect(
			database.query(`SELECT cost_known, unpriced FROM usage_queries`).get(),
		).toEqual({ cost_known: 1, unpriced: 0 });
	});

	it("backfills provider-agnostic pricing provenance and aggregates", async () => {
		const database = freshDb();
		await createSession("unknown", "Unknown", "model");
		await createSession("actual", "Actual", "model");
		await createSession("estimated", "Estimated", "model");
		await recordQuery(
			"unknown",
			baseQuery({ cost: 0, estimated_cost: null }),
			"acp:example",
		);
		await recordQuery(
			"actual",
			baseQuery({ cost: 0.5, estimated_cost: null }),
			"acp:example",
		);
		await recordQuery(
			"estimated",
			baseQuery({ cost: 0, estimated_cost: 0.25 }),
			"claude",
		);

		// Simulate the legacy Codex-only provenance state, then rerun only the
		// data backfill (the structural cost_known migration already ran).
		database.run(`UPDATE queries SET cost_known = 0`);
		database.run(`UPDATE usage_queries SET cost_known = 0, unpriced = 0`);
		database.run(`UPDATE sessions SET unpriced_query_count = 0`);
		database.run(`UPDATE usage_daily SET unpriced_queries = 0`);
		database.run(
			`DELETE FROM settings WHERE key = '_migrated_provider_agnostic_unpriced'`,
		);
		setDbForTest(database);

		expect(
			database
				.query(
					`SELECT session_id, cost_known, unpriced FROM usage_queries ORDER BY session_id`,
				)
				.all(),
		).toEqual([
			{ session_id: "actual", cost_known: 1, unpriced: 0 },
			{ session_id: "estimated", cost_known: 1, unpriced: 0 },
			{ session_id: "unknown", cost_known: 0, unpriced: 1 },
		]);
		expect(
			database
				.query(`SELECT id, unpriced_query_count FROM sessions ORDER BY id`)
				.all(),
		).toEqual([
			{ id: "actual", unpriced_query_count: 0 },
			{ id: "estimated", unpriced_query_count: 0 },
			{ id: "unknown", unpriced_query_count: 1 },
		]);
		expect((await getAggregatedStats()).today.unpriced_queries).toBe(1);
	});

	it("getSessionLastQueryContext returns context_window from a query", async () => {
		await createSession("s1", "L", "m");
		await recordQuery(
			"s1",
			baseQuery({ context_window: 200_000, tokens_in_context: 5000 }),
		);
		const ctx = await getSessionLastQueryContext("s1");
		expect(ctx?.context_window).toBe(200_000);
		expect(ctx?.last_context_used).toBe(5000);
	});

	it("does not let an auxiliary recap replace the chat context reading", async () => {
		await createSession("s1", "L", "m");
		await recordQuery(
			"s1",
			baseQuery({ context_window: 200_000, tokens_in_context: 5000 }),
		);
		await recordQuery(
			"s1",
			baseQuery({
				context_window: 128_000,
				tokens_in_context: 100,
				stop_reason: "turn_recap",
			}),
		);

		const ctx = await getSessionLastQueryContext("s1");
		expect(ctx?.context_window).toBe(200_000);
		expect(ctx?.last_context_used).toBe(5000);
		const session = (await getRecentSessions())[0];
		expect(session.query_count).toBe(2);
		expect(session.total_input_tokens).toBe(200);
		expect(session.total_output_tokens).toBe(100);
		expect(session.total_turns).toBe(2);
		expect(session.total_cost).toBeCloseTo(0.002);
		const aggregate = await getAggregatedStats();
		expect(aggregate.today.queries).toBe(2);
		expect(aggregate.today.input_tokens).toBe(200);
		expect(aggregate.today.output_tokens).toBe(100);
	});

	it("getSessionLastQueryContext returns null for unknown session", async () => {
		await createSession("s1", "L", "m");
		expect(await getSessionLastQueryContext("nonexistent")).toBeNull();
	});
});

describe("sessions — deleteSession", () => {
	beforeEach(() => freshDb());

	it("removes session and all related rows", async () => {
		await createSession("s1", "L", "m");
		await appendMessage("s1", 0, "user", "hello");
		await recordQuery("s1", baseQuery());
		await deleteSession("s1");
		expect(await getRecentSessions()).toHaveLength(0);
		expect(await getSessionMessages("s1")).toHaveLength(0);
	});
});

// ── messages ──────────────────────────────────────────────────────────────────

describe("messages", () => {
	beforeEach(() => freshDb());

	it("appends and retrieves messages in seq order", async () => {
		await createSession("s1", "L", "m");
		await appendMessage("s1", 0, "user", "hello", "turn-1");
		await appendMessage("s1", 1, "assistant", "world");
		const rows = await getSessionMessages("s1");
		expect(rows).toHaveLength(2);
		expect(rows[0].role).toBe("user");
		expect(rows[0].text).toBe("hello");
		expect(rows[0].turn_id).toBe("turn-1");
		expect(rows[1].role).toBe("assistant");
		expect(rows[1].turn_id).toBeNull();
	});

	it("returns empty array for session with no messages", async () => {
		await createSession("s1", "L", "m");
		expect(await getSessionMessages("s1")).toHaveLength(0);
	});

	it("pages backwards with a 201-row lookahead and no gaps or duplicates", async () => {
		await createSession("s1", "L", "m");
		for (let seq = 0; seq <= 400; seq++) {
			await appendMessage(
				"s1",
				seq,
				seq % 2 === 0 ? "user" : "assistant",
				`${seq}`,
			);
		}

		const newestWithLookahead = await getSessionMessages("s1", undefined, 201);
		expect(newestWithLookahead.map((row) => row.seq)).toEqual(
			Array.from({ length: 201 }, (_, index) => index + 200),
		);
		const newest = newestWithLookahead.slice(1);
		const olderWithLookahead = await getSessionMessages(
			"s1",
			newest[0].seq,
			201,
			undefined,
			newest[0].id,
		);
		const older = olderWithLookahead.slice(1);
		const oldest = await getSessionMessages(
			"s1",
			older[0].seq,
			201,
			undefined,
			older[0].id,
		);
		const combined = [...oldest, ...older, ...newest].map((row) => row.seq);

		expect(combined).toEqual(Array.from({ length: 401 }, (_, index) => index));
		expect(new Set(combined).size).toBe(401);
	});

	it("uses the row id tie-breaker when a duplicate sequence straddles a page boundary", async () => {
		await createSession("s1", "L", "m");
		for (let seq = 0; seq < 200; seq++) {
			await appendMessage("s1", seq, "user", `${seq}`);
		}
		await appendMessage("s1", 1, "assistant", "duplicate-low-boundary");
		await appendMessage("s1", 199, "assistant", "duplicate-newest");

		const newestWithLookahead = await getSessionMessages("s1", undefined, 201);
		const newest = newestWithLookahead.slice(1);
		const older = await getSessionMessages(
			"s1",
			newest[0].seq,
			201,
			undefined,
			newest[0].id,
		);
		const combined = [...older, ...newest];
		const all = await getSessionMessages("s1");

		expect(combined.map((row) => row.id)).toEqual(all.map((row) => row.id));
		expect(combined).toHaveLength(202);
	});

	it("refreshes an inclusive loaded window so reconnect does not drop its oldest rows", async () => {
		await createSession("s1", "L", "m");
		for (let seq = 0; seq <= 205; seq++) {
			await appendMessage("s1", seq, "assistant", `${seq}`);
		}

		const refreshed = await getSessionMessages("s1", undefined, undefined, 5);
		expect(refreshed[0].seq).toBe(5);
		expect(refreshed.at(-1)?.seq).toBe(205);
		expect(refreshed).toHaveLength(201);
	});

	it("refreshes a compound inclusive window without pulling an older duplicate", async () => {
		await createSession("s1", "L", "m");
		await appendMessage("s1", 5, "user", "older duplicate");
		await appendMessage("s1", 5, "assistant", "window start");
		await appendMessage("s1", 6, "assistant", "newer");
		const all = await getSessionMessages("s1");

		const refreshed = await getSessionMessages(
			"s1",
			undefined,
			undefined,
			5,
			undefined,
			all[1].id,
		);

		expect(refreshed.map((row) => row.text)).toEqual(["window start", "newer"]);
	});

	it("derives the resume sequence from every persisted transcript table", async () => {
		await createSession("s1", "L", "m");
		await appendMessage("s1", 0, "user", "hello");
		await appendToolEvent("s1", 2, "tool", "Read", {});
		await appendPlanProposal("s1", "plan", 5, "plan", "approved");
		await appendAskUserQuestion("s1", "ask", 8, "[]");

		expect(await getSessionNextMessageSeq("s1")).toBe(9);
		expect(await getSessionNextMessageSeq("missing")).toBe(0);
	});

	it("appendToolEvent rejects a missing session instead of dropping the event", async () => {
		await expect(
			appendToolEvent("missing-session", 1, "missing-tool", "Read", {}),
		).rejects.toThrow(
			"appendToolEvent: no session found for session=missing-session",
		);
		expect(await getSessionToolEventSummaries("missing-session")).toEqual([]);
	});

	it("setMessageRecap updates the recap field", async () => {
		await createSession("s1", "L", "m");
		await appendMessage("s1", 0, "assistant", "some response");
		await setMessageRecap("s1", 0, "did X and Y");
		const rows = await getSessionMessages("s1");
		expect(rows[0].recap).toBe("did X and Y");
	});

	it("setMessageRecap throws when row not found", async () => {
		await createSession("s1", "L", "m");
		await expect(setMessageRecap("s1", 99, "orphan")).rejects.toThrow(
			"no row found",
		);
	});
});

describe("tool events", () => {
	beforeEach(() => freshDb());

	it("appends and retrieves tool events", async () => {
		await createSession("s1", "L", "m");
		await appendMessage("s1", 0, "assistant", "used tool");
		await appendToolEvent("s1", 0, "tid-1", "Bash", { command: "ls" });
		const events = await getSessionToolEventSummaries("s1");
		expect(events).toHaveLength(1);
		expect(events[0].name).toBe("Bash");
		expect(events[0].tool_id).toBe("tid-1");
	});

	it("scopes tool-adjacent transcript cards to the requested sequence window", async () => {
		await createSession("s1", "L", "m");
		await appendMessage("s1", 10, "assistant", "old");
		await appendMessage("s1", 20, "assistant", "new");
		await appendToolEvent("s1", 10, "tool-old", "Read", {});
		await appendToolEvent("s1", 20, "tool-new", "Bash", {});
		await recordPermissionEvent(
			"s1",
			"tool-old",
			"Read",
			undefined,
			"approved",
		);
		await recordPermissionEvent(
			"s1",
			"tool-new",
			"Bash",
			undefined,
			"approved",
		);
		await appendPlanProposal("s1", "plan-old", 10, "old", "approved");
		await appendPlanProposal("s1", "plan-new", 20, "new", "approved");
		await appendAskUserQuestion("s1", "ask-old", 10, "[]");
		await appendAskUserQuestion("s1", "ask-new", 20, "[]");
		for (const [id, seq] of [
			["attachment-old", 10],
			["attachment-new", 20],
		] as const) {
			await createAttachment({
				id,
				session_id: "s1",
				kind: "ephemeral",
				filename: `${id}.txt`,
				path: `/tmp/${id}.txt`,
				mime: "text/plain",
				size_bytes: 1,
				sha256: null,
			});
			await linkAttachmentToMessage(id, "s1", seq);
		}

		expect(
			(await getSessionToolEventSummaries("s1", 15, 25)).map(
				(row) => row.tool_id,
			),
		).toEqual(["tool-new"]);
		expect(
			(await getSessionPermissionEvents("s1", 15, 25)).map(
				(row) => row.tool_id,
			),
		).toEqual(["tool-new"]);
		expect(
			(await getSessionPlanProposals("s1", 15, 25)).map(
				(row) => row.proposal_id,
			),
		).toEqual(["plan-new"]);
		expect(
			(await getSessionAskUserQuestions("s1", 15, 25)).map(
				(row) => row.request_id,
			),
		).toEqual(["ask-new"]);
		expect(
			(await getAttachmentsForSession("s1", 15, 25)).map((row) => row.id),
		).toEqual(["attachment-new"]);

		// Compound message cursors can include a lower-id row whose seq equals the
		// cursor sequence, so the derived page maximum is inclusive.
		expect(
			(await getSessionToolEventSummaries("s1", 15, undefined, 20)).map(
				(row) => row.tool_id,
			),
		).toEqual(["tool-new"]);
		expect(
			(await getSessionPermissionEvents("s1", 15, undefined, 20)).map(
				(row) => row.tool_id,
			),
		).toEqual(["tool-new"]);
		expect(
			(await getSessionPlanProposals("s1", 15, undefined, 20)).map(
				(row) => row.proposal_id,
			),
		).toEqual(["plan-new"]);
		expect(
			(await getSessionAskUserQuestions("s1", 15, undefined, 20)).map(
				(row) => row.request_id,
			),
		).toEqual(["ask-new"]);
		expect(
			(await getAttachmentsForSession("s1", 15, undefined, 20)).map(
				(row) => row.id,
			),
		).toEqual(["attachment-new"]);
	});

	it("stores input as JSON string", async () => {
		await createSession("s1", "L", "m");
		await appendMessage("s1", 0, "assistant", "x");
		await appendToolEvent("s1", 0, "tid-1", "Read", {
			file_path: "/etc/hosts",
		});
		const events = await getSessionToolEventSummaries("s1");
		expect(events[0].input_json).toBe(
			JSON.stringify({ file_path: "/etc/hosts" }),
		);
	});

	it("summarizes large results and hydrates full detail within the session", async () => {
		await createSession("s1", "One", "m");
		await createSession("s2", "Two", "m");
		await appendMessage("s1", 0, "assistant", "x");
		await appendMessage("s2", 0, "assistant", "x");
		await appendToolEvent("s1", 0, "shared-tool", "Read", { path: "a" });
		await appendToolEvent("s2", 0, "shared-tool", "Read", { path: "b" });
		const longResult = "x".repeat(400);
		await setToolEventResult("s1", "shared-tool", longResult, false);
		await setToolEventResult("s2", "shared-tool", "other session", true);

		const [summary] = await getSessionToolEventSummaries("s1");
		expect(summary.result_text).toBe("x".repeat(256));
		expect(summary.result_length).toBe(400);
		expect(summary.result_truncated).toBe(1);
		expect(await getSessionToolEventDetail("s1", "shared-tool")).toEqual({
			tool_id: "shared-tool",
			result_text: longResult,
			is_error: 0,
		});
		expect(await getSessionToolEventDetail("s2", "shared-tool")).toEqual({
			tool_id: "shared-tool",
			result_text: "other session",
			is_error: 1,
		});
		expect(
			await getSessionToolEventDetail("missing", "shared-tool"),
		).toBeNull();
	});

	it("stores and updates the normalized subagent snapshot", async () => {
		await createSession("s1", "L", "m");
		await appendMessage("s1", 0, "assistant", "");
		const started = {
			provider: "codex" as const,
			agentId: "spawn-1",
			status: "pending" as const,
			startedAtMs: 1000,
		};
		await appendToolEvent("s1", 0, "spawn-1", "spawn_agent", {}, started);
		await setToolEventSubagent("s1", "spawn-1", {
			...started,
			agentId: "child-1",
			status: "completed",
			endedAtMs: 5000,
		});
		const events = await getSessionToolEventSummaries("s1");
		expect(JSON.parse(events[0].subagent_json ?? "{}")).toEqual({
			provider: "codex",
			agentId: "child-1",
			status: "completed",
			startedAtMs: 1000,
			endedAtMs: 5000,
		});
	});
});

// ── permission events ─────────────────────────────────────────────────────────

describe("permission events", () => {
	beforeEach(() => freshDb());

	it("records and retrieves permission events", async () => {
		await createSession("s1", "L", "m");
		await recordPermissionEvent("s1", "tid-1", "Bash", "Bash", "approved");
		const events = await getSessionPermissionEvents("s1");
		expect(events).toHaveLength(1);
		expect(events[0].tool_name).toBe("Bash");
		expect(events[0].decision).toBe("approved");
	});

	it("handles undefined displayName (stores null)", async () => {
		await createSession("s1", "L", "m");
		await recordPermissionEvent("s1", "tid-2", "Read", undefined, "denied");
		const events = await getSessionPermissionEvents("s1");
		expect(events[0].display_name).toBeNull();
	});

	it("returns empty array for session with no events", async () => {
		await createSession("s1", "L", "m");
		expect(await getSessionPermissionEvents("s1")).toHaveLength(0);
	});

	it("returns events ordered by timestamp then rowid", async () => {
		await createSession("s1", "L", "m");
		await recordPermissionEvent("s1", "t1", "Bash", undefined, "approved");
		await recordPermissionEvent("s1", "t2", "Read", undefined, "denied");
		const events = await getSessionPermissionEvents("s1");
		expect(events[0].tool_id).toBe("t1");
		expect(events[1].tool_id).toBe("t2");
	});

	it("keeps standalone approvals visible in the newest paged window only", async () => {
		await createSession("s1", "L", "m");
		await recordPermissionEvent(
			"s1",
			"hlid-windows-computer-use-turn-1",
			"hlid.windows_computer_use",
			"Windows Computer Use",
			"approved",
		);

		expect(
			(await getSessionPermissionEvents("s1", 0, undefined, 10)).map(
				(row) => row.tool_id,
			),
		).toEqual(["hlid-windows-computer-use-turn-1"]);
		expect(await getSessionPermissionEvents("s1", 0, 11, 10)).toEqual([]);
	});
});

// ── event log ────────────────────────────────────────────────────────────────

describe("event log — appendLog / getLogs", () => {
	beforeEach(() => freshDb());

	it("appends a log entry and retrieves it", async () => {
		await appendLog("info", "test", "hello world");
		const { logs, total } = await getLogs(1, 10);
		expect(total).toBe(1);
		expect(logs[0].level).toBe("info");
		expect(logs[0].source).toBe("test");
		expect(logs[0].message).toBe("hello world");
	});

	it("stores detail as JSON string", async () => {
		await appendLog("error", "session", "query failed", { reason: "timeout" });
		const { logs } = await getLogs(1, 10);
		expect(JSON.parse(logs[0].detail ?? "null")).toEqual({ reason: "timeout" });
	});

	it("null detail stored as null", async () => {
		await appendLog("warn", "db", "minor issue");
		const { logs } = await getLogs(1, 10);
		expect(logs[0].detail).toBeNull();
	});

	it("returns multiple log entries with correct total", async () => {
		await appendLog("info", "a", "first");
		await appendLog("info", "b", "second");
		const { logs, total } = await getLogs(1, 10);
		expect(total).toBe(2);
		const messages = logs.map((l) => l.message);
		expect(messages).toContain("first");
		expect(messages).toContain("second");
	});

	it("filters by level", async () => {
		await appendLog("error", "x", "err");
		await appendLog("warn", "x", "wrn");
		await appendLog("info", "x", "inf");
		const { logs, total } = await getLogs(1, 10, "error");
		expect(total).toBe(1);
		expect(logs[0].level).toBe("error");
	});

	it("counts by level in response", async () => {
		await appendLog("error", "x", "e1");
		await appendLog("error", "x", "e2");
		await appendLog("warn", "x", "w1");
		const { counts } = await getLogs(1, 10);
		expect(counts.error).toBe(2);
		expect(counts.warn).toBe(1);
		expect(counts.info).toBe(0);
	});

	it("retains exactly the newest 1000 entries", async () => {
		for (let index = 0; index < 1001; index++) {
			await appendLog("info", "retention", `entry-${index}`);
		}
		const { logs, total } = await getLogs(1, 1000);
		expect(total).toBe(1000);
		expect(logs[0].message).toBe("entry-1000");
		expect(logs.at(-1)?.message).toBe("entry-1");
	});

	it("clearLogs removes all entries", async () => {
		await appendLog("info", "x", "msg");
		await clearLogs();
		const { total } = await getLogs(1, 10);
		expect(total).toBe(0);
	});
});

// ── usage — getAggregatedStats ────────────────────────────────────────────────

describe("usage — getAggregatedStats", () => {
	beforeEach(() => freshDb());

	it("returns zeroed stats on empty DB", async () => {
		const { allTime, today, thisMonth } = await getAggregatedStats();
		expect(allTime.cost).toBe(0);
		expect(allTime.queries).toBe(0);
		expect(allTime.sessions).toBe(0);
		expect(today.cost).toBe(0);
		expect(thisMonth.tokens).toBe(0);
	});

	it("accumulates after recordQuery", async () => {
		await createSession("s1", "L", "m");
		await recordQuery(
			"s1",
			baseQuery({ cost: 0.1, input_tokens: 500, output_tokens: 200, turns: 3 }),
		);
		const { allTime } = await getAggregatedStats();
		expect(allTime.queries).toBe(1);
		expect(allTime.sessions).toBe(1);
		expect(allTime.input_tokens).toBe(500);
		expect(allTime.output_tokens).toBe(200);
		expect(allTime.turns).toBe(3);
		expect(allTime.cost).toBeCloseTo(0.1);
	});

	it("today and thisMonth include full token breakdown", async () => {
		await createSession("s1", "L", "m");
		await recordQuery(
			"s1",
			baseQuery({
				cost: 0.05,
				input_tokens: 300,
				output_tokens: 100,
				cache_read_tokens: 80,
				cache_creation_tokens: 20,
				turns: 2,
			}),
		);
		const { today, thisMonth } = await getAggregatedStats();

		// today
		expect(today.input_tokens).toBe(300);
		expect(today.output_tokens).toBe(100);
		expect(today.cache_read_tokens).toBe(80);
		expect(today.cache_creation_tokens).toBe(20);
		expect(today.turns).toBe(2);
		expect(today.queries).toBe(1);
		expect(today.tokens).toBe(500); // uncached input + output + cache read/write
		expect(today.cost).toBeCloseTo(0.05);

		// thisMonth mirrors today (single record, same calendar month)
		expect(thisMonth.input_tokens).toBe(300);
		expect(thisMonth.output_tokens).toBe(100);
		expect(thisMonth.cache_read_tokens).toBe(80);
		expect(thisMonth.cache_creation_tokens).toBe(20);
		expect(thisMonth.turns).toBe(2);
	});
});

// ── usage — getThirtyDayStats ────────────────────────────────────────────────

describe("usage — getThirtyDayStats", () => {
	beforeEach(() => freshDb());

	it("returns 30 days of data", async () => {
		const { days } = await getThirtyDayStats();
		expect(days).toHaveLength(30);
	});

	it("total is 0 on empty DB", async () => {
		const { total } = await getThirtyDayStats();
		expect(total).toBe(0);
	});

	it("days array contains today's date", async () => {
		const { days } = await getThirtyDayStats();
		const now = new Date();
		const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
		expect(days[days.length - 1].date).toBe(today);
	});
});

// ── usage — getUsageWindows ───────────────────────────────────────────────────

describe("usage — getUsageWindows", () => {
	beforeEach(() => freshDb());

	it("returns zeroed windows on empty DB", async () => {
		const { fiveHour, weekly } = await getUsageWindows();
		expect(fiveHour.tokens).toBe(0);
		expect(fiveHour.queries).toBe(0);
		expect(weekly.tokens).toBe(0);
		expect(weekly.sessions).toBe(0);
	});

	it("weeklySonnet is null when no rl setting stored", async () => {
		const { weeklySonnet } = await getUsageWindows();
		expect(weeklySonnet).toBeNull();
	});
});

// ── attachments ───────────────────────────────────────────────────────────────

function makeAttachment(
	id: string,
	overrides: Partial<Parameters<typeof createAttachment>[0]> = {},
) {
	return createAttachment({
		id,
		session_id: null,
		kind: "ephemeral",
		filename: `file-${id}.txt`,
		path: `/tmp/${id}.txt`,
		mime: "text/plain",
		size_bytes: 100,
		sha256: null,
		...overrides,
	});
}

describe("attachments — CRUD", () => {
	beforeEach(() => freshDb());

	it("creates and retrieves an attachment", async () => {
		await makeAttachment("att-1");
		const row = await getAttachment("att-1");
		expect(row).not.toBeNull();
		expect(row?.filename).toBe("file-att-1.txt");
		expect(row?.kind).toBe("ephemeral");
	});

	it("returns null for unknown id", async () => {
		expect(await getAttachment("nonexistent")).toBeNull();
	});

	it("linkAttachmentToMessage updates session_id and message_seq", async () => {
		await createSession("s1", "L", "m");
		await makeAttachment("att-2", { session_id: "s1" });
		const linked = await linkAttachmentToMessage("att-2", "s1", 3);
		expect(linked).toBe(true);
		const row = await getAttachment("att-2");
		expect(row?.session_id).toBe("s1");
		expect(row?.message_seq).toBe(3);
	});

	it("linkAttachmentToMessage returns false for unknown id", async () => {
		const result = await linkAttachmentToMessage("ghost", "s1", 0);
		expect(result).toBe(false);
	});

	it("getAttachmentsForSession returns only session attachments", async () => {
		await createSession("s1", "L", "m");
		await makeAttachment("att-3", { session_id: "s1" });
		await makeAttachment("att-4", { session_id: null });
		const rows = await getAttachmentsForSession("s1");
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe("att-3");
	});

	it("deleteAttachment returns the row and removes it", async () => {
		await makeAttachment("att-5");
		const deleted = await deleteAttachment("att-5");
		expect(deleted).not.toBeNull();
		expect(deleted?.id).toBe("att-5");
		expect(await getAttachment("att-5")).toBeNull();
	});

	it("deleteAttachment returns null for unknown id", async () => {
		expect(await deleteAttachment("ghost")).toBeNull();
	});
});

describe("attachments — listAttachments", () => {
	beforeEach(() => freshDb());

	it("lists all attachments", async () => {
		await makeAttachment("a1");
		await makeAttachment("a2");
		const { rows, total } = await listAttachments();
		expect(total).toBe(2);
		expect(rows).toHaveLength(2);
	});

	it("filters by kind", async () => {
		await makeAttachment("a1", { kind: "ephemeral" });
		await makeAttachment("a2", { kind: "vault" });
		const { total } = await listAttachments({ kind: "vault" });
		expect(total).toBe(1);
	});

	it("filters by sessionId", async () => {
		await createSession("s1", "L", "m");
		await makeAttachment("a1", { session_id: "s1" });
		await makeAttachment("a2", { session_id: null });
		const { total } = await listAttachments({ sessionId: "s1" });
		expect(total).toBe(1);
	});

	it("filters by filename search", async () => {
		await makeAttachment("findme", { filename: "report-2024.pdf" });
		await makeAttachment("other", { filename: "notes.txt" });
		const { total, rows } = await listAttachments({ search: "report" });
		expect(total).toBe(1);
		expect(rows[0].filename).toBe("report-2024.pdf");
	});

	it("filters filenames without requiring accents", async () => {
		await makeAttachment("accented", { filename: "résumé.pdf" });
		await makeAttachment("other", { filename: "notes.txt" });
		const { total, rows } = await listAttachments({ search: "resume" });
		expect(total).toBe(1);
		expect(rows[0].filename).toBe("résumé.pdf");
	});

	it("returns total_bytes sum", async () => {
		await makeAttachment("b1", { size_bytes: 400 });
		await makeAttachment("b2", { size_bytes: 600 });
		const { total_bytes } = await listAttachments();
		expect(total_bytes).toBe(1000);
	});

	it("respects limit and offset", async () => {
		for (let i = 0; i < 5; i++) await makeAttachment(`p${i}`);
		const { rows, total } = await listAttachments({ limit: 2, offset: 1 });
		expect(total).toBe(5);
		expect(rows).toHaveLength(2);
	});

	it("filters by broad MIME class", async () => {
		await makeAttachment("img", { mime: "image/png" });
		await makeAttachment("pdf", { mime: "application/pdf" });
		await makeAttachment("txt", { mime: "text/plain" });
		await makeAttachment("json", { mime: "application/json" });
		await makeAttachment("zip", { mime: "application/zip" });

		expect((await listAttachments({ type: "image" })).total).toBe(1);
		expect((await listAttachments({ type: "pdf" })).total).toBe(1);
		// text covers text/* plus JSON
		expect((await listAttachments({ type: "text" })).total).toBe(2);
		const other = await listAttachments({ type: "other" });
		expect(other.total).toBe(1);
		expect(other.rows[0].id).toBe("zip");
	});

	it("sorts by size in both directions", async () => {
		await makeAttachment("small", { size_bytes: 10 });
		await makeAttachment("big", { size_bytes: 1000 });
		await makeAttachment("mid", { size_bytes: 100 });

		const desc = await listAttachments({ sort: "size_bytes", dir: "desc" });
		expect(desc.rows.map((r) => r.id)).toEqual(["big", "mid", "small"]);
		const asc = await listAttachments({ sort: "size_bytes", dir: "asc" });
		expect(asc.rows.map((r) => r.id)).toEqual(["small", "mid", "big"]);
	});
});

// ── sessions — deleteSessionsOlderThan ───────────────────────────────────────

describe("sessions — deleteSessionsOlderThan", () => {
	let db: ReturnType<typeof freshDb>;
	beforeEach(() => {
		db = freshDb();
	});

	it("deletes sessions older than N days, keeps newer ones", async () => {
		const oldTs = Math.floor(Date.now() / 1000) - 10 * 86400;
		db.run(
			`INSERT INTO sessions (id, label, model, started_at) VALUES (?, ?, ?, ?)`,
			["old-s", "Old", "m", oldTs],
		);
		await createSession("new-s", "New", "m");

		const { count } = await deleteSessionsOlderThan(5);
		expect(count).toBe(1);
		const rows = await getRecentSessions();
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe("new-s");
	});

	it("returns 0 when nothing is old enough", async () => {
		await createSession("s1", "L", "m");
		const { count } = await deleteSessionsOlderThan(30);
		expect(count).toBe(0);
		expect(await getRecentSessions()).toHaveLength(1);
	});

	it("returns ephemeral attachment paths for deleted sessions", async () => {
		const oldTs = Math.floor(Date.now() / 1000) - 10 * 86400;
		db.run(
			`INSERT INTO sessions (id, label, model, started_at) VALUES (?, ?, ?, ?)`,
			["old-s", "Old", "m", oldTs],
		);
		await makeAttachment("att-old", {
			session_id: "old-s",
			kind: "ephemeral",
			path: "/tmp/old-file.bin",
		});

		const { ephemeralPaths } = await deleteSessionsOlderThan(5);
		expect(ephemeralPaths).toContain("/tmp/old-file.bin");
	});
});

// ── sessions — cascade delete completeness ───────────────────────────────────

describe("sessions — cascade delete completeness", () => {
	beforeEach(() => freshDb());

	it("deleteSession removes tool_events and permission_events", async () => {
		await createSession("s1", "L", "m");
		await appendMessage("s1", 0, "assistant", "x");
		await appendToolEvent("s1", 0, "tid-1", "Bash", { command: "ls" });
		await recordPermissionEvent("s1", "tid-1", "Bash", "Bash", "approved");
		await recordQuery("s1", baseQuery());

		await deleteSession("s1");

		expect(await getSessionMessages("s1")).toHaveLength(0);
		expect(await getSessionToolEventSummaries("s1")).toHaveLength(0);
		expect(await getSessionPermissionEvents("s1")).toHaveLength(0);
	});

	it("deleteSession returns ephemeral paths and removes ephemeral attachments", async () => {
		await createSession("s1", "L", "m");
		await makeAttachment("att-e", {
			session_id: "s1",
			kind: "ephemeral",
			path: "/tmp/ephemeral.bin",
		});

		const { ephemeralPaths } = await deleteSession("s1");
		expect(ephemeralPaths).toContain("/tmp/ephemeral.bin");
		expect(await getAttachment("att-e")).toBeNull();
	});

	it("deleteSession nulls vault attachment session_id instead of deleting", async () => {
		await createSession("s1", "L", "m");
		await makeAttachment("att-v", { session_id: "s1", kind: "vault" });

		await deleteSession("s1");

		const att = await getAttachment("att-v");
		expect(att).not.toBeNull();
		expect(att?.session_id).toBeNull();
		expect(att?.message_seq).toBeNull();
	});
});

// ── usage — getWeeklyStats ────────────────────────────────────────────────────

describe("usage — getWeeklyStats", () => {
	beforeEach(() => freshDb());

	it("returns 7-element days array with zero total on empty DB", async () => {
		const { days, total } = await getWeeklyStats();
		expect(days).toHaveLength(7);
		expect(total).toBe(0);
	});

	it("accumulates queries recorded this week", async () => {
		await createSession("s1", "L", "m");
		await recordQuery("s1", baseQuery());
		await recordQuery("s1", baseQuery());
		const { total } = await getWeeklyStats();
		expect(total).toBe(2);
	});

	it("today's day index has non-zero count after recordQuery", async () => {
		const db = freshDb();
		await createSession("s1", "L", "m");
		await recordQuery("s1", baseQuery());
		const { days } = await getWeeklyStats();
		// Use SQLite's localtime DOW to match recordQuery's date insertion;
		// JS `new Date().getDay()` can disagree with SQLite under some test
		// runners (e.g. bun test forces UTC for JS Intl but the C runtime
		// SQLite uses still reads the system TZ).
		const { dow } = db
			.query<{ dow: number }, []>(
				`SELECT CAST(strftime('%w', 'now', 'localtime') AS INTEGER) AS dow`,
			)
			.get() ?? { dow: 0 };
		expect(days[dow]).toBeGreaterThan(0);
	});
});

// ── usage — getUsageWindows parseRl logic ─────────────────────────────────────

describe("usage — getUsageWindows rate-limit settings", () => {
	beforeEach(() => freshDb());

	it("exposes utilization and resetsAt from rl_claude_five_hour when not expired", async () => {
		const resetsAt = Math.floor(Date.now() / 1000) + 3600;
		await saveSetting(
			"rl_claude_five_hour",
			JSON.stringify({ utilization: 0.75, resetsAt }),
		);
		const { fiveHour } = await getUsageWindows();
		expect(fiveHour.utilization).toBeCloseTo(0.75);
		expect(fiveHour.resetsAt).toBe(resetsAt);
	});

	it("ignores rl_claude_five_hour setting when resetsAt is in the past", async () => {
		const resetsAt = Math.floor(Date.now() / 1000) - 60;
		await saveSetting(
			"rl_claude_five_hour",
			JSON.stringify({ utilization: 0.9, resetsAt }),
		);
		const { fiveHour } = await getUsageWindows();
		expect(fiveHour.utilization).toBeNull();
	});

	it("handles malformed JSON in rl settings without throwing", async () => {
		await saveSetting("rl_claude_five_hour", "not-valid-json{{");
		const { fiveHour } = await getUsageWindows();
		expect(fiveHour.utilization).toBeNull();
	});

	it("exposes utilization and resetsAt from rl_claude_weekly when not expired", async () => {
		const resetsAt = Math.floor(Date.now() / 1000) + 3600;
		await saveSetting(
			"rl_claude_weekly",
			JSON.stringify({ utilization: 0.6, resetsAt }),
		);
		const { weekly } = await getUsageWindows();
		expect(weekly.utilization).toBeCloseTo(0.6);
		expect(weekly.resetsAt).toBe(resetsAt);
	});

	it("ignores rl_claude_weekly setting when resetsAt is in the past", async () => {
		const resetsAt = Math.floor(Date.now() / 1000) - 60;
		await saveSetting(
			"rl_claude_weekly",
			JSON.stringify({ utilization: 0.8, resetsAt }),
		);
		const { weekly } = await getUsageWindows();
		expect(weekly.utilization).toBeNull();
	});

	it("returns weeklySonnet utilization when rl_claude_weekly_sonnet is set and unexpired", async () => {
		const resetsAt = Math.floor(Date.now() / 1000) + 3600;
		await saveSetting(
			"rl_claude_weekly_sonnet",
			JSON.stringify({ utilization: 0.5, resetsAt }),
		);
		const { weeklySonnet } = await getUsageWindows();
		expect(weeklySonnet).not.toBeNull();
		expect(weeklySonnet?.utilization).toBeCloseTo(0.5);
	});

	it("weeklySonnet is null when rl_claude_weekly_sonnet resetsAt expired", async () => {
		const resetsAt = Math.floor(Date.now() / 1000) - 1;
		await saveSetting(
			"rl_claude_weekly_sonnet",
			JSON.stringify({ utilization: 0.5, resetsAt }),
		);
		const { weeklySonnet } = await getUsageWindows();
		expect(weeklySonnet).toBeNull();
	});
});

// ── ledger immutability ───────────────────────────────────────────────────────
// All-time stats (usage_daily) and window stats (usage_queries) must survive
// session deletion. Deleting sessions should clean up disk/context but never
// subtract from the historical record of what was used.

describe("ledger — usage_daily survives session deletion (all-time immutability)", () => {
	let db: ReturnType<typeof freshDb>;
	beforeEach(() => {
		db = freshDb();
	});

	it("usage_daily row is NOT removed when session is deleted", async () => {
		await createSession("s1", "L", "m");
		await recordQuery(
			"s1",
			baseQuery({ cost: 0.05, input_tokens: 300, output_tokens: 100 }),
		);

		// Confirm row exists
		const before = await getAggregatedStats();
		expect(before.allTime.queries).toBe(1);

		await deleteSession("s1");

		// All-time stats must be unchanged
		const after = await getAggregatedStats();
		expect(after.allTime.queries).toBe(1);
		expect(after.allTime.input_tokens).toBe(300);
		expect(after.allTime.output_tokens).toBe(100);
		expect(after.allTime.cost).toBeCloseTo(0.05);
	});

	it("usage_daily survives deleteSessionsOlderThan", async () => {
		const oldTs = Math.floor(Date.now() / 1000) - 10 * 86400;
		db.run(
			`INSERT INTO sessions (id, label, model, started_at) VALUES (?, ?, ?, ?)`,
			["old-s", "Old", "m", oldTs],
		);
		await recordQuery("old-s", baseQuery({ cost: 0.1, input_tokens: 500 }));

		const before = await getAggregatedStats();
		expect(before.allTime.queries).toBe(1);

		await deleteSessionsOlderThan(5);

		const after = await getAggregatedStats();
		expect(after.allTime.queries).toBe(1);
		expect(after.allTime.input_tokens).toBe(500);
	});

	it("usage_daily has no FK to sessions (structural: deleting session cannot cascade to it)", async () => {
		// Prove the table has no foreign-key referencing sessions.
		// If someone adds a FK later, this test catches it.
		const fkRows = db
			.query<{ table: string }, []>(
				`SELECT "table" FROM pragma_foreign_key_list('usage_daily')`,
			)
			.all();
		expect(fkRows).toHaveLength(0);
	});
});

describe("ledger — usage_queries survives session deletion (window immutability)", () => {
	let db: ReturnType<typeof freshDb>;
	beforeEach(() => {
		db = freshDb();
	});

	it("usage_queries rows are NOT deleted when session is deleted", async () => {
		await createSession("s1", "L", "m");
		await recordQuery(
			"s1",
			baseQuery({ cost: 0.02, input_tokens: 150, output_tokens: 60 }),
		);

		// Confirm row exists in usage_queries
		const countBefore = db
			.query<{ n: number }, []>(`SELECT COUNT(*) as n FROM usage_queries`)
			.get()?.n;
		expect(countBefore).toBe(1);

		await deleteSession("s1");

		// usage_queries row must survive
		const countAfter = db
			.query<{ n: number }, []>(`SELECT COUNT(*) as n FROM usage_queries`)
			.get()?.n;
		expect(countAfter).toBe(1);
	});

	it("getUsageWindows query count unchanged after session deletion", async () => {
		await createSession("s1", "L", "m");
		await recordQuery(
			"s1",
			baseQuery({ input_tokens: 200, output_tokens: 80 }),
		);

		const before = await getUsageWindows();
		expect(before.fiveHour.queries).toBe(1);

		await deleteSession("s1");

		const after = await getUsageWindows();
		expect(after.fiveHour.queries).toBe(1);
		expect(after.fiveHour.tokens).toBe(before.fiveHour.tokens);
	});

	it("usage_queries has no FK to sessions (structural)", async () => {
		const fkRows = db
			.query<{ table: string }, []>(
				`SELECT "table" FROM pragma_foreign_key_list('usage_queries')`,
			)
			.all();
		expect(fkRows).toHaveLength(0);
	});
});

// ── sessions — sort by most-recently-active ───────────────────────────────────

describe("sessions — sort by most-recently-active (COALESCE ended_at, started_at)", () => {
	let db: ReturnType<typeof freshDb>;
	beforeEach(() => {
		db = freshDb();
	});

	it("session with recent ended_at sorts before session with newer started_at but no queries", async () => {
		const now = Math.floor(Date.now() / 1000);
		// s-old: old start, but recently queried (ended_at = now)
		db.run(
			`INSERT INTO sessions (id, label, model, started_at, ended_at) VALUES (?, ?, ?, ?, ?)`,
			["s-old", "Old but active", "m", now - 1000, now],
		);
		// s-new: newer start, never queried (ended_at = null)
		db.run(
			`INSERT INTO sessions (id, label, model, started_at) VALUES (?, ?, ?, ?)`,
			["s-new", "New but idle", "m", now - 100],
		);

		const { sessions } = await getSessionsPaginated(1, 10);
		expect(sessions[0].id).toBe("s-old"); // COALESCE(now, now-1000) = now
		expect(sessions[1].id).toBe("s-new"); // COALESCE(null, now-100) = now-100
	});

	it("getRecentSessions also sorts by most-recently-active", async () => {
		const now = Math.floor(Date.now() / 1000);
		db.run(
			`INSERT INTO sessions (id, label, model, started_at, ended_at) VALUES (?, ?, ?, ?, ?)`,
			["s-recent-query", "Q", "m", now - 2000, now - 5],
		);
		db.run(
			`INSERT INTO sessions (id, label, model, started_at) VALUES (?, ?, ?, ?)`,
			["s-newer-start", "N", "m", now - 500],
		);

		const rows = await getRecentSessions(10);
		// s-newer-start: COALESCE(null, now-500) = now-500
		// s-recent-query: COALESCE(now-5, now-2000) = now-5
		// now-5 > now-500, so s-recent-query sorts first
		expect(rows[0].id).toBe("s-recent-query");
		expect(rows[1].id).toBe("s-newer-start");
	});

	it("multiple sessions without queries sort by started_at DESC", async () => {
		const now = Math.floor(Date.now() / 1000);
		db.run(
			`INSERT INTO sessions (id, label, model, started_at) VALUES (?, ?, ?, ?)`,
			["s1", "A", "m", now - 300],
		);
		db.run(
			`INSERT INTO sessions (id, label, model, started_at) VALUES (?, ?, ?, ?)`,
			["s2", "B", "m", now - 100],
		);
		db.run(
			`INSERT INTO sessions (id, label, model, started_at) VALUES (?, ?, ?, ?)`,
			["s3", "C", "m", now - 200],
		);

		const { sessions } = await getSessionsPaginated(1, 10);
		// No ended_at → COALESCE falls back to started_at
		expect(sessions[0].id).toBe("s2"); // started_at = now-100
		expect(sessions[1].id).toBe("s3"); // started_at = now-200
		expect(sessions[2].id).toBe("s1"); // started_at = now-300
	});
});

// ── usage — registerProvider ──────────────────────────────────────────────────

describe("usage — registerProvider", () => {
	beforeEach(() => freshDb());

	it("registerProvider exposes windows via getProviderUsage", async () => {
		registerProvider("testprovider", "Test Provider", [
			{ windowId: "hourly", label: "1-HOUR", windowSecs: 3600 },
		]);
		const snapshot = await getProviderUsage("testprovider");
		expect(snapshot.providerId).toBe("testprovider");
		expect(snapshot.providerLabel).toBe("Test Provider");
		expect(snapshot.windows).toHaveLength(1);
		expect(snapshot.windows[0].windowId).toBe("hourly");
		expect(snapshot.windows[0].label).toBe("1-HOUR");
	});

	it("registerProvider overwrites an existing provider registration", async () => {
		registerProvider("testprovider2", "Old Label", [
			{ windowId: "w1", label: "W1", windowSecs: 3600 },
		]);
		registerProvider("testprovider2", "New Label", [
			{ windowId: "w2", label: "W2", windowSecs: 7200 },
		]);
		const snapshot = await getProviderUsage("testprovider2");
		expect(snapshot.providerLabel).toBe("New Label");
		expect(snapshot.windows).toHaveLength(1);
		expect(snapshot.windows[0].windowId).toBe("w2");
	});

	it("getProviderUsage for unknown provider returns empty windows and uses id as label", async () => {
		const snapshot = await getProviderUsage("unknownprovider-xyz");
		expect(snapshot.providerId).toBe("unknownprovider-xyz");
		expect(snapshot.providerLabel).toBe("unknownprovider-xyz"); // fallback: id
		expect(snapshot.windows).toHaveLength(0);
	});

	it("claude provider windows are unchanged after registering another provider", async () => {
		registerProvider("another", "Another", [
			{ windowId: "w1", label: "W1", windowSecs: 1000 },
		]);
		const snapshot = await getProviderUsage("claude");
		expect(snapshot.providerLabel).toBe("Claude");
		expect(snapshot.windows).toHaveLength(2); // five_hour, weekly
		const ids = snapshot.windows.map((w) => w.windowId);
		expect(ids).toContain("five_hour");
		expect(ids).toContain("weekly");
	});

	it("hydrates provider windows from valid persisted rate-limit metadata", async () => {
		const resetsAt = Math.floor(Date.now() / 1000) + 3_600;
		registerProvider("persisted-provider", "Persisted Provider", [
			{ windowId: "hourly", label: "1-HOUR", windowSecs: 3_600 },
		]);
		await saveSetting(
			"rl_persisted-provider_hourly",
			JSON.stringify({
				utilization: 0.42,
				remaining: 58,
				limit: 100,
				resetsAt,
			}),
		);

		const snapshot = await getProviderUsage("persisted-provider");
		expect(snapshot.windows[0]).toMatchObject({
			utilization: 0.42,
			remaining: 58,
			limit: 100,
			resetsAt,
		});
	});

	it("contains malformed or stale persisted rate-limit metadata", async () => {
		registerProvider("invalid-provider", "Invalid Provider", [
			{ windowId: "malformed", label: "Malformed", windowSecs: 3_600 },
			{ windowId: "scalar", label: "Scalar", windowSecs: 3_600 },
			{ windowId: "stale", label: "Stale", windowSecs: 3_600 },
			{ windowId: "wrong-types", label: "Wrong Types", windowSecs: 3_600 },
		]);
		await saveSetting("rl_invalid-provider_malformed", "not-json{");
		await saveSetting("rl_invalid-provider_scalar", JSON.stringify("value"));
		await saveSetting(
			"rl_invalid-provider_stale",
			JSON.stringify({
				utilization: 0.9,
				resetsAt: Math.floor(Date.now() / 1000) - 1,
			}),
		);
		await saveSetting(
			"rl_invalid-provider_wrong-types",
			JSON.stringify({
				utilization: "high",
				remaining: "many",
				limit: false,
			}),
		);

		const snapshot = await getProviderUsage("invalid-provider");
		for (const window of snapshot.windows) {
			expect(window).toMatchObject({
				utilization: null,
				remaining: null,
				limit: null,
				resetsAt: null,
			});
		}
	});
});

// ── ask_user_questions ────────────────────────────────────────────────────────

describe("ask_user_questions", () => {
	beforeEach(() => freshDb());

	const sampleQuestionsJson = JSON.stringify([
		{ question: "Pick?", options: ["A", "B"], multiSelect: false },
	]);

	it("appendAskUserQuestion inserts a pending row (answers_json + notes_json null)", async () => {
		await createSession("s1", "TEST", "claude-sonnet");
		await appendAskUserQuestion("s1", "req-1", 0, sampleQuestionsJson);
		const rows = await getSessionAskUserQuestions("s1");
		expect(rows).toHaveLength(1);
		expect(rows[0].request_id).toBe("req-1");
		expect(rows[0].questions_json).toBe(sampleQuestionsJson);
		expect(rows[0].answers_json).toBeNull();
		expect(rows[0].notes_json).toBeNull();
	});

	it("appendAskUserQuestion upserts on the same request_id (retry-safe)", async () => {
		await createSession("s1", "TEST", "claude-sonnet");
		await appendAskUserQuestion("s1", "req-1", 0, sampleQuestionsJson);
		const updatedJson = JSON.stringify([
			{ question: "Pick again?", options: ["X", "Y"], multiSelect: true },
		]);
		await appendAskUserQuestion("s1", "req-1", 0, updatedJson);
		const rows = await getSessionAskUserQuestions("s1");
		expect(rows).toHaveLength(1);
		expect(rows[0].questions_json).toBe(updatedJson);
	});

	it("setAskUserQuestionResolution stores answers and notes", async () => {
		await createSession("s1", "TEST", "claude-sonnet");
		await appendAskUserQuestion("s1", "req-1", 0, sampleQuestionsJson);
		const answersJson = JSON.stringify({ "Pick?": ["A"] });
		const notesJson = JSON.stringify({ "Pick?": "because A" });
		await setAskUserQuestionResolution("s1", "req-1", answersJson, notesJson);
		const rows = await getSessionAskUserQuestions("s1");
		expect(rows[0].answers_json).toBe(answersJson);
		expect(rows[0].notes_json).toBe(notesJson);
	});

	it("setAskUserQuestionResolution accepts null notes_json", async () => {
		await createSession("s1", "TEST", "claude-sonnet");
		await appendAskUserQuestion("s1", "req-1", 0, sampleQuestionsJson);
		const answersJson = JSON.stringify({ "Pick?": ["B"] });
		await setAskUserQuestionResolution("s1", "req-1", answersJson, null);
		const rows = await getSessionAskUserQuestions("s1");
		expect(rows[0].answers_json).toBe(answersJson);
		expect(rows[0].notes_json).toBeNull();
	});

	it("setAskUserQuestionResolution throws when the row does not exist", async () => {
		await createSession("s1", "TEST", "claude-sonnet");
		await expect(
			setAskUserQuestionResolution("s1", "missing-id", "{}", null),
		).rejects.toThrow(/no row found/);
	});

	it("getSessionAskUserQuestions orders by seq ASC", async () => {
		await createSession("s1", "TEST", "claude-sonnet");
		await appendAskUserQuestion("s1", "req-c", 2, sampleQuestionsJson);
		await appendAskUserQuestion("s1", "req-a", 0, sampleQuestionsJson);
		await appendAskUserQuestion("s1", "req-b", 1, sampleQuestionsJson);
		const rows = await getSessionAskUserQuestions("s1");
		expect(rows.map((r) => r.request_id)).toEqual(["req-a", "req-b", "req-c"]);
	});

	it("getSessionAskUserQuestions scopes by session_id", async () => {
		await createSession("s1", "ONE", "claude-sonnet");
		await createSession("s2", "TWO", "claude-sonnet");
		await appendAskUserQuestion("s1", "req-1", 0, sampleQuestionsJson);
		await appendAskUserQuestion("s2", "req-2", 0, sampleQuestionsJson);
		const rows1 = await getSessionAskUserQuestions("s1");
		const rows2 = await getSessionAskUserQuestions("s2");
		expect(rows1).toHaveLength(1);
		expect(rows1[0].request_id).toBe("req-1");
		expect(rows2).toHaveLength(1);
		expect(rows2[0].request_id).toBe("req-2");
	});
});
