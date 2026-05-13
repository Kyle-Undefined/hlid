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
	// Fresh mock WS that is immediately OPEN (simulates successful connect)
	const mockWs = makeMockWs(WS_STATES.OPEN);
	wsCtorSpy = vi.fn().mockReturnValue(mockWs);
	vi.stubGlobal("WebSocket", Object.assign(wsCtorSpy, WS_STATES));

	// Reset all module state; _ws becomes null
	wsStore.__resetForTesting();
	// Clear call count accumulated during module-load-time connect()
	wsCtorSpy.mockClear();
});

afterEach(() => {
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

	it("does NOT create a new WebSocket if WS is already open", () => {
		// First visibility event: connect() fires → mockWs (readyState=OPEN) assigned
		setVisibility("visible");
		expect(wsCtorSpy).toHaveBeenCalledOnce();

		// Second visibility event: WS is OPEN → connect() guard returns early
		wsCtorSpy.mockClear();
		setVisibility("visible");
		expect(wsCtorSpy).not.toHaveBeenCalled();
	});

	it("does nothing when page becomes hidden", () => {
		setVisibility("hidden");
		expect(wsCtorSpy).not.toHaveBeenCalled();
	});
});
