/**
 * DB layer integration tests.
 * Requires Bun runtime (uses bun:sqlite).
 * Run with: bun test src/db/
 */

import type { Database } from "bun:sqlite";
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
	promoteAttachmentToVault,
} from "./attachments";
import { freshDb } from "./db.test-utils";
import {
	createHlidDelegation,
	updateHlidDelegationCost,
	updateHlidDelegationTokens,
} from "./delegations";
import { appendLog, clearLogs, getLogs } from "./logs";
import {
	appendAskUserQuestion,
	appendMessage,
	appendPlanProposal,
	appendRealtimeTranscriptMessage,
	appendToolEvent,
	copyForkedSessionTranscript,
	getMessageForFork,
	getSessionAskUserQuestions,
	getSessionContextManifests,
	getSessionMessages,
	getSessionNextMessageSeq,
	getSessionPlanProposals,
	getSessionToolEventDetail,
	getSessionToolEventPage,
	getSessionToolEventSummaries,
	getSessionToolEventTranscriptWindow,
	replaceUserMessageContextManifest,
	setAskUserQuestionProvenance,
	setAskUserQuestionResolution,
	setMessageProviderTurnId,
	setMessageQueryId,
	setMessageRecap,
	setMessageSteerTargetSeq,
	setToolEventActivity,
	setToolEventResult,
	setToolEventSubagent,
} from "./messages";
import {
	getSessionPermissionEvents,
	recordPermissionEvent,
	recordProviderPermissionDenied,
} from "./permissions";
import { retainProjectPreviewFeedback } from "./projectPreviewFeedback";
import { getDb, setDbForTest } from "./schema";
import {
	createForkedSessionRow,
	createProviderNativeSessionImport,
	createSession,
	deleteSession,
	deleteSessionsOlderThan,
	getAllSessions,
	getRecentSessions,
	getSessionActualModel,
	getSessionAgentCwd,
	getSessionById,
	getSessionClaudeId,
	getSessionCleanupPlan,
	getSessionLastQueryContext,
	getSessionModel,
	getSessionProviderId,
	getSessionProviderRuntimeIdentity,
	getSessionProviderSession,
	getSessionSelection,
	getSessionsPaginated,
	recordQuery,
	renameSession,
	setSessionActualModelForProvider,
	setSessionAgentCwd,
	setSessionApprovalsReviewer,
	setSessionArchived,
	setSessionEffort,
	setSessionModel,
	setSessionModelAndPermissionMode,
	setSessionPermissionMode,
	setSessionPinned,
	setSessionProviderId,
	setSessionProviderSelection,
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
	getWeeklyStats,
	registerProvider,
} from "./usage";

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

function insertProviderTranscriptForTest(
	db: Database,
	providerId: string,
	nativeSessionId: string,
): void {
	db.run(
		`INSERT INTO provider_history_transcripts
		 (provider_id, native_session_id, subpath, source_path, source_hash,
		  payload_json, entry_count)
		 VALUES (?, ?, '', 'source.jsonl', 'hash', '[]', 1)`,
		[providerId, nativeSessionId],
	);
	db.run(
		`INSERT INTO provider_history_transcript_deltas
		 (provider_id, native_session_id, subpath, uuid, payload_json)
		 VALUES (?, ?, '', 'delta-1', '{"type":"user","uuid":"delta-1"}')`,
		[providerId, nativeSessionId],
	);
}

async function setActualModelForTest(
	sessionId: string,
	actualModel: string,
): Promise<void> {
	const database = await getDb();
	database.run(`UPDATE sessions SET actual_model = ? WHERE id = ?`, [
		actualModel,
		sessionId,
	]);
}

function providerSelectionStorageSnapshot(
	db: Database,
	sessionId: string,
): string {
	return JSON.stringify({
		session: db
			.query(
				`SELECT provider_id, model, selected_model, selected_effort,
				        selected_permission_mode, selected_approvals_reviewer,
				        actual_model, provider_session_id, claude_session_id
				 FROM sessions WHERE id = ?`,
			)
			.get(sessionId),
		transcripts: db
			.query(
				`SELECT * FROM provider_history_transcripts
				 ORDER BY provider_id, native_session_id, subpath`,
			)
			.all(),
		deltas: db
			.query(
				`SELECT * FROM provider_history_transcript_deltas
				 ORDER BY provider_id, native_session_id, subpath, id`,
			)
			.all(),
	});
}

describe("session creation", () => {
	it("persists a delegated child's complete runtime selection atomically", async () => {
		freshDb();
		await createSession("delegated-child", "Child", "gpt-5.6-sol", {
			effort: "high",
			permissionMode: "acceptEdits",
			approvalsReviewer: "auto_review",
			agentCwd: "/work/project",
			providerId: "codex",
		});

		expect(await getSessionById("delegated-child")).toMatchObject({
			model: "gpt-5.6-sol",
			selected_model: "gpt-5.6-sol",
			selected_effort: "high",
			selected_permission_mode: "acceptEdits",
			selected_approvals_reviewer: "auto_review",
			agent_cwd: "/work/project",
			provider_id: "codex",
		});
	});
});

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
				setSessionProviderSession("revision-session", "codex", "codex-session"),
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

	it("derives tool-call counts in session list and read projections", async () => {
		await createSession("with-tools", "With tools", "m");
		await createSession("without-tools", "Without tools", "m");
		await appendToolEvent("with-tools", 1, "tool-1", "Read", {});
		await appendToolEvent("with-tools", 1, "tool-2", "Bash", {});

		expect((await getSessionById("with-tools"))?.tool_call_count).toBe(2);
		expect((await getSessionById("without-tools"))?.tool_call_count).toBe(0);
		expect(
			(await getRecentSessions()).find((row) => row.id === "with-tools")
				?.tool_call_count,
		).toBe(2);
		expect(
			(await getSessionsPaginated(1, 20)).sessions.find(
				(row) => row.id === "with-tools",
			)?.tool_call_count,
		).toBe(2);
		expect(
			(await getAllSessions()).find((row) => row.id === "with-tools")
				?.tool_call_count,
		).toBe(2);
	});

	it("projects durable delegated-child usage without rewriting session accounting", async () => {
		await createSession("parent", "Parent", "m");
		await createSession("child", "Child", "m");
		await createHlidDelegation({
			id: "delegation",
			parentSessionId: "parent",
			parentTurnId: "turn",
			parentLabel: "Parent",
			childSessionId: "child",
			depth: 1,
			task: "Test usage fallback",
			providerId: "codex",
			model: "m",
			effort: null,
			serviceTier: null,
			workspace: "/workspace",
			permissionMode: "default",
			timeoutSeconds: 120,
		});
		await updateHlidDelegationTokens("delegation", 175_800);
		await updateHlidDelegationCost("delegation", 0.172);

		const rows = [
			await getSessionById("child"),
			(await getRecentSessions()).find((row) => row.id === "child"),
			(await getSessionsPaginated(1, 20)).sessions.find(
				(row) => row.id === "child",
			),
			(await getAllSessions()).find((row) => row.id === "child"),
		];
		for (const row of rows) {
			expect(row).toMatchObject({
				delegation_tokens_used: 175_800,
				delegation_cost_used: 0.172,
				total_cost: 0,
				total_input_tokens: 0,
				total_output_tokens: 0,
			});
		}
	});

	it("keeps pinned sessions above the selected list sort", async () => {
		const db = freshDb();
		await createSession("newest", "Newest", "m");
		await createSession("pinned", "Pinned", "m");
		db.run(
			`UPDATE sessions SET started_at = CASE id
			 WHEN 'newest' THEN 200 WHEN 'pinned' THEN 100 END`,
		);
		await setSessionPinned("pinned", true);

		const recent = await getSessionsPaginated(1, 20, { sort: "recent" });
		expect(recent.sessions.map((row) => row.id)).toEqual(["pinned", "newest"]);
		expect(recent.sessions[0]?.pinned).toBe(1);
		expect((await getRecentSessions()).map((row) => row.id)).toEqual([
			"pinned",
			"newest",
		]);
	});

	it("archives sessions reversibly, removes pinning, and protects cleanup", async () => {
		const db = freshDb();
		await createSession("kept", "Keep me", "m");
		await setSessionPinned("kept", true);
		db.run(`UPDATE sessions SET started_at = 1 WHERE id = 'kept'`);

		await setSessionArchived("kept", true);
		expect((await getSessionById("kept"))?.pinned).toBe(0);
		expect((await getSessionById("kept"))?.archived_at).not.toBeNull();
		expect((await getSessionsPaginated(1, 20)).sessions).toHaveLength(0);
		expect(
			(await getSessionsPaginated(1, 20, { archived: true })).sessions.map(
				(row) => row.id,
			),
		).toEqual(["kept"]);
		expect(await getRecentSessions()).toHaveLength(0);
		expect((await deleteSessionsOlderThan(1)).count).toBe(0);

		await setSessionArchived("kept", false);
		expect((await getSessionById("kept"))?.archived_at).toBeNull();
		expect((await getSessionsPaginated(1, 20)).sessions[0]?.id).toBe("kept");
	});

	it("preserves renamed fork provenance through archive and restore", async () => {
		freshDb();
		await createSession("source", "Original parent", "gpt-test", {
			providerId: "codex",
		});
		await setSessionProviderSession("source", "codex", "thread-source");
		await setSessionAgentCwd("source", "/work/project");
		await renameSession("source", "Renamed parent");
		await createForkedSessionRow("source", "child", "thread-child", {
			forkKind: "exact",
		});
		await renameSession("child", "Renamed child");
		await setSessionPinned("child", true);

		await setSessionArchived("child", true);
		await setSessionArchived("child", false);

		expect(await getSessionById("source")).toMatchObject({
			label: "Renamed parent",
		});
		expect(await getSessionById("child")).toMatchObject({
			label: "Renamed child",
			pinned: 0,
			archived_at: null,
			fork_parent_session_id: "source",
			fork_parent_label: "Renamed parent",
			fork_kind: "exact",
			provider_id: "codex",
			agent_cwd: "/work/project",
		});
		expect(
			(await getSessionsPaginated(1, 20, { search: "renamed child" })).sessions,
		).toMatchObject([{ id: "child", label: "Renamed child" }]);
		expect(
			(await getRecentSessions()).find((row) => row.id === "child"),
		).toMatchObject({ fork_parent_label: "Renamed parent" });
	});

	it("copies session-store resume mode to a native fork", async () => {
		const db = freshDb();
		await createSession("source", "Imported Claude", "sonnet", {
			providerId: "claude",
		});
		await setSessionProviderSession(
			"source",
			"claude",
			"native-source",
			"runtime-v1",
		);
		db.run(
			`UPDATE sessions SET history_resume_mode = 'session-store' WHERE id = 'source'`,
		);

		await createForkedSessionRow("source", "fork", "native-fork");

		expect(await getSessionById("fork")).toMatchObject({
			provider_id: "claude",
			provider_session_id: "native-fork",
			history_resume_mode: "session-store",
		});
		expect(await getSessionProviderRuntimeIdentity("fork", "claude")).toBe(
			"runtime-v1",
		);
	});

	it("rejects rename for a missing session", async () => {
		freshDb();
		await expect(renameSession("missing", "New label")).rejects.toThrow(
			"Session not found",
		);
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
		await setActualModelForTest("raven-fast", "gpt-5.4");
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
		await setSessionProviderSession("s1", "claude", "claude-uuid-123");
		expect(await getSessionClaudeId("s1")).toBe("claude-uuid-123");
	});

	it("the provider session setter clears claude_session_id", async () => {
		await createSession("s1", "L", "m");
		await setSessionProviderSession("s1", "claude", "claude-uuid-123");
		await setSessionProviderSession("s1", "claude", null);
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
		await createSession("s1", "L", "m", { providerId: "codex" });
		expect(
			await setSessionProviderSession("s1", "codex", "codex-thread-123"),
		).toBe(true);
		expect(await getSessionProviderId("s1")).toBe("codex");
		expect(await getSessionProviderSession("s1")).toBe("codex-thread-123");
		expect(await getSessionProviderSession("s1", "codex")).toBe(
			"codex-thread-123",
		);
		expect(await getSessionProviderSession("s1", "claude")).toBeNull();
		expect(await getSessionClaudeId("s1")).toBeNull();
	});

	it("stores runtime continuity with the native id and clears both together", async () => {
		await createSession("s1", "L", "m", { providerId: "acp:opencode" });
		expect(
			await setSessionProviderSession(
				"s1",
				"acp:opencode",
				"opencode-session",
				"runtime-v1",
			),
		).toBe(true);
		expect(await getSessionProviderRuntimeIdentity("s1", "acp:opencode")).toBe(
			"runtime-v1",
		);
		expect(await getSessionProviderRuntimeIdentity("s1", "codex")).toBeNull();

		await setSessionProviderSession("s1", "acp:opencode", null);
		expect(await getSessionProviderSession("s1", "acp:opencode")).toBeNull();
		expect(
			await getSessionProviderRuntimeIdentity("s1", "acp:opencode"),
		).toBeNull();
	});

	it("clears runtime continuity when provider ownership changes", async () => {
		await createSession("s1", "L", "m", { providerId: "acp:opencode" });
		await setSessionProviderSession(
			"s1",
			"acp:opencode",
			"opencode-session",
			"runtime-v1",
		);

		await setSessionProviderId("s1", "codex");

		expect(await getSessionProviderSession("s1")).toBeNull();
		expect(await getSessionProviderRuntimeIdentity("s1")).toBeNull();
	});

	it("rejects a provider-native session write after ownership changes", async () => {
		await createSession("s1", "L", "m", { providerId: "codex" });
		await setSessionProviderId("s1", "claude");

		expect(
			await setSessionProviderSession("s1", "codex", "stale-codex-thread"),
		).toBe(false);
		expect(await getSessionProviderId("s1")).toBe("claude");
		expect(await getSessionProviderSession("s1")).toBeNull();
	});

	it("keeps the legacy Claude getter compatible with provider sessions", async () => {
		await createSession("s1", "L", "m");
		await setSessionProviderSession("s1", "claude", "claude-uuid-123");
		expect(await getSessionProviderId("s1")).toBe("claude");
		expect(await getSessionProviderSession("s1", "claude")).toBe(
			"claude-uuid-123",
		);
	});

	it("deletes a last-owner transcript and deltas on a provider id switch", async () => {
		const db = await getDb();
		await createSession("s1", "L", "sonnet", { providerId: "claude" });
		await setSessionProviderSession("s1", "claude", "claude-native");
		insertProviderTranscriptForTest(db, "claude", "claude-native");

		await setSessionProviderId("s1", "codex");

		expect(
			db
				.query<{ transcripts: number; deltas: number }, []>(`
					SELECT
					 (SELECT COUNT(*) FROM provider_history_transcripts) AS transcripts,
					 (SELECT COUNT(*) FROM provider_history_transcript_deltas) AS deltas
				`)
				.get(),
		).toEqual({ transcripts: 0, deltas: 0 });
	});

	it("retains shared transcripts until the final provider selection switches", async () => {
		const db = await getDb();
		for (const sessionId of ["first", "second"]) {
			await createSession(sessionId, sessionId, "sonnet", {
				providerId: "claude",
			});
			await setSessionProviderSession(sessionId, "claude", "shared-native");
		}
		insertProviderTranscriptForTest(db, "claude", "shared-native");

		await setSessionProviderId("first", "codex");
		expect(
			db
				.query<{ count: number }, []>(
					`SELECT COUNT(*) AS count FROM provider_history_transcripts`,
				)
				.get()?.count,
		).toBe(1);

		await setSessionProviderSelection("second", "codex", {
			model: "gpt-5.6-sol",
			effort: "medium",
			permissionMode: "default",
		});
		expect(
			db
				.query<{ transcripts: number; deltas: number }, []>(`
					SELECT
					 (SELECT COUNT(*) FROM provider_history_transcripts) AS transcripts,
					 (SELECT COUNT(*) FROM provider_history_transcript_deltas) AS deltas
				`)
				.get(),
		).toEqual({ transcripts: 0, deltas: 0 });
	});

	it("preserves transcript ownership across same-provider updates", async () => {
		const db = await getDb();
		await createSession("s1", "L", "sonnet", { providerId: "claude" });
		await setSessionProviderSession("s1", "claude", "claude-native");
		insertProviderTranscriptForTest(db, "claude", "claude-native");

		await setSessionProviderId("s1", "claude");
		await setSessionProviderSelection("s1", "claude", {
			model: "opus",
			effort: "high",
			permissionMode: "default",
		});

		expect(
			db
				.query<{ transcripts: number; deltas: number }, []>(`
					SELECT
					 (SELECT COUNT(*) FROM provider_history_transcripts) AS transcripts,
					 (SELECT COUNT(*) FROM provider_history_transcript_deltas) AS deltas
				`)
				.get(),
		).toEqual({ transcripts: 1, deltas: 1 });
		expect(await getSessionProviderSession("s1", "claude")).toBe(
			"claude-native",
		);
	});
});

