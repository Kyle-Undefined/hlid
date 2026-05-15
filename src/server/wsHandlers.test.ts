/**
 * wsHandlers unit tests — routes ClientMessages to the correct SessionManager
 * method and enforces ownership semantics. SessionManager, runState, DB, and
 * config are all mocked; only the routing logic inside createWsHandlers is real.
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
}));

// vi.mock factories are hoisted before module-level code, so vars referenced
// inside them must also be hoisted via vi.hoisted().
const { wsState, mockSend, mockBroadcast, mockGetRunBuffer, mockLoadConfig } =
	vi.hoisted(() => ({
		wsState: {
			clients: new Set<object>(),
			sessionOwnerWs: null as object | null,
			lastSessionError: null as string | null,
			inFlightChatCount: new Map<object, number>(),
		},
		mockSend: vi.fn(),
		mockBroadcast: vi.fn(),
		mockGetRunBuffer: vi.fn().mockReturnValue([]),
		mockLoadConfig: vi.fn().mockReturnValue({
			vault: { path: "/tmp/test" },
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
	getRunBuffer: mockGetRunBuffer,
}));

// ── import after mocks ────────────────────────────────────────────────────────

import { createWsHandlers } from "./wsHandlers";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Create a minimal fake WebSocket with a spy on send(). */
function makeWs() {
	return { send: vi.fn() };
}

/** Create a fully mocked SessionManager. */
function makeSession(overrides: Partial<SessionManager> = {}): SessionManager {
	return {
		getStatus: vi.fn().mockReturnValue({ state: "idle", model: "test-model" }),
		isRunning: vi.fn().mockReturnValue(false),
		getLastMcpStatus: vi.fn().mockReturnValue(null),
		getPendingPermissionRequests: vi.fn().mockReturnValue([]),
		getPendingAskUserQuestions: vi.fn().mockReturnValue([]),
		getPendingPlanModeExits: vi.fn().mockReturnValue([]),
		getCurrentSessionId: vi.fn().mockReturnValue(null),
		abort: vi.fn(),
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
	} as unknown as SessionManager;
}

/** Capture the most recent arg to mockSend for a given ws. */
function lastSentTo(ws: ReturnType<typeof makeWs>): ServerMessage | undefined {
	const calls = mockSend.mock.calls.filter((c) => c[0] === ws);
	return calls.length > 0 ? calls[calls.length - 1][1] : undefined;
}

beforeEach(() => {
	wsState.clients.clear();
	wsState.sessionOwnerWs = null;
	wsState.lastSessionError = null;
	wsState.inFlightChatCount.clear();
	mockSend.mockClear();
	mockBroadcast.mockClear();
	mockGetRunBuffer.mockClear().mockReturnValue([]);
});

// ── open ──────────────────────────────────────────────────────────────────────

