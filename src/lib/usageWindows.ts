import type {
	ProviderUsageSnapshot,
	ProviderWindowEntry,
	UsageWindows,
} from "#/db";
import type { RateLimitMessage } from "#/server/protocol";

export function applyRateLimitToWindowData(
	prev: UsageWindows | null,
	rateLimit: Pick<
		RateLimitMessage,
		"rateLimitType" | "utilization" | "resetsAt"
	>,
): UsageWindows | null {
	if (!prev || rateLimit.utilization == null) return prev;
	const update = {
		utilization: rateLimit.utilization,
		resetsAt: rateLimit.resetsAt ?? null,
	};
	switch (rateLimit.rateLimitType) {
		case "five_hour":
			return { ...prev, fiveHour: { ...prev.fiveHour, ...update } };
		case "weekly_sonnet":
			return { ...prev, weeklySonnet: update };
		case "weekly":
			return { ...prev, weekly: { ...prev.weekly, ...update } };
		default:
			return prev;
	}
}

type WindowReading = {
	utilization: number | null;
	resetsAt: number | null;
};

function preferredWindowReading(
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

function mergeWindow(
	fresh: UsageWindows["fiveHour"],
	previous: UsageWindows["fiveHour"],
	now: number,
): UsageWindows["fiveHour"] {
	return { ...fresh, ...preferredWindowReading(fresh, previous, now) };
}

function mergeSonnetWindow(
	fresh: UsageWindows["weeklySonnet"],
	previous: UsageWindows["weeklySonnet"],
	now: number,
): UsageWindows["weeklySonnet"] {
	if (!fresh) return null;
	return { ...fresh, ...preferredWindowReading(fresh, previous, now) };
}

export function mergeUsageWindows(
	fresh: UsageWindows,
	previous: UsageWindows | null,
): UsageWindows {
	if (!previous) return fresh;
	const now = Date.now() / 1000;
	return {
		...fresh,
		fiveHour: mergeWindow(fresh.fiveHour, previous.fiveHour, now),
		weekly: mergeWindow(fresh.weekly, previous.weekly, now),
		weeklySonnet: mergeSonnetWindow(
			fresh.weeklySonnet,
			previous.weeklySonnet,
			now,
		),
	};
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
	return fresh.map((snapshot) =>
		mergeProviderSnapshot(
			snapshot,
			previous.find((item) => item.providerId === snapshot.providerId),
			null,
		),
	);
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
		return { percentage: null, label: null };
	}
	return {
		percentage: Math.min((1 - window.remaining / window.limit) * 100, 100),
		label: `${window.remaining.toLocaleString()} left`,
	};
}
