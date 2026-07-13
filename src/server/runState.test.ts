/**
 * runState unit tests — buffer management, broadcast semantics, send helper.
 * DB is mocked to prevent bun:sqlite from loading in Node.js vitest.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../db", () => ({
	saveSetting: vi.fn().mockResolvedValue(undefined),
}));

// ── import after mocks ────────────────────────────────────────────────────────

import { broadcast, getRunBuffer, send, wsState } from "./runState";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Minimal fake WebSocket with a send spy. */
function makeWs() {
	return { send: vi.fn() };
}

/** Reset module-level mutable state before each test. */
function resetState() {
	wsState.clients.clear();
	wsState.lastSessionError = null;
	// Flush _runBuffer by broadcasting a status/running message
	broadcast({ type: "status", state: "running", model: "__reset__" });
}

beforeEach(() => {
	resetState();
	vi.clearAllMocks();
});

// ── getRunBuffer initial state ────────────────────────────────────────────────

describe("getRunBuffer", () => {
	it("returns empty buffer initially (after reset)", () => {
		expect(getRunBuffer()).toHaveLength(0);
	});

	it("returns readonly array", () => {
		const buf = getRunBuffer();
		expect(Array.isArray(buf)).toBe(true);
	});
});

// ── broadcast — buffered message types ───────────────────────────────────────

describe("broadcast — buffer accumulation", () => {
	it("appends chunk to buffer", () => {
		broadcast({ type: "chunk", text: "hello" });
		expect(getRunBuffer()).toHaveLength(1);
		expect(getRunBuffer()[0]).toMatchObject({ type: "chunk", text: "hello" });
	});

	it("appends tool_event to buffer", () => {
		broadcast({ type: "tool_event", id: "t1", name: "Bash", input: {} });
		expect(getRunBuffer()).toHaveLength(1);
		expect(getRunBuffer()[0]).toMatchObject({
			type: "tool_event",
			name: "Bash",
		});
	});

	it("appends permission_request to buffer", () => {
		broadcast({
			type: "permission_request",
			id: "p1",
			toolName: "Bash",
			title: "Run?",
		});
		expect(getRunBuffer()).toHaveLength(1);
	});

	it("appends permission_resolved to buffer", () => {
		broadcast({
			type: "permission_resolved",
			id: "p1",
			toolName: "Bash",
			decision: "approved",
		});
		expect(getRunBuffer()).toHaveLength(1);
	});

	it("accumulates multiple buffered messages", () => {
		broadcast({ type: "chunk", text: "a" });
		broadcast({ type: "chunk", text: "b" });
		broadcast({ type: "chunk", text: "c" });
		expect(getRunBuffer()).toHaveLength(3);
	});
});

// ── broadcast — non-buffered message types ────────────────────────────────────

describe("broadcast — non-buffered types do not enter buffer", () => {
	it("status message not buffered", () => {
		broadcast({ type: "status", state: "idle", model: "m" });
		expect(getRunBuffer()).toHaveLength(0);
	});

	it("done message not buffered", () => {
		broadcast({ type: "chunk", text: "x" }); // pre-populate
		broadcast({
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
		});
		expect(getRunBuffer()).toHaveLength(0);
	});

	it("error message not buffered", () => {
		broadcast({ type: "chunk", text: "x" }); // pre-populate
		broadcast({ type: "error", message: "boom" });
		expect(getRunBuffer()).toHaveLength(0);
	});
});

// ── broadcast — buffer cleared by control messages ───────────────────────────

describe("broadcast — buffer flush", () => {
	it("status/running clears buffer", () => {
		broadcast({ type: "chunk", text: "a" });
		broadcast({ type: "chunk", text: "b" });
		expect(getRunBuffer()).toHaveLength(2);
		broadcast({ type: "status", state: "running", model: "m" });
		expect(getRunBuffer()).toHaveLength(0);
	});

	it("done clears buffer", () => {
		broadcast({ type: "chunk", text: "a" });
		broadcast({
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
		});
		expect(getRunBuffer()).toHaveLength(0);
	});

	it("error clears buffer", () => {
		broadcast({ type: "chunk", text: "a" });
		broadcast({ type: "error", message: "oops" });
		expect(getRunBuffer()).toHaveLength(0);
	});
});

// ── broadcast — lastSessionError side-effects ─────────────────────────────────

