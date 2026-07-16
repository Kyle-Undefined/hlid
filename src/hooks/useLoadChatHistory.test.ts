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
import type { ServerMessage } from "#/server/protocol";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("#/hooks/wsStore", () => ({
	setBufferingEnabled: vi.fn(),
	send: vi.fn(),
	drainMessageBuffer: vi.fn().mockReturnValue([]),
	clearMessageBuffer: vi.fn(),
	getSnapshot: vi.fn().mockReturnValue({ sessionState: "idle" }),
	seedActualModel: vi.fn(),
}));

vi.mock("#/hooks/wsChatQueueStore", () => ({
	claimPendingPrompt: vi.fn().mockReturnValue(null),
}));

vi.mock("#/hooks/wsLiveStatsStore", () => ({
	seedContextStats: vi.fn(),
	resetLiveStats: vi.fn(),
}));

vi.mock("#/lib/serverFns/sessions", () => ({
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

import * as chatQueueStore from "#/hooks/wsChatQueueStore";
import * as liveStatsStore from "#/hooks/wsLiveStatsStore";
import * as wsStore from "#/hooks/wsStore";
import {
	getSessionAskUserQuestionsFn,
	getSessionContextFn,
	getSessionDataFn,
	getSessionPermissionsFn,
	getSessionPlanProposalsFn,
} from "#/lib/serverFns/sessions";
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
			effort: null,
			hasPendingPermissions: false,
			runningTurnId: null,
			sleepState: null,
		});
		vi.mocked(chatQueueStore.claimPendingPrompt).mockReturnValue(null);
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

		expect(liveStatsStore.resetLiveStats).not.toHaveBeenCalled();
	});

	it("restores persisted subagent snapshots on tool events", async () => {
		const row = makeRow("assistant", "", 1000);
		vi.mocked(getSessionDataFn).mockResolvedValue([
			{
				...row,
				toolEvents: [
					{
						id: 1,
						session_id: "sess-1",
						assistant_seq: row.seq,
						tool_id: "spawn-1",
						name: "spawn_agent",
						input_json: JSON.stringify({ prompt: "Inspect auth" }),
						result_text: null,
						result_length: null,
						result_truncated: 0,
						is_error: null,
						subagent_json: JSON.stringify({
							provider: "codex",
							agentId: "child-1",
							status: "running",
							startedAtMs: 1000,
							currentStep: "Reading files",
						}),
					},
				],
			},
		]);
		const dispatch = vi.fn();
		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef: { current: null },
			historyReadyRef: { current: false },
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef: { current: "sess-1" },
		});
		await act(async () => {});

		const load = dispatch.mock.calls.find(
			([action]) => action.type === "LOAD_HISTORY",
		)?.[0];
		expect(load.items[0].toolEvents[0].subagent).toMatchObject({
			agentId: "child-1",
			status: "running",
			currentStep: "Reading files",
		});
	});

	it("maps historical result previews to lazy session-scoped tool events", async () => {
		const row = makeRow("assistant", "", 1000);
		vi.mocked(getSessionDataFn).mockResolvedValue([
			{
				...row,
				toolEvents: [
					{
						id: 1,
						session_id: "sess-1",
						assistant_seq: row.seq,
						tool_id: "tool-1",
						name: "Read",
						input_json: JSON.stringify({ path: "README.md" }),
						result_text: "preview",
						result_length: 10_000,
						result_truncated: 1,
						is_error: 0,
						subagent_json: null,
					},
				],
			},
		]);
		const dispatch = vi.fn();
		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef: { current: null },
			historyReadyRef: { current: false },
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef: { current: "sess-1" },
		});
		await act(async () => {});

		const load = dispatch.mock.calls.find(
			([action]) => action.type === "LOAD_HISTORY",
		)?.[0];
		expect(load.items[0].toolEvents[0]).toMatchObject({
			id: "tool-1",
			result: "preview",
			resultLength: 10_000,
			resultTruncated: true,
			detailSessionId: "sess-1",
		});
	});

	it("uses a 201-row lookahead and prepends the preceding cursor page without overlap", async () => {
		const rows = (start: number, end: number) =>
			Array.from({ length: end - start + 1 }, (_, index) => {
				const seq = start + index;
				return {
					id: seq + 1,
					session_id: "sess-1",
					seq,
					role: seq % 2 === 0 ? "user" : "assistant",
					text: `message ${seq}`,
					timestamp: 1_000 + seq,
					toolEvents: [],
					attachments: [],
					recap: null,
				};
			});
		vi.mocked(getSessionDataFn)
			.mockResolvedValueOnce(rows(100, 300))
			.mockResolvedValueOnce(rows(0, 100));
		const dispatch = vi.fn();
		const hook = renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef: { current: null },
			historyReadyRef: { current: false },
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef: { current: "sess-1" },
		});

		await act(async () => {});
		expect(hook.result.current.hasOlderHistory).toBe(true);
		let loaded = 0;
		await act(async () => {
			loaded = await hook.result.current.loadOlderHistory();
		});

		expect(loaded).toBe(101);
		expect(getSessionDataFn).toHaveBeenNthCalledWith(1, {
			data: { sessionId: "sess-1", limit: 201 },
		});
		expect(getSessionDataFn).toHaveBeenNthCalledWith(2, {
			data: {
				sessionId: "sess-1",
				beforeSeq: 101,
				beforeId: 102,
				limit: 201,
			},
		});
		const initial = dispatch.mock.calls.find(
			([action]) => action.type === "LOAD_HISTORY",
		)?.[0];
		const prepend = dispatch.mock.calls.find(
			([action]) => action.type === "PREPEND_HISTORY",
		)?.[0];
		const combinedMessages = [...prepend.items, ...initial.items].filter(
			(item) => item.kind === "message",
		);
		const combinedTexts = combinedMessages.map((item) => item.text);
		expect(combinedTexts).toEqual(
			Array.from({ length: 301 }, (_, seq) => `message ${seq}`),
		);
		expect(new Set(combinedTexts).size).toBe(301);
		expect(combinedMessages.map((item) => item.id)).toEqual(
			Array.from(
				{ length: 301 },
				(_, index) => `persisted-message:${index + 1}`,
			),
		);
		expect(getSessionPlanProposalsFn).toHaveBeenNthCalledWith(2, {
			data: {
				sessionId: "sess-1",
				minSeq: 0,
				maxSeq: 100,
				beforeSeq: 101,
			},
		});
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
			effort: null,
			hasPendingPermissions: false,
			runningTurnId: null,
			sleepState: null,
		});
		vi.mocked(chatQueueStore.claimPendingPrompt).mockReturnValue(null);
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

		const userRow = makeRow("user", "hello", 1000);
		const assistantRow = makeRow("assistant", "world", 2000);
		// First DB call (initial load) returns just a user message. Reconnect
		// returns that same persisted row plus the newly persisted assistant.
		vi.mocked(getSessionDataFn)
			.mockResolvedValueOnce([userRow])
			// Second call (reconnect) returns user + assistant
			.mockResolvedValueOnce([userRow, assistantRow]);

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
		expect(getSessionDataFn).toHaveBeenNthCalledWith(2, {
			data: { sessionId: "sess-1", minSeq: 1, minId: 1 },
		});

		// LOAD_HISTORY dispatched twice
		const loadHistoryCalls = dispatch.mock.calls.filter(
			([a]) => a.type === "LOAD_HISTORY",
		);
		expect(loadHistoryCalls).toHaveLength(2);
		expect(loadHistoryCalls[0][0].items[0].id).toBe("persisted-message:1");
		expect(loadHistoryCalls[1][0].items[0].id).toBe("persisted-message:1");

		// Second LOAD_HISTORY includes the assistant message
		const secondItems = loadHistoryCalls[1][0].items as { role: string }[];
		expect(secondItems.some((i) => i.role === "assistant")).toBe(true);
	});

	it("keeps a persisted user message keyed by its queued turn id", async () => {
		vi.mocked(getSessionDataFn).mockResolvedValue([
			{ ...makeRow("user", "queued prompt"), turn_id: "queued-turn-1" },
		]);

		const dispatch = vi.fn();
		const pendingIdRef = { current: null };
		const historyReadyRef = { current: false };
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

		const loadHistory = dispatch.mock.calls.find(
			([action]) => action.type === "LOAD_HISTORY",
		)?.[0];
		expect(loadHistory.items[0].id).toBe("queued-turn-1");
	});

	it("serializes reconnect behind an in-flight older-page load", async () => {
		const rows = (start: number, end: number) =>
			Array.from({ length: end - start + 1 }, (_, index) => {
				const seq = start + index;
				return {
					id: seq + 1,
					session_id: "sess-1",
					seq,
					role: "user" as const,
					text: `message ${seq}`,
					timestamp: 1_000 + seq,
					toolEvents: [],
					attachments: [],
					recap: null,
				};
			});
		let resolveOlder!: (value: ReturnType<typeof rows>) => void;
		const olderPage = new Promise<ReturnType<typeof rows>>((resolve) => {
			resolveOlder = resolve;
		});
		vi.mocked(getSessionDataFn)
			.mockResolvedValueOnce(rows(100, 300))
			.mockReturnValueOnce(olderPage)
			.mockResolvedValueOnce(rows(0, 300));
		const dispatch = vi.fn();
		const historyReadyRef = { current: false };
		const pendingIdRef = { current: null as string | null };
		const sessionIdRef = { current: "sess-1" };
		const hook = renderHistory({
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

		let olderRequest!: Promise<number>;
		act(() => {
			olderRequest = hook.result.current.loadOlderHistory();
		});
		hook.rerender({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "disconnected",
			sessionIdRef,
		});
		hook.rerender({
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
		expect(getSessionDataFn).toHaveBeenCalledTimes(2);

		await act(async () => {
			resolveOlder(rows(0, 100));
			await olderRequest;
		});
		await act(async () => {});

		expect(getSessionDataFn).toHaveBeenCalledTimes(3);
		expect(getSessionDataFn).toHaveBeenNthCalledWith(3, {
			data: { sessionId: "sess-1", minSeq: 0, minId: 1 },
		});
		expect(
			dispatch.mock.calls
				.map(([action]) => action.type)
				.filter(
					(type) => type === "LOAD_HISTORY" || type === "PREPEND_HISTORY",
				),
		).toEqual(["LOAD_HISTORY", "PREPEND_HISTORY", "LOAD_HISTORY"]);
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
			effort: null,
			hasPendingPermissions: false,
			runningTurnId: null,
			sleepState: null,
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
		expect(liveStatsStore.resetLiveStats).not.toHaveBeenCalled();
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

		expect(liveStatsStore.resetLiveStats).not.toHaveBeenCalled();
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
			result_length: null,
			result_truncated: 0,
			is_error: null,
		})),
		attachments: [],
		recap: null,
	};
}

describe("useLoadChatHistory — in-flight assistant reuse during running turn", () => {
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
			effort: null,
			hasPendingPermissions: false,
			runningTurnId: null,
			sleepState: null,
		});
		vi.mocked(chatQueueStore.claimPendingPrompt).mockReturnValue(null);
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

		// pendingIdRef should match the placeholder's stable persisted-row id from
		// the LOAD_HISTORY items.
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

	it("reuses the in-flight assistant when its persisted text is non-empty", async () => {
		const dispatch = vi.fn();
		const historyReadyRef = { current: false };
		const pendingIdRef = { current: null as string | null };
		const sessionIdRef = { current: "sess-1" };

		vi.mocked(getSessionDataFn).mockResolvedValue([
			makeRow("user", "hi", 1000),
			makeRow("assistant", "partial response", 2000),
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
		expect(addAssistantCalls).toHaveLength(0);
		const loadCall = dispatch.mock.calls.find(
			([a]) => a.type === "LOAD_HISTORY",
		);
		const items = loadCall?.[0].items as { role: string; id: string }[];
		const assistant = items.find((item) => item.role === "assistant");
		expect(pendingIdRef.current).toBe(assistant?.id);
	});

	it("forwards replay events after reusing the persisted in-flight assistant", async () => {
		const dispatch = vi.fn();
		const historyReadyRef = { current: false };
		const pendingIdRef = { current: null as string | null };
		const sessionIdRef = { current: "sess-1" };

		vi.mocked(getSessionDataFn).mockResolvedValue([
			makeRow("user", "go", 1000),
			makeAssistantRowWithTools(["tu-1"]),
		]);

		// Buffer contains duplicate tu-1 events, a fresh tu-2, an offset-aware
		// chunk (the reducer can safely reconcile it), and an ask_user_question.
		const readyStates: boolean[] = [];
		const handleWsMessage = vi.fn((_message: ServerMessage) => {
			readyStates.push(historyReadyRef.current);
		});
		vi.mocked(wsStore.drainMessageBuffer).mockReturnValue([
			{ type: "tool_event", id: "tu-1", name: "Read", input: {} },
			{ type: "tool_result", id: "tu-1", content: "duplicate" },
			{ type: "tool_event", id: "tu-2", name: "Read", input: {} },
			{ type: "chunk", text: "live text", offset: 0 },
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
		expect(readyStates.every(Boolean)).toBe(true);
		expect(forwarded).toEqual([
			{ type: "tool_event", id: "tu-1", name: "Read", input: {} },
			{ type: "tool_result", id: "tu-1", content: "duplicate" },
			{ type: "tool_event", id: "tu-2", name: "Read", input: {} },
			{ type: "chunk", text: "live text", offset: 0 },
			{
				type: "ask_user_question",
				id: "aq-1",
				questions: [{ question: "?", options: ["a"], multiSelect: false }],
			},
		]);
	});
});
