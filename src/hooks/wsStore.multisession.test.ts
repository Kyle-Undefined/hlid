/**
 * wsStore — multi-session state tests (Phase 3 TDD).
 *
 * Covers:
 *  - getSessionsStatus() / subscribeSessionsStatus()
 *  - subscribeToSession() / getSubscribedSessionId()
 *  - Per-session message filtering (session_id gating)
 *  - getAggregateNavStatus()
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isRavenTerminalOpen,
	rememberRavenTerminal,
	resetRavenTerminalsForTesting,
} from "./ravenTerminalStore";
import * as wsDataRevisionStore from "./wsDataRevisionStore";
import * as wsLiveStatsStore from "./wsLiveStatsStore";
import * as wsSessionStatusStore from "./wsSessionStatusStore";
import * as wsTransport from "./wsStore";
import { type MockWs, makeMockWs, WS_STATES } from "./wsStore.test-utils";

const wsStore = {
	...wsTransport,
	...wsSessionStatusStore,
	...wsDataRevisionStore,
	...wsLiveStatsStore,
};

let currentWs: MockWs;

beforeEach(() => {
	resetRavenTerminalsForTesting();
	currentWs = makeMockWs(WS_STATES.OPEN);
	vi.stubGlobal(
		"WebSocket",
		Object.assign(
			// biome-ignore lint/complexity/useArrowFunction: constructor mock for Vitest 4
			vi.fn().mockImplementation(function () {
				return currentWs;
			}),
			WS_STATES,
		),
	);
	wsStore.__resetForTesting();
	// Bring _ws to OPEN by dispatching visibilitychange
	Object.defineProperty(document, "visibilityState", {
		value: "visible",
		writable: true,
		configurable: true,
	});
	document.dispatchEvent(new Event("visibilitychange"));
	currentWs.onopen?.();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** Simulate a server→client message arriving on the WS. */
function receive(msg: Record<string, unknown>): void {
	currentWs.onmessage?.({ data: JSON.stringify(msg) });
}

// ── getSessionsStatus / subscribeSessionsStatus ───────────────────────────────

describe("getSessionsStatus", () => {
	it("returns [] initially", () => {
		expect(wsStore.getSessionsStatus()).toEqual([]);
	});

	it("sessions_status message updates getSessionsStatus()", () => {
		receive({
			type: "sessions_status",
			sessions: [
				{
					session_id: "vault-id",
					agent_cwd: "/vault",
					agent_name: "Vault",
					state: "idle",
					model: "claude-sonnet",
					hasPendingPermissions: false,
				},
			],
		});
		const status = wsStore.getSessionsStatus();
		expect(status).toHaveLength(1);
		expect(status[0].session_id).toBe("vault-id");
		expect(status[0].state).toBe("idle");
	});

	it("sessions_status replaces previous list entirely", () => {
		receive({
			type: "sessions_status",
			sessions: [
				{
					session_id: "s1",
					agent_cwd: "/a",
					agent_name: "A",
					state: "idle",
					model: "m",
					hasPendingPermissions: false,
				},
				{
					session_id: "s2",
					agent_cwd: "/b",
					agent_name: "B",
					state: "running",
					model: "m",
					hasPendingPermissions: false,
				},
			],
		});
		// Second sessions_status with one entry removes the other
		receive({
			type: "sessions_status",
			sessions: [
				{
					session_id: "s1",
					agent_cwd: "/a",
					agent_name: "A",
					state: "idle",
					model: "m",
					hasPendingPermissions: false,
				},
			],
		});
		expect(wsStore.getSessionsStatus()).toHaveLength(1);
		expect(wsStore.getSessionsStatus()[0].session_id).toBe("s1");
	});

	it("subscribeSessionsStatus notified on sessions_status message", () => {
		const fn = vi.fn();
		const unsub = wsStore.subscribeSessionsStatus(fn);
		receive({
			type: "sessions_status",
			sessions: [],
		});
		expect(fn).toHaveBeenCalledOnce();
		unsub();
	});

	it("subscribeSessionsStatus unsubscribe stops notifications", () => {
		const fn = vi.fn();
		const unsub = wsStore.subscribeSessionsStatus(fn);
		unsub();
		receive({ type: "sessions_status", sessions: [] });
		expect(fn).not.toHaveBeenCalled();
	});

	it("session_closed removes the session from the list", () => {
		receive({
			type: "sessions_status",
			sessions: [
				{
					session_id: "s1",
					agent_cwd: "/a",
					agent_name: "A",
					state: "idle",
					model: "m",
					hasPendingPermissions: false,
				},
				{
					session_id: "s2",
					agent_cwd: "/b",
					agent_name: "B",
					state: "idle",
					model: "m",
					hasPendingPermissions: false,
				},
			],
		});
		receive({ type: "session_closed", session_id: "s1" });
		const status = wsStore.getSessionsStatus();
		expect(status).toHaveLength(1);
		expect(status[0].session_id).toBe("s2");
	});

	it("session_closed forgets terminal state stored under the DB session id", () => {
		rememberRavenTerminal("db-session");
		receive({
			type: "sessions_status",
			sessions: [
				{
					session_id: "pool-session",
					db_session_id: "db-session",
					agent_cwd: "/a",
					agent_name: "A",
					state: "idle",
					model: "m",
					hasPendingPermissions: false,
				},
			],
		});

		receive({ type: "session_closed", session_id: "pool-session" });

		expect(isRavenTerminalOpen("db-session")).toBe(false);
	});

	it("session_closed notifies subscribeSessionsStatus subscribers", () => {
		receive({
			type: "sessions_status",
			sessions: [
				{
					session_id: "s1",
					agent_cwd: "/a",
					agent_name: "A",
					state: "idle",
					model: "m",
					hasPendingPermissions: false,
				},
			],
		});
		const fn = vi.fn();
		const unsub = wsStore.subscribeSessionsStatus(fn);
		receive({ type: "session_closed", session_id: "s1" });
		expect(fn).toHaveBeenCalledOnce();
		unsub();
	});
});

