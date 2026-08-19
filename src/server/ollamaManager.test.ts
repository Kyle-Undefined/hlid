import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_OLLAMA_BASE_URL,
	normalizeOllamaLoopbackBaseUrl,
	OllamaClientError,
	type OllamaClock,
	type OllamaFetch,
	OllamaManager,
} from "./ollamaManager";

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json", ...headers },
		status,
	});
}

function ndjsonResponse(chunks: string[], headers?: HeadersInit) {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		}),
		{
			headers: {
				"content-type": "application/x-ndjson",
				...headers,
			},
		},
	);
}

function localModel(overrides: Record<string, unknown> = {}) {
	return {
		capabilities: ["completion", "tools"],
		details: {
			families: ["qwen2"],
			family: "qwen2",
			format: "gguf",
			parameter_size: "7B",
			quantization_level: "Q4_K_M",
		},
		digest: "sha256:local",
		model: "qwen2.5-coder:7b",
		modified_at: "2030-01-01T00:00:00Z",
		name: "qwen2.5-coder:7b",
		size: 4_000_000_000,
		...overrides,
	};
}

function loadedModel(overrides: Record<string, unknown> = {}) {
	return {
		context_length: 65_536,
		details: localModel().details,
		digest: "sha256:local",
		expires_at: "2030-01-01T00:05:00Z",
		model: "qwen2.5-coder:7b",
		name: "qwen2.5-coder:7b",
		size: 4_000_000_000,
		size_vram: 3_500_000_000,
		...overrides,
	};
}

function injectedClock(now = 123_000): {
	clock: OllamaClock;
	controllers: AbortController[];
	now: ReturnType<typeof vi.fn>;
} {
	const controllers: AbortController[] = [];
	const nowFn = vi.fn(() => now);
	return {
		clock: {
			now: nowFn,
			timeoutSignal: vi.fn(() => {
				const controller = new AbortController();
				controllers.push(controller);
				return controller.signal;
			}),
		},
		controllers,
		now: nowFn,
	};
}

async function expectOllamaError(
	promise: Promise<unknown>,
	code: OllamaClientError["code"],
) {
	try {
		await promise;
		expect.unreachable("expected an OllamaClientError");
	} catch (error) {
		expect(error).toBeInstanceOf(OllamaClientError);
		expect((error as OllamaClientError).code).toBe(code);
		return error as OllamaClientError;
	}
}

describe("normalizeOllamaLoopbackBaseUrl", () => {
	it("accepts only a bare IPv4 Windows loopback origin", () => {
		expect(normalizeOllamaLoopbackBaseUrl(DEFAULT_OLLAMA_BASE_URL)).toBe(
			DEFAULT_OLLAMA_BASE_URL,
		);
		expect(normalizeOllamaLoopbackBaseUrl("http://127.0.0.1:22999/")).toBe(
			"http://127.0.0.1:22999",
		);
	});

	it.each([
		"http://localhost:11434",
		"http://0.0.0.0:11434",
		"http://192.168.1.10:11434",
		"https://127.0.0.1:11434",
		"http://user:secret@127.0.0.1:11434",
		"http://127.0.0.1:11434/api",
		"not a url",
	])("rejects non-loopback or decorated upstream %s", (value) => {
		expect(() => normalizeOllamaLoopbackBaseUrl(value)).toThrow();
	});
});

