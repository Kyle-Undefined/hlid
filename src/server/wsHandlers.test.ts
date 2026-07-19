/**
 * wsHandlers unit tests — routes ClientMessages to the correct SessionManager
 * method and enforces ownership semantics. SessionManager, runState, DB, and
 * config are all mocked; only the routing logic inside createWsHandlers is real.
 *
 * Uses a single-session pool wrapper so existing per-session tests work with the
 * new pool-based createWsHandlers(pool) API.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "./protocol";
import type { SessionManager } from "./session";

// ── mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../db", () => ({
	recordPermissionEvent: vi.fn().mockResolvedValue(undefined),
	appendLog: vi.fn().mockResolvedValue(undefined),
	saveSetting: vi.fn().mockResolvedValue(undefined),
	setAskUserQuestionResolution: vi.fn().mockResolvedValue(undefined),
	getSessionSelection: vi.fn().mockResolvedValue(null),
}));

// vi.mock factories are hoisted before module-level code, so vars referenced
// inside them must also be hoisted via vi.hoisted().
const {
	wsState,
	mockSend,
	mockBroadcast,
	mockLoadConfig,
	mockWaitForClaudeWarmupSnapshot,
	mockWaitForAllClaudeWarmupSnapshots,
} = vi.hoisted(() => ({
	wsState: {
		clients: new Set<object>(),
	},
	mockSend: vi.fn(),
	mockBroadcast: vi.fn(),
	mockWaitForClaudeWarmupSnapshot: vi.fn().mockResolvedValue(null),
	mockWaitForAllClaudeWarmupSnapshots: vi.fn().mockResolvedValue([]),
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

vi.mock("./config", () => ({
	loadConfig: mockLoadConfig,
}));

vi.mock("./runState", () => ({
	wsState,
	send: mockSend,
	broadcast: mockBroadcast,
}));

vi.mock("./claudeWarmup", () => ({
	waitForClaudeWarmupSnapshot: mockWaitForClaudeWarmupSnapshot,
	waitForAllClaudeWarmupSnapshots: mockWaitForAllClaudeWarmupSnapshots,
}));

// ── import after mocks ────────────────────────────────────────────────────────

import * as dbMock from "../db";
import { createWsHandlers } from "./wsHandlers";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Create a minimal fake WebSocket with a spy on send() and pool-required data. */
function makeWs(subscribedSessionId = "vault-id") {
	return { send: vi.fn(), data: { subscribedSessionId } };
}

/** Per-session run state mock (mirrors SessionRunState public API). */
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

/** Create a fully mocked SessionManager. */
function makeSession(overrides: Partial<SessionManager> = {}): SessionManager {
	return {
		getStatus: vi.fn().mockReturnValue({ state: "idle", model: "test-model" }),
		isRunning: vi.fn().mockReturnValue(false),
		getLastMcpStatus: vi.fn().mockReturnValue(null),
		getMcpSnapshots: vi.fn().mockReturnValue([]),
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
		probeSlashCommands: vi.fn().mockResolvedValue(undefined),
		restoreMcpStatus: vi.fn(),
		setModel: vi.fn().mockResolvedValue(undefined),
		setProvider: vi.fn().mockResolvedValue(undefined),
		setEffort: vi.fn().mockResolvedValue(undefined),
		setPermissionMode: vi.fn().mockResolvedValue(undefined),
		getAccountInfo: vi.fn().mockResolvedValue(null),
		...overrides,
	} as unknown as SessionManager;
}

/**
 * Wrap a single SessionManager in a minimal pool mock.
 * Returns { pool, entry, runState } so tests can inspect per-session state.
 */
function wrapSession(session: SessionManager) {
	const runState = makeRunState("vault-id");
	const entry = {
		sessionId: "vault-id",
		agentCwd: "/tmp/test",
		agentName: "Test Vault",
		manager: session,
		runState,
	};
	const pool = {
		vaultEntry: vi.fn().mockReturnValue(entry),
		vaultSessionId: vi.fn().mockReturnValue("vault-id"),
		get: vi.fn((id: string) => (id === "vault-id" ? entry : undefined)),
		create: vi.fn().mockReturnValue(entry),
		close: vi.fn(),
		getSessionsStatus: vi.fn().mockReturnValue([]),
		getAllEntries: vi.fn().mockReturnValue([][Symbol.iterator]()),
		syncConfig: vi.fn(),
		getSize: vi.fn().mockReturnValue(1),
		findByDbSessionId: vi.fn().mockReturnValue(undefined),
		isVaultSession: vi.fn().mockReturnValue(false),
	};
	return { pool, entry, runState };
}

/** Capture the most recent arg to mockSend for a given ws. */
function lastSentTo(ws: ReturnType<typeof makeWs>): ServerMessage | undefined {
	const calls = mockSend.mock.calls.filter((c) => c[0] === ws);
	return calls.length > 0 ? calls[calls.length - 1][1] : undefined;
}

beforeEach(() => {
	wsState.clients.clear();
	mockSend.mockClear();
	mockBroadcast.mockClear();
});

