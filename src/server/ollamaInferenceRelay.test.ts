import { describe, expect, it, vi } from "vitest";
import {
	createOllamaInferenceRelay,
	type IssuedOllamaInferenceLease,
	OLLAMA_INFERENCE_CHAT_PATH,
	OLLAMA_INFERENCE_MODELS_PATH,
	OLLAMA_INFERENCE_UPSTREAM_ORIGIN,
	OllamaInferenceLeaseRegistry,
} from "./ollamaInferenceRelay";

const START_TIME = 1_700_000_000_000;
const FIRST_TOKEN = "a".repeat(43);

function registry(
	options: {
		now?: () => number;
		tokens?: string[];
		ids?: string[];
		maxActiveLeases?: number;
	} = {},
): OllamaInferenceLeaseRegistry {
	const tokens = [...(options.tokens ?? [FIRST_TOKEN])];
	const ids = [...(options.ids ?? ["lease-1"])];
	return new OllamaInferenceLeaseRegistry({
		now: options.now ?? (() => START_TIME),
		tokenFactory: () => tokens.shift() ?? "z".repeat(43),
		idFactory: () => ids.shift() ?? `lease-${ids.length + 2}`,
		maxActiveLeases: options.maxActiveLeases,
	});
}

function issue(
	leases: OllamaInferenceLeaseRegistry,
	input: Partial<{
		profileId: string;
		targetId: string;
		processId: string;
		allowedModels: string[];
		expiresAt: number;
	}> = {},
): IssuedOllamaInferenceLease {
	return leases.issue({
		profileId: input.profileId ?? "ollama-default",
		targetId: input.targetId ?? "wsl:Ubuntu-24.04",
		processId: input.processId ?? "opencode-1234",
		allowedModels: input.allowedModels ?? ["qwen3-coder:30b"],
		expiresAt: input.expiresAt ?? START_TIME + 60_000,
	});
}

function relayRequest(
	path: string,
	lease: IssuedOllamaInferenceLease | undefined,
	init: RequestInit = {},
): Request {
	const headers = new Headers(init.headers);
	if (lease) headers.set("authorization", `Bearer ${lease.token}`);
	if (init.method === "POST" && !headers.has("content-type")) {
		headers.set("content-type", "application/json");
	}
	return new Request(`http://relay.test${path}`, { ...init, headers });
}

