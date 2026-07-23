import { describe, expect, it } from "vitest";
import type { ProviderUsageSnapshot, UsageWindow, UsageWindows } from "#/db";
import {
	applyRateLimitToSnapshot,
	applyRateLimitToWindowData,
	builtInProviderUsageShells,
	mergeFreshProviderSnapshots,
	mergeProviderSnapshot,
	mergeUsageWindows,
	providerWindowUsage,
} from "#/lib/usageWindows";

describe("builtInProviderUsageShells", () => {
	it("does not invent an unreported Codex spend-control window", () => {
		const shells = builtInProviderUsageShells();
		expect(
			shells.find((item) => item.providerId === "claude")?.windows,
		).toHaveLength(2);
		expect(
			shells
				.find((item) => item.providerId === "codex")
				?.windows.map((window) => window.windowId),
		).toEqual(["five_hour", "weekly"]);
	});
});

function makeWindows(
	utilization: number | null,
	resetsAt: number | null,
): UsageWindows {
	const win: UsageWindow = {
		tokens: 0,
		queries: 0,
		sessions: 0,
		cost: 0,
		utilization,
		resetsAt,
		rateLimitType: null,
	};
	return { fiveHour: win, weekly: win, weeklySonnet: null };
}

const NOW = Math.floor(Date.now() / 1000);
const FUTURE_NEAR = NOW + 2 * 24 * 3600; // 2 days out (old window, still valid)
const FUTURE_FAR = NOW + 7 * 24 * 3600; // 7 days out (new window after reset)

describe("mergeUsageWindows", () => {
	it("uses fresh utilization within same window (external reset)", () => {
		// Anthropic can reset usage without changing resetsAt — downward moves are valid.
		const prev = makeWindows(0.25, FUTURE_NEAR);
		const fresh = makeWindows(0.03, FUTURE_NEAR); // same resetsAt, lower = reset
		const result = mergeUsageWindows(fresh, prev);
		expect(result.weekly.utilization).toBe(0.03);
		expect(result.weekly.resetsAt).toBe(FUTURE_NEAR);
	});

	it("keeps prev when fresh.utilization is null (anti-flicker)", () => {
		// Server has no mark data — keep the client's cached value to avoid blank flash.
		const prev = makeWindows(0.25, FUTURE_NEAR);
		const fresh = makeWindows(null, FUTURE_NEAR); // server returned no utilization
		const result = mergeUsageWindows(fresh, prev);
		expect(result.weekly.utilization).toBe(0.25);
		expect(result.weekly.resetsAt).toBe(FUTURE_NEAR);
	});

	it("uses fresh utilization when resetsAt changed (early reset)", () => {
		const prev = makeWindows(0.25, FUTURE_NEAR);
		const fresh = makeWindows(0.01, FUTURE_FAR); // new resetsAt = new window
		const result = mergeUsageWindows(fresh, prev);
		expect(result.weekly.utilization).toBe(0.01);
		expect(result.weekly.resetsAt).toBe(FUTURE_FAR);
	});

	it("uses fresh utilization when resetsAt changed (natural rollover)", () => {
		const pastResetsAt = NOW - 1; // old window expired
		const prev = makeWindows(0.8, pastResetsAt);
		const fresh = makeWindows(0.02, FUTURE_FAR);
		const result = mergeUsageWindows(fresh, prev);
		expect(result.weekly.utilization).toBe(0.02);
		expect(result.weekly.resetsAt).toBe(FUTURE_FAR);
	});

	it("keeps prev when fresh has no resetsAt (no new header data)", () => {
		const prev = makeWindows(0.25, FUTURE_NEAR);
		const fresh = makeWindows(null, null);
		const result = mergeUsageWindows(fresh, prev);
		expect(result.weekly.utilization).toBe(0.25);
		expect(result.weekly.resetsAt).toBe(FUTURE_NEAR);
	});

	it("uses fresh when prev is null", () => {
		const fresh = makeWindows(0.1, FUTURE_FAR);
		const result = mergeUsageWindows(fresh, null);
		expect(result.weekly.utilization).toBe(0.1);
	});

	// Sonnet window
	it("uses fresh sonnet when resetsAt changed (early reset)", () => {
		const win: UsageWindow = {
			tokens: 0,
			queries: 0,
			sessions: 0,
			cost: 0,
			utilization: 0.0,
			resetsAt: FUTURE_NEAR,
			rateLimitType: null,
		};
		const prev: UsageWindows = {
			fiveHour: win,
			weekly: win,
			weeklySonnet: { utilization: 0.32, resetsAt: FUTURE_NEAR },
		};
		const freshWin = { ...win, utilization: 0.01, resetsAt: FUTURE_FAR };
		const fresh: UsageWindows = {
			fiveHour: freshWin,
			weekly: freshWin,
			weeklySonnet: { utilization: 0.01, resetsAt: FUTURE_FAR },
		};
		const result = mergeUsageWindows(fresh, prev);
		expect(result.weeklySonnet?.utilization).toBe(0.01);
		expect(result.weeklySonnet?.resetsAt).toBe(FUTURE_FAR);
	});

	it("uses fresh sonnet utilization within same window (external reset)", () => {
		const win: UsageWindow = {
			tokens: 0,
			queries: 0,
			sessions: 0,
			cost: 0,
			utilization: 0.0,
			resetsAt: FUTURE_NEAR,
			rateLimitType: null,
		};
		const prev: UsageWindows = {
			fiveHour: win,
			weekly: win,
			weeklySonnet: { utilization: 0.31, resetsAt: FUTURE_NEAR },
		};
		const fresh: UsageWindows = {
			fiveHour: win,
			weekly: win,
			weeklySonnet: { utilization: 0.04, resetsAt: FUTURE_NEAR },
		};
		const result = mergeUsageWindows(fresh, prev);
		expect(result.weeklySonnet?.utilization).toBe(0.04);
		expect(result.weeklySonnet?.resetsAt).toBe(FUTURE_NEAR);
	});

	it("keeps prev sonnet when fresh.utilization is null (anti-flicker)", () => {
		const win: UsageWindow = {
			tokens: 0,
			queries: 0,
			sessions: 0,
			cost: 0,
			utilization: 0.0,
			resetsAt: FUTURE_NEAR,
			rateLimitType: null,
		};
		const prev: UsageWindows = {
			fiveHour: win,
			weekly: win,
			weeklySonnet: { utilization: 0.31, resetsAt: FUTURE_NEAR },
		};
		const fresh: UsageWindows = {
			fiveHour: win,
			weekly: win,
			weeklySonnet: { utilization: null, resetsAt: FUTURE_NEAR },
		};
		const result = mergeUsageWindows(fresh, prev);
		expect(result.weeklySonnet?.utilization).toBe(0.31);
		expect(result.weeklySonnet?.resetsAt).toBe(FUTURE_NEAR);
	});
});