describe("OllamaManager status and response safety", () => {
	it("reads the server version from the fixed default endpoint", async () => {
		const fetchFn = vi.fn(
			async (_input: string | URL | Request, _init?: RequestInit) =>
				jsonResponse({ version: "0.32.14" }),
		);
		const manager = new OllamaManager({ fetch: fetchFn });

		await expect(manager.getVersion()).resolves.toBe("0.32.14");
		expect(fetchFn).toHaveBeenCalledOnce();
		expect(fetchFn.mock.calls[0]?.[0]).toBe(
			"http://127.0.0.1:11434/api/version",
		);
		expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({
			headers: { accept: "application/json" },
			method: "GET",
			signal: expect.any(AbortSignal),
		});
	});

	it("returns a timestamped nonfatal status when Windows Ollama is unavailable", async () => {
		const { clock } = injectedClock(456_000);
		const manager = new OllamaManager({
			clock,
			fetch: vi.fn(async () => {
				throw new Error("secret transport details");
			}),
		});

		await expect(manager.getStatus()).resolves.toEqual({
			available: false,
			checkedAt: 456_000,
			reason: "unavailable",
			version: null,
		});
	});

	it("reports a clock-controlled timeout without exposing transport errors", async () => {
		const { clock, controllers } = injectedClock();
		const fetchFn: OllamaFetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(init.signal?.reason),
				);
			});
		const manager = new OllamaManager({ clock, fetch: fetchFn });

		const request = manager.getVersion();
		controllers[0]?.abort(new Error("private timeout reason"));
		const error = await expectOllamaError(request, "timeout");
		expect(error.message).toBe("Ollama request timed out");
		expect(error.message).not.toContain("private");
	});

	it("preserves explicit caller cancellation", async () => {
		const external = new AbortController();
		const fetchFn: OllamaFetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(init.signal?.reason),
				);
			});
		const manager = new OllamaManager({ fetch: fetchFn });

		const request = manager.getStatus({ signal: external.signal });
		external.abort(new Error("do not expose me"));
		await expectOllamaError(request, "aborted");
	});

	it("does not call fetch for an already-aborted request", async () => {
		const external = new AbortController();
		external.abort();
		const fetchFn = vi.fn(async () => jsonResponse({ version: "0.32.14" }));
		const manager = new OllamaManager({ fetch: fetchFn });

		await expectOllamaError(
			manager.getVersion({ signal: external.signal }),
			"aborted",
		);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("bounds JSON before parsing it", async () => {
		const manager = new OllamaManager({
			fetch: vi.fn(async () => jsonResponse({ version: "0.32.14" })),
			maxJsonBytes: 10,
		});

		await expectOllamaError(manager.getVersion(), "response-too-large");
	});

	it("never incorporates an HTTP error body into the thrown error", async () => {
		const manager = new OllamaManager({
			fetch: vi.fn(async () =>
				jsonResponse({ error: "prompt and token secret" }, 500),
			),
		});

		const error = await expectOllamaError(manager.getVersion(), "http");
		expect(error.status).toBe(500);
		expect(error.message).toBe("Ollama returned HTTP 500");
		expect(error.message).not.toContain("secret");
	});

	it("rejects malformed successful JSON", async () => {
		const manager = new OllamaManager({
			fetch: vi.fn(async () => new Response("{nope")),
		});

		await expectOllamaError(manager.getVersion(), "invalid-response");
	});
});

