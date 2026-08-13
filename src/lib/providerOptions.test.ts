import { describe, expect, it } from "vitest";
import {
	codexRealtimeAvailability,
	configuredVaultModel,
	defaultEffortFor,
	effortOptionsFor,
	modelInputAvailability,
	modelOptions,
	normalizeEffortForPlanMode,
	permissionModeBadgeLabel,
	providerAdvertisesInput,
	resolveActiveProviderId,
	sessionPermissionOptionsFor,
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

describe("modelInputAvailability", () => {
	const codex: ProviderInfo = {
		id: "codex",
		label: "Codex",
		available: true,
		models: [
			{
				value: "text-model",
				label: "Text Model",
				isDefault: true,
				inputModalities: ["text", "image"],
			},
			{
				value: "audio-model",
				label: "Audio Model",
				inputModalities: ["text", "image", "audio"],
			},
		],
	};

	it("uses the selected model's advertised input modalities", () => {
		expect(modelInputAvailability(codex, "audio-model", "audio")).toEqual({
			available: true,
			modelLabel: "Audio Model",
		});
		expect(modelInputAvailability(codex, "text-model", "audio")).toEqual({
			available: false,
			modelLabel: "Text Model",
			reason: "Text Model does not support audio input.",
		});
	});

	it("uses the catalog default when no model is configured", () => {
		expect(modelInputAvailability(codex, undefined, "audio")).toEqual({
			available: false,
			modelLabel: "Text Model",
			reason: "Text Model does not support audio input.",
		});
	});

	it("does not assume support when the catalog has no capability data", () => {
		expect(modelInputAvailability(provider, "sonnet", "audio")).toEqual({
			available: false,
			modelLabel: "Sonnet",
			reason: "Sonnet has not reported audio input support.",
		});
	});

	it("reports an unavailable provider before inspecting cached model data", () => {
		expect(
			modelInputAvailability(
				{ ...codex, available: false, unavailableReason: "Codex is offline" },
				"audio-model",
				"audio",
			),
		).toEqual({ available: false, reason: "Codex is offline" });
	});
});

describe("providerAdvertisesInput", () => {
	it("finds support in any selectable catalog model", () => {
		const providerWithAudio: ProviderInfo = {
			...provider,
			models: [
				...(provider.models ?? []),
				{
					value: "audio-model",
					label: "Audio Model",
					inputModalities: ["text", "audio"],
				},
			],
		};
		expect(providerAdvertisesInput(providerWithAudio, "audio")).toEqual({
			available: true,
			modelLabel: "Audio Model",
		});
	});

	it("does not advertise a hidden-only input capability", () => {
		expect(
			providerAdvertisesInput(
				{
					...provider,
					models: [
						{
							value: "hidden-audio",
							label: "Hidden Audio",
							hidden: true,
							inputModalities: ["audio"],
						},
					],
				},
				"audio",
			),
		).toEqual({
			available: false,
			reason: "No selectable Claude model advertises audio input.",
		});
	});
});

describe("codexRealtimeAvailability", () => {
	const realtimeProvider: ProviderInfo = {
		id: "codex",
		label: "Codex",
		available: true,
		capabilities: { realtime: true },
	};

	it("requires preview and a realtime-capable Codex provider", () => {
		expect(
			codexRealtimeAvailability(false, realtimeProvider, { available: true }),
		).toEqual({
			available: false,
			reason: "Enable Codex realtime Developer Preview to use Codex dictation.",
		});
		expect(
			codexRealtimeAvailability(
				true,
				{ ...realtimeProvider, capabilities: { realtime: false } },
				{ available: true },
			),
		).toEqual({
			available: false,
			reason:
				"The current Codex provider does not advertise realtime conversation support.",
		});
	});

	it("treats an unknown backend as viable until first use", () => {
		expect(
			codexRealtimeAvailability(true, realtimeProvider, undefined),
		).toEqual({
			available: true,
			reason:
				"Account and backend support will be confirmed when Codex dictation starts.",
		});
	});

	it("uses a known backend failure as the unavailable reason", () => {
		expect(
			codexRealtimeAvailability(true, realtimeProvider, {
				available: false,
				reason: "Realtime is unavailable for this account",
			}),
		).toEqual({
			available: false,
			reason: "Realtime is unavailable for this account",
		});
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

	it("does not backfill another model's effort list for model-scoped providers", () => {
		const modelScoped = { ...provider, effortScope: "model" as const };
		expect(effortOptionsFor(modelScoped, "sonnet")).toEqual([]);
		expect(effortOptionsFor(modelScoped, "missing")).toEqual([]);
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

describe("sessionPermissionOptionsFor", () => {
	const advancedClaude: ProviderInfo = {
		...provider,
		models: [
			{
				value: "sonnet",
				resolvedModel: "claude-sonnet-4-6",
				label: "Sonnet",
				supportsAutoMode: true,
			},
			{ value: "haiku", label: "Haiku" },
		],
		permissionModes: [{ value: "default", label: "Persistent ask" }],
		sessionPermissionModes: [
			{ value: "default", label: "Ask" },
			{ value: "auto", label: "Auto" },
			{ value: "dontAsk", label: "Pre-approved only" },
		],
	};
	const available = (model: string) =>
		sessionPermissionOptionsFor(advancedClaude, {
			model,
			policyEnforced: false,
			usageGateEnforced: false,
		});

	it("uses the session catalog and accepts affirmative raw capability by alias or resolved model", () => {
		expect(available("sonnet").map((mode) => mode.value)).toEqual([
			"default",
			"auto",
			"dontAsk",
		]);
		expect(available("claude-sonnet-4-6").map((mode) => mode.value)).toEqual([
			"default",
			"auto",
			"dontAsk",
		]);
		expect(available("sonnet")[0]?.label).toBe("Ask");
	});

	it("fails Auto closed when raw model capability is missing", () => {
		expect(available("haiku").map((mode) => mode.value)).toEqual([
			"default",
			"dontAsk",
		]);
		expect(available("unknown").map((mode) => mode.value)).toEqual([
			"default",
			"dontAsk",
		]);
		expect(
			sessionPermissionOptionsFor(advancedClaude, {
				model: undefined,
				policyEnforced: false,
				usageGateEnforced: false,
			}).map((mode) => mode.value),
		).toEqual(["default", "dontAsk"]);
	});

	it("hides advanced modes under policy and Auto under the usage gate", () => {
		expect(
			sessionPermissionOptionsFor(advancedClaude, {
				model: "sonnet",
				policyEnforced: true,
				usageGateEnforced: false,
			}).map((mode) => mode.value),
		).toEqual(["default"]);
		expect(
			sessionPermissionOptionsFor(advancedClaude, {
				model: "sonnet",
				policyEnforced: false,
				usageGateEnforced: true,
			}).map((mode) => mode.value),
		).toEqual(["default", "dontAsk"]);
	});

	it("never trusts a routed provider that advertises Claude-only modes", () => {
		expect(
			sessionPermissionOptionsFor(
				{ ...advancedClaude, id: "cliproxy-claude" },
				{
					model: "sonnet",
					policyEnforced: false,
					usageGateEnforced: false,
				},
			).map((mode) => mode.value),
		).toEqual(["default"]);
	});

	it("keeps the legacy list for providers without a separate session catalog", () => {
		expect(
			sessionPermissionOptionsFor(
				{
					id: "codex",
					label: "Codex",
					available: true,
					permissionModes: [{ value: "default", label: "Ask" }],
				},
				{
					model: "gpt-5.6-sol",
					policyEnforced: false,
					usageGateEnforced: false,
				},
			),
		).toEqual([{ value: "default", label: "Ask" }]);
	});
});

describe("permissionModeBadgeLabel", () => {
	it("keeps bypass, Claude Auto, and pre-approved mode distinct", () => {
		expect(permissionModeBadgeLabel("bypassPermissions")).toBe("bypass");
		expect(permissionModeBadgeLabel("auto")).toBe("auto");
		expect(permissionModeBadgeLabel("dontAsk")).toBe("pre-approved");
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
		cliproxy: { model: "kimi-k2.5" },
	};

	it("uses vault configuration instead of whichever session is focused", () => {
		expect(configuredVaultModel(config as never)).toBe("claude-sonnet-4-6");
		expect(
			configuredVaultModel({ ...config, vault_provider: "codex" } as never),
		).toBe("gpt-5.6-sol");
	});

	it("uses the shared routed model for every CLIProxy harness", () => {
		for (const providerId of [
			"cliproxy-codex",
			"cliproxy:codex",
			"cliproxy:opencode",
		]) {
			expect(
				configuredVaultModel({
					...config,
					vault_provider: providerId,
				} as never),
			).toBe("kimi-k2.5");
		}
	});

	it("does not invent a model for providers without vault model fields", () => {
		expect(
			configuredVaultModel({ ...config, vault_provider: "acp:pi" } as never),
		).toBeNull();
	});
});
