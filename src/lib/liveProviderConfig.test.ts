import { describe, expect, it } from "vitest";
import { applyLiveProviderConfig } from "./liveProviderConfig";
import { effortOptionsFor } from "./providerOptions";
import type { ProviderInfo } from "./providerTypes";

describe("applyLiveProviderConfig", () => {
	it("scopes dependent ACP options to one live provider row", () => {
		const providers: ProviderInfo[] = [
			{
				id: "acp:opencode",
				label: "OpenCode",
				available: true,
				models: [
					{ value: "fast", label: "Fast" },
					{ value: "smart", label: "Smart" },
				],
				effortLevels: [{ value: "medium", label: "Medium" }],
			},
			{ id: "acp:pi-acp", label: "Pi", available: true },
		];
		const next = applyLiveProviderConfig(providers, "acp:opencode", {
			models: [
				{ value: "fast", label: "Fast" },
				{
					value: "smart",
					label: "Smart",
					efforts: [
						{ value: "high", label: "High", isDefault: true },
						{ value: "xhigh", label: "Extra High" },
					],
				},
			],
			activeModel: "smart",
			activeEffort: "high",
			effortLevels: [
				{ value: "high", label: "High", isDefault: true },
				{ value: "xhigh", label: "Extra High" },
			],
			modes: [
				{ value: "build", label: "Build", isDefault: true },
				{ value: "plan", label: "Plan" },
			],
			activeMode: "build",
			planModeValue: "plan",
		});

		expect(next[1]).toBe(providers[1]);
		expect(effortOptionsFor(next[0], "smart")).toEqual([
			{ value: "high", label: "High", isDefault: true },
			{ value: "xhigh", label: "Extra High" },
		]);
		expect(next[0]?.effortLevels).toBeUndefined();
		expect(next[0]?.liveSessionConfig).toEqual({
			activeModel: "smart",
			activeEffort: "high",
			modes: [
				{ value: "build", label: "Build", isDefault: true },
				{ value: "plan", label: "Plan" },
			],
			activeMode: "build",
			planModeValue: "plan",
		});
	});

	it("patches effort choices when an agent omits the unchanged model list", () => {
		const [provider] = applyLiveProviderConfig(
			[
				{
					id: "acp:test",
					label: "Test",
					available: true,
					models: [{ value: "model-a", label: "Model A" }],
				},
			],
			"acp:test",
			{
				activeModel: "model-a",
				activeEffort: "low",
				effortLevels: [{ value: "low", label: "Low" }],
			},
		);
		expect(provider?.models?.[0]?.efforts).toEqual([
			{ value: "low", label: "Low" },
		]);
	});
});
