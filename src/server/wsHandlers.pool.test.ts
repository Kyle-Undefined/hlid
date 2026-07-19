/**
 * wsHandlers multi-session routing tests (TDD).
 * Tests pool-based createWsHandlers(pool: SessionPool) signature.
 * These tests are written FIRST and initially fail; implementation comes after.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionManager } from "./session";
import type { PoolEntry, SessionPool } from "./sessionPool";

// ── mocks ─────────────────────────────────────────────────────────────────────

const {
	wsState,
	mockSend,
	mockBroadcast,
	mockLoadConfig,
	mockGetSessionSelection,
} = vi.hoisted(() => ({
	wsState: {
		clients: new Set<object>(),
	},
	mockSend: vi.fn(),
	mockBroadcast: vi.fn(),
	mockGetSessionSelection: vi.fn().mockResolvedValue(null),
	mockLoadConfig: vi.fn().mockReturnValue({
		vault: { path: "/tmp/test", name: "Test Vault" },
		claude: {
			model: "test-model",
			effort: "medium",
			permission_mode: "default",
			turn_recaps: false,
		},
		agents: [],
	}),
}));

vi.mock("../db", () => ({
	recordPermissionEvent: vi.fn().mockResolvedValue(undefined),
	appendLog: vi.fn().mockResolvedValue(undefined),
	saveSetting: vi.fn().mockResolvedValue(undefined),
	setAskUserQuestionResolution: vi.fn().mockResolvedValue(undefined),
	getSessionSelection: mockGetSessionSelection,
}));

vi.mock("./config", () => ({ loadConfig: mockLoadConfig }));

vi.mock("./runState", () => ({
	wsState,
	send: mockSend,
	broadcast: mockBroadcast,
}));

// ── import after mocks ────────────────────────────────────────────────────────

import type { WsData } from "./wsHandlers";
import { createWsHandlers } from "./wsHandlers";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeManager(
	overrides: Partial<SessionManager> = {},
): SessionManager & {
	getStatus: ReturnType<typeof vi.fn>;
	isRunning: ReturnType<typeof vi.fn>;
	abort: ReturnType<typeof vi.fn>;
	skipSleep: ReturnType<typeof vi.fn>;
	getSleepState: ReturnType<typeof vi.fn>;
	clearHistory: ReturnType<typeof vi.fn>;
	runQuery: ReturnType<typeof vi.fn>;
	getPendingPermissionRequests: ReturnType<typeof vi.fn>;
	getPendingAskUserQuestions: ReturnType<typeof vi.fn>;
	getPendingPlanModeExits: ReturnType<typeof vi.fn>;
	getLastMcpStatus: ReturnType<typeof vi.fn>;
	syncConfig: ReturnType<typeof vi.fn>;
	reinitialize: ReturnType<typeof vi.fn>;
	getQueueState: ReturnType<typeof vi.fn>;
	getCurrentSessionId: ReturnType<typeof vi.fn>;
	handlePermissionResponse: ReturnType<typeof vi.fn>;
	handleAskUserQuestionResponse: ReturnType<typeof vi.fn>;
	handlePlanModeExitResponse: ReturnType<typeof vi.fn>;
	probeMcpStatus: ReturnType<typeof vi.fn>;
} {
	return {
		getStatus: vi.fn().mockReturnValue({ state: "idle", model: "test-model" }),
		isRunning: vi.fn().mockReturnValue(false),
		getLastMcpStatus: vi.fn().mockReturnValue(null),
		getAgentCwd: vi.fn().mockReturnValue(undefined),
		getProviderId: vi.fn().mockReturnValue("claude"),
		getPendingPermissionRequests: vi.fn().mockReturnValue([]),
		getPendingAskUserQuestions: vi.fn().mockReturnValue([]),
		getPendingPlanModeExits: vi.fn().mockReturnValue([]),
		getCurrentSessionId: vi.fn().mockReturnValue("mock-db-session"),
		abort: vi.fn(),
		skipSleep: vi.fn(),
		getSleepState: vi.fn().mockReturnValue(null),
		clearHistory: vi.fn(),
		reinitialize: vi.fn(),
		syncConfig: vi.fn().mockReturnValue(false),
		runQuery: vi.fn().mockResolvedValue(undefined),
		cancelQueued: vi.fn().mockReturnValue(false),
		promoteQueued: vi.fn().mockReturnValue(false),
		getQueueState: vi
			.fn()
			.mockReturnValue({ pending_turn_ids: [], running_turn_id: null }),
		handlePermissionResponse: vi.fn(),
		handleAskUserQuestionResponse: vi.fn(),
		handlePlanModeExitResponse: vi.fn(),
		probeMcpStatus: vi.fn().mockResolvedValue(undefined),
		restoreMcpStatus: vi.fn(),
		...overrides,
	} as unknown as ReturnType<typeof makeManager>;
}

function makeRunState(sessionId = "vault-id") {
	return {
		sessionId,
		addSubscriber: vi.fn(),
		removeSubscriber: vi.fn(),
		getSubscriberCount: vi.fn().mockReturnValue(0),
		broadcast: vi.fn(),
		send: vi.fn(),
		getReplayBuffer: vi.fn().mockReturnValue([]),
		clearError: vi.fn(),
		lastError: null as string | null,
		ownerWs: null as object | null,
		inFlightChatCount: new Map<object, number>(),
	};
}

type MockRunState = ReturnType<typeof makeRunState>;

function makeEntry(
	sessionId = "vault-id",
	overrides: Partial<
		Omit<PoolEntry, "manager" | "runState"> & {
			manager?: Partial<SessionManager>;
		}
	> = {},
): PoolEntry & {
	manager: ReturnType<typeof makeManager>;
	runState: MockRunState;
} {
	const entry = {
		sessionId,
		agentCwd: "/tmp/test",
		agentName: "Test Vault",
		manager: makeManager(overrides.manager ?? {}),
		runState: makeRunState(sessionId),
		...overrides,
	};
	return entry as never;
}

function makePool(vaultEntry?: ReturnType<typeof makeEntry>): SessionPool & {
	vaultEntry: ReturnType<typeof vi.fn>;
	vaultSessionId: ReturnType<typeof vi.fn>;
	get: ReturnType<typeof vi.fn>;
	create: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
	getSessionsStatus: ReturnType<typeof vi.fn>;
	getAllEntries: ReturnType<typeof vi.fn>;
	syncConfig: ReturnType<typeof vi.fn>;
	getSize: ReturnType<typeof vi.fn>;
	findByDbSessionId: ReturnType<typeof vi.fn>;
	isVaultSession: ReturnType<typeof vi.fn>;
} {
	const vault = vaultEntry ?? makeEntry("vault-id");
	return {
		vaultEntry: vi.fn().mockReturnValue(vault),
		vaultSessionId: vi.fn().mockReturnValue(vault.sessionId),
		get: vi.fn((id: string) => (id === vault.sessionId ? vault : undefined)),
		create: vi.fn(),
		close: vi.fn(),
		getSessionsStatus: vi.fn().mockReturnValue([]),
		getAllEntries: vi.fn().mockReturnValue([][Symbol.iterator]()),
		syncConfig: vi.fn(),
		getSize: vi.fn().mockReturnValue(1),
		findByDbSessionId: vi.fn().mockReturnValue(undefined),
		isVaultSession: vi.fn().mockReturnValue(false),
	} as unknown as ReturnType<typeof makePool>;
}

/** Fake WS with per-ws data (matches Bun ServerWebSocket<WsData>). */
function makeWs(subscribedSessionId = "vault-id") {
	return {
		send: vi.fn(),
		data: { subscribedSessionId } as WsData,
	};
}

