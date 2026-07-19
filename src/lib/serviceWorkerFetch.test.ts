import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type FetchEvent = {
	request: Request;
	respondWith(response: Promise<Response>): void;
};

function loadFetchHandler(fetchImpl: typeof fetch) {
	let handler: ((event: FetchEvent) => void) | undefined;
	const source = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");
	runInNewContext(source, {
		URL,
		Response,
		Promise,
		fetch: fetchImpl,
		setTimeout: (callback: () => void) => {
			callback();
			return 0;
		},
		clearTimeout,
		caches: {
			match: vi.fn().mockResolvedValue(undefined),
			open: vi.fn().mockResolvedValue({
				add: vi.fn(),
				put: vi.fn(),
			}),
			keys: vi.fn().mockResolvedValue([]),
			delete: vi.fn(),
		},
		self: {
			addEventListener(type: string, callback: unknown) {
				if (type === "fetch") handler = callback as typeof handler;
			},
			skipWaiting: vi.fn(),
			clients: { claim: vi.fn() },
		},
	});
	if (!handler)
		throw new Error("service worker fetch handler was not registered");
	return handler;
}

async function dispatchFetch(
	handler: (event: FetchEvent) => void,
	request: Request,
): Promise<Response> {
	let response: Promise<Response> | undefined;
	handler({
		request,
		respondWith(value) {
			response = value;
		},
	});
	if (!response) throw new Error("service worker did not handle request");
	return response;
}

describe("service worker dynamic request recovery", () => {
	it("retries a transient server-function network failure", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockRejectedValueOnce(new TypeError("network reset"))
			.mockResolvedValueOnce(new Response("ok", { status: 200 }));
		const handler = loadFetchHandler(fetchImpl);

		const response = await dispatchFetch(
			handler,
			new Request("https://hlid.test/_serverFn/loader"),
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("uses the unavailable response only after retries are exhausted", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockRejectedValue(new TypeError("offline"));
		const handler = loadFetchHandler(fetchImpl);

		const response = await dispatchFetch(
			handler,
			new Request("https://hlid.test/_serverFn/loader"),
		);

		expect(response.status).toBe(503);
		expect(await response.text()).toBe("Hlið is temporarily unavailable.");
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});
});
