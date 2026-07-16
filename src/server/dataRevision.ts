import {
	DATA_DOMAINS,
	type DataDomain,
	type DataRevisionSnapshot,
} from "../lib/dataRevision";

export type { DataDomain, DataRevisionSnapshot } from "../lib/dataRevision";

const revisions: DataRevisionSnapshot = {
	stats: 0,
	sessions: 0,
	relics: 0,
	vault: 0,
	providers: 0,
	config: 0,
	mcp: 0,
	storage: 0,
};
const subscribers = new Set<(snapshot: DataRevisionSnapshot) => void>();

export function getDataRevisions(): DataRevisionSnapshot {
	return { ...revisions };
}

export function bumpDataRevision(...domains: DataDomain[]): void {
	if (domains.length === 0) return;
	for (const domain of new Set(domains)) revisions[domain]++;
	const snapshot = getDataRevisions();
	for (const subscriber of subscribers) subscriber(snapshot);
}

export function subscribeDataRevisions(
	subscriber: (snapshot: DataRevisionSnapshot) => void,
): () => void {
	subscribers.add(subscriber);
	return () => subscribers.delete(subscriber);
}

// fallow-ignore-next-line unused-export -- test-only reset
export function resetDataRevisionsForTesting(): void {
	for (const domain of DATA_DOMAINS) revisions[domain] = 0;
	subscribers.clear();
}
