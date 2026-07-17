import { describe, expect, it } from "vitest";
import { estimateClaudeCost, getClaudePricing } from "./claudePricing";
import { getPricingCatalogState } from "./pricingCatalog";

const USAGE = {
	inputTokens: 1_000_000,
	outputTokens: 1_000_000,
	cacheReadTokens: 1_000_000,
	cacheCreationTokens: 1_000_000,
};

describe("claude pricing", () => {
	it("covers the published Claude model families", () => {
		const models = getPricingCatalogState()
			.models.filter(
				(entry) => entry.source === "built-in" && entry.provider === "claude",
			)
			.map((entry) => entry.model);
		expect(models).toContain("claude-fable-5");
		expect(models).toContain("claude-opus-4-8");
		expect(models).toContain("claude-sonnet-4-6");
	});

	it("uses disjoint token and five-minute cache-write rates", () => {
		expect(estimateClaudeCost("claude-fable-5", USAGE)).toBe(73.5);
		expect(estimateClaudeCost("claude-opus-4-8", USAGE)).toBe(36.75);
	});

	it("applies Sonnet 5 introductory pricing through August 2026", () => {
		expect(
			estimateClaudeCost(
				"claude-sonnet-5-20260701",
				USAGE,
				Date.UTC(2026, 7, 31),
			),
		).toBe(14.7);
		expect(
			estimateClaudeCost("claude-sonnet-5", USAGE, Date.UTC(2026, 8, 1)),
		).toBe(22.05);
	});

	it("resolves dated IDs without guessing aliases", () => {
		expect(getClaudePricing("claude-sonnet-4-6-20260301")?.model).toBe(
			"claude-sonnet-4-6",
		);
		expect(getClaudePricing("sonnet")).toBeNull();
		expect(estimateClaudeCost("<synthetic>", USAGE)).toBeNull();
	});
});
