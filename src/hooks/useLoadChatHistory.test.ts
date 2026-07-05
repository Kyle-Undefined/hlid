/**
 * useLoadChatHistory — reconnect recovery tests.
 *
 * We verify that when wsStatus transitions disconnected → connected (after an
 * initial load has completed), the hook re-fetches session history from DB and
 * dispatches LOAD_HISTORY with the fresh data. This is the core of the
 * "dot went green but chat didn't update" bug fix.
 *
 * jsdom environment is required because the hook uses React effects.
 * wsStore and serverFns are fully mocked to prevent real WS connections
 * or network calls.
 */
// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("#/hooks/wsStore", () => ({
	setBufferingEnabled: vi.fn(),
	send: vi.fn(),
	claimPendingPrompt: vi.fn().mockReturnValue(null),
	drainMessageBuffer: vi.fn().mockReturnValue([]),
	clearMessageBuffer: vi.fn(),
	getSnapshot: vi.fn().mockReturnValue({ sessionState: "idle" }),
	seedContextStats: vi.fn(),
	seedActualModel: vi.fn(),
	resetLiveStats: vi.fn(),
}));

vi.mock("#/lib/serverFns", () => ({
	getSessionDataFn: vi.fn(),
	getSessionContextFn: vi.fn(),
	getSessionPermissionsFn: vi.fn(),
	getSessionPlanProposalsFn: vi.fn(),
	getSessionAskUserQuestionsFn: vi.fn(),
}));

vi.mock("#/lib/utils", () => ({
	uid: vi.fn().mockReturnValue("test-uid"),
}));

// ── imports (after mocks) ─────────────────────────────────────────────────────

import * as wsStore from "#/hooks/wsStore";
import {
	getSessionAskUserQuestionsFn,
	getSessionContextFn,
	getSessionDataFn,
	getSessionPermissionsFn,
	getSessionPlanProposalsFn,
} from "#/lib/serverFns";
import { useLoadChatHistory } from "./useLoadChatHistory";

// ── helpers ───────────────────────────────────────────────────────────────────

const noopWsHandler = vi.fn();

let _seq = 0;
function makeRow(role: "user" | "assistant", text: string, timestamp = 1000) {
	const id = ++_seq;
	return {
		id,
		session_id: "sess-1",
		seq: id,
		role,
		text,
		timestamp,
		toolEvents: [],
		attachments: [],
		recap: null,
	};
}

function makePerms() {
	return [];
}

function makeCtx() {
	return { context_window: null, last_context_used: null, actual_model: null };
}

type HookProps = Parameters<typeof useLoadChatHistory>[0];

function renderHistory(props: HookProps) {
	return renderHook((p: HookProps) => useLoadChatHistory(p), {
		initialProps: props,
	});
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("useLoadChatHistory — initial load", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		_seq = 0;
		vi.mocked(wsStore.getSnapshot).mockReturnValue({
			sessionState: "idle",
			wsStatus: "connected",
			model: "",
			actualModel: null,
			permissionMode: null,
			hasPendingPermissions: false,
			runningTurnId: null,
		});
		vi.mocked(wsStore.claimPendingPrompt).mockReturnValue(null);
		vi.mocked(wsStore.drainMessageBuffer).mockReturnValue([]);
		vi.mocked(getSessionContextFn).mockResolvedValue(makeCtx());
		vi.mocked(getSessionPermissionsFn).mockResolvedValue(makePerms());
		vi.mocked(getSessionPlanProposalsFn).mockResolvedValue([]);
		vi.mocked(getSessionAskUserQuestionsFn).mockResolvedValue([]);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("preserves live stats across session navigation (does not reset on load)", async () => {
		// Stats should persist when navigating to any session — they track the active
		// running session, not the viewed session. Reset only happens when a new run
		// starts (index.tsx) or the user explicitly clears (raven.tsx).
		vi.mocked(getSessionDataFn).mockResolvedValue([
			makeRow("user", "hello", 1000),
		]);

		const dispatch = vi.fn();
		const historyReadyRef = { current: false };
		const pendingIdRef = { current: null as string | null };
		const sessionIdRef = { current: "sess-1" };

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		expect(wsStore.resetLiveStats).not.toHaveBeenCalled();
	});
});

