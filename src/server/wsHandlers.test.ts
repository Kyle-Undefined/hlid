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
import { type SessionManager, UnsupportedProviderEffortError } from "./session";
import type { PoolEntry } from "./sessionPool";

// ── mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../db", () => ({
	recordPermissionEvent: vi.fn().mockResolvedValue(undefined),
	appendLog: vi.fn().mockResolvedValue(undefined),
	saveSetting: vi.fn().mockResolvedValue(undefined),
	setAskUserQuestionResolution: vi.fn().mockResolvedValue(undefined),
	getSessionSelection: vi.fn().mockResolvedValue(null),
	setSessionModel: vi.fn().mockResolvedValue(true),
	setSessionModelAndPermissionMode: vi.fn().mockResolvedValue(true),
	setSessionEffort: vi.fn().mockResolvedValue(true),
	setSessionPermissionMode: vi.fn().mockResolvedValue(true),
	setSessionApprovalsReviewer: vi.fn().mockResolvedValue(true),
	setSessionProviderSelection: vi.fn().mockResolvedValue(true),
	getHlidDelegationByChildSession: vi.fn().mockResolvedValue(null),
}));

// vi.mock factories are hoisted before module-level code, so vars referenced
// inside them must also be hoisted via vi.hoisted().
const {
	wsState,
	mockSend,
	mockBroadcast,
	mockRemoveNotificationPresence,
	mockUpdateNotificationPresence,
	mockLoadConfig,
	mockWaitForClaudeWarmupSnapshot,
	mockWaitForAllClaudeWarmupSnapshots,
} = vi.hoisted(() => ({
	wsState: {
		clients: new Set<object>(),
	},
	mockSend: vi.fn(),
	mockBroadcast: vi.fn(),
	mockRemoveNotificationPresence: vi.fn(),
	mockUpdateNotificationPresence: vi.fn(),
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

vi.mock("./notificationPresence", () => ({
	removeNotificationPresence: mockRemoveNotificationPresence,
	updateNotificationPresence: mockUpdateNotificationPresence,
}));

vi.mock("./claudeWarmup", () => ({
	waitForClaudeWarmupSnapshot: mockWaitForClaudeWarmupSnapshot,
	waitForAllClaudeWarmupSnapshots: mockWaitForAllClaudeWarmupSnapshots,
}));

// ── import after mocks ────────────────────────────────────────────────────────

import * as dbMock from "../db";
import {
	ClaudeWorkflowDeleteError,
	ClaudeWorkflowSaveError,
	ClaudeWorkflowSourceError,
} from "./claudeWorkflows";
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
		getMcpControlOperations: vi.fn().mockReturnValue([]),
		getMcpSnapshots: vi.fn().mockReturnValue([]),
		getAgentCwd: vi.fn().mockReturnValue(undefined),
		getProviderId: vi.fn().mockReturnValue("claude"),
		getPendingPermissionRequests: vi.fn().mockReturnValue([]),
		getPendingAskUserQuestions: vi.fn().mockReturnValue([]),
		getPendingPlanModeExits: vi.fn().mockReturnValue([]),
		getCurrentSessionId: vi.fn().mockReturnValue("mock-db-session"),
		getCurrentTurnId: vi.fn().mockReturnValue(null),
		abort: vi.fn(),
		skipSleep: vi.fn(),
		getSleepState: vi.fn().mockReturnValue(null),
		reinitialize: vi.fn(),
		syncConfig: vi.fn().mockReturnValue(false),
		syncRealtimeConfig: vi.fn(),
		runQuery: vi.fn().mockResolvedValue(undefined),
		cancelQueued: vi.fn().mockReturnValue(false),
		promoteQueued: vi.fn().mockReturnValue(false),
		steerQueued: vi.fn().mockResolvedValue(false),
		getQueueState: vi
			.fn()
			.mockReturnValue({ pending_turn_ids: [], running_turn_id: null }),
		handlePermissionResponse: vi.fn(),
		handleAskUserQuestionResponse: vi.fn().mockResolvedValue(true),
		handlePlanModeExitResponse: vi.fn(),
		probeProviderSessionConfig: vi.fn(),
		probeMcpStatus: vi.fn().mockResolvedValue(undefined),
		applyProviderMcpServers: vi.fn().mockResolvedValue({
			providerId: "claude",
			status: "not-live",
			reason: "No live query",
		}),
		controlMcpServer: vi
			.fn()
			.mockResolvedValue({ providerId: "claude", statuses: [] }),
		probeSlashCommands: vi.fn().mockResolvedValue(undefined),
		probeWorkflowCatalog: vi.fn().mockResolvedValue(undefined),
		saveProviderWorkflow: vi.fn().mockResolvedValue({
			id: "claude-workflow:audit",
			name: "audit",
			description: "Audit the project",
			argumentHint: "[input]",
			scriptPath: "/tmp/test/.claude/workflows/audit.js",
			scope: "project",
			scopeLabel: "Project",
			availableAsCommand: true,
		}),
		deleteProviderWorkflow: vi.fn().mockResolvedValue(undefined),
		readProviderWorkflowSource: vi
			.fn()
			.mockResolvedValue('export const meta = { name: "audit" }'),
		controlGoal: vi.fn().mockResolvedValue({ providerId: "codex", goal: null }),
		controlRealtime: vi.fn().mockResolvedValue(undefined),
		restoreMcpStatus: vi.fn(),
		setModel: vi.fn().mockResolvedValue(undefined),
		setProvider: vi.fn().mockResolvedValue(undefined),
		setInitialChatSelection: vi.fn().mockResolvedValue(undefined),
		prepareSessionControlsForChat: vi
			.fn()
			.mockResolvedValue({ restored: false }),
		setEffort: vi.fn().mockResolvedValue(undefined),
		setProviderSessionMode: vi.fn().mockResolvedValue(undefined),
		validateEffort: vi.fn(),
		validatePermissionMode: vi.fn().mockResolvedValue(undefined),
		setPermissionMode: vi.fn().mockResolvedValue(undefined),
		acknowledgeSessionControlRejection: vi.fn(),
		setApprovalsReviewer: vi.fn().mockResolvedValue(undefined),
		stopProviderTask: vi.fn().mockResolvedValue(undefined),
		controlProviderBackgroundActivity: vi.fn().mockResolvedValue(undefined),
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
		getProvider: vi.fn((id: string) => ({ providerId: id })),
		validateDetachedPermissionMode: vi.fn().mockResolvedValue(0),
		isDetachedPermissionValidationCurrent: vi.fn().mockReturnValue(true),
		getDetachedPermissionValidationGeneration: vi.fn().mockReturnValue(0),
		get: vi.fn((id: string) => (id === "vault-id" ? entry : undefined)),
		create: vi.fn().mockReturnValue(entry),
		close: vi.fn(),
		getSessionsStatus: vi.fn().mockReturnValue([]),
		getAllEntries: vi.fn().mockReturnValue([][Symbol.iterator]()),
		syncConfig: vi.fn(),
		getSize: vi.fn().mockReturnValue(1),
		findByDbSessionId: vi.fn((id: string) =>
			id === session.getCurrentSessionId() ? entry : undefined,
		),
		claimDbSessionId: vi.fn(
			(candidate: PoolEntry, _dbSessionId: string) => candidate,
		),
		isVaultSession: vi.fn().mockReturnValue(false),
	};
	return { pool, entry, runState };
}

/** Capture the most recent arg to mockSend for a given ws. */
function lastSentTo(ws: ReturnType<typeof makeWs>): ServerMessage | undefined {
	const calls = mockSend.mock.calls.filter((c) => c[0] === ws);
	return calls.length > 0 ? calls[calls.length - 1][1] : undefined;
}

function deferred() {
	let resolve: () => void = () => {};
	let reject: (reason?: unknown) => void = () => {};
	const promise = new Promise<void>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

beforeEach(() => {
	wsState.clients.clear();
	mockSend.mockClear();
	mockBroadcast.mockClear();
	mockRemoveNotificationPresence.mockClear();
	mockUpdateNotificationPresence.mockClear();
});

describe("message — connection_probe", () => {
	it("acknowledges the exact request before session routing", async () => {
		const { pool } = wrapSession(makeSession());
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({ type: "connection_probe", request_id: "resume-1" }),
		);

		expect(mockSend).toHaveBeenCalledOnce();
		expect(mockSend).toHaveBeenCalledWith(ws, {
			type: "connection_ack",
			request_id: "resume-1",
		});
		expect(pool.get).not.toHaveBeenCalled();
		expect(pool.findByDbSessionId).not.toHaveBeenCalled();
		expect(pool.vaultEntry).not.toHaveBeenCalled();
	});
});

describe("message — notification_presence", () => {
	it("records bounded visibility without routing or restoring a session", async () => {
		const { pool } = wrapSession(makeSession());
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "notification_presence",
				session_id: "db-session",
				visible: true,
			}),
		);

		expect(mockUpdateNotificationPresence).toHaveBeenCalledWith(ws, true);
		expect(pool.get).not.toHaveBeenCalled();
		expect(pool.findByDbSessionId).not.toHaveBeenCalled();
		expect(pool.vaultEntry).not.toHaveBeenCalled();
	});
});

describe("message — goal_control", () => {
	it("routes a native goal update and broadcasts the resulting state", async () => {
		const goal = {
			threadId: "thread-1",
			objective: "Finish the release gate",
			status: "active" as const,
			tokenBudget: 50_000,
			tokensUsed: 12,
			timeUsedSeconds: 3,
			createdAt: 1,
			updatedAt: 2,
		};
		const controlGoal = vi.fn(
			async (
				_control: unknown,
				options: { emit: (message: ServerMessage) => void },
			) => {
				options.emit({
					type: "status",
					state: "running",
					model: "gpt-5.6-sol",
					permission_mode: "default",
					effort: "high",
				});
				return { providerId: "codex", goal };
			},
		);
		const session = makeSession({ controlGoal });
		const { pool, entry, runState } = wrapSession(session);
		pool.findByDbSessionId.mockReturnValue(entry);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({
				type: "goal_control",
				request_id: "request-1",
				session_id: "mock-db-session",
				action: "set",
				objective: "Finish the release gate",
				token_budget: 50_000,
			}),
		);
		expect(controlGoal).toHaveBeenCalledWith(
			{
				action: "set",
				objective: "Finish the release gate",
				tokenBudget: 50_000,
			},
			expect.objectContaining({ sessionId: "mock-db-session" }),
		);
		expect(runState.broadcast).toHaveBeenCalledWith({
			type: "goal_state",
			session_id: "mock-db-session",
			provider_id: "codex",
			request_id: "request-1",
			goal: {
				thread_id: "thread-1",
				objective: "Finish the release gate",
				status: "active",
				token_budget: 50_000,
				tokens_used: 12,
				time_used_seconds: 3,
				created_at: 1,
				updated_at: 2,
			},
		});
		expect(runState.broadcast).toHaveBeenCalledWith({
			type: "status",
			state: "running",
			model: "gpt-5.6-sol",
			permission_mode: "default",
			effort: "high",
		});
		expect(mockBroadcast).toHaveBeenCalledWith({
			type: "sessions_status",
			sessions: [],
		});
	});

	it("does not revive a detached session to hydrate goal state", async () => {
		vi.mocked(dbMock.getSessionSelection).mockResolvedValueOnce({
			agentCwd: "/tmp/test",
			providerId: "codex",
			model: "gpt-5.6-sol",
			effort: "high",
			permissionMode: "default",
		});
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs("archived-session");

		await message(
			ws as never,
			JSON.stringify({
				type: "goal_control",
				request_id: "goal-hydration",
				session_id: "archived-session",
				action: "get",
			}),
		);

		expect(pool.create).not.toHaveBeenCalled();
		expect(session.controlGoal).not.toHaveBeenCalled();
		expect(lastSentTo(ws)).toEqual({
			type: "goal_state",
			session_id: "archived-session",
			provider_id: "codex",
			request_id: "goal-hydration",
			goal: null,
		});
	});
});

