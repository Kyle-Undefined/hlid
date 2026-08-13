/**
 * SessionPool unit tests — pool lifecycle, per-session isolation,
 * vault helpers, and capacity enforcement.
 *
 * Strategy: SessionManager is mocked so pool tests only exercise routing
 * and bookkeeping logic, not the full SDK stack.
 */

import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeConfig as makeBaseConfig } from "#/test/fixtures";
import type { HlidConfig } from "../config";
import type { AgentProvider } from "./agentProvider";

// ── mocks ─────────────────────────────────────────────────────────────────────

/**
 * Track mock instances so tests can inspect per-instance method calls.
 * Each `new SessionManager(...)` call pushes a fresh mock into this array.
 */
const mockInstances: {
	abort: ReturnType<typeof vi.fn>;
	suspendForRestart: ReturnType<typeof vi.fn>;
	suspendForRestartAndWait: ReturnType<typeof vi.fn>;
	restoreDurableTurns: ReturnType<typeof vi.fn>;
	syncConfig: ReturnType<typeof vi.fn>;
	retireProviderSessions: ReturnType<typeof vi.fn>;
	getStatus: ReturnType<typeof vi.fn>;
	getPendingPermissionRequests: ReturnType<typeof vi.fn>;
	getPendingAskUserQuestions: ReturnType<typeof vi.fn>;
	getPendingPlanModeExits: ReturnType<typeof vi.fn>;
	getQueueState: ReturnType<typeof vi.fn>;
	getCurrentSessionId: ReturnType<typeof vi.fn>;
	getCurrentGoal: ReturnType<typeof vi.fn>;
	getActiveRoutine: ReturnType<typeof vi.fn>;
	getSleepState: ReturnType<typeof vi.fn>;
	getSessionLabel: ReturnType<typeof vi.fn>;
	getSessionPresentation: ReturnType<typeof vi.fn>;
	getBackgroundActivities: ReturnType<typeof vi.fn>;
	setBackgroundActivityChangeHandler: ReturnType<typeof vi.fn>;
	getProviderId: ReturnType<typeof vi.fn>;
	isRunning: ReturnType<typeof vi.fn>;
}[] = [];

