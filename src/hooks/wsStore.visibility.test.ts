/**
 * wsStore — mobile/PWA lifecycle reconnect tests.
 *
 * Suspended browsers can retain an OPEN or CONNECTING readyState without ever
 * delivering close. Explicit foreground/network recovery must retire that
 * attempt, while ordinary focus events coalesce around a liveness check.
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

function sentMessages(socket: MockWs): Array<Record<string, unknown>> {
	return socket.send.mock.calls.map(([raw]) =>
		JSON.parse(raw as string),
	) as Array<Record<string, unknown>>;
}

function latestProbeId(socket: MockWs): string {
	const probe = [...sentMessages(socket)]
		.reverse()
		.find((message) => message.type === "connection_probe");
	if (typeof probe?.request_id !== "string") {
		throw new Error("Expected the socket to send a connection_probe");
	}
	return probe.request_id;
}

function receiveConnectionAck(socket: MockWs, requestId: string): void {
	socket.onmessage?.({
		data: JSON.stringify({ type: "connection_ack", request_id: requestId }),
	});
}

function acknowledgeLatestProbe(socket: MockWs): void {
	receiveConnectionAck(socket, latestProbeId(socket));
}

function openTransport(socket: MockWs): void {
	socket.readyState = WS_STATES.OPEN;
	socket.onopen?.();
}

function openSocket(socket: MockWs): void {
	openTransport(socket);
	acknowledgeLatestProbe(socket);
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

function dispatchFreeze(): void {
	document.dispatchEvent(new Event("freeze"));
}

function dispatchResume(): void {
	document.dispatchEvent(new Event("resume"));
}

describe("wsStore — lifecycle reconnect", () => {
	it("creates a replay-capable WebSocket when the page becomes visible", () => {
		setVisibility("visible");

		expect(wsCtorSpy).toHaveBeenCalledOnce();
		expect(wsCtorSpy.mock.calls[0]?.[0]).toContain("/ws?replay_batch=1");
		expect(wsStore.getSnapshot().wsStatus).toBe("connecting");
	});

	it("waits for a matching readiness acknowledgement before connecting", () => {
		setVisibility("visible");
		const socket = sockets[0];
		const received = vi.fn();
		const unsubscribe = wsStore.subscribeMessage(received);

		openTransport(socket);
		const probeId = latestProbeId(socket);
		expect(sentMessages(socket)).toEqual([
			{ type: "connection_probe", request_id: probeId },
		]);
		expect(wsStore.getSnapshot().wsStatus).toBe("connecting");

		receiveConnectionAck(socket, "wrong-request-id");
		expect(wsStore.getSnapshot().wsStatus).toBe("connecting");

		receiveConnectionAck(socket, probeId);
		expect(wsStore.getSnapshot().wsStatus).toBe("connected");
		expect(received).not.toHaveBeenCalled();
		vi.advanceTimersByTime(60_000);
		expect(socket.close).not.toHaveBeenCalled();
		unsubscribe();
	});

	it("ignores a stale acknowledgement from a retired socket generation", () => {
		setVisibility("visible");
		const firstSocket = sockets[0];
		openTransport(firstSocket);
		const staleProbeId = latestProbeId(firstSocket);
		const staleMessage = firstSocket.onmessage;

		setVisibility("hidden");
		setVisibility("visible");
		const replacement = sockets[1];
		staleMessage?.({
			data: JSON.stringify({
				type: "connection_ack",
				request_id: staleProbeId,
			}),
		});

		expect(firstSocket.close).toHaveBeenCalledOnce();
		expect(replacement.send).not.toHaveBeenCalled();
		expect(wsStore.getSnapshot().wsStatus).toBe("connecting");
		expect(wsCtorSpy).toHaveBeenCalledTimes(2);
	});

	it("allows a slow transport past three seconds and starts a fresh handshake deadline", () => {
		setVisibility("visible");
		const socket = sockets[0];

		vi.advanceTimersByTime(3_001);
		expect(socket.close).not.toHaveBeenCalled();
		vi.advanceTimersByTime(8_998);
		expect(socket.close).not.toHaveBeenCalled();

		openTransport(socket);
		vi.advanceTimersByTime(11_999);
		expect(socket.close).not.toHaveBeenCalled();
		expect(wsStore.getSnapshot().wsStatus).toBe("connecting");

		acknowledgeLatestProbe(socket);
		expect(wsStore.getSnapshot().wsStatus).toBe("connected");
		vi.advanceTimersByTime(1);
		expect(socket.close).not.toHaveBeenCalled();
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

	it("retires a frozen socket and reconnects once the visible page resumes", () => {
		setVisibility("visible");
		const firstSocket = sockets[0];
		openSocket(firstSocket);

		dispatchFreeze();
		expect(firstSocket.close).toHaveBeenCalledOnce();
		expect(wsStore.getSnapshot().wsStatus).toBe("disconnected");
		vi.advanceTimersByTime(60_000);
		expect(wsCtorSpy).toHaveBeenCalledOnce();

		dispatchResume();
		expect(wsCtorSpy).toHaveBeenCalledTimes(2);
		expect(wsStore.getSnapshot().wsStatus).toBe("connecting");
	});

	it("defers a frozen page resume until the document is visible", () => {
		setVisibility("visible");
		const firstSocket = sockets[0];
		openSocket(firstSocket);
		setVisibility("hidden");
		dispatchFreeze();

		dispatchResume();
		vi.advanceTimersByTime(60_000);
		expect(firstSocket.close).toHaveBeenCalledOnce();
		expect(wsCtorSpy).toHaveBeenCalledOnce();

		Object.defineProperty(document, "visibilityState", {
			value: "visible",
			writable: true,
			configurable: true,
		});
		dispatchResume();
		expect(wsCtorSpy).toHaveBeenCalledTimes(2);
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

	it("retires a silent CONNECTING attempt at the twelve-second deadline", () => {
		setVisibility("visible");
		const socket = sockets[0];
		const staleClose = socket.onclose;

		vi.advanceTimersByTime(11_999);
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

	it("retires an open transport that never acknowledges its handshake", () => {
		setVisibility("visible");
		const socket = sockets[0];
		openTransport(socket);

		vi.advanceTimersByTime(11_999);
		expect(socket.close).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);

		expect(socket.close).toHaveBeenCalledOnce();
		expect(wsStore.getSnapshot().wsStatus).toBe("disconnected");
		vi.advanceTimersByTime(1_000);
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

	it("coalesces duplicate foreground signals after freeze and resume", () => {
		setVisibility("visible");
		const firstSocket = sockets[0];
		openSocket(firstSocket);

		dispatchFreeze();
		dispatchResume();
		const resumedSocket = sockets[1];

		dispatchResume();
		window.dispatchEvent(new Event("online"));
		dispatchPageShow(true);
		window.dispatchEvent(new Event("focus"));

		expect(firstSocket.close).toHaveBeenCalledOnce();
		expect(wsCtorSpy).toHaveBeenCalledTimes(2);
		expect(resumedSocket.close).not.toHaveBeenCalled();
		openSocket(resumedSocket);
		expect(wsStore.getSnapshot().wsStatus).toBe("connected");
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

	it("validates a stale-looking OPEN socket when background events were missed", () => {
		setVisibility("visible");
		const socket = sockets[0];
		openSocket(socket);
		socket.send.mockClear();

		// The document stayed visible throughout: no hidden, pagehide, or freeze
		// event tells the store that this apparently OPEN socket may be stale.
		dispatchPageShow(false);
		window.dispatchEvent(new Event("focus"));
		const probeId = latestProbeId(socket);

		expect(sentMessages(socket)).toEqual([
			{ type: "connection_probe", request_id: probeId },
		]);
		expect(socket.close).not.toHaveBeenCalled();
		expect(wsCtorSpy).toHaveBeenCalledOnce();
		expect(wsStore.send({ type: "abort" })).toBe(false);
		expect(
			wsStore.send({
				type: "chat",
				text: "send after resume",
				session_id: "session-a",
			}),
		).toBe(true);
		expect(wsStore.send({ type: "sync" })).toBe(true);
		expect(sentMessages(socket)).toEqual([
			{ type: "connection_probe", request_id: probeId },
		]);

		vi.advanceTimersByTime(2_999);
		receiveConnectionAck(socket, probeId);
		vi.advanceTimersByTime(1);
		expect(socket.close).not.toHaveBeenCalled();
		expect(wsStore.getSnapshot().wsStatus).toBe("connected");
		expect(sentMessages(socket)).toEqual([
			{ type: "connection_probe", request_id: probeId },
			{
				type: "chat",
				text: "send after resume",
				session_id: "session-a",
			},
			{ type: "sync" },
		]);
		expect(wsCtorSpy).toHaveBeenCalledOnce();
	});

	it("replaces a stale OPEN socket when an ordinary focus probe times out", () => {
		setVisibility("visible");
		const staleSocket = sockets[0];
		openSocket(staleSocket);
		staleSocket.send.mockClear();

		// As above, deliberately omit every background event.
		window.dispatchEvent(new Event("focus"));
		expect(sentMessages(staleSocket)).toEqual([
			{
				type: "connection_probe",
				request_id: latestProbeId(staleSocket),
			},
		]);

		vi.advanceTimersByTime(2_999);
		expect(staleSocket.close).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);

		expect(staleSocket.close).toHaveBeenCalledOnce();
		expect(wsCtorSpy).toHaveBeenCalledTimes(2);
		expect(wsStore.getSnapshot().wsStatus).toBe("connecting");
		openSocket(sockets[1]);
		vi.advanceTimersByTime(60_000);
		expect(wsCtorSpy).toHaveBeenCalledTimes(2);
	});

	it("carries an explicitly scoped chat through stale-socket replacement", () => {
		setVisibility("visible");
		const staleSocket = sockets[0];
		openSocket(staleSocket);
		staleSocket.send.mockClear();

		window.dispatchEvent(new Event("focus"));
		expect(
			wsStore.send({
				type: "chat",
				text: "survive reconnect",
				session_id: "session-a",
			}),
		).toBe(true);
		expect(wsStore.send({ type: "sync" })).toBe(true);
		expect(wsStore.send({ type: "abort" })).toBe(false);

		vi.advanceTimersByTime(3_000);
		const replacement = sockets[1];
		openSocket(replacement);

		expect(sentMessages(replacement)).toEqual([
			{
				type: "connection_probe",
				request_id: latestProbeId(replacement),
			},
			{
				type: "chat",
				text: "survive reconnect",
				session_id: "session-a",
			},
		]);
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
		vi.advanceTimersByTime(12_000);

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