describe("message — realtime control", () => {
	function setupDetachedRealtime(controlRealtime: ReturnType<typeof vi.fn>) {
		const vaultSession = makeSession({
			getCurrentSessionId: vi.fn().mockReturnValue(null),
		});
		const { pool, entry: vaultEntry } = wrapSession(vaultSession);
		const voiceRunState = makeRunState("voice-pool");
		const voiceEntry = {
			sessionId: "voice-pool",
			agentCwd: "/tmp/voice-agent",
			agentName: "Voice Agent",
			claimedDbSessionId: null,
			manager: makeSession({
				controlRealtime:
					controlRealtime as unknown as SessionManager["controlRealtime"],
				getCurrentSessionId: vi.fn().mockReturnValue("detached-chat"),
			}),
			runState: voiceRunState,
		};
		pool.create.mockReturnValue(voiceEntry);
		pool.get.mockImplementation((id: string) => {
			if (id === "vault-id") return vaultEntry;
			if (id === "voice-pool") return voiceEntry;
			return undefined;
		});
		pool.claimDbSessionId.mockImplementation(
			(candidate: PoolEntry, dbSessionId: string) => {
				candidate.claimedDbSessionId = dbSessionId;
				return candidate;
			},
		);
		return { pool, vaultSession, voiceEntry };
	}

	it("claims a detached chat before publishing its first live-session status", async () => {
		const controlRealtime = vi.fn().mockResolvedValue(undefined);
		const { pool, voiceEntry } = setupDetachedRealtime(controlRealtime);
		pool.getSessionsStatus.mockImplementation(() => [
			{
				session_id: voiceEntry.sessionId,
				db_session_id: voiceEntry.claimedDbSessionId,
				agent_cwd: voiceEntry.agentCwd,
				agent_name: voiceEntry.agentName,
				state: "idle",
				provider_id: "codex",
				model: "gpt-5.6-sol",
				permission_mode: "default",
				hasPendingPermissions: false,
				hasDbSession: voiceEntry.claimedDbSessionId !== null,
			},
		]);
		const ws = makeWs("detached-chat");
		const { message } = createWsHandlers(pool as never);

		await message(
			ws as never,
			JSON.stringify({
				type: "realtime_start",
				session_id: "detached-chat",
				mode: "live",
				sdp: "v=0\r\no=hlid",
			}),
		);

		expect(pool.claimDbSessionId).toHaveBeenCalledWith(
			voiceEntry,
			"detached-chat",
		);
		expect(pool.claimDbSessionId.mock.invocationCallOrder[0]).toBeLessThan(
			controlRealtime.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		);
		expect(ws.data.subscribedSessionId).toBe(voiceEntry.sessionId);
		expect(mockSend).toHaveBeenCalledWith(ws, {
			type: "session_created",
			session_id: voiceEntry.sessionId,
			agent_cwd: voiceEntry.agentCwd,
			agent_name: voiceEntry.agentName,
		});
		expect(mockBroadcast).toHaveBeenCalledWith({
			type: "sessions_status",
			sessions: [
				expect.objectContaining({
					session_id: voiceEntry.sessionId,
					db_session_id: "detached-chat",
					hasDbSession: true,
				}),
			],
		});
	});

	it("subscribes a detached requester before an existing owner broadcasts Live finals", async () => {
		let emit: ((message: ServerMessage) => void) | undefined;
		const controlRealtime = vi.fn(
			async (
				_control: unknown,
				options: { emit: (message: ServerMessage) => void },
			) => {
				emit = options.emit;
			},
		);
		const session = makeSession({
			controlRealtime:
				controlRealtime as unknown as SessionManager["controlRealtime"],
			getCurrentSessionId: vi.fn().mockReturnValue("detached-chat"),
		});
		const { pool, entry } = wrapSession(session);
		pool.findByDbSessionId.mockReturnValue(entry);
		const ws = makeWs("different-pool");
		const { message } = createWsHandlers(pool as never);

		await message(
			ws as never,
			JSON.stringify({
				type: "realtime_start",
				session_id: "detached-chat",
				mode: "live",
				sdp: "v=0\r\no=hlid",
			}),
		);

		expect(entry.runState.addSubscriber).toHaveBeenCalledWith(ws);
		expect(ws.data.subscribedSessionId).toBe(entry.sessionId);
		const final: ServerMessage = {
			type: "realtime_transcript",
			session_id: "detached-chat",
			mode: "live",
			role: "assistant",
			text: "Durable answer",
			done: true,
			utterance_id: "codex-realtime-existing-owner",
			realtime_session_id: "raven-live-existing-owner",
			transcript_seq: 12,
			db_id: 42,
			source: "codex_realtime",
			fork_supported: false,
		};
		emit?.(final);
		expect(entry.runState.broadcast).toHaveBeenCalledWith(final);
	});

	it("closes a losing detached-start entry and reuses the claimed owner", async () => {
		const createdControlRealtime = vi.fn().mockResolvedValue(undefined);
		const { pool, voiceEntry } = setupDetachedRealtime(createdControlRealtime);
		const ownerControlRealtime = vi.fn().mockResolvedValue(undefined);
		const owner = {
			sessionId: "winning-pool",
			agentCwd: "/tmp/voice-agent",
			agentName: "Voice Agent",
			claimedDbSessionId: "detached-chat",
			manager: makeSession({
				controlRealtime:
					ownerControlRealtime as unknown as SessionManager["controlRealtime"],
				getCurrentSessionId: vi.fn().mockReturnValue("detached-chat"),
			}),
			runState: makeRunState("winning-pool"),
		} as unknown as PoolEntry;
		pool.claimDbSessionId.mockReturnValue(owner);
		const ws = makeWs("detached-chat");
		const { message } = createWsHandlers(pool as never);

		await message(
			ws as never,
			JSON.stringify({
				type: "realtime_start",
				session_id: "detached-chat",
				mode: "live",
				sdp: "v=0\r\no=hlid",
			}),
		);

		expect(pool.close).toHaveBeenCalledWith(voiceEntry.sessionId);
		expect(createdControlRealtime).not.toHaveBeenCalled();
		expect(ownerControlRealtime).toHaveBeenCalledOnce();
		expect(owner.runState.addSubscriber).toHaveBeenCalledWith(ws);
		expect(ws.data.subscribedSessionId).toBe(owner.sessionId);
		expect(mockSend).not.toHaveBeenCalledWith(
			ws,
			expect.objectContaining({ type: "session_created" }),
		);
	});

	it("refreshes only realtime config before starting on an existing chat", async () => {
		const syncConfig = vi.fn().mockReturnValue(false);
		const syncRealtimeConfig = vi.fn();
		const controlRealtime = vi.fn().mockResolvedValue(undefined);
		const session = makeSession({
			syncConfig,
			syncRealtimeConfig,
			controlRealtime,
		});
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		const latest = {
			vault: { path: "/tmp/test", name: "Test Vault" },
			claude: {
				model: "test-model",
				effort: "medium",
				permission_mode: "default",
				turn_recaps: false,
			},
			voice: { codex_live_mode: true },
			agents: [],
		};
		mockLoadConfig.mockReturnValueOnce(latest);

		await message(
			ws as never,
			JSON.stringify({
				type: "realtime_start",
				session_id: "vault-id",
				mode: "live",
				sdp: "v=0\r\no=hlid",
			}),
		);

		expect(syncRealtimeConfig).toHaveBeenCalledWith(latest);
		expect(syncConfig).not.toHaveBeenCalled();
		expect(syncRealtimeConfig.mock.invocationCallOrder[0]).toBeLessThan(
			controlRealtime.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		);
	});

	it("correlates read-aloud speech failures instead of sending a generic error", async () => {
		const controlRealtime = vi
			.fn()
			.mockRejectedValue(new Error("Codex appendSpeech failed"));
		const session = makeSession({ controlRealtime });
		const { pool } = wrapSession(session);
		const ws = makeWs();
		const { message } = createWsHandlers(pool as never);

		await message(
			ws as never,
			JSON.stringify({
				type: "realtime_speak",
				session_id: "vault-id",
				request_id: "read-aloud-request",
				mode: "read-aloud",
				text: "Read this response",
			}),
		);

		expect(controlRealtime).toHaveBeenCalledWith(
			{
				action: "speak",
				mode: "read-aloud",
				text: "Read this response",
			},
			expect.objectContaining({
				sessionId: "vault-id",
				requestId: "read-aloud-request",
			}),
		);
		expect(lastSentTo(ws)).toEqual({
			type: "realtime_error",
			session_id: "vault-id",
			request_id: "read-aloud-request",
			mode: "read-aloud",
			message: "Codex appendSpeech failed",
		});
		expect(mockSend).not.toHaveBeenCalledWith(
			ws,
			expect.objectContaining({ type: "error" }),
		);
	});

	it("broadcasts durable Live transcripts and tools while captions stay private", async () => {
		let emit: ((message: ServerMessage) => void) | undefined;
		const controlRealtime = vi.fn(
			async (
				_control: unknown,
				options: { emit: (message: ServerMessage) => void },
			) => {
				emit = options.emit;
			},
		);
		const { pool, voiceEntry } = setupDetachedRealtime(controlRealtime);
		const ws = makeWs("detached-chat");
		wsState.clients.add(ws);
		const { message } = createWsHandlers(pool as never);

		await message(
			ws as never,
			JSON.stringify({
				type: "realtime_start",
				session_id: "detached-chat",
				mode: "live",
				sdp: "v=0\r\no=hlid",
			}),
		);
		const base = {
			type: "realtime_transcript" as const,
			session_id: "detached-chat",
			mode: "live" as const,
			role: "assistant" as const,
			text: "Hello",
			utterance_id: "codex-realtime-1",
			realtime_session_id: "raven-live-test",
			transcript_seq: 1,
			source: "codex_realtime" as const,
			fork_supported: false,
		};
		emit?.({ ...base, done: false });
		const tool: ServerMessage = {
			type: "tool_event",
			id: "live-tool-1",
			name: "exec_command",
			input: { cmd: "git status --short" },
			realtime_utterance_id: "codex-realtime-1",
			realtime_session_id: "raven-live-test",
			transcript_seq: 1,
			fork_supported: false,
		};
		emit?.(tool);
		emit?.({ ...base, done: true, db_id: 42 });

		expect(mockSend).toHaveBeenCalledWith(ws, { ...base, done: false });
		expect(voiceEntry.runState.broadcast).toHaveBeenCalledWith({
			...base,
			done: true,
			db_id: 42,
		});
		expect(voiceEntry.runState.broadcast).toHaveBeenCalledWith(tool);
		expect(mockSend).not.toHaveBeenCalledWith(
			ws,
			expect.objectContaining({ db_id: 42 }),
		);
	});

	it("does not route a detached voice start through the permanent vault session", async () => {
		vi.mocked(dbMock.getSessionSelection).mockResolvedValueOnce({
			agentCwd: "/tmp/voice-agent",
			providerId: "codex",
			model: "gpt-5.6-sol",
			effort: "high",
			permissionMode: "default",
		});
		const controlRealtime = vi
			.fn()
			.mockRejectedValue(
				new Error("Codex realtime voice is not available for this account."),
			);
		const { pool, vaultSession, voiceEntry } =
			setupDetachedRealtime(controlRealtime);
		const ws = makeWs("detached-chat");
		wsState.clients.add(ws);
		const { message } = createWsHandlers(pool as never);

		await message(
			ws as never,
			JSON.stringify({
				type: "realtime_start",
				session_id: "detached-chat",
				request_id: "request-start-failure",
				mode: "dictation",
				sdp: "v=0\r\no=hlid",
				agent_cwd: "/tmp/voice-agent",
			}),
		);

		expect(pool.create).toHaveBeenCalledWith("/tmp/voice-agent", "voice-agent");
		expect(vaultSession.controlRealtime).not.toHaveBeenCalled();
		expect(controlRealtime).toHaveBeenCalledWith(
			expect.objectContaining({ action: "start", mode: "dictation" }),
			expect.objectContaining({
				sessionId: "detached-chat",
				requestId: "request-start-failure",
			}),
		);
		expect(pool.close).toHaveBeenCalledWith(voiceEntry.sessionId);
		expect(ws.data.subscribedSessionId).toBe("vault-id");
		expect(lastSentTo(ws)).toEqual({
			type: "realtime_error",
			session_id: "detached-chat",
			request_id: "request-start-failure",
			mode: "dictation",
			message: "Codex realtime voice is not available for this account.",
		});
	});

	it("retires a voice-only entry when the provider reports a late error", async () => {
		let emit: ((message: ServerMessage) => void) | undefined;
		const controlRealtime = vi.fn(
			async (
				_control: unknown,
				options: { emit: (message: ServerMessage) => void },
			) => {
				emit = options.emit;
			},
		);
		const { pool, voiceEntry } = setupDetachedRealtime(controlRealtime);
		const ws = makeWs("detached-chat");
		wsState.clients.add(ws);
		const { message } = createWsHandlers(pool as never);

		await message(
			ws as never,
			JSON.stringify({
				type: "realtime_start",
				session_id: "detached-chat",
				mode: "dictation",
				sdp: "v=0\r\no=hlid",
			}),
		);
		expect(pool.close).not.toHaveBeenCalled();

		emit?.({
			type: "realtime_error",
			session_id: "detached-chat",
			mode: "dictation",
			message: "Realtime failed after startup.",
		});

		expect(pool.close).toHaveBeenCalledWith(voiceEntry.sessionId);
		expect(ws.data.subscribedSessionId).toBe("vault-id");
		expect(mockBroadcast).toHaveBeenCalledWith({
			type: "session_closed",
			session_id: voiceEntry.sessionId,
		});
	});

	it("retires a detached dictation entry after a successful stop", async () => {
		vi.mocked(dbMock.getSessionSelection).mockResolvedValueOnce(null);
		const controlRealtime = vi.fn(
			async (
				control: { action: string },
				options: {
					requestId?: string;
					emit: (message: ServerMessage) => void;
				},
			) => {
				if (control.action !== "stop") return;
				options.emit({
					type: "realtime_state",
					session_id: "detached-dictation",
					request_id: options.requestId,
					mode: "dictation",
					state: "closed",
				});
			},
		);
		const { pool, voiceEntry } = setupDetachedRealtime(controlRealtime);
		let claimed = false;
		pool.findByDbSessionId.mockImplementation((id: string) =>
			claimed && id === "detached-dictation" ? voiceEntry : undefined,
		);
		pool.claimDbSessionId.mockImplementation(
			(candidate: PoolEntry, dbSessionId: string) => {
				candidate.claimedDbSessionId = dbSessionId;
				claimed = true;
				return candidate;
			},
		);
		const ws = makeWs("detached-dictation");
		wsState.clients.add(ws);
		const { message } = createWsHandlers(pool as never);

		await message(
			ws as never,
			JSON.stringify({
				type: "realtime_start",
				session_id: "detached-dictation",
				request_id: "dictation-request",
				mode: "dictation",
				sdp: "v=0\r\no=hlid",
				agent_cwd: "/tmp/voice-agent",
			}),
		);
		expect(pool.close).not.toHaveBeenCalled();

		await message(
			ws as never,
			JSON.stringify({
				type: "realtime_stop",
				session_id: "detached-dictation",
				request_id: "dictation-request",
				mode: "dictation",
			}),
		);

		expect(pool.close).toHaveBeenCalledWith(voiceEntry.sessionId);
		expect(ws.data.subscribedSessionId).toBe("vault-id");
		expect(lastSentTo(ws)).toEqual({
			type: "realtime_state",
			session_id: "detached-dictation",
			request_id: "dictation-request",
			mode: "dictation",
			state: "closed",
		});
	});

	it("keeps consecutive Cockpit dictation recordings transient", async () => {
		vi.mocked(dbMock.getSessionSelection).mockClear();
		vi.mocked(dbMock.getSessionSelection).mockResolvedValue(null);
		const controlRealtime = vi.fn(
			async (
				control: { action: string },
				options: {
					requestId?: string;
					emit: (message: ServerMessage) => void;
				},
			) => {
				if (control.action !== "stop") return;
				options.emit({
					type: "realtime_state",
					session_id: "cockpit-dictation",
					request_id: options.requestId,
					mode: "dictation",
					state: "closed",
				});
			},
		);
		const vaultSession = makeSession({
			getCurrentSessionId: vi.fn().mockReturnValue(null),
		});
		const { pool, entry: vaultEntry } = wrapSession(vaultSession);
		const voiceEntries: PoolEntry[] = [];
		const poolEntries = new Map<string, PoolEntry>([
			[vaultEntry.sessionId, vaultEntry as unknown as PoolEntry],
		]);
		const claimedEntries = new Map<string, PoolEntry>();
		pool.create.mockImplementation((agentCwd: string, agentName: string) => {
			const index = voiceEntries.length + 1;
			const entry = {
				sessionId: `voice-pool-${index}`,
				agentCwd,
				agentName,
				claimedDbSessionId: null,
				manager: makeSession({
					controlRealtime:
						controlRealtime as unknown as SessionManager["controlRealtime"],
					getCurrentSessionId: vi.fn().mockReturnValue(null),
				}),
				runState: makeRunState(`voice-pool-${index}`),
			} as unknown as PoolEntry;
			voiceEntries.push(entry);
			poolEntries.set(entry.sessionId, entry);
			return entry;
		});
		pool.get.mockImplementation((id: string) => poolEntries.get(id) as never);
		pool.findByDbSessionId.mockImplementation(
			(id: string) => claimedEntries.get(id) as never,
		);
		pool.claimDbSessionId.mockImplementation(
			(candidate: PoolEntry, dbSessionId: string) => {
				candidate.claimedDbSessionId = dbSessionId;
				claimedEntries.set(dbSessionId, candidate);
				return candidate;
			},
		);
		pool.close.mockImplementation((sessionId: string) => {
			const entry = poolEntries.get(sessionId);
			poolEntries.delete(sessionId);
			if (entry?.claimedDbSessionId) {
				claimedEntries.delete(entry.claimedDbSessionId);
			}
		});
		const ws = makeWs("cockpit-dictation");
		wsState.clients.add(ws);
		const { message } = createWsHandlers(pool as never);

		for (const requestId of ["dictation-one", "dictation-two"]) {
			await message(
				ws as never,
				JSON.stringify({
					type: "realtime_start",
					session_id: "cockpit-dictation",
					request_id: requestId,
					mode: "dictation",
					sdp: "v=0\r\no=hlid",
					agent_cwd: "/tmp/voice-agent",
				}),
			);
			await message(
				ws as never,
				JSON.stringify({
					type: "realtime_stop",
					session_id: "cockpit-dictation",
					request_id: requestId,
					mode: "dictation",
				}),
			);
		}

		const starts = controlRealtime.mock.calls.filter(
			([control]) => control.action === "start",
		);
		expect(starts).toHaveLength(2);
		for (const [, options] of starts) {
			expect(options).toEqual(
				expect.objectContaining({
					sessionId: "cockpit-dictation",
					transient: true,
				}),
			);
		}
		expect(voiceEntries).toHaveLength(2);
		expect(pool.close).toHaveBeenNthCalledWith(1, "voice-pool-1");
		expect(pool.close).toHaveBeenNthCalledWith(2, "voice-pool-2");
		expect(dbMock.getSessionSelection).toHaveBeenCalledTimes(2);
		expect(dbMock.getSessionSelection).toHaveBeenNthCalledWith(
			1,
			"cockpit-dictation",
		);
		expect(dbMock.getSessionSelection).toHaveBeenNthCalledWith(
			2,
			"cockpit-dictation",
		);
		expect(ws.data.subscribedSessionId).toBe("vault-id");
	});

	it("treats a late stop for a retired voice session as a no-op", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const ws = makeWs("detached-chat");
		const { message } = createWsHandlers(pool as never);

		await message(
			ws as never,
			JSON.stringify({
				type: "realtime_stop",
				session_id: "detached-chat",
			}),
		);

		expect(session.controlRealtime).not.toHaveBeenCalled();
		expect(mockSend).not.toHaveBeenCalledWith(
			ws,
			expect.objectContaining({ type: "error" }),
		);
	});

	it("acknowledges a mode-bearing late stop after its entry retired", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const ws = makeWs("detached-chat");
		const { message } = createWsHandlers(pool as never);

		await message(
			ws as never,
			JSON.stringify({
				type: "realtime_stop",
				session_id: "detached-chat",
				request_id: "request-late-stop",
				mode: "live",
			}),
		);

		expect(session.controlRealtime).not.toHaveBeenCalled();
		expect(lastSentTo(ws)).toEqual({
			type: "realtime_state",
			session_id: "detached-chat",
			request_id: "request-late-stop",
			mode: "live",
			state: "closed",
		});
	});

	it("acknowledges a mode-bearing stop when the manager emits no terminal", async () => {
		const controlRealtime = vi.fn().mockResolvedValue(undefined);
		const session = makeSession({ controlRealtime });
		const { pool } = wrapSession(session);
		const ws = makeWs();
		const { message } = createWsHandlers(pool as never);

		await message(
			ws as never,
			JSON.stringify({
				type: "realtime_stop",
				session_id: "vault-id",
				request_id: "request-stop-fallback",
				mode: "dictation",
			}),
		);

		expect(controlRealtime).toHaveBeenCalledWith(
			{ action: "stop" },
			expect.objectContaining({
				sessionId: "vault-id",
				requestId: "request-stop-fallback",
			}),
		);
		expect(lastSentTo(ws)).toEqual({
			type: "realtime_state",
			session_id: "vault-id",
			request_id: "request-stop-fallback",
			mode: "dictation",
			state: "closed",
		});
	});

	it("does not duplicate a manager-emitted stop terminal", async () => {
		const terminal: ServerMessage = {
			type: "realtime_state",
			session_id: "vault-id",
			request_id: "request-stop-terminal",
			mode: "read-aloud",
			state: "closed",
		};
		const controlRealtime = vi.fn(
			async (
				_control: unknown,
				options: { emit: (message: ServerMessage) => void },
			) => options.emit(terminal),
		);
		const session = makeSession({ controlRealtime });
		const { pool } = wrapSession(session);
		const ws = makeWs();
		const { message } = createWsHandlers(pool as never);

		await message(
			ws as never,
			JSON.stringify({
				type: "realtime_stop",
				session_id: "vault-id",
				request_id: "request-stop-terminal",
				mode: "read-aloud",
			}),
		);

		expect(
			mockSend.mock.calls.filter(
				([target, event]) =>
					target === ws &&
					event.type === "realtime_state" &&
					event.session_id === "vault-id" &&
					event.request_id === "request-stop-terminal" &&
					event.mode === "read-aloud" &&
					event.state === "closed",
			),
		).toHaveLength(1);
	});

	it("does not let an old terminal suppress the current stop acknowledgement", async () => {
		const controlRealtime = vi.fn(
			async (
				_control: unknown,
				options: { emit: (message: ServerMessage) => void },
			) =>
				options.emit({
					type: "realtime_state",
					session_id: "vault-id",
					request_id: "request-old",
					mode: "live",
					state: "closed",
				}),
		);
		const session = makeSession({ controlRealtime });
		const { pool } = wrapSession(session);
		const ws = makeWs();
		const { message } = createWsHandlers(pool as never);

		await message(
			ws as never,
			JSON.stringify({
				type: "realtime_stop",
				session_id: "vault-id",
				request_id: "request-current",
				mode: "live",
			}),
		);

		const terminals = mockSend.mock.calls.flatMap(([target, event]) =>
			target === ws &&
			event.type === "realtime_state" &&
			event.state === "closed"
				? [event]
				: [],
		);
		expect(terminals.map((event) => event.request_id)).toEqual([
			"request-old",
			"request-current",
		]);
	});
});

