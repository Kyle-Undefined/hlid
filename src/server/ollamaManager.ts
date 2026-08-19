import { OLLAMA_MAX_CONTEXT_LENGTH } from "../lib/ollama";

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_LOAD_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_PULL_TIMEOUT_MS = 6 * 60 * 60_000;
const DEFAULT_MAX_JSON_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_PULL_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_PULL_LINE_BYTES = 64 * 1024;
const MAX_MODEL_NAME_BYTES = 512;
const MAX_VERSION_BYTES = 256;
const MAX_MODELS = 10_000;

export type OllamaFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export type OllamaClock = {
	now: () => number;
	timeoutSignal: (timeoutMs: number) => AbortSignal;
};

export type OllamaClientErrorCode =
	| "aborted"
	| "http"
	| "invalid-response"
	| "remote-model"
	| "response-too-large"
	| "timeout"
	| "unavailable";

/**
 * A deliberately body-free Ollama error. Server response bodies are never
 * copied into errors because they may contain prompts or other private data.
 */
export class OllamaClientError extends Error {
	readonly code: OllamaClientErrorCode;
	readonly operation: string;
	readonly status: number | null;

	constructor(
		code: OllamaClientErrorCode,
		operation: string,
		message: string,
		status: number | null = null,
	) {
		super(message);
		this.name = "OllamaClientError";
		this.code = code;
		this.operation = operation;
		this.status = status;
	}
}

export type OllamaStatus =
	| {
			available: true;
			checkedAt: number;
			version: string;
	  }
	| {
			available: false;
			checkedAt: number;
			reason: OllamaClientErrorCode;
			version: null;
	  };

export type OllamaModelMetadata = {
	contextLength: number | null;
	families: string[];
	family: string | null;
	format: string | null;
	parameterSize: string | null;
	parentModel: string | null;
	quantizationLevel: string | null;
};

export type OllamaLocalModel = {
	capabilities: string[];
	details: OllamaModelMetadata;
	digest: string;
	model: string;
	modifiedAt: string | null;
	name: string;
	size: number;
};

export type OllamaModelDetails = {
	capabilities: string[];
	contextLength: number | null;
	details: OllamaModelMetadata;
	model: string;
	modifiedAt: string | null;
	requires: string | null;
};

export type OllamaLoadedModel = {
	contextLength: number;
	details: OllamaModelMetadata;
	digest: string;
	expiresAt: string | null;
	model: string;
	name: string;
	size: number;
	sizeVram: number;
};

export type OllamaPullProgress = {
	completed: number | null;
	digest: string | null;
	percent: number | null;
	receivedAt: number;
	status: string;
	total: number | null;
};

export type OllamaPullResult = {
	completed: number | null;
	completedAt: number;
	events: number;
	model: string;
	total: number | null;
};

export type OllamaModelLoadResult = {
	keepAlive: number | string;
	model: string;
	numCtx?: number;
};

export type OllamaRequestOptions = {
	signal?: AbortSignal;
};

export type OllamaPullOptions = OllamaRequestOptions & {
	onProgress?: (progress: OllamaPullProgress) => Promise<void> | void;
};

export type OllamaLoadOptions = OllamaRequestOptions & {
	keepAlive?: number | string;
	/** Native Ollama context allocation, forwarded as `options.num_ctx`. */
	numCtx?: number;
};

export type OllamaManagerOptions = {
	baseUrl?: string;
	clock?: OllamaClock;
	fetch?: OllamaFetch;
	loadTimeoutMs?: number;
	maxJsonBytes?: number;
	maxPullBytes?: number;
	maxPullLineBytes?: number;
	pullTimeoutMs?: number;
	requestTimeoutMs?: number;
};

type RequestContext = {
	externalSignal: AbortSignal | undefined;
	operation: string;
	response: Response;
	timeoutSignal: AbortSignal;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveLimit(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error("Ollama safety limits must be positive integers");
	}
	return value;
}

