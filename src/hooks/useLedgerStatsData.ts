import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { ProviderUsageSnapshot, ThirtyDayStats } from "#/db";
import { getProvidersFn, getProviderUsagesFn } from "#/lib/serverFns/providers";
import type { ActivityStats } from "#/lib/serverFns/stats";
import {
	EMPTY_ACTIVITY,
	EMPTY_AGG,
	getActivityStatsFn,
	getCockpitStatsFn,
	getThirtyDayStatsFn,
} from "#/lib/serverFns/stats";

export type LedgerStatsData = {
	statsData: Awaited<ReturnType<typeof getCockpitStatsFn>>;
	thirtyDayStats: ThirtyDayStats;
	providerUsages: ProviderUsageSnapshot[];
	providerIds: string[];
	activity: ActivityStats;
};

const EMPTY_LEDGER_STATS: LedgerStatsData = {
	statsData: { agg: EMPTY_AGG },
	thirtyDayStats: { days: [], total: 0 },
	providerUsages: [],
	providerIds: ["claude"],
	activity: EMPTY_ACTIVITY,
};

let snapshot: LedgerStatsData = EMPTY_LEDGER_STATS;
const subscribers = new Set<() => void>();

function getSnapshot(): LedgerStatsData {
	return snapshot;
}

function subscribe(callback: () => void): () => void {
	subscribers.add(callback);
	return () => subscribers.delete(callback);
}

function updateSnapshot(patch: Partial<LedgerStatsData>): void {
	snapshot = { ...snapshot, ...patch };
	for (const subscriber of subscribers) subscriber();
}

function sameProviderIds(left: string[], right: string[]): boolean {
	return (
		left.length === right.length &&
		left.every((id, index) => id === right[index])
	);
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
): LedgerStatsData & { refresh: () => void } {
	const data = useSyncExternalStore(
		subscribe,
		getSnapshot,
		() => EMPTY_LEDGER_STATS,
	);
	const generationRef = useRef(0);

	const refresh = useCallback(() => {
		const generation = ++generationRef.current;
		const isCurrent = () => generation === generationRef.current;

		void getCockpitStatsFn()
			.then((statsData) => {
				if (isCurrent()) updateSnapshot({ statsData });
			})
			.catch(() => {});

		void getThirtyDayStatsFn()
			.then((thirtyDayStats) => {
				if (isCurrent()) updateSnapshot({ thirtyDayStats });
			})
			.catch(() => {});

		void getActivityStatsFn()
			.then((activity) => {
				if (isCurrent()) updateSnapshot({ activity });
			})
			.catch(() => {});

		const refreshProviderUsages = (providerIds: string[]) => {
			void getProviderUsagesFn({ data: providerIds })
				.then((providerUsages) => {
					if (
						isCurrent() &&
						sameProviderIds(getSnapshot().providerIds, providerIds)
					) {
						updateSnapshot({ providerUsages });
					}
				})
				.catch(() => {});
		};

		const currentProviderIds = getSnapshot().providerIds;
		refreshProviderUsages(currentProviderIds);
		void getProvidersFn({ data: { preferCachedModels: true } })
			.then((providers) => {
				if (!isCurrent()) return;
				const availableIds = providers
					.filter((provider) => provider.available)
					.map((provider) => provider.id);
				const providerIds = availableIds.length > 0 ? availableIds : ["claude"];
				updateSnapshot({ providerIds });
				if (!sameProviderIds(currentProviderIds, providerIds)) {
					refreshProviderUsages(providerIds);
				}
			})
			.catch(() => {});
	}, []);

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

	return { ...data, refresh };
}

/** Test-only reset for the client-memory last-good snapshot. */
// fallow-ignore-next-line unused-export -- test-only reset
export function resetLedgerStatsDataForTest(): void {
	snapshot = EMPTY_LEDGER_STATS;
	for (const subscriber of subscribers) subscriber();
}
