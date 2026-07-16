import { getSessionToolEventDetailFn } from "#/lib/serverFns/sessions";

export type HistoricalToolEventDetail = {
	result: string | null;
	isError?: boolean;
};

const MAX_CACHED_DETAILS = 100;
const MAX_CACHED_DETAIL_BYTES = 8 * 1024 * 1024;

type CachedDetail = { detail: HistoricalToolEventDetail; bytes: number };

const resolved = new Map<string, CachedDetail>();
const inflight = new Map<string, Promise<HistoricalToolEventDetail>>();
let resolvedBytes = 0;

function detailKey(sessionId: string, toolId: string): string {
	return `${sessionId}\0${toolId}`;
}

/** Deduplicated, in-memory hydration for immutable persisted tool results. */
export function loadToolEventDetail(
	sessionId: string,
	toolId: string,
): Promise<HistoricalToolEventDetail> {
	const key = detailKey(sessionId, toolId);
	const cached = resolved.get(key);
	if (cached) {
		// Refresh insertion order so eviction follows least-recently-used detail.
		resolved.delete(key);
		resolved.set(key, cached);
		return Promise.resolve(cached.detail);
	}
	const pending = inflight.get(key);
	if (pending) return pending;

	const request = getSessionToolEventDetailFn({
		data: { sessionId, toolId },
	})
		.then((row) => {
			if (!row) throw new Error("Tool result is no longer available");
			const detail: HistoricalToolEventDetail = {
				result: row.result_text,
				...(row.is_error != null ? { isError: row.is_error === 1 } : {}),
			};
			const bytes = (detail.result?.length ?? 0) * 2;
			if (bytes <= MAX_CACHED_DETAIL_BYTES) {
				resolved.set(key, { detail, bytes });
				resolvedBytes += bytes;
				while (
					resolved.size > MAX_CACHED_DETAILS ||
					resolvedBytes > MAX_CACHED_DETAIL_BYTES
				) {
					const oldestKey = resolved.keys().next().value;
					if (oldestKey === undefined) break;
					const evicted = resolved.get(oldestKey);
					resolved.delete(oldestKey);
					resolvedBytes -= evicted?.bytes ?? 0;
				}
			}
			return detail;
		})
		.finally(() => inflight.delete(key));
	inflight.set(key, request);
	return request;
}

/** Test and logout boundary; normal navigation intentionally keeps details warm. */
// fallow-ignore-next-line unused-export -- test-only reset
export function clearToolEventDetailCache(): void {
	resolved.clear();
	inflight.clear();
	resolvedBytes = 0;
}