function optionalString(value: unknown, maxBytes = 4_096): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed || Buffer.byteLength(trimmed, "utf8") > maxBytes) return null;
	return trimmed;
}

function requiredString(
	value: unknown,
	field: string,
	operation: string,
	maxBytes = 4_096,
): string {
	const parsed = optionalString(value, maxBytes);
	if (parsed) return parsed;
	throw invalidResponse(operation, `Ollama returned an invalid ${field}`);
}

function optionalNonNegativeInteger(value: unknown): number | null {
	return Number.isSafeInteger(value) && Number(value) >= 0
		? Number(value)
		: null;
}

function requiredNonNegativeInteger(
	value: unknown,
	field: string,
	operation: string,
): number {
	const parsed = optionalNonNegativeInteger(value);
	if (parsed !== null) return parsed;
	throw invalidResponse(operation, `Ollama returned an invalid ${field}`);
}

function stringArray(value: unknown, maxItems = 1_000): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.slice(0, maxItems)
		.map((entry) => optionalString(entry, 512))
		.filter((entry): entry is string => entry !== null);
}

function invalidResponse(
	operation: string,
	message: string,
): OllamaClientError {
	return new OllamaClientError("invalid-response", operation, message);
}

function remoteEvidence(value: Record<string, unknown>): boolean {
	return (
		optionalString(value.remote_model, 2_048) !== null ||
		optionalString(value.remote_host, 2_048) !== null
	);
}

function parseMetadata(value: unknown): OllamaModelMetadata {
	const details = isRecord(value) ? value : {};
	return {
		contextLength: optionalNonNegativeInteger(details.context_length),
		families: stringArray(details.families),
		family: optionalString(details.family, 512),
		format: optionalString(details.format, 512),
		parameterSize: optionalString(details.parameter_size, 512),
		parentModel: optionalString(details.parent_model, 512),
		quantizationLevel: optionalString(details.quantization_level, 512),
	};
}

function contextLengthFromModelInfo(value: unknown): number | null {
	if (!isRecord(value)) return null;
	let largest: number | null = null;
	for (const [key, entry] of Object.entries(value)) {
		if (key !== "context_length" && !key.endsWith(".context_length")) continue;
		const length = optionalNonNegativeInteger(entry);
		if (
			length !== null &&
			length > 0 &&
			(largest === null || length > largest)
		) {
			largest = length;
		}
	}
	return largest;
}

function parseLocalModel(
	value: unknown,
	operation: string,
): OllamaLocalModel | null {
	if (!isRecord(value))
		throw invalidResponse(operation, "Ollama returned an invalid model");
	if (remoteEvidence(value)) return null;
	return {
		capabilities: stringArray(value.capabilities),
		details: parseMetadata(value.details),
		digest: requiredString(value.digest, "model digest", operation, 512),
		model: requiredString(
			value.model,
			"model id",
			operation,
			MAX_MODEL_NAME_BYTES,
		),
		modifiedAt: optionalString(value.modified_at, 256),
		name: requiredString(
			value.name,
			"model name",
			operation,
			MAX_MODEL_NAME_BYTES,
		),
		size: requiredNonNegativeInteger(value.size, "model size", operation),
	};
}

function parseLoadedModel(
	value: unknown,
	operation: string,
): OllamaLoadedModel {
	if (!isRecord(value)) {
		throw invalidResponse(operation, "Ollama returned an invalid loaded model");
	}
	return {
		contextLength: requiredNonNegativeInteger(
			value.context_length,
			"loaded context length",
			operation,
		),
		details: parseMetadata(value.details),
		digest: requiredString(value.digest, "loaded model digest", operation, 512),
		expiresAt: optionalString(value.expires_at, 256),
		model: requiredString(
			value.model,
			"loaded model id",
			operation,
			MAX_MODEL_NAME_BYTES,
		),
		name: requiredString(
			value.name,
			"loaded model name",
			operation,
			MAX_MODEL_NAME_BYTES,
		),
		size: requiredNonNegativeInteger(
			value.size,
			"loaded model size",
			operation,
		),
		sizeVram: requiredNonNegativeInteger(
			value.size_vram,
			"loaded VRAM size",
			operation,
		),
	};
}