describe("OllamaManager model inspection", () => {
	it("treats compatibility evidence omitted by the official tags shape as unknown", async () => {
		const manager = new OllamaManager({
			fetch: vi.fn(async () =>
				jsonResponse({
					models: [
						{
							details: {
								families: ["gemma3"],
								family: "gemma3",
								format: "gguf",
								parameter_size: "4.3B",
								quantization_level: "Q4_K_M",
							},
							digest: "a".repeat(64),
							model: "gemma3:4b",
							modified_at: "2030-01-01T00:00:00Z",
							name: "gemma3:4b",
							size: 3_338_801_804,
						},
					],
				}),
			),
		});

		await expect(manager.listLocalModels()).resolves.toEqual([
			expect.objectContaining({
				capabilities: [],
				details: expect.objectContaining({
					contextLength: null,
					family: "gemma3",
				}),
				model: "gemma3:4b",
			}),
		]);
	});

	it("lists local models while excluding only explicit remote evidence", async () => {
		const fetchFn = vi.fn(async () =>
			jsonResponse({
				models: [
					localModel(),
					localModel({
						digest: "",
						model: "gpt-cloud",
						name: "gpt-cloud",
						remote_host: "https://ollama.com",
					}),
					localModel({
						digest: "",
						model: "other-cloud",
						name: "other-cloud",
						remote_model: "upstream/model",
					}),
					localModel({
						details: {},
						digest: "sha256:zero",
						model: "unusual-local",
						name: "unusual-local",
						size: 0,
					}),
				],
			}),
		);
		const manager = new OllamaManager({ fetch: fetchFn });

		const models = await manager.listLocalModels();

		expect(models.map((model) => model.model)).toEqual([
			"qwen2.5-coder:7b",
			"unusual-local",
		]);
		expect(models[0]).toMatchObject({
			capabilities: ["completion", "tools"],
			details: {
				family: "qwen2",
				format: "gguf",
				parameterSize: "7B",
				quantizationLevel: "Q4_K_M",
			},
			size: 4_000_000_000,
		});
	});

	it("shows bounded local details and derives context length from model_info", async () => {
		const fetchFn = vi.fn(
			async (_input: string | URL | Request, _init?: RequestInit) =>
				jsonResponse({
					capabilities: ["completion", "tools"],
					details: localModel().details,
					model_info: {
						"qwen2.context_length": 65_536,
						"qwen2.embedding_length": 3_584,
					},
					modified_at: "2030-01-01T00:00:00Z",
					requires: "0.10.0",
				}),
		);
		const manager = new OllamaManager({ fetch: fetchFn });

		await expect(manager.showModel(" qwen2.5-coder:7b ")).resolves.toEqual({
			capabilities: ["completion", "tools"],
			contextLength: 65_536,
			details: expect.objectContaining({ family: "qwen2" }),
			model: "qwen2.5-coder:7b",
			modifiedAt: "2030-01-01T00:00:00Z",
			requires: "0.10.0",
		});
		expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toEqual({
			model: "qwen2.5-coder:7b",
			verbose: false,
		});
	});

	it.each([
		{ remote_host: "https://ollama.com" },
		{ remote_model: "gpt-remote" },
	])("refuses details for cloud-backed models", async (remoteEvidence) => {
		const manager = new OllamaManager({
			fetch: vi.fn(async () => jsonResponse(remoteEvidence)),
		});

		await expectOllamaError(manager.showModel("cloud-model"), "remote-model");
	});

	it("lists loaded state including actual context and VRAM", async () => {
		const manager = new OllamaManager({
			fetch: vi.fn(async () => jsonResponse({ models: [loadedModel()] })),
		});

		await expect(manager.listLoadedModels()).resolves.toEqual([
			expect.objectContaining({
				contextLength: 65_536,
				model: "qwen2.5-coder:7b",
				sizeVram: 3_500_000_000,
			}),
		]);
	});

	it("fails closed on malformed inventory entries", async () => {
		const manager = new OllamaManager({
			fetch: vi.fn(async () =>
				jsonResponse({ models: [localModel({ size: -1 })] }),
			),
		});

		await expectOllamaError(manager.listLocalModels(), "invalid-response");
	});
});

