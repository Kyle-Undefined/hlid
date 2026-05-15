/**
 * DB layer integration tests.
 * Requires Bun runtime (uses bun:sqlite).
 * Run with: bun test src/db/
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
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
	appendToolEvent,
	getSessionAskUserQuestions,
	getSessionMessages,
	getSessionToolEvents,
	setAskUserQuestionResolution,
	setMessageRecap,
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
	getSessionsPaginated,
	recordQuery,
	setSessionActualModel,
	setSessionAgentCwd,
	setSessionClaudeId,
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
		await appendMessage("s1", 0, "user", "hello");
		await appendMessage("s1", 1, "assistant", "world");
		const rows = await getSessionMessages("s1");
		expect(rows).toHaveLength(2);
		expect(rows[0].role).toBe("user");
		expect(rows[0].text).toBe("hello");
		expect(rows[1].role).toBe("assistant");
	});

	it("returns empty array for session with no messages", async () => {
		await createSession("s1", "L", "m");
		expect(await getSessionMessages("s1")).toHaveLength(0);
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
		const events = await getSessionToolEvents("s1");
		expect(events).toHaveLength(1);
		expect(events[0].name).toBe("Bash");
		expect(events[0].tool_id).toBe("tid-1");
	});

	it("stores input as JSON string", async () => {
		await createSession("s1", "L", "m");
		await appendMessage("s1", 0, "assistant", "x");
		await appendToolEvent("s1", 0, "tid-1", "Read", {
			file_path: "/etc/hosts",
		});
		const events = await getSessionToolEvents("s1");
		expect(events[0].input_json).toBe(
			JSON.stringify({ file_path: "/etc/hosts" }),
		);
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
		expect(today.tokens).toBe(400); // input + output
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
		expect(await getSessionToolEvents("s1")).toHaveLength(0);
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
		expect(snapshot.windows).toHaveLength(3); // five_hour, weekly, weekly_sonnet
		const ids = snapshot.windows.map((w) => w.windowId);
		expect(ids).toContain("five_hour");
		expect(ids).toContain("weekly");
		expect(ids).toContain("weekly_sonnet");
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
