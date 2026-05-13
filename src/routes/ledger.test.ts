import { describe, expect, it } from "vitest";
import {
	filterOptimisticIds,
	filterOptimisticLabels,
	parseLedgerSearch,
} from "./ledger";

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