function validateModelName(model: string): string {
	const normalized = model.trim();
	if (
		!normalized ||
		Buffer.byteLength(normalized, "utf8") > MAX_MODEL_NAME_BYTES ||
		[...normalized].some((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code < 0x20 || code === 0x7f;
		})
	) {
		throw new Error("Ollama model name is invalid");
	}
	return normalized;
}

function validateKeepAlive(value: number | string): number | string {
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value)) {
			throw new Error(
				"Ollama keep-alive must be an integer or duration string",
			);
		}
		return value;
	}
	const normalized = value.trim();
	if (!normalized || Buffer.byteLength(normalized, "utf8") > 64) {
		throw new Error("Ollama keep-alive must be an integer or duration string");
	}
	return normalized;
}

function validateContextLength(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (
		!Number.isSafeInteger(value) ||
		value <= 0 ||
		value > OLLAMA_MAX_CONTEXT_LENGTH
	) {
		throw new Error(
			`Ollama context length must be a positive integer no greater than ${OLLAMA_MAX_CONTEXT_LENGTH.toLocaleString()}`,
		);
	}
	return value;
}

export function normalizeOllamaLoopbackBaseUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Ollama base URL is invalid");
	}
	if (
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	) {
		throw new Error("Ollama must use a Windows IPv4 loopback URL");
	}
	return url.origin;
}

function systemClock(): OllamaClock {
	return {
		now: Date.now,
		timeoutSignal: (timeoutMs) => AbortSignal.timeout(timeoutMs),
	};
}

function requestSignal(
	timeoutSignal: AbortSignal,
	externalSignal: AbortSignal | undefined,
): AbortSignal {
	return externalSignal
		? AbortSignal.any([externalSignal, timeoutSignal])
		: timeoutSignal;
}

function normalizedRequestError(
	error: unknown,
	operation: string,
	externalSignal: AbortSignal | undefined,
	timeoutSignal: AbortSignal,
): Error {
	if (error instanceof OllamaClientError) return error;
	if (externalSignal?.aborted) {
		return new OllamaClientError(
			"aborted",
			operation,
			"Ollama request aborted",
		);
	}
	if (timeoutSignal.aborted) {
		return new OllamaClientError(
			"timeout",
			operation,
			"Ollama request timed out",
		);
	}
	return new OllamaClientError(
		"unavailable",
		operation,
		"Ollama is unavailable on Windows",
	);
}

async function cancelResponse(response: Response): Promise<void> {
	await response.body?.cancel().catch(() => {});
}

async function assertBoundedContentLength(
	context: RequestContext,
	maxBytes: number,
	tooLargeMessage: string,
): Promise<void> {
	const rawContentLength = context.response.headers.get("content-length");
	if (!rawContentLength) return;
	const contentLength = Number(rawContentLength);
	if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
		await cancelResponse(context.response);
		throw invalidResponse(
			context.operation,
			"Ollama returned an invalid content length",
		);
	}
	if (contentLength > maxBytes) {
		await cancelResponse(context.response);
		throw new OllamaClientError(
			"response-too-large",
			context.operation,
			tooLargeMessage,
		);
	}
}