describe("message — provider probes", () => {
	it("replies directly when an archived session is detached from the live pool", async () => {
		vi.mocked(dbMock.getSessionSelection).mockResolvedValueOnce({
			agentCwd: "/tmp/test",
			providerId: "claude",
			model: "claude-sonnet-5",
			effort: "high",
			permissionMode: "default",
		});
		const probeMcpStatus = vi.fn(
			async (emit: (message: ServerMessage) => void) => {
				emit({
					type: "mcp_status",
					provider_id: "codex",
					agent_cwd: "/tmp/test",
					session_id: "archived-session",
					servers: [],
				});
			},
		);
		const session = makeSession({ probeMcpStatus });
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs("archived-session");

		await message(
			ws as never,
			JSON.stringify({
				type: "probe_mcp",
				agent_cwd: "/tmp/test",
				session_id: "archived-session",
			}),
		);

		expect(probeMcpStatus).toHaveBeenCalledWith(expect.any(Function), {
			agentCwd: "/tmp/test",
			sessionId: "archived-session",
			providerId: "claude",
		});
		expect(mockSend).toHaveBeenCalledWith(
			ws,
			expect.objectContaining({
				type: "mcp_status",
				session_id: "archived-session",
			}),
		);
		expect(runState.broadcast).not.toHaveBeenCalled();
	});

	it("sends scoped command discovery only to the requesting client", async () => {
		const probeSlashCommands = vi.fn(
			async (emit: (message: ServerMessage) => void) => {
				emit({
					type: "slash_commands",
					provider_id: "codex",
					commands: [
						{ name: "review", description: "Review", argumentHint: "" },
					],
				});
			},
		);
		const session = makeSession({ probeSlashCommands });
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({ type: "probe_slash_commands" }),
		);

		expect(runState.send).toHaveBeenCalledWith(
			ws,
			expect.objectContaining({ type: "slash_commands" }),
		);
		expect(runState.broadcast).not.toHaveBeenCalled();
	});

	it("tags live MCP probe replies with the subscribed pool session", async () => {
		const probeMcpStatus = vi.fn(
			async (emit: (message: ServerMessage) => void) => {
				emit({
					type: "mcp_status",
					provider_id: "claude",
					session_id: "db-session",
					servers: [{ name: "claude.ai Excalidraw", status: "connected" }],
				});
			},
		);
		const session = makeSession({ probeMcpStatus });
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs("vault-id");

		await message(
			ws as never,
			JSON.stringify({
				type: "probe_mcp",
				session_id: "db-session",
			}),
		);

		expect(runState.send).toHaveBeenCalledWith(
			ws,
			expect.objectContaining({
				type: "mcp_status",
				session_id: "db-session",
			}),
		);
		expect(mockSend).not.toHaveBeenCalledWith(
			ws,
			expect.objectContaining({ type: "mcp_status" }),
		);
	});
});

// ── open ──────────────────────────────────────────────────────────────────────

describe("open", () => {
	it("adds ws to clients set", () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { open } = createWsHandlers(pool as never);
		const ws = makeWs();
		open(ws as never);
		expect(wsState.clients.has(ws)).toBe(true);
	});

	it("sends current status to new connection", () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { open } = createWsHandlers(pool as never);
		const ws = makeWs();
		open(ws as never);
		const types = mockSend.mock.calls
			.filter((c) => c[0] === ws)
			.map((c) => (c[1] as { type: string }).type);
		expect(types).toContain("status");
	});

	it("re-sends last error when session is in error state", () => {
		const session = makeSession({
			getStatus: vi.fn().mockReturnValue({ state: "error", model: "m" }),
		});
		const { pool, runState } = wrapSession(session);
		runState.lastError = "Something failed";
		const { open } = createWsHandlers(pool as never);
		const ws = makeWs();
		open(ws as never);
		const calls = mockSend.mock.calls.filter((c) => c[0] === ws);
		const errorMsg = calls.find((c) => c[1].type === "error");
		expect(errorMsg).toBeDefined();
		expect(errorMsg?.[1].message).toBe("Something failed");
	});

	it("does NOT re-send error when session recovered to idle", () => {
		const session = makeSession({
			getStatus: vi.fn().mockReturnValue({ state: "idle", model: "m" }),
		});
		const { pool, runState } = wrapSession(session);
		runState.lastError = "old error";
		const { open } = createWsHandlers(pool as never);
		const ws = makeWs();
		open(ws as never);
		const calls = mockSend.mock.calls.filter((c) => c[0] === ws);
		expect(calls.find((c) => c[1].type === "error")).toBeUndefined();
	});

	it("replays run buffer when session is running", () => {
		const chunks: ServerMessage[] = [
			{ type: "chunk", text: "Hello" },
			{ type: "chunk", text: " world" },
		];
		const session = makeSession({ isRunning: vi.fn().mockReturnValue(true) });
		const { pool, runState } = wrapSession(session);
		runState.getReplayBuffer.mockReturnValue(chunks);
		const { open } = createWsHandlers(pool as never);
		const ws = makeWs();
		open(ws as never);
		const sentChunks = mockSend.mock.calls
			.filter((c) => c[0] === ws && c[1].type === "chunk")
			.map((c) => c[1].text);
		expect(sentChunks).toEqual(["Hello", " world"]);
	});

	it("claims ownership for reconnecting client when no owner set", () => {
		const session = makeSession({ isRunning: vi.fn().mockReturnValue(true) });
		const { pool, runState } = wrapSession(session);
		const { open } = createWsHandlers(pool as never);
		const ws = makeWs();
		open(ws as never);
		expect(runState.ownerWs).toBe(ws);
	});

	it("sends MCP status cache if available", () => {
		const mcpStatuses = [{ name: "my-server", status: "connected" as const }];
		const session = makeSession({
			getLastMcpStatus: vi.fn().mockReturnValue(mcpStatuses),
		});
		const { pool } = wrapSession(session);
		const { open } = createWsHandlers(pool as never);
		const ws = makeWs();
		open(ws as never);
		const calls = mockSend.mock.calls.filter((c) => c[0] === ws);
		const mcpMsg = calls.find((c) => c[1].type === "mcp_status");
		expect(mcpMsg).toBeDefined();
	});

	it("replays pending ask_user_question messages when claiming ownership on reconnect", () => {
		const pendingQ = {
			type: "ask_user_question" as const,
			id: "aqq-1",
			questions: [
				{
					question: "Which approach?",
					options: ["Option A", "Option B"],
					multiSelect: false,
				},
			],
		};
		const session = makeSession({
			isRunning: vi.fn().mockReturnValue(true),
			getPendingAskUserQuestions: vi.fn().mockReturnValue([pendingQ]),
		});
		const { pool } = wrapSession(session);
		const { open } = createWsHandlers(pool as never);
		const ws = makeWs();
		// No owner yet — reconnecting client claims ownership
		open(ws as never);
		const calls = mockSend.mock.calls.filter((c) => c[0] === ws);
		const qMsg = calls.find((c) => c[1].type === "ask_user_question");
		expect(qMsg).toBeDefined();
		expect(qMsg?.[1]).toMatchObject({
			id: "aqq-1",
			questions: [{ question: "Which approach?" }],
		});
	});

	it("replays ask_user_questions when another client already owns the session", () => {
		const pendingQ = {
			type: "ask_user_question" as const,
			id: "aqq-1",
			questions: [
				{
					question: "Which approach?",
					options: ["Option A", "Option B"],
					multiSelect: false,
				},
			],
		};
		const session = makeSession({
			isRunning: vi.fn().mockReturnValue(true),
			getPendingAskUserQuestions: vi.fn().mockReturnValue([pendingQ]),
		});
		const { pool, runState } = wrapSession(session);
		const { open } = createWsHandlers(pool as never);
		const owner = makeWs();
		const other = makeWs("vault-id");
		runState.ownerWs = owner; // pre-set an existing owner
		open(other as never);
		const calls = mockSend.mock.calls.filter((c) => c[0] === other);
		const question = calls.find((c) => c[1].type === "ask_user_question")?.[1];
		expect(question).toMatchObject({ id: "aqq-1" });
	});
});

