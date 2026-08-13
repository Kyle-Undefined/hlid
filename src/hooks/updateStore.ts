// Shared update status store. Fetches once (module-singleton), all
// subscribers see the same data and get notified on change.
//
// Pattern mirrors wsStore: useSyncExternalStore-compatible.

import type { CliUpdateStatus } from "#/lib/cliUpdateTypes";
import type { ReleaseNotes } from "#/lib/updates";

export type UpdateStatus = {
	current: string;
	latest: string | null;
	available: boolean;
	lastCheckedAt: number;
	release?: ReleaseNotes | null;
	cliUpdates?: CliUpdateStatus[];
	cliUpdateActionsAllowed?: boolean;
	refreshing?: boolean;
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
let forcedRefresh: Promise<void> | null = null;
// A forced refresh or externally supplied snapshot supersedes any older GET
// already in flight. Fetch cannot reliably abort every response once parsing
// has started, so generation ownership prevents stale completion from winning.
let requestGeneration = 0;
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
let didScheduleReconcile = false;
const listeners = new Set<() => void>();

// 10s should comfortably cover even a slow local round-trip while still
// freeing callers from hanging if the server stops responding mid-request.
const FETCH_TIMEOUT_MS = 10_000;
// A forced check waits for live ACP registry and target discovery instead of
// returning the startup snapshot, so give that bounded server work headroom.
const FORCED_REFRESH_TIMEOUT_MS = 30_000;
// Native/WSL probes finish within 5s. ACP can spend 10s loading its registry
// and another 10s initializing agents, so reconcile once after the full batch
// has had time to persist its snapshot.
const BACKGROUND_RECONCILE_MS = 25_000;

function emit() {
	for (const fn of listeners) fn();
}

function resetScheduledReconcile(): void {
	if (reconcileTimer) clearTimeout(reconcileTimer);
	reconcileTimer = null;
	didScheduleReconcile = false;
}

function scheduleReconcileIfNeeded(next: UpdateStatus): void {
	if (!next.refreshing || didScheduleReconcile) return;
	didScheduleReconcile = true;
	reconcileTimer = setTimeout(() => {
		reconcileTimer = null;
		didFetch = false;
		void fetchUpdateStatus();
	}, BACKGROUND_RECONCILE_MS);
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
	requestGeneration += 1;
	inFlight = null;
	forcedRefresh = null;
	resetScheduledReconcile();
	status = s;
	emit();
	scheduleReconcileIfNeeded(s);
}

/** Fetch once per module lifetime. Safe to call from multiple components
 *  concurrently — overlapping calls share the same in-flight promise. */
export async function fetchUpdateStatus(): Promise<void> {
	if (didFetch) return;
	if (inFlight) return inFlight;
	const generation = requestGeneration;
	const pending = (async () => {
		try {
			const r = await fetch("/api/updates", {
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			const j = (await r.json()) as { ok: boolean; data?: UpdateStatus };
			if (generation === requestGeneration && j.ok && j.data) {
				status = j.data;
				didFetch = true;
				emit();
				scheduleReconcileIfNeeded(j.data);
			}
			// j.ok === false: leave didFetch false so the next mount can retry
			// instead of being stuck with an empty banner until page refresh.
		} catch {
			// Network/timeout/abort error — same retry semantics as ok:false.
		} finally {
			if (generation === requestGeneration) inFlight = null;
		}
	})();
	inFlight = pending;
	return pending;
}

/**
 * Invalidate the client snapshot and force the server's combined release/CLI
 * check. This is used after ACP catalog mutations so a managed-target notice
 * appears or disappears immediately instead of waiting for the normal cache.
 * Concurrent callers share one forced check. A failed check restores the last
 * useful snapshot, while generation ownership prevents an older request from
 * overwriting newer state.
 */
export async function refreshUpdateStatus(): Promise<void> {
	if (forcedRefresh) return forcedRefresh;
	const previous = status;
	const generation = ++requestGeneration;
	resetScheduledReconcile();
	didFetch = false;
	status = null;
	if (previous !== null) emit();

	const pending = (async () => {
		try {
			const response = await fetch("/api/updates", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "check" }),
				signal: AbortSignal.timeout(FORCED_REFRESH_TIMEOUT_MS),
			});
			const payload = (await response.json()) as {
				ok: boolean;
				data?: UpdateStatus;
			};
			if (generation !== requestGeneration) return;
			if (payload.ok && payload.data) {
				status = payload.data;
				didFetch = true;
				emit();
				scheduleReconcileIfNeeded(payload.data);
				return;
			}
			status = previous;
			if (previous !== null) {
				emit();
				scheduleReconcileIfNeeded(previous);
			}
		} catch {
			if (generation !== requestGeneration) return;
			status = previous;
			if (previous !== null) {
				emit();
				scheduleReconcileIfNeeded(previous);
			}
		} finally {
			if (generation === requestGeneration) {
				forcedRefresh = null;
				inFlight = null;
			}
		}
	})();
	forcedRefresh = pending;
	inFlight = pending;
	return pending;
}

/** @internal — resets module state for tests. */
export function __resetForTesting(): void {
	resetScheduledReconcile();
	requestGeneration += 1;
	status = null;
	didFetch = false;
	inFlight = null;
	forcedRefresh = null;
	listeners.clear();
}
