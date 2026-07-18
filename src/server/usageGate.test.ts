import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoSleepConfig } from "../config";
import { updateWindowMark } from "./proxy";
import {
	_resetForTests,
	evaluateSleep,
	reportRateLimitSignal,
	skipSleep,
	sleepUntilAllowed,
} from "./usageGate";

const cfg = (overrides: Partial<AutoSleepConfig> = {}): AutoSleepConfig => ({
	enabled: true,
	threshold: 0.95,
	max_sleep_minutes: 360,
	resume_buffer_seconds: 60,
	...overrides,
});

// Unique provider per test — proxy window marks have no reset hook.
let providerSeq = 0;
let provider = "";

const now = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-07-11T10:00:00Z"));
	provider = `test-provider-${providerSeq++}`;
});

afterEach(() => {
	_resetForTests();
	vi.useRealTimers();
});

describe("evaluateSleep", () => {
	it("returns null when disabled", () => {
		updateWindowMark(provider, "five_hour", 0.99, now() + 3600);
		expect(evaluateSleep(provider, cfg({ enabled: false }))).toBeNull();
		expect(evaluateSleep(provider, undefined)).toBeNull();
	});

	it("sleeps to resetsAt + buffer when utilization crosses the threshold", () => {
		const resetsAt = now() + 1200;
		updateWindowMark(provider, "five_hour", 0.96, resetsAt);
		const decision = evaluateSleep(provider, cfg());
		expect(decision).toMatchObject({
			until: resetsAt + 60,
			reason: "threshold",
			windowId: "five_hour",
			capApplied: false,
			utilization: 0.96,
		});
	});

	it("does not sleep below the threshold", () => {
		updateWindowMark(provider, "five_hour", 0.9, now() + 1200);
		expect(evaluateSleep(provider, cfg())).toBeNull();
	});

	it("falls back to weekly when no active five-hour window is reported", () => {
		const resetsAt = now() + 5 * 86400;
		updateWindowMark(provider, "weekly", 0.96, resetsAt);
		expect(evaluateSleep(provider, cfg())).toMatchObject({
			reason: "threshold",
			windowId: "weekly",
			utilization: 0.96,
			targetResetsAt: resetsAt + 60,
		});
	});

	it("prefers an active five-hour window over weekly", () => {
		updateWindowMark(provider, "five_hour", 0.9, now() + 1200);
		updateWindowMark(provider, "weekly", 0.99, now() + 5 * 86400);
		expect(evaluateSleep(provider, cfg())).toBeNull();
	});

	it("falls back to weekly after a stale five-hour window expires", () => {
		updateWindowMark(provider, "five_hour", 0.99, now() - 1);
		updateWindowMark(provider, "weekly", 0.96, now() + 5 * 86400);
		expect(evaluateSleep(provider, cfg())).toMatchObject({
			windowId: "weekly",
			utilization: 0.96,
		});
	});

	it("reserves headroom before a 99% threshold for an in-flight request", () => {
		const tight = cfg({ threshold: 0.99 });
		updateWindowMark(provider, "five_hour", 0.979, now() + 1200);
		expect(evaluateSleep(provider, tight)).toBeNull();
		updateWindowMark(provider, "five_hour", 0.98, now() + 1200);
		expect(evaluateSleep(provider, tight)).toMatchObject({
			reason: "threshold",
			utilization: 0.98,
		});
	});

	it("does not sleep on a stale or missing resetsAt", () => {
		updateWindowMark(provider, "five_hour", 0.99, now() - 10);
		expect(evaluateSleep(provider, cfg())).toBeNull();
		updateWindowMark(provider, "five_hour", 0.99, null);
		expect(evaluateSleep(provider, cfg())).toBeNull();
	});

	it("caps the sleep at max_sleep_minutes", () => {
		const resetsAt = now() + 7200;
		updateWindowMark(provider, "five_hour", 0.99, resetsAt);
		const decision = evaluateSleep(provider, cfg({ max_sleep_minutes: 30 }));
		expect(decision).toMatchObject({
			until: now() + 30 * 60,
			capApplied: true,
			targetResetsAt: resetsAt + 60,
		});
	});

	it("sleeps on a hard limit regardless of utilization", () => {
		const resetsAt = now() + 600;
		reportRateLimitSignal(provider, "five_hour", "rejected", resetsAt);
		const decision = evaluateSleep(provider, cfg());
		expect(decision).toMatchObject({
			until: resetsAt + 60,
			reason: "limit_reached",
		});
	});

	it("clears a hard limit on a later non-rejected reading", () => {
		reportRateLimitSignal(provider, "five_hour", "rejected", now() + 600);
		reportRateLimitSignal(provider, "five_hour", "ok", null);
		expect(evaluateSleep(provider, cfg())).toBeNull();
	});

	it("expires a hard limit whose resetsAt has passed", () => {
		reportRateLimitSignal(provider, "five_hour", "rejected", now() + 600);
		vi.advanceTimersByTime(700_000);
		expect(evaluateSleep(provider, cfg())).toBeNull();
	});

	it("sleeps on a weekly hard limit when five-hour is absent", () => {
		reportRateLimitSignal(provider, "weekly", "rejected", now() + 600);
		expect(evaluateSleep(provider, cfg())).toMatchObject({
			reason: "limit_reached",
			windowId: "weekly",
		});
	});

	it("prefers five-hour when both windows report hard limits", () => {
		reportRateLimitSignal(provider, "weekly", "rejected", now() + 86400);
		reportRateLimitSignal(provider, "five_hour", "rejected", now() + 600);
		expect(evaluateSleep(provider, cfg())).toMatchObject({
			reason: "limit_reached",
			windowId: "five_hour",
		});
	});

	it("rechecks in 15-minute increments on a hard limit without resetsAt", () => {
		reportRateLimitSignal(provider, "five_hour", "rejected", null);
		const decision = evaluateSleep(provider, cfg());
		expect(decision).toMatchObject({
			until: now() + 15 * 60,
			reason: "limit_reached",
			targetResetsAt: null,
		});
	});

	it("gives up on a null-resetsAt hard limit after the cumulative cap", () => {
		reportRateLimitSignal(provider, "five_hour", "rejected", null);
		vi.advanceTimersByTime(360 * 60 * 1000 + 1000);
		expect(evaluateSleep(provider, cfg())).toBeNull();
		// Escape hatch sets skipUntil, so an immediate re-report stays quiet
		// until the fallback passes.
		reportRateLimitSignal(provider, "five_hour", "rejected", null);
		expect(evaluateSleep(provider, cfg())).toBeNull();
	});

	it("attributes a window-less rejection to five_hour only when resetsAt is near", () => {
		reportRateLimitSignal(provider, undefined, "rejected", now() + 600, cfg());
		expect(evaluateSleep(provider, cfg())).not.toBeNull();

		const far = `${provider}-far`;
		reportRateLimitSignal(far, undefined, "rejected", now() + 8 * 3600, cfg());
		expect(evaluateSleep(far, cfg())).toBeNull();
	});
});