describe("server data revisions", () => {
	it("reconciles the authoritative revision snapshot on connect or change", () => {
		const notify = vi.fn();
		wsStore.subscribeDataRevisionSnapshot(notify);

		receive({
			type: "data_revisions",
			revisions: {
				stats: 2,
				sessions: 1,
				relics: 3,
				vault: 0,
				providers: 1,
				config: 0,
				mcp: 0,
				storage: 0,
			},
		});

		expect(wsStore.getDataRevisionSnapshot()).toMatchObject({
			stats: 2,
			sessions: 1,
			relics: 3,
		});
		expect(notify).toHaveBeenCalledOnce();
	});
});

describe("pending interaction status", () => {
	it("does not turn idle-green before a plan interaction resolves", () => {
		receive({
			type: "plan_mode_exit",
			id: "plan-1",
			input: { plan: "Plan" },
		});
		expect(wsStore.getSnapshot().hasPendingPermissions).toBe(true);

		receive({ type: "status", state: "idle", model: "codex" });
		expect(wsStore.getSnapshot().hasPendingPermissions).toBe(true);

		receive({
			type: "plan_mode_exit_resolved",
			id: "plan-1",
			decision: "approved",
		});
		expect(wsStore.getSnapshot().hasPendingPermissions).toBe(false);
	});

	it("clears an unfinished token snapshot when the session stops running", () => {
		receive({
			type: "usage_update",
			input_tokens: 20,
			output_tokens: 5,
			cache_read_tokens: 10,
			cache_creation_tokens: 0,
			query_input_tokens: 20,
			query_output_tokens: 5,
			query_cache_read_tokens: 10,
			query_cache_creation_tokens: 0,
			tokens_in_context: 30,
			context_window: 200_000,
		});
		expect(wsStore.getLiveStats().pending_input_tokens).toBe(20);

		receive({ type: "status", state: "error", model: "codex" });
		expect(wsStore.getLiveStats().pending_input_tokens).toBe(0);
	});
});

// ── subscribeToSession / getSubscribedSessionId ───────────────────────────────