beforeEach(() => {
	wsState.clients.clear();
	mockSend.mockClear();
	mockBroadcast.mockClear();
});

// ── open ──────────────────────────────────────────────────────────────────────

describe("open (pool)", () => {
	it("adds ws to wsState.clients", () => {
		const pool = makePool();
		const { open } = createWsHandlers(pool);
		const ws = makeWs();
		open(ws as never);
		expect(wsState.clients.has(ws)).toBe(true);
	});

	it("subscribes ws to vault runState", () => {
		const vault = makeEntry("vault-id");
		const pool = makePool(vault);
		const { open } = createWsHandlers(pool);
		const ws = makeWs();
		open(ws as never);
		expect(vault.runState.addSubscriber).toHaveBeenCalledWith(ws);
	});

	it("sets ws.data.subscribedSessionId to vault sessionId", () => {
		const pool = makePool();
		const { open } = createWsHandlers(pool);
		const ws = makeWs(""); // empty initially
		open(ws as never);
		expect(ws.data.subscribedSessionId).toBe("vault-id");
	});

	it("sends sessions_status on connect", () => {
		const pool = makePool();
		pool.getSessionsStatus.mockReturnValue([
			{
				session_id: "vault-id",
				state: "idle",
				model: "m",
				agent_cwd: "/t",
				agent_name: "Vault",
				hasPendingPermissions: false,
			},
		]);
		const { open } = createWsHandlers(pool);
		const ws = makeWs();
		open(ws as never);
		const calls = mockSend.mock.calls.filter((c) => c[0] === ws);
		expect(calls.some((c) => c[1].type === "sessions_status")).toBe(true);
	});

	it("sends vault session status on connect", () => {
		const vault = makeEntry("vault-id");
		vault.manager.getStatus.mockReturnValue({
			state: "idle",
			model: "test-model",
		});
		const pool = makePool(vault);
		const { open } = createWsHandlers(pool);
		const ws = makeWs();
		open(ws as never);
		const calls = mockSend.mock.calls.filter((c) => c[0] === ws);
		expect(calls.some((c) => c[1].type === "status")).toBe(true);
	});

	it("replays vault runState buffer when session is running", () => {
		const vault = makeEntry("vault-id");
		vault.manager.isRunning.mockReturnValue(true);
		vault.runState.getReplayBuffer.mockReturnValue([
			{ type: "chunk", text: "hello" },
		]);
		const pool = makePool(vault);
		const { open } = createWsHandlers(pool);
		const ws = makeWs();
		open(ws as never);
		const calls = mockSend.mock.calls.filter((c) => c[0] === ws);
		expect(calls.some((c) => c[1].type === "chunk")).toBe(true);
	});

	it("claims ownership and replays pending permission requests when no owner", () => {
		const vault = makeEntry("vault-id");
		vault.manager.isRunning.mockReturnValue(true);
		vault.manager.getPendingPermissionRequests.mockReturnValue([
			{ type: "permission_request", id: "p1", toolName: "Bash", title: "Run?" },
		]);
		const pool = makePool(vault);
		const { open } = createWsHandlers(pool);
		const ws = makeWs();
		open(ws as never);
		expect(vault.runState.ownerWs).toBe(ws);
		const calls = mockSend.mock.calls.filter((c) => c[0] === ws);
		expect(calls.some((c) => c[1].type === "permission_request")).toBe(true);
	});

	it("does NOT claim ownership when runState already has an owner", () => {
		const vault = makeEntry("vault-id");
		vault.manager.isRunning.mockReturnValue(true);
		const existingOwner = makeWs();
		vault.runState.ownerWs = existingOwner as never;
		const pool = makePool(vault);
		const { open } = createWsHandlers(pool);
		const ws = makeWs();
		open(ws as never);
		expect(vault.runState.ownerWs).toBe(existingOwner);
	});

	it("sends queue_state on connect", () => {
		const vault = makeEntry("vault-id");
		vault.manager.getQueueState.mockReturnValue({
			pending_turn_ids: ["t1"],
			running_turn_id: null,
		});
		const pool = makePool(vault);
		const { open } = createWsHandlers(pool);
		const ws = makeWs();
		open(ws as never);
		const calls = mockSend.mock.calls.filter((c) => c[0] === ws);
		expect(calls.find((c) => c[1].type === "queue_state")?.[1]).toEqual({
			type: "queue_state",
			session_id: "mock-db-session",
			pending_turn_ids: ["t1"],
			running_turn_id: null,
		});
	});
});

