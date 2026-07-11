import { describe, expect, it, vi } from "vitest";
import { createTlsHttpForwarder, MAX_TLS_PUBLIC_BODY_BYTES } from "./tlsProxy";

function request(
	path: string,
	body: BodyInit | ReadableStream<Uint8Array>,
	headers?: HeadersInit,
): Request {
	return new Request(`https://hlid.test${path}`, {
		method: "POST",
		body,
		headers,
		duplex: "half",
	} as RequestInit);
}

function forwarder(
	overrides: {
		maxBodyBytes?: number;
		maxConcurrent?: number;
		authenticate?: (request: Request) => Promise<boolean>;
		forward?: (input: string, init: RequestInit) => Promise<Response>;
	} = {},
) {
	return createTlsHttpForwarder({
		uiPort: 3000,
		internalToken: "internal-secret",
		maxBodyBytes: overrides.maxBodyBytes ?? 10,
		maxConcurrent: overrides.maxConcurrent,
		authenticate: overrides.authenticate ?? (async () => true),
		forward: overrides.forward ?? (async () => new Response("ok")),
	});
}

describe("TLS HTTP proxy limits", () => {
	it("authenticates private paths before reading or forwarding their bodies", async () => {
		const forward = vi.fn(async () => new Response("unexpected"));
		const handle = forwarder({
			authenticate: async () => false,
			forward,
		});
		const privateRequest = request(
			"/api/private",
			new ReadableStream({
				pull(controller) {
					controller.enqueue(new Uint8Array([1]));
				},
			}),
		);
		if (!privateRequest.body) throw new Error("expected request body");
		const getReader = vi.spyOn(privateRequest.body, "getReader");
		const response = await handle(privateRequest);

		expect(response.status).toBe(401);
		expect(getReader).not.toHaveBeenCalled();
		expect(forward).not.toHaveBeenCalled();
	});

	it("forwards an authenticated fixed-length body at the proxy cap", async () => {
		const forward = vi.fn(async (_input: string, init: RequestInit) => {
			expect(new Uint8Array(init.body as ArrayBuffer)).toHaveLength(10);
			return new Response("ok");
		});
		const response = await forwarder({ forward })(
			request("/api/private", new Uint8Array(10), {
				"content-length": "10",
			}),
		);

		expect(response.status).toBe(200);
		expect(forward).toHaveBeenCalledOnce();
	});

	it("rejects oversized fixed-length bodies before reading or forwarding", async () => {
		const forward = vi.fn(async () => new Response("unexpected"));
		const response = await forwarder({ forward })(
			request("/api/private", "small", { "content-length": "11" }),
		);

		expect(response.status).toBe(413);
		expect(forward).not.toHaveBeenCalled();
	});

	it("rejects oversized chunked bodies and cancels their stream", async () => {
		let cancelled = false;
		const forward = vi.fn(async () => new Response("unexpected"));
		const response = await forwarder({ forward })(
			request(
				"/api/private",
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(6));
						controller.enqueue(new Uint8Array(5));
					},
					cancel() {
						cancelled = true;
					},
				}),
			),
		);

		expect(response.status).toBe(413);
		expect(cancelled).toBe(true);
		expect(forward).not.toHaveBeenCalled();
	});

	it("keeps public authentication bodies usable but capped at 2 KiB", async () => {
		const forward = vi.fn(async () => new Response("ok"));
		const handle = forwarder({ maxBodyBytes: 100_000, forward });

		expect(
			(await handle(request("/api/auth/login", new Uint8Array(2048)))).status,
		).toBe(200);
		expect(
			(
				await handle(
					request("/api/auth/setup", "x", {
						"content-length": String(MAX_TLS_PUBLIC_BODY_BYTES + 1),
					}),
				)
			).status,
		).toBe(413);
		expect(forward).toHaveBeenCalledOnce();
	});

	it("bounds buffered forwards and releases capacity after a client abort", async () => {
		let failBody: ((error: Error) => void) | undefined;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				failBody = (error) => controller.error(error);
			},
		});
		const forward = vi.fn(async () => new Response("ok"));
		const handle = forwarder({ maxConcurrent: 1, forward });
		const aborted = handle(request("/api/private", body));
		await Promise.resolve();

		expect((await handle(request("/api/private", "busy"))).status).toBe(429);
		failBody?.(new Error("client aborted"));
		expect((await aborted).status).toBe(499);
		expect((await handle(request("/api/private", "released"))).status).toBe(
			200,
		);
		expect(forward).toHaveBeenCalledOnce();
	});

	it("releases capacity after an upstream forward completes", async () => {
		let finish: (() => void) | undefined;
		const forward = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					finish = () => resolve(new Response("ok"));
				}),
		);
		const handle = forwarder({ maxConcurrent: 1, forward });
		const first = handle(request("/api/private", "first"));
		while (forward.mock.calls.length < 1) await Promise.resolve();

		expect((await handle(request("/api/private", "busy"))).status).toBe(429);
		finish?.();
		expect((await first).status).toBe(200);
		const next = handle(request("/api/private", "next"));
		while (forward.mock.calls.length < 2) await Promise.resolve();
		finish?.();
		expect((await next).status).toBe(200);
	});
});
