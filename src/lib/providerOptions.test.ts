import { describe, expect, it } from "vitest";
import {
	configuredVaultModel,
	defaultEffortFor,
	effortOptionsFor,
	modelOptions,
	normalizeEffortForPlanMode,
	resolveActiveProviderId,
} from "./providerOptions";
import type { ProviderInfo } from "./providerTypes";

const provider: ProviderInfo = {
	id: "claude",
	label: "Claude",
	available: true,
	models: [
		{ value: "sonnet", label: "Sonnet", isDefault: true },
		{ value: "hidden-model", label: "Hidden", hidden: true },
		{
			value: "opus",
			label: "Opus",
			description: "the big one",
			efforts: [
				{ value: "low", label: "Low" },
				{ value: "high", label: "High", isDefault: true },
			],
		},
	],
	effortLevels: [
		{ value: "medium", label: "Medium" },
		{ value: "high", label: "High" },
	],
};

describe("modelOptions", () => {
	it("filters out hidden models", () => {
		const result = modelOptions(provider);
		expect(result.map((m) => m.value)).toEqual(["sonnet", "opus"]);
	});

	it("returns [] for undefined provider", () => {
		expect(modelOptions(undefined)).toEqual([]);
	});

	it("returns [] when provider has no models", () => {
		expect(modelOptions({ id: "x", label: "X", available: true })).toEqual([]);
	});
});

describe("effortOptionsFor", () => {
	it("uses the selected model's own efforts when present", () => {
		const result = effortOptionsFor(provider, "opus");
		expect(result).toEqual([
			{ value: "low", label: "Low" },
			{ value: "high", label: "High", isDefault: true },
		]);
	});

	it("falls back to provider-level effortLevels when the model has none", () => {
		const result = effortOptionsFor(provider, "sonnet");
		expect(result).toEqual(provider.effortLevels);
	});

	it("falls back to provider-level effortLevels when the model isn't found", () => {
		const result = effortOptionsFor(provider, "");
		expect(result).toEqual(provider.effortLevels);
	});

	it("returns [] when neither the model nor the provider declare efforts", () => {
		const bare: ProviderInfo = { id: "x", label: "X", available: true };
		expect(effortOptionsFor(bare, "anything")).toEqual([]);
	});

	it("returns [] for undefined provider", () => {
		expect(effortOptionsFor(undefined, "anything")).toEqual([]);
	});

	it("hides Max and Ultra only for Codex native plan mode", () => {
		const codex: ProviderInfo = {
			...provider,
			id: "codex",
			models: [
				{
					value: "sol",
					label: "Sol",
					efforts: [
						{ value: "high", label: "High" },
						{ value: "xhigh", label: "X-High" },
						{ value: "max", label: "Max" },
						{ value: "ultra", label: "Ultra" },
					],
				},
			],
		};

		expect(effortOptionsFor(codex, "sol", true).map((e) => e.value)).toEqual([
			"high",
			"xhigh",
		]);
		expect(effortOptionsFor(codex, "sol", false)).toHaveLength(4);
		expect(effortOptionsFor(provider, "opus", true)).toHaveLength(2);
	});
});

describe("normalizeEffortForPlanMode", () => {
	it.each(["max", "ultra"])("maps Codex %s to xhigh", (effort) => {
		expect(normalizeEffortForPlanMode("codex", effort)).toBe("xhigh");
	});

	it("leaves X-High and Claude efforts unchanged", () => {
		expect(normalizeEffortForPlanMode("codex", "xhigh")).toBe("xhigh");
		expect(normalizeEffortForPlanMode("claude", "max")).toBe("max");
	});
});

describe("defaultEffortFor", () => {
	it("returns the selected model's default effort value", () => {
		expect(defaultEffortFor(provider, "opus")).toBe("high");
	});

	it("returns undefined when the selected model has no default effort", () => {
		expect(defaultEffortFor(provider, "sonnet")).toBeUndefined();
	});

	it("returns undefined when the model isn't found", () => {
		expect(defaultEffortFor(provider, "nope")).toBeUndefined();
	});

	it("returns undefined for undefined provider", () => {
		expect(defaultEffortFor(undefined, "anything")).toBeUndefined();
	});
});

describe("resolveActiveProviderId", () => {
	const agentList = [
		{ path: "/agents/codex-agent", provider: "codex" },
		{ path: "/agents/claude-agent", provider: "claude" },
	];

	it("returns the vault provider when no agent context is active", () => {
		expect(resolveActiveProviderId(agentList, undefined, "claude")).toBe(
			"claude",
		);
	});

	it("returns the matched agent's provider when an agent context is active", () => {
		expect(
			resolveActiveProviderId(agentList, "/agents/codex-agent", "claude"),
		).toBe("codex");
	});

	it("falls back to the vault provider when the agent context isn't found", () => {
		expect(
			resolveActiveProviderId(agentList, "/agents/unknown", "claude"),
		).toBe("claude");
	});
});

describe("configuredVaultModel", () => {
	const config = {
		vault_provider: "claude",
		claude: { model: "claude-sonnet-4-6" },
		codex: { model: "gpt-5.6-sol" },
	};

	it("uses vault configuration instead of whichever session is focused", () => {
		expect(configuredVaultModel(config as never)).toBe("claude-sonnet-4-6");
		expect(
			configuredVaultModel({ ...config, vault_provider: "codex" } as never),
		).toBe("gpt-5.6-sol");
	});

	it("does not invent a model for providers without vault model fields", () => {
		expect(
			configuredVaultModel({ ...config, vault_provider: "acp:pi" } as never),
		).toBeNull();
	});
});