describe("open", () => {
	it("adds ws to clients set", () => {
		const session = makeSession();
		const { open } = createWsHandlers(session);
		const ws = makeWs();
		open(ws as never);
		expect(wsState.clients.has(ws)).toBe(true);
	});

	it("sends current status to new connection", () => {
		const session = makeSession();
		const { open } = createWsHandlers(session);
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
		wsState.lastSessionError = "Something failed";
		const { open } = createWsHandlers(session);
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
		wsState.lastSessionError = "old error";
		const { open } = createWsHandlers(session);
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
		mockGetRunBuffer.mockReturnValue(chunks);
		const session = makeSession({ isRunning: vi.fn().mockReturnValue(true) });
		const { open } = createWsHandlers(session);
		const ws = makeWs();
		open(ws as never);
		const sentChunks = mockSend.mock.calls
			.filter((c) => c[0] === ws && c[1].type === "chunk")
			.map((c) => c[1].text);
		expect(sentChunks).toEqual(["Hello", " world"]);
	});

	it("claims ownership for reconnecting client when no owner set", () => {
		const session = makeSession({ isRunning: vi.fn().mockReturnValue(true) });
		const { open } = createWsHandlers(session);
		const ws = makeWs();
		open(ws as never);
		expect(wsState.sessionOwnerWs).toBe(ws);
	});

	it("sends MCP status cache if available", () => {
		const mcpStatuses = [{ name: "my-server", status: "connected" as const }];
		const session = makeSession({
			getLastMcpStatus: vi.fn().mockReturnValue(mcpStatuses),
		});
		const { open } = createWsHandlers(session);
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
		const { open } = createWsHandlers(session);
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

	it("does NOT replay ask_user_questions when another client already owns the session", () => {
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
		const { open } = createWsHandlers(session);
		const owner = makeWs();
		const other = makeWs();
		wsState.sessionOwnerWs = owner;
		open(other as never);
		const calls = mockSend.mock.calls.filter((c) => c[0] === other);
		expect(
			calls.find((c) => c[1].type === "ask_user_question"),
		).toBeUndefined();
	});
});

// ── close ─────────────────────────────────────────────────────────────────────

describe("close", () => {
	it("removes ws from clients", () => {
		const session = makeSession();
		const { open, close } = createWsHandlers(session);
		const ws = makeWs();
		open(ws as never);
		close(ws as never);
		expect(wsState.clients.has(ws)).toBe(false);
	});

	it("clears sessionOwnerWs when owner disconnects", () => {
		const session = makeSession();
		const { close } = createWsHandlers(session);
		const ws = makeWs();
		wsState.sessionOwnerWs = ws;
		close(ws as never);
		expect(wsState.sessionOwnerWs).toBeNull();
	});

	it("does not clear owner when a non-owner disconnects", () => {
		const session = makeSession();
		const { close } = createWsHandlers(session);
		const owner = makeWs();
		const other = makeWs();
		wsState.sessionOwnerWs = owner;
		close(other as never);
		expect(wsState.sessionOwnerWs).toBe(owner);
	});
});

// ── message: invalid JSON ─────────────────────────────────────────────────────

describe("message — invalid JSON", () => {
	it("sends error on malformed JSON", async () => {
		const session = makeSession();
		const { message } = createWsHandlers(session);
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
		const { message } = createWsHandlers(session);
		const ws = makeWs();
		await message(ws as never, JSON.stringify({ type: "sync" }));
		const types = mockSend.mock.calls
			.filter((c) => c[0] === ws)
			.map((c) => (c[1] as { type: string }).type);
		expect(types).toContain("status");
	});
});

// ── message: abort ────────────────────────────────────────────────────────────

describe("message — abort", () => {
	it("calls session.abort() when ws is owner", async () => {
		const session = makeSession();
		const { message } = createWsHandlers(session);
		const ws = makeWs();
		wsState.sessionOwnerWs = ws;
		await message(ws as never, JSON.stringify({ type: "abort" }));
		expect(session.abort).toHaveBeenCalled();
	});

	it("allows abort from any device", async () => {
		const session = makeSession();
		const { message } = createWsHandlers(session);
		const owner = makeWs();
		const other = makeWs();
		wsState.sessionOwnerWs = owner;
		await message(other as never, JSON.stringify({ type: "abort" }));
		expect(session.abort).toHaveBeenCalled();
	});
});

// ── message: clear ────────────────────────────────────────────────────────────

describe("message — clear", () => {
	it("calls clearHistory and resets lastSessionError when owner", async () => {
		const session = makeSession();
		const { message } = createWsHandlers(session);
		const ws = makeWs();
		wsState.sessionOwnerWs = ws;
		wsState.lastSessionError = "prev error";
		await message(ws as never, JSON.stringify({ type: "clear" }));
		expect(session.clearHistory).toHaveBeenCalled();
		expect(wsState.lastSessionError).toBeNull();
	});

	it("allows clear from any device", async () => {
		const session = makeSession();
		const { message } = createWsHandlers(session);
		const owner = makeWs();
		const other = makeWs();
		wsState.sessionOwnerWs = owner;
		await message(other as never, JSON.stringify({ type: "clear" }));
		expect(session.clearHistory).toHaveBeenCalled();
	});
});

// ── message: reload_session ───────────────────────────────────────────────────

describe("message — reload_session", () => {
	it("reinitializes session and broadcasts status when owner", async () => {
		const session = makeSession();
		const { message } = createWsHandlers(session);
		const ws = makeWs();
		wsState.sessionOwnerWs = ws;
		await message(ws as never, JSON.stringify({ type: "reload_session" }));
		expect(session.reinitialize).toHaveBeenCalled();
		expect(mockBroadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "status" }),
		);
	});

	it("allows reload from any device", async () => {
		const session = makeSession();
		const { message } = createWsHandlers(session);
		const owner = makeWs();
		const other = makeWs();
		wsState.sessionOwnerWs = owner;
		await message(other as never, JSON.stringify({ type: "reload_session" }));
		expect(session.reinitialize).toHaveBeenCalled();
	});
});

