/**
 * TerminalSessionPool unit tests — TDD.
 *
 * Verifies: session creation, reattach on reconnect, buffer replay,
 * idle timeout / cancel, write/resize routing, closeAll, getSessionsStatus.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── mock PtyBridge ────────────────────────────────────────────────────────────

const mockBridgeInstance = {
	write: vi.fn(),
	resize: vi.fn(),
	kill: vi.fn(),
	onData: vi.fn(),
	onExit: vi.fn(),
};

vi.mock("./ptyBridge", () => ({
	PtyBridge: {
		spawn: vi.fn(() => mockBridgeInstance),
	},
}));

vi.mock("../lib/claudePath", () => ({
	resolveClaudeExecutable: vi.fn(() => "/usr/bin/claude"),
}));

import { PtyBridge } from "./ptyBridge";
import { TerminalSessionPool } from "./terminalSessionPool";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Minimal mock of a Bun ServerWebSocket. */
function makeWs(id = "ws-1") {
	return {
		_id: id,
		send: vi.fn(),
		sendBinary: vi.fn(),
		close: vi.fn(),
		data: {} as Record<string, unknown>,
	};
}

function makeSubOpts(
	overrides: Partial<{
		sessionId: string;
		cwd: string;
		claudeSessionId: string | null;
		cols: number;
		rows: number;
	}> = {},
) {
	return {
		sessionId: "sess-1",
		cwd: "/tmp/test",
		claudeSessionId: null,
		cols: 80,
		rows: 24,
		...overrides,
	};
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("TerminalSessionPool — subscribe", () => {
	let pool: TerminalSessionPool;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		mockBridgeInstance.onData.mockImplementation(() => {});
		mockBridgeInstance.onExit.mockImplementation(() => {});
		pool = new TerminalSessionPool();
	});

	afterEach(() => {
		vi.useRealTimers();
		pool.closeAll();
	});

	it("spawns a PtyBridge on first subscribe", () => {
		const ws = makeWs();
		pool.subscribe(ws as never, makeSubOpts());
		expect(PtyBridge.spawn).toHaveBeenCalledOnce();
	});

	it("does NOT spawn a second PtyBridge on re-subscribe to same session", () => {
		const ws1 = makeWs("ws-1");
		const ws2 = makeWs("ws-2");
		pool.subscribe(ws1 as never, makeSubOpts());
		pool.unsubscribe(ws1 as never);
		pool.subscribe(ws2 as never, makeSubOpts());
		expect(PtyBridge.spawn).toHaveBeenCalledOnce();
	});

	it("sends ready frame to new subscriber", () => {
		const ws = makeWs();
		pool.subscribe(ws as never, makeSubOpts());
		expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "ready" }));
	});

	it("replays output buffer to reconnecting subscriber", () => {
		const ws1 = makeWs("ws-1");
		pool.subscribe(ws1 as never, makeSubOpts());

		// Simulate PTY data arriving
		const onDataCb = mockBridgeInstance.onData.mock.calls[0][0];
		const chunk = Buffer.from("hello from claude\r\n");
		onDataCb(chunk);

		// Disconnect then reconnect
		pool.unsubscribe(ws1 as never);
		const ws2 = makeWs("ws-2");
		pool.subscribe(ws2 as never, makeSubOpts());

		// ws2 should have received the replayed buffer
		expect(ws2.sendBinary).toHaveBeenCalled();
	});

	it("broadcasts PTY output to all current subscribers", () => {
		const ws1 = makeWs("ws-1");
		const ws2 = makeWs("ws-2");
		pool.subscribe(ws1 as never, makeSubOpts());
		pool.subscribe(ws2 as never, makeSubOpts());

		const onDataCb = mockBridgeInstance.onData.mock.calls[0][0];
		onDataCb(Buffer.from("output"));

		expect(ws1.sendBinary).toHaveBeenCalled();
		expect(ws2.sendBinary).toHaveBeenCalled();
	});
});

