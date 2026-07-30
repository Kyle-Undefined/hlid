import { describe, expect, it } from "vitest";
import type { ProviderUsageSnapshot } from "#/db";
import {
	applyRateLimitToSnapshot,
	builtInProviderUsageShells,
	mergeFreshProviderSnapshots,
	mergeProviderSnapshot,
	preferredWindowReading,
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

const NOW = Math.floor(Date.now() / 1000);
const FUTURE_NEAR = NOW + 2 * 24 * 3600; // 2 days out (old window, still valid)
const FUTURE_FAR = NOW + 7 * 24 * 3600; // 7 days out (new window after reset)

// Core merge rule tested once here; mergeProviderSnapshot delegates to it, so
// its suite below only covers wrapper wiring.
describe("preferredWindowReading", () => {
	it("uses fresh utilization within same window (external reset)", () => {
		// Anthropic can reset usage without changing resetsAt — downward moves are valid.
		const result = preferredWindowReading(
			{ utilization: 0.03, resetsAt: FUTURE_NEAR }, // same resetsAt, lower = reset
			{ utilization: 0.25, resetsAt: FUTURE_NEAR },
			NOW,
		);
		expect(result).toEqual({ utilization: 0.03, resetsAt: FUTURE_NEAR });
	});

	it("keeps prev when fresh.utilization is null (anti-flicker)", () => {
		// Server has no mark data — keep the client's cached value to avoid blank flash.
		const result = preferredWindowReading(
			{ utilization: null, resetsAt: FUTURE_NEAR },
			{ utilization: 0.25, resetsAt: FUTURE_NEAR },
			NOW,
		);
		expect(result).toEqual({ utilization: 0.25, resetsAt: FUTURE_NEAR });
	});

	it("uses fresh utilization when resetsAt changed (early reset)", () => {
		const result = preferredWindowReading(
			{ utilization: 0.01, resetsAt: FUTURE_FAR }, // new resetsAt = new window
			{ utilization: 0.25, resetsAt: FUTURE_NEAR },
			NOW,
		);
		expect(result).toEqual({ utilization: 0.01, resetsAt: FUTURE_FAR });
	});

	it("uses fresh when the previous window expired (natural rollover)", () => {
		const result = preferredWindowReading(
			{ utilization: null, resetsAt: FUTURE_FAR },
			{ utilization: 0.8, resetsAt: NOW - 1 }, // old window expired
			NOW,
		);
		expect(result).toEqual({ utilization: null, resetsAt: FUTURE_FAR });
	});

	it("keeps prev when fresh has no resetsAt (no new header data)", () => {
		const result = preferredWindowReading(
			{ utilization: null, resetsAt: null },
			{ utilization: 0.25, resetsAt: FUTURE_NEAR },
			NOW,
		);
		expect(result).toEqual({ utilization: 0.25, resetsAt: FUTURE_NEAR });
	});

	it("uses fresh when prev is missing", () => {
		const result = preferredWindowReading(
			{ utilization: null, resetsAt: FUTURE_FAR },
			undefined,
			NOW,
		);
		expect(result).toEqual({ utilization: null, resetsAt: FUTURE_FAR });
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

	it("applies the preferred reading against the previous window matched by windowId", () => {
		// Merge semantics live in preferredWindowReading (tested above); this
		// covers the windowId lookup wiring via the anti-flicker path.
		const prev = makeSnapshot(0.24, FUTURE_NEAR);
		const fresh = makeSnapshot(null, FUTURE_NEAR); // server returned no utilization
		const result = mergeProviderSnapshot(fresh, prev, null);
		expect(result.windows[0].utilization).toBe(0.24);
		expect(result.windows[0].resetsAt).toBe(FUTURE_NEAR);
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
