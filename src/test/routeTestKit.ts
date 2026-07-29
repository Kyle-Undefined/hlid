/**
 * Shared helpers for route handler tests (src/routes/api).
 *
 * Mocking pattern: the common route dependencies have `__mocks__` modules, so
 * test files only need bare, hoist-safe one-liners:
 *
 *   vi.mock("#/lib/originGate");        // forbiddenResponse: vi.fn(() => null)
 *   vi.mock("#/lib/dbClient");          // dbFetch: vi.fn()
 *   vi.mock("#/server/config");         // loadConfig: vi.fn()
 *   vi.mock("#/lib/serverFns/config");  // getConfig: vi.fn()
 *
 * Note: `vi.resetAllMocks()` wipes the default `forbiddenResponse` null
 * implementation — re-prime it in beforeEach (or use `vi.clearAllMocks()`).
 */

export interface MakeRequestOptions {
	method?: string;
	/**
	 * JSON body shortcut: sets `content-type: application/json` and
	 * stringifies the value. A string is sent RAW (not re-stringified) so
	 * tests can send intentionally invalid JSON payloads.
	 */
	json?: unknown;
	/** Raw body passthrough (multipart, binary, etc.). Wins over `json`. */
	body?: BodyInit;
	headers?: HeadersInit;
	/** Query params appended to the URL. */
	params?: Record<string, string>;
}

export function makeRequest(
	url: string,
	options: MakeRequestOptions = {},
): Request {
	const { method = "GET", json, body, headers, params } = options;
	const target = new URL(url, "http://localhost");
	for (const [key, value] of Object.entries(params ?? {})) {
		target.searchParams.set(key, value);
	}

	const finalHeaders = new Headers(headers);
	let finalBody = body;
	if (finalBody === undefined && json !== undefined) {
		if (!finalHeaders.has("content-type")) {
			finalHeaders.set("content-type", "application/json");
		}
		finalBody = typeof json === "string" ? json : JSON.stringify(json);
	}

	return new Request(target, {
		method,
		headers: finalHeaders,
		body: finalBody,
	});
}