// ── close ─────────────────────────────────────────────────────────────────────

describe("close (pool)", () => {
	it("removes ws from wsState.clients", () => {
		const vault = makeEntry("vault-id");
		const pool = makePool(vault);
		const { open, close } = createWsHandlers(pool);
		const ws = makeWs();
		open(ws as never);
		close(ws as never);
		expect(wsState.clients.has(ws)).toBe(false);
	});

	it("calls runState.removeSubscriber for subscribed session", () => {
		const vault = makeEntry("vault-id");
		const pool = makePool(vault);
		pool.get.mockImplementation((id: string) =>
			id === "vault-id" ? vault : undefined,
		);
		const { open, close } = createWsHandlers(pool);
		const ws = makeWs();
		open(ws as never);
		close(ws as never);
		expect(vault.runState.removeSubscriber).toHaveBeenCalledWith(ws);
	});
});

// ── new_session ───────────────────────────────────────────────────────────────

describe("message — new_session", () => {
	it("calls pool.create with provided agent_cwd and agent_name", async () => {
		const vault = makeEntry("vault-id");
		const newEntry = makeEntry("new-session-id");
		newEntry.agentCwd = "/code/proj";
		newEntry.agentName = "My Agent";
		const pool = makePool(vault);
		pool.create.mockReturnValue(newEntry);
		const { message } = createWsHandlers(pool);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({
				type: "new_session",
				agent_cwd: "/code/proj",
				agent_name: "My Agent",
			}),
		);
		expect(pool.create).toHaveBeenCalledWith("/code/proj", "My Agent");
	});

	it("defaults agent_cwd to vault cwd when omitted", async () => {
		const vault = makeEntry("vault-id");
		vault.agentCwd = "/tmp/vault";
		const newEntry = makeEntry("new-id");
		const pool = makePool(vault);
		pool.create.mockReturnValue(newEntry);
		const { message } = createWsHandlers(pool);
		const ws = makeWs();
		await message(ws as never, JSON.stringify({ type: "new_session" }));
		const [cwd] = pool.create.mock.calls[0] as [string, string];
		expect(cwd).toBe("/tmp/vault");
	});

	it("sends session_created to the requesting ws", async () => {
		const vault = makeEntry("vault-id");
		const newEntry = makeEntry("new-session-id");
		newEntry.agentCwd = "/code/proj";
		newEntry.agentName = "My Agent";
		const pool = makePool(vault);
		pool.create.mockReturnValue(newEntry);
		const { message } = createWsHandlers(pool);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({
				type: "new_session",
				agent_cwd: "/code/proj",
				agent_name: "My Agent",
			}),
		);
		const calls = mockSend.mock.calls.filter((c) => c[0] === ws);
		const createdMsg = calls.find((c) => c[1].type === "session_created");
		expect(createdMsg).toBeDefined();
		expect(createdMsg?.[1]).toMatchObject({
			type: "session_created",
			session_id: "new-session-id",
			agent_cwd: "/code/proj",
			agent_name: "My Agent",
		});
	});

	it("broadcasts sessions_status to all clients after create", async () => {
		const vault = makeEntry("vault-id");
		const newEntry = makeEntry("new-session-id");
		const pool = makePool(vault);
		pool.create.mockReturnValue(newEntry);
		const { message } = createWsHandlers(pool);
		const ws = makeWs();
		await message(ws as never, JSON.stringify({ type: "new_session" }));
		expect(mockBroadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "sessions_status" }),
		);
	});
});

// ── subscribe_session ─────────────────────────────────────────────────────────