// ── close ─────────────────────────────────────────────────────────────────────

describe("close", () => {
	it("removes ws from clients", () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { open, close } = createWsHandlers(pool as never);
		const ws = makeWs();
		open(ws as never);
		close(ws as never);
		expect(wsState.clients.has(ws)).toBe(false);
	});

	it("calls runState.removeSubscriber when owner disconnects", () => {
		const session = makeSession();
		const { pool, runState } = wrapSession(session);
		const { open, close } = createWsHandlers(pool as never);
		const ws = makeWs();
		runState.ownerWs = ws;
		open(ws as never);
		close(ws as never);
		expect(runState.removeSubscriber).toHaveBeenCalledWith(ws);
	});

	it("calls runState.removeSubscriber when non-owner disconnects", () => {
		const session = makeSession();
		const { pool, runState } = wrapSession(session);
		const { open, close } = createWsHandlers(pool as never);
		const owner = makeWs();
		const other = makeWs("vault-id");
		runState.ownerWs = owner;
		open(other as never);
		close(other as never);
		expect(runState.removeSubscriber).toHaveBeenCalledWith(other);
	});
});

// ── message: invalid JSON ─────────────────────────────────────────────────────

describe("message — invalid JSON", () => {
	it("sends error on malformed JSON", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(ws as never, "not-json");
		expect(lastSentTo(ws)).toMatchObject({
			type: "error",
			message: "Invalid JSON",
		});
	});
});

// ── message: sync ─────────────────────────────────────────────────────────────

describe("message — sync", () => {
	it("sends current status", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(ws as never, JSON.stringify({ type: "sync" }));
		const types = mockSend.mock.calls
			.filter((c) => c[0] === ws)
			.map((c) => (c[1] as { type: string }).type);
		expect(types).toContain("status");
	});

	it("replays pending questions and plans without taking ownership", async () => {
		const pendingQuestion = {
			type: "ask_user_question" as const,
			id: "question-1",
			questions: [
				{ question: "Which scope?", options: ["A", "B"], multiSelect: false },
			],
		};
		const pendingPlan = {
			type: "plan_mode_exit" as const,
			id: "plan-1",
			input: { plan: "The plan" },
		};
		const session = makeSession({
			isRunning: vi.fn().mockReturnValue(true),
			getPendingAskUserQuestions: vi.fn().mockReturnValue([pendingQuestion]),
			getPendingPlanModeExits: vi.fn().mockReturnValue([pendingPlan]),
		});
		const { pool, runState } = wrapSession(session);
		const owner = makeWs();
		const other = makeWs();
		runState.ownerWs = owner;
		const { message } = createWsHandlers(pool as never);

		await message(other as never, JSON.stringify({ type: "sync" }));

		expect(runState.ownerWs).toBe(owner);
		const types = mockSend.mock.calls
			.filter((call) => call[0] === other)
			.map((call) => call[1].type);
		expect(types).toContain("ask_user_question");
		expect(types).toContain("plan_mode_exit");
	});
});

// ── message: abort ────────────────────────────────────────────────────────────

describe("message — abort", () => {
	it("calls session.abort() when ws is owner", async () => {
		const session = makeSession();
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		runState.ownerWs = ws;
		await message(ws as never, JSON.stringify({ type: "abort" }));
		expect(session.abort).toHaveBeenCalled();
	});

	it("allows abort from any device", async () => {
		const session = makeSession();
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const owner = makeWs();
		const other = makeWs("vault-id");
		runState.ownerWs = owner;
		await message(other as never, JSON.stringify({ type: "abort" }));
		expect(session.abort).toHaveBeenCalled();
	});
});

// ── message: skip_sleep ───────────────────────────────────────────────────────

describe("message — skip_sleep", () => {
	it("routes skip_sleep to session.skipSleep()", async () => {
		const session = makeSession();
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		runState.ownerWs = ws;
		await message(ws as never, JSON.stringify({ type: "skip_sleep" }));
		expect(session.skipSleep).toHaveBeenCalled();
	});
});

// ── message: clear ────────────────────────────────────────────────────────────

describe("message — clear", () => {
	it("sets pendingNewSession and clears error on subscribed session", async () => {
		const session = makeSession();
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		runState.ownerWs = ws;
		runState.lastError = "prev error";
		await message(ws as never, JSON.stringify({ type: "clear" }));
		expect(
			(ws as { data: { pendingNewSession?: boolean } }).data.pendingNewSession,
		).toBe(true);
		expect(runState.clearError).toHaveBeenCalled();
	});

	it("allows clear from any device", async () => {
		const session = makeSession();
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const owner = makeWs();
		const other = makeWs("vault-id");
		runState.ownerWs = owner;
		await message(other as never, JSON.stringify({ type: "clear" }));
		expect(
			(other as { data: { pendingNewSession?: boolean } }).data
				.pendingNewSession,
		).toBe(true);
	});
});

// ── message: reload_session ───────────────────────────────────────────────────

describe("message — reload_session", () => {
	it("reinitializes session and broadcasts status via runState when owner", async () => {
		const session = makeSession();
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		runState.ownerWs = ws;
		await message(ws as never, JSON.stringify({ type: "reload_session" }));
		expect(session.reinitialize).toHaveBeenCalled();
		expect(runState.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "status" }),
		);
	});

	it("allows reload from any device", async () => {
		const session = makeSession();
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const owner = makeWs();
		const other = makeWs("vault-id");
		runState.ownerWs = owner;
		await message(other as never, JSON.stringify({ type: "reload_session" }));
		expect(session.reinitialize).toHaveBeenCalled();
	});
});

// ── message: set_model ────────────────────────────────────────────────────────

