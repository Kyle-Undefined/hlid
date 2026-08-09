import type {
	InitializeResponse,
	SessionConfigOption,
	SessionModeState,
} from "@agentclientprotocol/sdk";
import type {
	ProviderCapabilityDiscovery,
	ProviderCapabilityEvidence,
	ProviderCapabilityIntegration,
	ProviderCapabilityMaturity,
} from "../lib/providerCapabilityTypes";
import {
	acpSelectValues,
	findAcpSessionConfigOption as configOption,
} from "./acpSessionConfig";
import { providerCapabilityId } from "./providerCapabilities";

const MAX_CONFIG_OPTIONS = 100;
const MAX_SELECT_VALUES = 200;

function optionalCapability(input: {
	providerId: string;
	segments: string[];
	label: string;
	advertised: boolean;
	integration: ProviderCapabilityIntegration;
	operations: string[];
	maturity?: ProviderCapabilityMaturity;
	advertisedReason?: string;
	notAdvertisedReason?: string;
}): ProviderCapabilityEvidence {
	const reason = input.advertised
		? input.advertisedReason
		: (input.notAdvertisedReason ??
			"The agent did not advertise this capability.");
	return {
		id: providerCapabilityId(input.providerId, ...input.segments),
		label: input.label,
		scope: "session",
		support: input.advertised ? "advertised" : "not-advertised",
		integration: input.integration,
		readiness:
			input.advertised && input.integration !== "not-integrated"
				? "ready"
				: "unavailable",
		source: "provider-runtime",
		maturity: input.maturity ?? "stable",
		operations: input.operations,
		...(reason ? { reason } : {}),
	};
}

function configCapability(input: {
	providerId: string;
	kind: "model" | "mode" | "effort";
	option: SessionConfigOption | undefined;
	issues: string[];
}): ProviderCapabilityEvidence {
	const option = input.option;
	const label =
		input.kind === "model"
			? "Model configuration"
			: input.kind === "mode"
				? "Session mode configuration"
				: "Reasoning effort configuration";
	if (!option) {
		return optionalCapability({
			providerId: input.providerId,
			segments: ["acp-session-config", input.kind],
			label,
			advertised: false,
			integration: "integrated",
			operations: ["list", "select"],
		});
	}
	if (option.type !== "select") {
		return optionalCapability({
			providerId: input.providerId,
			segments: ["acp-session-config", input.kind],
			label,
			advertised: true,
			integration: "not-integrated",
			operations: ["toggle"],
			advertisedReason:
				"The agent advertises a boolean control, but Hlid currently integrates select-based ACP configuration controls only.",
		});
	}

	const selected = acpSelectValues(option, MAX_SELECT_VALUES);
	if (selected.truncated) {
		input.issues.push(
			`ACP ${input.kind} configuration exceeded ${MAX_SELECT_VALUES} values; capability evidence was truncated.`,
		);
	}
	if (input.kind !== "mode") {
		return {
			...optionalCapability({
				providerId: input.providerId,
				segments: ["acp-session-config", input.kind],
				label: `${label} (${selected.values.length})`,
				advertised: true,
				integration: "integrated",
				operations: ["list", "select"],
			}),
			scope: input.kind === "model" ? "provider" : "session",
		};
	}

	const plan = selected.values.find((entry) =>
		[entry.value, entry.name].some(
			(value) =>
				value.trim().toLowerCase() === "plan" ||
				/architect|planning/i.test(value),
		),
	);
	return {
		...optionalCapability({
			providerId: input.providerId,
			segments: ["acp-session-config", input.kind],
			label: `${label} (${selected.values.length})`,
			advertised: true,
			integration: "integrated",
			operations: ["list", "select"],
			advertisedReason: plan
				? "Hlid exposes every advertised mode in Raven and additionally maps the recognized planning value to Raven's Plan control."
				: "Hlid exposes every advertised mode through Raven's provider mode selector.",
		}),
		readiness: "ready",
	};
}

function legacyModeConfigOption(
	modes: SessionModeState | null | undefined,
): SessionConfigOption | undefined {
	if (!modes?.availableModes.length) return undefined;
	return {
		type: "select",
		id: "legacy-session-mode",
		name: "Session mode",
		category: "mode",
		currentValue: modes.currentModeId,
		options: modes.availableModes.map((mode) => ({
			value: mode.id,
			name: mode.name,
			...(mode.description ? { description: mode.description } : {}),
		})),
	};
}

/**
 * Map one already-negotiated ACP initialize/session response into bounded,
 * provider-generic capability evidence. This does not launch or probe an agent.
 */