describe("OllamaManager streamed pulls", () => {
	it("parses chunked NDJSON progress with clocked events and a final result", async () => {
		const { clock, now } = injectedClock(1_000);
		now
			.mockReturnValueOnce(1_001)
			.mockReturnValueOnce(1_002)
			.mockReturnValueOnce(1_003)
			.mockReturnValueOnce(1_004);
		const fetchFn = vi.fn(
			async (_input: string | URL | Request, _init?: RequestInit) =>
				ndjsonResponse([
					'{"status":"pulling manifest"}\n{"status":"down',
					'loading","digest":"sha256:layer","total":100,"completed":25}\r\n',
					'{"status":"success"}\n',
				]),
		);
		const onProgress = vi.fn(async () => {});
		const manager = new OllamaManager({ clock, fetch: fetchFn });

		await expect(
			manager.pullModel("qwen2.5-coder:7b", { onProgress }),
		).resolves.toEqual({
			completed: 25,
			completedAt: 1_004,
			events: 3,
			model: "qwen2.5-coder:7b",
			total: 100,
		});
		expect(onProgress).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				completed: 25,
				digest: "sha256:layer",
				percent: 0.25,
				receivedAt: 1_002,
				total: 100,
			}),
		);
		expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toEqual({
			model: "qwen2.5-coder:7b",
			stream: true,
		});
	});

	it("rejects a truncated or error-bearing progress stream", async () => {
		const truncated = new OllamaManager({
			fetch: vi.fn(async () => ndjsonResponse(['{"status":"downloading"}\n'])),
		});
		const failed = new OllamaManager({
			fetch: vi.fn(async () =>
				ndjsonResponse(['{"error":"private registry detail"}\n']),
			),
		});

		await expectOllamaError(
			truncated.pullModel("qwen2.5-coder:7b"),
			"invalid-response",
		);
		const error = await expectOllamaError(
			failed.pullModel("qwen2.5-coder:7b"),
			"invalid-response",
		);
		expect(error.message).not.toContain("private");
	});

	it("requires success to be the final progress event", async () => {
		const manager = new OllamaManager({
			fetch: vi.fn(async () =>
				ndjsonResponse([
					'{"status":"success"}\n{"status":"unexpected trailing event"}\n',
				]),
			),
		});

		await expectOllamaError(
			manager.pullModel("qwen2.5-coder:7b"),
			"invalid-response",
		);
	});

	it("bounds both individual progress lines and the entire stream", async () => {
		const lineBound = new OllamaManager({
			fetch: vi.fn(async () =>
				ndjsonResponse([`${JSON.stringify({ status: "x".repeat(200) })}\n`]),
			),
			maxPullBytes: 1_000,
			maxPullLineBytes: 64,
		});
		const streamBound = new OllamaManager({
			fetch: vi.fn(async () =>
				ndjsonResponse(['{"status":"success","padding":"123456789"}\n']),
			),
			maxPullBytes: 25,
			maxPullLineBytes: 25,
		});

		await expectOllamaError(
			lineBound.pullModel("qwen2.5-coder:7b"),
			"response-too-large",
		);
		await expectOllamaError(
			streamBound.pullModel("qwen2.5-coder:7b"),
			"response-too-large",
		);
	});

	it("propagates AbortSignal cancellation through a pending pull", async () => {
		const external = new AbortController();
		const fetchFn: OllamaFetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(init.signal?.reason),
				);
			});
		const manager = new OllamaManager({ fetch: fetchFn });

		const request = manager.pullModel("qwen2.5-coder:7b", {
			signal: external.signal,
		});
		external.abort();
		await expectOllamaError(request, "aborted");
	});

	it("cancels the stream but preserves errors thrown by the progress consumer", async () => {
		const manager = new OllamaManager({
			fetch: vi.fn(async () => ndjsonResponse(['{"status":"success"}\n'])),
		});
		const consumerError = new TypeError("consumer stopped");

		await expect(
			manager.pullModel("qwen2.5-coder:7b", {
				onProgress: () => {
					throw consumerError;
				},
			}),
		).rejects.toBe(consumerError);
	});
});