describe("message — subscribe_session", () => {
	it("removes ws from old session's runState", async () => {
		const vault = makeEntry("vault-id");
		const other = makeEntry("other-id");
		const pool = makePool(vault);
		pool.get.mockImplementation((id: string) => {
			if (id === "vault-id") return vault;
			if (id === "other-id") return other;
			return undefined;
		});
		const { message } = createWsHandlers(pool);
		const ws = makeWs("vault-id");
		await message(
			ws as never,
			JSON.stringify({ type: "subscribe_session", session_id: "other-id" }),
		);
		expect(vault.runState.removeSubscriber).toHaveBeenCalledWith(ws);
	});

	it("adds ws to new session's runState", async () => {
		const vault = makeEntry("vault-id");
		const other = makeEntry("other-id");
		const pool = makePool(vault);
		pool.get.mockImplementation((id: string) => {
			if (id === "vault-id") return vault;
			if (id === "other-id") return other;
			return undefined;
		});
		const { message } = createWsHandlers(pool);
		const ws = makeWs("vault-id");
		await message(
			ws as never,
			JSON.stringify({ type: "subscribe_session", session_id: "other-id" }),
		);
		expect(other.runState.addSubscriber).toHaveBeenCalledWith(ws);
	});

	it("updates ws.data.subscribedSessionId", async () => {
		const vault = makeEntry("vault-id");
		const other = makeEntry("other-id");
		const pool = makePool(vault);
		pool.get.mockImplementation((id: string) => {
			if (id === "vault-id") return vault;
			if (id === "other-id") return other;
			return undefined;
		});
		const { message } = createWsHandlers(pool);
		const ws = makeWs("vault-id");
		await message(
			ws as never,
			JSON.stringify({ type: "subscribe_session", session_id: "other-id" }),
		);
		expect(ws.data.subscribedSessionId).toBe("other-id");
	});

	it("sends status of the new session to the ws", async () => {
		const vault = makeEntry("vault-id");
		const other = makeEntry("other-id");
		other.manager.getStatus.mockReturnValue({
			state: "running",
			model: "model-x",
		});
		const pool = makePool(vault);
		pool.get.mockImplementation((id: string) => {
			if (id === "vault-id") return vault;
			if (id === "other-id") return other;
			return undefined;
		});
		const { message } = createWsHandlers(pool);
		const ws = makeWs("vault-id");
		await message(
			ws as never,
			JSON.stringify({ type: "subscribe_session", session_id: "other-id" }),
		);
		const calls = mockSend.mock.calls.filter((c) => c[0] === ws);
		const statusMsg = calls.find((c) => c[1].type === "status");
		expect(statusMsg).toBeDefined();
		expect(statusMsg?.[1]).toMatchObject({
			state: "running",
			model: "model-x",
		});
	});

	it("replays new session's buffer when session is running", async () => {
		const vault = makeEntry("vault-id");
		const other = makeEntry("other-id");
		other.manager.isRunning.mockReturnValue(true);
		other.runState.getReplayBuffer.mockReturnValue([
			{ type: "chunk", text: "in-flight" },
		]);
		const pool = makePool(vault);
		pool.get.mockImplementation((id: string) => {
			if (id === "vault-id") return vault;
			if (id === "other-id") return other;
			return undefined;
		});
		const { message } = createWsHandlers(pool);
		const ws = makeWs("vault-id");
		await message(
			ws as never,
			JSON.stringify({ type: "subscribe_session", session_id: "other-id" }),
		);
		const calls = mockSend.mock.calls.filter((c) => c[0] === ws);
		expect(calls.some((c) => c[1].type === "chunk")).toBe(true);
	});

	it("replays pending questions and plans when another device owns the run", async () => {
		const vault = makeEntry("vault-id");
		const other = makeEntry("other-id");
		other.manager.isRunning.mockReturnValue(true);
		other.manager.getPendingAskUserQuestions.mockReturnValue([
			{
				type: "ask_user_question",
				id: "question-1",
				questions: [
					{ question: "Which scope?", options: ["A", "B"], multiSelect: false },
				],
			},
		]);
		other.manager.getPendingPlanModeExits.mockReturnValue([
			{ type: "plan_mode_exit", id: "plan-1", input: { plan: "The plan" } },
		]);
		other.runState.ownerWs = makeWs("other-id") as never;
		const pool = makePool(vault);
		pool.get.mockImplementation((id: string) => {
			if (id === "vault-id") return vault;
			if (id === "other-id") return other;
			return undefined;
		});
		const { message } = createWsHandlers(pool);
		const ws = makeWs("vault-id");

		await message(
			ws as never,
			JSON.stringify({ type: "subscribe_session", session_id: "other-id" }),
		);

		const types = mockSend.mock.calls
			.filter((call) => call[0] === ws)
			.map((call) => call[1].type);
		expect(types).toContain("ask_user_question");
		expect(types).toContain("plan_mode_exit");
	});

	it("replays auto-sleep state when switching to a sleeping live session", async () => {
		const vault = makeEntry("vault-id");
		const other = makeEntry("other-id");
		other.manager.getSleepState.mockReturnValue({
			type: "agent_sleep",
			state: "sleeping",
			providerId: "claude",
			windowId: "five_hour",
			until: 1_784_060_475,
			reason: "threshold",
			utilization: 0.94,
		});
		const pool = makePool(vault);
		pool.get.mockImplementation((id: string) => {
			if (id === "vault-id") return vault;
			if (id === "other-id") return other;
			return undefined;
		});
		const { message } = createWsHandlers(pool);
		const ws = makeWs("vault-id");

		await message(
			ws as never,
			JSON.stringify({ type: "subscribe_session", session_id: "other-id" }),
		);

		expect(mockSend).toHaveBeenCalledWith(
			ws,
			expect.objectContaining({
				type: "agent_sleep",
				state: "sleeping",
				providerId: "claude",
				utilization: 0.94,
			}),
		);
	});

	it("resolves a database session id to its live pool entry", async () => {
		const vault = makeEntry("vault-id");
		const other = makeEntry("other-id");
		const pool = makePool(vault);
		pool.get.mockImplementation((id: string) =>
			id === "vault-id" ? vault : undefined,
		);
		pool.findByDbSessionId.mockReturnValue(other);
		const { message } = createWsHandlers(pool);
		const ws = makeWs("vault-id");
		await message(
			ws as never,
			JSON.stringify({ type: "subscribe_session", session_id: "db-id" }),
		);
		expect(other.runState.addSubscriber).toHaveBeenCalledWith(ws);
		expect(ws.data.subscribedSessionId).toBe("other-id");
	});

	it("detaches from live sessions when session_id is not found", async () => {
		const vault = makeEntry("vault-id");
		const pool = makePool(vault);
		pool.get.mockReturnValue(undefined);
		const { message } = createWsHandlers(pool);
		const ws = makeWs("vault-id");
		await message(
			ws as never,
			JSON.stringify({ type: "subscribe_session", session_id: "ghost-id" }),
		);
		expect(vault.runState.addSubscriber).not.toHaveBeenCalled();
		expect(ws.data.subscribedSessionId).toBe("ghost-id");
		expect(mockSend).toHaveBeenCalledWith(
			ws,
			expect.objectContaining({ type: "status", state: "idle" }),
		);
	});

	it("uses the archived Einherjar controls instead of vault defaults", async () => {
		const vault = makeEntry("vault-id");
		vault.manager.getStatus.mockReturnValue({
			state: "idle",
			model: "vault-model",
			effort: "medium",
			permission_mode: "default",
		});
		const pool = makePool(vault);
		pool.get.mockReturnValue(undefined);
		mockGetSessionSelection.mockResolvedValueOnce({
			agentCwd: "/tmp",
			providerId: "codex",
			model: "gpt-session",
			effort: null,
			permissionMode: null,
		});
		mockLoadConfig.mockReturnValueOnce({
			vault: { path: "/tmp/test", name: "Test Vault" },
			vault_provider: "codex",
			codex: {
				model: "vault-model",
				effort: "medium",
				permission_mode: "default",
				turn_recaps: false,
			},
			claude: {
				model: "claude-model",
				effort: "medium",
				permission_mode: "default",
				turn_recaps: false,
			},
			agents: [
				{
					path: "/tmp",
					provider: "codex",
					model: "gpt-agent",
					effort: "high",
					permission_mode: "bypassPermissions",
				},
			],
		});
		const { message } = createWsHandlers(pool);
		const ws = makeWs("vault-id");

		await message(
			ws as never,
			JSON.stringify({
				type: "subscribe_session",
				session_id: "archived-einherjar",
			}),
		);

		expect(mockSend).toHaveBeenCalledWith(ws, {
			type: "status",
			state: "idle",
			model: "gpt-session",
			effort: "high",
			permission_mode: "bypassPermissions",
		});
	});

	it("keeps an archived session idle when history loading sends sync", async () => {
		const vault = makeEntry("vault-id");
		vault.manager.getStatus.mockReturnValue({
			state: "running",
			model: "vault-model",
			effort: "high",
			permission_mode: "bypassPermissions",
		});
		const pool = makePool(vault);
		pool.get.mockImplementation((id: string) =>
			id === "vault-id" ? vault : undefined,
		);
		mockGetSessionSelection.mockResolvedValueOnce({
			agentCwd: "/tmp",
			providerId: "codex",
			model: "archived-model",
			effort: "medium",
			permissionMode: "default",
		});
		const { message } = createWsHandlers(pool);
		const ws = makeWs("archived-db-id");

		await message(ws as never, JSON.stringify({ type: "sync" }));

		expect(mockSend).toHaveBeenCalledWith(ws, {
			type: "status",
			state: "idle",
			model: "archived-model",
			effort: "medium",
			permission_mode: "default",
		});
		expect(vault.manager.getQueueState).not.toHaveBeenCalled();
	});
});

