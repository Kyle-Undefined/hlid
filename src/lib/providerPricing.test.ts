import { describe, expect, it } from "vitest";
import { estimateProviderCost } from "./providerPricing";

describe("provider pricing routes", () => {
	it("prices CLIProxy Codex usage with the Codex catalog", () => {
		const usage = {
			inputTokens: 1_000,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
		};
		expect(estimateProviderCost("cliproxy-codex", "gpt-5.6-sol", usage)).toBe(
			0.005,
		);
	});
});
