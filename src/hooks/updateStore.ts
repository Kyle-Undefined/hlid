// Shared update status store. Fetches once (module-singleton), all
// subscribers see the same data and get notified on change.
//
// Pattern mirrors wsStore: useSyncExternalStore-compatible.

export type UpdateStatus = {
	current: string;
	latest: string | null;
	available: boolean;
	lastCheckedAt: number;
	error?: string;
};

let status: UpdateStatus | null = null;
// `didFetch` is set true only after a successful fetch — failures
// (network error, timeout, ok:false) leave it false so the next mount can
// retry without a page refresh.
let didFetch = false;
// `inFlight` coalesces concurrent callers onto a single fetch. The bool
// alone races: two mounts in the same tick can both pass the check before
// either marks the fetch as done. Promise dedup is correct.
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

// 10s should comfortably cover even a slow local round-trip while still
// freeing callers from hanging if the server stops responding mid-request.
const FETCH_TIMEOUT_MS = 10_000;

function emit() {
	for (const fn of listeners) fn();
}

export function subscribeUpdateStatus(cb: () => void): () => void {
	listeners.add(cb);
	return () => listeners.delete(cb);
}

export function getUpdateSnapshot(): UpdateStatus | null {
	return status;
}

/** Server snapshot — always null, no window access on server. */
export function getUpdateServerSnapshot(): null {
	return null;
}

/** Set status externally (e.g. after a force-check in UpdatesSection). */
export function setUpdateStatus(s: UpdateStatus): void {
	status = s;
	emit();
}

/** Fetch once per module lifetime. Safe to call from multiple components
 *  concurrently — overlapping calls share the same in-flight promise. */
export async function fetchUpdateStatus(): Promise<void> {
	if (didFetch) return;
	if (inFlight) return inFlight;
	inFlight = (async () => {
		try {
			const r = await fetch("/api/updates", {
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			const j = (await r.json()) as { ok: boolean; data?: UpdateStatus };
			if (j.ok && j.data) {
				status = j.data;
				didFetch = true;
				emit();
			}
			// j.ok === false: leave didFetch false so the next mount can retry
			// instead of being stuck with an empty banner until page refresh.
		} catch {
			// Network/timeout/abort error — same retry semantics as ok:false.
		} finally {
			inFlight = null;
		}
	})();
	return inFlight;
}

/** @internal — resets module state for tests. */
export function __resetForTesting(): void {
	status = null;
	didFetch = false;
	inFlight = null;
	listeners.clear();
}