describe("broadcast — lastSessionError", () => {
	it("error message sets lastSessionError", () => {
		broadcast({ type: "error", message: "something broke" });
		expect(wsState.lastSessionError).toBe("something broke");
	});

	it("status/running clears lastSessionError", () => {
		wsState.lastSessionError = "prior error";
		broadcast({ type: "status", state: "running", model: "m" });
		expect(wsState.lastSessionError).toBeNull();
	});

	it("status/idle does NOT clear lastSessionError", () => {
		wsState.lastSessionError = "prior error";
		broadcast({ type: "status", state: "idle", model: "m" });
		expect(wsState.lastSessionError).toBe("prior error");
	});
});

// ── broadcast — buffer cap ─────────────────────────────────────────────────────

describe("broadcast — buffer cap at 500", () => {
	it("caps buffer at 500 entries, drops oldest on overflow", () => {
		// Push 501 chunks
		for (let i = 0; i < 501; i++) {
			broadcast({ type: "chunk", text: `msg-${i}` });
		}
		expect(getRunBuffer()).toHaveLength(500);
		// Oldest (msg-0) should be gone; most recent (msg-500) should be present
		const texts = getRunBuffer().map((m) => (m as { text: string }).text);
		expect(texts[0]).toBe("msg-1"); // msg-0 was evicted
		expect(texts[499]).toBe("msg-500");
	});
});

// ── broadcast — sends to all clients ─────────────────────────────────────────

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
		const dead = {
			send: vi.fn().mockImplementation(() => {
				throw new Error("closed");
			}),
		};
		const alive = makeWs();
		wsState.clients.add(dead as never);
		wsState.clients.add(alive as never);

		// Should not throw
		expect(() => broadcast({ type: "chunk", text: "x" })).not.toThrow();
		expect(alive.send).toHaveBeenCalledOnce();
	});

	it("sends nothing when clients set is empty", () => {
		// No assertion needed — just verify no throw and buffer still works
		expect(() => broadcast({ type: "chunk", text: "quiet" })).not.toThrow();
		expect(getRunBuffer()).toHaveLength(1);
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
		const dead = {
			send: vi.fn().mockImplementation(() => {
				throw new Error("gone");
			}),
		};
		expect(() =>
			send(dead as never, { type: "chunk", text: "x" }),
		).not.toThrow();
	});
});

// ── SessionRunState ───────────────────────────────────────────────────────────

import { SessionRunState } from "./runState";

describe("SessionRunState — subscriber management", () => {
	it("addSubscriber puts ws in subscriber set", () => {
		const rs = new SessionRunState("session-1");
		const ws = makeWs();
		rs.addSubscriber(ws as never);
		expect(rs.getSubscriberCount()).toBe(1);
	});

	it("removeSubscriber removes ws from subscriber set", () => {
		const rs = new SessionRunState("session-1");
		const ws = makeWs();
		rs.addSubscriber(ws as never);
		rs.removeSubscriber(ws as never);
		expect(rs.getSubscriberCount()).toBe(0);
	});

	it("removeSubscriber is a no-op for non-subscriber ws", () => {
		const rs = new SessionRunState("session-1");
		const ws = makeWs();
		expect(() => rs.removeSubscriber(ws as never)).not.toThrow();
	});

	it("multiple subscribers tracked independently", () => {
		const rs = new SessionRunState("session-1");
		const ws1 = makeWs();
		const ws2 = makeWs();
		rs.addSubscriber(ws1 as never);
		rs.addSubscriber(ws2 as never);
		expect(rs.getSubscriberCount()).toBe(2);
		rs.removeSubscriber(ws1 as never);
		expect(rs.getSubscriberCount()).toBe(1);
	});
});

describe("SessionRunState — broadcast", () => {
	it("sends to all subscribers", () => {
		const rs = new SessionRunState("session-1");
		const ws1 = makeWs();
		const ws2 = makeWs();
		rs.addSubscriber(ws1 as never);
		rs.addSubscriber(ws2 as never);

		rs.broadcast({ type: "chunk", text: "hello" });

		expect(ws1.send).toHaveBeenCalledOnce();
		expect(ws2.send).toHaveBeenCalledOnce();
	});

	it("message payload includes session_id", () => {
		const rs = new SessionRunState("my-session-id");
		const ws = makeWs();
		rs.addSubscriber(ws as never);

		rs.broadcast({ type: "chunk", text: "hello" });

		const payload = JSON.parse(ws.send.mock.calls[0][0] as string);
		expect(payload.session_id).toBe("my-session-id");
	});

	it("does not throw for dead subscriber (send throws)", () => {
		const rs = new SessionRunState("session-1");
		const dead = {
			send: vi.fn().mockImplementation(() => {
				throw new Error("closed");
			}),
		};
		rs.addSubscriber(dead as never);
		expect(() => rs.broadcast({ type: "chunk", text: "x" })).not.toThrow();
	});

	it("sends nothing when no subscribers", () => {
		const rs = new SessionRunState("session-1");
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
		const dead = {
			send: vi.fn().mockImplementation(() => {
				throw new Error("gone");
			}),
		};
		expect(() =>
			rs.send(dead as never, { type: "chunk", text: "x" }),
		).not.toThrow();
	});
});