describe("OllamaManager explicit mutations", () => {
	it("deletes only through the explicit DELETE endpoint", async () => {
		const fetchFn = vi.fn(
			async (_input: string | URL | Request, _init?: RequestInit) =>
				new Response(null, { status: 200 }),
		);
		const manager = new OllamaManager({ fetch: fetchFn });

		await manager.deleteModel("qwen2.5-coder:7b");

		expect(fetchFn.mock.calls[0]?.[0]).toBe(
			"http://127.0.0.1:11434/api/delete",
		);
		expect(fetchFn.mock.calls[0]?.[1]?.method).toBe("DELETE");
		expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toEqual({
			model: "qwen2.5-coder:7b",
		});
	});

	it("creates or overwrites a fixed-context variant from a verified local model", async () => {
		const { clock } = injectedClock();
		const fetchFn = vi.fn(
			async (input: string | URL | Request, _init?: RequestInit) => {
				if (String(input).endsWith("/api/show")) return jsonResponse({});
				if (String(input).endsWith("/api/create")) {
					return jsonResponse({ status: "success" });
				}
				throw new Error("unexpected endpoint");
			},
		);
		const manager = new OllamaManager({
			clock,
			fetch: fetchFn,
			loadTimeoutMs: 9_876,
			requestTimeoutMs: 1_234,
		});

		await expect(
			manager.createContextModel(
				" hlid/qwen2.5-coder:7b-64k ",
				" qwen2.5-coder:7b ",
				65_536,
			),
		).resolves.toBeUndefined();

		expect(fetchFn).toHaveBeenCalledTimes(2);
		expect(fetchFn.mock.calls[0]?.[0]).toBe("http://127.0.0.1:11434/api/show");
		expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toEqual({
			model: "qwen2.5-coder:7b",
			verbose: false,
		});
		expect(fetchFn.mock.calls[1]?.[0]).toBe(
			"http://127.0.0.1:11434/api/create",
		);
		expect(fetchFn.mock.calls[1]?.[1]).toMatchObject({
			headers: {
				accept: "application/json",
				"content-type": "application/json",
			},
			method: "POST",
			signal: expect.any(AbortSignal),
		});
		expect(JSON.parse(String(fetchFn.mock.calls[1]?.[1]?.body))).toEqual({
			from: "qwen2.5-coder:7b",
			model: "hlid/qwen2.5-coder:7b-64k",
			parameters: { num_ctx: 65_536 },
			stream: false,
		});
		expect(clock.timeoutSignal).toHaveBeenNthCalledWith(1, 1_234);
		expect(clock.timeoutSignal).toHaveBeenNthCalledWith(2, 9_876);
	});

	it.each([
		null,
		{},
		{ status: "creating" },
	])("rejects an invalid create response: %j", async (responseBody) => {
		const fetchFn = vi.fn(async (input: string | URL | Request) =>
			String(input).endsWith("/api/show")
				? jsonResponse({})
				: jsonResponse(responseBody),
		);
		const manager = new OllamaManager({ fetch: fetchFn });

		await expectOllamaError(
			manager.createContextModel(
				"hlid/qwen2.5-coder:7b-64k",
				"qwen2.5-coder:7b",
				65_536,
			),
			"invalid-response",
		);
	});

	it("bounds the non-streaming create response before parsing it", async () => {
		const fetchFn = vi.fn(async (input: string | URL | Request) =>
			String(input).endsWith("/api/show")
				? jsonResponse({})
				: jsonResponse({ padding: "x".repeat(64), status: "success" }),
		);
		const manager = new OllamaManager({ fetch: fetchFn, maxJsonBytes: 32 });

		await expectOllamaError(
			manager.createContextModel(
				"hlid/qwen2.5-coder:7b-64k",
				"qwen2.5-coder:7b",
				65_536,
			),
			"response-too-large",
		);
	});

	it("preserves cancellation while creating a context variant", async () => {
		const external = new AbortController();
		const fetchFn: OllamaFetch = vi.fn((input, init) => {
			if (String(input).endsWith("/api/show")) {
				return Promise.resolve(jsonResponse({}));
			}
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(init.signal?.reason),
				);
			});
		});
		const manager = new OllamaManager({ fetch: fetchFn });

		const request = manager.createContextModel(
			"hlid/qwen2.5-coder:7b-64k",
			"qwen2.5-coder:7b",
			65_536,
			{ signal: external.signal },
		);
		await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
		external.abort(new Error("private cancellation detail"));
		const error = await expectOllamaError(request, "aborted");
		expect(error.message).not.toContain("private");
	});

	it("preserves an HTTP failure from the create endpoint", async () => {
		const fetchFn = vi.fn(async (input: string | URL | Request) =>
			String(input).endsWith("/api/show")
				? jsonResponse({})
				: jsonResponse({ error: "private response" }, 409),
		);
		const manager = new OllamaManager({ fetch: fetchFn });

		const error = await expectOllamaError(
			manager.createContextModel(
				"hlid/qwen2.5-coder:7b-64k",
				"qwen2.5-coder:7b",
				65_536,
			),
			"http",
		);
		expect(error.status).toBe(409);
		expect(error.message).not.toContain("private");
	});

	it.each([
		["", "qwen2.5-coder:7b", 65_536],
		["hlid/qwen2.5-coder:7b-64k", "bad\nmodel", 65_536],
		["hlid/qwen2.5-coder:7b-64k", "qwen2.5-coder:7b", 0],
		["hlid/qwen2.5-coder:7b-64k", "qwen2.5-coder:7b", 1.5],
		["hlid/qwen2.5-coder:7b-64k", "qwen2.5-coder:7b", 4 * 1024 * 1024 + 1],
	])("rejects invalid create input before fetch: model=%s from=%s numCtx=%s", async (model, from, numCtx) => {
		const fetchFn = vi.fn(
			async (_input: string | URL | Request, _init?: RequestInit) =>
				jsonResponse({ status: "success" }),
		);
		const manager = new OllamaManager({ fetch: fetchFn });

		await expect(
			manager.createContextModel(model, from, numCtx),
		).rejects.toThrow();
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("refuses to create from a cloud-backed base model", async () => {
		const fetchFn = vi.fn(
			async (_input: string | URL | Request, _init?: RequestInit) =>
				jsonResponse({ remote_model: "registry/private-model" }),
		);
		const manager = new OllamaManager({ fetch: fetchFn });

		await expectOllamaError(
			manager.createContextModel("hlid/cloud-model:64k", "cloud-model", 65_536),
			"remote-model",
		);
		expect(fetchFn).toHaveBeenCalledOnce();
		expect(String(fetchFn.mock.calls[0]?.[0])).toMatch(/\/api\/show$/);
	});

	it("loads and unloads a verified local model with documented generate options", async () => {
		const fetchFn = vi.fn(
			async (input: string | URL | Request, _init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/api/show")) return jsonResponse({});
				if (url.endsWith("/api/generate")) {
					return jsonResponse({ done: true, model: "qwen2.5-coder:7b" });
				}
				throw new Error("unexpected endpoint");
			},
		);
		const manager = new OllamaManager({ fetch: fetchFn });

		await expect(
			manager.loadModel("qwen2.5-coder:7b", {
				keepAlive: "24h",
				numCtx: 65_536,
			}),
		).resolves.toEqual({
			keepAlive: "24h",
			model: "qwen2.5-coder:7b",
			numCtx: 65_536,
		});
		await expect(manager.unloadModel("qwen2.5-coder:7b")).resolves.toEqual({
			keepAlive: 0,
			model: "qwen2.5-coder:7b",
		});

		const generatedBodies = fetchFn.mock.calls
			.filter(([input]) => String(input).endsWith("/api/generate"))
			.map(([, init]) => JSON.parse(String(init?.body)));
		expect(generatedBodies).toEqual([
			{
				keep_alive: "24h",
				model: "qwen2.5-coder:7b",
				options: { num_ctx: 65_536 },
				prompt: "",
				stream: false,
			},
			{
				keep_alive: 0,
				model: "qwen2.5-coder:7b",
				prompt: "",
				stream: false,
			},
		]);
	});

	it("uses an indefinite local keep-alive by default", async () => {
		const fetchFn = vi.fn(async (input: string | URL | Request) =>
			String(input).endsWith("/api/show")
				? jsonResponse({})
				: jsonResponse({ done: true }),
		);
		const manager = new OllamaManager({ fetch: fetchFn });

		await expect(manager.loadModel("qwen2.5-coder:7b")).resolves.toEqual({
			keepAlive: -1,
			model: "qwen2.5-coder:7b",
		});
	});

	it("refuses to invoke generate when show reports a remote model", async () => {
		const fetchFn = vi.fn(async () =>
			jsonResponse({ remote_host: "https://ollama.com" }),
		);
		const manager = new OllamaManager({ fetch: fetchFn });

		await expectOllamaError(manager.loadModel("cloud-model"), "remote-model");
		expect(fetchFn).toHaveBeenCalledOnce();
	});

	it.each([
		"",
		"bad\nmodel",
		1.5,
	])("rejects unsafe model or keep-alive input before fetch: %s", async (value) => {
		const fetchFn = vi.fn(async () => jsonResponse({ done: true }));
		const manager = new OllamaManager({ fetch: fetchFn });

		if (typeof value === "number") {
			await expect(
				manager.loadModel("qwen2.5-coder:7b", { keepAlive: value }),
			).rejects.toThrow();
		} else {
			await expect(manager.deleteModel(value)).rejects.toThrow();
		}
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it.each([
		0,
		-1,
		1.5,
		4 * 1024 * 1024 + 1,
	])("rejects an unsafe context allocation before fetch: %s", async (numCtx) => {
		const fetchFn = vi.fn(async () => jsonResponse({ done: true }));
		const manager = new OllamaManager({ fetch: fetchFn });

		await expect(
			manager.loadModel("qwen2.5-coder:7b", { numCtx }),
		).rejects.toThrow(/context length/i);
		expect(fetchFn).not.toHaveBeenCalled();
	});
});