describe("subscribeToSession / getSubscribedSessionId", () => {
	it("getSubscribedSessionId() returns empty string initially", () => {
		expect(wsStore.getSubscribedSessionId()).toBe("");
	});

	it("subscribeToSession updates getSubscribedSessionId()", () => {
		wsStore.subscribeToSession("session-a");
		expect(wsStore.getSubscribedSessionId()).toBe("session-a");
	});

	it("subscribeToSession sends subscribe_session to the WS", () => {
		currentWs.send.mockClear();
		wsStore.subscribeToSession("session-a");
		const sent = currentWs.send.mock.calls.map((c) =>
			JSON.parse(c[0] as string),
		);
		const subscribeMsgs = sent.filter((m) => m.type === "subscribe_session");
		expect(subscribeMsgs).toHaveLength(1);
		expect(subscribeMsgs[0]).toMatchObject({
			type: "subscribe_session",
			session_id: "session-a",
		});
	});

	it("subscribeToSession notifies status subscribers", () => {
		const fn = vi.fn();
		const unsub = wsStore.subscribeStatus(fn);
		wsStore.subscribeToSession("session-a");
		expect(fn).toHaveBeenCalled();
		unsub();
	});

	it("does not resubscribe or notify when the focused session is unchanged", () => {
		const fn = vi.fn();
		const unsub = wsStore.subscribeStatus(fn);
		wsStore.subscribeToSession("session-a");
		currentWs.send.mockClear();
		fn.mockClear();

		wsStore.subscribeToSession("session-a");

		expect(currentWs.send).not.toHaveBeenCalled();
		expect(fn).not.toHaveBeenCalled();
		unsub();
	});

	it("multiple subscribeToSession calls update to the latest session", () => {
		wsStore.subscribeToSession("session-a");
		wsStore.subscribeToSession("session-b");
		expect(wsStore.getSubscribedSessionId()).toBe("session-b");
	});

	it("switches between running chats without replaying output from the old chat", () => {
		receive({
			type: "sessions_status",
			sessions: [
				{
					session_id: "session-a",
					agent_cwd: "/a",
					agent_name: "A",
					state: "running",
					model: "codex",
					hasPendingPermissions: false,
				},
				{
					session_id: "session-b",
					agent_cwd: "/b",
					agent_name: "B",
					state: "running",
					model: "codex",
					hasPendingPermissions: false,
				},
			],
		});
		wsStore.subscribeToSession("session-a");
		wsStore.setBufferingEnabled(true);
		receive({
			type: "chunk",
			text: "A before switch",
			session_id: "session-a",
		});

		const delivered: string[] = [];
		const unsubscribe = wsStore.subscribeMessage((message) => {
			if (message.type === "chunk") delivered.push(message.text);
		});
		wsStore.subscribeToSession("session-b");
		receive({
			type: "chunk",
			text: "A after switch",
			session_id: "session-a",
		});
		receive({
			type: "chunk",
			text: "B after switch",
			session_id: "session-b",
		});

		expect(delivered).toEqual(["B after switch"]);
		expect(wsStore.drainMessageBuffer()).toEqual([
			expect.objectContaining({
				type: "chunk",
				text: "B after switch",
				session_id: "session-b",
			}),
		]);
		unsubscribe();
	});

	it("clears session-scoped controls while the next session status loads", () => {
		wsStore.subscribeToSession("session-a");
		receive({
			type: "status",
			state: "idle",
			model: "gpt-5.4",
			effort: "xhigh",
			permission_mode: "bypassPermissions",
		});

		wsStore.subscribeToSession("session-b");

		expect(wsStore.getSnapshot()).toMatchObject({
			model: "",
			effort: null,
			permissionMode: null,
		});
	});

	it("restores the focused session when a socket reconnects", () => {
		wsStore.subscribeToSession("session-a");
		currentWs.send.mockClear();
		currentWs.onopen?.();

		expect(currentWs.send).toHaveBeenCalledWith(
			JSON.stringify({
				type: "subscribe_session",
				session_id: "session-a",
			}),
		);
	});
});

// ── session-scoped message filtering ─────────────────────────────────────────

