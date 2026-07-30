import { vi } from "vitest";

export interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
}

/** Promise with externally accessible resolve/reject. */
export function deferred<T>(): Deferred<T> {
	return Promise.withResolvers<T>();
}

/** Minimal fetch-style Response stub resolving json() to `data`. */
export function jsonResponse(data: unknown, ok = true, status = 200): Response {
	return {
		ok,
		status,
		json: vi.fn().mockResolvedValue(data),
	} as unknown as Response;
}