describe("message — provider probes", () => {
	it("replays live provider configuration only to the requesting client", async () => {
		const probeProviderSessionConfig = vi.fn(
			(emit: (message: ServerMessage) => void) => {
				emit({
					type: "provider_config_options",
					provider_id: "acp:fake",
					session_id: "mock-db-session",
					activeMode: "build",
					modes: [{ value: "build", label: "Build" }],
				});
			},
		);
		const session = makeSession({ probeProviderSessionConfig });
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "probe_provider_config",
				session_id: "mock-db-session",
			}),
		);

		expect(probeProviderSessionConfig).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({ sessionId: "mock-db-session" }),
		);
		expect(runState.send).toHaveBeenCalledWith(
			ws,
			expect.objectContaining({
				type: "provider_config_options",
				activeMode: "build",
			}),
		);
		expect(runState.broadcast).not.toHaveBeenCalled();
	});

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

describe("message — set_provider_mode", () => {
	it("delegates the live mode and republishes the authoritative snapshot", async () => {
		const setProviderSessionMode = vi.fn().mockResolvedValue(undefined);
		const probeProviderSessionConfig = vi.fn(
			(emit: (message: ServerMessage) => void) => {
				emit({
					type: "provider_config_options",
					provider_id: "acp:fake",
					session_id: "mock-db-session",
					activeMode: "review",
					modes: [{ value: "review", label: "Review" }],
				});
			},
		);
		const session = makeSession({
			setProviderSessionMode,
			probeProviderSessionConfig,
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "set_provider_mode",
				mode: "review",
				session_id: "mock-db-session",
			}),
		);

		expect(setProviderSessionMode).toHaveBeenCalledWith("review");
		expect(runState.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "provider_config_options",
				activeMode: "review",
			}),
		);
	});

	it("restores the live provider's previous non-Plan mode", async () => {
		const restoreProviderSessionMode = vi.fn().mockResolvedValue(undefined);
		const probeProviderSessionConfig = vi.fn(
			(emit: (message: ServerMessage) => void) => {
				emit({
					type: "provider_config_options",
					provider_id: "acp:fake",
					session_id: "mock-db-session",
					activeMode: "review",
					modes: [{ value: "review", label: "Review" }],
				});
			},
		);
		const session = makeSession({
			restoreProviderSessionMode,
			probeProviderSessionConfig,
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "restore_provider_mode",
				session_id: "mock-db-session",
			}),
		);

		expect(restoreProviderSessionMode).toHaveBeenCalledTimes(1);
		expect(runState.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "provider_config_options",
				activeMode: "review",
			}),
		);
	});
});

