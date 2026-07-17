import { describe, expect, it } from "vitest";
import {
	canonicalizeCodexUsage,
	estimateCodexCost,
	getCodexPricing,
} from "./codexPricing";
import { getPricingCatalogState } from "./pricingCatalog";

describe("codex pricing", () => {
	it("contains every model currently exposed by the CLI catalog", () => {
		const models = getPricingCatalogState()
			.models.filter(
				(entry) => entry.source === "built-in" && entry.provider === "codex",
			)
			.map((entry) => entry.model);
		expect(new Set(models)).toEqual(
			new Set([
				"gpt-5.6-sol",
				"gpt-5.6-terra",
				"gpt-5.6-luna",
				"gpt-5.5",
				"gpt-5.4",
				"gpt-5.4-mini",
				"gpt-5.3-codex",
				"gpt-5.2-codex",
				"gpt-5.3-codex-spark",
			]),
		);
	});

	it("prices historical Codex and the documented code-review alias", () => {
		const usage = {
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			cacheReadTokens: 1_000_000,
			cacheCreationTokens: 0,
		};
		expect(estimateCodexCost("gpt-5.3-codex", usage)).toBe(15.925);
		expect(estimateCodexCost("gpt-5.2-codex", usage)).toBe(15.925);
		expect(estimateCodexCost("codex-auto-review", usage)).toBe(15.925);
	});

	it("normalizes OpenAI cached input into disjoint provider-neutral buckets", () => {
		expect(
			canonicalizeCodexUsage({
				inputTokens: 2_006,
				outputTokens: 300,
				cacheReadTokens: 1_920,
			}),
		).toEqual({
			inputTokens: 86,
			outputTokens: 300,
			cacheReadTokens: 1_920,
			cacheCreationTokens: 0,
		});
	});

	it("calculates a Terra API-equivalent estimate using cache rates", () => {
		const estimate = estimateCodexCost("gpt-5.6-terra", {
			inputTokens: 34_018,
			outputTokens: 4_940,
			cacheReadTokens: 144_000,
			cacheCreationTokens: 0,
		});
		expect(estimate).toBeCloseTo(0.195_145, 6);
	});

	it("applies long-context input and output multipliers to the full request", () => {
		const estimate = estimateCodexCost("gpt-5.6-terra", {
			inputTokens: 10_000,
			outputTokens: 1_000,
			cacheReadTokens: 263_000,
			cacheCreationTokens: 0,
		});
		expect(estimate).toBeCloseTo(0.204, 6);
	});

	it("adds the published hosted web-search fee per call", () => {
		const estimate = estimateCodexCost(
			"gpt-5.6-terra",
			{
				inputTokens: 1_000,
				outputTokens: 100,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
			},
			{ webSearchCalls: 3 },
		);
		expect(estimate).toBeCloseTo(0.034, 6);
	});

	it("resolves aliases/snapshots and leaves unpublished prices unavailable", () => {
		expect(getCodexPricing("gpt-5.6")?.model).toBe("gpt-5.6-sol");
		expect(getCodexPricing("gpt-5.4-2026-03-05")?.model).toBe("gpt-5.4");
		expect(
			estimateCodexCost("gpt-5.3-codex-spark", {
				inputTokens: 1,
				outputTokens: 1,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
			}),
		).toBeNull();
	});
});
