import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type {
	LedgerAnalytics,
	LedgerAnalyticsFilter,
	ThirtyDayStats,
} from "#/db";
import type { ActivityStats } from "#/lib/serverFns/stats";
import {
	EMPTY_ACTIVITY,
	EMPTY_AGG,
	getActivityStatsFn,
	getCockpitStatsFn,
	getLedgerAnalyticsFn,
	getThirtyDayStatsFn,
} from "#/lib/serverFns/stats";

export type LedgerStatsData = {
	statsData: Awaited<ReturnType<typeof getCockpitStatsFn>>;
	thirtyDayStats: ThirtyDayStats;
	activity: ActivityStats;
	statsStatus: LedgerStatsSourceStatus;
	thirtyDayStatus: LedgerStatsSourceStatus;
	activityStatus: LedgerStatsSourceStatus;
	analytics: LedgerAnalytics | null;
	/** Prior successful filter result retained only while the next filter loads. */
	staleAnalytics: LedgerAnalytics | null;
	analyticsStatus: LedgerStatsSourceStatus;
};

export type LedgerStatsSourceStatus = "loading" | "ready" | "unavailable";

type LedgerStatsSnapshot = Omit<LedgerStatsData, "staleAnalytics"> & {
	/** Filter identity for the analytics payload/status stored in this snapshot. */
	analyticsKey: string | null;
	/** Filter identity whose request owns analyticsStatus. */
	analyticsRequestKey: string | null;
};

const EMPTY_LEDGER_STATS: LedgerStatsSnapshot = {
	statsData: { agg: EMPTY_AGG },
	thirtyDayStats: { days: [], total: 0 },
	activity: EMPTY_ACTIVITY,
	statsStatus: "loading",
	thirtyDayStatus: "loading",
	activityStatus: "loading",
	analytics: null,
	analyticsStatus: "loading",
	analyticsKey: null,
	analyticsRequestKey: null,
};

let snapshot: LedgerStatsSnapshot = EMPTY_LEDGER_STATS;
const subscribers = new Set<() => void>();

function getSnapshot(): LedgerStatsSnapshot {
	return snapshot;
}

function subscribe(callback: () => void): () => void {
	subscribers.add(callback);
	return () => subscribers.delete(callback);
}

function updateSnapshot(patch: Partial<LedgerStatsSnapshot>): void {
	snapshot = { ...snapshot, ...patch };
	for (const subscriber of subscribers) subscriber();
}

function analyticsFilterKey(filter: LedgerAnalyticsFilter): string {
	return JSON.stringify({
		range: filter.range,
		agent: filter.agent ?? "",
		provider: filter.provider ?? "",
		model: filter.model ?? "",
		from: filter.range === "custom" ? (filter.from ?? "") : "",
		to: filter.range === "custom" ? (filter.to ?? "") : "",
	});
}

/**
 * Last-good Ledger analytics with non-blocking stale-while-revalidate reads.
 *
 * The cache lives only in client memory and is populated exclusively by
 * successful server-function responses. Every Stats activation and refresh
 * token change reconciles it with the authoritative server state.
 */
export function useLedgerStatsData(
	enabled: boolean,
	refreshToken?: number,
	filter: LedgerAnalyticsFilter = { range: "30d" },
): LedgerStatsData & { refresh: () => void } {
	const data = useSyncExternalStore(
		subscribe,
		getSnapshot,
		() => EMPTY_LEDGER_STATS,
	);
	const generationRef = useRef(0);
	const filterRange = filter.range;
	const filterAgent = filter.agent;
	const filterProvider = filter.provider;
	const filterModel = filter.model;
	const filterFrom = filter.range === "custom" ? filter.from : undefined;
	const filterTo = filter.range === "custom" ? filter.to : undefined;
	const filterKey = analyticsFilterKey(filter);

	const refresh = useCallback(() => {
		const generation = ++generationRef.current;
		const isCurrent = () => generation === generationRef.current;
		if (getSnapshot().analyticsKey !== filterKey) {
			updateSnapshot({
				analyticsStatus: "loading",
				analyticsRequestKey: filterKey,
			});
		}

		void getCockpitStatsFn()
			.then((statsData) => {
				if (isCurrent()) updateSnapshot({ statsData, statsStatus: "ready" });
			})
			.catch(() => {
				if (isCurrent() && getSnapshot().statsStatus !== "ready") {
					updateSnapshot({ statsStatus: "unavailable" });
				}
			});

		void getThirtyDayStatsFn()
			.then((thirtyDayStats) => {
				if (isCurrent()) {
					updateSnapshot({ thirtyDayStats, thirtyDayStatus: "ready" });
				}
			})
			.catch(() => {
				if (isCurrent() && getSnapshot().thirtyDayStatus !== "ready") {
					updateSnapshot({ thirtyDayStatus: "unavailable" });
				}
			});

		void getActivityStatsFn()
			.then((activity) => {
				if (isCurrent()) updateSnapshot({ activity, activityStatus: "ready" });
			})
			.catch(() => {
				if (isCurrent() && getSnapshot().activityStatus !== "ready") {
					updateSnapshot({ activityStatus: "unavailable" });
				}
			});

		void getLedgerAnalyticsFn({
			data: {
				range: filterRange,
				agent: filterAgent,
				provider: filterProvider,
				model: filterModel,
				from: filterFrom,
				to: filterTo,
			},
		})
			.then((analytics) => {
				if (!isCurrent()) return;
				if (analytics) {
					updateSnapshot({
						analytics,
						analyticsStatus: "ready",
						analyticsKey: filterKey,
						analyticsRequestKey: filterKey,
					});
				} else if (getSnapshot().analyticsRequestKey === filterKey) {
					updateSnapshot({
						analyticsStatus: "unavailable",
						analyticsRequestKey: filterKey,
					});
				}
			})
			.catch(() => {
				if (
					isCurrent() &&
					getSnapshot().analyticsRequestKey === filterKey &&
					getSnapshot().analyticsKey !== filterKey
				) {
					updateSnapshot({
						analyticsStatus: "unavailable",
						analyticsRequestKey: filterKey,
					});
				}
			});
	}, [
		filterAgent,
		filterFrom,
		filterKey,
		filterModel,
		filterProvider,
		filterRange,
		filterTo,
	]);

	useEffect(() => {
		if (enabled) {
			// Reading the token makes its sole purpose explicit: changes retrigger the
			// effect even though the value is not part of the request payload.
			void refreshToken;
			refresh();
		} else generationRef.current++;
	}, [enabled, refreshToken, refresh]);

	useEffect(
		() => () => {
			generationRef.current++;
		},
		[],
	);

	const analyticsMatchesFilter = data.analyticsKey === filterKey;
	const requestMatchesFilter = data.analyticsRequestKey === filterKey;
	const staleAnalytics =
		!analyticsMatchesFilter &&
		requestMatchesFilter &&
		data.analyticsStatus === "loading"
			? data.analytics
			: null;
	return {
		...data,
		analytics: analyticsMatchesFilter ? data.analytics : null,
		staleAnalytics,
		analyticsStatus: analyticsMatchesFilter
			? "ready"
			: requestMatchesFilter
				? data.analyticsStatus
				: "loading",
		refresh,
	};
}

/** Test-only reset for the client-memory last-good snapshot. */
// fallow-ignore-next-line unused-export -- test-only reset
export function resetLedgerStatsDataForTest(): void {
	snapshot = EMPTY_LEDGER_STATS;
	for (const subscriber of subscribers) subscriber();
}