describe("session message filtering", () => {
	it("clear immediately detaches from the old running session until session_created", () => {
		wsStore.subscribeToSession("old-session");
		receive({
			type: "status",
			state: "running",
			model: "claude",
			session_id: "old-session",
		});
		expect(wsStore.getSnapshot().sessionState).toBe("running");

		const received: unknown[] = [];
		const unsub = wsStore.subscribeMessage((m) => received.push(m));
		wsStore.send({ type: "clear" });
		expect(wsStore.getSnapshot().sessionState).toBe("idle");

		receive({ type: "chunk", text: "old output", session_id: "old-session" });
		receive({
			type: "status",
			state: "running",
			model: "claude",
			session_id: "old-session",
		});

		expect(received).toHaveLength(0);
		expect(wsStore.getSnapshot().sessionState).toBe("idle");
		unsub();
	});

	it("session_created sets the subscribed session id for subsequent filtering", () => {
		receive({
			type: "session_created",
			session_id: "session-new",
			agent_cwd: "/vault",
			agent_name: "Vault",
		});
		expect(wsStore.getSubscribedSessionId()).toBe("session-new");

		const received: unknown[] = [];
		const unsub = wsStore.subscribeMessage((m) => received.push(m));
		receive({ type: "chunk", text: "old", session_id: "session-old" });
		receive({ type: "chunk", text: "new", session_id: "session-new" });
		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({ type: "chunk", text: "new" });
		unsub();
	});

	it("status with no session_id is NOT filtered (backward compat)", () => {
		wsStore.subscribeToSession("session-a");
		receive({ type: "status", state: "running", model: "claude" });
		expect(wsStore.getSnapshot().sessionState).toBe("running");
	});

	it("status from subscribed session IS processed", () => {
		wsStore.subscribeToSession("session-a");
		receive({
			type: "status",
			state: "running",
			model: "claude",
			session_id: "session-a",
		});
		expect(wsStore.getSnapshot().sessionState).toBe("running");
	});

	it("status from different session is ignored when subscribedSessionId is set", () => {
		wsStore.subscribeToSession("session-a");
		receive({
			type: "status",
			state: "running",
			model: "claude",
			session_id: "session-b",
		});
		// Should remain idle (initial) — the running status from session-b is filtered
		expect(wsStore.getSnapshot().sessionState).toBe("idle");
	});

	it("sessions_status is NEVER filtered regardless of subscribedSessionId", () => {
		wsStore.subscribeToSession("session-a");
		receive({
			type: "sessions_status",
			sessions: [
				{
					session_id: "session-b",
					agent_cwd: "/b",
					agent_name: "B",
					state: "idle",
					model: "m",
					hasPendingPermissions: false,
				},
			],
		});
		// sessions_status should be processed even though session_id doesn't match
		expect(wsStore.getSessionsStatus()).toHaveLength(1);
	});

	it("session_closed is NEVER filtered", () => {
		receive({
			type: "sessions_status",
			sessions: [
				{
					session_id: "s1",
					agent_cwd: "/a",
					agent_name: "A",
					state: "idle",
					model: "m",
					hasPendingPermissions: false,
				},
			],
		});
		wsStore.subscribeToSession("session-a");
		// Closing s1 which is not our subscribed session — still should be removed
		receive({ type: "session_closed", session_id: "s1" });
		expect(wsStore.getSessionsStatus()).toHaveLength(0);
	});

	it("message delivery to messageSubs filtered by session_id", () => {
		wsStore.subscribeToSession("session-a");
		const received: unknown[] = [];
		const unsub = wsStore.subscribeMessage((m) => received.push(m));
		receive({ type: "chunk", text: "hello", session_id: "session-b" });
		expect(received).toHaveLength(0);
		receive({ type: "chunk", text: "hello", session_id: "session-a" });
		expect(received).toHaveLength(1);
		unsub();
	});

	it("no filtering when subscribedSessionId is empty (backward compat)", () => {
		// Do NOT call subscribeToSession — _subscribedSessionId stays ""
		receive({
			type: "status",
			state: "running",
			model: "claude",
			session_id: "any-session",
		});
		expect(wsStore.getSnapshot().sessionState).toBe("running");
	});
});

// ── getAggregateNavStatus ────────────────────────────────────────────────────