describe("useLoadChatHistory — reconnect recovery", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		_seq = 0;
		vi.mocked(wsStore.getSnapshot).mockReturnValue({
			sessionState: "idle",
			wsStatus: "connected",
			model: "",
			actualModel: null,
			permissionMode: null,
			hasPendingPermissions: false,
			runningTurnId: null,
		});
		vi.mocked(wsStore.claimPendingPrompt).mockReturnValue(null);
		vi.mocked(wsStore.drainMessageBuffer).mockReturnValue([]);
		vi.mocked(getSessionContextFn).mockResolvedValue(makeCtx());
		vi.mocked(getSessionPermissionsFn).mockResolvedValue(makePerms());
		vi.mocked(getSessionPlanProposalsFn).mockResolvedValue([]);
		vi.mocked(getSessionAskUserQuestionsFn).mockResolvedValue([]);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("dispatches LOAD_HISTORY on reconnect with fresh DB data", async () => {
		const dispatch = vi.fn();
		const historyReadyRef = { current: false };
		const pendingIdRef = { current: null as string | null };
		const sessionIdRef = { current: "sess-1" };

		// First DB call (initial load) returns just a user message
		vi.mocked(getSessionDataFn)
			.mockResolvedValueOnce([makeRow("user", "hello", 1000)])
			// Second call (reconnect) returns user + assistant
			.mockResolvedValueOnce([
				makeRow("user", "hello", 1000),
				makeRow("assistant", "world", 2000),
			]);

		const { rerender } = renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});

		// Wait for initial load to complete
		await act(async () => {});

		expect(historyReadyRef.current).toBe(true);
		const loadHistoryCallCount = dispatch.mock.calls.filter(
			([a]) => a.type === "LOAD_HISTORY",
		).length;
		expect(loadHistoryCallCount).toBe(1);

		// Simulate disconnect then reconnect
		rerender({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "disconnected",
			sessionIdRef,
		});

		await act(async () => {});

		rerender({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		// getSessionDataFn called twice (initial + reconnect)
		expect(getSessionDataFn).toHaveBeenCalledTimes(2);

		// LOAD_HISTORY dispatched twice
		const loadHistoryCalls = dispatch.mock.calls.filter(
			([a]) => a.type === "LOAD_HISTORY",
		);
		expect(loadHistoryCalls).toHaveLength(2);

		// Second LOAD_HISTORY includes the assistant message
		const secondItems = loadHistoryCalls[1][0].items as { role: string }[];
		expect(secondItems.some((i) => i.role === "assistant")).toBe(true);
	});

	it("on reconnect clears stale pendingIdRef before re-fetch", async () => {
		const dispatch = vi.fn();
		const historyReadyRef = { current: false };
		const pendingIdRef = { current: "stale-bubble-id" as string | null };
		const sessionIdRef = { current: "sess-1" };

		vi.mocked(getSessionDataFn).mockResolvedValue([
			makeRow("user", "hi", 1000),
		]);

		const { rerender } = renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		// Simulate stale pending bubble (e.g., done was missed)
		pendingIdRef.current = "stale-bubble-id";

		rerender({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "disconnected",
			sessionIdRef,
		});

		rerender({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		// Stale bubble cleared before re-fetch
		expect(pendingIdRef.current).toBeNull();
	});

	it("on reconnect with running session, adds bubble and drains buffer", async () => {
		const dispatch = vi.fn();
		const historyReadyRef = { current: false };
		const pendingIdRef = { current: null as string | null };
		const sessionIdRef = { current: "sess-1" };
		const handleWsMessage = vi.fn();
		const bufferedMsg = { type: "chunk" as const, text: "hello" };

		vi.mocked(getSessionDataFn).mockResolvedValue([
			makeRow("user", "query", 1000),
		]);
		vi.mocked(wsStore.drainMessageBuffer).mockReturnValue([bufferedMsg]);

		const { rerender } = renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		// Session is running when we reconnect
		vi.mocked(wsStore.getSnapshot).mockReturnValue({
			sessionState: "running",
			wsStatus: "connected",
			model: "",
			actualModel: null,
			permissionMode: null,
			hasPendingPermissions: false,
			runningTurnId: null,
		});

		rerender({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage,
			wsStatus: "disconnected",
			sessionIdRef,
		});

		rerender({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		// ADD_ASSISTANT dispatched for new bubble
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({ type: "ADD_ASSISTANT" }),
		);
		// Buffered message replayed
		expect(handleWsMessage).toHaveBeenCalledWith(bufferedMsg);
	});

	it("skips reconnect re-fetch if historyReady is still false", async () => {
		const dispatch = vi.fn();
		const pendingIdRef = { current: null as string | null };
		const sessionIdRef = { current: "sess-1" };

		vi.mocked(getSessionDataFn).mockResolvedValue([]);

		const { rerender } = renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef: { current: false }, // stays false
			handleWsMessage: noopWsHandler,
			wsStatus: "connecting",
			sessionIdRef,
		});

		await act(async () => {});

		// Force wsConnectedOnceRef to be set by simulating an initial connect
		// without a real initial load completing (historyReady stays false)
		rerender({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef: { current: false },
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		rerender({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef: { current: false }, // still not ready
			handleWsMessage: noopWsHandler,
			wsStatus: "disconnected",
			sessionIdRef,
		});

		rerender({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef: { current: false },
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		// getSessionDataFn should only be called once (initial load, NOT the reconnect)
		// because historyReady is false
		// Note: initial load may have called it depending on whether existingSessionId triggers it
		// The reconnect effect guards with historyReadyRef.current === false → skip
		// So reconnect fetch does NOT add a second call beyond initial load
		const calls = vi.mocked(getSessionDataFn).mock.calls;
		// All calls should be with { data: "sess-1" } but we verify reconnect didn't add extras
		// The initial load effect fires (existingSessionId="sess-1"), so 1 call expected
		// Reconnect would be a 2nd call — we expect it NOT to fire
		expect(calls.length).toBe(1);
	});

	it("does not reset live stats when navigating to an explicit session", async () => {
		const dispatch = vi.fn();
		const historyReadyRef = { current: false };
		const pendingIdRef = { current: null as string | null };
		const sessionIdRef = { current: "sess-2" };

		vi.mocked(getSessionDataFn).mockResolvedValue([
			makeRow("user", "hello", 1000),
		]);

		renderHistory({
			existingSessionId: "sess-2",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		// Stats persist across SPA navigation — only index.tsx resets on new run.
		expect(wsStore.resetLiveStats).not.toHaveBeenCalled();
	});

	it("does not reset live stats when navigating to an implicit session", async () => {
		const dispatch = vi.fn();
		const historyReadyRef = { current: false };
		const pendingIdRef = { current: null as string | null };
		const sessionIdRef = { current: "sess-1" };

		vi.mocked(getSessionDataFn).mockResolvedValue([
			makeRow("user", "hello", 1000),
		]);

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: false,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		expect(wsStore.resetLiveStats).not.toHaveBeenCalled();
	});

	it("does NOT re-fetch on first connect (initial load handles that)", async () => {
		const dispatch = vi.fn();
		const historyReadyRef = { current: false };
		const pendingIdRef = { current: null as string | null };
		const sessionIdRef = { current: "sess-1" };

		vi.mocked(getSessionDataFn).mockResolvedValue([
			makeRow("user", "hello", 1000),
		]);

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		// Only ONE LOAD_HISTORY dispatch — initial load, not a duplicate from reconnect effect
		const loadHistoryCalls = dispatch.mock.calls.filter(
			([a]) => a.type === "LOAD_HISTORY",
		);
		expect(loadHistoryCalls).toHaveLength(1);
		// And only one DB fetch
		expect(getSessionDataFn).toHaveBeenCalledTimes(1);
	});
});

// ── Mid-turn placeholder reuse ────────────────────────────────────────────────
// When the server pre-inserts an empty assistant placeholder + tool_event rows
// at first tool_start, a mid-turn reload must reuse that placeholder id as the
// pending bubble (instead of opening a fresh ADD_ASSISTANT bubble) so the user
// sees a single coherent assistant turn — not the placeholder followed by a
// second empty bubble.

function makeAssistantRowWithTools(
	toolIds: string[],
	{ text = "", timestamp = 2000 }: { text?: string; timestamp?: number } = {},
) {
	const id = ++_seq;
	return {
		id,
		session_id: "sess-1",
		seq: id,
		role: "assistant" as const,
		text,
		timestamp,
		toolEvents: toolIds.map((tid) => ({
			id: 0,
			session_id: "sess-1",
			assistant_seq: id,
			tool_id: tid,
			name: "Read",
			input_json: "{}",
			result_text: null,
			is_error: null,
		})),
		attachments: [],
		recap: null,
	};
}

describe("useLoadChatHistory — placeholder reuse during running turn", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		_seq = 0;
		// Session is RUNNING — mid-turn reload scenario.
		vi.mocked(wsStore.getSnapshot).mockReturnValue({
			sessionState: "running",
			wsStatus: "connected",
			model: "",
			actualModel: null,
			permissionMode: null,
			hasPendingPermissions: false,
			runningTurnId: null,
		});
		vi.mocked(wsStore.claimPendingPrompt).mockReturnValue(null);
		vi.mocked(wsStore.drainMessageBuffer).mockReturnValue([]);
		vi.mocked(getSessionContextFn).mockResolvedValue(makeCtx());
		vi.mocked(getSessionPermissionsFn).mockResolvedValue([]);
		vi.mocked(getSessionPlanProposalsFn).mockResolvedValue([]);
		vi.mocked(getSessionAskUserQuestionsFn).mockResolvedValue([]);
	});

	it("reuses placeholder id as pendingIdRef when last assistant row has empty text", async () => {
		const dispatch = vi.fn();
		const historyReadyRef = { current: false };
		const pendingIdRef = { current: null as string | null };
		const sessionIdRef = { current: "sess-1" };

		vi.mocked(getSessionDataFn).mockResolvedValue([
			makeRow("user", "read please", 1000),
			makeAssistantRowWithTools(["tu-1", "tu-2"]),
		]);

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		// Should NOT dispatch a fresh ADD_ASSISTANT — we reuse the placeholder.
		const addAssistantCalls = dispatch.mock.calls.filter(
			([a]) => a.type === "ADD_ASSISTANT",
		);
		expect(addAssistantCalls).toHaveLength(0);

		// pendingIdRef should match the placeholder's id from the LOAD_HISTORY items.
		const loadCall = dispatch.mock.calls.find(
			([a]) => a.type === "LOAD_HISTORY",
		);
		const items = loadCall?.[0].items as { role: string; id: string }[];
		const placeholder = [...items]
			.reverse()
			.find((i: { role: string; id: string }) => i.role === "assistant");
		expect(pendingIdRef.current).toBe(placeholder?.id);
	});

	it("opens a fresh bubble when no placeholder exists (last row is user)", async () => {
		const dispatch = vi.fn();
		const historyReadyRef = { current: false };
		const pendingIdRef = { current: null as string | null };
		const sessionIdRef = { current: "sess-1" };

		vi.mocked(getSessionDataFn).mockResolvedValue([
			makeRow("user", "hello", 1000),
		]);

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		const addAssistantCalls = dispatch.mock.calls.filter(
			([a]) => a.type === "ADD_ASSISTANT",
		);
		expect(addAssistantCalls).toHaveLength(1);
		expect(pendingIdRef.current).toBe(addAssistantCalls[0][0].id);
	});

	it("opens a fresh bubble when last assistant row has non-empty text (not a placeholder)", async () => {
		const dispatch = vi.fn();
		const historyReadyRef = { current: false };
		const pendingIdRef = { current: null as string | null };
		const sessionIdRef = { current: "sess-1" };

		vi.mocked(getSessionDataFn).mockResolvedValue([
			makeRow("user", "hi", 1000),
			makeRow("assistant", "completed turn", 2000),
		]);

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		const addAssistantCalls = dispatch.mock.calls.filter(
			([a]) => a.type === "ADD_ASSISTANT",
		);
		expect(addAssistantCalls).toHaveLength(1);
	});

	it("dedupes drained tool_event/tool_result whose tool_use_id is already on the placeholder, and drops chunks (DB streams text)", async () => {
		const dispatch = vi.fn();
		const historyReadyRef = { current: false };
		const pendingIdRef = { current: null as string | null };
		const sessionIdRef = { current: "sess-1" };

		vi.mocked(getSessionDataFn).mockResolvedValue([
			makeRow("user", "go", 1000),
			makeAssistantRowWithTools(["tu-1"]),
		]);

		// Buffer contains: duplicate tu-1 events, a fresh tu-2, a chunk (must be
		// dropped — assistant text streams to DB row directly), and an
		// ask_user_question (NOT persisted to DB, must pass through).
		const handleWsMessage = vi.fn();
		vi.mocked(wsStore.drainMessageBuffer).mockReturnValue([
			{ type: "tool_event", id: "tu-1", name: "Read", input: {} },
			{ type: "tool_result", id: "tu-1", content: "duplicate" },
			{ type: "tool_event", id: "tu-2", name: "Read", input: {} },
			{ type: "chunk", text: "live text" },
			{
				type: "ask_user_question",
				id: "aq-1",
				questions: [{ question: "?", options: ["a"], multiSelect: false }],
			},
		]);

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		const forwarded = handleWsMessage.mock.calls.map((c) => c[0]);
		expect(forwarded).toEqual([
			{ type: "tool_event", id: "tu-2", name: "Read", input: {} },
			{
				type: "ask_user_question",
				id: "aq-1",
				questions: [{ question: "?", options: ["a"], multiSelect: false }],
			},
		]);
	});
});