async function readBoundedText(
	context: RequestContext,
	maxBytes: number,
): Promise<string> {
	await assertBoundedContentLength(
		context,
		maxBytes,
		"Ollama response exceeded the safety limit",
	);
	if (!context.response.body) {
		throw invalidResponse(
			context.operation,
			"Ollama returned an empty response",
		);
	}
	const reader = context.response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let bytes = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) {
				throw new OllamaClientError(
					"response-too-large",
					context.operation,
					"Ollama response exceeded the safety limit",
				);
			}
			try {
				text += decoder.decode(value, { stream: true });
			} catch {
				throw invalidResponse(
					context.operation,
					"Ollama returned invalid UTF-8",
				);
			}
		}
		try {
			text += decoder.decode();
		} catch {
			throw invalidResponse(context.operation, "Ollama returned invalid UTF-8");
		}
		return text;
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw normalizedRequestError(
			error,
			context.operation,
			context.externalSignal,
			context.timeoutSignal,
		);
	}
}

async function readBoundedJson(
	context: RequestContext,
	maxBytes: number,
): Promise<unknown> {
	const text = await readBoundedText(context, maxBytes);
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw invalidResponse(context.operation, "Ollama returned invalid JSON");
	}
}

function jsonHeaders(): HeadersInit {
	return {
		accept: "application/json",
		"content-type": "application/json",
	};
}

/**
 * Windows-loopback Ollama API manager. It does not start processes, expose a
 * network listener, mutate OpenCode configuration, or log request/response
 * data. Those responsibilities belong to later integration layers.
 */
export class OllamaManager {
	readonly baseUrl: string;

	private readonly clock: OllamaClock;
	private readonly fetchFn: OllamaFetch;
	private readonly loadTimeoutMs: number;
	private readonly maxJsonBytes: number;
	private readonly maxPullBytes: number;
	private readonly maxPullLineBytes: number;
	private readonly pullTimeoutMs: number;
	private readonly requestTimeoutMs: number;

	constructor(options: OllamaManagerOptions = {}) {
		this.baseUrl = normalizeOllamaLoopbackBaseUrl(
			options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL,
		);
		this.clock = options.clock ?? systemClock();
		this.fetchFn = options.fetch ?? fetch;
		this.loadTimeoutMs = positiveLimit(
			options.loadTimeoutMs,
			DEFAULT_LOAD_TIMEOUT_MS,
		);
		this.maxJsonBytes = positiveLimit(
			options.maxJsonBytes,
			DEFAULT_MAX_JSON_BYTES,
		);
		this.maxPullBytes = positiveLimit(
			options.maxPullBytes,
			DEFAULT_MAX_PULL_BYTES,
		);
		this.maxPullLineBytes = positiveLimit(
			options.maxPullLineBytes,
			DEFAULT_MAX_PULL_LINE_BYTES,
		);
		if (this.maxPullLineBytes > this.maxPullBytes) {
			throw new Error(
				"Ollama pull line limit cannot exceed its response limit",
			);
		}
		this.pullTimeoutMs = positiveLimit(
			options.pullTimeoutMs,
			DEFAULT_PULL_TIMEOUT_MS,
		);
		this.requestTimeoutMs = positiveLimit(
			options.requestTimeoutMs,
			DEFAULT_REQUEST_TIMEOUT_MS,
		);
	}

	private async request(
		operation: string,
		path: string,
		init: RequestInit,
		timeoutMs: number,
		externalSignal?: AbortSignal,
	): Promise<RequestContext> {
		const timeoutSignal = this.clock.timeoutSignal(timeoutMs);
		try {
			if (externalSignal?.aborted) {
				throw new OllamaClientError(
					"aborted",
					operation,
					"Ollama request aborted",
				);
			}
			const response = await this.fetchFn(`${this.baseUrl}${path}`, {
				...init,
				signal: requestSignal(timeoutSignal, externalSignal),
			});
			if (!response.ok) {
				await cancelResponse(response);
				throw new OllamaClientError(
					"http",
					operation,
					`Ollama returned HTTP ${response.status}`,
					response.status,
				);
			}
			return { externalSignal, operation, response, timeoutSignal };
		} catch (error) {
			throw normalizedRequestError(
				error,
				operation,
				externalSignal,
				timeoutSignal,
			);
		}
	}

