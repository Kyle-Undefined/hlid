import type { AutoSleepConfig } from "../config";
import { getWindowMark } from "./proxy";

/**
 * Auto-sleep gate for provider usage windows.
 *
 * Utilization truth is provider-global (proxy window marks + provider
 * rate_limit events), so the sleep *decision* is shared per providerId while
 * the *waiting* happens per-session: each session awaits with its own
 * AbortSignal, and a per-provider waker set lets one "resume now" wake every
 * sleeping session on that provider (the budget is shared anyway).
 *
 * The five_hour window is preferred when the provider reports one. Providers
 * that expose only a weekly window (as Codex sometimes does) fall back to that
 * window instead.
 */

type HardLimitRecord = {
	/** Epoch seconds when the window resets, when the provider reported one. */
	resetsAt: number | null;
	/** Epoch seconds when the rejection was recorded; anchors the cumulative
	 * cap for null-resetsAt rechecks. */
	reportedAt: number;
};

export type SleepReason = "threshold" | "limit_reached";

export type SleepWindowId = "five_hour" | "weekly";

export type SleepDecision = {
	/** Epoch seconds to sleep until (already capped by max_sleep). */
	until: number;
	reason: SleepReason;
	windowId: SleepWindowId;
	/** True when max_sleep truncated the wait short of the window reset. */
	capApplied: boolean;
	/** Untruncated resume target (resetsAt + buffer), when known. */
	targetResetsAt: number | null;
	/** Utilization reading behind a threshold decision, for UI copy. */
	utilization: number | null;
};

const SLEEP_WINDOWS = ["five_hour", "weekly"] as const;
/** Recheck interval while a hard limit reports no resetsAt. */
const NULL_RESET_RECHECK_SECONDS = 15 * 60;
/** skipUntil fallback when no reset timestamp is known. */
const SKIP_FALLBACK_SECONDS = 5 * 60;
/**
 * A utilization response describes work that has already reached the provider.
 * Reserve one percentage point so a threshold such as 99% gates before the
 * next model request can consume the final percent and hard-limit the session.
 */
const IN_FLIGHT_HEADROOM = 0.01;

const hardLimits = new Map<string, HardLimitRecord>();
const skipUntil = new Map<string, number>();
const wakers = new Map<string, Set<() => void>>();
const warnedMissingReset = new Set<string>();

function epochNow(): number {
	return Math.floor(Date.now() / 1000);
}

function windowKey(providerId: string, windowId: SleepWindowId): string {
	return `${providerId}:${windowId}`;
}

function isSleepWindow(windowId: string): windowId is SleepWindowId {
	return (SLEEP_WINDOWS as readonly string[]).includes(windowId);
}

function activeWindow(
	providerId: string,
	windowId: SleepWindowId,
	now: number,
): boolean {
	const key = windowKey(providerId, windowId);
	const record = hardLimits.get(key);
	if (record && (record.resetsAt == null || record.resetsAt > now)) return true;
	if (record) hardLimits.delete(key);
	const mark = getWindowMark(providerId, windowId);
	return (
		mark?.utilization != null && (mark.resetsAt == null || mark.resetsAt > now)
	);
}

function selectedWindow(providerId: string, now: number): SleepWindowId | null {
	if (activeWindow(providerId, "five_hour", now)) return "five_hour";
	if (activeWindow(providerId, "weekly", now)) return "weekly";
	return null;
}

/**
 * Record a provider rate-limit signal. Rejections register a hard limit for a
 * supported sleep window; any later non-rejected reading for the same window
 * clears it. A rejection without a window id is attributed to five_hour only
 * when its resetsAt is close enough to plausibly be the short window.
 */
export function reportRateLimitSignal(
	providerId: string,
	windowId: string | undefined,
	status: string,
	resetsAt: number | null,
	cfg?: Pick<AutoSleepConfig, "max_sleep_minutes">,
): void {
	let resolvedWindow = windowId;
	if (resolvedWindow === undefined) {
		if (status !== "rejected") return;
		const maxSleepSecs = (cfg?.max_sleep_minutes ?? 360) * 60;
		const now = epochNow();
		if (resetsAt == null || resetsAt <= now || resetsAt - now > maxSleepSecs)
			return;
		resolvedWindow = "five_hour";
	}
	if (!isSleepWindow(resolvedWindow)) return;
	const key = windowKey(providerId, resolvedWindow);
	if (status === "rejected") {
		hardLimits.set(key, { resetsAt, reportedAt: epochNow() });
	} else {
		hardLimits.delete(key);
	}
}

