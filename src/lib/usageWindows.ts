import type { ProviderUsageSnapshot, ProviderWindowEntry } from "#/db";
import type { RateLimitMessage } from "#/server/protocol";

const EMPTY_PROVIDER_WINDOW = {
	tokens: 0,
	queries: 0,
	sessions: 0,
	cost: 0,
	utilization: null,
	remaining: null,
	limit: null,
	resetsAt: null,
} as const;

/**
 * Stable Cockpit shell for the built-in provider windows. Usage hydration is
 * intentionally non-blocking, so keep the panel geometry present while its
 * last-known or fresh readings are restored.
 */
export function builtInProviderUsageShells(): ProviderUsageSnapshot[] {
	return ["claude", "codex"].map((providerId) => ({
		providerId,
		providerLabel: providerId === "claude" ? "Claude" : "Codex",
		windows: [
			{
				...EMPTY_PROVIDER_WINDOW,
				windowId: "five_hour",
				label: "5-HOUR",
				windowSecs: 5 * 3600,
			},
			{
				...EMPTY_PROVIDER_WINDOW,
				windowId: "weekly",
				label: "7-DAY",
				windowSecs: 7 * 86400,
			},
		],
	}));
}

type WindowReading = {
	utilization: number | null;
	resetsAt: number | null;
};

/**
 * Core merge rule for provider usage snapshots:
 * prefer the fresh reading unless it carries no utilization for a still-valid
 * previous window (anti-flicker), in which case keep the previous reading.
 * Exported for direct unit testing.
 */
export function preferredWindowReading(
	fresh: WindowReading,
	previous: WindowReading | null | undefined,
	now: number,
): WindowReading {
	const keepPrevious =
		previous?.utilization != null &&
		previous.resetsAt != null &&
		previous.resetsAt > now &&
		fresh.utilization == null &&
		(fresh.resetsAt == null || fresh.resetsAt === previous.resetsAt);
	return keepPrevious
		? {
				utilization: previous.utilization,
				resetsAt: previous.resetsAt,
			}
		: { utilization: fresh.utilization, resetsAt: fresh.resetsAt };
}

export function applyRateLimitToSnapshot(
	snapshot: ProviderUsageSnapshot,
	rateLimit: RateLimitMessage | null,
): ProviderUsageSnapshot {
	if (
		!rateLimit ||
		rateLimit.providerId !== snapshot.providerId ||
		rateLimit.utilization == null ||
		!rateLimit.rateLimitType
	) {
		return snapshot;
	}
	const utilization = rateLimit.utilization;
	return {
		...snapshot,
		windows: snapshot.windows.map((window) =>
			window.windowId === rateLimit.rateLimitType
				? {
						...window,
						utilization,
						remaining: rateLimit.remaining ?? window.remaining,
						limit: rateLimit.limit ?? window.limit,
						resetsAt: rateLimit.resetsAt ?? window.resetsAt,
					}
				: window,
		),
	};
}

function mergeProviderWindow(
	fresh: ProviderWindowEntry,
	previous: ProviderWindowEntry | undefined,
	now: number,
): ProviderWindowEntry {
	// A provider-native display reading is authoritative. In particular, an
	// authentication failure or expired stale cache must clear a previous
	// account's browser-cached percentage instead of using the anti-flicker rule.
	if (fresh.displayOnly) return fresh;
	return { ...fresh, ...preferredWindowReading(fresh, previous, now) };
}

export function mergeProviderSnapshot(
	fresh: ProviderUsageSnapshot,
	previous: ProviderUsageSnapshot | undefined,
	rateLimit: RateLimitMessage | null,
): ProviderUsageSnapshot {
	if (!previous) return applyRateLimitToSnapshot(fresh, rateLimit);
	const now = Date.now() / 1000;
	const windows = fresh.windows.map((window) =>
		mergeProviderWindow(
			window,
			previous.windows.find((item) => item.windowId === window.windowId),
			now,
		),
	);
	return applyRateLimitToSnapshot({ ...fresh, windows }, rateLimit);
}

export function mergeFreshProviderSnapshots(
	fresh: ProviderUsageSnapshot[],
	previous: ProviderUsageSnapshot[],
): ProviderUsageSnapshot[] {
	const refreshed = fresh.map((snapshot) =>
		mergeProviderSnapshot(
			snapshot,
			previous.find((item) => item.providerId === snapshot.providerId),
			null,
		),
	);
	const refreshedIds = new Set(
		refreshed.map((snapshot) => snapshot.providerId),
	);
	// Read-only server functions intentionally return [] on a transient timeout.
	// Keep the last good providers when a background refresh is empty or partial
	// so the usage strip cannot disappear until the next successful poll.
	return [
		...refreshed,
		...previous.filter((snapshot) => !refreshedIds.has(snapshot.providerId)),
	];
}

export function providerWindowUsage(window: ProviderWindowEntry): {
	percentage: number | null;
	label: string | null;
} {
	if (window.utilization != null) {
		const percentage = Math.min(window.utilization * 100, 100);
		return { percentage, label: `${Math.floor(percentage)}%` };
	}
	if (window.remaining == null || window.limit == null || window.limit <= 0) {
		return { percentage: null, label: "not reported" };
	}
	return {
		percentage: Math.min((1 - window.remaining / window.limit) * 100, 100),
		label: `${window.remaining.toLocaleString()} left`,
	};
}
