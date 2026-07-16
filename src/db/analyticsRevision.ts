/**
 * Server-side revision clock for data that feeds aggregate dashboards.
 *
 * Writers advance only the affected scopes after their transaction commits.
 * Snapshot readers can therefore retain a last-good value until an
 * authoritative mutation makes it stale, without relying on a long TTL.
 */
export const ANALYTICS_SCOPES = [
	"stats",
	"activity",
	"weekly",
	"thirtyDay",
	"providerUsage",
] as const;

export type AnalyticsScope = (typeof ANALYTICS_SCOPES)[number];

type AnalyticsChange = {
	revision: number;
	scopes: readonly AnalyticsScope[];
	reason?: string;
};

let revision = 0;
const scopeRevisions: Record<AnalyticsScope, number> = {
	stats: 0,
	activity: 0,
	weekly: 0,
	thirtyDay: 0,
	providerUsage: 0,
};

export function getAnalyticsRevision(scope: AnalyticsScope): number {
	return scopeRevisions[scope];
}

export function markAnalyticsChanged(
	scopes: readonly AnalyticsScope[] = ANALYTICS_SCOPES,
	reason?: string,
): AnalyticsChange {
	const changedScopes = [...new Set(scopes)];
	if (changedScopes.length === 0) {
		return { revision, scopes: changedScopes, reason };
	}

	revision += 1;
	for (const scope of changedScopes) scopeRevisions[scope] = revision;
	const change = { revision, scopes: changedScopes, reason };
	return change;
}

/** Test-only reset for module-level revisions. */
// fallow-ignore-next-line unused-export -- test-only reset
export function resetAnalyticsRevisionForTest(): void {
	revision = 0;
	for (const scope of ANALYTICS_SCOPES) scopeRevisions[scope] = 0;
}
