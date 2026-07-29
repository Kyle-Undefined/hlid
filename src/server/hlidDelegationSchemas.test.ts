import { describe, expect, it } from "vitest";
import {
	delegateHlidAgentSchema,
	resumeHlidAgentSchema,
} from "./hlidDelegationSchemas";

const delegationId = "7c0eea4d-f74e-45c8-8674-a535fbb4412b";

describe("Hlid delegation request schemas", () => {
	it("strips legacy timeout and usage caps", () => {
		const delegated = delegateHlidAgentSchema.parse({
			task: "Review the provider boundary",
			provider: "codex",
			timeout_seconds: 120,
			token_budget: 12_000,
			cost_budget: 1,
		});
		expect(delegated).toEqual({
			task: "Review the provider boundary",
			provider: "codex",
		});

		const resumed = resumeHlidAgentSchema.parse({
			id: delegationId,
			instruction: "Continue explicitly",
			timeout_seconds: 180,
			token_budget: 24_000,
			cost_budget: 2,
		});
		expect(resumed).toEqual({
			id: delegationId,
			instruction: "Continue explicitly",
		});
		expect(delegateHlidAgentSchema.shape).not.toHaveProperty("timeout_seconds");
		expect(resumeHlidAgentSchema.shape).not.toHaveProperty("timeout_seconds");
	});
});
