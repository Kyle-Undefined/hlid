import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = {
	write: vi.fn(),
	resize: vi.fn(),
	kill: vi.fn(),
	onData: vi.fn(),
	onExit: vi.fn(),
};

vi.mock("./ptyBridge", () => ({
	PtyBridge: { spawn: vi.fn(() => bridge) },
}));

vi.mock("./resolveShell", () => ({
	resolveShell: vi.fn(() => ({ executable: "/bin/bash", args: ["-l"] })),
}));

import { PtyBridge } from "./ptyBridge";
import { IDLE_TIMEOUT_MS } from "./ptySessionPoolBase";
import { ShellSessionPool } from "./shellSessionPool";

function makeWs(id: string) {
	return {
		id,
		send: vi.fn(),
		sendBinary: vi.fn(),
	};
}

describe("ShellSessionPool lifetime", () => {
	let pool: ShellSessionPool;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		pool = new ShellSessionPool();
	});

	afterEach(() => {
		pool.closeAll();
		vi.useRealTimers();
	});

	it("keeps the shell alive without browser subscribers until its session closes", () => {
		const first = makeWs("first");
		pool.subscribe(first as never, {
			sessionId: "session-a",
			cwd: "/tmp",
			cols: 80,
			rows: 24,
		});
		pool.unsubscribe(first as never);

		vi.advanceTimersByTime(IDLE_TIMEOUT_MS * 2);
		const second = makeWs("second");
		pool.subscribe(second as never, {
			sessionId: "session-a",
			cwd: "/tmp",
			cols: 80,
			rows: 24,
		});

		expect(PtyBridge.spawn).toHaveBeenCalledOnce();
		expect(bridge.kill).not.toHaveBeenCalled();

		pool.terminate("session-a");
		expect(bridge.kill).toHaveBeenCalledOnce();
	});
});