/**
 * Decide whether sessions on this provider should sleep right now.
 * Returns null to proceed.
 */
export function evaluateSleep(
	providerId: string,
	cfg: AutoSleepConfig | undefined,
	now: number = epochNow(),
): SleepDecision | null {
	if (!cfg?.enabled) return null;

	const maxSleepSecs = cfg.max_sleep_minutes * 60;
	const windowId = selectedWindow(providerId, now);
	if (!windowId) return null;
	const key = windowKey(providerId, windowId);

	const skip = skipUntil.get(key);
	if (skip !== undefined) {
		if (skip > now) return null;
		skipUntil.delete(key);
	}

	const record = hardLimits.get(key);
	if (record) {
		if (record.resetsAt != null) {
			if (record.resetsAt <= now) {
				// Reset passed — record is stale.
				hardLimits.delete(key);
			} else {
				const target = record.resetsAt + cfg.resume_buffer_seconds;
				const cap = now + maxSleepSecs;
				return {
					until: Math.min(target, cap),
					reason: "limit_reached",
					windowId,
					capApplied: cap < target,
					targetResetsAt: target,
					utilization: null,
				};
			}
		} else {
			// Hard limit with no reset timestamp: recheck in short increments
			// until the cumulative cap (anchored at reportedAt) runs out.
			const capEnd = record.reportedAt + maxSleepSecs;
			if (now >= capEnd) {
				hardLimits.delete(key);
				skipUntil.set(key, now + SKIP_FALLBACK_SECONDS);
				return null;
			}
			const until = Math.min(now + NULL_RESET_RECHECK_SECONDS, capEnd);
			return {
				until,
				reason: "limit_reached",
				windowId,
				capApplied: until === capEnd,
				targetResetsAt: null,
				utilization: null,
			};
		}
	}

	const mark = getWindowMark(providerId, windowId);
	const proactiveThreshold = Math.max(
		0,
		cfg.threshold - Math.min(IN_FLIGHT_HEADROOM, cfg.threshold * 0.1),
	);
	if (mark?.utilization == null || mark.utilization < proactiveThreshold)
		return null;
	if (mark.resetsAt == null) {
		const warnKey = windowKey(providerId, windowId);
		if (!warnedMissingReset.has(warnKey)) {
			warnedMissingReset.add(warnKey);
			console.warn(
				`[usageGate] ${providerId} ${windowId} at ${Math.round(mark.utilization * 100)}% but no resetsAt reported; not sleeping`,
			);
		}
		return null;
	}
	if (mark.resetsAt <= now) return null; // Stale mark — window already reset.
	const target = mark.resetsAt + cfg.resume_buffer_seconds;
	const cap = now + maxSleepSecs;
	return {
		until: Math.min(target, cap),
		reason: "threshold",
		windowId,
		capApplied: cap < target,
		targetResetsAt: target,
		utilization: mark.utilization,
	};
}

function addWaker(providerId: string, wake: () => void): void {
	let set = wakers.get(providerId);
	if (!set) {
		set = new Set();
		wakers.set(providerId, set);
	}
	set.add(wake);
}

function removeWaker(providerId: string, wake: () => void): void {
	const set = wakers.get(providerId);
	if (!set) return;
	set.delete(wake);
	if (set.size === 0) wakers.delete(providerId);
}

/** One bounded wait, racing timer vs abort vs provider waker. */
function waitChunk(
	providerId: string,
	ms: number,
	signal: AbortSignal | undefined,
): Promise<"tick" | "aborted" | "woken"> {
	return new Promise((resolve) => {
		const finish = (result: "tick" | "aborted" | "woken") => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			removeWaker(providerId, onWake);
			resolve(result);
		};
		const onAbort = () => finish("aborted");
		const onWake = () => finish("woken");
		const timer = setTimeout(() => finish("tick"), ms);
		signal?.addEventListener("abort", onAbort, { once: true });
		addWaker(providerId, onWake);
	});
}