describe("sleepUntilAllowed", () => {
	it("proceeds immediately when nothing gates", async () => {
		const onSleep = vi.fn();
		await expect(
			sleepUntilAllowed({ providerId: provider, cfg: cfg(), onSleep }),
		).resolves.toBe("proceeded");
		expect(onSleep).not.toHaveBeenCalled();
	});

	it("sleeps until the window reset, then proceeds", async () => {
		const resetsAt = now() + 180;
		updateWindowMark(provider, "five_hour", 0.99, resetsAt);
		const onSleep = vi.fn();
		const onWake = vi.fn();
		const pending = sleepUntilAllowed({
			providerId: provider,
			cfg: cfg(),
			onSleep,
			onWake,
		});
		await vi.advanceTimersByTimeAsync(1000);
		expect(onSleep).toHaveBeenCalledTimes(1);
		expect(onSleep.mock.calls[0][0]).toMatchObject({ until: resetsAt + 60 });
		// Walk past resetsAt + buffer in chunked ticks.
		await vi.advanceTimersByTimeAsync(300_000);
		await expect(pending).resolves.toBe("proceeded");
		expect(onWake).toHaveBeenCalledWith("reset");
	});

	it("proceeds at the cap and suppresses re-sleeping until the real reset", async () => {
		const resetsAt = now() + 7200;
		updateWindowMark(provider, "five_hour", 0.99, resetsAt);
		const pending = sleepUntilAllowed({
			providerId: provider,
			cfg: cfg({ max_sleep_minutes: 2 }),
		});
		await vi.advanceTimersByTimeAsync(130_000);
		await expect(pending).resolves.toBe("proceeded");
		// skipUntil is set to the reset target — no re-sleep loop.
		expect(evaluateSleep(provider, cfg({ max_sleep_minutes: 2 }))).toBeNull();
		// Past the real reset the mark itself is stale, still no sleep.
		vi.advanceTimersByTime(7300 * 1000);
		expect(evaluateSleep(provider, cfg({ max_sleep_minutes: 2 }))).toBeNull();
	});

	it.each([
		"five_hour",
		"weekly",
	] as const)("skipSleep wakes all %s waiters and suppresses re-sleep", async (windowId) => {
		updateWindowMark(provider, windowId, 0.99, now() + 3600);
		const wakes: string[] = [];
		const first = sleepUntilAllowed({
			providerId: provider,
			cfg: cfg(),
			onWake: (cause) => wakes.push(cause),
		});
		const second = sleepUntilAllowed({
			providerId: provider,
			cfg: cfg(),
			onWake: (cause) => wakes.push(cause),
		});
		await vi.advanceTimersByTimeAsync(1000);
		skipSleep(provider, windowId);
		await vi.advanceTimersByTimeAsync(0);
		await expect(first).resolves.toBe("proceeded");
		await expect(second).resolves.toBe("proceeded");
		expect(wakes).toEqual(["skipped", "skipped"]);
		expect(evaluateSleep(provider, cfg())).toBeNull();
	});

	it("aborts when the signal fires mid-sleep", async () => {
		updateWindowMark(provider, "five_hour", 0.99, now() + 3600);
		const controller = new AbortController();
		const onWake = vi.fn();
		const pending = sleepUntilAllowed({
			providerId: provider,
			cfg: cfg(),
			signal: controller.signal,
			onWake,
		});
		await vi.advanceTimersByTimeAsync(1000);
		controller.abort();
		await expect(pending).resolves.toBe("aborted");
		expect(onWake).toHaveBeenCalledWith("aborted");
	});

	it("returns aborted without sleeping on a pre-aborted signal", async () => {
		updateWindowMark(provider, "five_hour", 0.99, now() + 3600);
		const controller = new AbortController();
		controller.abort();
		await expect(
			sleepUntilAllowed({
				providerId: provider,
				cfg: cfg(),
				signal: controller.signal,
			}),
		).resolves.toBe("aborted");
	});

	it("picks up a fresher resetsAt while sleeping", async () => {
		const resetsAt = now() + 3600;
		updateWindowMark(provider, "five_hour", 0.99, resetsAt);
		const onSleep = vi.fn();
		const pending = sleepUntilAllowed({
			providerId: provider,
			cfg: cfg(),
			onSleep,
		});
		await vi.advanceTimersByTimeAsync(1000);
		// A new window reading arrives with an earlier reset (same window ended
		// early server-side).
		updateWindowMark(provider, "five_hour", 0.2, now() + 30);
		await vi.advanceTimersByTimeAsync(61_000);
		await expect(pending).resolves.toBe("proceeded");
		expect(onSleep).toHaveBeenCalledTimes(1);
	});
});
