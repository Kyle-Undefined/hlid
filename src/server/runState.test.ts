/**
 * runState unit tests.
 *
 * Replay-buffer + error-state semantics are tested against the
 * applyReplayTransition helper and SessionRunState. The global broadcast suite
 * covers client delivery only.
 * DB is mocked to prevent bun:sqlite from loading in Node.js vitest.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../db", () => ({
	saveSetting: vi.fn().mockResolvedValue(undefined),
}));

// ── import after mocks ────────────────────────────────────────────────────────

import type { ServerMessage } from "./protocol";
import {
	applyReplayTransition,
	broadcast,
	REPLAY_BUFFER_MAX,
	type ReplayState,
	SessionRunState,
	send,
	subscribeSessionsStatusBroadcast,
	wsState,
} from "./runState";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Minimal fake WebSocket with a send spy. */
function makeWs() {
	return { send: vi.fn() };
}

/** Fake WebSocket whose send always throws (dead socket). */
function makeDeadWs() {
	return {
		send: vi.fn().mockImplementation(() => {
			throw new Error("closed");
		}),
	};
}

function makeState(): ReplayState {
	return { buffer: [], lastError: null };
}

const DONE_MSG: ServerMessage = {
	type: "done",
	cost: null,
	turns: 1,
	duration_ms: 0,
	input_tokens: 0,
	output_tokens: 0,
	cache_read_tokens: 0,
	cache_creation_tokens: 0,
	context_window: null,
	max_output_tokens: null,
	stop_reason: null,
	tokens_in_context: null,
};

/** Reset global client state before each test. */
function resetState() {
	wsState.clients.clear();
}

beforeEach(() => {
	resetState();
	vi.clearAllMocks();
});

// ── applyReplayTransition — shared buffer/error semantics ────────────────────

describe("applyReplayTransition", () => {
	it("retains tool activity in order so a reconnect can rebuild a Live card", () => {
		const state: ReplayState = { buffer: [], lastError: null };
		const start = {
			type: "tool_event" as const,
			id: "live-tool-1",
			name: "exec_command",
			input: { cmd: "git status --short" },
			realtime_utterance_id: "codex-realtime-1",
		};
		const result = {
			type: "tool_result" as const,
			id: "live-tool-1",
			content: "clean",
		};

		applyReplayTransition(state, start);
		applyReplayTransition(state, result);

		expect(state.buffer).toEqual([start, result]);
	});

	it("coalesces repeated tool progress snapshots for reconnect replay", () => {
		const state = makeState();
		applyReplayTransition(state, {
			type: "tool_progress_update",
			id: "tool-1",
			progress: { status: "in_progress", content: "step 1" },
		});
		applyReplayTransition(state, {
			type: "tool_progress_update",
			id: "tool-1",
			progress: { status: "in_progress", content: "step 2" },
		});
		expect(state.buffer).toEqual([
			{
				type: "tool_progress_update",
				id: "tool-1",
				progress: { status: "in_progress", content: "step 2" },
			},
		]);
	});

	it("retains canonical assistant revisions in replay order", () => {
		const state = makeState();
		const revision: ServerMessage = {
			type: "assistant_revision",
			session_id: "session-1",
			transcript_seq: 3,
			current: true,
			text: "canonical",
			removed_tool_ids: ["removed-tool"],
			cleared_tool_result_ids: ["cleared-result"],
			remaining_tool_count: 1,
			remaining_tool_error_count: 0,
			steer_tool_event_indexes: [],
		};
		applyReplayTransition(state, { type: "chunk", text: "superseded" });
		applyReplayTransition(state, revision);
		expect(state.buffer).toEqual([
			{ type: "chunk", text: "superseded" },
			revision,
		]);
	});

	it("accumulates transcript and human/provider permission evidence", () => {
		const state = makeState();
		applyReplayTransition(state, { type: "chunk", text: "hello" });
		applyReplayTransition(state, {
			type: "tool_event",
			id: "t1",
			name: "Bash",
			input: {},
		});
		applyReplayTransition(state, {
			type: "permission_request",
			id: "p1",
			toolName: "Bash",
			title: "Run?",
		});
		applyReplayTransition(state, {
			type: "permission_resolved",
			id: "p1",
			toolName: "Bash",
			decision: "approved",
		});
		applyReplayTransition(state, {
			type: "provider_permission_denied",
			id: "p1",
			toolName: "Bash",
			providerId: "claude",
		});
		expect(state.buffer.map((m) => m.type)).toEqual([
			"chunk",
			"tool_event",
			"permission_request",
			"permission_resolved",
			"provider_permission_denied",
		]);
	});

	it("does not buffer other message types", () => {
		const state = makeState();
		applyReplayTransition(state, { type: "status", state: "idle", model: "m" });
		expect(state.buffer).toHaveLength(0);
	});

	it("status/running clears buffer and error", () => {
		const state = makeState();
		applyReplayTransition(state, { type: "chunk", text: "a" });
		state.lastError = "prior error";
		applyReplayTransition(state, {
			type: "status",
			state: "running",
			model: "m",
		});
		expect(state.buffer).toHaveLength(0);
		expect(state.lastError).toBeNull();
	});

	it("status/idle does NOT clear the error", () => {
		const state = makeState();
		state.lastError = "prior error";
		applyReplayTransition(state, { type: "status", state: "idle", model: "m" });
		expect(state.lastError).toBe("prior error");
	});

	it("done clears buffer but keeps the error", () => {
		const state = makeState();
		applyReplayTransition(state, { type: "chunk", text: "a" });
		state.lastError = "prior error";
		applyReplayTransition(state, DONE_MSG);
		expect(state.buffer).toHaveLength(0);
		expect(state.lastError).toBe("prior error");
	});

	it("error records the message and clears the buffer", () => {
		const state = makeState();
		applyReplayTransition(state, { type: "chunk", text: "a" });
		applyReplayTransition(state, { type: "error", message: "boom" });
		expect(state.buffer).toHaveLength(0);
		expect(state.lastError).toBe("boom");
	});

	it("caps buffer at REPLAY_BUFFER_MAX, drops oldest on overflow", () => {
		const state = makeState();
		for (let i = 0; i <= REPLAY_BUFFER_MAX; i++) {
			applyReplayTransition(state, { type: "chunk", text: `msg-${i}` });
		}
		expect(state.buffer).toHaveLength(REPLAY_BUFFER_MAX);
		const texts = state.buffer.map((m) => (m as { text: string }).text);
		expect(texts[0]).toBe("msg-1"); // msg-0 was evicted
		expect(texts[REPLAY_BUFFER_MAX - 1]).toBe(`msg-${REPLAY_BUFFER_MAX}`);
	});
});