describe("message — set_model", () => {
	it("calls manager.setModel and broadcasts the updated status", async () => {
		const session = makeSession({
			getStatus: vi.fn().mockReturnValue({
				state: "idle",
				model: "new-model",
				permission_mode: "default",
			}),
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({ type: "set_model", model: "new-model" }),
		);
		expect(session.setModel).toHaveBeenCalledWith("new-model");
		expect(runState.broadcast).toHaveBeenCalledWith({
			type: "status",
			state: "idle",
			model: "new-model",
			permission_mode: "default",
		});
	});

	it("passes undefined through (reset to provider default)", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(ws as never, JSON.stringify({ type: "set_model" }));
		expect(session.setModel).toHaveBeenCalledWith(undefined);
	});
});

describe("message — set_provider", () => {
	it("switches the session-scoped CLI and broadcasts the updated status", async () => {
		const session = makeSession({
			getStatus: vi.fn().mockReturnValue({
				state: "idle",
				model: "pi-pro",
				permission_mode: "default",
				effort: "medium",
			}),
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "set_provider",
				provider: "pi",
				model: "pi-pro",
				effort: "medium",
				permission_mode: "default",
			}),
		);

		expect(session.setProvider).toHaveBeenCalledWith("pi", {
			model: "pi-pro",
			effort: "medium",
			permissionMode: "default",
		});
		expect(runState.broadcast).toHaveBeenCalledWith({
			type: "status",
			state: "idle",
			model: "pi-pro",
			permission_mode: "default",
			effort: "medium",
		});
	});

	it("does not apply archived-session settings to the vault manager", async () => {
		const session = makeSession();
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs("archived-session");

		await message(
			ws as never,
			JSON.stringify({
				type: "set_provider",
				provider: "pi",
				session_id: "archived-session",
			}),
		);

		expect(session.setProvider).not.toHaveBeenCalled();
		expect(runState.broadcast).not.toHaveBeenCalled();
	});
});

// ── message: set_permission_mode ──────────────────────────────────────────────