describe("applyRateLimitToWindowData", () => {
	const base = makeWindows(0.5, FUTURE_NEAR);

	it('updates fiveHour on "five_hour"', () => {
		const result = applyRateLimitToWindowData(base, {
			rateLimitType: "five_hour",
			utilization: 0.9,
			resetsAt: FUTURE_FAR,
		});
		expect(result?.fiveHour.utilization).toBe(0.9);
		expect(result?.weekly.utilization).toBe(0.5); // unchanged
	});

	it('updates weekly on "weekly"', () => {
		const result = applyRateLimitToWindowData(base, {
			rateLimitType: "weekly",
			utilization: 0.8,
			resetsAt: FUTURE_FAR,
		});
		expect(result?.weekly.utilization).toBe(0.8);
		expect(result?.fiveHour.utilization).toBe(0.5); // unchanged
	});

	it('updates weeklySonnet on "weekly_sonnet"', () => {
		const withSonnet: UsageWindows = {
			...base,
			weeklySonnet: { utilization: 0.1, resetsAt: FUTURE_NEAR },
		};
		const result = applyRateLimitToWindowData(withSonnet, {
			rateLimitType: "weekly_sonnet",
			utilization: 0.7,
			resetsAt: FUTURE_FAR,
		});
		expect(result?.weeklySonnet?.utilization).toBe(0.7);
		expect(result?.weekly.utilization).toBe(0.5); // unchanged
	});

	it("returns prev unchanged for unknown rateLimitType (regression: old fallthrough bug)", () => {
		// Before fix, any unknown type (e.g. SDK's "seven_day" before translation,
		// or "overage") would fall through and clobber weekly window.
		for (const unknown of ["seven_day", "seven_day_sonnet", "overage"]) {
			const result = applyRateLimitToWindowData(base, {
				rateLimitType: unknown,
				utilization: 0.99,
				resetsAt: FUTURE_FAR,
			});
			expect(result).toBe(base); // same reference = unchanged
		}
	});

	it("returns prev unchanged when utilization is null", () => {
		const result = applyRateLimitToWindowData(base, {
			rateLimitType: "weekly",
			utilization: null,
			resetsAt: FUTURE_FAR,
		});
		expect(result).toBe(base);
	});

	it("returns null when prev is null", () => {
		const result = applyRateLimitToWindowData(null, {
			rateLimitType: "weekly",
			utilization: 0.5,
			resetsAt: FUTURE_FAR,
		});
		expect(result).toBeNull();
	});
});

