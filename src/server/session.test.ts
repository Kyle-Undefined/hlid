/**
 * SessionManager unit tests — state machine and config methods only.
 * runQuery() is SDK-coupled and not tested here; SessionManager's
 * simple observable behaviors are fully covered.
 */
import { describe, expect, it, vi } from "vitest";
import type { HlidConfig } from "../config";

// ── module mocks (hoisted) ────────────────────────────────────────────────────

vi.mock("./config");
vi.mock("./agentPaths", () => ({
	computeAllowedAgentRealPaths: vi.fn().mockReturnValue([]),
	isAllowedAgentPath: vi.fn().mockReturnValue(false),
	resolveAgentMode: vi.fn().mockReturnValue("cwd"),
}));
vi.mock("../lib/claudePath", () => ({
	resolveClaudeExecutable: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../db", () => ({
	clearCurrentSessionId: vi.fn().mockResolvedValue(undefined),
	setCurrentSessionId: vi.fn().mockResolvedValue(undefined),
	appendMessage: vi.fn().mockResolvedValue(undefined),
	appendToolEvent: vi.fn().mockResolvedValue(undefined),
	appendLog: vi.fn().mockResolvedValue(undefined),
	createSession: vi.fn().mockResolvedValue(undefined),
	recordQuery: vi.fn().mockResolvedValue(undefined),
	getSessionMessages: vi.fn().mockResolvedValue([]),
	getSessionAgentCwd: vi.fn().mockResolvedValue(null),
	getSessionClaudeId: vi.fn().mockResolvedValue(null),
	setSessionClaudeId: vi.fn().mockResolvedValue(undefined),
	setSessionActualModel: vi.fn().mockResolvedValue(undefined),
	setSessionAgentCwd: vi.fn().mockResolvedValue(undefined),
	saveSetting: vi.fn().mockResolvedValue(undefined),
	linkAttachmentToMessage: vi.fn().mockResolvedValue(undefined),
	recordPermissionEvent: vi.fn().mockResolvedValue(undefined),
}));
// Prevent SDK from spawning any process
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(),
}));
vi.mock("./recap", () => ({
	generateTurnRecap: vi.fn().mockResolvedValue(undefined),
}));

// ── import after mocks ────────────────────────────────────────────────────────

import * as dbMock from "../db";
import { SessionManager } from "./session";

// ── fixtures ──────────────────────────────────────────────────────────────────

function makeConfig(model = "claude-test"): HlidConfig {
	return {
		claude: {
			model,
			effort: "medium",
			permission_mode: "default",
			turn_recaps: false,
		},
		vault: { path: "/tmp/hlid-test-vault", name: "Test" },
		agents: [],
	} as unknown as HlidConfig;
}

// ── getStatus / initial state ─────────────────────────────────────────────────

describe("SessionManager — initial state", () => {
	it("reports idle state and configured model", () => {
		const sm = new SessionManager(makeConfig("model-x"));
		expect(sm.getStatus()).toEqual({ state: "idle", model: "model-x" });
	});

	it("isRunning() returns false initially", () => {
		const sm = new SessionManager(makeConfig());
		expect(sm.isRunning()).toBe(false);
	});

	it("getLastMcpStatus() returns null initially", () => {
		const sm = new SessionManager(makeConfig());
		expect(sm.getLastMcpStatus()).toBeNull();
	});

	it("getCurrentSessionId() returns null initially", () => {
		const sm = new SessionManager(makeConfig());
		expect(sm.getCurrentSessionId()).toBeNull();
	});

	it("getPendingPermissionRequests() returns empty array initially", () => {
		const sm = new SessionManager(makeConfig());
		expect(sm.getPendingPermissionRequests()).toEqual([]);
	});
});

// ── restoreMcpStatus ──────────────────────────────────────────────────────────

describe("SessionManager — restoreMcpStatus", () => {
	it("sets and retrieves MCP status", () => {
		const sm = new SessionManager(makeConfig());
		const statuses = [{ name: "my-server", status: "connected" as const }];
		sm.restoreMcpStatus(statuses);
		expect(sm.getLastMcpStatus()).toEqual(statuses);
	});

	it("replaces previous MCP status on second call", () => {
		const sm = new SessionManager(makeConfig());
		sm.restoreMcpStatus([{ name: "a", status: "connected" }]);
		sm.restoreMcpStatus([{ name: "b", status: "failed" }]);
		const last = sm.getLastMcpStatus();
		expect(last).not.toBeNull();
		expect(last?.[0].name).toBe("b");
	});
});

// ── syncConfig ────────────────────────────────────────────────────────────────

describe("SessionManager — syncConfig", () => {
	it("returns false when model unchanged", () => {
		const sm = new SessionManager(makeConfig("model-a"));
		expect(sm.syncConfig(makeConfig("model-a"))).toBe(false);
	});

	it("returns true when model changes", () => {
		const sm = new SessionManager(makeConfig("model-a"));
		expect(sm.syncConfig(makeConfig("model-b"))).toBe(true);
	});

	it("updates model in getStatus after syncConfig", () => {
		const sm = new SessionManager(makeConfig("old-model"));
		sm.syncConfig(makeConfig("new-model"));
		expect(sm.getStatus().model).toBe("new-model");
	});

	it("does not reset session state (non-destructive update)", () => {
		const sm = new SessionManager(makeConfig());
		// syncConfig should not touch session continuity
		sm.syncConfig(makeConfig("new-model"));
		expect(sm.getStatus().state).toBe("idle");
		expect(sm.getCurrentSessionId()).toBeNull();
	});
});

// ── clearHistory ──────────────────────────────────────────────────────────────

describe("SessionManager — clearHistory", () => {
	it("does not throw", () => {
		const sm = new SessionManager(makeConfig());
		expect(() => sm.clearHistory()).not.toThrow();
	});

	it("session remains idle after clearHistory", () => {
		const sm = new SessionManager(makeConfig());
		sm.clearHistory();
		expect(sm.getStatus().state).toBe("idle");
	});

	it("calls db.clearCurrentSessionId", () => {
		vi.mocked(dbMock.clearCurrentSessionId).mockClear();
		const sm = new SessionManager(makeConfig());
		sm.clearHistory();
		expect(vi.mocked(dbMock.clearCurrentSessionId)).toHaveBeenCalled();
	});
});

// ── abort ─────────────────────────────────────────────────────────────────────

describe("SessionManager — abort", () => {
	it("does not throw when no query is running", () => {
		const sm = new SessionManager(makeConfig());
		expect(() => sm.abort()).not.toThrow();
	});

	it("state remains idle after abort when not running", () => {
		const sm = new SessionManager(makeConfig());
		sm.abort();
		expect(sm.getStatus().state).toBe("idle");
	});
});

// ── reinitialize ──────────────────────────────────────────────────────────────

describe("SessionManager — reinitialize", () => {
	it("applies new config", () => {
		const sm = new SessionManager(makeConfig("old-model"));
		sm.reinitialize(makeConfig("fresh-model"));
		expect(sm.getStatus().model).toBe("fresh-model");
	});

	it("resets state to idle", () => {
		const sm = new SessionManager(makeConfig());
		sm.reinitialize(makeConfig());
		expect(sm.getStatus().state).toBe("idle");
	});

	it("clears currentSessionId", () => {
		const sm = new SessionManager(makeConfig());
		sm.reinitialize(makeConfig());
		expect(sm.getCurrentSessionId()).toBeNull();
	});
});