describe("message — set_permission_mode", () => {
	it("calls manager.setPermissionMode and broadcasts the updated status", async () => {
		const session = makeSession({
			getStatus: vi.fn().mockReturnValue({
				state: "idle",
				model: "test-model",
				permission_mode: "acceptEdits",
			}),
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({ type: "set_permission_mode", mode: "acceptEdits" }),
		);
		expect(session.setPermissionMode).toHaveBeenCalledWith("acceptEdits");
		expect(runState.broadcast).toHaveBeenCalledWith({
			type: "status",
			state: "idle",
			model: "test-model",
			permission_mode: "acceptEdits",
		});
	});

	it("sends an error and does not broadcast when the mode is rejected", async () => {
		const session = makeSession({
			setPermissionMode: vi
				.fn()
				.mockRejectedValue(new Error("Unknown permission mode: bogus")),
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({ type: "set_permission_mode", mode: "bogus" }),
		);
		expect(lastSentTo(ws)).toEqual({
			type: "error",
			message: "Unknown permission mode: bogus",
		});
		expect(runState.broadcast).not.toHaveBeenCalled();
	});
});

// ── message: chat ─────────────────────────────────────────────────────────────

describe("message — chat", () => {
	it("rejects empty text", async () => {
		const session = makeSession();
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		runState.ownerWs = ws;
		await message(ws as never, JSON.stringify({ type: "chat", text: "   " }));
		expect(lastSentTo(ws)).toMatchObject({
			type: "error",
			message: "Invalid message",
		});
		expect(session.runQuery).not.toHaveBeenCalled();
	});

	it("allows chat from any device regardless of who owns the session", async () => {
		const session = makeSession();
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const owner = makeWs();
		const other = makeWs("vault-id");
		runState.ownerWs = owner;
		await message(other as never, JSON.stringify({ type: "chat", text: "hi" }));
		const errorCalls = mockSend.mock.calls.filter(
			(c) => (c[1] as { type?: string })?.type === "error",
		);
		expect(errorCalls).toHaveLength(0);
		expect(session.runQuery).toHaveBeenCalled();
	});

	it("does not reject chat when session is running — forwards to runQuery (Slice A)", async () => {
		const session = makeSession({
			isRunning: vi.fn().mockReturnValue(true),
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		runState.ownerWs = ws;
		await message(ws as never, JSON.stringify({ type: "chat", text: "hi" }));
		// No "Session already running" error should be sent.
		const errorCalls = mockSend.mock.calls.filter(
			(c) => (c[1] as { type?: string })?.type === "error",
		);
		expect(errorCalls).toHaveLength(0);
		// runQuery is invoked even though session.isRunning() reported true.
		expect(session.runQuery).toHaveBeenCalled();
	});

	it("does not let a stale live-chat payload overwrite a just-selected effort", async () => {
		const session = makeSession({
			getProviderId: vi.fn().mockReturnValue("codex"),
			getCurrentSessionId: vi.fn().mockReturnValue("live-session"),
		});
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "chat",
				text: "follow up",
				session_id: "live-session",
				provider: "codex",
				model: "gpt-5.6-sol",
				effort: "high",
				permission_mode: "bypassPermissions",
			}),
		);

		expect(session.setProvider).not.toHaveBeenCalled();
		expect(session.runQuery).toHaveBeenCalled();
	});

	it("still applies repeated controls when creating a live manager", async () => {
		const session = makeSession({
			getProviderId: vi.fn().mockReturnValue("codex"),
			getCurrentSessionId: vi.fn().mockReturnValue(null),
		});
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "chat",
				text: "first turn",
				session_id: "new-session",
				provider: "codex",
				model: "gpt-5.6-sol",
				effort: "ultra",
				permission_mode: "bypassPermissions",
			}),
		);

		expect(session.setProvider).toHaveBeenCalledWith("codex", {
			model: "gpt-5.6-sol",
			effort: "ultra",
			permissionMode: "bypassPermissions",
		});
		expect(session.runQuery).toHaveBeenCalled();
	});

	it("applies partial first-turn controls without requiring a provider override", async () => {
		const status = {
			state: "idle" as const,
			model: "configured-model",
			effort: "medium",
			permission_mode: "default" as const,
		};
		const session = makeSession({
			getProviderId: vi.fn().mockReturnValue("codex"),
			getCurrentSessionId: vi.fn().mockReturnValue(null),
			getStatus: vi.fn(() => ({ ...status })),
			setModel: vi.fn(async (model?: string) => {
				status.model = model ?? "";
			}),
			setEffort: vi.fn(async (effort: string) => {
				status.effort = effort;
			}),
			setPermissionMode: vi.fn(async (mode: string) => {
				status.permission_mode = mode as "default";
			}),
		});
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "chat",
				text: "first turn",
				session_id: "new-session",
				model: "gpt-5.6-sol",
				effort: "ultra",
				permission_mode: "bypassPermissions",
			}),
		);

		expect(session.setProvider).not.toHaveBeenCalled();
		expect(session.setModel).toHaveBeenCalledWith("gpt-5.6-sol");
		expect(session.setEffort).toHaveBeenCalledWith("ultra");
		expect(session.setPermissionMode).toHaveBeenCalledWith("bypassPermissions");
		expect(mockSend).toHaveBeenCalledWith(
			ws,
			expect.objectContaining({
				type: "status",
				model: "gpt-5.6-sol",
				effort: "ultra",
				permission_mode: "bypassPermissions",
			}),
		);
		expect(session.runQuery).toHaveBeenCalled();
	});

	it("keeps ownership across concurrent chats from the same ws (Slice A)", async () => {
		// Provider runQuery resolves only when we say so — lets us simulate two
		// chats in-flight from the same ws.
		const turn1Resolvers: Array<() => void> = [];
		const turn2Resolvers: Array<() => void> = [];
		let callCount = 0;
		const session = makeSession({
			runQuery: vi.fn(() => {
				callCount++;
				return new Promise<void>((resolve) => {
					if (callCount === 1) turn1Resolvers.push(resolve);
					else turn2Resolvers.push(resolve);
				});
			}) as unknown as SessionManager["runQuery"],
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		// Fire two chats concurrently — do not await yet.
		const p1 = message(
			ws as never,
			JSON.stringify({ type: "chat", text: "first" }),
		);
		const p2 = message(
			ws as never,
			JSON.stringify({ type: "chat", text: "second" }),
		);

		// Resolve turn 1 — ownership must NOT clear because turn 2 still in-flight
		// from the same ws.
		turn1Resolvers[0]?.();
		await p1;
		expect(runState.ownerWs).toBe(ws);

		// Resolve turn 2 — now ownership should clear.
		turn2Resolvers[0]?.();
		await p2;
		expect(runState.ownerWs).toBeNull();
	});

	it("calls session.runQuery with correct args", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({
				type: "chat",
				text: "hello",
				session_id: "sess-1",
				skill_context: "/vault/skills/s.md",
			}),
		);
		expect(session.runQuery).toHaveBeenCalledWith(
			"hello",
			expect.any(Function),
			"sess-1",
			"/vault/skills/s.md",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		);
	});

	it("forwards plan_mode flag to session.runQuery", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({
				type: "chat",
				text: "hello",
				session_id: "sess-1",
				plan_mode: true,
			}),
		);
		expect(session.runQuery).toHaveBeenCalledWith(
			"hello",
			expect.any(Function),
			"sess-1",
			undefined,
			undefined,
			undefined,
			undefined,
			true,
			undefined,
		);
	});

	it("forwards plan_html flag to session.runQuery", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({
				type: "chat",
				text: "hello",
				session_id: "sess-1",
				plan_mode: true,
				plan_html: true,
			}),
		);
		expect(session.runQuery).toHaveBeenCalledWith(
			"hello",
			expect.any(Function),
			"sess-1",
			undefined,
			undefined,
			undefined,
			undefined,
			true,
			true,
		);
	});

	it("broadcasts status via runState when syncConfig reports model changed", async () => {
		const session = makeSession({
			syncConfig: vi.fn().mockReturnValue(true),
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		runState.broadcast.mockClear();
		await message(ws as never, JSON.stringify({ type: "chat", text: "hi" }));
		expect(runState.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "status" }),
		);
	});

	it("does not broadcast status when syncConfig reports no model change", async () => {
		const session = makeSession({
			syncConfig: vi.fn().mockReturnValue(false),
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		runState.broadcast.mockClear();
		await message(ws as never, JSON.stringify({ type: "chat", text: "hi" }));
		const statusBroadcasts = runState.broadcast.mock.calls.filter(
			(c) => (c[0] as { type?: string })?.type === "status",
		);
		expect(statusBroadcasts).toHaveLength(0);
	});

	it("cancel_queued forwards turn_id to session.cancelQueued", async () => {
		const session = makeSession({
			cancelQueued: vi.fn().mockReturnValue(true),
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		runState.ownerWs = ws;
		await message(
			ws as never,
			JSON.stringify({ type: "cancel_queued", turn_id: "turn-xyz" }),
		);
		expect(session.cancelQueued).toHaveBeenCalledWith("turn-xyz");
	});

	it("promote_queued forwards turn_id to session.promoteQueued", async () => {
		const session = makeSession({
			promoteQueued: vi.fn().mockReturnValue(true),
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		runState.ownerWs = ws;
		await message(
			ws as never,
			JSON.stringify({ type: "promote_queued", turn_id: "turn-3" }),
		);
		expect(session.promoteQueued).toHaveBeenCalledWith("turn-3");
	});

	it("promote_queued allowed from any device", async () => {
		const session = makeSession({
			promoteQueued: vi.fn().mockReturnValue(true),
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const owner = makeWs();
		const other = makeWs("vault-id");
		runState.ownerWs = owner;
		await message(
			other as never,
			JSON.stringify({ type: "promote_queued", turn_id: "turn-3" }),
		);
		expect(session.promoteQueued).toHaveBeenCalledWith("turn-3");
	});

	it("cancel_queued allowed from any device", async () => {
		const session = makeSession({
			cancelQueued: vi.fn().mockReturnValue(true),
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const owner = makeWs();
		const other = makeWs("vault-id");
		runState.ownerWs = owner;
		await message(
			other as never,
			JSON.stringify({ type: "cancel_queued", turn_id: "turn-xyz" }),
		);
		expect(session.cancelQueued).toHaveBeenCalledWith("turn-xyz");
	});

	it("first chat from unowned session is not rejected as non-owner", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		// No owner set — chat allowed from any ws
		await message(ws as never, JSON.stringify({ type: "chat", text: "hello" }));
		// runQuery called proves the request wasn't rejected
		expect(session.runQuery).toHaveBeenCalled();
	});
});

// ── message: permission_response ──────────────────────────────────────────────

describe("message — permission_response", () => {
	it("resolves pending permission and broadcasts resolved event via runState", async () => {
		const pending = {
			type: "permission_request" as const,
			id: "perm-1",
			toolName: "Bash",
			title: "Run command",
			displayName: "Bash",
		};
		const session = makeSession({
			getPendingPermissionRequests: vi.fn().mockReturnValue([pending]),
			getCurrentSessionId: vi.fn().mockReturnValue("sess-1"),
		});
		const { pool, runState } = wrapSession(session);
		pool.getSessionsStatus.mockReturnValue([
			{ session_id: "vault-id", hasPendingPermissions: false },
		]);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({
				type: "permission_response",
				id: "perm-1",
				approved: true,
			}),
		);
		expect(session.handlePermissionResponse).toHaveBeenCalledWith(
			"perm-1",
			true,
			undefined,
			undefined,
		);
		expect(runState.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "permission_resolved", id: "perm-1" }),
		);
		expect(mockBroadcast).toHaveBeenCalledWith({
			type: "sessions_status",
			sessions: [{ session_id: "vault-id", hasPendingPermissions: false }],
		});
	});

	it("does nothing when permission id not found", async () => {
		const session = makeSession({
			getPendingPermissionRequests: vi.fn().mockReturnValue([]),
		});
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({
				type: "permission_response",
				id: "nonexistent",
				approved: true,
			}),
		);
		expect(session.handlePermissionResponse).not.toHaveBeenCalled();
	});

	it("forwards denyMessage to handlePermissionResponse", async () => {
		const pending = {
			type: "permission_request" as const,
			id: "perm-2",
			toolName: "Bash",
			title: "Run command",
			displayName: "Bash",
		};
		const session = makeSession({
			getPendingPermissionRequests: vi.fn().mockReturnValue([pending]),
			getCurrentSessionId: vi.fn().mockReturnValue("sess-1"),
		});
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({
				type: "permission_response",
				id: "perm-2",
				approved: false,
				denyMessage: "use Read instead",
			}),
		);
		expect(session.handlePermissionResponse).toHaveBeenCalledWith(
			"perm-2",
			false,
			undefined,
			"use Read instead",
		);
	});
});

// ── message: ask_user_question_response ───────────────────────────────────────

describe("message — ask_user_question_response", () => {
	it("calls session.handleAskUserQuestionResponse with id and answers map", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({
				type: "ask_user_question_response",
				id: "aqq-1",
				answers: { "Q?": ["Option A"] },
			}),
		);
		expect(session.handleAskUserQuestionResponse).toHaveBeenCalledWith(
			"aqq-1",
			{
				"Q?": ["Option A"],
			},
			undefined,
		);
	});

	it("does not throw when id is unknown", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({
				type: "ask_user_question_response",
				id: "ghost-id",
				answers: { "Q?": ["Whatever"] },
			}),
		);
	});

	it("broadcasts ask_user_question_resolved via runState after response", async () => {
		const session = makeSession();
		const { pool, runState } = wrapSession(session);
		pool.getSessionsStatus.mockReturnValue([
			{ session_id: "vault-id", hasPendingPermissions: false },
		]);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({
				type: "ask_user_question_response",
				id: "aqq-2",
				answers: { "Q?": ["Option B"] },
			}),
		);
		expect(runState.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "ask_user_question_resolved",
				id: "aqq-2",
				answers: { "Q?": ["Option B"] },
			}),
		);
		expect(mockBroadcast).toHaveBeenCalledWith({
			type: "sessions_status",
			sessions: [{ session_id: "vault-id", hasPendingPermissions: false }],
		});
	});

	it("propagates multi-question / multi-select answer maps verbatim", async () => {
		const session = makeSession();
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		const answers = {
			"First?": ["Yes"],
			"Pick any?": ["Alpha", "Gamma"],
		};
		await message(
			ws as never,
			JSON.stringify({
				type: "ask_user_question_response",
				id: "aqq-multi",
				answers,
			}),
		);
		expect(session.handleAskUserQuestionResponse).toHaveBeenCalledWith(
			"aqq-multi",
			answers,
			undefined,
		);
		expect(runState.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "ask_user_question_resolved",
				id: "aqq-multi",
				answers,
			}),
		);
	});

	it("forwards notes to session.handleAskUserQuestionResponse when provided", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({
				type: "ask_user_question_response",
				id: "aqq-notes",
				answers: { "Q?": ["A"] },
				notes: { "Q?": "more context" },
			}),
		);
		expect(session.handleAskUserQuestionResponse).toHaveBeenCalledWith(
			"aqq-notes",
			{ "Q?": ["A"] },
			{ "Q?": "more context" },
		);
	});

	it("broadcasts ask_user_question_resolved including notes when provided", async () => {
		const session = makeSession();
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({
				type: "ask_user_question_response",
				id: "aqq-notes-2",
				answers: { "Q?": ["A"] },
				notes: { "Q?": "feedback text" },
			}),
		);
		expect(runState.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "ask_user_question_resolved",
				id: "aqq-notes-2",
				answers: { "Q?": ["A"] },
				notes: { "Q?": "feedback text" },
			}),
		);
	});

	it("any client can respond to ask_user_question (not owner-gated)", async () => {
		const session = makeSession();
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const owner = makeWs();
		const other = makeWs("vault-id");
		runState.ownerWs = owner;
		// non-owner can still respond to a question
		await message(
			other as never,
			JSON.stringify({
				type: "ask_user_question_response",
				id: "aqq-3",
				answers: { "Q?": ["Option C"] },
			}),
		);
		expect(session.handleAskUserQuestionResponse).toHaveBeenCalledWith(
			"aqq-3",
			{
				"Q?": ["Option C"],
			},
			undefined,
		);
	});
});