describe("mergeProviderSnapshot", () => {
	function makeSnapshot(
		util: number | null,
		resetsAt: number | null,
	): ProviderUsageSnapshot {
		return {
			providerId: "claude",
			providerLabel: "Claude",
			windows: [
				{
					windowId: "weekly",
					label: "7-DAY",
					windowSecs: 7 * 86400,
					tokens: 0,
					queries: 0,
					sessions: 0,
					cost: 0,
					utilization: util,
					remaining: null,
					limit: null,
					resetsAt,
				},
			],
		};
	}

	it("uses fresh utilization within same window (external reset)", () => {
		const prev = makeSnapshot(0.24, FUTURE_NEAR);
		const fresh = makeSnapshot(0.03, FUTURE_NEAR); // same resetsAt, lower = reset
		const result = mergeProviderSnapshot(fresh, prev, null);
		expect(result.windows[0].utilization).toBe(0.03);
		expect(result.windows[0].resetsAt).toBe(FUTURE_NEAR);
	});

	it("keeps prev when fresh has null utilization (anti-flicker)", () => {
		const prev = makeSnapshot(0.24, FUTURE_NEAR);
		const fresh = makeSnapshot(null, FUTURE_NEAR); // server returned no utilization
		const result = mergeProviderSnapshot(fresh, prev, null);
		expect(result.windows[0].utilization).toBe(0.24);
		expect(result.windows[0].resetsAt).toBe(FUTURE_NEAR);
	});

	it("uses fresh on resetsAt change (window rollover)", () => {
		const prev = makeSnapshot(0.24, FUTURE_NEAR);
		const fresh = makeSnapshot(0.02, FUTURE_FAR); // new resetsAt = new window
		const result = mergeProviderSnapshot(fresh, prev, null);
		expect(result.windows[0].utilization).toBe(0.02);
		expect(result.windows[0].resetsAt).toBe(FUTURE_FAR);
	});

	it("returns fresh directly when prev is undefined", () => {
		const fresh = makeSnapshot(0.1, FUTURE_FAR);
		const result = mergeProviderSnapshot(fresh, undefined, null);
		expect(result.windows[0].utilization).toBe(0.1);
	});

	it("applies matching live rate limits without changing other providers", () => {
		const claude = makeSnapshot(0.1, FUTURE_NEAR);
		const codex = { ...makeSnapshot(0.2, FUTURE_NEAR), providerId: "codex" };
		const rateLimit = {
			type: "rate_limit" as const,
			status: "ok" as const,
			providerId: "claude",
			rateLimitType: "weekly",
			utilization: 0.75,
			remaining: 250,
			limit: 1_000,
			resetsAt: FUTURE_FAR,
		};

		expect(
			applyRateLimitToSnapshot(claude, rateLimit).windows[0],
		).toMatchObject({
			utilization: 0.75,
			remaining: 250,
			limit: 1_000,
			resetsAt: FUTURE_FAR,
		});
		expect(applyRateLimitToSnapshot(codex, rateLimit)).toBe(codex);
	});

	it("merges each refreshed provider against its matching previous snapshot", () => {
		const previous = [
			makeSnapshot(0.2, FUTURE_NEAR),
			{ ...makeSnapshot(0.4, FUTURE_NEAR), providerId: "codex" },
		];
		const fresh = [
			makeSnapshot(null, FUTURE_NEAR),
			{ ...makeSnapshot(0.1, FUTURE_FAR), providerId: "codex" },
		];

		const merged = mergeFreshProviderSnapshots(fresh, previous);
		expect(merged[0].windows[0].utilization).toBe(0.2);
		expect(merged[1].windows[0].utilization).toBe(0.1);
	});

	it("keeps the last good snapshots when a transient refresh is empty", () => {
		const previous = [
			makeSnapshot(0.2, FUTURE_NEAR),
			{ ...makeSnapshot(0.4, FUTURE_NEAR), providerId: "codex" },
		];

		expect(mergeFreshProviderSnapshots([], previous)).toEqual(previous);
	});

	it("keeps providers omitted by a partial refresh", () => {
		const claude = makeSnapshot(0.2, FUTURE_NEAR);
		const codex = {
			...makeSnapshot(0.4, FUTURE_NEAR),
			providerId: "codex",
		};

		const merged = mergeFreshProviderSnapshots(
			[makeSnapshot(0.3, FUTURE_FAR)],
			[claude, codex],
		);

		expect(merged.map((snapshot) => snapshot.providerId)).toEqual([
			"claude",
			"codex",
		]);
		expect(merged[1]).toBe(codex);
	});
});

describe("providerWindowUsage", () => {
	const base = {
		windowId: "weekly",
		label: "7-DAY",
		windowSecs: 604_800,
		tokens: 0,
		queries: 0,
		sessions: 0,
		cost: 0,
		resetsAt: null,
	};

	it("formats direct utilization", () => {
		expect(
			providerWindowUsage({
				...base,
				utilization: 0.425,
				remaining: null,
				limit: null,
			}),
		).toEqual({ percentage: 42.5, label: "42%" });
	});

	it("derives utilization from remaining capacity", () => {
		expect(
			providerWindowUsage({
				...base,
				utilization: null,
				remaining: 25,
				limit: 100,
			}),
		).toEqual({ percentage: 75, label: "25 left" });
	});

	it("labels windows the provider does not report", () => {
		expect(
			providerWindowUsage({
				...base,
				utilization: null,
				remaining: null,
				limit: null,
			}),
		).toEqual({ percentage: null, label: "not reported" });
	});
});
