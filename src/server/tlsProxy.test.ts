import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

vi.mock("./embedded-server-fn-names", () => ({
	SERVER_FN_NAMES: {
		aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:
			"getLedgerAnalyticsFn",
	},
}));

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
	it("redirects an unauthenticated document request to login", async () => {
		const forward = vi.fn(async () => new Response("unexpected"));
		const handle = forwarder({
			authenticate: async () => false,
			forward,
		});
		const response = await handle(
			new Request("https://hlid.test/", {
				headers: { accept: "text/html,application/xhtml+xml" },
			}),
		);

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("/login");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(forward).not.toHaveBeenCalled();
	});

	it("keeps unauthenticated server-function requests as JSON 401 responses", async () => {
		const response = await forwarder({ authenticate: async () => false })(
			new Request("https://hlid.test/", {
				headers: {
					accept: "text/html",
					"x-tsr-serverfn": "true",
				},
			}),
		);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Unauthorized" });
	});

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

	it("forwards safe headers and adds authenticated proxy metadata", async () => {
		const forward = vi.fn(
			async (_input: string, _init: RequestInit) =>
				new Response("ok", {
					status: 201,
					headers: { "x-upstream": "yes", connection: "close" },
				}),
		);
		const response = await forwarder({ forward })(
			new Request("https://hlid.test/api/private?q=1", {
				headers: {
					"x-custom": "kept",
					"x-hlid-proxy-token": "attacker",
				},
			}),
			"192.0.2.5",
		);
		const [target, init] = forward.mock.calls[0];
		const headers = new Headers(init.headers);
		expect(target).toBe("http://127.0.0.1:3000/api/private?q=1");
		expect(headers.get("x-custom")).toBe("kept");
		expect(headers.get("x-hlid-proxy-token")).toBe("internal-secret");
		expect(headers.get("x-hlid-forwarded-proto")).toBe("https");
		expect(headers.get("x-hlid-forwarded-client-ip")).toBe("192.0.2.5");
		expect(headers.get("accept-encoding")).toBe("identity");
		expect(response.status).toBe(201);
		expect(response.headers.get("x-upstream")).toBe("yes");
		expect(response.headers.has("connection")).toBe(false);
	});

	it("requests identity upstream and compresses once for the public client", async () => {
		const html = `<!DOCTYPE html>${"login".repeat(500)}`;
		const forward = vi.fn(
			async (_input: string, _init: RequestInit) =>
				new Response(html, {
					headers: { "content-type": "text/html; charset=utf-8" },
				}),
		);
		const response = await forwarder({ forward })(
			new Request("https://hlid.test/login", {
				headers: { "accept-encoding": "gzip" },
			}),
		);
		const forwardedHeaders = new Headers(forward.mock.calls[0][1].headers);

		expect(forwardedHeaders.get("accept-encoding")).toBe("identity");
		expect(response.headers.get("content-encoding")).toBe("gzip");
		expect(
			gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8"),
		).toBe(html);
	});

	it("retries a stalled safe request within the existing timeout budget", async () => {
		vi.useFakeTimers();
		try {
			let firstSignal: AbortSignal | undefined;
			const log = vi.spyOn(console, "error").mockImplementation(() => {});
			const forward = vi
				.fn()
				.mockImplementationOnce((_input: string, init: RequestInit) => {
					firstSignal = init.signal ?? undefined;
					return new Promise<Response>((_resolve, reject) => {
						firstSignal?.addEventListener("abort", () =>
							reject(firstSignal?.reason),
						);
					});
				})
				.mockResolvedValueOnce(new Response("recovered"));
			const pending = forwarder({ forward })(
				new Request("https://hlid.test/api/private"),
			);
			await vi.waitFor(() => expect(forward).toHaveBeenCalledOnce());

			await vi.advanceTimersByTimeAsync(5_000);
			const response = await pending;

			expect(firstSignal?.aborted).toBe(true);
			expect(forward).toHaveBeenCalledTimes(2);
			expect(response.status).toBe(200);
			expect(await response.text()).toBe("recovered");
			expect(log).not.toHaveBeenCalled();
			log.mockRestore();
		} finally {
			vi.useRealTimers();
		}
	});

	it("bounds both safe attempts to the original total timeout", async () => {
		vi.useFakeTimers();
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const forward = vi.fn((_input: string, init: RequestInit) => {
				const signal = init.signal;
				return new Promise<Response>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason));
				});
			});
			const pending = forwarder({ forward })(
				new Request("https://hlid.test/api/private"),
			);
			await vi.waitFor(() => expect(forward).toHaveBeenCalledOnce());

			await vi.advanceTimersByTimeAsync(5_000);
			expect(forward).toHaveBeenCalledTimes(2);
			await vi.advanceTimersByTimeAsync(25_000);
			const response = await pending;

			expect(response.status).toBe(503);
			expect(forward).toHaveBeenCalledTimes(2);
			expect(log).toHaveBeenCalledOnce();
		} finally {
			log.mockRestore();
			vi.useRealTimers();
		}
	});

	it("does not retry failed mutation requests", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const forward = vi.fn(async () => {
			throw new Error("mutation failed");
		});
		const response = await forwarder({ forward })(
			request("/api/private", "body"),
		);

		expect(response.status).toBe(503);
		expect(forward).toHaveBeenCalledOnce();
		log.mockRestore();
	});

	it("maps upstream connection failures to service unavailable", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const response = await forwarder({
			forward: async () => {
				const error = new Error("connect failed") as NodeJS.ErrnoException;
				error.code = "ConnectionRefused";
				throw error;
			},
		})(new Request("https://hlid.test/api/private"));
		expect(response.status).toBe(503);
		expect(await response.text()).toBe("Service Unavailable");
		expect(log).toHaveBeenCalledWith(
			"[tls-proxy] GET /api/private failed after 0ms: Error: connect failed",
		);
		log.mockRestore();
	});

	it("identifies generated server functions in forwarding failures", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const response = await forwarder({
			forward: async () => {
				throw new Error("connect failed");
			},
		})(
			new Request(
				"https://hlid.test/_serverFn/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				{ method: "POST", body: "body" },
			),
		);

		expect(response.status).toBe(503);
		expect(log).toHaveBeenCalledWith(
			"[tls-proxy] POST /_serverFn/:id server-fn=getLedgerAnalyticsFn failed after 0ms: Error: connect failed",
		);
		log.mockRestore();
	});

	it("keeps the Tailscale voice forward alive beyond the default timeout", async () => {
		vi.useFakeTimers();
		try {
			let resolveForward: ((response: Response) => void) | undefined;
			let forwardedSignal: AbortSignal | undefined;
			const forward = vi.fn(
				(_input: string, init: RequestInit) =>
					new Promise<Response>((resolve, reject) => {
						resolveForward = resolve;
						forwardedSignal = init.signal ?? undefined;
						forwardedSignal?.addEventListener("abort", () =>
							reject(forwardedSignal?.reason),
						);
					}),
			);
			const pending = forwarder({ forward })(
				request("/api/voice/transcribe", "audio"),
			);
			await vi.waitFor(() => expect(forward).toHaveBeenCalledOnce());

			await vi.advanceTimersByTimeAsync(60_000);
			expect(forwardedSignal?.aborted).toBe(false);
			resolveForward?.(Response.json({ text: "done" }));

			const response = await pending;
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ text: "done" });
		} finally {
			vi.useRealTimers();
		}
	});
});
