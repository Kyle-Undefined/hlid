/**
 * SessionPool unit tests — pool lifecycle, per-session isolation,
 * vault helpers, and capacity enforcement.
 *
 * Strategy: SessionManager is mocked so pool tests only exercise routing
 * and bookkeeping logic, not the full SDK stack.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HlidConfig } from "../config";
import type { AgentProvider } from "./agentProvider";

// ── mocks ─────────────────────────────────────────────────────────────────────

/**
 * Track mock instances so tests can inspect per-instance method calls.
 * Each `new SessionManager(...)` call pushes a fresh mock into this array.
 */
const mockInstances: {
	abort: ReturnType<typeof vi.fn>;
	getStatus: ReturnType<typeof vi.fn>;
	getPendingPermissionRequests: ReturnType<typeof vi.fn>;
	getPendingAskUserQuestions: ReturnType<typeof vi.fn>;
	getPendingPlanModeExits: ReturnType<typeof vi.fn>;
	getCurrentSessionId: ReturnType<typeof vi.fn>;
	getSessionLabel: ReturnType<typeof vi.fn>;
	getProviderId: ReturnType<typeof vi.fn>;
	isRunning: ReturnType<typeof vi.fn>;
}[] = [];

vi.mock("./session", () => ({
	// biome-ignore lint/complexity/useArrowFunction: constructor mock for Vitest 4
	SessionManager: vi.fn().mockImplementation(function () {
		const instance = {
			abort: vi.fn(),
			getStatus: vi.fn().mockReturnValue({
				state: "idle",
				model: "claude-test",
				effort: "medium",
				permission_mode: "default",
			}),
			getPendingPermissionRequests: vi.fn().mockReturnValue([]),
			getPendingAskUserQuestions: vi.fn().mockReturnValue([]),
			getPendingPlanModeExits: vi.fn().mockReturnValue([]),
			getCurrentSessionId: vi.fn().mockReturnValue(null),
			getSessionLabel: vi.fn().mockReturnValue(null),
			getProviderId: vi.fn().mockReturnValue("claude"),
			isRunning: vi.fn().mockReturnValue(false),
		};
		mockInstances.push(instance);
		return instance;
	}),
}));

vi.mock("../db", () => ({
	clearCurrentSessionId: vi.fn().mockResolvedValue(undefined),
	appendLog: vi.fn().mockResolvedValue(undefined),
}));

// ── import after mocks ────────────────────────────────────────────────────────

import { SessionPool } from "./sessionPool";

// ── fixtures ──────────────────────────────────────────────────────────────────

function makeConfig(
	vaultPath = "/tmp/test-vault",
	vaultName = "Test Vault",
): HlidConfig {
	return {
		claude: {
			model: "claude-test",
			effort: "medium",
			permission_mode: "default",
			turn_recaps: false,
		},
		vault: { path: vaultPath, name: vaultName },
		agents: [],
	} as unknown as HlidConfig;
}

function makeProviders(): Map<string, AgentProvider> {
	return new Map([
		[
			"claude",
			{
				providerId: "claude",
				models: [],
				effortLevels: [],
				permissionModes: [],
				query: vi.fn(),
			} as unknown as AgentProvider,
		],
	]);
}

function makePool(maxSize?: number): SessionPool {
	return new SessionPool(makeConfig(), makeProviders(), maxSize);
}

beforeEach(() => {
	vi.clearAllMocks();
	mockInstances.length = 0;
});

// ── create ────────────────────────────────────────────────────────────────────

