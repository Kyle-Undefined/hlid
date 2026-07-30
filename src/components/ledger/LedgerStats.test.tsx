import { describe, expect, it } from "vitest";
import { cacheHitPct } from "./LedgerStats";

describe("cacheHitPct", () => {
	it("computes the cache read share of input-side tokens", () => {
		expect(cacheHitPct(1000, 3000, 1000)).toBe("60.0");
	});

	it("returns 0 when total is zero", () => {
		expect(cacheHitPct(0, 0, 0)).toBe("0");
	});
});
