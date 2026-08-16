import type { ProviderWindowReading } from "./agentProvider";

export const OPENCODE_GO_USAGE_ENDPOINT = "https://opencode.ai/zen/go/v1/usage";

export const OPENCODE_GO_USAGE_WINDOWS = [
	{
		windowId: "opencode_go_rolling",
		label: "5-HOUR",
		windowSecs: 5 * 3_600,
		displayOnly: true,
		showLocalStats: false,
		modelPrefixes: ["opencode-go/"],
	},
	{
		windowId: "opencode_go_weekly",
		label: "WEEKLY",
		windowSecs: 7 * 86_400,
		displayOnly: true,
		showLocalStats: false,
		modelPrefixes: ["opencode-go/"],
	},
	{
		windowId: "opencode_go_monthly",
		label: "MONTHLY",
		windowSecs: 30 * 86_400,
		displayOnly: true,
		showLocalStats: false,
		modelPrefixes: ["opencode-go/"],
	},
] as const;

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_MAX_STALE_MS = 10 * 60_000;
// Stay comfortably inside Hlid's 5-second read budget so an unreachable
// provider endpoint can still return a nonfatal unavailable snapshot.
const DEFAULT_TIMEOUT_MS = 3_000;
const AUTH_RETRY_MS = 5 * 60_000;
const TRANSIENT_RETRY_MS = 60_000;
const RATE_LIMIT_RETRY_MS = 2 * 60_000;
const MAX_RATE_LIMIT_RETRY_MS = 15 * 60_000;

type UsagePeriod = {
	status: "ok" | "rate-limited";
	percent: number;
	resetsAt: string;
};

type CachedUsage = {
	readings: ProviderWindowReading[];
	fetchedAt: number;
};

type OpenCodeGoUsageClientOptions = {
	apiKey: string;
	fetch?: (
		input: string | URL | Request,
		init?: RequestInit,
	) => Promise<Response>;
	now?: () => number;
	cacheTtlMs?: number;
	maxStaleMs?: number;
	timeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePeriod(value: unknown): UsagePeriod | null {
	if (!isRecord(value)) return null;
	if (value.status !== "ok" && value.status !== "rate-limited") return null;
	if (
		typeof value.percent !== "number" ||
		!Number.isFinite(value.percent) ||
		value.percent < 0
	) {
		return null;
	}
	if (typeof value.resetsAt !== "string") return null;
	const resetMs = Date.parse(value.resetsAt);
	if (!Number.isFinite(resetMs) || resetMs <= 0) return null;
	return {
		status: value.status,
		percent: Math.min(value.percent, 100),
		resetsAt: value.resetsAt,
	};
}

export function parseOpenCodeGoUsage(
	value: unknown,
): ProviderWindowReading[] | null {
	if (!isRecord(value) || !isRecord(value.usage)) return null;
	const periods = [
		["rolling", OPENCODE_GO_USAGE_WINDOWS[0]],
		["weekly", OPENCODE_GO_USAGE_WINDOWS[1]],
		["monthly", OPENCODE_GO_USAGE_WINDOWS[2]],
	] as const;
	const readings: ProviderWindowReading[] = [];
	for (const [key, definition] of periods) {
		const period = parsePeriod(value.usage[key]);
		if (!period) return null;
		readings.push({
			windowId: definition.windowId,
			label: definition.label,
			utilization: period.percent / 100,
			remaining: null,
			limit: null,
			resetsAt: Math.floor(Date.parse(period.resetsAt) / 1_000),
		});
	}
	return readings;
}

function retryAfterMs(response: Response, now: number): number {
	const raw = response.headers.get("retry-after")?.trim();
	if (!raw) return RATE_LIMIT_RETRY_MS;
	const seconds = Number(raw);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.min(seconds * 1_000, MAX_RATE_LIMIT_RETRY_MS);
	}
	const at = Date.parse(raw);
	if (!Number.isFinite(at)) return RATE_LIMIT_RETRY_MS;
	return Math.min(Math.max(0, at - now), MAX_RATE_LIMIT_RETRY_MS);
}

function cloneReadings(
	readings: ProviderWindowReading[],
): ProviderWindowReading[] {
	return readings.map((reading) => ({ ...reading }));
}

export function unavailableOpenCodeGoUsageReadings(): ProviderWindowReading[] {
	return OPENCODE_GO_USAGE_WINDOWS.map((definition) => ({
		windowId: definition.windowId,
		label: definition.label,
		utilization: null,
		remaining: null,
		limit: null,
		resetsAt: null,
	}));
}

export type OpenCodeGoUsageReader = () => Promise<ProviderWindowReading[]>;

/**
 * Provider-native OpenCode Go quota reader. The credential is supplied only in
 * the Authorization header and is never logged, persisted here, or read from
 * OpenCode's credential store.
 */
export function createOpenCodeGoUsageReader(
	options: OpenCodeGoUsageClientOptions,
): OpenCodeGoUsageReader {
	const apiKey = options.apiKey;
	const fetchFn = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
	const maxStaleMs = options.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let cached: CachedUsage | null = null;
	let nextAttemptAt = 0;
	let inFlight: Promise<ProviderWindowReading[]> | null = null;

	const retained = (at: number): ProviderWindowReading[] => {
		if (!cached || at - cached.fetchedAt > maxStaleMs) {
			return unavailableOpenCodeGoUsageReadings();
		}
		return cloneReadings(cached.readings);
	};

	const refresh = async (): Promise<ProviderWindowReading[]> => {
		const attemptedAt = now();
		try {
			const response = await fetchFn(OPENCODE_GO_USAGE_ENDPOINT, {
				method: "GET",
				headers: {
					accept: "application/json",
					authorization: `Bearer ${apiKey}`,
				},
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (response.status === 401 || response.status === 403) {
				cached = null;
				nextAttemptAt = attemptedAt + AUTH_RETRY_MS;
				return unavailableOpenCodeGoUsageReadings();
			}
			if (response.status === 429) {
				nextAttemptAt = attemptedAt + retryAfterMs(response, attemptedAt);
				return retained(attemptedAt);
			}
			if (!response.ok) {
				nextAttemptAt = attemptedAt + TRANSIENT_RETRY_MS;
				return retained(attemptedAt);
			}
			const readings = parseOpenCodeGoUsage(await response.json());
			if (!readings) {
				nextAttemptAt = attemptedAt + TRANSIENT_RETRY_MS;
				return retained(attemptedAt);
			}
			cached = { readings, fetchedAt: attemptedAt };
			nextAttemptAt = attemptedAt + cacheTtlMs;
			return cloneReadings(readings);
		} catch {
			nextAttemptAt = attemptedAt + TRANSIENT_RETRY_MS;
			return retained(attemptedAt);
		}
	};

	return async () => {
		const at = now();
		if (cached && at - cached.fetchedAt < cacheTtlMs) {
			return cloneReadings(cached.readings);
		}
		if (at < nextAttemptAt) return retained(at);
		if (inFlight) return inFlight;
		inFlight = refresh().finally(() => {
			inFlight = null;
		});
		return inFlight;
	};
}