describe("SessionPool.create", () => {
	it("returns a PoolEntry with a non-empty UUID sessionId", () => {
		const pool = makePool();
		const entry = pool.create("/code/proj", "My Agent");

		expect(entry.sessionId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		);
	});

	it("returned entry has correct agentCwd and agentName", () => {
		const pool = makePool();
		const entry = pool.create("/code/proj", "My Agent");

		expect(entry.agentCwd).toBe("/code/proj");
		expect(entry.agentName).toBe("My Agent");
	});

	it("returned entry exposes a manager with abort/getStatus", () => {
		const pool = makePool();
		const entry = pool.create("/code/proj", "Agent");

		expect(typeof entry.manager.abort).toBe("function");
		expect(typeof entry.manager.getStatus).toBe("function");
	});

	it("two calls with same agentCwd produce two distinct entries", () => {
		const pool = makePool();
		const a = pool.create("/code/proj", "Agent");
		const b = pool.create("/code/proj", "Agent");

		expect(a.sessionId).not.toBe(b.sessionId);
		expect(pool.getSize()).toBe(2);
	});

	it("two calls produce entries with distinct sessionIds", () => {
		const pool = makePool();
		const ids = new Set([
			pool.create("/a", "A").sessionId,
			pool.create("/b", "B").sessionId,
			pool.create("/a", "A again").sessionId,
		]);

		expect(ids.size).toBe(3);
	});

	it("increments pool size on each create", () => {
		const pool = makePool();
		expect(pool.getSize()).toBe(0);
		pool.create("/a", "A");
		expect(pool.getSize()).toBe(1);
		pool.create("/b", "B");
		expect(pool.getSize()).toBe(2);
	});

	it("constructs one SessionManager per create call", async () => {
		const { SessionManager } = await import("./session");
		const pool = makePool();
		pool.create("/a", "A");
		pool.create("/b", "B");
		expect(SessionManager).toHaveBeenCalledTimes(2);
	});
});

// ── get ───────────────────────────────────────────────────────────────────────

describe("SessionPool.get", () => {
	it("returns the entry for a known sessionId", () => {
		const pool = makePool();
		const created = pool.create("/code/proj", "Agent");
		const found = pool.get(created.sessionId);

		expect(found).toBe(created);
	});

	it("returns undefined for an unknown sessionId", () => {
		const pool = makePool();
		expect(pool.get("does-not-exist")).toBeUndefined();
	});

	it("returns different entries for different sessionIds", () => {
		const pool = makePool();
		const a = pool.create("/a", "A");
		const b = pool.create("/b", "B");

		expect(pool.get(a.sessionId)).toBe(a);
		expect(pool.get(b.sessionId)).toBe(b);
		expect(pool.get(a.sessionId)).not.toBe(pool.get(b.sessionId));
	});
});

// ── close ─────────────────────────────────────────────────────────────────────

describe("SessionPool.close", () => {
	it("calls abort() on the session manager", () => {
		const pool = makePool();
		const entry = pool.create("/code/proj", "Agent");
		pool.close(entry.sessionId);

		expect(entry.manager.abort).toHaveBeenCalledOnce();
	});

	it("removes the entry from the pool", () => {
		const pool = makePool();
		const entry = pool.create("/code/proj", "Agent");
		pool.close(entry.sessionId);

		expect(pool.get(entry.sessionId)).toBeUndefined();
		expect(pool.getSize()).toBe(0);
	});

	it("does not affect other entries", () => {
		const pool = makePool();
		const a = pool.create("/a", "A");
		const b = pool.create("/b", "B");

		pool.close(a.sessionId);

		expect(pool.get(b.sessionId)).toBe(b);
		expect(pool.getSize()).toBe(1);
	});

	it("is a no-op for unknown sessionId (does not throw)", () => {
		const pool = makePool();
		expect(() => pool.close("not-real")).not.toThrow();
	});

	it("entry is no longer returned after close", () => {
		const pool = makePool();
		const entry = pool.create("/code/proj", "Agent");
		pool.close(entry.sessionId);

		expect(pool.get(entry.sessionId)).toBeUndefined();
	});
});

// ── closeAll ──────────────────────────────────────────────────────────────────

describe("SessionPool.closeAll", () => {
	it("calls abort() on every manager", () => {
		const pool = makePool();
		const a = pool.create("/a", "A");
		const b = pool.create("/b", "B");
		const c = pool.create("/c", "C");

		pool.closeAll();

		expect(a.manager.abort).toHaveBeenCalledOnce();
		expect(b.manager.abort).toHaveBeenCalledOnce();
		expect(c.manager.abort).toHaveBeenCalledOnce();
	});

	it("empties the pool", () => {
		const pool = makePool();
		pool.create("/a", "A");
		pool.create("/b", "B");

		pool.closeAll();

		expect(pool.getSize()).toBe(0);
	});

	it("is a no-op on empty pool (does not throw)", () => {
		const pool = makePool();
		expect(() => pool.closeAll()).not.toThrow();
	});
});

