import {
	type AnalyticsScope,
	getAnalyticsRevision,
} from "../db/analyticsRevision";

type SnapshotEntry<T> = {
	revision: number;
	expiresAt: number;
	hasValue: boolean;
	value?: T;
	pending?: Promise<T>;
};

const snapshots = new Map<string, SnapshotEntry<unknown>>();

export type AnalyticsSnapshotOptions = {
	/**
	 * Safety expiry for data that changes as time passes without a DB write.
	 * Mutation-driven snapshots should omit this and live for their revision.
	 */
	maxAgeMs?: number;
};

function snapshotKey(scope: AnalyticsScope, key: string): string {
	return `${scope}:${key}`;
}

/**
 * Read a revision-scoped, single-flight server snapshot. Failed loads are not
 * retained, and an older in-flight load never overwrites a newer revision.
 */
export function readAnalyticsSnapshot<T>(
	scope: AnalyticsScope,
	key: string,
	load: () => Promise<T>,
	options: AnalyticsSnapshotOptions = {},
): Promise<T> {
	const revision = getAnalyticsRevision(scope);
	const now = Date.now();
	const cacheKey = snapshotKey(scope, key);
	const current = snapshots.get(cacheKey) as SnapshotEntry<T> | undefined;
	if (
		current?.revision === revision &&
		current.expiresAt > now &&
		current.hasValue
	) {
		return Promise.resolve(current.value as T);
	}
	if (current?.revision === revision && current.pending) {
		return current.pending;
	}

	const maxAgeMs = Math.max(0, options.maxAgeMs ?? Number.POSITIVE_INFINITY);
	const entry: SnapshotEntry<T> = {
		revision,
		expiresAt: now + maxAgeMs,
		hasValue: false,
	};
	const pending = load().then(
		(value) => {
			if (
				getAnalyticsRevision(scope) === revision &&
				snapshots.get(cacheKey) === entry
			) {
				entry.value = value;
				entry.hasValue = true;
				entry.pending = undefined;
			}
			return value;
		},
		(error) => {
			if (snapshots.get(cacheKey) === entry) snapshots.delete(cacheKey);
			throw error;
		},
	);
	entry.pending = pending;
	snapshots.set(cacheKey, entry);
	return pending;
}

/** Milliseconds until the next local midnight, with a small rollover margin. */
export function msUntilNextLocalDay(now = new Date()): number {
	const next = new Date(now);
	next.setHours(24, 0, 1, 0);
	return Math.max(1, next.getTime() - now.getTime());
}

/** Test-only reset for module-level snapshots. */
// fallow-ignore-next-line unused-export -- test-only reset
export function resetAnalyticsSnapshotsForTest(): void {
	snapshots.clear();
}
