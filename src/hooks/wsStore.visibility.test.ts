/**
 * wsStore — visibilitychange reconnect tests.
 *
 * On mobile browsers the WS onclose event may never fire when the OS
 * backgrounds the app (screen lock). The store's visibilitychange listener
 * calls connect() when the tab becomes visible again so the reconnect
 * effect in useLoadChatHistory fires and history reloads.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as wsStore from "./wsStore";
import { makeMockWs, WS_STATES } from "./wsStore.test-utils";

let wsCtorSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.useFakeTimers();
	// Fresh mock WS that is immediately OPEN (simulates successful connect)
	const mockWs = makeMockWs(WS_STATES.OPEN);
	// biome-ignore lint/complexity/useArrowFunction: constructor mock for Vitest 4
	wsCtorSpy = vi.fn().mockImplementation(function () {
		return mockWs;
	});
	vi.stubGlobal("WebSocket", Object.assign(wsCtorSpy, WS_STATES));

	// Reset all module state; _ws becomes null
	wsStore.__resetForTesting();
	// Clear call count accumulated during module-load-time connect()
	wsCtorSpy.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function setVisibility(state: "visible" | "hidden") {
	Object.defineProperty(document, "visibilityState", {
		value: state,
		writable: true,
		configurable: true,
	});
	document.dispatchEvent(new Event("visibilitychange"));
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("wsStore — visibilitychange reconnect", () => {
	it("creates a new WebSocket when page becomes visible with no active WS", () => {
		// After __resetForTesting(), _ws is null — simulates the case where
		// onclose never fired (OS killed the socket silently on screen lock).
		setVisibility("visible");
		expect(wsCtorSpy).toHaveBeenCalledOnce();
	});

	it("sets wsStatus to connecting when page becomes visible with no active WS", () => {
		setVisibility("visible");
		// connect() sets wsStatus = "connecting" synchronously before onopen
		expect(wsStore.getSnapshot().wsStatus).toBe("connecting");
	});

	it("recreates an apparently open WebSocket when the page resumes", () => {
		// First visibility event: connect() fires → mockWs (readyState=OPEN) assigned
		setVisibility("visible");
		expect(wsCtorSpy).toHaveBeenCalledOnce();
		const firstSocket = wsCtorSpy.mock.results[0].value;

		// Second visibility event: mobile may report OPEN for a dead socket.
		wsCtorSpy.mockClear();
		setVisibility("visible");
		expect(firstSocket.close).toHaveBeenCalled();
		expect(wsCtorSpy).toHaveBeenCalledOnce();
	});

	it("does nothing when page becomes hidden", () => {
		setVisibility("hidden");
		expect(wsCtorSpy).not.toHaveBeenCalled();
	});

	it("backs off repeated failed reconnects and caps the delay", () => {
		setVisibility("visible");
		let socket = wsCtorSpy.mock.results[0].value;
		socket.readyState = WS_STATES.CLOSED;
		socket.onclose?.();

		vi.advanceTimersByTime(2_999);
		expect(wsCtorSpy).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		expect(wsCtorSpy).toHaveBeenCalledTimes(2);

		for (const delay of [6_000, 12_000, 24_000, 30_000, 30_000]) {
			socket = wsCtorSpy.mock.results.at(-1)?.value;
			socket.readyState = WS_STATES.CLOSED;
			socket.onclose?.();
			vi.advanceTimersByTime(delay - 1);
			const calls = wsCtorSpy.mock.calls.length;
			vi.advanceTimersByTime(1);
			expect(wsCtorSpy).toHaveBeenCalledTimes(calls + 1);
		}
	});

	it("cancels a pending reconnect while hidden and reconnects on visibility", () => {
		setVisibility("visible");
		const socket = wsCtorSpy.mock.results[0].value;
		socket.readyState = WS_STATES.CLOSED;
		socket.onclose?.();

		setVisibility("hidden");
		vi.advanceTimersByTime(60_000);
		expect(wsCtorSpy).toHaveBeenCalledTimes(1);

		setVisibility("visible");
		expect(wsCtorSpy).toHaveBeenCalledTimes(2);
	});
});