// ── message: plan_mode_exit_response ─────────────────────────────────────────

describe("message — plan_mode_exit_response", () => {
	it("rebroadcasts pool status after the plan decision resolves", async () => {
		const session = makeSession();
		const { pool, runState } = wrapSession(session);
		pool.getSessionsStatus.mockReturnValue([
			{ session_id: "vault-id", hasPendingPermissions: false },
		]);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "plan_mode_exit_response",
				id: "plan-1",
				decision: "approved",
			}),
		);

		expect(session.handlePlanModeExitResponse).toHaveBeenCalledWith(
			"plan-1",
			"approved",
			undefined,
		);
		expect(runState.broadcast).toHaveBeenCalledWith({
			type: "plan_mode_exit_resolved",
			id: "plan-1",
			decision: "approved",
		});
		expect(mockBroadcast).toHaveBeenCalledWith({
			type: "sessions_status",
			sessions: [{ session_id: "vault-id", hasPendingPermissions: false }],
		});
	});
});

// ── message — sync_mcp_list (agent_cwd) ───────────────────────────────────────

describe("message — sync_mcp_list (agent_cwd)", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "hlid-ws-agent-"));
		mockLoadConfig.mockReturnValue({
			vault: { path: "/tmp/test", name: "Test Vault" },
			claude: {
				model: "test-model",
				effort: "medium",
				permission_mode: "default",
				turn_recaps: false,
			},
			agents: [
				{ path: agentDir, name: "test", mode: "cwd", provider: "claude" },
			],
		});
		mockWaitForClaudeWarmupSnapshot.mockResolvedValue(null);
		mockWaitForAllClaudeWarmupSnapshots.mockResolvedValue([]);
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
		// Restore default mock
		mockLoadConfig.mockReturnValue({
			vault: { path: "/tmp/test", name: "Test Vault" },
			claude: {
				model: "test-model",
				effort: "medium",
				permission_mode: "default",
				turn_recaps: false,
			},
			agents: [],
		});
	});

	it("without agent_cwd: calls broadcast with vault mcp_status", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(ws as never, JSON.stringify({ type: "sync_mcp_list" }));
		expect(mockBroadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "mcp_status" }),
		);
	});

	it("returns Cockpit inventory across live Codex and startup-cached Claude metadata", async () => {
		const codexSession = makeSession({
			getMcpSnapshots: vi.fn().mockReturnValue([
				{
					providerId: "codex",
					servers: [{ name: "github", status: "connected" }],
				},
			]),
		});
		mockWaitForAllClaudeWarmupSnapshots.mockResolvedValueOnce([
			{
				commands: [],
				agents: [],
				mcpServers: [
					{
						name: "claude.ai Excalidraw",
						status: "connected",
						scope: "claudeai",
					},
				],
				modelCount: 0,
				cwd: "/tmp/test",
				warmedAt: 1,
				durationMs: 100,
			},
		]);
		const { pool, entry } = wrapSession(codexSession);
		pool.getAllEntries.mockReturnValue([entry][Symbol.iterator]());
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({ type: "sync_mcp_list", inventory: true }),
		);

		const inventory = mockSend.mock.calls.find(
			(call) => call[0] === ws && call[1]?.type === "mcp_status",
		)?.[1] as
			| {
					inventory?: boolean;
					servers: Array<{ name: string; provider_id?: string }>;
			  }
			| undefined;
		expect(inventory?.inventory).toBe(true);
		expect(inventory?.servers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "github", provider_id: "codex" }),
				expect.objectContaining({
					name: "claude.ai Excalidraw",
					provider_id: "claude",
				}),
			]),
		);
	});

	it("with valid agent_cwd: calls send(ws) not broadcast", async () => {
		writeFileSync(
			join(agentDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { "my-server": { command: "bun" } } }),
			"utf8",
		);
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		mockSend.mockClear();
		mockBroadcast.mockClear();
		await message(
			ws as never,
			JSON.stringify({ type: "sync_mcp_list", agent_cwd: agentDir }),
		);
		// send called with our ws
		const mcpCall = mockSend.mock.calls.find(
			(c) => c[0] === ws && c[1]?.type === "mcp_status",
		);
		expect(mcpCall).toBeDefined();
		// broadcast NOT called for the mcp_status
		const broadcastMcp = mockBroadcast.mock.calls.find(
			(c) => c[0]?.type === "mcp_status",
		);
		expect(broadcastMcp).toBeUndefined();
	});

	it("with valid agent_cwd: includes server names from agent .mcp.json", async () => {
		writeFileSync(
			join(agentDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					"image-gen": { command: "bun", args: ["bridge.ts"] },
					search: { command: "npx" },
				},
			}),
			"utf8",
		);
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		mockSend.mockClear();
		await message(
			ws as never,
			JSON.stringify({ type: "sync_mcp_list", agent_cwd: agentDir }),
		);
		const mcpCall = mockSend.mock.calls.find(
			(c) => c[0] === ws && c[1]?.type === "mcp_status",
		);
		const serverNames = (
			mcpCall?.[1] as { servers: Array<{ name: string }> }
		).servers.map((s) => s.name);
		expect(serverNames).toContain("image-gen");
		expect(serverNames).toContain("search");
	});

	it("with valid agent_cwd: marks disabled names from settings.local.json", async () => {
		writeFileSync(
			join(agentDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					"image-gen": { command: "bun" },
					search: { command: "npx" },
				},
			}),
			"utf8",
		);
		mkdirSync(join(agentDir, ".claude"), { recursive: true });
		writeFileSync(
			join(agentDir, ".claude", "settings.local.json"),
			JSON.stringify({ disabledMcpjsonServers: ["image-gen"] }),
			"utf8",
		);
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		mockSend.mockClear();
		await message(
			ws as never,
			JSON.stringify({ type: "sync_mcp_list", agent_cwd: agentDir }),
		);
		const mcpCall = mockSend.mock.calls.find(
			(c) => c[0] === ws && c[1]?.type === "mcp_status",
		);
		const servers = (
			mcpCall?.[1] as { servers: Array<{ name: string; status: string }> }
		).servers;
		const imageGen = servers.find((s) => s.name === "image-gen");
		expect(imageGen?.status).toBe("disabled");
		const search = servers.find((s) => s.name === "search");
		expect(search?.status).not.toBe("disabled");
	});

	it("with unregistered agent_cwd: silently does nothing", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		mockSend.mockClear();
		mockBroadcast.mockClear();
		await message(
			ws as never,
			JSON.stringify({
				type: "sync_mcp_list",
				agent_cwd: "/tmp/not-a-registered-agent",
			}),
		);
		const mcpSend = mockSend.mock.calls.find(
			(c) => c[1]?.type === "mcp_status",
		);
		expect(mcpSend).toBeUndefined();
		const mcpBroadcast = mockBroadcast.mock.calls.find(
			(c) => c[0]?.type === "mcp_status",
		);
		expect(mcpBroadcast).toBeUndefined();
	});

	it("with agent_cwd + no .mcp.json: sends empty servers array", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		mockSend.mockClear();
		await message(
			ws as never,
			JSON.stringify({ type: "sync_mcp_list", agent_cwd: agentDir }),
		);
		const mcpCall = mockSend.mock.calls.find(
			(c) => c[0] === ws && c[1]?.type === "mcp_status",
		);
		expect(mcpCall).toBeDefined();
		const servers = (mcpCall?.[1] as { servers: unknown[] }).servers;
		expect(servers).toHaveLength(0);
	});
});