vi.mock("./session", () => ({
	// biome-ignore lint/complexity/useArrowFunction: constructor mock for Vitest 4
	SessionManager: vi.fn().mockImplementation(function () {
		const instance = {
			abort: vi.fn(),
			suspendForRestart: vi.fn(),
			suspendForRestartAndWait: vi.fn().mockResolvedValue(undefined),
			restoreDurableTurns: vi.fn((rows: unknown[]) => rows.length),
			syncConfig: vi.fn().mockReturnValue(false),
			retireProviderSessions: vi.fn().mockReturnValue(false),
			getStatus: vi.fn().mockReturnValue({
				state: "idle",
				model: "claude-test",
				effort: "medium",
				permission_mode: "default",
			}),
			getPendingPermissionRequests: vi.fn().mockReturnValue([]),
			getPendingAskUserQuestions: vi.fn().mockReturnValue([]),
			getPendingPlanModeExits: vi.fn().mockReturnValue([]),
			getQueueState: vi.fn().mockReturnValue({
				pending_turn_ids: [],
				pending_turns: [],
				running_turn_id: null,
			}),
			getCurrentSessionId: vi.fn().mockReturnValue(null),
			getCurrentGoal: vi.fn().mockReturnValue(null),
			getActiveRoutine: vi.fn().mockReturnValue(null),
			getSleepState: vi.fn().mockReturnValue(null),
			getSessionLabel: vi.fn().mockReturnValue(null),
			getSessionPresentation: vi.fn().mockReturnValue({
				pinned: false,
				forkParentSessionId: null,
				forkParentLabel: null,
				forkKind: null,
				delegationParentSessionId: null,
				delegationParentLabel: null,
				delegationParentTurnId: null,
				delegationDepth: null,
			}),
			getBackgroundActivities: vi.fn().mockReturnValue([]),
			setBackgroundActivityChangeHandler: vi.fn(),
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
	listResumableInterruptedHlidDelegations: vi.fn().mockResolvedValue([]),
	listHlidDelegationAncestorLineage: vi.fn().mockResolvedValue([]),
	listHlidDelegationLifecycleRollups: vi.fn().mockResolvedValue([]),
	getSessionById: vi.fn().mockResolvedValue(null),
	discardDispatchingSessionTurnsAfterRestart: vi.fn().mockResolvedValue(0),
	listRecoverablePendingSessionTurns: vi.fn().mockResolvedValue([]),
}));

// ── import after mocks ────────────────────────────────────────────────────────

import * as dbMock from "../db";
import { SessionManager } from "./session";
import { SessionPool } from "./sessionPool";

// ── fixtures ──────────────────────────────────────────────────────────────────

const makeConfig = (
	vaultPath = "/tmp/test-vault",
	vaultName = "Test Vault",
): HlidConfig =>
	makeBaseConfig({
		claude: {
			model: "claude-test",
			effort: "medium",
			permission_mode: "default",
			turn_recaps: false,
		},
		vault: { path: vaultPath, name: vaultName },
	});

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

describe("SessionPool delegation workspaces", () => {
	it("accepts only canonical exact configured workspaces", () => {
		const root = mkdtempSync(join(tmpdir(), "hlid-delegation-workspace-"));
		try {
			const vault = join(root, "vault");
			const agent = join(root, "agent");
			const nested = join(agent, "nested");
			const unrelated = join(root, "unrelated");
			const agentAlias = join(root, "agent-alias");
			for (const path of [vault, agent, nested, unrelated]) {
				mkdirSync(path, { recursive: true });
			}
			symlinkSync(agent, agentAlias, "dir");
			const config = makeConfig(vault);
			config.agents = [
				{
					path: agent,
					name: "Agent",
					mode: "cwd",
					provider: "claude",
				},
			];
			const pool = new SessionPool(config, makeProviders());

			expect(pool.resolveDelegationWorkspace(vault)).toBe(realpathSync(vault));
			expect(pool.resolveDelegationWorkspace(agent)).toBe(realpathSync(agent));
			expect(pool.resolveDelegationWorkspace(agentAlias)).toBe(
				realpathSync(agent),
			);
			expect(pool.resolveDelegationWorkspace(nested)).toBeNull();
			expect(pool.resolveDelegationWorkspace(unrelated)).toBeNull();
			expect(pool.resolveDelegationWorkspace(join(root, "missing"))).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("SessionPool provider runtime workspaces", () => {
	it("resolves vault, cwd-mode, and context-mode runtime ownership exactly", () => {
		const vault = "C:\\Users\\kyle\\Vault";
		const cwdAgent = "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\cwd-agent";
		const contextAgent =
			"\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\context-agent";
		const config = makeConfig(vault);
		config.agents = [
			{
				path: cwdAgent,
				name: "Cwd agent",
				mode: "cwd",
				provider: "claude",
			},
			{
				path: contextAgent,
				name: "Context agent",
				mode: "context",
				provider: "claude",
			},
		];
		const pool = new SessionPool(config, makeProviders());
		const persistedCwdAlias = "\\\\wsl$\\ubuntu-24.04\\home\\kyle\\cwd-agent";

		expect(pool.providerRuntimeCwd(null)).toBe(vault);
		expect(pool.providerRuntimeCwd(vault.toLowerCase())).toBe(vault);
		expect(pool.providerRuntimeCwd(persistedCwdAlias)).toBe(persistedCwdAlias);
		expect(pool.providerRuntimeCwd(contextAgent)).toBe(vault);
		expect(
			pool.providerRuntimeCwd(
				"\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\removed-agent",
			),
		).toBeNull();
	});
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
		const pool = makePool();
		pool.create("/a", "A");
		pool.create("/b", "B");
		expect(SessionManager).toHaveBeenCalledTimes(2);
	});

	it("constructs the manager with the pool entry's agent defaults", () => {
		const config = makeConfig();
		const providers = makeProviders();
		const pool = new SessionPool(config, providers);

		pool.create("/code/proj", "Agent");

		expect(SessionManager).toHaveBeenCalledWith(
			config,
			providers,
			"/code/proj",
		);
	});
});

describe("SessionPool durable delegation attention", () => {
	it("projects restart-interrupted children and rolls them into a live parent", async () => {
		vi.mocked(
			dbMock.listResumableInterruptedHlidDelegations,
		).mockResolvedValueOnce([
			{
				id: "delegation-1",
				parent_session_id: "parent-db",
				parent_turn_id: "turn-parent",
				parent_label: "Parent",
				parent_delegation_id: null,
				routine_run_id: null,
				child_session_id: "child-db",
				depth: 1,
				task: "Child task",
				provider_id: "codex",
				model: "gpt-test",
				effort: "high",
				service_tier: null,
				workspace: "/code/proj",
				permission_mode: "default",
				timeout_seconds: 600,
				token_budget: null,
				tokens_used: 0,
				cost_budget: null,
				cost_used: 0,
				attempt_count: 1,
				continuation_mode: "initial",
				handoff: {
					visible_transcript_chars: 0,
					selected_skills: 0,
					selected_relics: 0,
					vault_references: 0,
					workspace_references: 0,
				},
				status: "interrupted",
				started_at: 10,
				updated_at: 20,
				ended_at: 20,
				result_text: null,
				error: "Hlid restarted",
				progress_text: null,
				open_url: "/raven?session=child-db",
				complete: true,
				resumable: true,
			},
		]);
		vi.mocked(dbMock.getSessionById).mockResolvedValueOnce({
			id: "child-db",
			label: "Child",
			model: "gpt-test",
			provider_id: "codex",
			agent_cwd: "/code/proj",
			pinned: 0,
			archived_at: null,
			started_at: 10,
			ended_at: null,
			query_count: 0,
			total_cost: 0,
			total_input_tokens: 0,
			total_output_tokens: 0,
			total_cache_read_tokens: 0,
			total_cache_creation_tokens: 0,
			total_turns: 0,
		});
		const pool = makePool();
		pool.create("/code/proj", "Parent");
		mockInstances[0]?.getCurrentSessionId.mockReturnValue("parent-db");

		await pool.refreshDurableDelegationAttention();

		const statuses = pool.getSessionsStatus();
		expect(statuses).toHaveLength(2);
		expect(statuses[0]).toMatchObject({
			db_session_id: "parent-db",
			attention: {
				bucket: "needs_attention",
				reason: "delegated_child_attention",
			},
			delegated_attention: {
				descendant_count: 1,
				needs_attention_count: 1,
			},
		});
		expect(statuses[1]).toMatchObject({
			session_id: "child-db",
			db_session_id: "child-db",
			durable_only: true,
			delegation_status: "interrupted",
			delegation_resumable: true,
			attention: {
				bucket: "needs_attention",
				reason: "delegation_interrupted",
			},
		});
	});

	it("rolls a restart-interrupted grandchild through a completed non-live parent", async () => {
		vi.mocked(
			dbMock.listResumableInterruptedHlidDelegations,
		).mockResolvedValueOnce([
			{
				id: "delegation-2",
				parent_session_id: "completed-child-db",
				parent_turn_id: "turn-child",
				parent_label: "Completed child",
				parent_delegation_id: "delegation-1",
				routine_run_id: null,
				child_session_id: "grandchild-db",
				depth: 2,
				task: "Grandchild task",
				provider_id: "codex",
				model: "gpt-test",
				effort: "high",
				service_tier: null,
				workspace: "/code/proj",
				permission_mode: "default",
				timeout_seconds: 600,
				token_budget: null,
				tokens_used: 0,
				cost_budget: null,
				cost_used: 0,
				attempt_count: 1,
				continuation_mode: "initial",
				handoff: {
					visible_transcript_chars: 0,
					selected_skills: 0,
					selected_relics: 0,
					vault_references: 0,
					workspace_references: 0,
				},
				status: "interrupted",
				started_at: 10,
				updated_at: 20,
				ended_at: 20,
				result_text: null,
				error: "Hlid restarted",
				progress_text: null,
				open_url: "/raven?session=grandchild-db",
				complete: true,
				resumable: true,
			},
		]);
		vi.mocked(dbMock.listHlidDelegationAncestorLineage).mockResolvedValueOnce([
			{
				child_session_id: "grandchild-db",
				parent_session_id: "completed-child-db",
			},
			{
				child_session_id: "completed-child-db",
				parent_session_id: "root-db",
			},
		]);
		vi.mocked(dbMock.listHlidDelegationLifecycleRollups).mockResolvedValueOnce([
			{
				parent_session_id: "root-db",
				direct_count: 1,
				descendant_count: 2,
				waiting_count: 1,
				completed_count: 1,
				failed_count: 0,
				total_tokens: 1_000,
				total_cost: 1.5,
				elapsed_duration_seconds: 120,
				last_activity_at: 20_000,
			},
			{
				parent_session_id: "completed-child-db",
				direct_count: 1,
				descendant_count: 1,
				waiting_count: 1,
				completed_count: 0,
				failed_count: 0,
				total_tokens: 400,
				total_cost: 0.5,
				elapsed_duration_seconds: 45,
				last_activity_at: 20_000,
			},
		]);
		vi.mocked(dbMock.getSessionById).mockResolvedValueOnce({
			id: "grandchild-db",
			label: "Grandchild",
			model: "gpt-test",
			provider_id: "codex",
			agent_cwd: "/code/proj",
			pinned: 0,
			archived_at: null,
			started_at: 10,
			ended_at: null,
			query_count: 0,
			total_cost: 0,
			total_input_tokens: 0,
			total_output_tokens: 0,
			total_cache_read_tokens: 0,
			total_cache_creation_tokens: 0,
			total_turns: 0,
		});
		const pool = makePool();
		pool.create("/code/proj", "Root");
		mockInstances[0]?.getCurrentSessionId.mockReturnValue("root-db");

		await pool.refreshDurableDelegationAttention();

		const statuses = pool.getSessionsStatus();
		expect(statuses).toHaveLength(2);
		expect(statuses[0]).toMatchObject({
			db_session_id: "root-db",
			attention: {
				bucket: "needs_attention",
				reason: "delegated_child_attention",
			},
			delegated_attention: {
				direct_count: 1,
				descendant_count: 2,
				waiting_count: 1,
				completed_count: 1,
				total_tokens: 1_000,
				total_cost: 1.5,
				elapsed_duration_seconds: 120,
				needs_attention_count: 1,
			},
		});
		expect(
			statuses.some((status) => status.db_session_id === "completed-child-db"),
		).toBe(false);
	});

	it("rolls live grandchild attention through a completed non-live parent", async () => {
		vi.mocked(dbMock.listHlidDelegationAncestorLineage).mockResolvedValueOnce([
			{
				child_session_id: "grandchild-db",
				parent_session_id: "completed-child-db",
			},
			{
				child_session_id: "completed-child-db",
				parent_session_id: "root-db",
			},
		]);
		const pool = makePool();
		pool.create("/code/proj", "Root");
		pool.create("/code/proj", "Grandchild");
		mockInstances[0]?.getCurrentSessionId.mockReturnValue("root-db");
		mockInstances[1]?.getCurrentSessionId.mockReturnValue("grandchild-db");
		mockInstances[1]?.getPendingPermissionRequests.mockReturnValue([
			{ id: "permission-1" },
		]);

		await pool.refreshDurableDelegationAttention();

		expect(dbMock.listHlidDelegationAncestorLineage).toHaveBeenCalledWith([
			"root-db",
			"grandchild-db",
		]);
		const statuses = pool.getSessionsStatus();
		expect(statuses).toHaveLength(2);
		expect(statuses[0]).toMatchObject({
			db_session_id: "root-db",
			attention: {
				bucket: "needs_attention",
				reason: "delegated_child_attention",
			},
			delegated_attention: {
				direct_count: 0,
				descendant_count: 1,
				needs_attention_count: 1,
			},
		});
		expect(
			statuses.some((status) => status.db_session_id === "completed-child-db"),
		).toBe(false);
	});

	it("projects mixed durable lifecycle counts without creating terminal live rows", async () => {
		vi.mocked(dbMock.listHlidDelegationLifecycleRollups).mockResolvedValueOnce([
			{
				parent_session_id: "root-db",
				direct_count: 2,
				descendant_count: 3,
				waiting_count: 1,
				completed_count: 1,
				failed_count: 1,
				total_tokens: 2_400,
				total_cost: 3.75,
				elapsed_duration_seconds: 300,
				last_activity_at: 42_000,
			},
			{
				parent_session_id: "closed-completed-child",
				direct_count: 1,
				descendant_count: 1,
				waiting_count: 0,
				completed_count: 0,
				failed_count: 1,
				total_tokens: 500,
				total_cost: 0.75,
				elapsed_duration_seconds: 60,
				last_activity_at: 42_000,
			},
		]);
		const pool = makePool();
		pool.create("/code/proj", "Root");
		mockInstances[0]?.getCurrentSessionId.mockReturnValue("root-db");

		await pool.refreshDurableDelegationAttention();

		const statuses = pool.getSessionsStatus();
		expect(statuses).toHaveLength(1);
		expect(statuses[0]).toMatchObject({
			db_session_id: "root-db",
			attention: {
				bucket: "recent",
				reason: "ready",
			},
			delegated_attention: {
				direct_count: 2,
				descendant_count: 3,
				waiting_count: 1,
				completed_count: 1,
				failed_count: 1,
				total_tokens: 2_400,
				total_cost: 3.75,
				elapsed_duration_seconds: 300,
				needs_attention_count: 0,
				working_count: 0,
				queued_count: 0,
				last_activity_at: 42_000,
			},
		});
		expect(
			statuses.some(
				(status) =>
					status.db_session_id === "closed-completed-child" ||
					status.db_session_id === "closed-failed-grandchild",
			),
		).toBe(false);
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
	it("suspends every manager for restart", () => {
		const pool = makePool();
		const a = pool.create("/a", "A");
		const b = pool.create("/b", "B");
		const c = pool.create("/c", "C");

		pool.closeAll();

		expect(a.manager.suspendForRestart).toHaveBeenCalledOnce();
		expect(b.manager.suspendForRestart).toHaveBeenCalledOnce();
		expect(c.manager.suspendForRestart).toHaveBeenCalledOnce();
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

describe("SessionPool.closeAllAndWait", () => {
	it("awaits every manager before emptying the pool", async () => {
		const pool = makePool();
		const a = pool.create("/a", "A");
		const b = pool.create("/b", "B");

		await pool.closeAllAndWait();

		expect(a.manager.suspendForRestartAndWait).toHaveBeenCalledOnce();
		expect(b.manager.suspendForRestartAndWait).toHaveBeenCalledOnce();
		expect(pool.getSize()).toBe(0);
	});

	it("detaches entries and blocks creation until provider cleanup settles", async () => {
		let finishCleanup: (() => void) | undefined;
		const pool = makePool();
		pool.create("/a", "A");
		const manager = mockInstances.at(-1);
		if (!manager) throw new Error("missing manager mock");
		manager.suspendForRestartAndWait.mockReturnValueOnce(
			new Promise<void>((resolve) => {
				finishCleanup = resolve;
			}),
		);

		const draining = pool.closeAllAndWait();
		expect(pool.getSize()).toBe(0);
		expect(() => pool.create("/new", "New")).toThrow("pool is draining");
		finishCleanup?.();
		await draining;

		expect(pool.create("/new", "New")).toBeTruthy();
	});
});

describe("SessionPool CLI update lease", () => {
	it("blocks new sessions after drain until the exact lease is released", async () => {
		const pool = makePool();
		pool.create("/a", "A");
		const leaseId = pool.beginCliUpdateLease();

		await pool.closeAllAndWait();

		expect(() => pool.create("/blocked", "Blocked")).toThrow(
			"CLI update is in progress",
		);
		expect(pool.releaseCliUpdateLease("stale-lease")).toBe(false);
		expect(() => pool.create("/still-blocked", "Blocked")).toThrow(
			"CLI update is in progress",
		);
		expect(pool.releaseCliUpdateLease(leaseId)).toBe(true);
		expect(pool.create("/ready", "Ready")).toBeTruthy();
	});

	it("recovers automatically after a bounded lease expires", () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const pool = makePool();
		pool.beginCliUpdateLease(1_000);
		expect(() => pool.create("/blocked", "Blocked")).toThrow(
			"CLI update is in progress",
		);

		now.mockReturnValue(2_001);
		expect(pool.create("/recovered", "Recovered")).toBeTruthy();
	});

	it("renews only the exact live lease with a bounded extension", () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const pool = makePool();
		const leaseId = pool.beginCliUpdateLease(1_000);

		now.mockReturnValue(1_500);
		expect(pool.renewCliUpdateLease("stale-lease", 60 * 60 * 1_000)).toBe(
			false,
		);
		expect(pool.renewCliUpdateLease(leaseId, 60 * 60 * 1_000)).toBe(true);

		now.mockReturnValue(1_500 + 15 * 60 * 1_000 - 1);
		expect(pool.ownsCliUpdateLease(leaseId)).toBe(true);
		now.mockReturnValue(1_500 + 15 * 60 * 1_000);
		expect(pool.ownsCliUpdateLease(leaseId)).toBe(false);
		expect(pool.renewCliUpdateLease(leaseId)).toBe(false);
	});
});

describe("SessionPool.restoreDurableTurns", () => {
	it("recreates the owning session and restores recoverable rows", async () => {
		const row = {
			turn_id: "turn-1",
			session_id: "db-session-1",
			position: 1,
			payload_json: '{"userMessage":"resume","options":{}}',
			state: "sleeping",
			provider_id: "claude",
			window_id: "five_hour",
			sleep_reason: "threshold",
			sleep_until: 2_000,
			sleep_target: 2_000,
			sleep_utilization: 0.99,
			cap_deadline: null,
			created_at: 1_000,
			updated_at: 1_000,
		} as const;
		vi.mocked(
			dbMock.discardDispatchingSessionTurnsAfterRestart,
		).mockResolvedValue(2);
		vi.mocked(dbMock.listRecoverablePendingSessionTurns).mockResolvedValue([
			row,
		]);
		vi.mocked(dbMock.getSessionById).mockResolvedValue({
			id: "db-session-1",
			label: "Restored",
			agent_cwd: "/restored",
			archived_at: null,
		} as never);
		const pool = makePool();

		expect(await pool.restoreDurableTurns()).toEqual({
			restored: 1,
			discarded: 2,
		});
		expect(pool.getSize()).toBe(1);
		expect(mockInstances[0].restoreDurableTurns).toHaveBeenCalledWith(
			[row],
			expect.any(Function),
		);
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

	it("vaultEntry keeps vault defaults instead of treating the vault as an agent", () => {
		const config = makeConfig("/vault", "My Notes");
		const providers = makeProviders();
		const pool = new SessionPool(config, providers);

		pool.vaultEntry();

		expect(SessionManager).toHaveBeenCalledWith(config, providers, undefined);
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
		expect(s.provider_id).toBe("claude");
		expect(s.model).toBe("claude-test");
		expect(s.effort).toBe("medium");
		expect(s.permission_mode).toBe("default");
		expect(typeof s.hasPendingPermissions).toBe("boolean");
		expect(s.attention).toMatchObject({
			bucket: "recent",
			reason: "ready",
			queue_count: 0,
			pending_count: 0,
		});
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

	it("projects provider activity and its session attention", () => {
		const pool = makePool();
		pool.create("/code/proj", "Agent");
		const activity = {
			providerId: "codex",
			providerSessionId: "thread-1",
			activityId: "terminal-1",
			kind: "terminal",
			status: "running",
			command: "bun run dev",
			startedAtMs: 100,
			updatedAtMs: 200,
			capabilities: { terminate: true },
		};
		mockInstances[0]?.getBackgroundActivities.mockReturnValue([activity]);

		expect(pool.getSessionsStatus()[0]).toMatchObject({
			background_activities: [activity],
			attention: {
				bucket: "working",
				reason: "provider_activity",
			},
		});
	});

	it("hasPendingPermissions is true when manager has pending requests", () => {
		const pool = makePool();
		pool.create("/code/proj", "Agent");
		mockInstances[0]?.getPendingPermissionRequests.mockReturnValue([
			{ id: "p1", toolName: "Bash", title: "Run?" },
		]);

		const [s] = pool.getSessionsStatus();
		expect(s.hasPendingPermissions).toBe(true);
		expect(s.attention).toMatchObject({
			bucket: "needs_attention",
			reason: "permission",
		});
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
		expect(pool.getSessionsStatus()[0]?.attention).toMatchObject({
			bucket: "needs_attention",
			reason: "plan_review",
		});
	});

	it("includes queued prompt counts without replacing active work", () => {
		const pool = makePool();
		pool.create("/code/proj", "Agent");
		mockInstances[0]?.getStatus.mockReturnValue({
			state: "running",
			model: "claude-test",
		});
		mockInstances[0]?.getQueueState.mockReturnValue({
			pending_turn_ids: ["turn-2", "turn-3"],
			pending_turns: [],
			running_turn_id: "turn-1",
		});

		expect(pool.getSessionsStatus()[0]?.attention).toMatchObject({
			bucket: "working",
			reason: "provider_turn",
			queue_count: 2,
		});
	});

	it("projects a running usage sleep without losing queued prompts", () => {
		const pool = makePool();
		pool.create("/code/proj", "Agent");
		mockInstances[0]?.getStatus.mockReturnValue({
			state: "running",
			model: "claude-test",
		});
		mockInstances[0]?.getSleepState.mockReturnValue({
			type: "agent_sleep",
			state: "sleeping",
			providerId: "claude",
			windowId: "five_hour",
			until: 1_784_060_475,
			reason: "limit_reached",
		});
		mockInstances[0]?.getQueueState.mockReturnValue({
			pending_turn_ids: ["turn-2"],
			pending_turns: [],
			running_turn_id: "turn-1",
		});

		expect(pool.getSessionsStatus()[0]?.attention).toMatchObject({
			bucket: "sleeping",
			reason: "usage_sleep",
			queue_count: 1,
			sleep_until: 1_784_060_475,
			sleep_window_id: "five_hour",
		});
	});

	it("derives blocked goals and active Routines from their owning manager", () => {
		const pool = makePool();
		pool.create("/code/proj", "Agent");
		mockInstances[0]?.getCurrentGoal.mockReturnValue({
			status: "blocked",
		});

		expect(pool.getSessionsStatus()[0]?.attention).toMatchObject({
			bucket: "needs_attention",
			reason: "goal_blocked",
		});

		mockInstances[0]?.getCurrentGoal.mockReturnValue(null);
		mockInstances[0]?.getActiveRoutine.mockReturnValue({
			routineId: "routine-1",
			runId: "run-1",
		});
		mockInstances[0]?.getStatus.mockReturnValue({
			state: "running",
			model: "claude-test",
		});
		expect(pool.getSessionsStatus()[0]?.attention).toMatchObject({
			bucket: "working",
			reason: "routine_running",
		});
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

	it("projects pin, fork, and delegation provenance without changing attention", () => {
		const pool = makePool();
		pool.create("/code/proj", "Agent");
		mockInstances[0]?.getSessionPresentation.mockReturnValue({
			pinned: true,
			forkParentSessionId: "source",
			forkParentLabel: "Original",
			forkKind: "exact",
			delegationParentSessionId: "delegator",
			delegationParentLabel: "Parent task",
			delegationParentTurnId: "turn-1",
			delegationDepth: 1,
		});

		const [status] = pool.getSessionsStatus();
		expect(status).toMatchObject({
			pinned: true,
			fork_parent_session_id: "source",
			fork_parent_label: "Original",
			fork_kind: "exact",
			delegation_parent_session_id: "delegator",
			delegation_parent_label: "Parent task",
			delegation_parent_turn_id: "turn-1",
			delegation_depth: 1,
			attention: { bucket: "recent", reason: "ready" },
		});
	});

	it("rolls live descendant attention through bounded delegation lineage", () => {
		const pool = makePool();
		pool.create("/code/proj", "Root");
		pool.create("/code/proj", "Child");
		pool.create("/code/proj", "Grandchild");
		mockInstances[0]?.getCurrentSessionId.mockReturnValue("root-db");
		mockInstances[1]?.getCurrentSessionId.mockReturnValue("child-db");
		mockInstances[2]?.getCurrentSessionId.mockReturnValue("grandchild-db");
		mockInstances[1]?.getStatus.mockReturnValue({
			state: "running",
			model: "claude-test",
			effort: "medium",
			permission_mode: "default",
		});
		mockInstances[1]?.getSessionPresentation.mockReturnValue({
			pinned: false,
			forkParentSessionId: null,
			forkParentLabel: null,
			forkKind: null,
			delegationParentSessionId: "root-db",
			delegationParentLabel: "Root",
			delegationParentTurnId: "turn-root",
			delegationDepth: 1,
		});
		mockInstances[2]?.getPendingPermissionRequests.mockReturnValue([
			{ id: "permission-1" },
		]);
		mockInstances[2]?.getSessionPresentation.mockReturnValue({
			pinned: false,
			forkParentSessionId: null,
			forkParentLabel: null,
			forkKind: null,
			delegationParentSessionId: "child-db",
			delegationParentLabel: "Child",
			delegationParentTurnId: "turn-child",
			delegationDepth: 2,
		});

		const statuses = pool.getSessionsStatus();
		const root = statuses.find((status) => status.db_session_id === "root-db");
		const child = statuses.find(
			(status) => status.db_session_id === "child-db",
		);
		expect(root).toMatchObject({
			attention: {
				bucket: "needs_attention",
				reason: "delegated_child_attention",
			},
			delegated_attention: {
				direct_count: 1,
				descendant_count: 2,
				needs_attention_count: 1,
				working_count: 1,
			},
		});
		expect(child).toMatchObject({
			attention: {
				bucket: "needs_attention",
				reason: "delegated_child_attention",
			},
			delegated_attention: { descendant_count: 1 },
		});
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

	it("reserves a db session before the manager finishes loading it", () => {
		const pool = makePool();
		const entry = pool.create("/a", "A");

		expect(pool.claimDbSessionId(entry, "db-session-a")).toBe(entry);
		expect(pool.findByDbSessionId("db-session-a")).toBe(entry);
		expect(pool.getSessionsStatus()).toEqual([
			expect.objectContaining({
				session_id: entry.sessionId,
				hasDbSession: true,
				db_session_id: "db-session-a",
			}),
		]);
	});

	it("keeps the first owner when another entry claims the same db session", () => {
		const pool = makePool();
		const first = pool.create("/a", "A");
		const second = pool.create("/b", "B");

		expect(pool.claimDbSessionId(first, "shared-db-session")).toBe(first);
		expect(pool.claimDbSessionId(second, "shared-db-session")).toBe(first);
		expect(second.claimedDbSessionId).toBeNull();
	});

	it("replaces a provisional claim with the manager's loaded session", () => {
		const pool = makePool();
		const entry = pool.create("/a", "A");
		pool.claimDbSessionId(entry, "provisional-session");
		mockInstances[0]?.getCurrentSessionId.mockReturnValue("loaded-session");

		expect(pool.findByDbSessionId("provisional-session")).toBeUndefined();
		expect(pool.findByDbSessionId("loaded-session")).toBe(entry);
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

describe("SessionPool runtime refresh", () => {
	it("pushes hot config changes into already-open sessions", () => {
		const pool = makePool();
		pool.create("/a", "A");
		pool.create("/b", "B");
		const next = makeConfig("/next", "Next");

		pool.syncConfig(next);

		expect(mockInstances[0]?.syncConfig).toHaveBeenCalledWith(next);
		expect(mockInstances[1]?.syncConfig).toHaveBeenCalledWith(next);
	});

	it("retires removed providers across every live session", async () => {
		const pool = makePool();
		pool.create("/a", "A");
		pool.create("/b", "B");

		await pool.retireProviderSessions(["cliproxy-codex", "cliproxy:codex"]);

		for (const instance of mockInstances) {
			expect(instance.retireProviderSessions).toHaveBeenCalledOnce();
			expect(instance.retireProviderSessions.mock.calls[0]?.[0]).toEqual(
				new Set(["cliproxy-codex", "cliproxy:codex"]),
			);
		}
	});

	it("preserves provider selection while replacing a runtime", async () => {
		const pool = makePool();
		pool.create("/a", "A");

		await pool.retireProviderSessions(["acp:opencode"], {
			preserveSelection: true,
		});

		expect(mockInstances[0]?.retireProviderSessions).toHaveBeenCalledWith(
			new Set(["acp:opencode"]),
			{ preserveSelection: true },
		);
	});
});
