import { vi } from "vitest";

export interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
}

/** Promise with externally accessible resolve/reject. */
export function deferred<T>(): Deferred<T> {
	let resolve!: Deferred<T>["resolve"];
	let reject!: Deferred<T>["reject"];
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Minimal fetch-style Response stub resolving json() to `data`. */
export function jsonResponse(data: unknown, ok = true, status = 200): Response {
	return {
		ok,
		status,
		json: vi.fn().mockResolvedValue(data),
	} as unknown as Response;
}