describe("sessions — provider-native imports", () => {
	beforeEach(() => freshDb());

	it("creates one resumable ACP-native Hlid owner with searchable metadata", async () => {
		expect(
			await createProviderNativeSessionImport({
				id: "imported-opencode",
				label: "Imported OpenCode work",
				agentCwd: "/work/project",
				providerId: "acp:opencode",
				providerSessionId: "native-opencode",
				providerRuntimeIdentity: "runtime-v1",
				model: "openai/gpt-5.6",
			}),
		).toEqual({
			created: true,
			rebound: false,
			sessionId: "imported-opencode",
		});

		const imported = await getSessionById("imported-opencode");
		expect(imported).toMatchObject({
			id: "imported-opencode",
			label: "Imported OpenCode work",
			agent_cwd: "/work/project",
			provider_id: "acp:opencode",
			provider_session_id: "native-opencode",
			model: "openai/gpt-5.6",
			selected_model: "openai/gpt-5.6",
			history_imported: 1,
			history_source: "acp-native",
			history_resume_mode: "native",
		});
		expect(imported).not.toHaveProperty("provider_runtime_identity");
		expect(
			await getSessionProviderRuntimeIdentity(
				"imported-opencode",
				"acp:opencode",
			),
		).toBe("runtime-v1");
		expect(
			(await getSessionsPaginated(1, 10, { search: "opencode work" })).sessions,
		).toMatchObject([{ id: "imported-opencode" }]);
	});

	it("atomically rebinds an existing provider-native owner without overwriting its label", async () => {
		await createProviderNativeSessionImport({
			id: "first-owner",
			label: "Original label",
			agentCwd: "/work/original",
			providerId: "acp:opencode",
			providerSessionId: "shared-native",
			providerRuntimeIdentity: "runtime-v1",
		});

		expect(
			await createProviderNativeSessionImport({
				id: "second-owner",
				label: "Replacement label",
				agentCwd: "/work/replacement",
				providerId: "acp:opencode",
				providerSessionId: "shared-native",
				providerRuntimeIdentity: "runtime-v2",
			}),
		).toEqual({ created: false, rebound: true, sessionId: "first-owner" });

		expect(await getSessionById("first-owner")).toMatchObject({
			label: "Original label",
			agent_cwd: "/work/replacement",
		});
		expect(
			await getSessionProviderRuntimeIdentity("first-owner", "acp:opencode"),
		).toBe("runtime-v2");
		expect(
			await createProviderNativeSessionImport({
				id: "unused-third-owner",
				label: "Another replacement label",
				agentCwd: "/work/replacement",
				providerId: "acp:opencode",
				providerSessionId: "shared-native",
				providerRuntimeIdentity: "runtime-v2",
			}),
		).toEqual({ created: false, rebound: false, sessionId: "first-owner" });
		expect(await getSessionById("second-owner")).toBeNull();
	});

	it("never exposes runtime continuity through public session row projections", async () => {
		await createSession("private-runtime", "Private runtime", "model", {
			providerId: "acp:opencode",
		});
		await setSessionProviderSession(
			"private-runtime",
			"acp:opencode",
			"native-private",
			"runtime-secret-digest",
		);

		const rows = [
			await getSessionById("private-runtime"),
			(await getSessionsPaginated(1, 10)).sessions.find(
				(row) => row.id === "private-runtime",
			),
			(await getAllSessions()).find((row) => row.id === "private-runtime"),
			(await getRecentSessions()).find((row) => row.id === "private-runtime"),
		];
		for (const row of rows) {
			expect(row).toBeDefined();
			expect(row).not.toHaveProperty("provider_runtime_identity");
		}
		expect(
			await getSessionProviderRuntimeIdentity(
				"private-runtime",
				"acp:opencode",
			),
		).toBe("runtime-secret-digest");
	});

	it("rolls back without partial search data when the Hlid id is occupied", async () => {
		const db = await getDb();
		await createSession("occupied", "Existing", "m", { providerId: "codex" });

		await expect(
			createProviderNativeSessionImport({
				id: "occupied",
				label: "Imported OpenCode",
				agentCwd: "/work/project",
				providerId: "acp:opencode",
				providerSessionId: "native-opencode",
				providerRuntimeIdentity: "runtime-v1",
			}),
		).rejects.toThrow("Session id already exists: occupied");
		expect(
			db
				.query<{ count: number }, []>(
					`SELECT COUNT(*) AS count FROM session_search
					 WHERE session_id = 'occupied'`,
				)
				.get()?.count,
		).toBe(1);
		expect(
			db
				.query<{ count: number }, []>(
					`SELECT COUNT(*) AS count FROM sessions
					 WHERE provider_id = 'acp:opencode'
					   AND provider_session_id = 'native-opencode'`,
				)
				.get()?.count,
		).toBe(0);
	});
});

