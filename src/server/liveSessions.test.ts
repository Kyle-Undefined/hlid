import { describe, expect, it, vi } from "vitest";
import { getLiveSessionsStatus, hasLiveTerminalSession } from "./liveSessions";
import type { SessionStatusEntry } from "./protocol";

function status(
	sessionId: string,
	mode?: SessionStatusEntry["mode"],
): SessionStatusEntry {
	return {
		session_id: sessionId,
		agent_cwd: "/tmp",
		agent_name: sessionId,
		state: "running",
		model: "claude",
		hasPendingPermissions: false,
		hasDbSession: true,
		db_session_id: sessionId,
		mode,
	};
}

describe("getLiveSessionsStatus", () => {
	it("merges SDK and terminal live session snapshots in order", () => {
		const pool = { getSessionsStatus: vi.fn(() => [status("sdk-1")]) };
		const terminalPool = {
			getSessionsStatus: vi.fn(() => [status("term-1", "terminal")]),
		};

		expect(getLiveSessionsStatus(pool, terminalPool)).toEqual([
			status("sdk-1"),
			status("term-1", "terminal"),
		]);
	});

	it("handles missing pools", () => {
		expect(getLiveSessionsStatus()).toEqual([]);
	});
});

describe("hasLiveTerminalSession", () => {
	it("returns true when the terminal snapshot contains the id", () => {
		const terminalPool = {
			getSessionsStatus: vi.fn(() => [status("term-1", "terminal")]),
		};

		expect(hasLiveTerminalSession(terminalPool, "term-1")).toBe(true);
	});

	it("returns false when terminal pool is missing or does not contain the id", () => {
		const terminalPool = {
			getSessionsStatus: vi.fn(() => [status("term-1", "terminal")]),
		};

		expect(hasLiveTerminalSession(terminalPool, "other")).toBe(false);
		expect(hasLiveTerminalSession(undefined, "term-1")).toBe(false);
	});
});