// ── global broadcast delivery ────────────────────────────────────────────────

describe("broadcast — client delivery", () => {
	it("sends serialized message to all connected clients", () => {
		const ws1 = makeWs();
		const ws2 = makeWs();
		wsState.clients.add(ws1 as never);
		wsState.clients.add(ws2 as never);

		broadcast({ type: "chunk", text: "hi" });

		expect(ws1.send).toHaveBeenCalledOnce();
		expect(ws2.send).toHaveBeenCalledOnce();
		const payload = JSON.parse(ws1.send.mock.calls[0][0] as string);
		expect(payload).toMatchObject({ type: "chunk", text: "hi" });
	});

	it("skips dead sockets (send throws)", () => {
		const dead = makeDeadWs();
		const alive = makeWs();
		wsState.clients.add(dead as never);
		wsState.clients.add(alive as never);

		expect(() => broadcast({ type: "chunk", text: "x" })).not.toThrow();
		expect(alive.send).toHaveBeenCalledOnce();
	});

	it("does not throw when clients set is empty", () => {
		expect(() => broadcast({ type: "chunk", text: "quiet" })).not.toThrow();
	});

	it("observes only authoritative sessions status broadcasts", () => {
		const observer = vi.fn();
		const unsubscribe = subscribeSessionsStatusBroadcast(observer);
		broadcast({ type: "chunk", text: "quiet" });
		expect(observer).not.toHaveBeenCalled();
		broadcast({ type: "sessions_status", sessions: [] });
		expect(observer).toHaveBeenCalledOnce();
		expect(observer).toHaveBeenCalledWith([]);
		unsubscribe();
		broadcast({ type: "sessions_status", sessions: [] });
		expect(observer).toHaveBeenCalledOnce();
	});
});

// ── send ──────────────────────────────────────────────────────────────────────