// ── stop_session ──────────────────────────────────────────────────────────────

describe("message — stop_session", () => {
	it("calls manager.abort() on the target session", async () => {
		const vault = makeEntry("vault-id");
		const target = makeEntry("target-id");
		const pool = makePool(vault);
		pool.get.mockImplementation((id: string) =>
			id === "target-id" ? target : undefined,
		);
		const { message } = createWsHandlers(pool);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({ type: "stop_session", session_id: "target-id" }),
		);
		expect(target.manager.abort).toHaveBeenCalled();
	});

	it("is a no-op when session_id not found", async () => {
		const pool = makePool();
		pool.get.mockReturnValue(undefined);
		const { message } = createWsHandlers(pool);
		const ws = makeWs();
		await expect(
			message(
				ws as never,
				JSON.stringify({ type: "stop_session", session_id: "ghost" }),
			),
		).resolves.not.toThrow();
	});
});

// ── close_session ─────────────────────────────────────────────────────────────

describe("message — close_session", () => {
	it("closes project shells keyed by either pool or database session id", async () => {
		const vault = makeEntry("vault-id");
		const sessionEntry = makeEntry("session-abc");
		sessionEntry.manager.getCurrentSessionId.mockReturnValue("db-session-abc");
		const pool = makePool(vault);
		pool.get.mockImplementation((id: string) => {
			if (id === vault.sessionId) return vault;
			if (id === "session-abc") return sessionEntry;
			return undefined;
		});
		const shellPool = { close: vi.fn() };
		const { message } = createWsHandlers(pool, undefined, shellPool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({ type: "close_session", session_id: "session-abc" }),
		);

		expect(shellPool.close).toHaveBeenCalledWith("session-abc");
		expect(shellPool.close).toHaveBeenCalledWith("db-session-abc");
	});

	it("calls pool.close() with the session_id", async () => {
		const vault = makeEntry("vault-id");
		const sessionEntry = makeEntry("session-abc");
		const pool = makePool(vault);
		// Register session-abc as a known SDK session.
		pool.get.mockImplementation((id: string) => {
			if (id === vault.sessionId) return vault;
			if (id === "session-abc") return sessionEntry;
			return undefined;
		});
		const { message } = createWsHandlers(pool);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({ type: "close_session", session_id: "session-abc" }),
		);
		expect(pool.close).toHaveBeenCalledWith("session-abc");
	});

	it("broadcasts session_closed", async () => {
		const vault = makeEntry("vault-id");
		const pool = makePool(vault);
		const { message } = createWsHandlers(pool);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({ type: "close_session", session_id: "session-abc" }),
		);
		expect(mockBroadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "session_closed",
				session_id: "session-abc",
			}),
		);
	});

	it("broadcasts sessions_status after close", async () => {
		const vault = makeEntry("vault-id");
		const pool = makePool(vault);
		const { message } = createWsHandlers(pool);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({ type: "close_session", session_id: "session-abc" }),
		);
		expect(mockBroadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "sessions_status" }),
		);
	});

	it("re-subscribes ws to vault when ws was watching the closed session", async () => {
		const vault = makeEntry("vault-id");
		const sessionEntry = makeEntry("session-abc");
		const pool = makePool(vault);
		// Register session-abc as a known SDK session.
		pool.get.mockImplementation((id: string) => {
			if (id === vault.sessionId) return vault;
			if (id === "session-abc") return sessionEntry;
			return undefined;
		});
		const ws = makeWs("session-abc");
		wsState.clients.add(ws);
		const { message } = createWsHandlers(pool);
		await message(
			ws as never,
			JSON.stringify({ type: "close_session", session_id: "session-abc" }),
		);
		expect(vault.runState.addSubscriber).toHaveBeenCalledWith(ws);
		expect(ws.data.subscribedSessionId).toBe("vault-id");
	});

	it("does NOT re-subscribe ws that was watching a different session", async () => {
		const vault = makeEntry("vault-id");
		const pool = makePool(vault);
		const ws = makeWs("other-session");
		wsState.clients.add(ws);
		vault.runState.addSubscriber.mockClear();
		const { message } = createWsHandlers(pool);
		await message(
			ws as never,
			JSON.stringify({ type: "close_session", session_id: "session-abc" }),
		);
		expect(vault.runState.addSubscriber).not.toHaveBeenCalled();
	});
});