// ── message: chat ─────────────────────────────────────────────────────────────

describe("message — chat", () => {
	it("rejects empty text", async () => {
		const session = makeSession();
		const { message } = createWsHandlers(session);
		const ws = makeWs();
		wsState.sessionOwnerWs = ws;
		await message(ws as never, JSON.stringify({ type: "chat", text: "   " }));
		expect(lastSentTo(ws)).toMatchObject({
			type: "error",
			message: "Invalid message",
		});
		expect(session.runQuery).not.toHaveBeenCalled();
	});

	it("allows chat from any device regardless of who owns the session", async () => {
		const session = makeSession();
		const { message } = createWsHandlers(session);
		const owner = makeWs();
		const other = makeWs();
		wsState.sessionOwnerWs = owner;
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
		const { message } = createWsHandlers(session);
		const ws = makeWs();
		wsState.sessionOwnerWs = ws;
		await message(ws as never, JSON.stringify({ type: "chat", text: "hi" }));
		// No "Session already running" error should be sent.
		const errorCalls = mockSend.mock.calls.filter(
			(c) => (c[1] as { type?: string })?.type === "error",
		);
		expect(errorCalls).toHaveLength(0);
		// runQuery is invoked even though session.isRunning() reported true.
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
		const { message } = createWsHandlers(session);
		const ws = makeWs();
		wsState.sessionOwnerWs = ws;

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
		expect(wsState.sessionOwnerWs).toBe(ws);

		// Resolve turn 2 — now ownership should clear.
		turn2Resolvers[0]?.();
		await p2;
		expect(wsState.sessionOwnerWs).toBeNull();
	});

	it("calls session.runQuery with correct args", async () => {
		const session = makeSession();
		const { message } = createWsHandlers(session);
		const ws = makeWs();
		wsState.sessionOwnerWs = ws;
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
		);
	});

	it("forwards plan_mode flag to session.runQuery", async () => {
		const session = makeSession();
		const { message } = createWsHandlers(session);
		const ws = makeWs();
		wsState.sessionOwnerWs = ws;
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
		);
	});

	it("broadcasts status when syncConfig reports model changed", async () => {
		const session = makeSession({
			syncConfig: vi.fn().mockReturnValue(true),
		});
		const { message } = createWsHandlers(session);
		const ws = makeWs();
		wsState.sessionOwnerWs = ws;
		mockBroadcast.mockClear();
		await message(ws as never, JSON.stringify({ type: "chat", text: "hi" }));
		expect(mockBroadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "status" }),
		);
	});

	it("does not broadcast status when syncConfig reports no model change", async () => {
		const session = makeSession({
			syncConfig: vi.fn().mockReturnValue(false),
		});
		const { message } = createWsHandlers(session);
		const ws = makeWs();
		wsState.sessionOwnerWs = ws;
		mockBroadcast.mockClear();
		await message(ws as never, JSON.stringify({ type: "chat", text: "hi" }));
		const statusBroadcasts = mockBroadcast.mock.calls.filter(
			(c) => (c[0] as { type?: string })?.type === "status",
		);
		expect(statusBroadcasts).toHaveLength(0);
	});

	it("cancel_queued forwards turn_id to session.cancelQueued", async () => {
		const session = makeSession({
			cancelQueued: vi.fn().mockReturnValue(true),
		});
		const { message } = createWsHandlers(session);
		const ws = makeWs();
		wsState.sessionOwnerWs = ws;
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
		const { message } = createWsHandlers(session);
		const ws = makeWs();
		wsState.sessionOwnerWs = ws;
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
		const { message } = createWsHandlers(session);
		const owner = makeWs();
		const other = makeWs();
		wsState.sessionOwnerWs = owner;
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
		const { message } = createWsHandlers(session);
		const owner = makeWs();
		const other = makeWs();
		wsState.sessionOwnerWs = owner;
		await message(
			other as never,
			JSON.stringify({ type: "cancel_queued", turn_id: "turn-xyz" }),
		);
		expect(session.cancelQueued).toHaveBeenCalledWith("turn-xyz");
	});

	it("first chat from unowned session is not rejected as non-owner", async () => {
		const session = makeSession();
		const { message } = createWsHandlers(session);
		const ws = makeWs();
		// No owner set — chat allowed from any ws
		await message(ws as never, JSON.stringify({ type: "chat", text: "hello" }));
		// runQuery called proves the request wasn't rejected
		expect(session.runQuery).toHaveBeenCalled();
	});
});