// ── message: new_session ──────────────────────────────────────────────────────

describe("message — new_session", () => {
	it("sends session_created to requesting ws", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		mockSend.mockClear();
		await message(ws as never, JSON.stringify({ type: "new_session" }));
		const createdMsg = mockSend.mock.calls.find(
			(c) =>
				c[0] === ws && (c[1] as { type?: string })?.type === "session_created",
		);
		expect(createdMsg).toBeDefined();
	});

	it("sends status and queue_state to requesting ws after creation", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		mockSend.mockClear();
		await message(ws as never, JSON.stringify({ type: "new_session" }));
		const types = mockSend.mock.calls
			.filter((c) => c[0] === ws)
			.map((c) => (c[1] as { type?: string })?.type);
		expect(types).toContain("status");
		expect(types).toContain("queue_state");
	});

	it("subscribes ws to new session (addSubscriber called)", async () => {
		const session = makeSession();
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs("vault-id");
		await message(ws as never, JSON.stringify({ type: "new_session" }));
		expect(runState.addSubscriber).toHaveBeenCalledWith(ws);
	});

	it("unsubscribes ws from old session before subscribing to new", async () => {
		const session = makeSession();
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs("vault-id");
		await message(ws as never, JSON.stringify({ type: "new_session" }));
		expect(runState.removeSubscriber).toHaveBeenCalledWith(ws);
	});

	it("updates ws.data.subscribedSessionId to new session id", async () => {
		const session = makeSession();
		const { pool, entry } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs("vault-id");
		await message(ws as never, JSON.stringify({ type: "new_session" }));
		expect(ws.data.subscribedSessionId).toBe(entry.sessionId);
	});

	it("broadcasts sessions_status after creation", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		mockBroadcast.mockClear();
		await message(ws as never, JSON.stringify({ type: "new_session" }));
		expect(mockBroadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "sessions_status" }),
		);
	});

	it("sends error (not throw) when pool is at capacity", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		pool.create = vi.fn().mockImplementation(() => {
			throw new Error(
				"Session pool at capacity (20). Close a session before creating a new one.",
			);
		});
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await expect(
			message(ws as never, JSON.stringify({ type: "new_session" })),
		).resolves.toBeUndefined();
		expect(lastSentTo(ws)).toMatchObject({
			type: "error",
			message: expect.stringContaining("capacity"),
		});
	});

	it("does not broadcast sessions_status on capacity error", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		pool.create = vi.fn().mockImplementation(() => {
			throw new Error("capacity");
		});
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		mockBroadcast.mockClear();
		await message(ws as never, JSON.stringify({ type: "new_session" }));
		expect(mockBroadcast).not.toHaveBeenCalled();
	});
});