// ── chat routing via subscribed session ───────────────────────────────────────

describe("message — chat routing (pool)", () => {
	it("routes chat to subscribed session's manager.runQuery", async () => {
		const vault = makeEntry("vault-id");
		const other = makeEntry("other-id");
		other.agentCwd = "/other/path";
		const pool = makePool(vault);
		pool.get.mockImplementation((id: string) => {
			if (id === "vault-id") return vault;
			if (id === "other-id") return other;
			return undefined;
		});
		const { message } = createWsHandlers(pool);
		const ws = makeWs("other-id"); // subscribed to other session
		await message(ws as never, JSON.stringify({ type: "chat", text: "hello" }));
		expect(other.manager.runQuery).toHaveBeenCalled();
		expect(vault.manager.runQuery).not.toHaveBeenCalled();
	});

	it("uses entry.runState.broadcast for per-session events (not global broadcast)", async () => {
		const vault = makeEntry("vault-id");
		vault.manager.runQuery.mockImplementation(
			async (
				_text: string,
				onEvent: (e: { type: string; text?: string }) => Promise<void>,
			) => {
				await onEvent({ type: "chunk", text: "response" });
			},
		);
		const pool = makePool(vault);
		pool.get.mockImplementation((id: string) =>
			id === "vault-id" ? vault : undefined,
		);
		const { message } = createWsHandlers(pool);
		const ws = makeWs("vault-id");
		await message(ws as never, JSON.stringify({ type: "chat", text: "hi" }));
		expect(vault.runState.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "chunk" }),
		);
		// Global broadcast should NOT be called for per-session chunk events
		const chunkGlobalBroadcasts = mockBroadcast.mock.calls.filter(
			(c) => c[0]?.type === "chunk",
		);
		expect(chunkGlobalBroadcasts).toHaveLength(0);
	});

	it("falls back to vault when subscribed session not found", async () => {
		const vault = makeEntry("vault-id");
		const pool = makePool(vault);
		pool.get.mockReturnValue(undefined);
		const { message } = createWsHandlers(pool);
		const ws = makeWs("dead-session");
		await message(ws as never, JSON.stringify({ type: "chat", text: "hi" }));
		expect(vault.manager.runQuery).toHaveBeenCalled();
	});

	it("tracks ownership in entry.runState.ownerWs (not global wsState)", async () => {
		const vault = makeEntry("vault-id");
		const pool = makePool(vault);
		pool.get.mockImplementation((id: string) =>
			id === "vault-id" ? vault : undefined,
		);
		const { message } = createWsHandlers(pool);
		const ws = makeWs("vault-id");
		// runQuery hangs until resolved
		let resolve!: () => void;
		vault.manager.runQuery.mockReturnValue(
			new Promise<void>((r) => {
				resolve = r;
			}),
		);
		const p = message(
			ws as never,
			JSON.stringify({ type: "chat", text: "hi" }),
		);
		// Ownership claimed on this session's runState
		expect(vault.runState.ownerWs).toBe(ws);
		resolve();
		await p;
	});

	it("rejects empty chat text", async () => {
		const vault = makeEntry("vault-id");
		const pool = makePool(vault);
		pool.get.mockImplementation((id: string) =>
			id === "vault-id" ? vault : undefined,
		);
		const { message } = createWsHandlers(pool);
		const ws = makeWs("vault-id");
		await message(ws as never, JSON.stringify({ type: "chat", text: "   " }));
		const calls = mockSend.mock.calls.filter((c) => c[0] === ws);
		expect(calls.some((c) => c[1].type === "error")).toBe(true);
		expect(vault.manager.runQuery).not.toHaveBeenCalled();
	});

	it("auto-creates new pool session when current session is idle with no DB session", async () => {
		const vault = makeEntry("vault-id");
		// Simulate a fresh session: isRunning=false, getCurrentSessionId=null
		vault.manager.isRunning.mockReturnValue(false);
		vault.manager.getCurrentSessionId.mockReturnValue(null);
		const newEntry = makeEntry("new-session-id");
		const pool = makePool(vault);
		pool.get.mockImplementation((id: string) =>
			id === "vault-id" ? vault : undefined,
		);
		pool.create.mockReturnValue(newEntry);
		const { message } = createWsHandlers(pool);
		const ws = makeWs("vault-id");
		wsState.clients.add(ws as never);
		await message(ws as never, JSON.stringify({ type: "chat", text: "hello" }));
		// Should have created a new pool session
		expect(pool.create).toHaveBeenCalled();
		// ws should now be subscribed to the new session
		expect(ws.data.subscribedSessionId).toBe("new-session-id");
		// runQuery routed to the new session
		expect(newEntry.manager.runQuery).toHaveBeenCalledWith(
			"hello",
			expect.any(Function),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		);
		expect(vault.manager.runQuery).not.toHaveBeenCalled();
		// sessions_status broadcast after create
		const statusBroadcasts = mockBroadcast.mock.calls.filter(
			(c) => c[0]?.type === "sessions_status",
		);
		expect(statusBroadcasts.length).toBeGreaterThan(0);
	});

	it("continues in existing session when current session has DB history (follow-up message)", async () => {
		const vault = makeEntry("vault-id");
		// Simulate ongoing conversation: getCurrentSessionId returns a DB ID
		vault.manager.isRunning.mockReturnValue(false);
		vault.manager.getCurrentSessionId.mockReturnValue("existing-db-id");
		const pool = makePool(vault);
		pool.get.mockImplementation((id: string) =>
			id === "vault-id" ? vault : undefined,
		);
		const { message } = createWsHandlers(pool);
		const ws = makeWs("vault-id");
		await message(
			ws as never,
			JSON.stringify({ type: "chat", text: "follow-up" }),
		);
		// Should NOT create a new pool session
		expect(pool.create).not.toHaveBeenCalled();
		// Should route to existing vault session
		expect(vault.manager.runQuery).toHaveBeenCalled();
	});
});

