import { describe, expect, it } from "vitest";
import {
	costDisplayNote,
	formatDisplayCost,
	formatPerQueryCost,
	totalDisplayCost,
} from "./costDisplay";

describe("cost display", () => {
	it("combines exact and estimated amounts and marks the result", () => {
		const summary = { cost: 1.25, estimated_cost: 0.5, unpriced_queries: 0 };
		expect(totalDisplayCost(summary)).toBe(1.75);
		expect(formatDisplayCost(summary)).toBe("~$1.7500");
		expect(costDisplayNote(summary)).toBe("includes API-equivalent estimate");
	});

	it("does not present an unpriced query as free", () => {
		const summary = { cost: 0, estimated_cost: 0, unpriced_queries: 1 };
		expect(formatDisplayCost(summary)).toBe("--");
		expect(costDisplayNote(summary)).toBe("1 unpriced query");
	});

	it("formats exact and estimated cost per priced query", () => {
		expect(formatPerQueryCost({ cost: 1.5 }, 10)).toBe("$0.1500");
		expect(formatPerQueryCost({ cost: 1.5, estimated_cost: 0.5 }, 10)).toBe(
			"~$0.2000",
		);
	});

	it("returns null when there are no priced queries", () => {
		expect(formatPerQueryCost({ cost: 1.5 }, 0)).toBeNull();
	});
});
