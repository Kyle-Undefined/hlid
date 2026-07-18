import { safeRequestPath } from "../lib/httpDiagnostics";

const DEFAULT_SLOW_REQUEST_MS = 1_000;
const DEFAULT_DEDUPE_MS = 30_000;
const MAX_DIAGNOSTIC_KEYS = 200;
const MAX_ERROR_SUMMARY_CHARS = 400;
const REQUEST_ID_HEADER = "x-hlid-request-id";

type DiagnosticLevel = "warn" | "error";
type DiagnosticLogger = (level: DiagnosticLevel, message: string) => void;
type SlowRequestThreshold = number | ((request: Request) => number | undefined);

export type RequestObserverOptions = {
	scope: string;
	slowRequestMs?: SlowRequestThreshold;
	/** Optional allowlisted operation label, such as a generated server-fn name. */
	requestName?: (request: Request) => string | undefined;
	dedupeMs?: number;
	reportServerErrors?: boolean;
	now?: () => number;
	log?: DiagnosticLogger;
};

function defaultLogger(level: DiagnosticLevel, message: string): void {
	if (level === "error") console.error(message);
	else console.warn(message);
}

function stripControlCharacters(value: string): string {
	let result = "";
	for (const character of value) {
		const code = character.charCodeAt(0);
		result += code < 32 || code === 127 ? " " : character;
	}
	return result;
}

/** Remove paths, URLs, IDs, control characters, and excessive detail. */
export function safeErrorSummary(error: unknown): string {
	const record =
		error && typeof error === "object"
			? (error as Record<string, unknown>)
			: undefined;
	const name =
		error instanceof Error
			? error.name
			: typeof record?.name === "string"
				? record.name
				: "Error";
	const message =
		error instanceof Error
			? error.message
			: typeof record?.message === "string"
				? record.message
				: typeof error === "string"
					? error
					: "request handler failed";
	return stripControlCharacters(`${name}: ${message}`)
		.replace(/https?:\/\/\S+/gi, "<url>")
		.replace(/(?:[A-Za-z]:\\|\\\\)[^\s"']+/g, "<path>")
		.replace(/\/(?:home|Users|mnt\/c\/Users|tmp)\/[^\s"']+/g, "<path>")
		.replace(
			/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
			"<id>",
		)
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_ERROR_SUMMARY_CHARS);
}

function safeRequestId(request: Request): string | null {
	const value = request.headers.get(REQUEST_ID_HEADER)?.trim();
	if (!value || !/^[A-Za-z0-9-]{8,64}$/.test(value)) return null;
	return value.slice(0, 12);
}

function safeRequestName(value: string | undefined): string | null {
	if (!value || !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value)) return null;
	return value;
}

function requestLabels(
	request: Request,
	requestName?: (request: Request) => string | undefined,
): {
	label: string;
	signature: string;
} {
	const method = request.method.toUpperCase().slice(0, 12);
	const route = safeRequestPath(request);
	const requestId = safeRequestId(request);
	let operation: string | null = null;
	try {
		operation = safeRequestName(requestName?.(request));
	} catch {
		// Diagnostics must never interfere with request handling.
	}
	const signature = `${method} ${route}${operation ? ` server-fn=${operation}` : ""}`;
	return {
		label: `${signature}${requestId ? ` request ${requestId}` : ""}`,
		signature,
	};
}

/**
 * Observe a request without retaining query values or bodies. Slow and failed
 * signatures are deduplicated so one unhealthy route cannot evict the log.
 */
export function createRequestObserver(options: RequestObserverOptions) {
	const now = options.now ?? (() => performance.now());
	const log = options.log ?? defaultLogger;
	const dedupeMs = options.dedupeMs ?? DEFAULT_DEDUPE_MS;
	const reportServerErrors = options.reportServerErrors ?? true;
	const lastReported = new Map<string, number>();

	const report = (
		key: string,
		level: DiagnosticLevel,
		message: string,
	): void => {
		const at = now();
		const previous = lastReported.get(key);
		if (previous !== undefined && at - previous < dedupeMs) return;
		if (lastReported.size >= MAX_DIAGNOSTIC_KEYS) lastReported.clear();
		lastReported.set(key, at);
		log(level, message);
	};

	return async function observe<T extends Response | undefined>(
		request: Request,
		handle: () => Promise<T> | T,
	): Promise<T> {
		const startedAt = now();
		const { label, signature } = requestLabels(request, options.requestName);
		try {
			const response = await handle();
			const elapsedMs = Math.max(0, Math.round(now() - startedAt));
			if (response && reportServerErrors && response.status >= 500) {
				report(
					`status:${signature}:${response.status}`,
					"error",
					`[${options.scope}] ${label} returned ${response.status} after ${elapsedMs}ms`,
				);
				return response;
			}
			const configuredThreshold = options.slowRequestMs;
			const threshold =
				typeof configuredThreshold === "function"
					? configuredThreshold(request)
					: (configuredThreshold ?? DEFAULT_SLOW_REQUEST_MS);
			if (threshold !== undefined && elapsedMs >= threshold) {
				report(
					`slow:${signature}:${response?.status ?? "none"}`,
					"warn",
					`[${options.scope}] ${label} completed in ${elapsedMs}ms${response ? ` with ${response.status}` : ""}`,
				);
			}
			return response;
		} catch (error) {
			const elapsedMs = Math.max(0, Math.round(now() - startedAt));
			const summary = safeErrorSummary(error);
			report(
				`throw:${signature}:${summary}`,
				"error",
				`[${options.scope}] ${label} failed after ${elapsedMs}ms: ${summary}`,
			);
			throw error;
		}
	};
}

export type EventLoopLagMonitorOptions = {
	intervalMs?: number;
	warningThresholdMs?: number;
	cooldownMs?: number;
	maxReportableLagMs?: number;
	now?: () => number;
	log?: (message: string) => void;
};

/**
 * Warn on sustained event-loop stalls, while ignoring long gaps caused by a
 * sleeping machine and suppressing repeated warnings during the same stall.
 */
export function startEventLoopLagMonitor(
	options: EventLoopLagMonitorOptions = {},
): () => void {
	const intervalMs = options.intervalMs ?? 250;
	const warningThresholdMs = options.warningThresholdMs ?? 750;
	const cooldownMs = options.cooldownMs ?? 30_000;
	const maxReportableLagMs = options.maxReportableLagMs ?? 30_000;
	const now = options.now ?? (() => performance.now());
	const log =
		options.log ??
		((message: string) => {
			console.warn(message);
		});
	let expectedAt = now() + intervalMs;
	let lastWarningAt = Number.NEGATIVE_INFINITY;
	const timer = setInterval(() => {
		const actualAt = now();
		const lagMs = Math.max(0, actualAt - expectedAt);
		expectedAt = actualAt + intervalMs;
		if (
			lagMs < warningThresholdMs ||
			lagMs > maxReportableLagMs ||
			actualAt - lastWarningAt < cooldownMs
		) {
			return;
		}
		lastWarningAt = actualAt;
		log(`[server] event loop delayed by ${Math.round(lagMs)}ms`);
	}, intervalMs);
	timer.unref?.();
	return () => clearInterval(timer);
}