// ── capacity cap ──────────────────────────────────────────────────────────────

describe("SessionPool capacity cap", () => {
	it("throws when pool is full (default cap 20)", () => {
		const pool = makePool(3);
		pool.create("/a", "A");
		pool.create("/b", "B");
		pool.create("/c", "C");

		expect(() => pool.create("/d", "D")).toThrow(/capacity/i);
	});

	it("allows create after close frees a slot", () => {
		const pool = makePool(2);
		const a = pool.create("/a", "A");
		pool.create("/b", "B");

		pool.close(a.sessionId);

		expect(() => pool.create("/c", "C")).not.toThrow();
	});

	it("default cap is 20", () => {
		const pool = makePool(); // no maxSize arg
		for (let i = 0; i < 20; i++) {
			pool.create(`/a/${i}`, `Agent ${i}`);
		}
		expect(() => pool.create("/overflow", "Over")).toThrow(/capacity/i);
	});
});

// ── vaultEntry / vaultSessionId ───────────────────────────────────────────────

describe("SessionPool vault helpers", () => {
	it("vaultEntry creates an entry with the vault path from config", () => {
		const pool = new SessionPool(makeConfig("/my/vault"), makeProviders());
		const entry = pool.vaultEntry();

		expect(entry.agentCwd).toBe("/my/vault");
	});

	it("vaultEntry uses vault name from config as agentName", () => {
		const pool = new SessionPool(
			makeConfig("/vault", "My Notes"),
			makeProviders(),
		);
		const entry = pool.vaultEntry();

		expect(entry.agentName).toBe("My Notes");
	});

	it("vaultEntry returns same entry on repeated calls (lazy singleton)", () => {
		const pool = makePool();
		const a = pool.vaultEntry();
		const b = pool.vaultEntry();

		expect(a).toBe(b);
		expect(pool.getSize()).toBe(1);
	});

	it("vaultSessionId returns same UUID as vaultEntry.sessionId", () => {
		const pool = makePool();
		expect(pool.vaultSessionId()).toBe(pool.vaultEntry().sessionId);
	});

	it("vaultEntry recreates if its session was closed", () => {
		const pool = makePool();
		const first = pool.vaultEntry();
		pool.close(first.sessionId);

		const second = pool.vaultEntry();
		expect(second.sessionId).not.toBe(first.sessionId);
	});
});

// ── getSessionsStatus ─────────────────────────────────────────────────────────