describe("SessionRunState — replay buffer", () => {
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

	it("chunk is added to buffer", () => {
		const rs = new SessionRunState("session-1");
		rs.broadcast({ type: "chunk", text: "hello" });
		expect(rs.getReplayBuffer()).toHaveLength(1);
	});

	it("tool_event is added to buffer", () => {
		const rs = new SessionRunState("session-1");
		rs.broadcast({ type: "tool_event", id: "t1", name: "Bash", input: {} });
		expect(rs.getReplayBuffer()).toHaveLength(1);
	});

	it("permission_request is added to buffer", () => {
		const rs = new SessionRunState("session-1");
		rs.broadcast({
			type: "permission_request",
			id: "p1",
			toolName: "Bash",
			title: "Run?",
		});
		expect(rs.getReplayBuffer()).toHaveLength(1);
	});

	it("status/running clears buffer", () => {
		const rs = new SessionRunState("session-1");
		rs.broadcast({ type: "chunk", text: "a" });
		rs.broadcast({ type: "status", state: "running", model: "m" });
		expect(rs.getReplayBuffer()).toHaveLength(0);
	});

	it("done clears buffer", () => {
		const rs = new SessionRunState("session-1");
		rs.broadcast({ type: "chunk", text: "a" });
		rs.broadcast({
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
		});
		expect(rs.getReplayBuffer()).toHaveLength(0);
	});

	it("error clears buffer", () => {
		const rs = new SessionRunState("session-1");
		rs.broadcast({ type: "chunk", text: "a" });
		rs.broadcast({ type: "error", message: "boom" });
		expect(rs.getReplayBuffer()).toHaveLength(0);
	});

	it("caps buffer at 500, drops oldest on overflow", () => {
		const rs = new SessionRunState("session-1");
		for (let i = 0; i < 501; i++) {
			rs.broadcast({ type: "chunk", text: `msg-${i}` });
		}
		expect(rs.getReplayBuffer()).toHaveLength(500);
		const texts = rs.getReplayBuffer().map((m) => {
			const parsed = JSON.parse(JSON.stringify(m)) as { text?: string };
			return parsed.text;
		});
		expect(texts[0]).toBe("msg-1");
		expect(texts[499]).toBe("msg-500");
	});
});

describe("SessionRunState — error state", () => {
	it("lastError is null initially", () => {
		const rs = new SessionRunState("session-1");
		expect(rs.lastError).toBeNull();
	});

	it("error broadcast sets lastError", () => {
		const rs = new SessionRunState("session-1");
		rs.broadcast({ type: "error", message: "something broke" });
		expect(rs.lastError).toBe("something broke");
	});

	it("status/running clears lastError", () => {
		const rs = new SessionRunState("session-1");
		rs.broadcast({ type: "error", message: "old error" });
		rs.broadcast({ type: "status", state: "running", model: "m" });
		expect(rs.lastError).toBeNull();
	});

	it("clearError resets lastError to null", () => {
		const rs = new SessionRunState("session-1");
		rs.broadcast({ type: "error", message: "oops" });
		rs.clearError();
		expect(rs.lastError).toBeNull();
	});
});

describe("SessionRunState — owner tracking", () => {
	it("ownerWs is null initially", () => {
		const rs = new SessionRunState("session-1");
		expect(rs.ownerWs).toBeNull();
	});

	it("ownerWs can be set and read", () => {
		const rs = new SessionRunState("session-1");
		const ws = makeWs();
		rs.ownerWs = ws as never;
		expect(rs.ownerWs).toBe(ws);
	});

	it("inFlightChatCount is empty initially", () => {
		const rs = new SessionRunState("session-1");
		expect(rs.inFlightChatCount.size).toBe(0);
	});
});
