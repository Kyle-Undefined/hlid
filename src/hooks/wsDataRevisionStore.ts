import {
	DATA_DOMAINS,
	type DataDomain,
	type DataRevisionSnapshot,
} from "#/lib/dataRevision";

export const EMPTY_DATA_REVISIONS: DataRevisionSnapshot = {
	stats: 0,
	sessions: 0,
	relics: 0,
	vault: 0,
	providers: 0,
	config: 0,
	mcp: 0,
	storage: 0,
};

let snapshot: DataRevisionSnapshot = { ...EMPTY_DATA_REVISIONS };
const subscribers = new Set<() => void>();

export function getDataRevisionSnapshot(): DataRevisionSnapshot {
	return snapshot;
}

export function subscribeDataRevisionSnapshot(fn: () => void): () => void {
	subscribers.add(fn);
	return () => subscribers.delete(fn);
}

export function replaceDataRevisions(next: DataRevisionSnapshot): void {
	const changed = DATA_DOMAINS.some(
		(domain) => snapshot[domain] !== next[domain],
	);
	if (!changed) return;
	snapshot = { ...next };
	for (const subscriber of subscribers) subscriber();
}

export function changedDataDomains(
	previous: DataRevisionSnapshot,
	next: DataRevisionSnapshot,
): DataDomain[] {
	return DATA_DOMAINS.filter((domain) => previous[domain] !== next[domain]);
}

export function resetDataRevisionsForTesting(): void {
	snapshot = { ...EMPTY_DATA_REVISIONS };
	subscribers.clear();
}