/**
 * Block until the usage gate allows proceeding (or the caller aborts).
 * Sleeps in ≤60s chunks that re-check the wall clock, so machine suspend
 * doesn't oversleep, and re-evaluates the decision after every chunk so a
 * fresher resetsAt (or a skip) takes effect promptly.
 */
export async function sleepUntilAllowed(options: {
	providerId: string;
	cfg: AutoSleepConfig | undefined;
	signal?: AbortSignal;
	onSleep?: (decision: SleepDecision) => void;
	onWake?: (cause: "reset" | "skipped" | "aborted") => void;
}): Promise<"proceeded" | "aborted"> {
	const { providerId, cfg, signal, onSleep, onWake } = options;
	let lastEmitted: SleepDecision | null = null;
	// evaluateSleep computes its cap from the current clock, which would slide
	// forward on every re-evaluation; anchor the deadline at the first capped
	// decision so max_sleep bounds the whole sleep, not each re-check.
	let capDeadline: number | null = null;
	let sleeping = false;
	let skipped = false;
	for (;;) {
		if (signal?.aborted) {
			if (sleeping) onWake?.("aborted");
			return "aborted";
		}
		const now = epochNow();
		const decision = evaluateSleep(providerId, cfg, now);
		if (!decision) {
			if (sleeping) onWake?.(skipped ? "skipped" : "reset");
			return "proceeded";
		}
		if (decision.capApplied && capDeadline === null)
			capDeadline = decision.until;
		const effective: SleepDecision =
			capDeadline !== null && capDeadline < decision.until
				? { ...decision, until: capDeadline, capApplied: true }
				: decision;
		if (capDeadline !== null && now >= capDeadline) {
			// Slept to the max_sleep cap and the window still hasn't reset.
			// Proceed anyway and suppress re-sleeping until the real reset —
			// hard 429s then surface exactly as they did before auto-sleep.
			skipUntil.set(
				windowKey(providerId, effective.windowId),
				effective.targetResetsAt ?? now + SKIP_FALLBACK_SECONDS,
			);
			if (sleeping) onWake?.("reset");
			return "proceeded";
		}
		if (
			!lastEmitted ||
			lastEmitted.until !== effective.until ||
			lastEmitted.reason !== effective.reason ||
			lastEmitted.windowId !== effective.windowId
		) {
			onSleep?.(effective);
			lastEmitted = effective;
		}
		sleeping = true;
		const waitMs = Math.min(
			60_000,
			Math.max(50, Math.ceil((effective.until - now) * 1000)),
		);
		const result = await waitChunk(providerId, waitMs, signal);
		if (result === "aborted") {
			onWake?.("aborted");
			return "aborted";
		}
		if (result === "woken") skipped = true;
	}
}

/**
 * "Resume now": suppress sleeping on this provider until its current window
 * resets (or a short fallback when no reset is known), then wake every
 * session currently sleeping on it.
 */
export function skipSleep(
	providerId: string,
	sleepingWindow?: SleepWindowId,
): void {
	const now = epochNow();
	const windowId = sleepingWindow ?? selectedWindow(providerId, now);
	if (windowId) {
		const key = windowKey(providerId, windowId);
		const record = hardLimits.get(key);
		const mark = getWindowMark(providerId, windowId);
		const resetsAt = record?.resetsAt ?? mark?.resetsAt ?? null;
		skipUntil.set(
			key,
			resetsAt != null && resetsAt > now
				? resetsAt
				: now + SKIP_FALLBACK_SECONDS,
		);
	}
	const set = wakers.get(providerId);
	if (!set) return;
	for (const wake of [...set]) wake();
}

export function _resetForTests(): void {
	hardLimits.clear();
	skipUntil.clear();
	warnedMissingReset.clear();
	for (const set of wakers.values()) for (const wake of [...set]) wake();
	wakers.clear();
}