describe("OllamaInferenceLeaseRegistry", () => {
	it("binds an in-memory capability to its profile, target, process, models, and expiry", () => {
		const leases = registry();
		const lease = issue(leases, {
			allowedModels: ["qwen3-coder:30b", "qwen3-coder:30b", "gpt-oss:20b"],
		});

		expect(lease).toEqual({
			id: "lease-1",
			profileId: "ollama-default",
			targetId: "wsl:Ubuntu-24.04",
			processId: "opencode-1234",
			allowedModels: ["qwen3-coder:30b", "gpt-oss:20b"],
			issuedAt: START_TIME,
			expiresAt: START_TIME + 60_000,
			token: FIRST_TOKEN,
		});
		expect(leases.authorize(`Bearer ${FIRST_TOKEN}`)).toMatchObject({
			id: "lease-1",
			processId: "opencode-1234",
		});
		expect(leases.authorize(`bearer ${FIRST_TOKEN}`)?.id).toBe("lease-1");
		expect(leases.authorize(`Bearer ${"b".repeat(43)}`)).toBeNull();
		expect(leases.authorize(`Bearer  ${FIRST_TOKEN}`)).toBeNull();
	});

	it("expires and explicitly revokes capabilities", () => {
		let now = START_TIME;
		const leases = registry({ now: () => now });
		const lease = issue(leases, { expiresAt: START_TIME + 10 });

		now += 10;
		expect(leases.authorize(`Bearer ${lease.token}`)).toBeNull();
		expect(leases.revoke(lease.id)).toBe(false);
	});

	it("revokes only the exact capability id", () => {
		const leases = registry({
			tokens: ["a".repeat(43), "b".repeat(43)],
			ids: ["lease-1", "lease-2"],
		});
		const first = issue(leases);
		const second = issue(leases, { processId: "opencode-5678" });

		expect(leases.revoke(first.id)).toBe(true);
		expect(leases.authorize(`Bearer ${first.token}`)).toBeNull();
		expect(leases.authorize(`Bearer ${second.token}`)?.id).toBe(second.id);
	});

	it("renews only an active lease and aborts its lifecycle signal on revocation", () => {
		let now = START_TIME;
		const leases = registry({ now: () => now });
		const lease = issue(leases, { expiresAt: START_TIME + 10 });
		const signal = leases.lifecycleSignal(lease.id);

		expect(leases.renew(lease.id, START_TIME + 100)).toBe(true);
		now += 10;
		expect(leases.authorize(`Bearer ${lease.token}`)?.expiresAt).toBe(
			START_TIME + 100,
		);
		expect(signal?.aborted).toBe(false);
		expect(leases.revoke(lease.id)).toBe(true);
		expect(signal?.aborted).toBe(true);
		expect(leases.renew(lease.id, START_TIME + 200)).toBe(false);
	});

	it("rejects empty model sets, stale expiries, invalid tokens, and lease exhaustion", () => {
		expect(() => issue(registry(), { allowedModels: [] })).toThrow(
			"must allow at least one model",
		);
		expect(() => issue(registry(), { expiresAt: START_TIME })).toThrow(
			"future safe-integer",
		);
		expect(() =>
			issue(registry({ tokens: ["not-a-fixed-length-token"] })),
		).toThrow("invalid token");

		const leases = registry({
			tokens: ["a".repeat(43), "b".repeat(43)],
			ids: ["lease-1", "lease-2"],
			maxActiveLeases: 1,
		});
		issue(leases);
		expect(() => issue(leases, { processId: "another-process" })).toThrow(
			"lease limit",
		);
	});
});

