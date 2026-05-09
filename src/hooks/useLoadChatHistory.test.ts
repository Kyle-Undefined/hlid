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
}));

vi.mock("#/lib/utils", () => ({
	uid: vi.fn().mockReturnValue("test-uid"),
}));

// ── imports (after mocks) ─────────────────────────────────────────────────────

import * as wsStore from "#/hooks/wsStore";
import {
	getSessionContextFn,
	getSessionDataFn,
	getSessionPermissionsFn,
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

describe("useLoadChatHistory — reconnect recovery", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		_seq = 0;
		vi.mocked(wsStore.getSnapshot).mockReturnValue({
			sessionState: "idle",
			wsStatus: "connected",
			model: "",
			actualModel: null,
			hasPendingPermissions: false,
		});
		vi.mocked(wsStore.claimPendingPrompt).mockReturnValue(null);
		vi.mocked(wsStore.drainMessageBuffer).mockReturnValue([]);
		vi.mocked(getSessionContextFn).mockResolvedValue(makeCtx());
		vi.mocked(getSessionPermissionsFn).mockResolvedValue(makePerms());
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
			hasPendingPermissions: false,
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

	it("resets live stats when loading an explicit session (prevents prev-session bleed)", async () => {
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

		// Stats from prior session must be cleared even on explicit session nav —
		// applyCtx re-seeds from DB immediately after, so reset is always safe.
		expect(wsStore.resetLiveStats).toHaveBeenCalled();
	});

	it("resets live stats when loading an implicit session (baseline behaviour)", async () => {
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

		expect(wsStore.resetLiveStats).toHaveBeenCalled();
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
