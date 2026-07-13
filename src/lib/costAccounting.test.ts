import { describe, expect, it } from "vitest";
import { cumulativeCostDelta } from "./costAccounting";

describe("cumulativeCostDelta", () => {
	it("returns only the increase from the prior provider total", () => {
		expect(cumulativeCostDelta(6.043017, 3.81798)).toBeCloseTo(2.225037);
	});

	it("treats a lower total as a reset provider counter", () => {
		expect(cumulativeCostDelta(0.5, 7.600859)).toBe(0.5);
	});
});