describe("send", () => {
	it("sends serialized message to single ws", () => {
		const ws = makeWs();
		send(ws as never, { type: "status", state: "idle", model: "m" });
		expect(ws.send).toHaveBeenCalledOnce();
		const payload = JSON.parse(ws.send.mock.calls[0][0] as string);
		expect(payload).toMatchObject({ type: "status", state: "idle" });
	});

	it("does not throw when ws.send throws (dead socket)", () => {
		const dead = makeDeadWs();
		expect(() =>
			send(dead as never, { type: "chunk", text: "x" }),
		).not.toThrow();
	});
});

// ── SessionRunState ───────────────────────────────────────────────────────────

describe("SessionRunState — subscriber management", () => {
	it("add/remove tracks subscribers independently; remove of non-subscriber is a no-op", () => {
		const rs = new SessionRunState("session-1");
		const ws1 = makeWs();
		const ws2 = makeWs();
		expect(() => rs.removeSubscriber(ws1 as never)).not.toThrow();
		rs.addSubscriber(ws1 as never);
		rs.addSubscriber(ws2 as never);
		expect(rs.getSubscriberCount()).toBe(2);
		rs.removeSubscriber(ws1 as never);
		expect(rs.getSubscriberCount()).toBe(1);
	});

	it("removeSubscriber clears ownership and in-flight count for that ws", () => {
		const rs = new SessionRunState("session-1");
		const ws = makeWs();
		rs.addSubscriber(ws as never);
		rs.ownerWs = ws as never;
		rs.inFlightChatCount.set(ws as never, 2);
		rs.removeSubscriber(ws as never);
		expect(rs.ownerWs).toBeNull();
		expect(rs.inFlightChatCount.size).toBe(0);
	});
});

describe("SessionRunState — broadcast", () => {
	it("sends to all subscribers with session_id tag", () => {
		const rs = new SessionRunState("my-session-id");
		const ws1 = makeWs();
		const ws2 = makeWs();
		rs.addSubscriber(ws1 as never);
		rs.addSubscriber(ws2 as never);

		rs.broadcast({ type: "chunk", text: "hello" });

		expect(ws1.send).toHaveBeenCalledOnce();
		expect(ws2.send).toHaveBeenCalledOnce();
		const payload = JSON.parse(ws1.send.mock.calls[0][0] as string);
		expect(payload).toMatchObject({
			type: "chunk",
			text: "hello",
			session_id: "my-session-id",
		});
	});

	it("does not throw for dead subscriber or empty subscriber set", () => {
		const rs = new SessionRunState("session-1");
		expect(() => rs.broadcast({ type: "chunk", text: "x" })).not.toThrow();
		rs.addSubscriber(makeDeadWs() as never);
		expect(() => rs.broadcast({ type: "chunk", text: "x" })).not.toThrow();
	});
});

describe("SessionRunState — send (unicast)", () => {
	it("sends to specified ws only", () => {
		const rs = new SessionRunState("session-1");
		const ws1 = makeWs();
		const ws2 = makeWs();
		rs.addSubscriber(ws1 as never);
		rs.addSubscriber(ws2 as never);

		rs.send(ws1 as never, { type: "status", state: "idle", model: "m" });

		expect(ws1.send).toHaveBeenCalledOnce();
		expect(ws2.send).not.toHaveBeenCalled();
	});

	it("does not throw for dead ws", () => {
		const rs = new SessionRunState("session-1");
		expect(() =>
			rs.send(makeDeadWs() as never, { type: "chunk", text: "x" }),
		).not.toThrow();
	});
});

describe("SessionRunState — replay transition wiring", () => {
	it("runs messages through the shared transition (buffer + lastError)", () => {
		const rs = new SessionRunState("session-1");
		expect(rs.lastError).toBeNull();

		rs.broadcast({ type: "chunk", text: "a" });
		expect(rs.getReplayBuffer()).toHaveLength(1);

		rs.broadcast({ type: "error", message: "boom" });
		expect(rs.getReplayBuffer()).toHaveLength(0);
		expect(rs.lastError).toBe("boom");

		rs.clearError();
		expect(rs.lastError).toBeNull();
	});

	it("keeps the latest context snapshot outside the transcript replay buffer", () => {
		const rs = new SessionRunState("session-1");
		rs.broadcast({
			type: "context_update",
			tokens_in_context: 110_882,
			context_window: 1_000_000,
			actualModel: "claude-fable-5",
		});

		expect(rs.getReplayBuffer()).toHaveLength(0);
		expect(rs.getContextSnapshot()).toEqual({
			type: "context_update",
			tokens_in_context: 110_882,
			context_window: 1_000_000,
			actualModel: "claude-fable-5",
		});
	});
});