describe("createOllamaInferenceRelay", () => {
	it("requires an exact bearer capability before touching Ollama", async () => {
		const leases = registry();
		issue(leases);
		const upstreamFetch = vi.fn(async () => Response.json({ data: [] }));
		const relay = createOllamaInferenceRelay({ leases, upstreamFetch });

		const missing = await relay(
			relayRequest(OLLAMA_INFERENCE_MODELS_PATH, undefined),
		);
		const wrong = await relay(
			relayRequest(OLLAMA_INFERENCE_MODELS_PATH, {
				...issue(registry()),
				token: "b".repeat(43),
			}),
		);

		expect(missing.status).toBe(401);
		expect(missing.headers.get("www-authenticate")).toBe("Bearer");
		expect(wrong.status).toBe(401);
		expect(upstreamFetch).not.toHaveBeenCalled();
	});

	it.each([
		["Origin", { origin: "http://attacker.test" }],
		["cookies", { cookie: "session=secret" }],
	])("rejects browser %s", async (_label, headers) => {
		const leases = registry();
		const lease = issue(leases);
		const upstreamFetch = vi.fn(async () => Response.json({ data: [] }));
		const relay = createOllamaInferenceRelay({ leases, upstreamFetch });

		const response = await relay(
			relayRequest(OLLAMA_INFERENCE_MODELS_PATH, lease, { headers }),
		);

		expect(response.status).toBe(403);
		expect(upstreamFetch).not.toHaveBeenCalled();
	});

	it("admits only the two exact method/path pairs and no query or traversal syntax", async () => {
		const leases = registry();
		const lease = issue(leases);
		const upstreamFetch = vi.fn(async () => Response.json({ data: [] }));
		const relay = createOllamaInferenceRelay({ leases, upstreamFetch });

		expect((await relay(relayRequest("/api/tags", lease))).status).toBe(404);
		expect(
			(
				await relay(
					relayRequest(`${OLLAMA_INFERENCE_MODELS_PATH}?all=1`, lease),
				)
			).status,
		).toBe(400);
		expect(
			(
				await relay(relayRequest(OLLAMA_INFERENCE_MODELS_PATH, lease), {
					rawTarget: "/v1/private/../models",
				})
			).status,
		).toBe(400);
		expect(
			(await relay(relayRequest("/v1/%2e%2e%2fmodels", lease))).status,
		).toBe(400);
		const wrongModelsMethod = await relay(
			relayRequest(OLLAMA_INFERENCE_MODELS_PATH, lease, {
				method: "POST",
				body: "{}",
			}),
		);
		expect(wrongModelsMethod.status).toBe(405);
		expect(wrongModelsMethod.headers.get("allow")).toBe("GET");
		const wrongChatMethod = await relay(
			relayRequest(OLLAMA_INFERENCE_CHAT_PATH, lease),
		);
		expect(wrongChatMethod.status).toBe(405);
		expect(wrongChatMethod.headers.get("allow")).toBe("POST");
		expect(upstreamFetch).not.toHaveBeenCalled();
	});

	it("rejects transfer chunking and encoded request bodies", async () => {
		const leases = registry();
		const lease = issue(leases);
		const upstreamFetch = vi.fn(async () => new Response("unused"));
		const relay = createOllamaInferenceRelay({ leases, upstreamFetch });

		const chunked = await relay(
			relayRequest(OLLAMA_INFERENCE_CHAT_PATH, lease, {
				method: "POST",
				headers: { "transfer-encoding": "chunked" },
				body: JSON.stringify({ model: "qwen3-coder:30b" }),
			}),
		);
		const encoded = await relay(
			relayRequest(OLLAMA_INFERENCE_CHAT_PATH, lease, {
				method: "POST",
				headers: { "content-encoding": "gzip" },
				body: JSON.stringify({ model: "qwen3-coder:30b" }),
			}),
		);

		expect(chunked.status).toBe(400);
		expect(encoded.status).toBe(400);
		expect(upstreamFetch).not.toHaveBeenCalled();
	});

	it("bounds a streamed JSON body before parsing or forwarding it", async () => {
		const leases = registry();
		const lease = issue(leases);
		const upstreamFetch = vi.fn(async () => new Response("unused"));
		const relay = createOllamaInferenceRelay({
			leases,
			upstreamFetch,
			maxRequestBytes: 32,
		});
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("{".repeat(20)));
				controller.enqueue(new TextEncoder().encode("}".repeat(20)));
				controller.close();
			},
		});
		const init = {
			method: "POST",
			headers: {
				authorization: `Bearer ${lease.token}`,
				"content-type": "application/json",
			},
			body: stream,
			duplex: "half",
		} as RequestInit & { duplex: "half" };

		const response = await relay(
			new Request(`http://relay.test${OLLAMA_INFERENCE_CHAT_PATH}`, init),
		);

		expect(response.status).toBe(413);
		expect(upstreamFetch).not.toHaveBeenCalled();
	});

	it("requires JSON with an exact allowlisted model", async () => {
		const leases = registry();
		const lease = issue(leases);
		const upstreamFetch = vi.fn(async () => new Response("unused"));
		const relay = createOllamaInferenceRelay({ leases, upstreamFetch });

		const badType = await relay(
			relayRequest(OLLAMA_INFERENCE_CHAT_PATH, lease, {
				method: "POST",
				headers: { "content-type": "text/plain" },
				body: "{}",
			}),
		);
		const badJson = await relay(
			relayRequest(OLLAMA_INFERENCE_CHAT_PATH, lease, {
				method: "POST",
				body: "not json",
			}),
		);
		const missingModel = await relay(
			relayRequest(OLLAMA_INFERENCE_CHAT_PATH, lease, {
				method: "POST",
				body: "{}",
			}),
		);
		const wrongModel = await relay(
			relayRequest(OLLAMA_INFERENCE_CHAT_PATH, lease, {
				method: "POST",
				body: JSON.stringify({ model: "qwen3-coder:30b-latest" }),
			}),
		);

		expect(badType.status).toBe(415);
		expect(badJson.status).toBe(400);
		expect(missingModel.status).toBe(400);
		expect(wrongModel.status).toBe(403);
		expect(upstreamFetch).not.toHaveBeenCalled();
	});

	it("fails closed when current local-model evidence no longer matches the lease", async () => {
		const leases = registry();
		const lease = issue(leases);
		const upstreamFetch = vi.fn(async () => new Response("unused"));
		const validateLocalModels = vi.fn(async () => false);
		const relay = createOllamaInferenceRelay({
			leases,
			upstreamFetch,
			validateLocalModels,
		});

		const response = await relay(
			relayRequest(OLLAMA_INFERENCE_CHAT_PATH, lease, {
				method: "POST",
				body: JSON.stringify({ model: "qwen3-coder:30b" }),
			}),
		);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: "local_model_evidence_changed",
		});
		expect(validateLocalModels).toHaveBeenCalledWith({
			lease: expect.objectContaining({ id: lease.id }),
			models: ["qwen3-coder:30b"],
			route: "chat",
			signal: expect.any(AbortSignal),
		});
		expect(upstreamFetch).not.toHaveBeenCalled();
	});

	it("identifies model discovery separately during local-model validation", async () => {
		const leases = registry();
		const lease = issue(leases);
		const validateLocalModels = vi.fn(async () => true);
		const relay = createOllamaInferenceRelay({
			leases,
			validateLocalModels,
			upstreamFetch: async () => Response.json({ data: [] }),
		});

		const response = await relay(
			relayRequest(OLLAMA_INFERENCE_MODELS_PATH, lease),
		);

		expect(response.status).toBe(200);
		expect(validateLocalModels).toHaveBeenCalledWith({
			lease: expect.objectContaining({ id: lease.id }),
			models: ["qwen3-coder:30b"],
			route: "models",
			signal: expect.any(AbortSignal),
		});
	});

	it("aborts an admitted upstream request when its exact lease is revoked", async () => {
		const leases = registry();
		const lease = issue(leases);
		let markStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const upstreamFetch = vi.fn(
			async (_input: string, init: RequestInit): Promise<Response> => {
				markStarted();
				return await new Promise((_resolve, reject) => {
					init.signal?.addEventListener(
						"abort",
						() => reject(init.signal?.reason),
						{
							once: true,
						},
					);
				});
			},
		);
		const relay = createOllamaInferenceRelay({ leases, upstreamFetch });
		const pending = relay(
			relayRequest(OLLAMA_INFERENCE_CHAT_PATH, lease, {
				method: "POST",
				body: JSON.stringify({ model: "qwen3-coder:30b" }),
			}),
		);

		await started;
		expect(leases.revoke(lease.id)).toBe(true);
		const response = await pending;

		expect(response.status).toBe(401);
		expect(upstreamFetch).toHaveBeenCalledOnce();
	});

	it("rebuilds the fixed-loopback request without credentials or hop-by-hop headers", async () => {
		const leases = registry();
		const lease = issue(leases);
		let forwardedInput: string | undefined;
		let forwardedInit: RequestInit | undefined;
		const bytes = new Uint8Array([0, 1, 2, 255, 10]);
		const upstreamFetch = vi.fn(async (input: string, init: RequestInit) => {
			forwardedInput = input;
			forwardedInit = init;
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(bytes.slice(0, 2));
						controller.enqueue(bytes.slice(2));
						controller.close();
					},
				}),
				{
					status: 206,
					statusText: "Partial Content",
					headers: {
						connection: "close",
						"content-length": String(bytes.byteLength),
						"content-type": "text/event-stream; charset=utf-8",
						"set-cookie": "upstream=secret",
						"x-upstream": "ollama",
					},
				},
			);
		});
		const relay = createOllamaInferenceRelay({ leases, upstreamFetch });
		const requestBody = JSON.stringify({
			model: "qwen3-coder:30b",
			messages: [{ role: "user", content: "sensitive prompt" }],
			stream: true,
		});

		const response = await relay(
			relayRequest(OLLAMA_INFERENCE_CHAT_PATH, lease, {
				method: "POST",
				headers: {
					accept: "text/event-stream",
					connection: "keep-alive",
					"proxy-authorization": "Basic secret",
					"x-client-secret": "secret",
				},
				body: requestBody,
			}),
		);

		expect(forwardedInput).toBe(
			`${OLLAMA_INFERENCE_UPSTREAM_ORIGIN}${OLLAMA_INFERENCE_CHAT_PATH}`,
		);
		expect(forwardedInit?.method).toBe("POST");
		expect(forwardedInit?.redirect).toBe("manual");
		const forwardedHeaders = new Headers(forwardedInit?.headers);
		expect(Object.fromEntries(forwardedHeaders)).toEqual({
			accept: "text/event-stream",
			"accept-encoding": "identity",
			"content-type": "application/json",
		});
		expect(await new Response(forwardedInit?.body).text()).toBe(requestBody);
		expect(response.status).toBe(206);
		expect(response.statusText).toBe("Partial Content");
		expect(response.headers.get("content-type")).toBe(
			"text/event-stream; charset=utf-8",
		);
		expect(response.headers.get("x-upstream")).toBe("ollama");
		expect(response.headers.has("connection")).toBe(false);
		expect(response.headers.has("content-length")).toBe(false);
		expect(response.headers.has("set-cookie")).toBe(false);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
	});

	it("filters model discovery to the lease allowlist", async () => {
		const leases = registry();
		const lease = issue(leases, {
			allowedModels: ["qwen3-coder:30b", "gpt-oss:20b"],
		});
		const upstreamFetch = vi.fn(async () =>
			Response.json(
				{
					object: "list",
					data: [
						{ id: "qwen3-coder:30b", object: "model" },
						{ id: "private-model:latest", object: "model" },
						{ id: "gpt-oss:20b", object: "model" },
						{ object: "model" },
					],
				},
				{ headers: { etag: "inventory-secret", "set-cookie": "bad=1" } },
			),
		);
		const relay = createOllamaInferenceRelay({ leases, upstreamFetch });

		const response = await relay(
			relayRequest(OLLAMA_INFERENCE_MODELS_PATH, lease),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			object: "list",
			data: [
				{ id: "qwen3-coder:30b", object: "model" },
				{ id: "gpt-oss:20b", object: "model" },
			],
		});
		expect(response.headers.get("content-type")).toBe("application/json");
		expect(response.headers.has("etag")).toBe(false);
		expect(response.headers.has("set-cookie")).toBe(false);
	});

	it("preserves an Ollama error response without treating it as inventory", async () => {
		const leases = registry();
		const lease = issue(leases);
		const upstreamFetch = vi.fn(
			async () =>
				new Response("Ollama is loading", {
					status: 503,
					statusText: "Loading",
					headers: { "content-type": "text/plain" },
				}),
		);
		const relay = createOllamaInferenceRelay({ leases, upstreamFetch });

		const response = await relay(
			relayRequest(OLLAMA_INFERENCE_MODELS_PATH, lease),
		);

		expect(response.status).toBe(503);
		expect(response.statusText).toBe("Loading");
		expect(response.headers.get("content-type")).toBe("text/plain");
		expect(await response.text()).toBe("Ollama is loading");
	});

	it("aborts Ollama when the downstream response is cancelled", async () => {
		const leases = registry();
		const lease = issue(leases);
		let upstreamAborted = false;
		let upstreamCancelled = false;
		const upstreamFetch = vi.fn(async (_input: string, init: RequestInit) => {
			init.signal?.addEventListener(
				"abort",
				() => {
					upstreamAborted = true;
				},
				{ once: true },
			);
			return new Response(
				new ReadableStream<Uint8Array>({
					cancel() {
						upstreamCancelled = true;
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		});
		const relay = createOllamaInferenceRelay({ leases, upstreamFetch });
		const response = await relay(
			relayRequest(OLLAMA_INFERENCE_CHAT_PATH, lease, {
				method: "POST",
				body: JSON.stringify({ model: "qwen3-coder:30b", stream: true }),
			}),
		);

		await response.body?.cancel("client stopped reading");

		expect(upstreamAborted).toBe(true);
		expect(upstreamCancelled).toBe(true);
	});

	it("bounds connection and model-inventory read-idle time", async () => {
		const leases = registry({
			tokens: ["a".repeat(43), "b".repeat(43)],
			ids: ["lease-1", "lease-2"],
		});
		const connectionLease = issue(leases);
		const idleLease = issue(leases, { processId: "opencode-5678" });
		const hangingFetch = vi.fn(
			async (_input: string, init: RequestInit): Promise<Response> =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener(
						"abort",
						() => reject(init.signal?.reason),
						{
							once: true,
						},
					);
				}),
		);
		const connectionRelay = createOllamaInferenceRelay({
			leases,
			upstreamFetch: hangingFetch,
			connectTimeoutMs: 10,
		});

		const connectionResponse = await connectionRelay(
			relayRequest(OLLAMA_INFERENCE_MODELS_PATH, connectionLease),
		);
		expect(connectionResponse.status).toBe(504);

		let readAborted = false;
		const idleRelay = createOllamaInferenceRelay({
			leases,
			readIdleTimeoutMs: 10,
			upstreamFetch: async (_input, init) => {
				init.signal?.addEventListener("abort", () => {
					readAborted = true;
				});
				return new Response(new ReadableStream<Uint8Array>());
			},
		});
		const idleResponse = await idleRelay(
			relayRequest(OLLAMA_INFERENCE_MODELS_PATH, idleLease),
		);
		expect(idleResponse.status).toBe(504);
		expect(readAborted).toBe(true);
	});

	it("bounds inbound chat-body read-idle time and releases capacity", async () => {
		const leases = registry({
			tokens: ["a".repeat(43), "b".repeat(43)],
			ids: ["lease-1", "lease-2"],
		});
		const stalledLease = issue(leases);
		const validLease = issue(leases, { processId: "opencode-5678" });
		let bodyCancelled = false;
		const stalledBody = new ReadableStream<Uint8Array>({
			pull: () => new Promise<void>(() => {}),
			cancel() {
				bodyCancelled = true;
			},
		});
		const upstreamFetch = vi.fn(async () => Response.json({ ok: true }));
		const relay = createOllamaInferenceRelay({
			leases,
			upstreamFetch,
			maxConcurrent: 1,
			readIdleTimeoutMs: 10,
		});
		const stalled = await relay(
			new Request(`http://relay.test${OLLAMA_INFERENCE_CHAT_PATH}`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${stalledLease.token}`,
					"content-type": "application/json",
				},
				body: stalledBody,
				duplex: "half",
			} as RequestInit & { duplex: "half" }),
		);

		expect(stalled.status).toBe(408);
		expect(await stalled.json()).toEqual({ error: "request_body_timeout" });
		expect(bodyCancelled).toBe(true);
		expect(upstreamFetch).not.toHaveBeenCalled();

		const afterTimeout = await relay(
			relayRequest(OLLAMA_INFERENCE_CHAT_PATH, validLease, {
				method: "POST",
				body: JSON.stringify({ model: "qwen3-coder:30b" }),
			}),
		);
		expect(afterTimeout.status).toBe(200);
		await afterTimeout.body?.cancel();
	});

	it("releases capacity immediately when a stalled upload lease is revoked", async () => {
		const leases = registry({
			tokens: ["a".repeat(43), "b".repeat(43)],
			ids: ["lease-1", "lease-2"],
		});
		const stalledLease = issue(leases);
		const validLease = issue(leases, { processId: "opencode-5678" });
		let markReading: () => void = () => {};
		const reading = new Promise<void>((resolve) => {
			markReading = resolve;
		});
		let bodyCancelled = false;
		const stalledBody = new ReadableStream<Uint8Array>({
			pull() {
				markReading();
				return new Promise<void>(() => {});
			},
			cancel() {
				bodyCancelled = true;
			},
		});
		const upstreamFetch = vi.fn(async () => Response.json({ ok: true }));
		const relay = createOllamaInferenceRelay({
			leases,
			upstreamFetch,
			maxConcurrent: 1,
		});
		const stalled = relay(
			new Request(`http://relay.test${OLLAMA_INFERENCE_CHAT_PATH}`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${stalledLease.token}`,
					"content-type": "application/json",
				},
				body: stalledBody,
				duplex: "half",
			} as RequestInit & { duplex: "half" }),
		);
		await reading;

		expect(leases.revoke(stalledLease.id)).toBe(true);
		const admittedImmediately = relay(
			relayRequest(OLLAMA_INFERENCE_CHAT_PATH, validLease, {
				method: "POST",
				body: JSON.stringify({ model: "qwen3-coder:30b" }),
			}),
		);
		const [revoked, admitted] = await Promise.all([
			stalled,
			admittedImmediately,
		]);

		expect(revoked.status).toBe(401);
		expect(revoked.headers.get("www-authenticate")).toBe("Bearer");
		expect(bodyCancelled).toBe(true);
		expect(admitted.status).toBe(200);
		await admitted.body?.cancel();
	});

	it("returns 499 and releases capacity when a stalled upload client aborts", async () => {
		const leases = registry({
			tokens: ["a".repeat(43), "b".repeat(43)],
			ids: ["lease-1", "lease-2"],
		});
		const stalledLease = issue(leases);
		const validLease = issue(leases, { processId: "opencode-5678" });
		let markReading: () => void = () => {};
		const reading = new Promise<void>((resolve) => {
			markReading = resolve;
		});
		const client = new AbortController();
		const stalledBody = new ReadableStream<Uint8Array>({
			pull() {
				markReading();
				return new Promise<void>(() => {});
			},
		});
		const relay = createOllamaInferenceRelay({
			leases,
			upstreamFetch: async () => Response.json({ ok: true }),
			maxConcurrent: 1,
		});
		const stalled = relay(
			new Request(`http://relay.test${OLLAMA_INFERENCE_CHAT_PATH}`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${stalledLease.token}`,
					"content-type": "application/json",
				},
				body: stalledBody,
				duplex: "half",
				signal: client.signal,
			} as RequestInit & { duplex: "half" }),
		);
		await reading;

		client.abort();
		const admittedImmediately = relay(
			relayRequest(OLLAMA_INFERENCE_CHAT_PATH, validLease, {
				method: "POST",
				body: JSON.stringify({ model: "qwen3-coder:30b" }),
			}),
		);
		const [aborted, admitted] = await Promise.all([
			stalled,
			admittedImmediately,
		]);

		expect(aborted.status).toBe(499);
		expect(admitted.status).toBe(200);
		await admitted.body?.cancel();
	});

	it("holds relay capacity until a streaming request finishes or cancels", async () => {
		const leases = registry({
			tokens: ["a".repeat(43), "b".repeat(43)],
			ids: ["lease-1", "lease-2"],
		});
		const firstLease = issue(leases);
		const secondLease = issue(leases, { processId: "opencode-5678" });
		const upstreamFetch = vi.fn(
			async () => new Response(new ReadableStream<Uint8Array>()),
		);
		const relay = createOllamaInferenceRelay({
			leases,
			upstreamFetch,
			maxConcurrent: 1,
		});
		const first = await relay(
			relayRequest(OLLAMA_INFERENCE_CHAT_PATH, firstLease, {
				method: "POST",
				body: JSON.stringify({ model: "qwen3-coder:30b", stream: true }),
			}),
		);

		const second = await relay(
			relayRequest(OLLAMA_INFERENCE_CHAT_PATH, secondLease, {
				method: "POST",
				body: JSON.stringify({ model: "qwen3-coder:30b", stream: true }),
			}),
		);
		expect(second.status).toBe(429);

		await first.body?.cancel();
		const afterCancel = await relay(
			relayRequest(OLLAMA_INFERENCE_CHAT_PATH, secondLease, {
				method: "POST",
				body: JSON.stringify({ model: "qwen3-coder:30b", stream: true }),
			}),
		);
		expect(afterCancel.status).toBe(200);
		await afterCancel.body?.cancel();
	});
});