// ── abort routes to subscribed session ───────────────────────────────────────

describe("message — abort (pool)", () => {
	it("calls abort on the subscribed session's manager", async () => {
		const vault = makeEntry("vault-id");
		const other = makeEntry("other-id");
		const pool = makePool(vault);
		pool.get.mockImplementation((id: string) => {
			if (id === "vault-id") return vault;
			if (id === "other-id") return other;
			return undefined;
		});
		const { message } = createWsHandlers(pool);
		const ws = makeWs("other-id");
		await message(ws as never, JSON.stringify({ type: "abort" }));
		expect(other.manager.abort).toHaveBeenCalled();
		expect(vault.manager.abort).not.toHaveBeenCalled();
	});
});

// ── clear routes to subscribed session ───────────────────────────────────────

describe("message — clear (pool)", () => {
	it("sets pendingNewSession flag without calling clearHistory", async () => {
		const vault = makeEntry("vault-id");
		const other = makeEntry("other-id");
		const pool = makePool(vault);
		pool.get.mockImplementation((id: string) => {
			if (id === "vault-id") return vault;
			if (id === "other-id") return other;
			return undefined;
		});
		const { message } = createWsHandlers(pool);
		const ws = makeWs("other-id");
		await message(ws as never, JSON.stringify({ type: "clear" }));
		// clearHistory must NOT be called — the existing subprocess stays alive
		expect(other.manager.clearHistory).not.toHaveBeenCalled();
		expect(vault.manager.clearHistory).not.toHaveBeenCalled();
		// pendingNewSession flag must be set so the next chat spawns a fresh entry
		expect(ws.data.pendingNewSession).toBe(true);
	});

	it("clears lastError on subscribed session's runState", async () => {
		const vault = makeEntry("vault-id");
		const pool = makePool(vault);
		pool.get.mockImplementation((id: string) =>
			id === "vault-id" ? vault : undefined,
		);
		vault.runState.lastError = "old error";
		const { message } = createWsHandlers(pool);
		const ws = makeWs("vault-id");
		await message(ws as never, JSON.stringify({ type: "clear" }));
		expect(vault.runState.clearError).toHaveBeenCalled();
	});
});

// ── reload_session routes to subscribed session ───────────────────────────────

describe("message — reload_session (pool)", () => {
	it("reinitializes subscribed session's manager", async () => {
		const vault = makeEntry("vault-id");
		const other = makeEntry("other-id");
		const pool = makePool(vault);
		pool.get.mockImplementation((id: string) => {
			if (id === "vault-id") return vault;
			if (id === "other-id") return other;
			return undefined;
		});
		const { message } = createWsHandlers(pool);
		const ws = makeWs("other-id");
		await message(ws as never, JSON.stringify({ type: "reload_session" }));
		expect(other.manager.reinitialize).toHaveBeenCalled();
		expect(vault.manager.reinitialize).not.toHaveBeenCalled();
	});

	it("syncs config to pool on reload", async () => {
		const vault = makeEntry("vault-id");
		const pool = makePool(vault);
		pool.get.mockImplementation((id: string) =>
			id === "vault-id" ? vault : undefined,
		);
		const { message } = createWsHandlers(pool);
		const ws = makeWs("vault-id");
		await message(ws as never, JSON.stringify({ type: "reload_session" }));
		expect(pool.syncConfig).toHaveBeenCalled();
	});

	it("broadcasts status via subscribed session's runState after reload", async () => {
		const vault = makeEntry("vault-id");
		const pool = makePool(vault);
		pool.get.mockImplementation((id: string) =>
			id === "vault-id" ? vault : undefined,
		);
		const { message } = createWsHandlers(pool);
		const ws = makeWs("vault-id");
		await message(ws as never, JSON.stringify({ type: "reload_session" }));
		expect(vault.runState.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "status" }),
		);
	});
});

// ── pool entry reuse via findByDbSessionId ────────────────────────────────────

/**
 * Bug fix: when a client sends a chat message with a session_id that belongs
 * to a different pool entry (e.g. after back-navigation), the handler must
 * reuse the existing pool entry instead of spawning a new one.
 */