	private async getJson(
		operation: string,
		path: string,
		signal?: AbortSignal,
	): Promise<unknown> {
		const context = await this.request(
			operation,
			path,
			{ headers: { accept: "application/json" }, method: "GET" },
			this.requestTimeoutMs,
			signal,
		);
		return readBoundedJson(context, this.maxJsonBytes);
	}

	async getStatus(options: OllamaRequestOptions = {}): Promise<OllamaStatus> {
		const checkedAt = this.clock.now();
		try {
			return {
				available: true,
				checkedAt,
				version: await this.getVersion(options),
			};
		} catch (error) {
			if (options.signal?.aborted) throw error;
			return {
				available: false,
				checkedAt,
				reason: error instanceof OllamaClientError ? error.code : "unavailable",
				version: null,
			};
		}
	}

	async getVersion(options: OllamaRequestOptions = {}): Promise<string> {
		const operation = "get version";
		const body = await this.getJson(operation, "/api/version", options.signal);
		if (!isRecord(body)) {
			throw invalidResponse(operation, "Ollama returned an invalid version");
		}
		return requiredString(
			body.version,
			"version",
			operation,
			MAX_VERSION_BYTES,
		);
	}

	async listLocalModels(
		options: OllamaRequestOptions = {},
	): Promise<OllamaLocalModel[]> {
		const operation = "list local models";
		const body = await this.getJson(operation, "/api/tags", options.signal);
		if (!isRecord(body) || !Array.isArray(body.models)) {
			throw invalidResponse(operation, "Ollama returned an invalid model list");
		}
		if (body.models.length > MAX_MODELS) {
			throw new OllamaClientError(
				"response-too-large",
				operation,
				"Ollama returned too many models",
			);
		}
		return body.models
			.map((model) => parseLocalModel(model, operation))
			.filter((model): model is OllamaLocalModel => model !== null);
	}

	async showModel(
		model: string,
		options: OllamaRequestOptions = {},
	): Promise<OllamaModelDetails> {
		const normalizedModel = validateModelName(model);
		const operation = "show model";
		const context = await this.request(
			operation,
			"/api/show",
			{
				body: JSON.stringify({ model: normalizedModel, verbose: false }),
				headers: jsonHeaders(),
				method: "POST",
			},
			this.requestTimeoutMs,
			options.signal,
		);
		const body = await readBoundedJson(context, this.maxJsonBytes);
		if (!isRecord(body)) {
			throw invalidResponse(operation, "Ollama returned invalid model details");
		}
		if (remoteEvidence(body)) {
			throw new OllamaClientError(
				"remote-model",
				operation,
				"Ollama reported a cloud-backed model",
			);
		}
		const details = parseMetadata(body.details);
		return {
			capabilities: stringArray(body.capabilities),
			contextLength:
				details.contextLength ?? contextLengthFromModelInfo(body.model_info),
			details,
			model: normalizedModel,
			modifiedAt: optionalString(body.modified_at, 256),
			requires: optionalString(body.requires, 512),
		};
	}

	async listLoadedModels(
		options: OllamaRequestOptions = {},
	): Promise<OllamaLoadedModel[]> {
		const operation = "list loaded models";
		const body = await this.getJson(operation, "/api/ps", options.signal);
		if (!isRecord(body) || !Array.isArray(body.models)) {
			throw invalidResponse(
				operation,
				"Ollama returned an invalid process list",
			);
		}
		if (body.models.length > MAX_MODELS) {
			throw new OllamaClientError(
				"response-too-large",
				operation,
				"Ollama returned too many loaded models",
			);
		}
		return body.models.map((model) => parseLoadedModel(model, operation));
	}

	async pullModel(
		model: string,
		options: OllamaPullOptions = {},
	): Promise<OllamaPullResult> {
		const normalizedModel = validateModelName(model);
		const operation = "pull model";
		const context = await this.request(
			operation,
			"/api/pull",
			{
				body: JSON.stringify({ model: normalizedModel, stream: true }),
				headers: {
					accept: "application/x-ndjson, application/json",
					"content-type": "application/json",
				},
				method: "POST",
			},
			this.pullTimeoutMs,
			options.signal,
		);
		return this.readPullStream(normalizedModel, context, options.onProgress);
	}

