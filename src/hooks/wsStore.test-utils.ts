/**
 * Shared test utilities for wsStore test files.
 * Import from here instead of duplicating WS_STATES / makeMockWs per file.
 */
import { vi } from "vitest";

export const WS_STATES = {
	CONNECTING: 0,
	OPEN: 1,
	CLOSING: 2,
	CLOSED: 3,
} as const;

export type MockWs = {
	readyState: number;
	onopen: null | (() => void);
	onerror: null | (() => void);
	onclose: null | (() => void);
	onmessage: null | ((e: { data: string }) => void);
	send: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
};

export function makeMockWs(readyState: number = WS_STATES.OPEN): MockWs {
	return {
		readyState,
		onopen: null,
		onerror: null,
		onclose: null,
		onmessage: null,
		send: vi.fn(),
		close: vi.fn(),
	};
}

export function receiveWsMessage(
	socket: MockWs,
	message: Record<string, unknown>,
): void {
	socket.onmessage?.({ data: JSON.stringify(message) });
}

export function sentWsMessages(socket: MockWs): Record<string, unknown>[] {
	return socket.send.mock.calls.map(([payload]) =>
		JSON.parse(payload as string),
	) as Record<string, unknown>[];
}

export function latestConnectionProbeId(socket: MockWs): string {
	const probe = sentWsMessages(socket)
		.toReversed()
		.find((message) => message.type === "connection_probe");
	if (typeof probe?.request_id !== "string") {
		throw new Error("Expected a connection_probe message");
	}
	return probe.request_id;
}

export function acknowledgeLatestConnectionProbe(socket: MockWs): void {
	receiveWsMessage(socket, {
		type: "connection_ack",
		request_id: latestConnectionProbeId(socket),
	});
}

export function openReadySocket(socket: MockWs): void {
	socket.readyState = WS_STATES.OPEN;
	socket.onopen?.();
	acknowledgeLatestConnectionProbe(socket);
}