describe("message — provider-native MCP controls", () => {
	it("routes a live Claude control and reports the native result", async () => {
		const controlMcpServer = vi.fn(
			async (
				_request: unknown,
				options: { emit: (message: ServerMessage) => void },
			) => {
				options.emit({
					type: "mcp_status",
					provider_id: "claude",
					operations: ["reconnect", "toggle"],
					servers: [{ name: "github", status: "connected" }],
				});
				return { providerId: "claude", statuses: [] };
			},
		);
		const session = makeSession({ controlMcpServer });
		const { pool, entry, runState } = wrapSession(session);
		pool.findByDbSessionId.mockReturnValue(entry);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "mcp_control",
				request_id: "request-1",
				session_id: "db-session",
				server_name: "github",
				action: "reconnect",
			}),
		);

		expect(controlMcpServer).toHaveBeenCalledWith(
			{ serverName: "github", action: "reconnect" },
			expect.objectContaining({ sessionId: "db-session" }),
		);
		expect(runState.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "mcp_status", provider_id: "claude" }),
		);
		expect(mockSend).toHaveBeenCalledWith(ws, {
			type: "mcp_control_result",
			request_id: "request-1",
			session_id: "db-session",
			provider_id: "claude",
			server_name: "github",
			action: "reconnect",
		});
	});

	it("returns informational warnings from Claude permission overrides", async () => {
		const controlMcpServer = vi.fn(async () => ({
			providerId: "claude",
			statuses: [],
			warning: "Unknown server name",
		}));
		const session = makeSession({ controlMcpServer });
		const { pool, entry } = wrapSession(session);
		pool.findByDbSessionId.mockReturnValue(entry);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "mcp_control",
				request_id: "request-permission",
				session_id: "db-session",
				server_name: "github",
				action: "permission-auto",
			}),
		);

		expect(mockSend).toHaveBeenCalledWith(ws, {
			type: "mcp_control_result",
			request_id: "request-permission",
			session_id: "db-session",
			provider_id: "claude",
			server_name: "github",
			action: "permission-auto",
			warning: "Unknown server name",
		});
	});

	it("fails closed instead of reviving a detached session", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "mcp_control",
				request_id: "request-2",
				session_id: "archived-session",
				server_name: "github",
				action: "disable",
			}),
		);

		expect(session.controlMcpServer).not.toHaveBeenCalled();
		expect(mockSend).toHaveBeenCalledWith(
			ws,
			expect.objectContaining({
				type: "mcp_control_result",
				request_id: "request-2",
				error: "This MCP session is not live.",
			}),
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
		const { pool, runState } = wrapSession(session);
		const { open } = createWsHandlers(pool as never);
		const ws = makeWs();
		open(ws as never);
		expect(runState.send).toHaveBeenCalledWith(
			ws,
			expect.objectContaining({ type: "status" }),
		);
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
		expect(runState.send).toHaveBeenCalledWith(ws, {
			type: "error",
			message: "Something failed",
		});
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
		const sentChunks = runState.send.mock.calls
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
		const { pool, runState } = wrapSession(session);
		const { open } = createWsHandlers(pool as never);
		const ws = makeWs();
		open(ws as never);
		expect(runState.send).toHaveBeenCalledWith(
			ws,
			expect.objectContaining({ type: "mcp_status" }),
		);
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
		const { pool, runState } = wrapSession(session);
		const { open } = createWsHandlers(pool as never);
		const ws = makeWs();
		// No owner yet — reconnecting client claims ownership
		open(ws as never);
		expect(runState.send).toHaveBeenCalledWith(
			ws,
			expect.objectContaining({
				id: "aqq-1",
				questions: expect.arrayContaining([
					expect.objectContaining({ question: "Which approach?" }),
				]),
			}),
		);
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
		expect(runState.send).toHaveBeenCalledWith(
			other,
			expect.objectContaining({ type: "ask_user_question", id: "aqq-1" }),
		);
	});

	it("replays a held peer question while the provider session is idle", () => {
		const pendingQ = {
			type: "ask_user_question" as const,
			id: "peer-idle-1",
			questions: [
				{
					question: "Deliver this held peer message to Claude?",
					options: ["Deliver to Claude", "Deny"],
					multiSelect: false,
				},
			],
		};
		const session = makeSession({
			isRunning: vi.fn().mockReturnValue(false),
			getPendingAskUserQuestions: vi.fn().mockReturnValue([pendingQ]),
		});
		const { pool, runState } = wrapSession(session);
		const { open } = createWsHandlers(pool as never);
		const ws = makeWs();

		open(ws as never);

		expect(runState.send).toHaveBeenCalledWith(ws, pendingQ);
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
		expect(mockRemoveNotificationPresence).toHaveBeenCalledWith(ws);
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
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(ws as never, JSON.stringify({ type: "sync" }));
		expect(runState.send).toHaveBeenCalledWith(
			ws,
			expect.objectContaining({ type: "status" }),
		);
	});

	it("scopes replayed auto-sleep state to the synced session", async () => {
		const sleep = {
			type: "agent_sleep" as const,
			state: "sleeping" as const,
			providerId: "claude",
			windowId: "five_hour",
			until: 1_784_060_475,
			reason: "threshold" as const,
			utilization: 0.94,
		};
		const session = makeSession({
			getSleepState: vi.fn().mockReturnValue(sleep),
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(ws as never, JSON.stringify({ type: "sync" }));

		expect(runState.send).toHaveBeenCalledWith(ws, sleep);
		expect(mockSend).not.toHaveBeenCalledWith(ws, sleep);
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
		const types = runState.send.mock.calls
			.filter((call) => call[0] === other)
			.map((call) => call[1].type);
		expect(types).toContain("ask_user_question");
		expect(types).toContain("plan_mode_exit");
	});

	it("replays a held peer question on idle sync", async () => {
		const pendingQuestion = {
			type: "ask_user_question" as const,
			id: "peer-idle-sync",
			questions: [
				{
					question: "Deliver this held peer message to Claude?",
					options: ["Deliver to Claude", "Deny"],
					multiSelect: false,
				},
			],
		};
		const session = makeSession({
			isRunning: vi.fn().mockReturnValue(false),
			getPendingAskUserQuestions: vi.fn().mockReturnValue([pendingQuestion]),
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(ws as never, JSON.stringify({ type: "sync" }));

		expect(runState.send).toHaveBeenCalledWith(ws, pendingQuestion);
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

	it("republishes the rolled-back model when native or database application rejects", async () => {
		const operation = Promise.reject(
			new Error("Native model changed, but the database rollback completed"),
		);
		const session = makeSession({
			getCurrentSessionId: vi.fn().mockReturnValue("live-model-session"),
			getStatus: vi.fn().mockReturnValue({
				state: "idle",
				model: "claude-sonnet-4-6",
				effort: "high",
				permission_mode: "default",
			}),
			setModel: vi.fn().mockReturnValue(operation),
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "set_model",
				model: "claude-opus-4-8",
			}),
		);

		expect(session.acknowledgeSessionControlRejection).toHaveBeenCalledWith(
			operation,
		);
		expect(
			mockSend.mock.calls
				.filter((call) => call[0] === ws)
				.map((call) => call[1]),
		).toEqual([
			{
				type: "error",
				message: "Native model changed, but the database rollback completed",
			},
			{
				type: "session_control_rejected",
				control: "model",
				attempted_value: "claude-opus-4-8",
				authoritative_value: "claude-sonnet-4-6",
				session_id: "live-model-session",
			},
		]);
		expect(runState.broadcast).toHaveBeenCalledWith({
			type: "status",
			state: "idle",
			model: "claude-sonnet-4-6",
			effort: "high",
			permission_mode: "default",
		});
	});

	it("uses a newer live model as authoritative when an older control rejects late", async () => {
		const older = deferred();
		let model = "claude-sonnet-4-6";
		const setModel = vi.fn((requested: string | undefined) => {
			if (requested === "claude-opus-4-8") return older.promise;
			model = requested ?? "claude-default";
			return Promise.resolve();
		});
		const session = makeSession({
			getCurrentSessionId: vi.fn().mockReturnValue("live-model-session"),
			getStatus: vi.fn(() => ({
				state: "idle" as const,
				model,
				effort: "high",
				permission_mode: "default" as const,
			})),
			setModel,
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		const stale = message(
			ws as never,
			JSON.stringify({ type: "set_model", model: "claude-opus-4-8" }),
		);
		await vi.waitFor(() =>
			expect(setModel).toHaveBeenCalledWith("claude-opus-4-8"),
		);
		await message(
			ws as never,
			JSON.stringify({ type: "set_model", model: "claude-sonnet-5" }),
		);
		older.reject(new Error("stale native rejection"));
		await stale;

		expect(session.acknowledgeSessionControlRejection).toHaveBeenCalledWith(
			older.promise,
		);
		expect(lastSentTo(ws)).toEqual({
			type: "session_control_rejected",
			control: "model",
			attempted_value: "claude-opus-4-8",
			authoritative_value: "claude-sonnet-5",
			session_id: "live-model-session",
		});
		expect(runState.broadcast).toHaveBeenLastCalledWith({
			type: "status",
			state: "idle",
			model: "claude-sonnet-5",
			effort: "high",
			permission_mode: "default",
		});
	});

	it("routes a database alias to its live entry and suppresses rejection after that entry closes", async () => {
		const late = deferred();
		const aliasedRejection = Promise.reject(
			new Error("aliased model rejected"),
		);
		const setModel = vi
			.fn()
			.mockReturnValueOnce(aliasedRejection)
			.mockReturnValueOnce(late.promise);
		const session = makeSession({
			getCurrentSessionId: vi.fn().mockReturnValue("database-session-alias"),
			getStatus: vi.fn().mockReturnValue({
				state: "idle",
				model: "claude-sonnet-4-6",
				effort: "high",
				permission_mode: "default",
			}),
			setModel,
		});
		const { pool, entry, runState } = wrapSession(session);
		entry.sessionId = "runtime-session-id";
		let closed = false;
		pool.get.mockImplementation((sessionId: string) =>
			!closed && sessionId === "runtime-session-id" ? entry : undefined,
		);
		pool.findByDbSessionId.mockImplementation((sessionId: string) =>
			!closed && sessionId === "database-session-alias" ? entry : undefined,
		);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs("runtime-session-id");

		await message(
			ws as never,
			JSON.stringify({
				type: "set_model",
				session_id: "database-session-alias",
				model: "claude-opus-4-8",
			}),
		);

		expect(setModel).toHaveBeenCalledWith("claude-opus-4-8");
		expect(lastSentTo(ws)).toEqual({
			type: "session_control_rejected",
			control: "model",
			attempted_value: "claude-opus-4-8",
			authoritative_value: "claude-sonnet-4-6",
			session_id: "database-session-alias",
		});

		mockSend.mockClear();
		runState.broadcast.mockClear();
		const pending = message(
			ws as never,
			JSON.stringify({
				type: "set_model",
				session_id: "database-session-alias",
				model: "claude-sonnet-5",
			}),
		);
		await vi.waitFor(() => expect(setModel).toHaveBeenCalledTimes(2));
		closed = true;
		late.reject(new Error("entry closed during native control"));
		await pending;

		expect(session.acknowledgeSessionControlRejection).toHaveBeenCalledWith(
			late.promise,
		);
		expect(mockSend).not.toHaveBeenCalled();
		expect(runState.broadcast).not.toHaveBeenCalled();
	});

	it("persists a model change for a detached chat without reviving it", async () => {
		vi.mocked(dbMock.getSessionSelection)
			.mockResolvedValueOnce({
				agentCwd: "/tmp/test",
				providerId: "codex",
				model: "gpt-5.6-terra",
				effort: "high",
				permissionMode: "default",
			})
			.mockResolvedValueOnce({
				agentCwd: "/tmp/test",
				providerId: "codex",
				model: "gpt-5.6-sol",
				effort: "high",
				permissionMode: "default",
			});
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs("detached-session");

		await message(
			ws as never,
			JSON.stringify({
				type: "set_model",
				session_id: "detached-session",
				model: "gpt-5.6-sol",
			}),
		);

		expect(dbMock.setSessionModel).toHaveBeenCalledWith(
			"detached-session",
			"gpt-5.6-sol",
			expect.objectContaining({ guard: expect.any(Function) }),
		);
		expect(pool.create).not.toHaveBeenCalled();
		expect(session.setModel).not.toHaveBeenCalled();
		expect(lastSentTo(ws)).toEqual(
			expect.objectContaining({
				type: "status",
				session_id: "detached-session",
				model: "gpt-5.6-sol",
			}),
		);
	});

	it("atomically downgrades detached Auto when the requested model is unsupported", async () => {
		vi.mocked(dbMock.setSessionModel).mockClear();
		vi.mocked(dbMock.setSessionModelAndPermissionMode).mockClear();
		vi.mocked(dbMock.getSessionSelection)
			.mockResolvedValueOnce({
				agentCwd: "/tmp/test",
				providerId: "claude",
				model: "claude-opus-4-8",
				effort: "max",
				permissionMode: "auto",
			})
			.mockResolvedValueOnce({
				agentCwd: "/tmp/test",
				providerId: "claude",
				model: "claude-haiku-4-5",
				effort: "max",
				permissionMode: "default",
			});
		let atomicWriteApplied = false;
		vi.mocked(dbMock.setSessionModelAndPermissionMode).mockImplementationOnce(
			async (_sessionId, _model, _mode, options) => {
				if (!options?.guard?.()) return false;
				atomicWriteApplied = true;
				return true;
			},
		);
		const session = makeSession();
		const { pool } = wrapSession(session);
		pool.getDetachedPermissionValidationGeneration.mockReturnValue(44);
		pool.isDetachedPermissionValidationCurrent.mockImplementation(
			(generation: number) => generation === 44,
		);
		pool.validateDetachedPermissionMode.mockRejectedValueOnce(
			new Error("Auto is unsupported by claude-haiku-4-5"),
		);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs("detached-model-auto");

		await message(
			ws as never,
			JSON.stringify({
				type: "set_model",
				session_id: "detached-model-auto",
				model: "claude-haiku-4-5",
			}),
		);

		expect(atomicWriteApplied).toBe(true);
		expect(dbMock.setSessionModelAndPermissionMode).toHaveBeenCalledWith(
			"detached-model-auto",
			"claude-haiku-4-5",
			"default",
			expect.objectContaining({ guard: expect.any(Function) }),
		);
		expect(dbMock.setSessionModel).not.toHaveBeenCalled();
		expect(
			mockSend.mock.calls
				.filter((call) => call[0] === ws)
				.map((call) => call[1]),
		).toEqual([
			{
				type: "session_control_rejected",
				control: "permission_mode",
				attempted_value: "auto",
				authoritative_value: "default",
				session_id: "detached-model-auto",
			},
			{
				type: "status",
				session_id: "detached-model-auto",
				state: "idle",
				model: "claude-haiku-4-5",
				effort: "max",
				permission_mode: "default",
			},
		]);
	});

	it("fails the detached write guard when the archived session revives", async () => {
		vi.mocked(dbMock.getSessionSelection)
			.mockResolvedValueOnce({
				agentCwd: "/tmp/test",
				providerId: "claude",
				model: "claude-sonnet-4-6",
				effort: "high",
				permissionMode: "default",
			})
			.mockResolvedValueOnce({
				agentCwd: "/tmp/test",
				providerId: "claude",
				model: "claude-sonnet-4-6",
				effort: "high",
				permissionMode: "default",
			});
		const session = makeSession();
		const { pool, entry } = wrapSession(session);
		let revived = false;
		let modelWritten = false;
		pool.get.mockImplementation((sessionId: string) => {
			if (sessionId === "vault-id") return entry;
			return revived && sessionId === "reviving-detached" ? entry : undefined;
		});
		pool.findByDbSessionId.mockImplementation(() => undefined);
		vi.mocked(dbMock.setSessionModel).mockImplementationOnce(
			async (_sessionId, _model, options) => {
				revived = true;
				if (!options?.guard?.()) return false;
				modelWritten = true;
				return true;
			},
		);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs("reviving-detached");

		await message(
			ws as never,
			JSON.stringify({
				type: "set_model",
				session_id: "reviving-detached",
				model: "claude-opus-4-8",
			}),
		);

		expect(modelWritten).toBe(false);
		expect(dbMock.setSessionModel).toHaveBeenCalledWith(
			"reviving-detached",
			"claude-opus-4-8",
			expect.objectContaining({ guard: expect.any(Function) }),
		);
		expect(session.setModel).not.toHaveBeenCalled();
	});
});

describe("message — set_effort", () => {
	it("surfaces a live rejection and republishes the authoritative effort", async () => {
		const session = makeSession({
			setEffort: vi.fn().mockRejectedValue(new Error("native effort rejected")),
			getStatus: vi.fn().mockReturnValue({
				state: "idle",
				model: "claude-opus-4-8",
				permission_mode: "default",
				effort: "medium",
			}),
			getCurrentSessionId: vi.fn().mockReturnValue("vault-id"),
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({ type: "set_effort", effort: "max" }),
		);

		expect(
			mockSend.mock.calls
				.filter((call) => call[0] === ws)
				.map((call) => call[1]),
		).toEqual([
			{ type: "error", message: "native effort rejected" },
			{
				type: "session_control_rejected",
				control: "effort",
				attempted_value: "max",
				authoritative_value: "medium",
				session_id: "vault-id",
			},
		]);
		expect(runState.broadcast).toHaveBeenCalledWith({
			type: "status",
			state: "idle",
			model: "claude-opus-4-8",
			permission_mode: "default",
			effort: "medium",
		});
	});

	it("does not publish a late effort rejection after the owning entry closes", async () => {
		const applyGate = deferred();
		const session = makeSession({
			setEffort: vi.fn().mockReturnValue(applyGate.promise),
			getCurrentSessionId: vi.fn().mockReturnValue("vault-id"),
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		const pending = message(
			ws as never,
			JSON.stringify({ type: "set_effort", effort: "max" }),
		);
		await vi.waitFor(() =>
			expect(session.setEffort).toHaveBeenCalledWith("max"),
		);
		pool.get.mockReturnValue(undefined);
		pool.findByDbSessionId.mockReturnValue(undefined);
		applyGate.reject(new Error("late native rejection"));
		await pending;

		expect(mockSend).not.toHaveBeenCalled();
		expect(runState.broadcast).not.toHaveBeenCalled();
	});

	it("rejects an unsupported detached effort before persistence", async () => {
		const selection = {
			agentCwd: "/tmp/test",
			providerId: "cliproxy-codex",
			model: "gpt-5.6-sol",
			effort: "xhigh",
			permissionMode: "default",
		};
		vi.mocked(dbMock.getSessionSelection)
			.mockResolvedValueOnce(selection)
			.mockResolvedValueOnce(selection);
		mockLoadConfig.mockReturnValueOnce({
			vault: { path: "/tmp/test", name: "Test Vault" },
			claude: {
				model: "test-model",
				effort: "medium",
				permission_mode: "default",
				turn_recaps: false,
			},
			cliproxy: {
				model: "gpt-5.6-sol",
				effort: "xhigh",
				permission_mode: "default",
				turn_recaps: false,
			},
			agents: [],
		});
		const session = makeSession();
		const { pool } = wrapSession(session);
		pool.getProvider.mockReturnValue({
			providerId: "cliproxy-codex",
			label: "Claude Code · CLIProxy",
			effortLevels: [{ value: "xhigh", label: "X-High" }],
		} as never);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs("detached-cliproxy");
		vi.mocked(dbMock.setSessionEffort).mockClear();

		await message(
			ws as never,
			JSON.stringify({
				type: "set_effort",
				session_id: "detached-cliproxy",
				effort: "max",
			}),
		);

		expect(
			mockSend.mock.calls
				.filter((call) => call[0] === ws)
				.map((call) => call[1]),
		).toEqual([
			{
				type: "error",
				message: "Claude Code · CLIProxy does not support effort max",
			},
			{
				type: "session_control_rejected",
				control: "effort",
				attempted_value: "max",
				authoritative_value: "xhigh",
				session_id: "detached-cliproxy",
			},
			{
				type: "status",
				session_id: "detached-cliproxy",
				state: "idle",
				model: "gpt-5.6-sol",
				effort: "xhigh",
				permission_mode: "default",
			},
		]);
		expect(dbMock.setSessionEffort).not.toHaveBeenCalled();
		expect(session.setEffort).not.toHaveBeenCalled();
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

	it.each([
		["Auto validation", "Auto is unavailable for claude-opus-4-8"],
		["database commit", "Could not persist provider selection"],
	])("rolls back provider and Auto after a live %s rejection", async (_failureKind, messageText) => {
		const operation = Promise.reject(new Error(messageText));
		const session = makeSession({
			getCurrentSessionId: vi.fn().mockReturnValue("live-provider-session"),
			getProviderId: vi.fn().mockReturnValue("codex"),
			getStatus: vi.fn().mockReturnValue({
				state: "idle",
				model: "gpt-5.6-sol",
				effort: "high",
				permission_mode: "default",
			}),
			setProvider: vi.fn().mockReturnValue(operation),
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "set_provider",
				provider: "claude",
				model: "claude-opus-4-8",
				effort: "max",
				permission_mode: "auto",
			}),
		);

		expect(session.acknowledgeSessionControlRejection).toHaveBeenCalledWith(
			operation,
		);
		expect(
			mockSend.mock.calls
				.filter((call) => call[0] === ws)
				.map((call) => call[1]),
		).toEqual([
			{ type: "error", message: messageText },
			{
				type: "session_control_rejected",
				control: "provider",
				attempted_value: "claude",
				authoritative_value: "codex",
				session_id: "live-provider-session",
			},
			{
				type: "session_control_rejected",
				control: "permission_mode",
				attempted_value: "auto",
				authoritative_value: "default",
				session_id: "live-provider-session",
			},
		]);
		expect(runState.broadcast).toHaveBeenCalledWith({
			type: "status",
			state: "idle",
			model: "gpt-5.6-sol",
			effort: "high",
			permission_mode: "default",
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

	it("rejects an unsupported detached provider effort before persistence", async () => {
		const selection = {
			agentCwd: "/tmp/test",
			providerId: "claude",
			model: "claude-sonnet-4-6",
			effort: "high",
			permissionMode: "default",
		};
		vi.mocked(dbMock.getSessionSelection)
			.mockResolvedValueOnce(selection)
			.mockResolvedValueOnce(selection);
		const session = makeSession();
		const { pool } = wrapSession(session);
		pool.getProvider.mockReturnValue({
			providerId: "cliproxy-codex",
			label: "Claude Code · CLIProxy",
			effortLevels: [{ value: "xhigh", label: "X-High" }],
		} as never);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs("detached-provider-effort");
		vi.mocked(dbMock.setSessionProviderSelection).mockClear();

		await message(
			ws as never,
			JSON.stringify({
				type: "set_provider",
				session_id: "detached-provider-effort",
				provider: "cliproxy-codex",
				model: "gpt-5.6-sol",
				effort: "max",
			}),
		);

		expect(
			mockSend.mock.calls
				.filter((call) => call[0] === ws)
				.map((call) => call[1]),
		).toEqual([
			{
				type: "error",
				message: "Claude Code · CLIProxy does not support effort max",
			},
			{
				type: "session_control_rejected",
				control: "provider",
				attempted_value: "cliproxy-codex",
				authoritative_value: "claude",
				session_id: "detached-provider-effort",
			},
			{
				type: "session_control_rejected",
				control: "effort",
				attempted_value: "max",
				authoritative_value: "high",
				session_id: "detached-provider-effort",
			},
			{
				type: "status",
				session_id: "detached-provider-effort",
				state: "idle",
				model: "claude-sonnet-4-6",
				effort: "high",
				permission_mode: "default",
			},
		]);
		expect(dbMock.setSessionProviderSelection).not.toHaveBeenCalled();
		expect(session.setProvider).not.toHaveBeenCalled();
	});
});

// ── message: workflow_control ─────────────────────────────────────────────────

describe("message — workflow_control", () => {
	it("stops a native provider task in the addressed live session", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "workflow_control",
				action: "stop",
				task_id: "workflow-task-1",
				session_id: "vault-id",
			}),
		);

		expect(session.stopProviderTask).toHaveBeenCalledWith("workflow-task-1");
	});

	it("surfaces a native task-control failure", async () => {
		const session = makeSession({
			stopProviderTask: vi
				.fn()
				.mockRejectedValue(new Error("Workflow is already complete")),
		});
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "workflow_control",
				action: "stop",
				task_id: "workflow-task-1",
			}),
		);

		expect(lastSentTo(ws)).toEqual({
			type: "error",
			message: "Workflow is already complete",
		});
	});

	it("rejects a control addressed to a session that is no longer live", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "workflow_control",
				action: "stop",
				task_id: "workflow-task-1",
				session_id: "archived-session",
			}),
		);

		expect(session.stopProviderTask).not.toHaveBeenCalled();
		expect(lastSentTo(ws)).toEqual({
			type: "error",
			message: "This workflow session is not live.",
		});
	});
});

describe("message — background_activity_control", () => {
	it("terminates one exact native activity in the addressed live session", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "background_activity_control",
				action: "terminate",
				activity_id: "item-1",
				session_id: "vault-id",
			}),
		);

		expect(session.controlProviderBackgroundActivity).toHaveBeenCalledWith({
			action: "terminate",
			activityId: "item-1",
		});

		await message(
			ws as never,
			JSON.stringify({
				type: "background_activity_control",
				action: "background",
				session_id: "vault-id",
			}),
		);
		expect(session.controlProviderBackgroundActivity).toHaveBeenLastCalledWith({
			action: "background",
		});
	});

	it("rejects background control when the owning session is detached", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "background_activity_control",
				action: "clean",
				session_id: "archived-session",
			}),
		);

		expect(session.controlProviderBackgroundActivity).not.toHaveBeenCalled();
		expect(lastSentTo(ws)).toEqual({
			type: "error",
			message: "This provider background activity session is not live.",
		});
	});
});

