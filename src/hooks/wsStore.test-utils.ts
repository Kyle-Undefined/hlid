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