// ── message: permission_response ──────────────────────────────────────────────

describe("message — permission_response", () => {
	it("resolves pending permission and broadcasts resolved event", async () => {
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
		const { message } = createWsHandlers(session);
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
		expect(mockBroadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "permission_resolved", id: "perm-1" }),
		);
	});

	it("does nothing when permission id not found", async () => {
		const session = makeSession({
			getPendingPermissionRequests: vi.fn().mockReturnValue([]),
		});
		const { message } = createWsHandlers(session);
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
		const { message } = createWsHandlers(session);
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
		const { message } = createWsHandlers(session);
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
		const { message } = createWsHandlers(session);
		const ws = makeWs();
		// Just await — if it throws the test fails; resolves.not.toThrow() not Bun-compatible
		await message(
			ws as never,
			JSON.stringify({
				type: "ask_user_question_response",
				id: "ghost-id",
				answers: { "Q?": ["Whatever"] },
			}),
		);
	});

	it("broadcasts ask_user_question_resolved after response", async () => {
		const session = makeSession();
		const { message } = createWsHandlers(session);
		const ws = makeWs();
		await message(
			ws as never,
			JSON.stringify({
				type: "ask_user_question_response",
				id: "aqq-2",
				answers: { "Q?": ["Option B"] },
			}),
		);
		expect(mockBroadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "ask_user_question_resolved",
				id: "aqq-2",
				answers: { "Q?": ["Option B"] },
			}),
		);
	});

	it("propagates multi-question / multi-select answer maps verbatim", async () => {
		const session = makeSession();
		const { message } = createWsHandlers(session);
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
		expect(mockBroadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "ask_user_question_resolved",
				id: "aqq-multi",
				answers,
			}),
		);
	});

	it("forwards notes to session.handleAskUserQuestionResponse when provided", async () => {
		const session = makeSession();
		const { message } = createWsHandlers(session);
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
		const { message } = createWsHandlers(session);
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
		expect(mockBroadcast).toHaveBeenCalledWith(
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
		const { message } = createWsHandlers(session);
		const owner = makeWs();
		const other = makeWs();
		wsState.sessionOwnerWs = owner;
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

// ── message — sync_mcp_list (agent_cwd) ───────────────────────────────────────

describe("message — sync_mcp_list (agent_cwd)", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "hlid-ws-agent-"));
		mockLoadConfig.mockReturnValue({
			vault: { path: "/tmp/test" },
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
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
		// Restore default mock
		mockLoadConfig.mockReturnValue({
			vault: { path: "/tmp/test" },
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
		const { message } = createWsHandlers(session);
		const ws = makeWs();
		await message(ws as never, JSON.stringify({ type: "sync_mcp_list" }));
		expect(mockBroadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "mcp_status" }),
		);
	});

	it("with valid agent_cwd: calls send(ws) not broadcast", async () => {
		writeFileSync(
			join(agentDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { "my-server": { command: "bun" } } }),
			"utf8",
		);
		const session = makeSession();
		const { message } = createWsHandlers(session);
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
		const { message } = createWsHandlers(session);
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
		const { message } = createWsHandlers(session);
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
		const { message } = createWsHandlers(session);
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
		const { message } = createWsHandlers(session);
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