describe("getAggregateNavStatus", () => {
	it("returns idle when sessions list is empty", () => {
		const s = wsStore.getAggregateNavStatus();
		expect(s.state).toBe("idle");
		expect(s.sessionCount).toBe(0);
		expect(s.runningCount).toBe(0);
		expect(s.pendingPermissions).toBe(false);
	});

	it("returns idle when all sessions are idle", () => {
		receive({
			type: "sessions_status",
			sessions: [
				{
					session_id: "s1",
					agent_cwd: "/a",
					agent_name: "A",
					state: "idle",
					model: "m",
					hasPendingPermissions: false,
				},
				{
					session_id: "s2",
					agent_cwd: "/b",
					agent_name: "B",
					state: "idle",
					model: "m",
					hasPendingPermissions: false,
				},
			],
		});
		expect(wsStore.getAggregateNavStatus().state).toBe("idle");
		expect(wsStore.getAggregateNavStatus().sessionCount).toBe(2);
	});

	it("returns running when any session is running", () => {
		receive({
			type: "sessions_status",
			sessions: [
				{
					session_id: "s1",
					agent_cwd: "/a",
					agent_name: "A",
					state: "idle",
					model: "m",
					hasPendingPermissions: false,
				},
				{
					session_id: "s2",
					agent_cwd: "/b",
					agent_name: "B",
					state: "running",
					model: "m",
					hasPendingPermissions: false,
				},
			],
		});
		expect(wsStore.getAggregateNavStatus().state).toBe("running");
	});

	it("clears a stale aggregate running state from the scoped idle heartbeat", () => {
		receive({
			type: "sessions_status",
			sessions: [
				{
					session_id: "pool-session",
					db_session_id: "db-session",
					agent_cwd: "/a",
					agent_name: "A",
					state: "running",
					model: "codex",
					hasPendingPermissions: false,
				},
			],
		});
		wsStore.subscribeToSession("db-session");

		receive({
			type: "status",
			session_id: "pool-session",
			state: "idle",
			model: "codex",
		});

		expect(wsStore.getSessionsStatus()[0].state).toBe("idle");
		expect(wsStore.getAggregateNavStatus()).toMatchObject({
			state: "idle",
			sessionCount: 1,
			runningCount: 0,
		});
	});

	it("does not clear a different background session that is still running", () => {
		receive({
			type: "sessions_status",
			sessions: [
				{
					session_id: "focused",
					agent_cwd: "/a",
					agent_name: "A",
					state: "running",
					model: "codex",
					hasPendingPermissions: false,
				},
				{
					session_id: "background",
					agent_cwd: "/b",
					agent_name: "B",
					state: "running",
					model: "claude",
					hasPendingPermissions: false,
				},
			],
		});
		wsStore.subscribeToSession("focused");

		receive({
			type: "status",
			session_id: "focused",
			state: "idle",
			model: "codex",
		});

		expect(wsStore.getAggregateNavStatus()).toMatchObject({
			state: "running",
			runningCount: 1,
		});
		expect(
			wsStore
				.getSessionsStatus()
				.find((session) => session.session_id === "background")?.state,
		).toBe("running");
	});

	it("returns error when any session has error but none running", () => {
		receive({
			type: "sessions_status",
			sessions: [
				{
					session_id: "s1",
					agent_cwd: "/a",
					agent_name: "A",
					state: "error",
					model: "m",
					hasPendingPermissions: false,
				},
				{
					session_id: "s2",
					agent_cwd: "/b",
					agent_name: "B",
					state: "idle",
					model: "m",
					hasPendingPermissions: false,
				},
			],
		});
		expect(wsStore.getAggregateNavStatus().state).toBe("error");
	});

	it("running takes precedence over error", () => {
		receive({
			type: "sessions_status",
			sessions: [
				{
					session_id: "s1",
					state: "error",
					agent_cwd: "/a",
					agent_name: "A",
					model: "m",
					hasPendingPermissions: false,
				},
				{
					session_id: "s2",
					state: "running",
					agent_cwd: "/b",
					agent_name: "B",
					model: "m",
					hasPendingPermissions: false,
				},
			],
		});
		expect(wsStore.getAggregateNavStatus().state).toBe("running");
	});

	it("runningCount reflects number of running sessions", () => {
		receive({
			type: "sessions_status",
			sessions: [
				{
					session_id: "s1",
					state: "running",
					agent_cwd: "/a",
					agent_name: "A",
					model: "m",
					hasPendingPermissions: false,
				},
				{
					session_id: "s2",
					state: "running",
					agent_cwd: "/b",
					agent_name: "B",
					model: "m",
					hasPendingPermissions: false,
				},
				{
					session_id: "s3",
					state: "idle",
					agent_cwd: "/c",
					agent_name: "C",
					model: "m",
					hasPendingPermissions: false,
				},
			],
		});
		expect(wsStore.getAggregateNavStatus().runningCount).toBe(2);
	});

	it("pendingPermissions true when any session has hasPendingPermissions", () => {
		receive({
			type: "sessions_status",
			sessions: [
				{
					session_id: "s1",
					state: "idle",
					agent_cwd: "/a",
					agent_name: "A",
					model: "m",
					hasPendingPermissions: false,
				},
				{
					session_id: "s2",
					state: "running",
					agent_cwd: "/b",
					agent_name: "B",
					model: "m",
					hasPendingPermissions: true,
				},
			],
		});
		expect(wsStore.getAggregateNavStatus().pendingPermissions).toBe(true);
	});

	it("pendingPermissions false when no session has pending permissions", () => {
		receive({
			type: "sessions_status",
			sessions: [
				{
					session_id: "s1",
					state: "running",
					agent_cwd: "/a",
					agent_name: "A",
					model: "m",
					hasPendingPermissions: false,
				},
			],
		});
		expect(wsStore.getAggregateNavStatus().pendingPermissions).toBe(false);
	});
});