describe("TerminalSessionPool — unsubscribe / idle timeout", () => {
	let pool: TerminalSessionPool;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		mockBridgeInstance.onData.mockImplementation(() => {});
		mockBridgeInstance.onExit.mockImplementation(() => {});
		pool = new TerminalSessionPool();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("does NOT kill PTY immediately on last subscriber disconnect", () => {
		const ws = makeWs();
		pool.subscribe(ws as never, makeSubOpts());
		pool.unsubscribe(ws as never);
		expect(mockBridgeInstance.kill).not.toHaveBeenCalled();
	});

	it("kills PTY after idle timeout when no subscribers remain", () => {
		const ws = makeWs();
		pool.subscribe(ws as never, makeSubOpts());
		pool.unsubscribe(ws as never);

		// Advance past the 30-minute idle timeout
		vi.advanceTimersByTime(31 * 60 * 1000);

		expect(mockBridgeInstance.kill).toHaveBeenCalledOnce();
	});

	it("cancels idle timer when a subscriber reconnects before timeout", () => {
		const ws1 = makeWs("ws-1");
		pool.subscribe(ws1 as never, makeSubOpts());
		pool.unsubscribe(ws1 as never);

		// Reconnect before timeout
		const ws2 = makeWs("ws-2");
		pool.subscribe(ws2 as never, makeSubOpts());

		// Advance past timeout — PTY should NOT be killed
		vi.advanceTimersByTime(31 * 60 * 1000);

		expect(mockBridgeInstance.kill).not.toHaveBeenCalled();
	});
});

describe("TerminalSessionPool — write / resize", () => {
	let pool: TerminalSessionPool;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		mockBridgeInstance.onData.mockImplementation(() => {});
		mockBridgeInstance.onExit.mockImplementation(() => {});
		pool = new TerminalSessionPool();
	});

	afterEach(() => {
		vi.useRealTimers();
		pool.closeAll();
	});

	it("write() routes data to the correct PtyBridge", () => {
		const ws = makeWs();
		pool.subscribe(ws as never, makeSubOpts({ sessionId: "sess-A" }));
		pool.write("sess-A", "hello");
		expect(mockBridgeInstance.write).toHaveBeenCalledWith("hello");
	});

	it("resize() routes dimensions to the correct PtyBridge", () => {
		const ws = makeWs();
		pool.subscribe(ws as never, makeSubOpts({ sessionId: "sess-A" }));
		pool.resize("sess-A", 100, 40);
		expect(mockBridgeInstance.resize).toHaveBeenCalledWith(100, 40);
	});

	it("write() is no-op for unknown sessionId", () => {
		pool.write("nonexistent", "data");
		expect(mockBridgeInstance.write).not.toHaveBeenCalled();
	});
});

describe("TerminalSessionPool — closeAll", () => {
	it("kills all active PtyBridges", () => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		mockBridgeInstance.onData.mockImplementation(() => {});
		mockBridgeInstance.onExit.mockImplementation(() => {});

		const pool = new TerminalSessionPool();
		const ws1 = makeWs("ws-1");
		const ws2 = makeWs("ws-2");
		pool.subscribe(ws1 as never, makeSubOpts({ sessionId: "sess-1" }));
		pool.subscribe(ws2 as never, makeSubOpts({ sessionId: "sess-2" }));

		pool.closeAll();

		// Two distinct PTYs should each be killed
		expect(mockBridgeInstance.kill).toHaveBeenCalledTimes(2);
		vi.useRealTimers();
	});
});

describe("TerminalSessionPool — getSessionsStatus", () => {
	it("returns session entries with mode:'terminal'", () => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		mockBridgeInstance.onData.mockImplementation(() => {});
		mockBridgeInstance.onExit.mockImplementation(() => {});

		const pool = new TerminalSessionPool();
		const ws = makeWs();
		pool.subscribe(
			ws as never,
			makeSubOpts({ sessionId: "sess-1", cwd: "/home/kyle/project" }),
		);

		const statuses = pool.getSessionsStatus();
		expect(statuses).toHaveLength(1);
		expect(statuses[0].session_id).toBe("sess-1");
		expect(statuses[0].mode).toBe("terminal");
		pool.closeAll();
		vi.useRealTimers();
	});

	it("returns empty array when no sessions", () => {
		const pool = new TerminalSessionPool();
		expect(pool.getSessionsStatus()).toEqual([]);
	});
});

describe("TerminalSessionPool — PTY exit handling", () => {
	it("sends exit frame to all subscribers when PTY exits", () => {
		vi.clearAllMocks();
		let exitCb: ((code: number) => void) | undefined;
		mockBridgeInstance.onData.mockImplementation(() => {});
		mockBridgeInstance.onExit.mockImplementation(
			(cb: (code: number) => void) => {
				exitCb = cb;
			},
		);

		const pool = new TerminalSessionPool();
		const ws = makeWs();
		pool.subscribe(ws as never, makeSubOpts());

		// Simulate PTY exit
		exitCb?.(0);

		expect(ws.send).toHaveBeenCalledWith(
			JSON.stringify({ type: "exit", code: 0 }),
		);
		pool.closeAll();
	});
});