	private async readPullStream(
		model: string,
		context: RequestContext,
		onProgress: OllamaPullOptions["onProgress"],
	): Promise<OllamaPullResult> {
		await assertBoundedContentLength(
			context,
			this.maxPullBytes,
			"Ollama pull response exceeded the safety limit",
		);
		if (!context.response.body) {
			throw invalidResponse(
				context.operation,
				"Ollama returned an empty pull stream",
			);
		}
		const reader = context.response.body.getReader();
		const decoder = new TextDecoder("utf-8", { fatal: true });
		let buffer = "";
		let bytes = 0;
		let events = 0;
		let lastCompleted: number | null = null;
		let lastTotal: number | null = null;
		let succeeded = false;

		const consumeLine = async (rawLine: string): Promise<void> => {
			const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
			if (!line.trim()) return;
			if (Buffer.byteLength(line, "utf8") > this.maxPullLineBytes) {
				throw new OllamaClientError(
					"response-too-large",
					context.operation,
					"Ollama pull progress line exceeded the safety limit",
				);
			}
			let value: unknown;
			try {
				value = JSON.parse(line) as unknown;
			} catch {
				throw invalidResponse(
					context.operation,
					"Ollama returned invalid pull progress",
				);
			}
			if (!isRecord(value) || optionalString(value.error) !== null) {
				throw invalidResponse(
					context.operation,
					"Ollama pull did not return usable progress",
				);
			}
			const status = requiredString(
				value.status,
				"pull status",
				context.operation,
				512,
			);
			const completed = optionalNonNegativeInteger(value.completed);
			const total = optionalNonNegativeInteger(value.total);
			if (value.completed !== undefined && completed === null) {
				throw invalidResponse(
					context.operation,
					"Ollama returned invalid pull progress",
				);
			}
			if (value.total !== undefined && total === null) {
				throw invalidResponse(
					context.operation,
					"Ollama returned invalid pull progress",
				);
			}
			if (completed !== null) lastCompleted = completed;
			if (total !== null) lastTotal = total;
			succeeded = status === "success";
			const progress: OllamaPullProgress = {
				completed,
				digest: optionalString(value.digest, 512),
				percent:
					completed !== null && total !== null && total > 0
						? Math.min(completed / total, 1)
						: null,
				receivedAt: this.clock.now(),
				status,
				total,
			};
			events += 1;
			await onProgress?.(progress);
		};

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				bytes += value.byteLength;
				if (bytes > this.maxPullBytes) {
					throw new OllamaClientError(
						"response-too-large",
						context.operation,
						"Ollama pull response exceeded the safety limit",
					);
				}
				try {
					buffer += decoder.decode(value, { stream: true });
				} catch {
					throw invalidResponse(
						context.operation,
						"Ollama returned invalid UTF-8",
					);
				}
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					await consumeLine(line);
					newline = buffer.indexOf("\n");
				}
				if (Buffer.byteLength(buffer, "utf8") > this.maxPullLineBytes) {
					throw new OllamaClientError(
						"response-too-large",
						context.operation,
						"Ollama pull progress line exceeded the safety limit",
					);
				}
			}
			try {
				buffer += decoder.decode();
			} catch {
				throw invalidResponse(
					context.operation,
					"Ollama returned invalid UTF-8",
				);
			}
			await consumeLine(buffer);
			if (events === 0 || !succeeded) {
				throw invalidResponse(
					context.operation,
					"Ollama pull stream ended before success",
				);
			}
			return {
				completed: lastCompleted,
				completedAt: this.clock.now(),
				events,
				model,
				total: lastTotal,
			};
		} catch (error) {
			await reader.cancel().catch(() => {});
			if (error instanceof OllamaClientError) throw error;
			if (context.externalSignal?.aborted || context.timeoutSignal.aborted) {
				throw normalizedRequestError(
					error,
					context.operation,
					context.externalSignal,
					context.timeoutSignal,
				);
			}
			// Callback failures are caller errors rather than Ollama transport errors.
			throw error;
		}
	}

	async deleteModel(
		model: string,
		options: OllamaRequestOptions = {},
	): Promise<void> {
		const normalizedModel = validateModelName(model);
		const context = await this.request(
			"delete model",
			"/api/delete",
			{
				body: JSON.stringify({ model: normalizedModel }),
				headers: jsonHeaders(),
				method: "DELETE",
			},
			this.requestTimeoutMs,
			options.signal,
		);
		await cancelResponse(context.response);
	}

	async createContextModel(
		model: string,
		from: string,
		numCtx: number,
		options: OllamaRequestOptions = {},
	): Promise<void> {
		const normalizedModel = validateModelName(model);
		const normalizedFrom = validateModelName(from);
		validateContextLength(numCtx);
		// Creating from a cloud-backed alias could fetch or retain remote state.
		await this.showModel(normalizedFrom, { signal: options.signal });

		const operation = "create context model";
		const context = await this.request(
			operation,
			"/api/create",
			{
				body: JSON.stringify({
					from: normalizedFrom,
					model: normalizedModel,
					parameters: { num_ctx: numCtx },
					stream: false,
				}),
				headers: jsonHeaders(),
				method: "POST",
			},
			this.loadTimeoutMs,
			options.signal,
		);
		const body = await readBoundedJson(context, this.maxJsonBytes);
		if (!isRecord(body) || body.status !== "success") {
			throw invalidResponse(
				operation,
				"Ollama did not complete the model creation",
			);
		}
		if (remoteEvidence(body)) {
			throw new OllamaClientError(
				"remote-model",
				operation,
				"Ollama reported a cloud-backed model",
			);
		}
	}

	async loadModel(
		model: string,
		options: OllamaLoadOptions = {},
	): Promise<OllamaModelLoadResult> {
		const keepAlive = validateKeepAlive(options.keepAlive ?? -1);
		const numCtx = validateContextLength(options.numCtx);
		return this.setLoadedState(model, keepAlive, options.signal, numCtx);
	}

	async unloadModel(
		model: string,
		options: OllamaRequestOptions = {},
	): Promise<OllamaModelLoadResult> {
		return this.setLoadedState(model, 0, options.signal);
	}

	private async setLoadedState(
		model: string,
		keepAlive: number | string,
		signal?: AbortSignal,
		numCtx?: number,
	): Promise<OllamaModelLoadResult> {
		const normalizedModel = validateModelName(model);
		// Do not accidentally invoke a cloud-backed alias through /api/generate.
		await this.showModel(normalizedModel, { signal });
		const operation = keepAlive === 0 ? "unload model" : "load model";
		const context = await this.request(
			operation,
			"/api/generate",
			{
				body: JSON.stringify({
					keep_alive: keepAlive,
					model: normalizedModel,
					...(numCtx !== undefined ? { options: { num_ctx: numCtx } } : {}),
					prompt: "",
					stream: false,
				}),
				headers: jsonHeaders(),
				method: "POST",
			},
			this.loadTimeoutMs,
			signal,
		);
		const body = await readBoundedJson(context, this.maxJsonBytes);
		if (!isRecord(body) || body.done !== true) {
			throw invalidResponse(
				operation,
				"Ollama did not complete the model request",
			);
		}
		if (remoteEvidence(body)) {
			throw new OllamaClientError(
				"remote-model",
				operation,
				"Ollama reported a cloud-backed model",
			);
		}
		return {
			keepAlive,
			model: normalizedModel,
			...(numCtx !== undefined ? { numCtx } : {}),
		};
	}
}
