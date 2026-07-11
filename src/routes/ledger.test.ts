import { describe, expect, it } from "vitest";
import { cacheHitPct } from "#/components/ledger/LedgerStats";
import {
	filterOptimisticIds,
	filterOptimisticLabels,
	parseLedgerSearch,
} from "#/lib/ledgerState";

// ─── cacheHitPct ─────────────────────────────────────────────────────────────

describe("cacheHitPct", () => {
	it("returns '0' when all token counts are zero", () => {
		expect(cacheHitPct(0, 0, 0)).toBe("0");
	});

	it("returns '0' when there are tokens but no cache reads", () => {
		expect(cacheHitPct(1000, 0, 0)).toBe("0.0");
	});

	it("calculates correct hit rate to one decimal place", () => {
		// 500 cache reads out of 1000 total = 50%
		expect(cacheHitPct(500, 500, 0)).toBe("50.0");
	});

	it("includes cacheCreate in denominator but only cacheRead in numerator", () => {
		// 100 read, 200 create, 700 plain = 1000 total; hit = 100/1000 = 10%
		expect(cacheHitPct(700, 100, 200)).toBe("10.0");
	});

	it("returns '100.0' when everything is cache reads", () => {
		expect(cacheHitPct(0, 1000, 0)).toBe("100.0");
	});
});

describe("parseLedgerSearch", () => {
	it("defaults tab to 'sessions' when not provided", () => {
		expect(parseLedgerSearch({})).toMatchObject({ tab: "sessions" });
	});

	it("accepts 'sessions' tab", () => {
		expect(parseLedgerSearch({ tab: "sessions" })).toMatchObject({
			tab: "sessions",
		});
	});

	it("accepts 'stats' tab", () => {
		expect(parseLedgerSearch({ tab: "stats" })).toMatchObject({ tab: "stats" });
	});

	it("falls back to 'sessions' for unknown tab values", () => {
		expect(parseLedgerSearch({ tab: "invalid" })).toMatchObject({
			tab: "sessions",
		});
		expect(parseLedgerSearch({ tab: 42 })).toMatchObject({ tab: "sessions" });
		expect(parseLedgerSearch({ tab: null })).toMatchObject({ tab: "sessions" });
	});

	it("defaults page to 1 when not provided", () => {
		expect(parseLedgerSearch({})).toMatchObject({ page: 1 });
	});

	it("accepts numeric page values", () => {
		expect(parseLedgerSearch({ page: 3 })).toMatchObject({ page: 3 });
	});

	it("floors fractional page values", () => {
		expect(parseLedgerSearch({ page: 2.9 })).toMatchObject({ page: 2 });
	});

	it("clamps page to minimum 1", () => {
		expect(parseLedgerSearch({ page: 0 })).toMatchObject({ page: 1 });
		expect(parseLedgerSearch({ page: -5 })).toMatchObject({ page: 1 });
	});

	it("defaults size to 20 when not provided", () => {
		expect(parseLedgerSearch({})).toMatchObject({ size: 20 });
	});

	it.each([10, 20, 50, 100])("accepts valid page size %i", (size) => {
		expect(parseLedgerSearch({ size })).toMatchObject({ size });
	});

	it("falls back to 20 for invalid page sizes", () => {
		expect(parseLedgerSearch({ size: 5 })).toMatchObject({ size: 20 });
		expect(parseLedgerSearch({ size: 999 })).toMatchObject({ size: 20 });
		expect(parseLedgerSearch({ size: "20" })).toMatchObject({ size: 20 });
		expect(parseLedgerSearch({ size: null })).toMatchObject({ size: 20 });
	});

	it("floors fractional size values then validates against allowed set", () => {
		expect(parseLedgerSearch({ size: 20.7 })).toMatchObject({ size: 20 });
		// 19.9 floors to 19, which is invalid → fallback to 20
		expect(parseLedgerSearch({ size: 19.9 })).toMatchObject({ size: 20 });
	});
});

// ─── filterOptimisticIds ──────────────────────────────────────────────────────

describe("filterOptimisticIds", () => {
	it("returns same reference when prev is empty", () => {
		const prev = new Set<string>();
		const result = filterOptimisticIds(prev, new Set(["a", "b"]));
		expect(result).toBe(prev);
	});

	it("keeps IDs still present in server response (delete not yet confirmed)", () => {
		// User deleted "a" optimistically. Server still returns "a" → pending delete.
		const prev = new Set(["a"]);
		const freshIds = new Set(["a", "b"]);
		const result = filterOptimisticIds(prev, freshIds);
		expect(result.has("a")).toBe(true);
	});

	it("drops IDs no longer in server response (delete confirmed)", () => {
		// Server no longer returns "a" → delete confirmed, drop from tracking.
		const prev = new Set(["a"]);
		const freshIds = new Set(["b", "c"]);
		const result = filterOptimisticIds(prev, freshIds);
		expect(result.has("a")).toBe(false);
		expect(result.size).toBe(0);
	});

	it("returns same reference when nothing was evicted", () => {
		const prev = new Set(["a", "b"]);
		const freshIds = new Set(["a", "b", "c"]);
		const result = filterOptimisticIds(prev, freshIds);
		expect(result).toBe(prev);
	});

	it("returns new set when at least one ID was evicted", () => {
		const prev = new Set(["a", "b"]);
		const freshIds = new Set(["a"]); // "b" confirmed gone
		const result = filterOptimisticIds(prev, freshIds);
		expect(result).not.toBe(prev);
		expect(result.has("a")).toBe(true);
		expect(result.has("b")).toBe(false);
	});

	it("background done event cannot un-hide an optimistically deleted session", () => {
		// Regression: blanket new Set() would clear deletedIds, making deleted
		// session re-appear. filterOptimisticIds must preserve the pending delete.
		const deletedIds = new Set(["session-being-deleted"]);
		// Server still returns the session (delete RPC hasn't resolved yet)
		const freshIds = new Set(["session-being-deleted", "other-session"]);
		const result = filterOptimisticIds(deletedIds, freshIds);
		expect(result.has("session-being-deleted")).toBe(true);
	});
});

// ─── filterOptimisticLabels ───────────────────────────────────────────────────

describe("filterOptimisticLabels", () => {
	it("returns same reference when prev is empty", () => {
		const prev = new Map<string, string>();
		const result = filterOptimisticLabels(prev, new Set(["a"]));
		expect(result).toBe(prev);
	});

	it("keeps label override for session still in server response", () => {
		const prev = new Map([["a", "My Renamed Session"]]);
		const freshIds = new Set(["a", "b"]);
		const result = filterOptimisticLabels(prev, freshIds);
		expect(result.get("a")).toBe("My Renamed Session");
	});

	it("drops label override for session no longer in server response", () => {
		const prev = new Map([["a", "Old Label"]]);
		const freshIds = new Set(["b"]);
		const result = filterOptimisticLabels(prev, freshIds);
		expect(result.has("a")).toBe(false);
	});

	it("returns same reference when nothing was evicted", () => {
		const prev = new Map([
			["a", "Label A"],
			["b", "Label B"],
		]);
		const freshIds = new Set(["a", "b", "c"]);
		const result = filterOptimisticLabels(prev, freshIds);
		expect(result).toBe(prev);
	});

	it("returns new map when at least one entry was evicted", () => {
		const prev = new Map([
			["a", "Label A"],
			["b", "Label B"],
		]);
		const freshIds = new Set(["a"]);
		const result = filterOptimisticLabels(prev, freshIds);
		expect(result).not.toBe(prev);
		expect(result.get("a")).toBe("Label A");
		expect(result.has("b")).toBe(false);
	});
});
