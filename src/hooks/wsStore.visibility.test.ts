/**
 * wsStore — mobile/PWA lifecycle reconnect tests.
 *
 * Suspended browsers can retain an OPEN or CONNECTING readyState without ever
 * delivering close. Explicit foreground/network recovery must retire that
 * attempt, while ordinary focus events remain idempotent.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as wsStore from "./wsStore";
import { type MockWs, makeMockWs, WS_STATES } from "./wsStore.test-utils";

let sockets: MockWs[];
let wsCtorSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.useFakeTimers();
	sockets = [];
	// Every attempt needs a distinct socket so stale-generation callbacks are
	// observable instead of accidentally targeting the replacement object.
	// biome-ignore lint/complexity/useArrowFunction: constructor mock for Vitest 4
	wsCtorSpy = vi.fn().mockImplementation(function () {
		const socket = makeMockWs(WS_STATES.CONNECTING);
		sockets.push(socket);
		return socket;
	});
	vi.stubGlobal("WebSocket", Object.assign(wsCtorSpy, WS_STATES));
	Object.defineProperty(document, "visibilityState", {
		value: "visible",
		writable: true,
		configurable: true,
	});

	wsStore.__resetForTesting();
	wsCtorSpy.mockClear();
	sockets = [];
});

afterEach(() => {
	wsStore.__resetForTesting();
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function setVisibility(state: "visible" | "hidden") {
	Object.defineProperty(document, "visibilityState", {
		value: state,
		writable: true,
		configurable: true,
	});
	document.dispatchEvent(new Event("visibilitychange"));
}

function openSocket(socket: MockWs): void {
	socket.readyState = WS_STATES.OPEN;
	socket.onopen?.();
}

function failSocket(socket: MockWs): void {
	socket.readyState = WS_STATES.CLOSED;
	socket.onclose?.();
}

function dispatchPageShow(persisted: boolean): void {
	const event = new Event("pageshow");
	Object.defineProperty(event, "persisted", { value: persisted });
	window.dispatchEvent(event);
}

describe("wsStore — lifecycle reconnect", () => {
	it("creates a replay-capable WebSocket when the page becomes visible", () => {
		setVisibility("visible");

		expect(wsCtorSpy).toHaveBeenCalledOnce();
		expect(wsCtorSpy.mock.calls[0]?.[0]).toContain("/ws?replay_batch=1");
		expect(wsStore.getSnapshot().wsStatus).toBe("connecting");
	});

	it("recreates an apparently open WebSocket when the page resumes", () => {
		setVisibility("visible");
		const firstSocket = sockets[0];
		openSocket(firstSocket);

		setVisibility("hidden");
		setVisibility("visible");

		expect(firstSocket.close).toHaveBeenCalledOnce();
		expect(wsCtorSpy).toHaveBeenCalledTimes(2);
		expect(wsStore.getSnapshot().wsStatus).toBe("connecting");
	});

	it("immediately replaces a stale CONNECTING socket on resume", () => {
		setVisibility("visible");
		const staleSocket = sockets[0];

		setVisibility("hidden");
		setVisibility("visible");

		expect(staleSocket.close).toHaveBeenCalledOnce();
		expect(wsCtorSpy).toHaveBeenCalledTimes(2);
	});

	it("does nothing when the page becomes hidden", () => {
		setVisibility("hidden");
		expect(wsCtorSpy).not.toHaveBeenCalled();
	});

	it("backs off repeated failures from one second and caps the delay", () => {
		setVisibility("visible");
		failSocket(sockets[0]);

		for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
			vi.advanceTimersByTime(delay - 1);
			const calls = wsCtorSpy.mock.calls.length;
			vi.advanceTimersByTime(1);
			expect(wsCtorSpy).toHaveBeenCalledTimes(calls + 1);
			failSocket(sockets.at(-1) as MockWs);
		}
	});

	it("cancels pending backoff while hidden and reconnects immediately on resume", () => {
		setVisibility("visible");
		failSocket(sockets[0]);

		setVisibility("hidden");
		vi.advanceTimersByTime(60_000);
		expect(wsCtorSpy).toHaveBeenCalledTimes(1);

		setVisibility("visible");
		expect(wsCtorSpy).toHaveBeenCalledTimes(2);
	});

	it("retires a silent CONNECTING attempt at the deadline and retries once", () => {
		setVisibility("visible");
		const socket = sockets[0];
		const staleClose = socket.onclose;

		vi.advanceTimersByTime(2_999);
		expect(socket.close).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(socket.close).toHaveBeenCalledOnce();
		expect(wsStore.getSnapshot().wsStatus).toBe("disconnected");

		staleClose?.();
		vi.advanceTimersByTime(999);
		expect(wsCtorSpy).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		expect(wsCtorSpy).toHaveBeenCalledTimes(2);
	});

	it("recovers from onerror even when onclose never arrives", () => {
		setVisibility("visible");
		const socket = sockets[0];
		const staleClose = socket.onclose;

		socket.onerror?.();
		expect(socket.close).toHaveBeenCalledOnce();
		expect(wsStore.getSnapshot().wsStatus).toBe("disconnected");
		vi.advanceTimersByTime(1_000);
		expect(wsCtorSpy).toHaveBeenCalledTimes(2);
		openSocket(sockets[1]);

		staleClose?.();
		vi.advanceTimersByTime(30_000);
		expect(wsCtorSpy).toHaveBeenCalledTimes(2);
	});

	it("ignores stale open and close callbacks from a retired generation", () => {
		setVisibility("visible");
		const firstSocket = sockets[0];
		const staleOpen = firstSocket.onopen;
		const staleClose = firstSocket.onclose;

		setVisibility("hidden");
		setVisibility("visible");
		staleOpen?.();
		staleClose?.();

		expect(firstSocket.send).not.toHaveBeenCalled();
		expect(wsStore.getSnapshot().wsStatus).toBe("connecting");
		expect(wsCtorSpy).toHaveBeenCalledTimes(2);
	});

	it("foreground recovery bypasses and resets accumulated backoff", () => {
		setVisibility("visible");
		failSocket(sockets[0]);
		vi.advanceTimersByTime(1_000);
		failSocket(sockets[1]);

		vi.advanceTimersByTime(500);
		setVisibility("hidden");
		setVisibility("visible");
		expect(wsCtorSpy).toHaveBeenCalledTimes(3);
		failSocket(sockets[2]);

		vi.advanceTimersByTime(999);
		expect(wsCtorSpy).toHaveBeenCalledTimes(3);
		vi.advanceTimersByTime(1);
		expect(wsCtorSpy).toHaveBeenCalledTimes(4);
	});

	it("online replaces a visible socket but remains inert while hidden", () => {
		setVisibility("visible");
		const firstSocket = sockets[0];
		openSocket(firstSocket);
		vi.advanceTimersByTime(251);

		window.dispatchEvent(new Event("online"));
		expect(firstSocket.close).toHaveBeenCalledOnce();
		expect(wsCtorSpy).toHaveBeenCalledTimes(2);

		setVisibility("hidden");
		window.dispatchEvent(new Event("online"));
		expect(wsCtorSpy).toHaveBeenCalledTimes(2);
	});

	it("coalesces duplicate lifecycle recovery signals", () => {
		setVisibility("visible");
		openSocket(sockets[0]);
		setVisibility("hidden");
		setVisibility("visible");

		window.dispatchEvent(new Event("online"));
		dispatchPageShow(true);
		window.dispatchEvent(new Event("focus"));

		expect(wsCtorSpy).toHaveBeenCalledTimes(2);
	});

	it("coalesces resume signals after the hidden socket already closed", () => {
		setVisibility("visible");
		openSocket(sockets[0]);
		setVisibility("hidden");
		failSocket(sockets[0]);

		setVisibility("visible");
		const resumedSocket = sockets[1];
		openSocket(resumedSocket);
		window.dispatchEvent(new Event("online"));
		dispatchPageShow(true);

		expect(wsCtorSpy).toHaveBeenCalledTimes(2);
		expect(resumedSocket.close).not.toHaveBeenCalled();
		expect(wsStore.getSnapshot().wsStatus).toBe("connected");
	});

	it("ordinary pageshow and focus ensure without replacing an active socket", () => {
		setVisibility("visible");
		const socket = sockets[0];
		openSocket(socket);

		dispatchPageShow(false);
		window.dispatchEvent(new Event("focus"));

		expect(socket.close).not.toHaveBeenCalled();
		expect(wsCtorSpy).toHaveBeenCalledOnce();
	});

	it("ordinary pageshow recovers when the visible event was missed", () => {
		setVisibility("visible");
		const socket = sockets[0];
		setVisibility("hidden");
		Object.defineProperty(document, "visibilityState", {
			value: "visible",
			writable: true,
			configurable: true,
		});

		dispatchPageShow(false);
		expect(socket.close).toHaveBeenCalledOnce();
		expect(wsCtorSpy).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(3_000);

		expect(wsStore.getSnapshot().wsStatus).toBe("disconnected");
	});

	it("focus consumes a missed foreground recovery after the page was hidden", () => {
		setVisibility("visible");
		const socket = sockets[0];
		openSocket(socket);
		setVisibility("hidden");
		Object.defineProperty(document, "visibilityState", {
			value: "visible",
			writable: true,
			configurable: true,
		});

		window.dispatchEvent(new Event("focus"));

		expect(socket.close).toHaveBeenCalledOnce();
		expect(wsCtorSpy).toHaveBeenCalledTimes(2);
	});

	it("persisted pageshow replaces a socket restored from BFCache", () => {
		setVisibility("visible");
		const socket = sockets[0];
		openSocket(socket);
		vi.advanceTimersByTime(251);

		dispatchPageShow(true);

		expect(socket.close).toHaveBeenCalledOnce();
		expect(wsCtorSpy).toHaveBeenCalledTimes(2);
	});

	it("focus bypasses pending backoff while disconnected", () => {
		setVisibility("visible");
		failSocket(sockets[0]);

		window.dispatchEvent(new Event("focus"));

		expect(wsCtorSpy).toHaveBeenCalledTimes(2);
		openSocket(sockets[1]);
		vi.advanceTimersByTime(30_000);
		expect(wsCtorSpy).toHaveBeenCalledTimes(2);
	});

	it("test reset clears the deadline and invalidates captured callbacks", () => {
		setVisibility("visible");
		const socket = sockets[0];
		const staleOpen = socket.onopen;
		const staleClose = socket.onclose;

		wsStore.__resetForTesting();
		staleOpen?.();
		staleClose?.();
		vi.advanceTimersByTime(60_000);

		expect(wsStore.getSnapshot()).toEqual(wsStore.INITIAL_SNAPSHOT);
		expect(wsCtorSpy).toHaveBeenCalledOnce();
	});
});
