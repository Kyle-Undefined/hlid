import { describe, expect, it } from "vitest";
import { isHtmlPlanPath } from "./htmlPlanPath";

describe("isHtmlPlanPath", () => {
	it("normalizes separators and Windows drive casing", () => {
		expect(
			isHtmlPlanPath(
				"C:\\Vault\\.hlid\\plans\\plan.html",
				"c:/vault/.hlid/plans/plan.html",
			),
		).toBe(true);
	});

	it("keeps case-sensitive non-drive paths distinct", () => {
		expect(isHtmlPlanPath("/vault/Plan.html", "/vault/plan.html")).toBe(false);
		expect(isHtmlPlanPath("/vault/plan.html", undefined)).toBe(false);
	});
});
