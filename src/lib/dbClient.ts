import { getConfig } from "#/config";

let _base: string | null = null;

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
	return fetch(`${base}${path}`, init);
}

/**
 * GET JSON from the data API. Returns `fallback` on any failure
 * (network error, non-OK response, malformed JSON). Used by the
 * read-only server fns where a soft failure is preferable to a
 * loader crash.
 */
export async function dbJson<T>(path: string, fallback: T): Promise<T> {
	try {
		const res = await dbFetch(path);
		if (!res.ok) return fallback;
		return (await res.json()) as T;
	} catch {
		return fallback;
	}
}