describe("sessions — guarded selection transactions", () => {
	beforeEach(() => freshDb());

	it("leaves the complete provider selection and transcript storage unchanged when its guard rejects", async () => {
		const db = await getDb();
		await createSession("guarded", "Guarded", "claude-sonnet-5", {
			providerId: "claude",
			effort: "high",
			permissionMode: "auto",
			approvalsReviewer: "auto_review",
		});
		await setSessionProviderSession("guarded", "claude", "claude-guarded");
		await setActualModelForTest("guarded", "claude-sonnet-5-20260801");
		insertProviderTranscriptForTest(db, "claude", "claude-guarded");
		const before = providerSelectionStorageSnapshot(db, "guarded");
		let callbackCalls = 0;

		expect(
			await setSessionProviderSelection(
				"guarded",
				"codex",
				{
					model: "gpt-5.6-sol",
					effort: "low",
					permissionMode: "default",
					approvalsReviewer: "user",
				},
				{
					guard: () => false,
					onCommitted: () => {
						callbackCalls += 1;
					},
				},
			),
		).toBe(false);
		expect(callbackCalls).toBe(0);
		expect(providerSelectionStorageSnapshot(db, "guarded")).toBe(before);
	});

	it("returns false and skips the provider callback for a missing session", async () => {
		let callbackCalls = 0;

		expect(
			await setSessionProviderSelection(
				"missing",
				"claude",
				{
					model: "claude-sonnet-5",
					effort: "high",
					permissionMode: "auto",
					approvalsReviewer: "user",
				},
				{
					onCommitted: () => {
						callbackCalls += 1;
					},
				},
			),
		).toBe(false);
		expect(callbackCalls).toBe(0);
		expect(await getSessionById("missing")).toBeNull();
	});

	it("atomically replaces the provider tuple and removes only the retired unowned transcript", async () => {
		const db = await getDb();
		await createSession("switching", "Switching", "claude-sonnet-5", {
			providerId: "claude",
			effort: "high",
			permissionMode: "auto",
			approvalsReviewer: "user",
		});
		await setSessionProviderSession("switching", "claude", "retired-native");
		await setActualModelForTest("switching", "claude-sonnet-5-20260801");
		insertProviderTranscriptForTest(db, "claude", "retired-native");

		await createSession("survivor", "Survivor", "claude-sonnet-5", {
			providerId: "claude",
		});
		await setSessionProviderSession("survivor", "claude", "shared-native");
		insertProviderTranscriptForTest(db, "claude", "shared-native");

		expect(
			await setSessionProviderSelection("switching", "codex", {
				model: "gpt-5.6-sol",
				effort: "xhigh",
				permissionMode: "bypassPermissions",
				approvalsReviewer: "auto_review",
			}),
		).toBe(true);
		expect(
			db
				.query(
					`SELECT provider_id, model, selected_model, selected_effort,
					        selected_permission_mode, selected_approvals_reviewer,
					        actual_model, provider_session_id, claude_session_id
					 FROM sessions WHERE id = ?`,
				)
				.get("switching"),
		).toEqual({
			provider_id: "codex",
			model: "gpt-5.6-sol",
			selected_model: "gpt-5.6-sol",
			selected_effort: "xhigh",
			selected_permission_mode: "bypassPermissions",
			selected_approvals_reviewer: "auto_review",
			actual_model: null,
			provider_session_id: null,
			claude_session_id: null,
		});
		expect(
			db
				.query(
					`SELECT provider_id, native_session_id
					 FROM provider_history_transcripts
					 ORDER BY provider_id, native_session_id`,
				)
				.all(),
		).toEqual([{ provider_id: "claude", native_session_id: "shared-native" }]);
		expect(
			db
				.query(
					`SELECT provider_id, native_session_id
					 FROM provider_history_transcript_deltas
					 ORDER BY provider_id, native_session_id`,
				)
				.all(),
		).toEqual([{ provider_id: "claude", native_session_id: "shared-native" }]);
	});

	it("rolls back the provider tuple when transcript retirement fails", async () => {
		const db = await getDb();
		await createSession("rollback", "Rollback", "claude-sonnet-5", {
			providerId: "claude",
			effort: "high",
			permissionMode: "auto",
			approvalsReviewer: "user",
		});
		await setSessionProviderSession("rollback", "claude", "rollback-native");
		await setActualModelForTest("rollback", "claude-sonnet-5-20260801");
		insertProviderTranscriptForTest(db, "claude", "rollback-native");
		const before = providerSelectionStorageSnapshot(db, "rollback");
		let callbackCalls = 0;
		db.run(`
			CREATE TRIGGER block_provider_transcript_retirement
			BEFORE DELETE ON provider_history_transcripts
			BEGIN
				SELECT RAISE(ABORT, 'blocked provider transcript retirement');
			END
		`);

		await expect(
			setSessionProviderSelection(
				"rollback",
				"codex",
				{
					model: "gpt-5.6-sol",
					effort: "medium",
					permissionMode: "default",
					approvalsReviewer: "auto_review",
				},
				{
					onCommitted: () => {
						callbackCalls += 1;
					},
				},
			),
		).rejects.toThrow("blocked provider transcript retirement");
		expect(callbackCalls).toBe(0);
		expect(providerSelectionStorageSnapshot(db, "rollback")).toBe(before);
	});

	it("preserves same-provider runtime evidence and calls onCommitted after commit", async () => {
		const db = await getDb();
		await createSession("same-owner", "Same owner", "claude-sonnet-5", {
			providerId: "claude",
			effort: "high",
			permissionMode: "default",
			approvalsReviewer: "user",
		});
		await setSessionProviderSession("same-owner", "claude", "same-native");
		await setActualModelForTest("same-owner", "claude-sonnet-5-20260801");
		insertProviderTranscriptForTest(db, "claude", "same-native");
		let callbackInTransaction: boolean | undefined;
		let callbackSelection: unknown;

		expect(
			await setSessionProviderSelection(
				"same-owner",
				"claude",
				{
					model: "claude-sonnet-5",
					effort: "medium",
					permissionMode: "auto",
					approvalsReviewer: "auto_review",
				},
				{
					onCommitted: () => {
						callbackInTransaction = db.inTransaction;
						callbackSelection = db
							.query(
								`SELECT selected_effort, selected_permission_mode,
								        selected_approvals_reviewer
								 FROM sessions WHERE id = ?`,
							)
							.get("same-owner");
					},
				},
			),
		).toBe(true);
		expect(callbackInTransaction).toBe(false);
		expect(callbackSelection).toEqual({
			selected_effort: "medium",
			selected_permission_mode: "auto",
			selected_approvals_reviewer: "auto_review",
		});
		expect(
			db
				.query(
					`SELECT actual_model, provider_session_id, claude_session_id
					 FROM sessions WHERE id = ?`,
				)
				.get("same-owner"),
		).toEqual({
			actual_model: "claude-sonnet-5-20260801",
			provider_session_id: "same-native",
			claude_session_id: "same-native",
		});
		expect(
			db
				.query<{ count: number }, []>(
					`SELECT COUNT(*) AS count FROM provider_history_transcripts`,
				)
				.get()?.count,
		).toBe(1);
	});

	it("keeps a committed provider selection when onCommitted throws", async () => {
		await createSession("callback-error", "Callback error", "gpt-5.5", {
			providerId: "codex",
		});

		expect(
			await setSessionProviderSelection(
				"callback-error",
				"claude",
				{
					model: "claude-sonnet-5",
					effort: "high",
					permissionMode: "auto",
					approvalsReviewer: "user",
				},
				{
					onCommitted: () => {
						throw new Error("owner callback failed");
					},
				},
			),
		).toBe(true);
		expect(await getSessionSelection("callback-error")).toEqual({
			agentCwd: null,
			providerId: "claude",
			model: "claude-sonnet-5",
			effort: "high",
			permissionMode: "auto",
			approvalsReviewer: "user",
		});
	});

	it("writes model and permission together or neither under guard and missing-row rejection", async () => {
		const db = await getDb();
		await createSession("model-guard", "Model guard", "gpt-5.5", {
			providerId: "codex",
			permissionMode: "bypassPermissions",
		});
		await setActualModelForTest("model-guard", "gpt-5.5-20260801");
		const before = db
			.query(
				`SELECT model, selected_model, selected_permission_mode, actual_model
				 FROM sessions WHERE id = ?`,
			)
			.get("model-guard");
		let callbackCalls = 0;

		expect(
			await setSessionModelAndPermissionMode(
				"model-guard",
				"gpt-5.6-sol",
				"default",
				{
					guard: () => false,
					onCommitted: () => {
						callbackCalls += 1;
					},
				},
			),
		).toBe(false);
		expect(
			db
				.query(
					`SELECT model, selected_model, selected_permission_mode, actual_model
					 FROM sessions WHERE id = ?`,
				)
				.get("model-guard"),
		).toEqual(before);
		expect(
			await setSessionModelAndPermissionMode(
				"missing",
				"gpt-5.6-sol",
				"default",
				{
					onCommitted: () => {
						callbackCalls += 1;
					},
				},
			),
		).toBe(false);
		expect(callbackCalls).toBe(0);
		expect(await getSessionById("missing")).toBeNull();
	});

	it("preserves or clears actual_model with the exact model-and-permission tuple", async () => {
		const db = await getDb();
		await createSession("model-mode", "Model mode", "gpt-5.5", {
			providerId: "codex",
			permissionMode: "bypassPermissions",
		});
		await setActualModelForTest("model-mode", "gpt-5.5-20260801");

		expect(
			await setSessionModelAndPermissionMode(
				"model-mode",
				"gpt-5.5",
				"default",
			),
		).toBe(true);
		expect(
			db
				.query(
					`SELECT model, selected_model, selected_permission_mode, actual_model
					 FROM sessions WHERE id = ?`,
				)
				.get("model-mode"),
		).toEqual({
			model: "gpt-5.5",
			selected_model: "gpt-5.5",
			selected_permission_mode: "default",
			actual_model: "gpt-5.5-20260801",
		});

		expect(
			await setSessionModelAndPermissionMode(
				"model-mode",
				"gpt-5.6-sol",
				"bypassPermissions",
				{
					onCommitted: () => {
						throw new Error("owner callback failed");
					},
				},
			),
		).toBe(true);
		expect(
			db
				.query(
					`SELECT model, selected_model, selected_permission_mode, actual_model
					 FROM sessions WHERE id = ?`,
				)
				.get("model-mode"),
		).toEqual({
			model: "gpt-5.6-sol",
			selected_model: "gpt-5.6-sol",
			selected_permission_mode: "bypassPermissions",
			actual_model: null,
		});
	});
});