// ── message: close_session ────────────────────────────────────────────────────

describe("message — close_session", () => {
	it("sends error when attempting to close the vault session", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({ type: "close_session", session_id: "vault-id" }),
		);
		expect(lastSentTo(ws)).toMatchObject({
			type: "error",
			message: expect.stringContaining("vault"),
		});
	});

	it("does not call pool.close when session_id is the vault", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({ type: "close_session", session_id: "vault-id" }),
		);
		expect(pool.close).not.toHaveBeenCalled();
	});

	it("calls pool.close for a non-vault session", async () => {
		const session = makeSession();
		const { pool, entry } = wrapSession(session);
		// Register "other-session" as a known SDK session so the handler routes
		// to pool.close() rather than the terminal pool fallback.
		pool.get.mockImplementation((id: string) =>
			id === "vault-id" || id === "other-session" ? entry : undefined,
		);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({ type: "close_session", session_id: "other-session" }),
		);
		expect(pool.close).toHaveBeenCalledWith("other-session");
	});

	it("broadcasts session_closed after closing a non-vault session", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		mockBroadcast.mockClear();
		await message(
			ws as never,
			JSON.stringify({ type: "close_session", session_id: "other-session" }),
		);
		expect(mockBroadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "session_closed",
				session_id: "other-session",
			}),
		);
	});
});

// ── message: chat at capacity ─────────────────────────────────────────────────

describe("message — chat auto-create at capacity", () => {
	it("sends error when pool is at capacity during chat auto-create", async () => {
		// No current DB session → triggers auto-create path
		const session = makeSession({
			getCurrentSessionId: vi.fn().mockReturnValue(null),
			isRunning: vi.fn().mockReturnValue(false),
		});
		const { pool } = wrapSession(session);
		pool.create = vi.fn().mockImplementation(() => {
			throw new Error(
				"Session pool at capacity (20). Close a session before creating a new one.",
			);
		});
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(ws as never, JSON.stringify({ type: "chat", text: "hello" }));
		expect(lastSentTo(ws)).toMatchObject({
			type: "error",
			message: expect.stringContaining("capacity"),
		});
	});

	it("does not call runQuery when chat auto-create fails at capacity", async () => {
		const session = makeSession({
			getCurrentSessionId: vi.fn().mockReturnValue(null),
			isRunning: vi.fn().mockReturnValue(false),
		});
		const { pool } = wrapSession(session);
		pool.create = vi.fn().mockImplementation(() => {
			throw new Error(
				"Session pool at capacity (20). Close a session before creating a new one.",
			);
		});
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(ws as never, JSON.stringify({ type: "chat", text: "hello" }));
		expect(session.runQuery).not.toHaveBeenCalled();
	});
});