describe("message — chat pool entry reuse", () => {
	it("creates a parallel entry when the subscribed session is running but the chat ID is new", async () => {
		const vault = makeEntry("vault-id");
		vault.manager.getCurrentSessionId.mockReturnValue("running-db-session");
		vault.manager.isRunning.mockReturnValue(true);
		const created = makeEntry("parallel-pool-session");
		const pool = makePool(vault);
		pool.get.mockImplementation((id: string) =>
			id === "vault-id" ? vault : undefined,
		);
		pool.findByDbSessionId.mockReturnValue(undefined);
		pool.create.mockReturnValue(created);
		const { message } = createWsHandlers(pool);
		const ws = makeWs("vault-id");

		await message(
			ws as never,
			JSON.stringify({
				type: "chat",
				text: "start in parallel",
				session_id: "new-db-session",
				agent_cwd: "/other-project",
			}),
		);

		expect(pool.create).toHaveBeenCalledWith(
			"/other-project",
			expect.any(String),
		);
		expect(created.manager.runQuery).toHaveBeenCalled();
		expect(vault.manager.runQuery).not.toHaveBeenCalled();
	});

	it("reuses existing idle pool entry that owns the db session_id", async () => {
		// Entry A owns db_session "abc" but ws is subscribed to entry B (vault).
		const entryA = makeEntry("session-a-id");
		entryA.manager.getCurrentSessionId.mockReturnValue("db-session-abc");
		entryA.manager.isRunning.mockReturnValue(false);

		const vault = makeEntry("vault-id");
		vault.manager.getCurrentSessionId.mockReturnValue(null);

		const pool = makePool(vault);
		pool.get.mockImplementation((id: string) => {
			if (id === "vault-id") return vault;
			if (id === "session-a-id") return entryA;
			return undefined;
		});
		// findByDbSessionId returns entryA for "db-session-abc"
		pool.findByDbSessionId.mockImplementation((dbId: string) =>
			dbId === "db-session-abc" ? entryA : undefined,
		);

		const { message } = createWsHandlers(pool);
		// ws is subscribed to vault (not entryA)
		const ws = makeWs("vault-id");
		wsState.clients.add(ws as never);

		await message(
			ws as never,
			JSON.stringify({
				type: "chat",
				text: "continue",
				session_id: "db-session-abc",
			}),
		);

		// Must NOT create a new pool entry
		expect(pool.create).not.toHaveBeenCalled();
		// Must route to entryA, not vault
		expect(entryA.manager.runQuery).toHaveBeenCalled();
		expect(vault.manager.runQuery).not.toHaveBeenCalled();
		// ws subscription must switch to entryA
		expect(ws.data.subscribedSessionId).toBe("session-a-id");
		expect(vault.runState.removeSubscriber).toHaveBeenCalledWith(ws);
		expect(entryA.runState.addSubscriber).toHaveBeenCalledWith(ws);
	});

	it("reuses running pool entry that owns the db session_id (queues message)", async () => {
		// Entry A is currently running and owns db_session "xyz"
		const entryA = makeEntry("session-a-id");
		entryA.manager.getCurrentSessionId.mockReturnValue("db-session-xyz");
		entryA.manager.isRunning.mockReturnValue(true);

		const vault = makeEntry("vault-id");
		vault.manager.getCurrentSessionId.mockReturnValue(null);

		const pool = makePool(vault);
		pool.get.mockImplementation((id: string) => {
			if (id === "vault-id") return vault;
			if (id === "session-a-id") return entryA;
			return undefined;
		});
		pool.findByDbSessionId.mockImplementation((dbId: string) =>
			dbId === "db-session-xyz" ? entryA : undefined,
		);

		const { message } = createWsHandlers(pool);
		const ws = makeWs("vault-id");
		wsState.clients.add(ws as never);

		await message(
			ws as never,
			JSON.stringify({
				type: "chat",
				text: "follow up while running",
				session_id: "db-session-xyz",
			}),
		);

		// Must NOT create a new pool entry even though isRunning=true
		expect(pool.create).not.toHaveBeenCalled();
		// Must route to entryA
		expect(entryA.manager.runQuery).toHaveBeenCalled();
		expect(vault.manager.runQuery).not.toHaveBeenCalled();
		// ws subscription switches
		expect(ws.data.subscribedSessionId).toBe("session-a-id");
	});

	it("does not switch entry when subscribed session already owns the db session_id", async () => {
		// ws is already subscribed to the correct entry
		const vault = makeEntry("vault-id");
		vault.manager.getCurrentSessionId.mockReturnValue("db-session-vault");
		vault.manager.isRunning.mockReturnValue(false);

		const pool = makePool(vault);
		pool.get.mockImplementation((id: string) =>
			id === "vault-id" ? vault : undefined,
		);
		// findByDbSessionId returns vault itself (same entry)
		pool.findByDbSessionId.mockImplementation((dbId: string) =>
			dbId === "db-session-vault" ? vault : undefined,
		);

		const { message } = createWsHandlers(pool);
		const ws = makeWs("vault-id");
		wsState.clients.add(ws as never);

		await message(
			ws as never,
			JSON.stringify({
				type: "chat",
				text: "continue",
				session_id: "db-session-vault",
			}),
		);

		// No new entry, routes to vault
		expect(pool.create).not.toHaveBeenCalled();
		expect(vault.manager.runQuery).toHaveBeenCalled();
		// Subscription unchanged (still vault)
		expect(ws.data.subscribedSessionId).toBe("vault-id");
		// removeSubscriber should NOT have been called (no switch needed)
		expect(vault.runState.removeSubscriber).not.toHaveBeenCalled();
	});
});