describe("sessions — imported history source migration", () => {
	it("backfills source labels for imports created before source tracking", async () => {
		const database = freshDb();
		await createSession("claude-import", "Claude import", "m");
		await createSession("codex-import", "Codex import", "m");
		database.run(`
			UPDATE sessions
			SET history_imported = 1,
			    provider_id = CASE id
					WHEN 'claude-import' THEN 'claude'
					ELSE 'codex'
				END,
			    history_source = NULL
		`);
		database.run(
			`DELETE FROM settings WHERE key = '_migrated_sessions_history_source_backfill'`,
		);

		setDbForTest(database);

		expect(
			database
				.query(`SELECT id, history_source FROM sessions ORDER BY id`)
				.all(),
		).toEqual([
			{ id: "claude-import", history_source: "claude-cli" },
			{ id: "codex-import", history_source: "codex-cli" },
		]);
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

	it("invalidates an observed model only when the selected model changes", async () => {
		await createSession("s1", "L", "gpt-5.6-sol", {
			providerId: "codex",
		});
		await setActualModelForTest("s1", "gpt-5.6-sol-20260701");

		await setSessionModel("s1", "gpt-5.6-sol");
		expect(await getSessionActualModel("s1")).toBe("gpt-5.6-sol-20260701");

		await setSessionModel("s1", "gpt-5.6-terra");
		expect(await getSessionActualModel("s1")).toBeNull();
		expect(
			await setSessionActualModelForProvider(
				"s1",
				"codex",
				"gpt-5.6-sol",
				"stale-sol-runtime",
			),
		).toBe(false);
		expect(await getSessionActualModel("s1")).toBeNull();
	});

	it("keeps an explicit provider-default model selection across observations", async () => {
		await createSession("s1", "L", "gpt-5.6-sol", {
			providerId: "codex",
		});
		await setActualModelForTest("s1", "gpt-5.6-sol-20260701");

		await setSessionProviderSelection("s1", "codex", {
			model: undefined,
			effort: "medium",
			permissionMode: "default",
		});
		expect(await getSessionSelection("s1")).toMatchObject({ model: "" });
		expect(await getSessionActualModel("s1")).toBeNull();

		expect(
			await setSessionActualModelForProvider(
				"s1",
				"codex",
				"",
				"gpt-5.6-default-20260701",
			),
		).toBe(true);
		expect(await getSessionActualModel("s1")).toBe("gpt-5.6-default-20260701");
		expect(await getSessionModel("s1")).toBe("");
	});

	it("persists and reads all Raven session controls together", async () => {
		await createSession("s1", "L", "gpt-5.6-sol", {
			effort: "high",
			permissionMode: "bypassPermissions",
			approvalsReviewer: "auto_review",
		});
		await setSessionAgentCwd("s1", "/home/kyle/agents/hlid");
		await setSessionProviderId("s1", "codex");

		expect(await getSessionSelection("s1")).toEqual({
			agentCwd: "/home/kyle/agents/hlid",
			providerId: "codex",
			model: "gpt-5.6-sol",
			effort: "high",
			permissionMode: "bypassPermissions",
			approvalsReviewer: "auto_review",
		});

		await setSessionModel("s1", "gpt-5.6-terra");
		await setSessionEffort("s1", "xhigh");
		await setSessionPermissionMode("s1", "default");
		await setSessionApprovalsReviewer("s1", "user");
		expect(await getSessionSelection("s1")).toMatchObject({
			model: "gpt-5.6-terra",
			effort: "xhigh",
			permissionMode: "default",
			approvalsReviewer: "user",
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
			approvalsReviewer: null,
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

	it("sets and gets actual_model for the matching ownership tuple", async () => {
		await createSession("s1", "L", "m", { providerId: "claude" });
		expect(
			await setSessionActualModelForProvider(
				"s1",
				"claude",
				"m",
				"claude-opus-4-5",
			),
		).toBe(true);
		expect(await getSessionActualModel("s1")).toBe("claude-opus-4-5");
	});

	it("atomically transfers provider-owned controls and rejects delayed actual models", async () => {
		await createSession("round-trip", "Round trip", "gpt-5.5", {
			providerId: "codex",
			effort: "medium",
			permissionMode: "bypassPermissions",
			approvalsReviewer: "auto_review",
		});
		await setSessionProviderSession("round-trip", "codex", "codex-thread");
		await setSessionActualModelForProvider(
			"round-trip",
			"codex",
			"gpt-5.5",
			"gpt-5.5",
		);

		await setSessionProviderSelection("round-trip", "codex", {
			model: "gpt-5.5-mini",
			effort: "low",
			permissionMode: "default",
			approvalsReviewer: "auto_review",
		});
		expect(await getSessionActualModel("round-trip")).toBeNull();
		expect(await getSessionProviderSession("round-trip", "codex")).toBe(
			"codex-thread",
		);
		await setSessionActualModelForProvider(
			"round-trip",
			"codex",
			"gpt-5.5-mini",
			"gpt-5.5-mini-20260701",
		);
		await setSessionProviderSelection("round-trip", "codex", {
			model: "gpt-5.5-mini",
			effort: "medium",
			permissionMode: "default",
			approvalsReviewer: "user",
		});
		expect(await getSessionActualModel("round-trip")).toBe(
			"gpt-5.5-mini-20260701",
		);

		await setSessionProviderSelection("round-trip", "claude", {
			model: "claude-sonnet-5",
			effort: "high",
			permissionMode: "default",
			approvalsReviewer: undefined,
		});

		expect(await getSessionSelection("round-trip")).toEqual({
			agentCwd: null,
			providerId: "claude",
			model: "claude-sonnet-5",
			effort: "high",
			permissionMode: "default",
			approvalsReviewer: null,
		});
		expect(await getSessionActualModel("round-trip")).toBeNull();
		expect(await getSessionProviderSession("round-trip", "claude")).toBeNull();

		// A completion from the retired Codex runtime cannot reclaim Claude's
		// current-session presentation after the provider switch.
		await setSessionActualModelForProvider(
			"round-trip",
			"codex",
			"gpt-5.5-mini",
			"gpt-5.5",
		);
		expect(await getSessionActualModel("round-trip")).toBeNull();

		await setSessionActualModelForProvider(
			"round-trip",
			"claude",
			"claude-sonnet-5",
			"claude-sonnet-5",
		);
		expect(await getSessionActualModel("round-trip")).toBe("claude-sonnet-5");

		await setSessionProviderSelection("round-trip", "codex", {
			model: "gpt-5.5",
			effort: "medium",
			permissionMode: "bypassPermissions",
			approvalsReviewer: "auto_review",
		});
		expect(await getSessionSelection("round-trip")).toEqual({
			agentCwd: null,
			providerId: "codex",
			model: "gpt-5.5",
			effort: "medium",
			permissionMode: "bypassPermissions",
			approvalsReviewer: "auto_review",
		});
		expect(await getSessionActualModel("round-trip")).toBeNull();
	});

	it("keeps legacy selected controls while invalidating changed-provider runtime metadata", async () => {
		await createSession("legacy-switch", "Legacy switch", "claude-sonnet-5", {
			providerId: "claude",
			effort: "high",
			permissionMode: "acceptEdits",
			approvalsReviewer: "user",
		});
		await setSessionProviderSession("legacy-switch", "claude", "claude-thread");
		await setSessionActualModelForProvider(
			"legacy-switch",
			"claude",
			"claude-sonnet-5",
			"claude-sonnet-5",
		);

		await setSessionProviderId("legacy-switch", "codex");

		expect(await getSessionSelection("legacy-switch")).toEqual({
			agentCwd: null,
			providerId: "codex",
			model: "claude-sonnet-5",
			effort: "high",
			permissionMode: "acceptEdits",
			approvalsReviewer: "user",
		});
		expect(await getSessionActualModel("legacy-switch")).toBeNull();
		expect(
			await getSessionProviderSession("legacy-switch", "codex"),
		).toBeNull();
		expect(await getSessionClaudeId("legacy-switch")).toBeNull();
		await setSessionProviderId("legacy-switch", "claude");
		expect(
			await getSessionProviderSession("legacy-switch", "claude"),
		).toBeNull();
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

	it("falls back to published pricing when provider telemetry is missing", async () => {
		const database = freshDb();
		await createSession("s1", "L", "claude-fable-5");
		const recorded = await recordQuery(
			"s1",
			baseQuery({
				cost: 0,
				cost_known: false,
				estimated_cost: null,
				input_tokens: 1_000_000,
				output_tokens: 0,
			}),
			"claude",
		);

		expect(recorded.estimatedCost).toBe(10);
		expect((await getRecentSessions())[0].unpriced_query_count).toBe(0);
		expect(
			database
				.query(`SELECT estimated_cost, cost_known, unpriced FROM usage_queries`)
				.get(),
		).toEqual({ estimated_cost: 10, cost_known: 1, unpriced: 0 });
	});

	it("uses the configured model instead of persisting a synthetic marker", async () => {
		const database = freshDb();
		await createSession("s1", "L", "gpt-5.6-terra");
		const recorded = await recordQuery(
			"s1",
			baseQuery({
				cost: 0,
				cost_known: false,
				estimated_cost: null,
				model: "<synthetic>",
			}),
			"codex",
		);

		expect(recorded.estimatedCost).not.toBeNull();
		expect(database.query(`SELECT model FROM usage_queries`).get()).toEqual({
			model: "gpt-5.6-terra",
		});
	});

	it("does not relabel a synthetic turn from another provider's model", async () => {
		const database = freshDb();
		await createSession("s1", "L", "gpt-5.6-terra");
		const recorded = await recordQuery(
			"s1",
			baseQuery({
				cost: 0,
				cost_known: false,
				estimated_cost: null,
				model: "<synthetic>",
			}),
			"claude",
		);

		expect(recorded.estimatedCost).toBeNull();
		expect(
			database.query(`SELECT model, unpriced FROM usage_queries`).get(),
		).toEqual({ model: "<synthetic>", unpriced: 1 });
	});

	it("backfills known aliases and session-resolved synthetic models", async () => {
		const database = freshDb();
		await createSession("review", "Review", "codex-auto-review");
		await recordQuery(
			"review",
			baseQuery({ cost: 0, cost_known: false, estimated_cost: null }),
			"codex",
		);
		await createSession("synthetic", "Synthetic", "gpt-5.6-terra");
		await recordQuery(
			"synthetic",
			baseQuery({ cost: 0, cost_known: false, estimated_cost: null }),
			"codex",
		);

		database.run(`
			UPDATE queries
			SET model = CASE WHEN session_id = 'synthetic' THEN '<synthetic>' ELSE model END,
			    estimated_cost = NULL, cost_known = 0
		`);
		database.run(`
			UPDATE usage_queries
			SET model = CASE WHEN session_id = 'synthetic' THEN '<synthetic>' ELSE model END,
			    estimated_cost = NULL, cost_known = 0, unpriced = 1
		`);
		database.run(
			`UPDATE sessions SET total_estimated_cost = 0, unpriced_query_count = 1`,
		);
		database.run(
			`UPDATE usage_daily SET estimated_cost = 0, unpriced_queries = 2`,
		);
		database.run(
			`DELETE FROM settings WHERE key = '_migrated_provider_pricing_fallback_v1'`,
		);
		setDbForTest(database);

		expect(
			database
				.query(
					`SELECT session_id, model, cost_known, unpriced
					 FROM usage_queries ORDER BY session_id`,
				)
				.all(),
		).toEqual([
			{
				session_id: "review",
				model: "codex-auto-review",
				cost_known: 1,
				unpriced: 0,
			},
			{
				session_id: "synthetic",
				model: "gpt-5.6-terra",
				cost_known: 1,
				unpriced: 0,
			},
		]);
		expect((await getAggregatedStats()).today.unpriced_queries).toBe(0);
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

	it("persists realtime transcript provenance idempotently", async () => {
		await createSession("s1", "Live", "gpt-5.6-sol");
		const input = {
			sessionId: "s1",
			seq: 3,
			role: "assistant" as const,
			text: "Hello from Live",
			utteranceId: "codex-realtime-3",
			realtimeSessionId: "raven-live-test",
			providerRealtimeSessionId: "provider-call-test",
		};
		const inserted = await appendRealtimeTranscriptMessage(input);
		const duplicate = await appendRealtimeTranscriptMessage(input);

		expect(inserted.inserted).toBe(true);
		expect(duplicate).toEqual({ ...inserted, inserted: false });
		expect(await getMessageForFork(inserted.id)).toMatchObject({
			forkSupported: false,
		});
		expect(await getSessionMessages("s1")).toMatchObject([
			{
				id: inserted.id,
				seq: 3,
				role: "assistant",
				text: "Hello from Live",
				query_id: null,
				source: "codex_realtime",
				utterance_id: "codex-realtime-3",
				realtime_session_id: "raven-live-test",
				provider_realtime_session_id: "provider-call-test",
				fork_supported: 0,
			},
		]);
		await expect(
			appendRealtimeTranscriptMessage({ ...input, text: "collision" }),
		).rejects.toThrow("utterance collision");
		await createSession("fork", "Live copy", "gpt-5.6-sol");
		expect(await copyForkedSessionTranscript("s1", "fork")).toBe(1);
		expect(await getSessionMessages("fork")).toMatchObject([
			{
				source: "codex_realtime",
				utterance_id: "codex-realtime-3",
				realtime_session_id: "raven-live-test",
				provider_realtime_session_id: "provider-call-test",
				fork_supported: 0,
			},
		]);
	});

	it("appends and retrieves messages in seq order", async () => {
		await createSession("s1", "L", "m");
		await appendMessage("s1", 0, "user", "hello", "turn-1");
		await appendMessage("s1", 1, "assistant", "world");
		await appendMessage("s1", 2, "user", "steer", "turn-2", 1, undefined, 2);
		const rows = await getSessionMessages("s1");
		expect(rows).toHaveLength(3);
		expect(rows[0].role).toBe("user");
		expect(rows[0].text).toBe("hello");
		expect(rows[0].turn_id).toBe("turn-1");
		expect(rows[1].role).toBe("assistant");
		expect(rows[1].turn_id).toBeNull();
		expect(rows[2].turn_id).toBe("turn-2");
		expect(rows[2].steer_target_seq).toBe(1);
		expect(rows[2].steer_tool_event_index).toBe(2);
	});

	it("joins exact, estimated, and known-zero query costs onto assistant messages", async () => {
		await createSession("s1", "L", "model");
		await appendMessage("s1", 0, "assistant", "exact");
		await appendMessage("s1", 1, "assistant", "estimated");
		await appendMessage("s1", 2, "assistant", "known zero");

		const exact = await recordQuery(
			"s1",
			baseQuery({ cost: 0.25, estimated_cost: null }),
			"acp:test",
		);
		const estimated = await recordQuery(
			"s1",
			baseQuery({ cost: 0, estimated_cost: 0.125 }),
			"acp:test",
		);
		const knownZero = await recordQuery(
			"s1",
			baseQuery({ cost: 0, cost_known: true, estimated_cost: null }),
			"acp:test",
		);

		await setMessageQueryId("s1", 0, exact.queryId);
		await setMessageQueryId("s1", 1, estimated.queryId);
		await setMessageQueryId("s1", 2, knownZero.queryId);

		expect(await getSessionMessages("s1")).toMatchObject([
			{
				role: "assistant",
				query_id: exact.queryId,
				query_cost: 0.25,
				query_cost_known: 1,
				query_estimated_cost: null,
			},
			{
				role: "assistant",
				query_id: estimated.queryId,
				query_cost: 0,
				query_cost_known: 1,
				query_estimated_cost: 0.125,
			},
			{
				role: "assistant",
				query_id: knownZero.queryId,
				query_cost: 0,
				query_cost_known: 1,
				query_estimated_cost: null,
			},
		]);

		await createSession("other", "Other", "model");
		const otherQuery = await recordQuery(
			"other",
			baseQuery({ cost: 9 }),
			"acp:test",
		);
		await expect(
			setMessageQueryId("s1", 0, otherQuery.queryId),
		).rejects.toThrow("no matching assistant/query");
	});

	it("backfills the assistant target for a steer persisted before its response", async () => {
		await createSession("s1", "L", "m");
		await appendMessage(
			"s1",
			1,
			"user",
			"early steer",
			"steer-1",
			undefined,
			undefined,
			0,
		);
		await appendMessage("s1", 2, "assistant", "response");

		await setMessageSteerTargetSeq("s1", 1, 2);

		const rows = await getSessionMessages("s1");
		expect(rows[0].steer_target_seq).toBe(2);
		expect(rows[0].steer_tool_event_index).toBe(0);
		await expect(setMessageSteerTargetSeq("s1", 99, 2)).rejects.toThrow(
			"no user row found",
		);
	});

	it("pages Hlid context manifests outside visible message text", async () => {
		await createSession("s1", "L", "m");
		const first = JSON.stringify({ contractVersion: 1, promptChars: 10 });
		const second = JSON.stringify({ contractVersion: 1, promptChars: 20 });
		await appendMessage("s1", 0, "user", "hello", "turn-1", undefined, first);
		await appendMessage("s1", 1, "assistant", "world");
		await appendMessage("s1", 2, "user", "again", "turn-2", undefined, second);

		const latest = await getSessionContextManifests("s1", 1);
		expect(latest.rows).toHaveLength(1);
		expect(latest.rows[0]).toMatchObject({
			seq: 2,
			turn_number: 2,
			turn_id: "turn-2",
			message_preview: "again",
			context_manifest_json: second,
		});
		expect(latest.hasMore).toBe(true);

		const previous = await getSessionContextManifests("s1", 1, 2);
		expect(previous.rows).toHaveLength(1);
		expect(previous.rows[0]).toMatchObject({
			seq: 0,
			turn_number: 1,
			turn_id: "turn-1",
			message_preview: "hello",
			context_manifest_json: first,
		});
		expect(previous.hasMore).toBe(false);
		expect((await getSessionMessages("s1"))[2].text).toBe("again");
	});

	it("replaces only the exact persisted user context receipt", async () => {
		await createSession("s1", "L", "m");
		const initial = JSON.stringify({ contractVersion: 1, promptChars: 10 });
		const accepted = JSON.stringify({
			contractVersion: 1,
			promptChars: 10,
			structuredPrompt: { imageCount: 1, imageDecodedBytes: 3 },
		});
		await appendMessage("s1", 0, "user", "hello", "turn-1", undefined, initial);
		await appendMessage(
			"s1",
			0,
			"assistant",
			"same sequence",
			undefined,
			undefined,
			initial,
		);

		await replaceUserMessageContextManifest("s1", 0, initial, accepted);

		const rows = await getSessionMessages("s1");
		expect(rows.find((row) => row.role === "user")?.context_manifest_json).toBe(
			accepted,
		);
		expect(
			rows.find((row) => row.role === "assistant")?.context_manifest_json,
		).toBe(initial);
		await expect(
			replaceUserMessageContextManifest("s1", 0, initial, "stale write"),
		).rejects.toThrow("no exact user receipt");
		expect(
			(await getSessionMessages("s1")).find((row) => row.role === "user")
				?.context_manifest_json,
		).toBe(accepted);
	});

	it("refuses an ambiguous user context receipt without changing either row", async () => {
		await createSession("s1", "L", "m");
		const initial = JSON.stringify({ contractVersion: 1, promptChars: 10 });
		await appendMessage(
			"s1",
			0,
			"user",
			"first",
			undefined,
			undefined,
			initial,
		);
		await appendMessage(
			"s1",
			0,
			"user",
			"duplicate",
			undefined,
			undefined,
			initial,
		);

		await expect(
			replaceUserMessageContextManifest("s1", 0, initial, "replacement"),
		).rejects.toThrow("no exact user receipt");
		expect(
			(await getSessionMessages("s1")).map((row) => row.context_manifest_json),
		).toEqual([initial, initial]);
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

	it("copies an exact fork transcript through its provider turn boundary", async () => {
		await createSession("source", "Codex work", "gpt-5.6-sol", {
			effort: "high",
			permissionMode: "default",
			approvalsReviewer: "auto_review",
			providerId: "codex",
		});
		await setSessionAgentCwd("source", "/work/project");
		await setSessionProviderSession("source", "codex", "thread-source");
		const contextManifest = JSON.stringify({
			contractVersion: 1,
			promptChars: 42,
		});
		await appendMessage(
			"source",
			0,
			"user",
			"First prompt",
			"turn-1",
			undefined,
			contextManifest,
		);
		const assistantId = await appendMessage(
			"source",
			1,
			"assistant",
			"First answer",
			"turn-1",
		);
		const recorded = await recordQuery(
			"source",
			baseQuery({ cost: 0.02, estimated_cost: null }),
			"codex",
		);
		await setMessageQueryId("source", 1, recorded.queryId);
		await setMessageProviderTurnId("source", 1, "provider-turn-1");
		await appendToolEvent(
			"source",
			1,
			"tool-1",
			"Read",
			{ path: "README.md" },
			undefined,
			{ providerId: "codex", model: "gpt-5.6-sol", agentCwd: "/work/project" },
		);
		await setToolEventResult("source", "tool-1", "contents", false);
		await appendMessage(
			"source",
			2,
			"user",
			"Steered direction",
			"steer-1",
			1,
			undefined,
			1,
		);
		await appendMessage("source", 3, "user", "Later prompt", "turn-2");
		await appendMessage("source", 4, "assistant", "Later answer", "turn-2");

		await createForkedSessionRow("source", "fork", "thread-fork", {
			parentMessageId: assistantId,
			forkKind: "exact",
		});
		expect(await copyForkedSessionTranscript("source", "fork", 1)).toBe(3);

		const fork = await getSessionById("fork");
		expect(fork).toMatchObject({
			label: "Codex work (fork)",
			provider_id: "codex",
			agent_cwd: "/work/project",
			selected_model: "gpt-5.6-sol",
			selected_effort: "high",
			selected_permission_mode: "default",
			selected_approvals_reviewer: "auto_review",
			fork_parent_session_id: "source",
			fork_parent_message_id: assistantId,
			fork_kind: "exact",
		});
		expect(await getSessionProviderSession("fork", "codex")).toBe(
			"thread-fork",
		);
		const messages = await getSessionMessages("fork");
		expect(messages.map((message) => message.text)).toEqual([
			"First prompt",
			"First answer",
			"Steered direction",
		]);
		expect(messages[1].provider_turn_id).toBe("provider-turn-1");
		expect(messages[1]).toMatchObject({
			query_id: null,
			query_cost: null,
			query_cost_known: null,
			query_estimated_cost: null,
		});
		expect(messages[2].steer_target_seq).toBe(1);
		expect(messages[2].steer_tool_event_index).toBe(1);
		expect(messages[0].context_manifest_json).toBe(contextManifest);
		expect(await getMessageForFork(messages[1].id)).toMatchObject({
			sessionId: "fork",
			seq: 1,
			providerTurnId: "provider-turn-1",
		});
		expect(await getSessionToolEventSummaries("fork")).toMatchObject([
			{
				assistant_seq: 1,
				tool_id: "tool-1",
				name: "Read",
			},
		]);
		expect(await getSessionToolEventDetail("fork", "tool-1")).toEqual({
			tool_id: "tool-1",
			result_text: "contents",
			is_error: 0,
		});
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

	it("traverses three tool-event pages in order without duplicates", async () => {
		await createSession("s1", "L", "m");
		await appendMessage("s1", 0, "assistant", "used tools");
		for (let index = 0; index < 45; index++) {
			const toolId = `tool-${index}`;
			await appendToolEvent("s1", 0, toolId, "Read", { index });
			await setToolEventResult("s1", toolId, `result-${index}`, index === 2);
		}
		await createSession("other", "Other", "m");
		await appendToolEvent("other", 0, "other-tool", "Read", {});

		const latest = await getSessionToolEventPage("s1", 0, undefined, 20);
		expect(latest.items.map((row) => row.tool_id)).toEqual(
			Array.from({ length: 20 }, (_, index) => `tool-${index + 25}`),
		);
		expect(latest).toMatchObject({
			total: 45,
			errorCount: 1,
			hasEarlier: true,
		});
		expect(latest.nextBeforeId).toBe(latest.items[0].id);

		const middle = await getSessionToolEventPage(
			"s1",
			0,
			latest.nextBeforeId ?? undefined,
			20,
		);
		expect(middle.items.map((row) => row.tool_id)).toEqual(
			Array.from({ length: 20 }, (_, index) => `tool-${index + 5}`),
		);
		expect(middle).toMatchObject({
			total: 45,
			errorCount: 1,
			hasEarlier: true,
		});
		expect(middle.nextBeforeId).toBe(middle.items[0].id);

		const earlier = await getSessionToolEventPage(
			"s1",
			0,
			middle.nextBeforeId ?? undefined,
			20,
		);
		expect(earlier.items.map((row) => row.tool_id)).toEqual(
			Array.from({ length: 5 }, (_, index) => `tool-${index}`),
		);
		expect(earlier).toMatchObject({
			total: 45,
			errorCount: 1,
			hasEarlier: false,
			nextBeforeId: null,
		});
		const chronological = [...earlier.items, ...middle.items, ...latest.items];
		expect(chronological.map((row) => row.tool_id)).toEqual(
			Array.from({ length: 45 }, (_, index) => `tool-${index}`),
		);
		expect(new Set(chronological.map((row) => row.id)).size).toBe(45);
	});

	it("selects payloads only for the newest eligible page while keeping guarded responses complete", async () => {
		const database = freshDb();
		await createSession("s1", "L", "m");

		async function appendAssistant(
			seq: number,
			text: string,
			settled = true,
		): Promise<void> {
			await appendMessage("s1", seq, "assistant", text);
			if (!settled) return;
			const query = await recordQuery("s1", baseQuery());
			await setMessageQueryId("s1", seq, query.queryId);
		}

		async function appendEvents(
			seq: number,
			prefix: string,
			count: number,
			options: { specialAt?: number; unresolvedAt?: number } = {},
		): Promise<void> {
			for (let index = 0; index < count; index++) {
				const toolId = `${prefix}-${index}`;
				const marker = `${prefix.toUpperCase()}-INPUT-${index}`;
				await appendToolEvent(
					"s1",
					seq,
					toolId,
					index === options.specialAt
						? "mcp__hlid__capture_project_preview"
						: "Read",
					{ marker, payload: "x".repeat(4_096) },
				);
				if (index !== options.unresolvedAt) {
					await setToolEventResult(
						"s1",
						toolId,
						`${prefix.toUpperCase()}-RESULT-${index}-${"y".repeat(1_024)}`,
						prefix === "eligible" && index === 0,
					);
				}
			}
		}

		await appendAssistant(0, "eligible");
		await appendEvents(0, "eligible", 6);

		await appendAssistant(2, "unfinished", false);
		await appendEvents(2, "unfinished", 4);

		await appendAssistant(4, "unresolved");
		await appendEvents(4, "unresolved", 4, { unresolvedAt: 0 });

		await appendAssistant(6, "special");
		await appendEvents(6, "special", 4, { specialAt: 0 });

		await appendAssistant(8, "steered");
		await appendEvents(8, "steered", 4);
		await appendMessage("s1", 99, "user", "steer", "turn-steer", 8);

		await appendAssistant(10, "subagent");
		await appendEvents(10, "subagent", 4);
		database.run(
			"UPDATE tool_events SET subagent_json = '{}' WHERE session_id = 's1' AND tool_id = 'subagent-0'",
		);

		await appendAssistant(12, "activity");
		await appendEvents(12, "activity", 4);
		database.run(
			"UPDATE tool_events SET activity_json = '{}' WHERE session_id = 's1' AND tool_id = 'activity-0'",
		);

		// Duplicate assistant sequences are compacted only when every owning row is
		// settled, so an active sibling can never lose its historical tool context.
		await appendAssistant(14, "settled duplicate");
		await appendAssistant(14, "active duplicate", false);
		await appendEvents(14, "duplicate", 4);

		await appendAssistant(16, "exactly one page");
		await appendEvents(16, "exact", 2);

		const window = await getSessionToolEventTranscriptWindow("s1", 0, 16, 2);
		const bySeq = new Map<number, (typeof window.items)[number][]>();
		for (const item of window.items) {
			const items = bySeq.get(item.assistant_seq) ?? [];
			items.push(item);
			bySeq.set(item.assistant_seq, items);
		}

		expect(bySeq.get(0)?.map((row) => row.tool_id)).toEqual([
			"eligible-4",
			"eligible-5",
		]);
		for (const seq of [2, 4, 6, 8, 10, 12, 14]) {
			expect(bySeq.get(seq)).toHaveLength(4);
		}
		expect(bySeq.get(16)).toHaveLength(2);
		expect(window.pages).toEqual([
			{
				assistantSeq: 0,
				total: 6,
				errorCount: 1,
				hasEarlier: true,
				nextBeforeId: bySeq.get(0)?.[0]?.id ?? null,
			},
		]);

		const selectedPayload = JSON.stringify(window.items);
		expect(selectedPayload).not.toContain("ELIGIBLE-INPUT-0");
		expect(selectedPayload).not.toContain("ELIGIBLE-RESULT-0");
		expect(selectedPayload).toContain("ELIGIBLE-INPUT-4");
		expect(selectedPayload).toContain("UNFINISHED-INPUT-0");
		expect(
			await getSessionToolEventTranscriptWindow("missing", 0, 16, 2),
		).toEqual({ items: [], pages: [] });
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

	it("stores and updates normalized task activity", async () => {
		await createSession("s1", "L", "m");
		await appendMessage("s1", 0, "assistant", "");
		const started = {
			kind: "tasks" as const,
			source: "codex-plan" as const,
			operation: "snapshot" as const,
			items: [{ subject: "Persist tasks", status: "in_progress" as const }],
		};
		await appendToolEvent(
			"s1",
			0,
			"plan-1",
			"update_plan",
			{},
			undefined,
			undefined,
			started,
		);
		await setToolEventActivity("s1", "plan-1", {
			...started,
			items: [{ subject: "Persist tasks", status: "completed" }],
		});
		const events = await getSessionToolEventSummaries("s1");
		expect(JSON.parse(events[0].activity_json ?? "{}")).toEqual({
			...started,
			items: [{ subject: "Persist tasks", status: "completed" }],
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

	it("stores provider-only denial evidence without claiming a human denial", async () => {
		await createSession("s1", "L", "m");
		expect(
			await recordProviderPermissionDenied({
				sessionId: "s1",
				toolId: "provider-only",
				toolName: "Bash",
				displayName: "Shell command",
				providerId: "claude",
				providerSessionId: "native-1",
				reasonType: "rule",
				reason: "Workspace policy",
				message: "Command blocked",
			}),
		).toBe(true);
		expect((await getSessionPermissionEvents("s1"))[0]).toMatchObject({
			tool_id: "provider-only",
			decision: "provider_blocked",
			human_decision: null,
			provider_outcome: "blocked",
			provider_id: "claude",
			provider_reason_type: "rule",
			provider_reason: "Workspace policy",
			provider_message: "Command blocked",
		});
	});

	it("preserves human approval when a provider block arrives afterward", async () => {
		await createSession("s1", "L", "m");
		await recordPermissionEvent(
			"s1",
			"approved-blocked",
			"Bash",
			"Shell command",
			"approved_session",
		);
		await recordProviderPermissionDenied({
			sessionId: "s1",
			toolId: "approved-blocked",
			toolName: "Bash",
			providerId: "claude",
			providerSessionId: "native-1",
			message: "Provider veto",
		});
		expect((await getSessionPermissionEvents("s1"))[0]).toMatchObject({
			decision: "approved_session",
			human_decision: "approved_session",
			provider_outcome: "blocked",
			provider_message: "Provider veto",
		});
	});

	it("adds a later human decision without erasing provider-first evidence", async () => {
		await createSession("s1", "L", "m");
		await recordProviderPermissionDenied({
			sessionId: "s1",
			toolId: "provider-first",
			toolName: "Read",
			providerId: "claude",
			providerSessionId: "native-1",
			reason: "Managed rule",
		});
		await recordPermissionEvent(
			"s1",
			"provider-first",
			"Read",
			"Read file",
			"denied",
		);
		expect((await getSessionPermissionEvents("s1"))[0]).toMatchObject({
			decision: "denied",
			human_decision: "denied",
			provider_outcome: "blocked",
			provider_reason: "Managed rule",
		});
	});

	it("atomically converges concurrent human and provider upserts", async () => {
		await createSession("s1", "L", "m");
		await Promise.all([
			recordPermissionEvent(
				"s1",
				"concurrent",
				"Bash",
				"Shell command",
				"approved",
			),
			recordProviderPermissionDenied({
				sessionId: "s1",
				toolId: "concurrent",
				toolName: "Bash",
				providerId: "claude",
				providerSessionId: "native-concurrent",
				message: "Provider blocked",
			}),
		]);
		expect(await getSessionPermissionEvents("s1")).toEqual([
			expect.objectContaining({
				decision: "approved",
				human_decision: "approved",
				provider_outcome: "blocked",
				provider_message: "Provider blocked",
			}),
		]);
	});

	it("deduplicates provider replay and quarantines native-session collisions", async () => {
		await createSession("s1", "L", "m");
		const initial = {
			sessionId: "s1",
			toolId: "shared-id",
			toolName: "Bash",
			providerId: "claude",
			providerSessionId: "native-a",
			reason: "First evidence",
		};
		expect(await recordProviderPermissionDenied(initial)).toBe(true);
		expect(await recordProviderPermissionDenied(initial)).toBe(true);
		expect(
			await recordProviderPermissionDenied({
				...initial,
				providerSessionId: "native-b",
				reason: "Wrong session",
			}),
		).toBe(false);
		expect(
			await recordProviderPermissionDenied({
				...initial,
				providerId: "acp:other",
				reason: "Wrong provider",
			}),
		).toBe(false);
		const events = await getSessionPermissionEvents("s1");
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			provider_reason: "First evidence",
		});
	});

	it("migrates legacy duplicate rows into one independent human record", async () => {
		const database = freshDb();
		await createSession("legacy-permissions", "Legacy", "m");
		database.run(`DROP TABLE permission_events`);
		database.run(
			`DELETE FROM settings WHERE key = '_migrated_permission_provider_outcomes_v1'`,
		);
		database.run(`
			CREATE TABLE permission_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL REFERENCES sessions(id),
				tool_id TEXT NOT NULL,
				tool_name TEXT NOT NULL,
				display_name TEXT,
				decision TEXT NOT NULL,
				timestamp INTEGER NOT NULL
			)
		`);
		database.run(
			`INSERT INTO permission_events
			 (session_id, tool_id, tool_name, display_name, decision, timestamp)
			 VALUES ('legacy-permissions', 'legacy-tool', 'Read', NULL, 'approved', 10),
			        ('legacy-permissions', 'legacy-unknown', 'Read', NULL, 'retired_custom', 15),
			        ('legacy-permissions', 'legacy-tool', 'Read', 'Read file', 'denied', 20)`,
		);
		setDbForTest(database);

		const migrated = await getSessionPermissionEvents("legacy-permissions");
		expect(migrated).toHaveLength(2);
		expect(migrated).toContainEqual(
			expect.objectContaining({
				tool_id: "legacy-tool",
				display_name: "Read file",
				decision: "denied",
				human_decision: "denied",
				provider_outcome: null,
				timestamp: 20,
			}),
		);
		expect(migrated).toContainEqual(
			expect.objectContaining({
				tool_id: "legacy-unknown",
				decision: "retired_custom",
				human_decision: null,
				timestamp: 15,
			}),
		);
		expect(
			database
				.query<{ count: number }, []>(
					`SELECT COUNT(*) AS count FROM permission_events`,
				)
				.get()?.count,
		).toBe(2);

		// Normal repeated initialization observes the migration flag and leaves
		// both the rebuilt shape and its consolidated evidence unchanged.
		setDbForTest(database);
		expect(await getSessionPermissionEvents("legacy-permissions")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					tool_id: "legacy-tool",
					decision: "denied",
					human_decision: "denied",
					provider_outcome: null,
				}),
				expect.objectContaining({
					tool_id: "legacy-unknown",
					decision: "retired_custom",
					human_decision: null,
				}),
			]),
		);
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

	it("reads the immutable query ledger instead of a drifted daily aggregate", async () => {
		const db = freshDb();
		await createSession("s1", "L", "m");
		await recordQuery("s1", baseQuery());
		db.run(
			`UPDATE usage_daily SET queries = 99 WHERE date = DATE('now', 'localtime')`,
		);

		const { days, total } = await getThirtyDayStats();
		expect(total).toBe(1);
		expect(days.at(-1)?.count).toBe(1);
	});

	it("days array contains today's date", async () => {
		const db = freshDb();
		const { days } = await getThirtyDayStats();
		const today =
			db
				.query<{ date: string }, []>(`SELECT DATE('now', 'localtime') AS date`)
				.get()?.date ?? "";
		expect(days[days.length - 1].date).toBe(today);
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

	it("promotes an ephemeral attachment to a vault-owned relic", async () => {
		await makeAttachment("capture", { filename: "upload.png" });
		expect(
			await promoteAttachmentToVault("capture", {
				filename: "upload.png",
				path: "/vault/0 Inbox/upload.png",
			}),
		).toBe(true);
		expect(await getAttachment("capture")).toMatchObject({
			kind: "vault",
			filename: "upload.png",
			path: "/vault/0 Inbox/upload.png",
			storage_key: null,
			retention: "linked",
			origin: "vault",
		});
		expect((await listAttachments({ search: "upload" })).total).toBe(1);
	});

	it("does not re-promote a vault attachment", async () => {
		await makeAttachment("capture", { kind: "vault" });
		expect(
			await promoteAttachmentToVault("capture", {
				filename: "moved.txt",
				path: "/vault/moved.txt",
			}),
		).toBe(false);
	});
});

describe("Project Preview feedback", () => {
	beforeEach(() => freshDb());

	it("retains a session PNG and records immutable capture provenance", async () => {
		await createSession("session-1", "Preview", "model");
		await createAttachment({
			id: "feedback-1",
			session_id: "session-1",
			kind: "ephemeral",
			filename: "feedback.png",
			path: "/library/artifacts/feedback-1/feedback.png",
			mime: "image/png",
			size_bytes: 123,
			sha256: "annotated",
			category: "upload",
			retention: "session",
			origin: "upload",
		});

		const retained = await retainProjectPreviewFeedback({
			attachmentId: "feedback-1",
			previewId: "preview-1",
			sessionId: "session-1",
			sourceFrameId: "frame-1",
			path: "/settings",
			viewport: "tablet",
			width: 768,
			height: 1024,
			sourceSha256: "source",
			capturedAt: 1_753_400_000_000,
			comment: "The save button overlaps.",
		});

		expect(retained).toMatchObject({
			category: "report",
			retention: "retained",
			origin: "generated",
		});
		const db = await getDb();
		expect(
			db
				.query<
					{
						preview_id: string;
						path: string;
						viewport: string;
						source_sha256: string;
						comment: string;
					},
					[string]
				>(`SELECT * FROM project_preview_feedback WHERE attachment_id = ?`)
				.get("feedback-1"),
		).toMatchObject({
			preview_id: "preview-1",
			path: "/settings",
			viewport: "tablet",
			source_sha256: "source",
			comment: "The save button overlaps.",
		});
	});

	it("rejects an attachment that is already retained or owned elsewhere", async () => {
		await createSession("session-1", "Preview", "model");
		await createAttachment({
			id: "feedback-1",
			session_id: "session-1",
			kind: "ephemeral",
			filename: "feedback.png",
			path: "/tmp/feedback.png",
			mime: "image/png",
			size_bytes: 123,
			sha256: "annotated",
			category: "report",
			retention: "retained",
			origin: "generated",
		});

		expect(
			await retainProjectPreviewFeedback({
				attachmentId: "feedback-1",
				previewId: "preview-1",
				sessionId: "session-2",
				sourceFrameId: "frame-1",
				path: "/",
				viewport: "desktop",
				width: 1440,
				height: 1000,
				sourceSha256: "source",
				capturedAt: 1,
			}),
		).toBeNull();
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

	it("atomically excludes explicitly protected live session IDs", async () => {
		const oldTs = Math.floor(Date.now() / 1000) - 10 * 86400;
		db.run(
			`INSERT INTO sessions (id, label, model, started_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
			[
				"live-old",
				"Live old",
				"m",
				oldTs,
				"stale-old",
				"Stale old",
				"m",
				oldTs,
			],
		);

		const result = await deleteSessionsOlderThan(5, ["live-old", "live-old"]);

		expect(result.sessionIds).toEqual(["stale-old"]);
		expect(await getSessionById("live-old")).not.toBeNull();
		expect(await getSessionById("stale-old")).toBeNull();
	});

	it("uses last activity and protects pinned sessions", async () => {
		const now = Math.floor(Date.now() / 1000);
		const oldTs = now - 10 * 86_400;
		db.run(
			`INSERT INTO sessions (id, label, model, started_at, ended_at, pinned)
				 VALUES ('recently-used', 'Recent', 'm', ?, ?, 0),
				        ('recent-message', 'Recent message', 'm', ?, ?, 0),
				        ('pinned-old', 'Pinned', 'm', ?, ?, 1),
				        ('stale-old', 'Stale', 'm', ?, ?, 0)`,
			[oldTs, now, oldTs, oldTs, oldTs, oldTs, oldTs, oldTs],
		);
		await appendMessage("recent-message", 0, "user", "new activity");

		const result = await deleteSessionsOlderThan(5);

		expect(result.sessionIds).toEqual(["stale-old"]);
		expect(await getSessionById("recently-used")).not.toBeNull();
		expect(await getSessionById("recent-message")).not.toBeNull();
		expect(await getSessionById("pinned-old")).not.toBeNull();
	});

	it("previews destructive impact while separating preserved usage", async () => {
		const oldTs = Math.floor(Date.now() / 1000) - 10 * 86_400;
		db.run(
			`INSERT INTO sessions (id, label, model, started_at) VALUES (?, ?, ?, ?)`,
			["old-s", "Old", "m", oldTs],
		);
		await appendMessage("old-s", 0, "assistant", "message");
		await appendToolEvent("old-s", 0, "tool", "Read", { path: "/tmp" });
		await setToolEventResult("old-s", "tool", "result", false);
		await recordQuery("old-s", baseQuery());
		await makeAttachment("retained", {
			session_id: "old-s",
			kind: "ephemeral",
			retention: "retained",
			size_bytes: 123,
		});
		await appendPlanProposal("old-s", "plan", 1, "plan", "approved");
		await appendAskUserQuestion("old-s", "ask", 2, "[]");
		db.run(`UPDATE sessions SET ended_at = ? WHERE id = 'old-s'`, [oldTs]);
		for (const table of [
			"messages",
			"tool_events",
			"attachments",
			"plan_proposals",
			"ask_user_questions",
		]) {
			db.run(
				`UPDATE ${table} SET ${table === "attachments" ? "created_at" : "timestamp"} = ? WHERE session_id = 'old-s'`,
				[oldTs],
			);
		}

		const { preview } = await getSessionCleanupPlan(5);

		expect(preview).toMatchObject({
			sessions: 1,
			messages: 1,
			toolEvents: 1,
			usageQueriesPreserved: 1,
			managedAttachments: 1,
			managedAttachmentBytes: 123,
			retainedRelics: 1,
			retainedRelicBytes: 123,
			planProposals: 1,
			askUserQuestions: 1,
		});
		expect(preview.estimatedDatabaseBytes).toBeGreaterThan(0);
	});

	it("atomically refuses a cleanup plan when the exact candidates changed", async () => {
		const oldTs = Math.floor(Date.now() / 1000) - 10 * 86_400;
		db.run(
			`INSERT INTO sessions (id, label, model, started_at)
			 VALUES ('old-a', 'Old A', 'm', ?)`,
			[oldTs],
		);
		const plan = await getSessionCleanupPlan(5);
		db.run(
			`INSERT INTO sessions (id, label, model, started_at)
			 VALUES ('old-b', 'Old B', 'm', ?)`,
			[oldTs],
		);

		await expect(
			deleteSessionsOlderThan(5, [], plan.sessionIds),
		).rejects.toMatchObject({ name: "SessionCleanupPlanChangedError" });
		expect(await getSessionById("old-a")).not.toBeNull();
		expect(await getSessionById("old-b")).not.toBeNull();
	});

	it("includes bounded provider permission evidence in cleanup byte estimates", async () => {
		const oldTs = Math.floor(Date.now() / 1000) - 10 * 86_400;
		db.run(
			`INSERT INTO sessions (id, label, model, started_at, ended_at)
			 VALUES ('permission-old', 'Old', 'm', ?, ?)`,
			[oldTs, oldTs],
		);
		await recordProviderPermissionDenied({
			sessionId: "permission-old",
			toolId: "tool",
			toolName: "Bash",
			displayName: "Shell",
			providerId: "claude",
			providerSessionId: "native",
			reasonType: "rule",
			reason: "policy",
			message: "blocked",
		});
		db.run(
			`UPDATE permission_events SET timestamp = ?
			 WHERE session_id = 'permission-old'`,
			[oldTs],
		);

		const { preview } = await getSessionCleanupPlan(5);
		const expectedPermissionBytes = [
			"tool",
			"Bash",
			"Shell",
			"provider_blocked",
			"blocked",
			"claude",
			"native",
			"rule",
			"policy",
			"blocked",
		].reduce((total, value) => total + value.length, 0);
		expect(preview.estimatedDatabaseBytes).toBe(expectedPermissionBytes);
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
		db.run(`UPDATE attachments SET created_at = ? WHERE id = 'att-old'`, [
			oldTs,
		]);

		const { ephemeralPaths } = await deleteSessionsOlderThan(5);
		expect(ephemeralPaths).toContain("/tmp/old-file.bin");
	});
});

// ── sessions — cascade delete completeness ───────────────────────────────────

describe("sessions — cascade delete completeness", () => {
	let db: Database;
	beforeEach(() => {
		db = freshDb();
	});

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

	it("deleteSession removes linked Hlid-owned retained relics", async () => {
		await createSession("s1", "L", "m");
		await createAttachment({
			id: "att-plan",
			session_id: "s1",
			kind: "ephemeral",
			filename: "plan.html",
			path: "/library/artifacts/att-plan/plan.html",
			mime: "text/html",
			size_bytes: 12,
			sha256: null,
			storage_key: "artifacts/att-plan/plan.html",
			category: "plan",
			retention: "retained",
			origin: "generated",
		});

		const { ephemeralPaths } = await deleteSession("s1");
		expect(ephemeralPaths).toContain("/library/artifacts/att-plan/plan.html");
		expect(await getAttachment("att-plan")).toBeNull();
		expect(
			db
				.query<{ count: number }, []>(
					`SELECT COUNT(*) AS count FROM pending_file_deletions`,
				)
				.get()?.count,
		).toBe(1);
	});

	it("deleteSession removes interactive rows and preserves compact tool history", async () => {
		await createSession("s1", "L", "m");
		await appendMessage("s1", 0, "assistant", "x");
		await appendToolEvent("s1", 0, "tool-error", "Bash", { command: "x" });
		await setToolEventResult("s1", "tool-error", "failure", true);
		await appendPlanProposal("s1", "plan", 1, "plan", "approved");
		await appendAskUserQuestion("s1", "ask", 2, "[]");

		await deleteSession("s1");

		expect(
			db.query(`SELECT * FROM plan_proposals WHERE session_id = 's1'`).all(),
		).toHaveLength(0);
		expect(
			db
				.query(`SELECT * FROM ask_user_questions WHERE session_id = 's1'`)
				.all(),
		).toHaveLength(0);
		expect(
			db
				.query<{ name: string; is_error: number; result_text: string }, []>(
					`SELECT name, is_error, result_text FROM historical_tool_events`,
				)
				.get(),
		).toEqual({ name: "Bash", is_error: 1, result_text: "failure" });
	});

	it("deleteSession removes the stored transcript and deltas for its last owner", async () => {
		db.run(
			`INSERT INTO sessions
			 (id, label, model, started_at, provider_id, provider_session_id,
			  history_imported, history_resume_mode)
			 VALUES ('imported', 'Imported', 'm', 1, 'claude', 'native-id', 1,
			         'session-store')`,
		);
		db.run(
			`INSERT INTO provider_history_transcripts
			 (provider_id, native_session_id, subpath, source_path, source_hash,
			  payload_json, entry_count)
				 VALUES ('claude', 'native-id', '', 'source.jsonl', 'hash', '[]', 0)`,
		);
		db.run(
			`INSERT INTO provider_history_transcript_deltas
			 (provider_id, native_session_id, subpath, uuid, payload_json)
			 VALUES ('claude', 'native-id', '', 'delta-1', '{"type":"user","uuid":"delta-1"}')`,
		);

		await deleteSession("imported");

		expect(
			db
				.query<{ count: number }, []>(
					"SELECT COUNT(*) AS count FROM provider_history_transcripts",
				)
				.get()?.count,
		).toBe(0);
		expect(
			db
				.query<{ count: number }, []>(
					"SELECT COUNT(*) AS count FROM provider_history_transcript_deltas",
				)
				.get()?.count,
		).toBe(0);
	});

	it("retains a native transcript until its final Hlid session is deleted", async () => {
		await createSession("first", "First", "sonnet", { providerId: "claude" });
		await createSession("second", "Second", "sonnet", {
			providerId: "claude",
		});
		await setSessionProviderSession("first", "claude", "shared-native");
		await setSessionProviderSession("second", "claude", "shared-native");
		db.run(
			`INSERT INTO provider_history_transcripts
			 (provider_id, native_session_id, subpath, source_path, source_hash,
			  payload_json, entry_count)
			 VALUES ('claude', 'shared-native', '', 'source.jsonl', 'hash', '[]', 1)`,
		);
		db.run(
			`INSERT INTO provider_history_transcript_deltas
			 (provider_id, native_session_id, subpath, uuid, payload_json)
			 VALUES ('claude', 'shared-native', '', 'delta-1', '{"type":"user","uuid":"delta-1"}')`,
		);

		await deleteSession("first");
		expect(
			db
				.query<{ transcripts: number; deltas: number }, []>(`
					SELECT
					 (SELECT COUNT(*) FROM provider_history_transcripts) AS transcripts,
					 (SELECT COUNT(*) FROM provider_history_transcript_deltas) AS deltas
				`)
				.get(),
		).toEqual({ transcripts: 1, deltas: 1 });

		await deleteSession("second");
		expect(
			db
				.query<{ transcripts: number; deltas: number }, []>(`
					SELECT
					 (SELECT COUNT(*) FROM provider_history_transcripts) AS transcripts,
					 (SELECT COUNT(*) FROM provider_history_transcript_deltas) AS deltas
				`)
				.get(),
		).toEqual({ transcripts: 0, deltas: 0 });
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
		expect(after.allTime.sessions).toBe(before.allTime.sessions);
		expect(after.allTime.input_tokens).toBe(300);
		expect(after.allTime.output_tokens).toBe(100);
		expect(after.allTime.cost).toBeCloseTo(0.05);
	});

	it("preserves the all-time session total even without a usage row", async () => {
		await createSession("zero-query", "No query", "m");
		const before = await getAggregatedStats();

		await deleteSession("zero-query");

		const after = await getAggregatedStats();
		expect(before.allTime.sessions).toBe(1);
		expect(after.allTime.sessions).toBe(1);
		expect(
			db
				.query<{ count: number }, []>(
					"SELECT COUNT(*) AS count FROM historical_sessions WHERE session_id = 'zero-query'",
				)
				.get()?.count,
		).toBe(1);
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

	it("only exposes optional windows after a current provider reading", async () => {
		const resetsAt = Math.floor(Date.now() / 1000) + 3_600;
		registerProvider("optional-provider", "Optional Provider", [
			{ windowId: "standard", label: "STANDARD", windowSecs: 3_600 },
			{
				windowId: "spend_control",
				label: "SPEND",
				windowSecs: 30 * 86_400,
				optional: true,
			},
		]);

		expect(
			(await getProviderUsage("optional-provider")).windows.map(
				(window) => window.windowId,
			),
		).toEqual(["standard"]);

		await saveSetting(
			"rl_optional-provider_spend_control",
			JSON.stringify({ utilization: 0.5, resetsAt }),
		);
		expect(
			(await getProviderUsage("optional-provider")).windows.map(
				(window) => window.windowId,
			),
		).toEqual(["standard", "spend_control"]);
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
		expect(rows[0].provenance_json).toBeNull();
		expect(rows[0].answers_json).toBeNull();
		expect(rows[0].notes_json).toBeNull();
	});

	it("persists and upserts provider interaction provenance", async () => {
		await createSession("s1", "TEST", "claude-sonnet");
		const first = JSON.stringify({
			provider_id: "claude",
			kind: "mcp_elicitation",
			source_name: "github",
			turn_id: "turn-1",
		});
		const updated = JSON.stringify({
			provider_id: "claude",
			kind: "provider_dialog",
			source_name: "refusal_fallback_prompt",
			turn_id: "turn-1",
		});
		await appendAskUserQuestion("s1", "req-1", 0, sampleQuestionsJson, first);
		await appendAskUserQuestion("s1", "req-1", 0, sampleQuestionsJson, updated);

		const rows = await getSessionAskUserQuestions("s1");
		expect(rows[0].provenance_json).toBe(updated);
	});

	it("updates provenance learned after a held provider prompt is released", async () => {
		await createSession("s1", "TEST", "claude-sonnet");
		const preview = JSON.stringify({
			provider_id: "claude",
			kind: "provider_dialog",
			source_name: "peer_inbound_approval",
			peer: { preview: "Check the failing test" },
		});
		const delivered = JSON.stringify({
			provider_id: "claude",
			kind: "provider_dialog",
			source_name: "teammate@project",
			peer: {
				preview: "Check the failing test",
				body: "Check the failing test in session.queueing.test.ts",
			},
		});
		await appendAskUserQuestion(
			"s1",
			"req-peer",
			0,
			sampleQuestionsJson,
			preview,
		);
		await setAskUserQuestionProvenance("s1", "req-peer", delivered);

		const rows = await getSessionAskUserQuestions("s1");
		expect(rows[0].provenance_json).toBe(delivered);
	});

	it("setAskUserQuestionProvenance throws when the row does not exist", async () => {
		await createSession("s1", "TEST", "claude-sonnet");
		await expect(
			setAskUserQuestionProvenance("s1", "missing-id", "{}"),
		).rejects.toThrow(/no row found/);
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

	it("re-arms a replayed request that was resolved before provider delivery", async () => {
		await createSession("s1", "TEST", "claude-sonnet");
		await appendAskUserQuestion("s1", "req-replayed", 3, sampleQuestionsJson);
		await setAskUserQuestionResolution(
			"s1",
			"req-replayed",
			JSON.stringify({ "Pick?": ["A"] }),
			JSON.stringify({ "Pick?": "first attempt" }),
		);
		const replayedQuestions = JSON.stringify([
			{ question: "Deliver now?", options: ["Yes", "No"], multiSelect: false },
		]);
		await appendAskUserQuestion(
			"s1",
			"req-replayed",
			9,
			replayedQuestions,
			JSON.stringify({ provider_id: "claude", kind: "provider_dialog" }),
		);

		const rows = await getSessionAskUserQuestions("s1");
		expect(rows[0]).toMatchObject({
			seq: 9,
			questions_json: replayedQuestions,
			answers_json: null,
			notes_json: null,
		});
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