export function discoverAcpProviderCapabilities(input: {
	providerId: string;
	cwd: string;
	initialized: InitializeResponse;
	configOptions: readonly SessionConfigOption[];
	modes?: SessionModeState | null;
}): ProviderCapabilityDiscovery {
	const capabilities = input.initialized.agentCapabilities;
	const sessions = capabilities?.sessionCapabilities;
	const prompts = capabilities?.promptCapabilities;
	const mcp = capabilities?.mcpCapabilities;
	const authMethodCount = input.initialized.authMethods?.length ?? 0;
	const issues: string[] = [];
	const configOptions = input.configOptions.slice(0, MAX_CONFIG_OPTIONS);
	const stableMode = configOption(
		configOptions,
		"mode",
		/(?:^|[^a-z])mode(?:[^a-z]|$)/i,
	);
	const mode = stableMode ?? legacyModeConfigOption(input.modes);
	if (input.configOptions.length > MAX_CONFIG_OPTIONS) {
		issues.push(
			`ACP returned more than ${MAX_CONFIG_OPTIONS} session configuration options; capability evidence was truncated.`,
		);
	}

	const evidence: ProviderCapabilityEvidence[] = [
		{
			id: providerCapabilityId(input.providerId, "acp-session", "baseline"),
			label: "ACP baseline session protocol",
			scope: "session",
			support: "advertised",
			integration: "integrated",
			readiness: "ready",
			source: "hlid-adapter",
			maturity: "stable",
			operations: ["new", "prompt", "cancel", "update"],
		},
		optionalCapability({
			providerId: input.providerId,
			segments: ["acp-session", "load"],
			label: "Load an existing ACP session",
			advertised: capabilities?.loadSession === true,
			integration: "integrated",
			operations: ["load"],
		}),
		optionalCapability({
			providerId: input.providerId,
			segments: ["acp-session", "resume"],
			label: "Resume an existing ACP session",
			advertised: sessions?.resume != null,
			integration: "integrated",
			operations: ["resume"],
		}),
		optionalCapability({
			providerId: input.providerId,
			segments: ["acp-session", "close"],
			label: "Close an ACP session",
			advertised: sessions?.close != null,
			integration: "integrated",
			operations: ["close"],
		}),
		optionalCapability({
			providerId: input.providerId,
			segments: ["acp-session", "delete"],
			label: "Delete an ACP session",
			advertised: sessions?.delete != null,
			integration: "integrated",
			operations: ["delete"],
		}),
		optionalCapability({
			providerId: input.providerId,
			segments: ["acp-session", "additional-directories"],
			label: "Additional workspace directories",
			advertised: sessions?.additionalDirectories != null,
			integration: "integrated",
			operations: ["new", "load", "resume", "fork"],
		}),
		optionalCapability({
			providerId: input.providerId,
			segments: ["acp-session", "fork"],
			label: "Whole-session ACP fork",
			advertised: sessions?.fork != null,
			integration: "integrated",
			operations: ["fork"],
			maturity: "experimental",
		}),
		optionalCapability({
			providerId: input.providerId,
			segments: ["acp-session", "list"],
			label: "ACP session catalog",
			advertised: sessions?.list != null,
			integration: "not-integrated",
			operations: ["list", "import"],
			advertisedReason:
				"The agent advertises session/list, but Hlid has no ACP session browser or import UI yet.",
			notAdvertisedReason:
				"The agent does not advertise session/list, and Hlid has no ACP session browser or import UI yet.",
		}),
	];

	for (const [kind, advertised] of [
		["image", prompts?.image === true],
		["audio", prompts?.audio === true],
		["embedded-context", prompts?.embeddedContext === true],
	] as const) {
		evidence.push(
			optionalCapability({
				providerId: input.providerId,
				segments: ["acp-prompt", kind],
				label: `Prompt ${kind.replace("-", " ")}`,
				advertised,
				integration: "not-integrated",
				operations: ["prompt"],
				advertisedReason:
					"The agent accepts this prompt content, but Hlid's ACP prompt path currently sends text only.",
			}),
		);
	}

	for (const [transport, advertised, integration, maturity] of [
		["http", mcp?.http === true, "integrated", "stable"],
		["sse", mcp?.sse === true, "integrated", "stable"],
		["acp", mcp?.acp === true, "not-integrated", "experimental"],
	] as const) {
		evidence.push(
			optionalCapability({
				providerId: input.providerId,
				segments: ["acp-mcp-transport", transport],
				label: `${transport.toUpperCase()} MCP transport`,
				advertised,
				integration,
				operations: ["connect"],
				maturity,
				...(transport === "acp" && advertised
					? {
							advertisedReason:
								"The agent advertises experimental MCP-over-ACP, but Hlid does not currently supply ACP-transport MCP servers.",
						}
					: {}),
			}),
		);
	}

	evidence.push(
		{
			...optionalCapability({
				providerId: input.providerId,
				segments: ["acp-auth", "credential-actions"],
				label: `Credential actions (${authMethodCount})`,
				advertised: authMethodCount > 0,
				integration: "integrated",
				operations: ["inspect", "authenticate"],
				advertisedReason:
					"ACP auth methods advertise available credential actions, not whether the provider is currently signed in.",
			}),
			scope: "account",
		},
		{
			id: providerCapabilityId(input.providerId, "acp-auth", "sign-in-status"),
			label: "Provider sign-in status",
			scope: "account",
			support: "unknown",
			integration: "provider-native",
			readiness: "unknown",
			source: "provider-runtime",
			maturity: "unknown",
			operations: ["check-in-provider"],
			reason:
				"ACP does not report current sign-in state; advertised auth methods must not be interpreted as an authentication requirement.",
		},
	);

	evidence.push(
		configCapability({
			providerId: input.providerId,
			kind: "model",
			option: configOption(configOptions, "model", /model/i),
			issues,
		}),
		configCapability({
			providerId: input.providerId,
			kind: "mode",
			option: mode,
			issues,
		}),
		configCapability({
			providerId: input.providerId,
			kind: "effort",
			option: configOption(
				configOptions,
				"thought_level",
				/thought|reason|effort/i,
			),
			issues,
		}),
	);

	return {
		observedAt: Date.now(),
		context: { cwd: input.cwd },
		evidence,
		...(issues.length ? { issues } : {}),
	};
}
