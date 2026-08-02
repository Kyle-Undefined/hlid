import { describe, expect, it } from "vitest";
import {
	canonicalizeCodexUsage,
	estimateCodexCost,
	getCodexPricing,
} from "./codexPricing";
import { getPricingCatalogState } from "./pricingCatalog";

const beforeTerraLunaCutover = Date.parse("2026-07-29T23:59:59.999Z");
const afterTerraLunaCutover = Date.parse("2026-07-30T00:00:00.000Z");

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
		const estimate = estimateCodexCost(
			"gpt-5.6-terra",
			{
				inputTokens: 34_018,
				outputTokens: 4_940,
				cacheReadTokens: 144_000,
				cacheCreationTokens: 0,
			},
			{ webSearchCalls: 0 },
			afterTerraLunaCutover,
		);
		expect(estimate).toBeCloseTo(0.156_116, 6);
	});

	it("keeps the original Terra and Luna rates before the July 30 cutover", () => {
		expect(
			getCodexPricing("gpt-5.6-terra", beforeTerraLunaCutover)?.rates,
		).toMatchObject({
			input: 2.5,
			cachedInput: 0.25,
			cacheWrite: 3.125,
			output: 15,
		});
		expect(
			getCodexPricing("gpt-5.6-luna", beforeTerraLunaCutover)?.rates,
		).toMatchObject({
			input: 1,
			cachedInput: 0.1,
			cacheWrite: 1.25,
			output: 6,
		});
	});

	it("uses the reduced Terra and Luna rates from July 30 onward", () => {
		expect(
			getCodexPricing("gpt-5.6-terra", afterTerraLunaCutover)?.rates,
		).toMatchObject({
			input: 2,
			cachedInput: 0.2,
			cacheWrite: 2.5,
			output: 12,
		});
		expect(
			getCodexPricing("gpt-5.6-luna", afterTerraLunaCutover)?.rates,
		).toMatchObject({
			input: 0.2,
			cachedInput: 0.02,
			cacheWrite: 0.25,
			output: 1.2,
		});
		expect(
			estimateCodexCost(
				"gpt-5.6-luna",
				{
					inputTokens: 10_000,
					outputTokens: 10_000,
					cacheReadTokens: 10_000,
					cacheCreationTokens: 10_000,
				},
				{ webSearchCalls: 0 },
				afterTerraLunaCutover,
			),
		).toBeCloseTo(0.016_7, 6);
	});

	it("applies long-context input and output multipliers to the full request", () => {
		const estimate = estimateCodexCost(
			"gpt-5.6-terra",
			{
				inputTokens: 10_000,
				outputTokens: 1_000,
				cacheReadTokens: 263_000,
				cacheCreationTokens: 0,
			},
			{ webSearchCalls: 0 },
			afterTerraLunaCutover,
		);
		expect(estimate).toBeCloseTo(0.163_2, 6);
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
			afterTerraLunaCutover,
		);
		expect(estimate).toBeCloseTo(0.033_2, 6);
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
