import { describe, expect, it } from "vitest";
import { usageRepairTokenSummary } from "./usageRepairShared";

describe("usageRepairTokenSummary", () => {
	it("reports covered token totals and their delta", () => {
		expect(
			usageRepairTokenSummary({
				version: 1,
				rows: [],
				unresolved: [],
				totals: {
					before: {
						inputTokens: 100,
						outputTokens: 20,
						cacheReadTokens: 5,
						cacheCreationTokens: 1,
					},
					after: {
						inputTokens: 80,
						outputTokens: 15,
						cacheReadTokens: 4,
						cacheCreationTokens: 1,
					},
				},
			}),
		).toEqual({
			coveredTokensBefore: 126,
			coveredTokensAfter: 100,
			delta: -26,
		});
	});
});