describe("SessionPool.getSessionsStatus", () => {
	it("returns empty array when pool is empty", () => {
		const pool = makePool();
		expect(pool.getSessionsStatus()).toEqual([]);
	});

	it("returns one entry per live session", () => {
		const pool = makePool();
		pool.create("/a", "Alpha");
		pool.create("/b", "Beta");

		const status = pool.getSessionsStatus();
		expect(status).toHaveLength(2);
	});

	it("each entry has required fields", () => {
		const pool = makePool();
		const entry = pool.create("/code/proj", "MyAgent");
		const [s] = pool.getSessionsStatus();

		expect(s.session_id).toBe(entry.sessionId);
		expect(s.agent_cwd).toBe("/code/proj");
		expect(s.agent_name).toBe("MyAgent");
		expect(s.state).toBe("idle");
		expect(s.model).toBe("claude-test");
		expect(s.effort).toBe("medium");
		expect(s.permission_mode).toBe("default");
		expect(typeof s.hasPendingPermissions).toBe("boolean");
	});

	it("reflects running state from manager.getStatus()", () => {
		const pool = makePool();
		pool.create("/code/proj", "Agent");
		// Override the mocked getStatus to return running
		mockInstances[0]?.getStatus.mockReturnValue({
			state: "running",
			model: "claude-test",
		});

		const [s] = pool.getSessionsStatus();
		expect(s.state).toBe("running");
	});

	it("hasPendingPermissions is true when manager has pending requests", () => {
		const pool = makePool();
		pool.create("/code/proj", "Agent");
		mockInstances[0]?.getPendingPermissionRequests.mockReturnValue([
			{ id: "p1", toolName: "Bash", title: "Run?" },
		]);

		const [s] = pool.getSessionsStatus();
		expect(s.hasPendingPermissions).toBe(true);
	});

	it("hasPendingPermissions is false when no pending requests", () => {
		const pool = makePool();
		pool.create("/code/proj", "Agent");
		mockInstances[0]?.getPendingPermissionRequests.mockReturnValue([]);

		const [s] = pool.getSessionsStatus();
		expect(s.hasPendingPermissions).toBe(false);
	});

	it("includes pending plan approvals in the interaction status", () => {
		const pool = makePool();
		pool.create("/code/proj", "Agent");
		mockInstances[0]?.getPendingPlanModeExits.mockReturnValue([
			{ type: "plan_mode_exit", id: "plan-1", input: { plan: "Plan" } },
		]);

		expect(pool.getSessionsStatus()[0]?.hasPendingPermissions).toBe(true);
	});

	it("removes closed sessions from status", () => {
		const pool = makePool();
		const a = pool.create("/a", "A");
		pool.create("/b", "B");

		pool.close(a.sessionId);

		const status = pool.getSessionsStatus();
		expect(status).toHaveLength(1);
		expect(status[0]?.agent_cwd).toBe("/b");
	});

	it("includes lastLabel when manager.getSessionLabel() returns a value", () => {
		const pool = makePool();
		pool.create("/code/proj", "Agent");
		mockInstances[0]?.getSessionLabel.mockReturnValue("FIX THE BUG");

		const [s] = pool.getSessionsStatus();
		expect(s?.lastLabel).toBe("FIX THE BUG");
	});

	it("omits lastLabel when manager.getSessionLabel() returns null", () => {
		const pool = makePool();
		pool.create("/code/proj", "Agent");
		mockInstances[0]?.getSessionLabel.mockReturnValue(null);

		const [s] = pool.getSessionsStatus();
		expect(s).not.toHaveProperty("lastLabel");
	});
});

// ── findByDbSessionId ─────────────────────────────────────────────────────────

describe("SessionPool.findByDbSessionId", () => {
	it("returns the entry whose manager.getCurrentSessionId() matches", () => {
		const pool = makePool();
		const a = pool.create("/a", "A");
		const b = pool.create("/b", "B");
		mockInstances[0]?.getCurrentSessionId.mockReturnValue("db-session-a");
		mockInstances[1]?.getCurrentSessionId.mockReturnValue("db-session-b");

		expect(pool.findByDbSessionId("db-session-a")).toBe(a);
		expect(pool.findByDbSessionId("db-session-b")).toBe(b);
	});

	it("returns undefined when no entry matches", () => {
		const pool = makePool();
		pool.create("/a", "A");
		mockInstances[0]?.getCurrentSessionId.mockReturnValue("db-session-a");

		expect(pool.findByDbSessionId("nonexistent")).toBeUndefined();
	});

	it("returns undefined when pool is empty", () => {
		const pool = makePool();
		expect(pool.findByDbSessionId("any-id")).toBeUndefined();
	});

	it("does not match entries whose getCurrentSessionId returns null", () => {
		const pool = makePool();
		pool.create("/a", "A");
		mockInstances[0]?.getCurrentSessionId.mockReturnValue(null);

		expect(pool.findByDbSessionId("any-id")).toBeUndefined();
	});

	it("finds the correct entry among several with different db session ids", () => {
		const pool = makePool();
		pool.create("/a", "A");
		const b = pool.create("/b", "B");
		pool.create("/c", "C");
		mockInstances[0]?.getCurrentSessionId.mockReturnValue("db-a");
		mockInstances[1]?.getCurrentSessionId.mockReturnValue("db-b");
		mockInstances[2]?.getCurrentSessionId.mockReturnValue("db-c");

		expect(pool.findByDbSessionId("db-b")).toBe(b);
	});
});

// ── getAllEntries ─────────────────────────────────────────────────────────────

describe("SessionPool.getAllEntries", () => {
	it("iterates all live entries", () => {
		const pool = makePool();
		pool.create("/a", "A");
		pool.create("/b", "B");

		const entries = [...pool.getAllEntries()];
		expect(entries).toHaveLength(2);
	});

	it("returns empty iterator for empty pool", () => {
		const pool = makePool();
		expect([...pool.getAllEntries()]).toHaveLength(0);
	});
});
