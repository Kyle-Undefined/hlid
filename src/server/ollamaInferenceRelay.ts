import { randomBytes, randomUUID } from "node:crypto";
import { verifyToken } from "../lib/token";
import {
	createConcurrencyGate,
	payloadTooLarge,
	readRequestBodyLimited,
} from "./requestLimits";

export const OLLAMA_INFERENCE_UPSTREAM_ORIGIN =
	"http://127.0.0.1:11434" as const;
export const OLLAMA_INFERENCE_MODELS_PATH = "/v1/models" as const;
export const OLLAMA_INFERENCE_CHAT_PATH = "/v1/chat/completions" as const;
export const OLLAMA_INFERENCE_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
export const OLLAMA_INFERENCE_MAX_MODELS_RESPONSE_BYTES = 2 * 1024 * 1024;
export const OLLAMA_INFERENCE_CONNECT_TIMEOUT_MS = 120_000;
export const OLLAMA_INFERENCE_READ_IDLE_TIMEOUT_MS = 120_000;
export const OLLAMA_INFERENCE_MAX_CONCURRENT_REQUESTS = 8;
export const OLLAMA_INFERENCE_MAX_ACTIVE_LEASES = 256;

const CAPABILITY_TOKEN_LENGTH = 43;
const DUMMY_CAPABILITY_TOKEN = "0".repeat(CAPABILITY_TOKEN_LENGTH);
const CAPABILITY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_IDENTITY_LENGTH = 512;
const MAX_MODEL_LENGTH = 512;
const MAX_MODELS_PER_LEASE = 256;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i;
const TRAVERSAL_SYNTAX = /(?:^|[\\/])\.{1,2}(?:[\\/]|$)|%2e|%2f|%5c|\\/i;
const STRIP_RESPONSE_HEADERS = new Set([
	"connection",
	"content-encoding",
	"content-length",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"set-cookie",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

export type OllamaInferenceLeaseIdentity = Readonly<{
	profileId: string;
	targetId: string;
	processId: string;
}>;

export type OllamaInferenceLease = OllamaInferenceLeaseIdentity &
	Readonly<{
		id: string;
		allowedModels: readonly string[];
		issuedAt: number;
		expiresAt: number;
	}>;

export type IssuedOllamaInferenceLease = OllamaInferenceLease &
	Readonly<{
		token: string;
	}>;

export type IssueOllamaInferenceLeaseInput = OllamaInferenceLeaseIdentity &
	Readonly<{
		allowedModels: Iterable<string>;
		expiresAt: number;
	}>;

type StoredOllamaInferenceLease = Readonly<{
	lease: OllamaInferenceLease;
	token: string;
	controller: AbortController;
}>;

export type OllamaInferenceLeaseRegistryOptions = Readonly<{
	now?: () => number;
	tokenFactory?: () => string;
	idFactory?: () => string;
	maxActiveLeases?: number;
}>;

function validBoundedInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${label} must be a positive safe integer.`);
	}
	return value;
}

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function validateIdentity(value: string, label: string): string {
	if (
		value.length === 0 ||
		value.length > MAX_IDENTITY_LENGTH ||
		value !== value.trim() ||
		hasControlCharacter(value)
	) {
		throw new Error(`${label} is invalid.`);
	}
	return value;
}

function normalizeModels(models: Iterable<string>): readonly string[] {
	const result = new Set<string>();
	for (const model of models) {
		if (
			typeof model !== "string" ||
			model.length === 0 ||
			model.length > MAX_MODEL_LENGTH ||
			model !== model.trim() ||
			hasControlCharacter(model)
		) {
			throw new Error("An allowed Ollama model is invalid.");
		}
		result.add(model);
		if (result.size > MAX_MODELS_PER_LEASE) {
			throw new Error(
				`An Ollama inference lease cannot allow more than ${MAX_MODELS_PER_LEASE} models.`,
			);
		}
	}
	if (result.size === 0) {
		throw new Error("An Ollama inference lease must allow at least one model.");
	}
	return Object.freeze([...result]);
}

function secureCapabilityToken(): string {
	return randomBytes(32).toString("base64url");
}

function parseBearerToken(header: string | null): string | null {
	if (!header) return null;
	const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(header);
	return match?.[1] ?? null;
}

/**
 * Holds process-scoped inference capabilities only in memory. Tokens are
 * fixed-length random values and every candidate comparison uses verifyToken.
 */
export class OllamaInferenceLeaseRegistry {
	readonly #leases = new Map<string, StoredOllamaInferenceLease>();
	readonly #now: () => number;
	readonly #tokenFactory: () => string;
	readonly #idFactory: () => string;
	readonly #maxActiveLeases: number;

	constructor(options: OllamaInferenceLeaseRegistryOptions = {}) {
		this.#now = options.now ?? Date.now;
		this.#tokenFactory = options.tokenFactory ?? secureCapabilityToken;
		this.#idFactory = options.idFactory ?? randomUUID;
		this.#maxActiveLeases = validBoundedInteger(
			options.maxActiveLeases ?? OLLAMA_INFERENCE_MAX_ACTIVE_LEASES,
			"maxActiveLeases",
		);
	}

	issue(input: IssueOllamaInferenceLeaseInput): IssuedOllamaInferenceLease {
		const now = this.#now();
		this.#pruneExpired(now);
		if (this.#leases.size >= this.#maxActiveLeases) {
			throw new Error("The Ollama inference lease limit has been reached.");
		}
		if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) {
			throw new Error("expiresAt must be a future safe-integer timestamp.");
		}

		const id = validateIdentity(this.#idFactory(), "lease id");
		if (this.#leases.has(id)) {
			throw new Error("The Ollama inference lease id already exists.");
		}
		const allowedModels = normalizeModels(input.allowedModels);
		const token = this.#uniqueToken();
		const lease = Object.freeze({
			id,
			profileId: validateIdentity(input.profileId, "profileId"),
			targetId: validateIdentity(input.targetId, "targetId"),
			processId: validateIdentity(input.processId, "processId"),
			allowedModels,
			issuedAt: now,
			expiresAt: input.expiresAt,
		});
		this.#leases.set(id, { lease, token, controller: new AbortController() });
		return Object.freeze({ ...lease, token });
	}

	revoke(leaseId: string): boolean {
		const stored = this.#leases.get(leaseId);
		if (!stored) return false;
		stored.controller.abort(new OllamaLeaseRevokedError());
		return this.#leases.delete(leaseId);
	}

	renew(leaseId: string, expiresAt: number): boolean {
		const now = this.#now();
		this.#pruneExpired(now);
		if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
			throw new Error("expiresAt must be a future safe-integer timestamp.");
		}
		const stored = this.#leases.get(leaseId);
		if (!stored) return false;
		const lease = Object.freeze({ ...stored.lease, expiresAt });
		this.#leases.set(leaseId, { ...stored, lease });
		return true;
	}

	// fallow-ignore-next-line unused-class-member -- The relay handler consumes this injected registry boundary.
	lifecycleSignal(leaseId: string): AbortSignal | null {
		return this.#leases.get(leaseId)?.controller.signal ?? null;
	}

	// fallow-ignore-next-line unused-class-member -- The relay handler consumes this injected registry boundary.
	authorize(authorizationHeader: string | null): OllamaInferenceLease | null {
		const parsed = parseBearerToken(authorizationHeader);
		const candidate = parsed ?? DUMMY_CAPABILITY_TOKEN;
		const now = this.#now();
		let matched: OllamaInferenceLease | null = null;
		let comparisons = 0;
		const expired: string[] = [];

		for (const [id, stored] of this.#leases) {
			const matches = verifyToken(candidate, stored.token);
			comparisons++;
			if (stored.lease.expiresAt <= now) expired.push(id);
			else if (matches && parsed) matched = stored.lease;
		}
		if (comparisons === 0) verifyToken(candidate, DUMMY_CAPABILITY_TOKEN);
		for (const id of expired) this.revoke(id);
		return matched;
	}

	#pruneExpired(now: number): void {
		for (const [id, stored] of this.#leases) {
			if (stored.lease.expiresAt <= now) this.revoke(id);
		}
	}

	#uniqueToken(): string {
		for (let attempt = 0; attempt < 4; attempt++) {
			const token = this.#tokenFactory();
			if (!CAPABILITY_TOKEN_PATTERN.test(token)) {
				throw new Error(
					"The Ollama inference token factory returned an invalid token.",
				);
			}
			let duplicate = false;
			for (const stored of this.#leases.values()) {
				duplicate = verifyToken(token, stored.token) || duplicate;
			}
			if (!duplicate) return token;
		}
		throw new Error("Could not allocate a unique Ollama inference token.");
	}
}

export type OllamaInferenceUpstreamFetch = (
	input: string,
	init: RequestInit,
) => Promise<Response>;

export type OllamaLocalModelValidation =
	| boolean
	| Readonly<{
			valid: boolean;
			release: () => void;
			upstreamModel?: string;
	  }>;

export type OllamaInferenceRelayRequestContext = Readonly<{
	/** Raw HTTP origin-form target when the server API makes it available. */
	rawTarget?: string;
}>;

export type OllamaInferenceRelayHandler = (
	request: Request,
	context?: OllamaInferenceRelayRequestContext,
) => Promise<Response>;

export type OllamaInferenceRelayOptions = Readonly<{
	leases: OllamaInferenceLeaseRegistry;
	upstreamFetch?: OllamaInferenceUpstreamFetch;
	validateLocalModels?: (input: {
		lease: OllamaInferenceLease;
		models: readonly string[];
		route: "models" | "chat";
		signal: AbortSignal;
	}) => OllamaLocalModelValidation | Promise<OllamaLocalModelValidation>;
	maxRequestBytes?: number;
	maxModelsResponseBytes?: number;
	maxConcurrent?: number;
	connectTimeoutMs?: number;
	readIdleTimeoutMs?: number;
}>;

type RelayRoute =
	| Readonly<{
			kind: "models";
			method: "GET";
			path: typeof OLLAMA_INFERENCE_MODELS_PATH;
	  }>
	| Readonly<{
			kind: "chat";
			method: "POST";
			path: typeof OLLAMA_INFERENCE_CHAT_PATH;
	  }>;

type UpstreamOperation = Readonly<{
	controller: AbortController;
	abort: Promise<never>;
	addRelease: (release: () => void) => void;
	clientDisconnected: () => boolean;
	finish: () => void;
}>;

class OllamaConnectTimeoutError extends Error {}
class OllamaReadIdleTimeoutError extends Error {}
class OllamaRequestReadIdleTimeoutError extends Error {}
class OllamaModelsResponseTooLargeError extends Error {}
class OllamaClientDisconnectedError extends Error {}
class OllamaLeaseRevokedError extends Error {}

function jsonError(
	status: number,
	error: string,
	headers?: HeadersInit,
): Response {
	const result = new Headers(headers);
	result.set("cache-control", "no-store");
	return Response.json({ error }, { status, headers: result });
}

function requestRawTarget(requestUrl: string): string {
	const scheme = requestUrl.indexOf("://");
	const start = scheme < 0 ? 0 : requestUrl.indexOf("/", scheme + 3);
	return start < 0 ? "/" : requestUrl.slice(start);
}

function resolveRoute(
	request: Request,
	context: OllamaInferenceRelayRequestContext | undefined,
): { route?: RelayRoute; response?: Response } {
	let url: URL;
	try {
		url = new URL(request.url);
	} catch {
		return { response: jsonError(400, "invalid_request_target") };
	}
	const rawTarget = context?.rawTarget ?? requestRawTarget(request.url);
	if (
		!rawTarget.startsWith("/") ||
		rawTarget.startsWith("//") ||
		rawTarget.includes("?") ||
		rawTarget.includes("#") ||
		url.search.length > 0 ||
		url.hash.length > 0 ||
		TRAVERSAL_SYNTAX.test(rawTarget) ||
		rawTarget !== url.pathname
	) {
		return { response: jsonError(400, "invalid_request_target") };
	}

	if (url.pathname === OLLAMA_INFERENCE_MODELS_PATH) {
		if (request.method !== "GET") {
			return {
				response: jsonError(405, "method_not_allowed", { allow: "GET" }),
			};
		}
		return {
			route: {
				kind: "models",
				method: "GET",
				path: OLLAMA_INFERENCE_MODELS_PATH,
			},
		};
	}
	if (url.pathname === OLLAMA_INFERENCE_CHAT_PATH) {
		if (request.method !== "POST") {
			return {
				response: jsonError(405, "method_not_allowed", { allow: "POST" }),
			};
		}
		return {
			route: {
				kind: "chat",
				method: "POST",
				path: OLLAMA_INFERENCE_CHAT_PATH,
			},
		};
	}
	return { response: jsonError(404, "not_found") };
}

function upstreamRequestHeaders(request: Request, route: RelayRoute): Headers {
	const headers = new Headers();
	const accept = request.headers.get("accept");
	if (accept) headers.set("accept", accept);
	headers.set("accept-encoding", "identity");
	if (route.kind === "chat") headers.set("content-type", "application/json");
	return headers;
}

function upstreamResponseHeaders(response: Response): Headers {
	const headers = new Headers();
	for (const [name, value] of response.headers) {
		if (!STRIP_RESPONSE_HEADERS.has(name.toLowerCase())) {
			headers.append(name, value);
		}
	}
	headers.set("cache-control", "no-store");
	return headers;
}

function beginRelayOperation(
	request: Request,
	release: () => void,
	leaseSignal: AbortSignal,
): UpstreamOperation {
	const controller = new AbortController();
	let disconnected = request.signal.aborted;
	let finished = false;
	const releases = [release];
	let rejectAbort: ((reason: unknown) => void) | undefined;
	const abort = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject;
	});
	// Lifecycle cancellation can release capacity while injected validation is
	// still settling. Keep that rejected capability from becoming unhandled.
	void abort.catch(() => {});
	const finish = () => {
		if (finished) return;
		finished = true;
		request.signal.removeEventListener("abort", onClientAbort);
		leaseSignal.removeEventListener("abort", onLeaseAbort);
		for (const finalize of releases.splice(0)) finalize();
	};
	const addRelease = (additional: () => void) => {
		if (finished) additional();
		else releases.push(additional);
	};
	const onClientAbort = () => {
		disconnected = true;
		const reason = new OllamaClientDisconnectedError();
		controller.abort(reason);
		rejectAbort?.(reason);
		finish();
	};
	const onLeaseAbort = () => {
		const reason = new OllamaLeaseRevokedError();
		controller.abort(reason);
		rejectAbort?.(reason);
		finish();
	};
	request.signal.addEventListener("abort", onClientAbort, { once: true });
	leaseSignal.addEventListener("abort", onLeaseAbort, { once: true });
	if (request.signal.aborted) onClientAbort();
	else if (leaseSignal.aborted) onLeaseAbort();

	return {
		controller,
		abort,
		addRelease,
		clientDisconnected: () => disconnected,
		finish,
	};
}

async function fetchUpstream(
	upstreamFetch: OllamaInferenceUpstreamFetch,
	operation: UpstreamOperation,
	route: RelayRoute,
	headers: Headers,
	body: ArrayBuffer | undefined,
	connectTimeoutMs: number,
): Promise<Response> {
	let rejectTimeout: ((reason: unknown) => void) | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		rejectTimeout = reject;
	});
	const timeoutId = setTimeout(() => {
		const error = new OllamaConnectTimeoutError();
		operation.controller.abort(error);
		rejectTimeout?.(error);
	}, connectTimeoutMs);
	timeoutId.unref?.();
	try {
		return await Promise.race([
			upstreamFetch(`${OLLAMA_INFERENCE_UPSTREAM_ORIGIN}${route.path}`, {
				method: route.method,
				headers,
				body,
				redirect: "manual",
				signal: operation.controller.signal,
			}),
			timeout,
			operation.abort,
		]);
	} finally {
		clearTimeout(timeoutId);
	}
}

async function readWithIdleTimeout(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	operation: UpstreamOperation,
	readIdleTimeoutMs: number,
	timeoutError: () => Error = () => new OllamaReadIdleTimeoutError(),
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
	let rejectTimeout: ((reason: unknown) => void) | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		rejectTimeout = reject;
	});
	const timeoutId = setTimeout(() => {
		const error = timeoutError();
		operation.controller.abort(error);
		rejectTimeout?.(error);
	}, readIdleTimeoutMs);
	timeoutId.unref?.();
	try {
		return await Promise.race([reader.read(), timeout, operation.abort]);
	} finally {
		clearTimeout(timeoutId);
	}
}

function streamedUpstreamResponse(
	upstream: Response,
	operation: UpstreamOperation,
	readIdleTimeoutMs: number,
): Response {
	const headers = upstreamResponseHeaders(upstream);
	if (!upstream.body) {
		operation.finish();
		return new Response(null, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers,
		});
	}

	const reader = upstream.body.getReader();
	let closed = false;
	const finish = () => {
		if (closed) return;
		closed = true;
		operation.finish();
	};
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const chunk = await readWithIdleTimeout(
					reader,
					operation,
					readIdleTimeoutMs,
				);
				if (chunk.done) {
					finish();
					controller.close();
					return;
				}
				controller.enqueue(chunk.value);
			} catch (error) {
				operation.controller.abort(error);
				await reader.cancel(error).catch(() => {});
				finish();
				controller.error(new Error("Ollama inference stream unavailable."));
			}
		},
		async cancel(reason) {
			operation.controller.abort(reason);
			await reader.cancel(reason).catch(() => {});
			finish();
		},
	});

	return new Response(body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers,
	});
}

async function readModelsResponse(
	upstream: Response,
	operation: UpstreamOperation,
	maxBytes: number,
	readIdleTimeoutMs: number,
): Promise<Uint8Array> {
	if (!upstream.body) throw new Error("Ollama returned no model inventory.");
	const reader = upstream.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const chunk = await readWithIdleTimeout(
				reader,
				operation,
				readIdleTimeoutMs,
			);
			if (chunk.done) break;
			total += chunk.value.byteLength;
			if (total > maxBytes) {
				throw new OllamaModelsResponseTooLargeError();
			}
			chunks.push(chunk.value);
		}
	} catch (error) {
		operation.controller.abort(error);
		await reader.cancel(error).catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}

	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

function filteredModelsResponse(
	upstream: Response,
	bytes: Uint8Array,
	lease: OllamaInferenceLease,
): Response {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		return jsonError(502, "invalid_upstream_response");
	}
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		!("data" in value) ||
		!Array.isArray(value.data)
	) {
		return jsonError(502, "invalid_upstream_response");
	}
	const allowed = new Set(lease.allowedModels);
	const data = value.data.filter(
		(model): model is Record<string, unknown> =>
			typeof model === "object" &&
			model !== null &&
			!Array.isArray(model) &&
			typeof (model as { id?: unknown }).id === "string" &&
			allowed.has((model as { id: string }).id),
	);
	const headers = upstreamResponseHeaders(upstream);
	headers.set("content-type", "application/json");
	headers.delete("etag");
	headers.delete("last-modified");
	return new Response(JSON.stringify({ ...value, data }), {
		status: upstream.status,
		statusText: upstream.statusText,
		headers,
	});
}

function parseRequestedModel(body: ArrayBuffer): {
	model?: string;
	value?: Record<string, unknown>;
	response?: Response;
} {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
	} catch {
		return { response: jsonError(400, "invalid_json") };
	}
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		typeof (value as { model?: unknown }).model !== "string"
	) {
		return { response: jsonError(400, "invalid_model") };
	}
	const model = (value as { model: string }).model;
	if (
		model.length === 0 ||
		model.length > MAX_MODEL_LENGTH ||
		model !== model.trim() ||
		hasControlCharacter(model)
	) {
		return { response: jsonError(400, "invalid_model") };
	}
	return { model, value: value as Record<string, unknown> };
}

/**
 * Creates the HTTP fetch boundary for the inference-only Ollama relay. The
 * upstream origin is intentionally not configurable; only the injected fetch
 * implementation is replaceable for tests.
 */
export function createOllamaInferenceRelay(
	options: OllamaInferenceRelayOptions,
): OllamaInferenceRelayHandler {
	const upstreamFetch = options.upstreamFetch ?? fetch;
	const maxRequestBytes = validBoundedInteger(
		options.maxRequestBytes ?? OLLAMA_INFERENCE_MAX_REQUEST_BYTES,
		"maxRequestBytes",
	);
	const maxModelsResponseBytes = validBoundedInteger(
		options.maxModelsResponseBytes ??
			OLLAMA_INFERENCE_MAX_MODELS_RESPONSE_BYTES,
		"maxModelsResponseBytes",
	);
	const maxConcurrent = validBoundedInteger(
		options.maxConcurrent ?? OLLAMA_INFERENCE_MAX_CONCURRENT_REQUESTS,
		"maxConcurrent",
	);
	const connectTimeoutMs = validBoundedInteger(
		options.connectTimeoutMs ?? OLLAMA_INFERENCE_CONNECT_TIMEOUT_MS,
		"connectTimeoutMs",
	);
	const readIdleTimeoutMs = validBoundedInteger(
		options.readIdleTimeoutMs ?? OLLAMA_INFERENCE_READ_IDLE_TIMEOUT_MS,
		"readIdleTimeoutMs",
	);
	const gate = createConcurrencyGate(maxConcurrent);

	return async (request, context) => {
		if (request.headers.has("origin") || request.headers.has("cookie")) {
			return jsonError(403, "browser_context_forbidden");
		}
		if (request.headers.has("transfer-encoding")) {
			return jsonError(400, "chunked_body_forbidden");
		}
		if (request.headers.has("content-encoding")) {
			return jsonError(400, "encoded_body_forbidden");
		}

		const resolved = resolveRoute(request, context);
		if (!resolved.route) {
			return resolved.response ?? jsonError(404, "not_found");
		}
		const route = resolved.route;
		const lease = options.leases.authorize(
			request.headers.get("authorization"),
		);
		if (!lease) {
			return jsonError(401, "unauthorized", {
				"www-authenticate": "Bearer",
			});
		}
		const leaseSignal = options.leases.lifecycleSignal(lease.id);
		if (!leaseSignal || leaseSignal.aborted) {
			return jsonError(401, "unauthorized", {
				"www-authenticate": "Bearer",
			});
		}
		if (route.kind === "models" && request.body) {
			return jsonError(400, "body_not_allowed");
		}
		if (
			route.kind === "chat" &&
			!JSON_CONTENT_TYPE.test(request.headers.get("content-type") ?? "")
		) {
			return jsonError(415, "json_content_type_required");
		}

		const release = gate.tryEnter();
		if (!release) {
			return jsonError(429, "relay_capacity_reached", { "retry-after": "1" });
		}
		const operation = beginRelayOperation(request, release, leaseSignal);

		let body: ArrayBuffer | undefined;
		let chatValue: Record<string, unknown> | undefined;
		let requestedModels: readonly string[] = lease.allowedModels;
		if (route.kind === "chat") {
			try {
				const limited = await readRequestBodyLimited(request, maxRequestBytes, {
					readChunk: (reader) =>
						readWithIdleTimeout(
							reader,
							operation,
							readIdleTimeoutMs,
							() => new OllamaRequestReadIdleTimeoutError(),
						),
				});
				if (!limited.ok) {
					operation.finish();
					return limited.response;
				}
				body = limited.body;
			} catch (error) {
				operation.finish();
				if (
					error instanceof OllamaClientDisconnectedError ||
					request.signal.aborted
				) {
					return jsonError(499, "client_disconnected");
				}
				if (error instanceof OllamaLeaseRevokedError || leaseSignal.aborted) {
					return jsonError(401, "unauthorized", {
						"www-authenticate": "Bearer",
					});
				}
				if (error instanceof OllamaRequestReadIdleTimeoutError) {
					return jsonError(408, "request_body_timeout");
				}
				return jsonError(499, "client_disconnected");
			}
			const requested = parseRequestedModel(body);
			if (!requested.model) {
				operation.finish();
				return requested.response ?? jsonError(400, "invalid_model");
			}
			if (!lease.allowedModels.includes(requested.model)) {
				operation.finish();
				return jsonError(403, "model_not_allowed");
			}
			requestedModels = [requested.model];
			chatValue = requested.value;
		}

		let upstreamModel: string | undefined;
		if (options.validateLocalModels) {
			try {
				const validation = Promise.resolve(
					options.validateLocalModels({
						lease,
						models: requestedModels,
						route: route.kind,
						signal: AbortSignal.any([request.signal, leaseSignal]),
					}),
				).then((result) => {
					if (typeof result === "boolean") return result;
					operation.addRelease(result.release);
					upstreamModel = result.upstreamModel;
					return result.valid;
				});
				const valid = await Promise.race([validation, operation.abort]);
				if (request.signal.aborted) {
					operation.finish();
					return jsonError(499, "client_disconnected");
				}
				if (leaseSignal.aborted) {
					operation.finish();
					return jsonError(401, "unauthorized", {
						"www-authenticate": "Bearer",
					});
				}
				if (!valid) {
					operation.finish();
					return jsonError(409, "local_model_evidence_changed");
				}
			} catch {
				operation.finish();
				if (request.signal.aborted) {
					return jsonError(499, "client_disconnected");
				}
				if (leaseSignal.aborted) {
					return jsonError(401, "unauthorized", {
						"www-authenticate": "Bearer",
					});
				}
				return jsonError(503, "local_model_verification_unavailable");
			}
		}
		if (route.kind === "chat" && upstreamModel && chatValue) {
			body = new TextEncoder().encode(
				JSON.stringify({ ...chatValue, model: upstreamModel }),
			).buffer;
			if (body.byteLength > maxRequestBytes) {
				operation.finish();
				return payloadTooLarge(maxRequestBytes);
			}
		}

		let upstream: Response;
		try {
			upstream = await fetchUpstream(
				upstreamFetch,
				operation,
				route,
				upstreamRequestHeaders(request, route),
				body,
				connectTimeoutMs,
			);
		} catch (error) {
			operation.finish();
			if (
				error instanceof OllamaClientDisconnectedError ||
				operation.clientDisconnected()
			) {
				return jsonError(499, "client_disconnected");
			}
			if (error instanceof OllamaConnectTimeoutError) {
				return jsonError(504, "upstream_timeout");
			}
			if (error instanceof OllamaLeaseRevokedError) {
				return jsonError(401, "unauthorized", {
					"www-authenticate": "Bearer",
				});
			}
			return jsonError(502, "upstream_unavailable");
		}

		if (route.kind === "chat" || !upstream.ok) {
			return streamedUpstreamResponse(upstream, operation, readIdleTimeoutMs);
		}

		try {
			const bytes = await readModelsResponse(
				upstream,
				operation,
				maxModelsResponseBytes,
				readIdleTimeoutMs,
			);
			return filteredModelsResponse(upstream, bytes, lease);
		} catch (error) {
			if (
				error instanceof OllamaClientDisconnectedError ||
				operation.clientDisconnected()
			) {
				return jsonError(499, "client_disconnected");
			}
			if (error instanceof OllamaReadIdleTimeoutError) {
				return jsonError(504, "upstream_timeout");
			}
			if (error instanceof OllamaLeaseRevokedError) {
				return jsonError(401, "unauthorized", {
					"www-authenticate": "Bearer",
				});
			}
			return jsonError(502, "invalid_upstream_response");
		} finally {
			operation.finish();
		}
	};
}