describe("message — workflow catalog and save", () => {
	it("sends scoped workflow discovery only to the requesting client", async () => {
		const probeWorkflowCatalog = vi.fn(
			async (emit: (message: ServerMessage) => void) => {
				emit({
					type: "workflow_catalog",
					provider_id: "claude",
					workflows: [],
					locations: [],
				});
			},
		);
		const session = makeSession({ probeWorkflowCatalog });
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({ type: "probe_workflows", session_id: "vault-id" }),
		);

		expect(probeWorkflowCatalog).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({ sessionId: "vault-id" }),
		);
		expect(runState.send).toHaveBeenCalledWith(
			ws,
			expect.objectContaining({ type: "workflow_catalog" }),
		);
		expect(runState.broadcast).not.toHaveBeenCalled();
	});

	it("saves a workflow, returns it, and refreshes the catalog", async () => {
		const workflow = {
			id: "claude-workflow:audit",
			name: "audit",
			description: "Audit the project",
			argumentHint: "[input]",
			scriptPath: "/tmp/test/.claude/workflows/audit.js",
			scope: "project" as const,
			scopeLabel: "Project",
			availableAsCommand: true,
		};
		const saveProviderWorkflow = vi.fn().mockResolvedValue(workflow);
		const probeWorkflowCatalog = vi.fn().mockResolvedValue(undefined);
		const session = makeSession({
			saveProviderWorkflow,
			probeWorkflowCatalog,
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "save_workflow",
				request_id: "save-1",
				session_id: "vault-id",
				source_script_path:
					"/tmp/.claude/projects/project/session/workflows/scripts/audit.js",
				scope: "project",
			}),
		);

		expect(saveProviderWorkflow).toHaveBeenCalledWith(
			{
				sourceScriptPath:
					"/tmp/.claude/projects/project/session/workflows/scripts/audit.js",
				scope: "project",
				overwrite: undefined,
			},
			{
				agentCwd: undefined,
				sessionId: "vault-id",
				providerId: undefined,
			},
		);
		expect(runState.send).toHaveBeenCalledWith(ws, {
			type: "workflow_save_result",
			request_id: "save-1",
			workflow,
		});
		expect(probeWorkflowCatalog).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({
				agentCwd: undefined,
				sessionId: "vault-id",
			}),
		);
	});

	it("returns a typed collision without refreshing the catalog", async () => {
		const saveProviderWorkflow = vi
			.fn()
			.mockRejectedValue(
				new ClaudeWorkflowSaveError(
					"/audit already exists in the project workflow location.",
					"exists",
				),
			);
		const probeWorkflowCatalog = vi.fn().mockResolvedValue(undefined);
		const session = makeSession({
			saveProviderWorkflow,
			probeWorkflowCatalog,
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "save_workflow",
				request_id: "save-2",
				source_script_path:
					"/tmp/.claude/projects/project/session/workflows/scripts/audit.js",
				scope: "project",
			}),
		);

		expect(runState.send).toHaveBeenCalledWith(ws, {
			type: "workflow_save_result",
			request_id: "save-2",
			error: "/audit already exists in the project workflow location.",
			error_code: "exists",
		});
		expect(probeWorkflowCatalog).not.toHaveBeenCalled();
	});

	it("deletes an exact saved workflow and refreshes the catalog", async () => {
		const deleteProviderWorkflow = vi.fn().mockResolvedValue(undefined);
		const probeWorkflowCatalog = vi.fn().mockResolvedValue(undefined);
		const session = makeSession({
			deleteProviderWorkflow,
			probeWorkflowCatalog,
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "delete_workflow",
				request_id: "delete-1",
				session_id: "vault-id",
				script_path: "/tmp/test/.claude/workflows/audit.js",
				scope: "project",
			}),
		);

		expect(deleteProviderWorkflow).toHaveBeenCalledWith(
			{
				scriptPath: "/tmp/test/.claude/workflows/audit.js",
				scope: "project",
			},
			{
				agentCwd: undefined,
				sessionId: "vault-id",
				providerId: undefined,
			},
		);
		expect(runState.send).toHaveBeenCalledWith(ws, {
			type: "workflow_delete_result",
			request_id: "delete-1",
			script_path: "/tmp/test/.claude/workflows/audit.js",
		});
		expect(probeWorkflowCatalog).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({ sessionId: "vault-id" }),
		);
	});

	it("returns a typed delete miss without refreshing the catalog", async () => {
		const deleteProviderWorkflow = vi
			.fn()
			.mockRejectedValue(
				new ClaudeWorkflowDeleteError(
					"This saved workflow could not be found.",
					"not-found",
				),
			);
		const probeWorkflowCatalog = vi.fn().mockResolvedValue(undefined);
		const session = makeSession({
			deleteProviderWorkflow,
			probeWorkflowCatalog,
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "delete_workflow",
				request_id: "delete-2",
				script_path: "/tmp/test/.claude/workflows/missing.js",
				scope: "project",
			}),
		);

		expect(runState.send).toHaveBeenCalledWith(ws, {
			type: "workflow_delete_result",
			request_id: "delete-2",
			error: "This saved workflow could not be found.",
			error_code: "not-found",
		});
		expect(probeWorkflowCatalog).not.toHaveBeenCalled();
	});

	it("reads one workflow definition without refreshing the catalog", async () => {
		const source = 'export const meta = { name: "audit" }';
		const readProviderWorkflowSource = vi.fn().mockResolvedValue(source);
		const probeWorkflowCatalog = vi.fn().mockResolvedValue(undefined);
		const session = makeSession({
			readProviderWorkflowSource,
			probeWorkflowCatalog,
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "read_workflow_source",
				request_id: "source-1",
				session_id: "vault-id",
				script_path: "/tmp/test/.claude/workflows/audit.js",
				scope: "project",
			}),
		);

		expect(readProviderWorkflowSource).toHaveBeenCalledWith(
			{
				scriptPath: "/tmp/test/.claude/workflows/audit.js",
				scope: "project",
			},
			{
				agentCwd: undefined,
				sessionId: "vault-id",
				providerId: undefined,
			},
		);
		expect(runState.send).toHaveBeenCalledWith(ws, {
			type: "workflow_source_result",
			request_id: "source-1",
			script_path: "/tmp/test/.claude/workflows/audit.js",
			source,
		});
		expect(probeWorkflowCatalog).not.toHaveBeenCalled();
	});

	it("returns a typed workflow-definition access error", async () => {
		const readProviderWorkflowSource = vi
			.fn()
			.mockRejectedValue(
				new ClaudeWorkflowSourceError(
					"This workflow definition is outside Claude's persisted scripts.",
					"unsafe-path",
				),
			);
		const session = makeSession({ readProviderWorkflowSource });
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "read_workflow_source",
				request_id: "source-2",
				script_path: "/tmp/outside.js",
			}),
		);

		expect(runState.send).toHaveBeenCalledWith(ws, {
			type: "workflow_source_result",
			request_id: "source-2",
			script_path: "/tmp/outside.js",
			error: "This workflow definition is outside Claude's persisted scripts.",
			error_code: "unsafe-path",
		});
	});

	it("saves from an archived session without creating or reviving it", async () => {
		const selection = {
			agentCwd: "/tmp/archived-project",
			providerId: "claude",
			model: "claude-test",
			effort: "medium",
			permissionMode: "default",
		};
		vi.mocked(dbMock.getSessionSelection)
			.mockResolvedValueOnce(selection)
			.mockResolvedValueOnce(selection);
		const session = makeSession();
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs("archived-session");

		await message(
			ws as never,
			JSON.stringify({
				type: "save_workflow",
				request_id: "save-3",
				session_id: "archived-session",
				source_script_path:
					"/tmp/.claude/projects/project/session/workflows/scripts/audit.js",
				scope: "personal",
			}),
		);

		expect(pool.create).not.toHaveBeenCalled();
		expect(session.saveProviderWorkflow).toHaveBeenCalledWith(
			{
				sourceScriptPath:
					"/tmp/.claude/projects/project/session/workflows/scripts/audit.js",
				scope: "personal",
				overwrite: undefined,
			},
			{
				agentCwd: "/tmp/archived-project",
				sessionId: "archived-session",
				providerId: "claude",
			},
		);
		expect(session.probeWorkflowCatalog).toHaveBeenCalledWith(
			expect.any(Function),
			{
				agentCwd: "/tmp/archived-project",
				sessionId: "archived-session",
				providerId: "claude",
			},
		);
		expect(runState.send).not.toHaveBeenCalled();
		expect(lastSentTo(ws)).toEqual({
			type: "workflow_save_result",
			request_id: "save-3",
			workflow: {
				id: "claude-workflow:audit",
				name: "audit",
				description: "Audit the project",
				argumentHint: "[input]",
				scriptPath: "/tmp/test/.claude/workflows/audit.js",
				scope: "project",
				scopeLabel: "Project",
				availableAsCommand: true,
			},
		});
	});

	it("reports a missing archived session instead of saving in the vault scope", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs("missing-session");

		await message(
			ws as never,
			JSON.stringify({
				type: "save_workflow",
				request_id: "save-4",
				session_id: "missing-session",
				source_script_path: "/tmp/audit.js",
				scope: "project",
			}),
		);

		expect(session.saveProviderWorkflow).not.toHaveBeenCalled();
		expect(pool.create).not.toHaveBeenCalled();
		expect(lastSentTo(ws)).toEqual({
			type: "workflow_save_result",
			request_id: "save-4",
			error: "This workflow session could not be found.",
		});
	});

	it("deletes from an archived session without creating or reviving it", async () => {
		const selection = {
			agentCwd: "/tmp/archived-project",
			providerId: "claude",
			model: "claude-test",
			effort: "medium",
			permissionMode: "default",
		};
		vi.mocked(dbMock.getSessionSelection)
			.mockResolvedValueOnce(selection)
			.mockResolvedValueOnce(selection);
		const session = makeSession();
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs("archived-session");

		await message(
			ws as never,
			JSON.stringify({
				type: "delete_workflow",
				request_id: "delete-3",
				session_id: "archived-session",
				script_path: "/tmp/archived-project/.claude/workflows/audit.js",
				scope: "project",
			}),
		);

		expect(pool.create).not.toHaveBeenCalled();
		expect(session.deleteProviderWorkflow).toHaveBeenCalledWith(
			{
				scriptPath: "/tmp/archived-project/.claude/workflows/audit.js",
				scope: "project",
			},
			{
				agentCwd: "/tmp/archived-project",
				sessionId: "archived-session",
				providerId: "claude",
			},
		);
		expect(session.probeWorkflowCatalog).toHaveBeenCalledWith(
			expect.any(Function),
			{
				agentCwd: "/tmp/archived-project",
				sessionId: "archived-session",
				providerId: "claude",
			},
		);
		expect(runState.send).not.toHaveBeenCalled();
		expect(lastSentTo(ws)).toEqual({
			type: "workflow_delete_result",
			request_id: "delete-3",
			script_path: "/tmp/archived-project/.claude/workflows/audit.js",
		});
	});

	it("reads a workflow definition from an archived session without reviving it", async () => {
		const selection = {
			agentCwd: "/tmp/archived-project",
			providerId: "claude",
			model: "claude-test",
			effort: "medium",
			permissionMode: "default",
		};
		vi.mocked(dbMock.getSessionSelection)
			.mockResolvedValueOnce(selection)
			.mockResolvedValueOnce(selection);
		const source = 'export const meta = { name: "audit" }';
		const session = makeSession({
			readProviderWorkflowSource: vi.fn().mockResolvedValue(source),
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs("archived-session");

		await message(
			ws as never,
			JSON.stringify({
				type: "read_workflow_source",
				request_id: "source-3",
				session_id: "archived-session",
				script_path: "/tmp/archived-project/.claude/workflows/audit.js",
				scope: "project",
			}),
		);

		expect(pool.create).not.toHaveBeenCalled();
		expect(session.readProviderWorkflowSource).toHaveBeenCalledWith(
			{
				scriptPath: "/tmp/archived-project/.claude/workflows/audit.js",
				scope: "project",
			},
			{
				agentCwd: "/tmp/archived-project",
				sessionId: "archived-session",
				providerId: "claude",
			},
		);
		expect(runState.send).not.toHaveBeenCalled();
		expect(lastSentTo(ws)).toEqual({
			type: "workflow_source_result",
			request_id: "source-3",
			script_path: "/tmp/archived-project/.claude/workflows/audit.js",
			source,
		});
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
			getLastMcpStatus: vi
				.fn()
				.mockReturnValue([
					{ name: "github", status: "connected", scope: "project" },
				]),
			getMcpControlOperations: vi.fn().mockReturnValue(["reconnect"]),
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
		expect(runState.broadcast).toHaveBeenCalledWith({
			type: "mcp_status",
			provider_id: "claude",
			operations: ["reconnect"],
			servers: [
				expect.objectContaining({
					name: "github",
					status: "connected",
				}),
			],
		});
	});

	it("sends a correlated rejection and authoritative status when the mode is rejected", async () => {
		const session = makeSession({
			getStatus: vi.fn().mockReturnValue({
				state: "idle",
				model: "test-model",
				permission_mode: "default",
				effort: "medium",
			}),
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
		expect(mockSend).toHaveBeenCalledWith(ws, {
			type: "error",
			message: "Unknown permission mode: bogus",
		});
		expect(lastSentTo(ws)).toEqual({
			type: "session_control_rejected",
			control: "permission_mode",
			attempted_value: "bogus",
			authoritative_value: "default",
			session_id: "mock-db-session",
		});
		expect(runState.broadcast).toHaveBeenCalledWith({
			type: "status",
			state: "idle",
			model: "test-model",
			permission_mode: "default",
			effort: "medium",
		});
	});

	it("acknowledges a live rejection so only an already-captured adjacent chat fails", async () => {
		const permissionControl = deferred();
		let acknowledged = false;
		let chatCalls = 0;
		const acknowledgeSessionControlRejection = vi.fn(
			(operation: Promise<void> | undefined) => {
				if (operation === permissionControl.promise) acknowledged = true;
			},
		);
		const runQuery = vi.fn(() => {
			chatCalls++;
			if (chatCalls === 1) return permissionControl.promise;
			return acknowledged
				? Promise.resolve()
				: Promise.reject(new Error("rejected control remained sticky"));
		});
		const session = makeSession({
			getCurrentSessionId: vi.fn().mockReturnValue("live-permission-session"),
			getStatus: vi.fn().mockReturnValue({
				state: "idle",
				model: "claude-opus-4-8",
				effort: "max",
				permission_mode: "default",
			}),
			setPermissionMode: vi.fn().mockReturnValue(permissionControl.promise),
			acknowledgeSessionControlRejection,
			runQuery,
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		const rejectedControl = message(
			ws as never,
			JSON.stringify({ type: "set_permission_mode", mode: "auto" }),
		);
		await vi.waitFor(() =>
			expect(session.setPermissionMode).toHaveBeenCalledWith("auto"),
		);
		const adjacentChat = message(
			ws as never,
			JSON.stringify({
				type: "chat",
				text: "captured next to rejected control",
				turn_id: "adjacent-turn",
			}),
		);
		await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());

		permissionControl.reject(new Error("native Auto rejection"));
		await Promise.all([rejectedControl, adjacentChat]);

		expect(acknowledgeSessionControlRejection).toHaveBeenCalledWith(
			permissionControl.promise,
		);
		expect(
			mockSend.mock.calls
				.filter((call) => call[0] === ws)
				.map((call) => call[1]),
		).toEqual(
			expect.arrayContaining([
				{ type: "error", message: "native Auto rejection" },
				{
					type: "session_control_rejected",
					control: "permission_mode",
					attempted_value: "auto",
					authoritative_value: "default",
					session_id: "live-permission-session",
				},
				{
					type: "error",
					message: "native Auto rejection",
					turn_scoped: true,
					turn_id: "adjacent-turn",
				},
			]),
		);
		expect(runState.broadcast).toHaveBeenCalledWith({
			type: "status",
			state: "idle",
			model: "claude-opus-4-8",
			effort: "max",
			permission_mode: "default",
		});

		mockSend.mockClear();
		await message(
			ws as never,
			JSON.stringify({
				type: "chat",
				text: "later unrelated turn",
				turn_id: "later-turn",
			}),
		);
		expect(runQuery).toHaveBeenCalledTimes(2);
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("serializes detached controls per session across deferred validation and persistence", async () => {
		const probeA = deferred();
		const writeA = deferred();
		const order: string[] = [];
		vi.mocked(dbMock.getSessionSelection)
			.mockResolvedValueOnce({
				agentCwd: "/tmp/test",
				providerId: "claude",
				model: "claude-opus-4-8",
				effort: "max",
				permissionMode: "default",
			})
			.mockResolvedValueOnce({
				agentCwd: "/tmp/test",
				providerId: "claude",
				model: "claude-opus-4-8",
				effort: "max",
				permissionMode: "auto",
			})
			.mockResolvedValueOnce({
				agentCwd: "/tmp/test",
				providerId: "claude",
				model: "claude-opus-4-8",
				effort: "max",
				permissionMode: "auto",
			})
			.mockResolvedValueOnce({
				agentCwd: "/tmp/test",
				providerId: "claude",
				model: "claude-opus-4-8",
				effort: "max",
				permissionMode: "dontAsk",
			});
		vi.mocked(dbMock.setSessionPermissionMode)
			.mockImplementationOnce(async (_sessionId, _mode, options) => {
				order.push("write-A:start");
				expect(options?.guard?.()).toBe(true);
				await writeA.promise;
				order.push("write-A:end");
				return true;
			})
			.mockImplementationOnce(async (_sessionId, _mode, options) => {
				order.push("write-B");
				expect(options?.guard?.()).toBe(true);
				return true;
			});
		const session = makeSession();
		const { pool } = wrapSession(session);
		pool.validateDetachedPermissionMode
			.mockImplementationOnce(async () => {
				order.push("probe-A:start");
				await probeA.promise;
				order.push("probe-A:end");
				return 12;
			})
			.mockImplementationOnce(async () => {
				order.push("probe-B");
				return 12;
			});
		pool.getDetachedPermissionValidationGeneration.mockReturnValue(12);
		pool.isDetachedPermissionValidationCurrent.mockImplementation(
			(generation: number) => generation === 12,
		);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs("detached-fifo");

		const first = message(
			ws as never,
			JSON.stringify({
				type: "set_permission_mode",
				session_id: "detached-fifo",
				mode: "auto",
			}),
		);
		await vi.waitFor(() =>
			expect(pool.validateDetachedPermissionMode).toHaveBeenCalledTimes(1),
		);
		const second = message(
			ws as never,
			JSON.stringify({
				type: "set_permission_mode",
				session_id: "detached-fifo",
				mode: "dontAsk",
			}),
		);
		await Promise.resolve();
		expect(pool.validateDetachedPermissionMode).toHaveBeenCalledTimes(1);
		expect(dbMock.setSessionPermissionMode).not.toHaveBeenCalled();

		probeA.resolve();
		await vi.waitFor(() =>
			expect(dbMock.setSessionPermissionMode).toHaveBeenCalledTimes(1),
		);
		expect(pool.validateDetachedPermissionMode).toHaveBeenCalledTimes(1);
		writeA.resolve();
		await first;
		await vi.waitFor(() =>
			expect(pool.validateDetachedPermissionMode).toHaveBeenCalledTimes(2),
		);
		await second;

		expect(order).toEqual([
			"probe-A:start",
			"probe-A:end",
			"write-A:start",
			"write-A:end",
			"probe-B",
			"write-B",
		]);
		expect(
			vi.mocked(dbMock.setSessionPermissionMode).mock.calls.slice(-2),
		).toEqual([
			["detached-fifo", "auto", expect.any(Object)],
			["detached-fifo", "dontAsk", expect.any(Object)],
		]);
		expect(pool.create).not.toHaveBeenCalled();
	});

	it("narrows a saved invalid detached Auto mode with a guarded compare-and-set", async () => {
		vi.mocked(dbMock.getSessionSelection)
			.mockResolvedValueOnce({
				agentCwd: "/tmp/test",
				providerId: "claude",
				model: "claude-opus-4-8",
				effort: "max",
				permissionMode: "auto",
			})
			.mockResolvedValueOnce({
				agentCwd: "/tmp/test",
				providerId: "claude",
				model: "claude-opus-4-8",
				effort: "max",
				permissionMode: "default",
			});
		let narrowed = false;
		vi.mocked(dbMock.setSessionPermissionMode).mockImplementationOnce(
			async (_sessionId, _mode, options) => {
				if (!options?.guard?.()) return false;
				narrowed = true;
				return true;
			},
		);
		const session = makeSession();
		const { pool } = wrapSession(session);
		pool.getDetachedPermissionValidationGeneration.mockReturnValue(21);
		pool.isDetachedPermissionValidationCurrent.mockImplementation(
			(generation: number) => generation === 21,
		);
		pool.validateDetachedPermissionMode.mockRejectedValueOnce(
			new Error("Auto was disabled by effective Claude settings"),
		);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs("detached-invalid-auto");

		await message(
			ws as never,
			JSON.stringify({
				type: "set_permission_mode",
				session_id: "detached-invalid-auto",
				mode: "auto",
			}),
		);

		expect(narrowed).toBe(true);
		expect(dbMock.setSessionPermissionMode).toHaveBeenCalledWith(
			"detached-invalid-auto",
			"default",
			expect.objectContaining({ guard: expect.any(Function) }),
		);
		expect(pool.isDetachedPermissionValidationCurrent).toHaveBeenCalledWith(21);
		expect(
			mockSend.mock.calls
				.filter((call) => call[0] === ws)
				.map((call) => call[1]),
		).toEqual([
			{
				type: "error",
				message: "Auto was disabled by effective Claude settings",
			},
			{
				type: "session_control_rejected",
				control: "permission_mode",
				attempted_value: "auto",
				authoritative_value: "default",
				session_id: "detached-invalid-auto",
			},
			{
				type: "status",
				session_id: "detached-invalid-auto",
				state: "idle",
				model: "claude-opus-4-8",
				effort: "max",
				permission_mode: "default",
			},
		]);
	});

	it("prevents detached Auto and auto-review writes after config generation drift", async () => {
		vi.mocked(dbMock.getSessionSelection)
			.mockResolvedValueOnce({
				agentCwd: "/tmp/test",
				providerId: "claude",
				model: "claude-opus-4-8",
				effort: "max",
				permissionMode: "default",
			})
			.mockResolvedValueOnce({
				agentCwd: "/tmp/test",
				providerId: "codex",
				model: "gpt-5.6-sol",
				effort: "high",
				permissionMode: "default",
				approvalsReviewer: "user",
			});
		let autoWritten = false;
		let reviewerWritten = false;
		vi.mocked(dbMock.setSessionPermissionMode).mockImplementationOnce(
			async (_sessionId, _mode, options) => {
				if (!options?.guard?.()) return false;
				autoWritten = true;
				return true;
			},
		);
		vi.mocked(dbMock.setSessionApprovalsReviewer).mockImplementationOnce(
			async (_sessionId, _reviewer, options) => {
				if (!options?.guard?.()) return false;
				reviewerWritten = true;
				return true;
			},
		);
		const session = makeSession();
		const { pool } = wrapSession(session);
		pool.getDetachedPermissionValidationGeneration
			.mockReturnValueOnce(31)
			.mockReturnValueOnce(32);
		pool.validateDetachedPermissionMode.mockResolvedValueOnce(31);
		pool.isDetachedPermissionValidationCurrent.mockReturnValue(false);
		pool.getProvider.mockImplementation((providerId: string) =>
			providerId === "codex"
				? {
						providerId: "codex",
						label: "Codex",
						approvalReviewers: [
							{ value: "user", label: "User", isDefault: true },
							{ value: "auto_review", label: "Auto-review" },
						],
					}
				: { providerId },
		);
		const { message } = createWsHandlers(pool as never);

		await message(
			makeWs("detached-auto-drift") as never,
			JSON.stringify({
				type: "set_permission_mode",
				session_id: "detached-auto-drift",
				mode: "auto",
			}),
		).catch(() => undefined);
		await message(
			makeWs("detached-review-drift") as never,
			JSON.stringify({
				type: "set_approvals_reviewer",
				session_id: "detached-review-drift",
				reviewer: "auto_review",
			}),
		);

		expect(autoWritten).toBe(false);
		expect(reviewerWritten).toBe(false);
		expect(pool.isDetachedPermissionValidationCurrent).toHaveBeenCalledWith(31);
		expect(pool.isDetachedPermissionValidationCurrent).toHaveBeenCalledWith(32);
	});
});

// ── message: set_approvals_reviewer ──────────────────────────────────────────

describe("message — set_approvals_reviewer", () => {
	it("routes a live change and broadcasts the updated reviewer", async () => {
		const session = makeSession({
			getStatus: vi.fn().mockReturnValue({
				state: "idle",
				model: "gpt-5.6-sol",
				permission_mode: "default",
				effort: "medium",
				approvals_reviewer: "auto_review",
			}),
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "set_approvals_reviewer",
				reviewer: "auto_review",
			}),
		);

		expect(session.setApprovalsReviewer).toHaveBeenCalledWith("auto_review");
		expect(runState.broadcast).toHaveBeenCalledWith({
			type: "status",
			state: "idle",
			model: "gpt-5.6-sol",
			permission_mode: "default",
			effort: "medium",
			approvals_reviewer: "auto_review",
		});
	});

	it("surfaces a live policy rejection without broadcasting", async () => {
		const session = makeSession({
			setApprovalsReviewer: vi
				.fn()
				.mockRejectedValue(
					new Error(
						"Auto-review is unavailable while Hlid policy enforcement is enabled.",
					),
				),
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "set_approvals_reviewer",
				reviewer: "auto_review",
			}),
		);

		expect(lastSentTo(ws)).toEqual({
			type: "error",
			message:
				"Auto-review is unavailable while Hlid policy enforcement is enabled.",
		});
		expect(runState.broadcast).not.toHaveBeenCalled();
	});

	it("persists a detached chat change without reviving its provider", async () => {
		vi.mocked(dbMock.getSessionSelection)
			.mockResolvedValueOnce({
				agentCwd: "/tmp/test",
				providerId: "codex",
				model: "gpt-5.6-sol",
				effort: "medium",
				permissionMode: "default",
				approvalsReviewer: "user",
			})
			.mockResolvedValueOnce({
				agentCwd: "/tmp/test",
				providerId: "codex",
				model: "gpt-5.6-sol",
				effort: "medium",
				permissionMode: "default",
				approvalsReviewer: "auto_review",
			});
		const session = makeSession();
		const { pool } = wrapSession(session);
		pool.getProvider.mockReturnValue({
			providerId: "codex",
			label: "Codex",
			approvalReviewers: [
				{ value: "user", label: "User review", isDefault: true },
				{ value: "auto_review", label: "Auto-review" },
			],
		} as never);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs("detached-review");

		await message(
			ws as never,
			JSON.stringify({
				type: "set_approvals_reviewer",
				session_id: "detached-review",
				reviewer: "auto_review",
			}),
		);

		expect(dbMock.setSessionApprovalsReviewer).toHaveBeenCalledWith(
			"detached-review",
			"auto_review",
			expect.objectContaining({ guard: expect.any(Function) }),
		);
		expect(pool.create).not.toHaveBeenCalled();
		expect(session.setApprovalsReviewer).not.toHaveBeenCalled();
		expect(lastSentTo(ws)).toEqual(
			expect.objectContaining({
				type: "status",
				session_id: "detached-review",
				approvals_reviewer: "auto_review",
			}),
		);
	});

	it("rejects an unsupported detached reviewer before persisting", async () => {
		vi.mocked(dbMock.getSessionSelection).mockResolvedValueOnce({
			agentCwd: "/tmp/test",
			providerId: "claude",
			model: "claude-sonnet-4-6",
			effort: "medium",
			permissionMode: "default",
			approvalsReviewer: null,
		});
		const session = makeSession();
		const { pool } = wrapSession(session);
		pool.getProvider.mockReturnValue({
			providerId: "claude",
			label: "Claude",
		} as never);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs("detached-claude");
		vi.mocked(dbMock.setSessionApprovalsReviewer).mockClear();

		await message(
			ws as never,
			JSON.stringify({
				type: "set_approvals_reviewer",
				session_id: "detached-claude",
				reviewer: "auto_review",
			}),
		);

		expect(lastSentTo(ws)).toEqual({
			type: "error",
			message: "Claude does not support approval reviewer auto_review",
		});
		expect(dbMock.setSessionApprovalsReviewer).not.toHaveBeenCalled();
	});

	it("rejects detached auto-review while Hlid policy enforcement is enabled", async () => {
		vi.mocked(dbMock.getSessionSelection).mockResolvedValueOnce({
			agentCwd: "/tmp/test",
			providerId: "codex",
			model: "gpt-5.6-sol",
			effort: "medium",
			permissionMode: "default",
			approvalsReviewer: "user",
		});
		mockLoadConfig.mockReturnValueOnce({
			vault: { path: "/tmp/test", name: "Test Vault" },
			claude: {
				model: "test-model",
				effort: "medium",
				permission_mode: "default",
				turn_recaps: false,
			},
			umbod: { enabled: true },
			agents: [],
		});
		const session = makeSession();
		const { pool } = wrapSession(session);
		pool.getProvider.mockReturnValue({
			providerId: "codex",
			label: "Codex",
			approvalReviewers: [
				{ value: "user", label: "User review", isDefault: true },
				{ value: "auto_review", label: "Auto-review" },
			],
		} as never);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs("detached-policy");
		vi.mocked(dbMock.setSessionApprovalsReviewer).mockClear();

		await message(
			ws as never,
			JSON.stringify({
				type: "set_approvals_reviewer",
				session_id: "detached-policy",
				reviewer: "auto_review",
			}),
		);

		expect(lastSentTo(ws)).toEqual({
			type: "error",
			message:
				"Auto-review is unavailable while Hlid policy enforcement is enabled.",
		});
		expect(dbMock.setSessionApprovalsReviewer).not.toHaveBeenCalled();
	});

	it("rejects detached auto-review while Hlid's auto-sleep usage gate is enabled", async () => {
		vi.mocked(dbMock.getSessionSelection).mockResolvedValueOnce({
			agentCwd: "/tmp/test",
			providerId: "codex",
			model: "gpt-5.6-sol",
			effort: "medium",
			permissionMode: "default",
			approvalsReviewer: "user",
		});
		mockLoadConfig.mockReturnValueOnce({
			vault: { path: "/tmp/test", name: "Test Vault" },
			claude: {
				model: "test-model",
				effort: "medium",
				permission_mode: "default",
				turn_recaps: false,
			},
			auto_sleep: {
				enabled: true,
				threshold: 0.95,
				max_sleep_minutes: 360,
				resume_buffer_seconds: 60,
			},
			agents: [],
		});
		const session = makeSession();
		const { pool } = wrapSession(session);
		pool.getProvider.mockReturnValue({
			providerId: "codex",
			label: "Codex",
			approvalReviewers: [
				{ value: "user", label: "User review", isDefault: true },
				{ value: "auto_review", label: "Auto-review" },
			],
		} as never);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs("detached-usage-gate");
		vi.mocked(dbMock.setSessionApprovalsReviewer).mockClear();

		await message(
			ws as never,
			JSON.stringify({
				type: "set_approvals_reviewer",
				session_id: "detached-usage-gate",
				reviewer: "auto_review",
			}),
		);

		expect(lastSentTo(ws)).toEqual({
			type: "error",
			message:
				"Auto-review is unavailable while Hlid's auto-sleep usage gate is enabled.",
		});
		expect(dbMock.setSessionApprovalsReviewer).not.toHaveBeenCalled();
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

	it("marks a rejected chat run as a turn-scoped error", async () => {
		const session = makeSession({
			runQuery: vi.fn().mockRejectedValue(new Error("setup failed")),
		});
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "chat",
				text: "hello",
				turn_id: "turn-1",
			}),
		);

		expect(lastSentTo(ws)).toEqual({
			type: "error",
			message: "setup failed",
			turn_scoped: true,
			turn_id: "turn-1",
		});
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

	it("waits for a pending detached Auto control before claiming and restoring the first chat", async () => {
		const sessionId = "detached-control-then-chat";
		const probe = deferred();
		const order: string[] = [];
		let claimed = false;
		let currentSessionId: string | null = null;
		let livePermissionMode: "default" | "auto" = "default";
		const saved = {
			agentCwd: "/tmp/test",
			providerId: "claude",
			model: "claude-opus-4-8",
			effort: "max",
			permissionMode: "default" as "default" | "auto",
		};
		vi.mocked(dbMock.setSessionPermissionMode).mockClear();
		vi.mocked(dbMock.getSessionSelection)
			.mockImplementationOnce(async () => ({ ...saved }))
			.mockImplementationOnce(async () => ({ ...saved }));
		let writeApplied = false;
		vi.mocked(dbMock.setSessionPermissionMode).mockImplementationOnce(
			async (_targetSessionId, mode, options) => {
				order.push(`write:${mode}`);
				if (!options?.guard?.()) return false;
				saved.permissionMode = mode as "default" | "auto";
				writeApplied = true;
				return true;
			},
		);
		const prepareSessionControlsForChat = vi.fn(
			async (targetSessionId: string) => {
				order.push(`prepare:${saved.permissionMode}`);
				currentSessionId = targetSessionId;
				livePermissionMode = saved.permissionMode;
				return { restored: true };
			},
		);
		const runQuery = vi.fn(async () => {
			order.push(`run:${livePermissionMode}`);
		});
		const session = makeSession({
			getCurrentSessionId: vi.fn(() => currentSessionId),
			getProviderId: vi.fn().mockReturnValue("claude"),
			getStatus: vi.fn(() => ({
				state: "idle" as const,
				model: saved.model,
				effort: saved.effort,
				permission_mode: livePermissionMode,
			})),
			prepareSessionControlsForChat,
			runQuery,
		});
		const { pool, entry } = wrapSession(session);
		pool.get.mockImplementation((targetSessionId: string) => {
			if (targetSessionId === "vault-id") return entry;
			return claimed && targetSessionId === sessionId ? entry : undefined;
		});
		pool.findByDbSessionId.mockImplementation((targetSessionId: string) =>
			claimed && targetSessionId === sessionId ? entry : undefined,
		);
		pool.claimDbSessionId.mockImplementation(
			(candidate: PoolEntry, targetSessionId: string) => {
				order.push(`claim:${saved.permissionMode}`);
				expect(targetSessionId).toBe(sessionId);
				claimed = true;
				return candidate;
			},
		);
		pool.getDetachedPermissionValidationGeneration.mockReturnValue(61);
		pool.isDetachedPermissionValidationCurrent.mockImplementation(
			(generation: number) => generation === 61,
		);
		pool.validateDetachedPermissionMode.mockImplementationOnce(async () => {
			order.push("probe:start");
			await probe.promise;
			order.push("probe:end");
			return 61;
		});
		const { message } = createWsHandlers(pool as never);
		const controlWs = makeWs(sessionId);
		const chatWs = makeWs();

		const control = message(
			controlWs as never,
			JSON.stringify({
				type: "set_permission_mode",
				session_id: sessionId,
				mode: "auto",
			}),
		);
		await vi.waitFor(() =>
			expect(pool.validateDetachedPermissionMode).toHaveBeenCalledOnce(),
		);
		const chat = message(
			chatWs as never,
			JSON.stringify({
				type: "chat",
				text: "use the newly committed Auto selection",
				turn_id: "first-after-detached-control",
				session_id: sessionId,
			}),
		);
		await Promise.resolve();

		expect(pool.claimDbSessionId).not.toHaveBeenCalled();
		expect(prepareSessionControlsForChat).not.toHaveBeenCalled();
		expect(runQuery).not.toHaveBeenCalled();

		probe.resolve();
		await Promise.all([control, chat]);

		expect(writeApplied).toBe(true);
		expect(saved.permissionMode).toBe("auto");
		expect(dbMock.setSessionPermissionMode).toHaveBeenCalledWith(
			sessionId,
			"auto",
			expect.objectContaining({ guard: expect.any(Function) }),
		);
		expect(prepareSessionControlsForChat).toHaveBeenCalledWith(sessionId);
		expect(session.setInitialChatSelection).not.toHaveBeenCalled();
		expect(runQuery).toHaveBeenCalledOnce();
		expect(order).toEqual([
			"probe:start",
			"probe:end",
			"write:auto",
			"claim:auto",
			"prepare:auto",
			"run:auto",
		]);
		expect(
			mockSend.mock.calls.some(
				([ws, event]) => ws === chatWs && event.type === "error",
			),
		).toBe(false);
	});

	it("applies repeated controls without resetting the configured provider", async () => {
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

		expect(session.setProvider).not.toHaveBeenCalled();
		expect(session.setInitialChatSelection).toHaveBeenCalledWith({
			model: "gpt-5.6-sol",
			effort: "ultra",
			permissionMode: "bypassPermissions",
		});
		expect(session.runQuery).toHaveBeenCalled();
	});

	it("settles an invalid first-chat effort without claiming a pending turn", async () => {
		const unsupportedEffort = new UnsupportedProviderEffortError(
			"Claude Code · CLIProxy does not support effort max",
		);
		const session = makeSession({
			getProviderId: vi.fn().mockReturnValue("cliproxy-codex"),
			getCurrentSessionId: vi.fn().mockReturnValue(null),
			setInitialChatSelection: vi.fn().mockRejectedValue(unsupportedEffort),
			getStatus: vi.fn().mockReturnValue({
				state: "idle",
				model: "gpt-5.6-sol",
				effort: "xhigh",
				permission_mode: "default",
			}),
		});
		const { pool, entry, runState } = wrapSession(session);
		entry.sessionId = "random-live-pool-id";
		pool.getSessionsStatus.mockReturnValue([
			{
				session_id: "random-live-pool-id",
				db_session_id: "vault-id",
				agent_cwd: "/tmp/test",
				agent_name: "Test Vault",
				state: "idle",
				model: "gpt-5.6-sol",
				effort: "xhigh",
				permission_mode: "default",
				hasPendingPermissions: false,
				hasDbSession: true,
			},
		]);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "chat",
				text: "first turn",
				turn_id: "invalid-effort-turn",
				session_id: "vault-id",
				model: "gpt-5.6-sol",
				effort: "max",
			}),
		);

		expect(
			mockSend.mock.calls
				.filter((call) => call[0] === ws)
				.map((call) => call[1]),
		).toEqual([
			{
				type: "session_created",
				session_id: "random-live-pool-id",
				agent_cwd: "/tmp/test",
				agent_name: "Test Vault",
			},
			{
				type: "error",
				message: "Claude Code · CLIProxy does not support effort max",
				turn_scoped: true,
				turn_id: "invalid-effort-turn",
			},
			{
				type: "session_control_rejected",
				control: "effort",
				attempted_value: "max",
				authoritative_value: "xhigh",
				session_id: "vault-id",
			},
		]);
		expect(mockBroadcast).toHaveBeenCalledWith({
			type: "sessions_status",
			sessions: [
				expect.objectContaining({
					session_id: "random-live-pool-id",
					db_session_id: "vault-id",
				}),
			],
		});
		const directCalls = mockSend.mock.invocationCallOrder;
		const sessionsStatusOrder = mockBroadcast.mock.invocationCallOrder[0] ?? 0;
		expect(directCalls[1] ?? Number.POSITIVE_INFINITY).toBeLessThan(
			sessionsStatusOrder,
		);
		expect(sessionsStatusOrder).toBeLessThan(directCalls[2] ?? 0);
		expect(session.runQuery).not.toHaveBeenCalled();
		expect(runState.inFlightChatCount.size).toBe(0);
		expect(runState.ownerWs).toBeNull();
	});

	it("rejects one atomic full first-chat selection without partial controls or turn ownership", async () => {
		const initialSelection = Promise.reject(
			new Error("Auto selection could not be committed"),
		);
		const status = {
			state: "idle" as const,
			model: "claude-sonnet-4-6",
			effort: "medium",
			permission_mode: "default" as const,
			approvals_reviewer: "user" as const,
		};
		const session = makeSession({
			getProviderId: vi.fn().mockReturnValue("claude"),
			getCurrentSessionId: vi.fn().mockReturnValue(null),
			getStatus: vi.fn(() => ({ ...status })),
			setInitialChatSelection: vi.fn().mockReturnValue(initialSelection),
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "chat",
				text: "first turn with every control",
				turn_id: "atomic-first-turn",
				session_id: "atomic-first-session",
				provider: "claude",
				model: "claude-opus-4-8",
				effort: "max",
				permission_mode: "auto",
				approvals_reviewer: "auto_review",
			}),
		);

		expect(session.setInitialChatSelection).toHaveBeenCalledWith({
			model: "claude-opus-4-8",
			effort: "max",
			permissionMode: "auto",
			approvalsReviewer: "auto_review",
		});
		expect(session.acknowledgeSessionControlRejection).toHaveBeenCalledWith(
			initialSelection,
		);
		expect(session.setProvider).not.toHaveBeenCalled();
		expect(session.setModel).not.toHaveBeenCalled();
		expect(session.setEffort).not.toHaveBeenCalled();
		expect(session.setPermissionMode).not.toHaveBeenCalled();
		expect(session.setApprovalsReviewer).not.toHaveBeenCalled();
		expect(session.runQuery).not.toHaveBeenCalled();
		expect(runState.ownerWs).toBeNull();
		expect(runState.inFlightChatCount.size).toBe(0);
		expect(runState.broadcast).toHaveBeenCalledWith({
			type: "status",
			...status,
		});
		expect(
			mockSend.mock.calls
				.filter((call) => call[0] === ws)
				.map((call) => call[1]),
		).toEqual(
			expect.arrayContaining([
				{
					type: "error",
					message: "Auto selection could not be committed",
					turn_scoped: true,
					turn_id: "atomic-first-turn",
				},
				{
					type: "session_control_rejected",
					control: "permission_mode",
					attempted_value: "auto",
					authoritative_value: "default",
					session_id: "atomic-first-session",
				},
			]),
		);
	});

	it("continues the first resumed turn after exact saved Auto narrowing without retrying the stale payload", async () => {
		let currentSessionId: string | null = null;
		const status = {
			state: "idle" as const,
			model: "claude-opus-4-8",
			effort: "max",
			permission_mode: "default" as const,
		};
		const prepareSessionControlsForChat = vi.fn(async (sessionId: string) => {
			currentSessionId = sessionId;
			return {
				restored: true,
				permissionModeNarrowing: {
					attempted: "auto" as const,
					authoritative: "default" as const,
					providerId: "claude",
					model: "claude-opus-4-8",
				},
			};
		});
		const session = makeSession({
			getCurrentSessionId: vi.fn(() => currentSessionId),
			getProviderId: vi.fn().mockReturnValue("claude"),
			getStatus: vi.fn(() => ({ ...status })),
			prepareSessionControlsForChat,
			validatePermissionMode: vi
				.fn()
				.mockRejectedValue(new Error("stale Auto payload was retried")),
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "chat",
				text: "resume under the narrowed mode",
				turn_id: "resume-narrowed-turn",
				session_id: "archived-auto-session",
				provider: "claude",
				model: "claude-opus-4-8",
				effort: "max",
				permission_mode: "auto",
			}),
		);

		expect(prepareSessionControlsForChat).toHaveBeenCalledWith(
			"archived-auto-session",
		);
		expect(session.validatePermissionMode).not.toHaveBeenCalled();
		expect(session.setInitialChatSelection).not.toHaveBeenCalled();
		expect(session.setProvider).not.toHaveBeenCalled();
		expect(session.runQuery).toHaveBeenCalledOnce();
		const directMessages = mockSend.mock.calls
			.filter((call) => call[0] === ws)
			.map((call) => call[1]);
		expect(
			directMessages.filter(
				(event) => event.type === "session_control_rejected",
			),
		).toEqual([
			{
				type: "session_control_rejected",
				control: "permission_mode",
				attempted_value: "auto",
				authoritative_value: "default",
				session_id: "archived-auto-session",
			},
		]);
		expect(directMessages.some((event) => event.type === "error")).toBe(false);
		const statuses = [
			...runState.send.mock.calls.map((call) => call[1]),
			...runState.broadcast.mock.calls.map((call) => call[0]),
		].filter((event) => event.type === "status");
		expect(statuses).toEqual([{ type: "status", ...status }]);
	});

	it.each([
		{
			label: "provider",
			provider: "cliproxy-codex",
			model: "claude-opus-4-8",
		},
		{
			label: "model",
			provider: "claude",
			model: "claude-sonnet-5",
		},
	])("still validates and rejects changed $label Auto on first resume", async ({
		provider,
		model,
	}) => {
		let currentSessionId: string | null = null;
		const validatePermissionMode = vi
			.fn()
			.mockRejectedValue(new Error("changed Auto tuple is unavailable"));
		const session = makeSession({
			getCurrentSessionId: vi.fn(() => currentSessionId),
			getProviderId: vi.fn().mockReturnValue("claude"),
			getStatus: vi.fn().mockReturnValue({
				state: "idle",
				model: "claude-opus-4-8",
				effort: "max",
				permission_mode: "default",
			}),
			prepareSessionControlsForChat: vi.fn(async (sessionId: string) => {
				currentSessionId = sessionId;
				return {
					restored: true,
					permissionModeNarrowing: {
						attempted: "auto" as const,
						authoritative: "default" as const,
						providerId: "claude",
						model: "claude-opus-4-8",
					},
				};
			}),
			validatePermissionMode,
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "chat",
				text: "resume with changed controls",
				turn_id: `changed-${provider}-${model}`,
				session_id: "archived-auto-session",
				provider,
				model,
				permission_mode: "auto",
			}),
		);

		expect(validatePermissionMode).toHaveBeenCalledWith(
			"auto",
			provider,
			model,
			true,
		);
		expect(session.runQuery).not.toHaveBeenCalled();
		expect(lastSentTo(ws)).toEqual({
			type: "session_control_rejected",
			control: "permission_mode",
			attempted_value: "auto",
			authoritative_value: "default",
			session_id: "archived-auto-session",
		});
		expect(runState.broadcast).toHaveBeenCalledWith({
			type: "status",
			state: "idle",
			model: "claude-opus-4-8",
			effort: "max",
			permission_mode: "default",
		});
	});

	it("applies the approval reviewer carried by a first-chat payload", async () => {
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
				session_id: "new-review-session",
				provider: "codex",
				approvals_reviewer: "auto_review",
			}),
		);

		expect(session.setProvider).not.toHaveBeenCalled();
		expect(session.setInitialChatSelection).toHaveBeenCalledWith({
			approvalsReviewer: "auto_review",
		});
		expect(session.runQuery).toHaveBeenCalled();
	});

	it("preserves same-provider configured controls when the first chat omits overrides", async () => {
		const session = makeSession({
			getProviderId: vi.fn().mockReturnValue("codex"),
			getCurrentSessionId: vi.fn().mockReturnValue(null),
			getStatus: vi.fn().mockReturnValue({
				state: "idle",
				model: "gpt-5.6-sol",
				effort: "high",
				permission_mode: "bypassPermissions",
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
				provider: "codex",
			}),
		);

		expect(session.setProvider).not.toHaveBeenCalled();
		expect(session.setInitialChatSelection).toHaveBeenCalledWith({});
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
			setInitialChatSelection: vi.fn(
				async (selection: {
					model?: string;
					effort?: string;
					permissionMode?: string;
				}) => {
					status.model = selection.model ?? status.model;
					status.effort = selection.effort ?? status.effort;
					status.permission_mode =
						(selection.permissionMode as "default") ?? status.permission_mode;
				},
			),
		});
		const { pool, runState } = wrapSession(session);
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
		expect(session.setInitialChatSelection).toHaveBeenCalledWith({
			model: "gpt-5.6-sol",
			effort: "ultra",
			permissionMode: "bypassPermissions",
		});
		expect(runState.send).toHaveBeenCalledWith(
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
		await vi.waitFor(() => expect(session.runQuery).toHaveBeenCalledTimes(2));

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
			expect.objectContaining({
				inputOrigin: "human",
				sessionId: "sess-1",
				skillContexts: "/vault/skills/s.md",
			}),
		);
	});

	it("forwards the first-chat notification policy to durable session creation", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({
				type: "chat",
				text: "notify me when this finishes",
				session_id: "sess-notification",
				turn_id: "turn-notification",
				notification_policy: {
					mode: "notify_completion_once",
					scope: "delegation_tree",
					target_device_ids: ["11111111-1111-4111-8111-111111111111"],
				},
			}),
		);
		expect(session.runQuery).toHaveBeenCalledWith(
			"notify me when this finishes",
			expect.any(Function),
			expect.objectContaining({
				sessionId: "sess-notification",
				turnId: "turn-notification",
				initialNotificationPolicy: {
					mode: "notify_completion_once",
					scope: "delegation_tree",
					targetDeviceIds: ["11111111-1111-4111-8111-111111111111"],
				},
			}),
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
			expect.objectContaining({
				sessionId: "sess-1",
				planMode: true,
				planHtml: undefined,
			}),
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
			expect.objectContaining({
				sessionId: "sess-1",
				planMode: true,
				planHtml: true,
			}),
		);
	});

	it("forwards vault references to session.runQuery", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({
				type: "chat",
				text: "compare these",
				session_id: "sess-1",
				vault_references: ["Projects/Hlid.md", "Notes/Decision.md"],
			}),
		);
		expect(session.runQuery).toHaveBeenCalledWith(
			"compare these",
			expect.any(Function),
			expect.objectContaining({
				sessionId: "sess-1",
				vaultReferences: ["Projects/Hlid.md", "Notes/Decision.md"],
			}),
		);
	});

	it("forwards the previewed workspace revision to session.runQuery", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		const workspaceReferences = [
			{
				relativePath: "src/server/session.ts",
				sha256: "a".repeat(64),
			},
		];
		await message(
			ws as never,
			JSON.stringify({
				type: "chat",
				text: "review this",
				session_id: "sess-1",
				workspace_references: workspaceReferences,
			}),
		);
		expect(session.runQuery).toHaveBeenCalledWith(
			"review this",
			expect.any(Function),
			expect.objectContaining({
				sessionId: "sess-1",
				workspaceReferences,
			}),
		);
	});

	it("forwards a native goal with its normal starting turn", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({
				type: "chat",
				text: "Finish the release gate",
				session_id: "sess-goal",
				goal: {
					objective: "Finish the release gate",
					token_budget: 50_000,
				},
			}),
		);
		expect(session.runQuery).toHaveBeenCalledWith(
			"Finish the release gate",
			expect.any(Function),
			expect.objectContaining({
				sessionId: "sess-goal",
				goalStart: {
					objective: "Finish the release gate",
					tokenBudget: 50_000,
				},
			}),
		);
	});

	it("broadcasts vault references to another live view before persistence", async () => {
		const session = makeSession();
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const sender = makeWs();
		const other = makeWs();
		wsState.clients.add(sender as never);
		wsState.clients.add(other as never);

		await message(
			sender as never,
			JSON.stringify({
				type: "chat",
				text: "compare these",
				session_id: "sess-1",
				turn_id: "turn-1",
				vault_references: ["Projects/Hlid.md"],
			}),
		);

		expect(other.send).toHaveBeenCalledWith(
			JSON.stringify({
				type: "user_message",
				text: "compare these",
				session_id: "vault-id",
				id: "turn-1",
				vault_references: ["Projects/Hlid.md"],
			}),
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

	it("steer_queued returns immediately, then acknowledges and republishes queue state", async () => {
		const session = makeSession({
			steerQueued: vi.fn().mockResolvedValue({
				targetTurnId: "active-turn",
				targetAssistantSeq: 7,
				steerSeq: 8,
				steerToolEventIndex: 3,
			}),
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({ type: "steer_queued", turn_id: "turn-4" }),
		);
		expect(session.steerQueued).toHaveBeenCalledWith("turn-4");
		await vi.waitFor(() => {
			expect(runState.broadcast).toHaveBeenCalledWith({
				type: "turn_steered",
				turn_id: "turn-4",
				target_turn_id: "active-turn",
				target_assistant_seq: 7,
				steer_seq: 8,
				steer_tool_event_index: 3,
				session_id: expect.any(String),
			});
			expect(runState.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({ type: "queue_state" }),
			);
		});
	});

	it("does not hold the WebSocket dispatch open while the provider accepts a steer", async () => {
		let acceptSteer:
			| ((value: {
					targetTurnId: string;
					targetAssistantSeq: number;
					steerSeq: number;
					steerToolEventIndex: number;
			  }) => void)
			| undefined;
		const steering = new Promise<{
			targetTurnId: string;
			targetAssistantSeq: number;
			steerSeq: number;
			steerToolEventIndex: number;
		}>((resolve) => {
			acceptSteer = resolve;
		});
		const session = makeSession({
			steerQueued: vi.fn().mockReturnValue(steering),
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		const handled = message(
			ws as never,
			JSON.stringify({ type: "steer_queued", turn_id: "turn-4" }),
		);
		await expect(handled).resolves.toBeUndefined();
		acceptSteer?.({
			targetTurnId: "active-turn",
			targetAssistantSeq: 7,
			steerSeq: 8,
			steerToolEventIndex: 3,
		});
		await vi.waitFor(() => {
			expect(runState.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({ type: "turn_steered" }),
			);
		});
	});

	it("reports a provider steering failure without dropping queue state", async () => {
		const session = makeSession({
			steerQueued: vi.fn().mockRejectedValue(new Error("not steerable")),
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({ type: "steer_queued", turn_id: "turn-4" }),
		);
		await vi.waitFor(() => {
			expect(mockSend).toHaveBeenCalledWith(
				ws,
				expect.objectContaining({ type: "error", message: "not steerable" }),
			);
			expect(runState.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({ type: "queue_state" }),
			);
		});
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

	it("does not broadcast a stale response rejected by the session", async () => {
		const session = makeSession({
			handleAskUserQuestionResponse: vi.fn().mockResolvedValue(false),
		});
		const { pool, runState } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();

		await message(
			ws as never,
			JSON.stringify({
				type: "ask_user_question_response",
				id: "already-answered",
				answers: { "Q?": ["Late answer"] },
			}),
		);

		expect(runState.broadcast).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "ask_user_question_resolved",
				id: "already-answered",
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

	it("with a live Claude session: applies the canonical agent definitions", async () => {
		writeFileSync(
			join(agentDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					search: { command: "bun", args: ["server.ts"] },
				},
			}),
			"utf8",
		);
		const applyProviderMcpServers = vi.fn().mockResolvedValue({
			providerId: "claude",
			status: "applied",
			result: { added: ["search"], removed: [], errors: {} },
			statuses: [{ name: "search", status: "connected", scope: "project" }],
		});
		const session = makeSession({ applyProviderMcpServers });
		const { pool, entry, runState } = wrapSession(session);
		entry.agentCwd = agentDir;
		pool.getAllEntries.mockReturnValue([entry][Symbol.iterator]());
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		mockSend.mockClear();

		await message(
			ws as never,
			JSON.stringify({ type: "sync_mcp_list", agent_cwd: agentDir }),
		);

		expect(applyProviderMcpServers).toHaveBeenCalledWith(
			[
				{
					name: "search",
					config: { command: "bun", args: ["server.ts"] },
					disabled: false,
				},
			],
			expect.any(Function),
		);
		expect(runState.broadcast).not.toHaveBeenCalled();
		expect(mockSend).toHaveBeenCalledWith(
			ws,
			expect.objectContaining({
				type: "mcp_status",
				servers: [
					expect.objectContaining({
						name: "search",
						status: "connected",
					}),
				],
			}),
		);
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

	it("accepts a configured WSL alias without requiring the share to be mounted", async () => {
		const configured =
			"\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\development\\repos\\hlid";
		mockLoadConfig.mockReturnValue({
			vault: { path: "/tmp/test", name: "Test Vault" },
			claude: {
				model: "test-model",
				effort: "medium",
				permission_mode: "default",
				turn_recaps: false,
			},
			agents: [
				{
					path: configured,
					name: "Hlid",
					mode: "cwd",
					provider: "codex",
				},
			],
		});
		const session = makeSession({
			getProviderId: vi.fn().mockReturnValue("codex"),
		});
		const { pool } = wrapSession(session);
		const { message } = createWsHandlers(pool as never);
		const ws = makeWs();
		mockSend.mockClear();

		await message(
			ws as never,
			JSON.stringify({
				type: "sync_mcp_list",
				agent_cwd:
					"\\\\wsl$\\ubuntu-24.04\\home\\kyle\\development\\repos\\hlid\\.",
			}),
		);

		expect(mockSend).toHaveBeenCalledWith(
			ws,
			expect.objectContaining({
				type: "mcp_status",
				provider_id: "codex",
				servers: [],
			}),
		);
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
