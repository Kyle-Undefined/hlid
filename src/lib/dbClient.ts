import { getConfig } from "#/lib/serverFns/config";
import { safeRequestPath } from "./httpDiagnostics";

let _base: string | null = null;
const SOFT_FAILURE_DEDUP_MS = 30_000;
const INTERNAL_API_READ_TIMEOUT_MS = 5_000;
const REQUEST_ID_HEADER = "x-hlid-request-id";
const softFailureTimes = new Map<string, number>();

function requestId(): string {
	return crypto.randomUUID();
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function reportSoftFailure(
	path: string,
	reason: string,
	elapsedMs: number,
	requestId: string,
): void {
	const route = safeRequestPath(path);
	const key = `${route}:${reason}`;
	const now = Date.now();
	const last = softFailureTimes.get(key) ?? 0;
	if (now - last < SOFT_FAILURE_DEDUP_MS) return;
	if (softFailureTimes.size >= 200) softFailureTimes.clear();
	softFailureTimes.set(key, now);
	console.warn(
		`[internal-api] ${route} unavailable after ${Math.max(0, Math.round(elapsedMs))}ms (request ${requestId.slice(0, 12)}): ${reason}`,
	);
}

async function getBase(): Promise<string> {
	if (!_base) {
		const { server } = await getConfig();
		_base = `http://127.0.0.1:${server.port + 1}`;
	}
	return _base;
}

/**
 * Fetch from the internal data API (Bun server on port+1).
 * Centralizes host/port resolution and standardizes to 127.0.0.1.
 */
export async function dbFetch(
	path: string,
	init?: RequestInit,
): Promise<Response> {
	const base = await getBase();
	const { loadToken } = await import("./token");
	const headers = new Headers(init?.headers);
	headers.set("x-hlid-internal", loadToken());
	if (!headers.has(REQUEST_ID_HEADER)) {
		headers.set(REQUEST_ID_HEADER, requestId());
	}
	return fetch(`${base}${path}`, { ...init, headers });
}

export class InternalApiError extends Error {
	readonly status: number;

	constructor(operation: string, status: number, detail?: string) {
		super(
			`${operation} failed (${status})${detail ? `: ${detail.slice(0, 500)}` : ""}`,
		);
		this.name = "InternalApiError";
		this.status = status;
	}
}

/** Require a successful internal API response for a mutation. */
export async function requireDbOk(
	response: Response,
	operation: string,
): Promise<Response> {
	if (response.ok) return response;
	let detail = "";
	try {
		detail = (await response.text()).trim();
	} catch {
		// The status and operation still provide a useful failure.
	}
	throw new InternalApiError(operation, response.status, detail);
}

/**
 * GET JSON from the data API. Returns `fallback` on any failure
 * (network error, non-OK response, malformed JSON). Used by the
 * read-only server fns where a soft failure is preferable to a
 * loader crash.
 */
export async function dbJson<T>(path: string, fallback: T): Promise<T> {
	const startedAt = performance.now();
	const currentRequestId = requestId();
	const abort = new AbortController();
	const timeout = setTimeout(
		() =>
			abort.abort(
				new Error(
					`internal API read timed out after ${INTERNAL_API_READ_TIMEOUT_MS}ms`,
				),
			),
		INTERNAL_API_READ_TIMEOUT_MS,
	);
	try {
		const res = await dbFetch(path, {
			headers: { [REQUEST_ID_HEADER]: currentRequestId },
			signal: abort.signal,
		});
		if (!res.ok) {
			reportSoftFailure(
				path,
				`HTTP ${res.status}`,
				performance.now() - startedAt,
				currentRequestId,
			);
			return fallback;
		}
		try {
			return (await res.json()) as T;
		} catch {
			reportSoftFailure(
				path,
				"invalid JSON response",
				performance.now() - startedAt,
				currentRequestId,
			);
			return fallback;
		}
	} catch (error) {
		reportSoftFailure(
			path,
			describeError(error),
			performance.now() - startedAt,
			currentRequestId,
		);
		return fallback;
	} finally {
		clearTimeout(timeout);
	}
}

/** @internal */
export function resetDbClientForTesting(): void {
	_base = null;
	softFailureTimes.clear();
}
