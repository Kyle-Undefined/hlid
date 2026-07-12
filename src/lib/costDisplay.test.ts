import { describe, expect, it } from "vitest";
import {
	costDisplayNote,
	formatDisplayCost,
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
});
