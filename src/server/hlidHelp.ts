import {
	COMMAND_CAPABILITY_REGISTRY,
	type CommandAction,
} from "../lib/commands";
import {
	isClaudeRuntimeProvider,
	isCodexRuntimeProvider,
} from "../lib/providerRuntime";
import type { ProviderInfo } from "../lib/providerTypes";

export const HLID_OPERATING_CONTRACT_VERSION = 1 as const;
export const MAX_HLID_OPERATING_BRIEF_CHARS = 700;
export const MAX_HLID_HELP_RESPONSE_CHARS = 8_000;
export const MAX_HLID_ORCHESTRATION_TARGET_CATALOG_CHARS = 2_600;

const MAX_HLID_ORCHESTRATION_TARGET_PROVIDERS = 12;
const MAX_HLID_ORCHESTRATION_TARGET_MODELS = 8;
const MAX_HLID_ORCHESTRATION_TARGET_EFFORTS = 4;
const MAX_HLID_ORCHESTRATION_TARGET_SERVICE_TIERS = 4;

export const HLID_HELP_TOPICS = [
	"overview",
	"references",
	"permissions",
	"sessions",
	"context",
	"plans_review",
	"workflows",
	"orchestration",
	"goals",
	"relics",
	"project_preview",
	"mcp",
	"skills_extensions",
	"api",
	"computer_use",
	"voice_audio",
	"providers",
] as const;

export type HlidHelpTopic = (typeof HLID_HELP_TOPICS)[number];

export type HlidOperatingContext = {
	providerId?: string;
	model?: string;
	effort?: string;
	permissionMode?: string;
	policyEnforced?: boolean;
	runtimeCwd?: string;
	sessionId?: string;
	vaultName?: string;
	agentMode?: "cwd" | "context";
	codexRealtimeEnabled?: boolean;
	codexRealtimeBackendAvailable?: boolean;
	voiceSnapshot?: {
		state:
			| "disabled"
			| "unconfigured"
			| "unavailable"
			| "loading"
			| "ready"
			| "error";
		model?: string;
	};
	ttsSnapshot?: {
		state:
			| "disabled"
			| "unconfigured"
			| "unavailable"
			| "loading"
			| "ready"
			| "error";
		model?: string;
	};
	registeredHlidTools?: readonly string[];
	providerSnapshot?: ProviderInfo;
	providerCatalog?: readonly ProviderInfo[];
};

type CapabilityAvailability =
	| "available"
	| "unavailable"
	| "conditional"
	| "provider-native";

type ProviderGuidancePointer = {
	providerId: string;
	source:
		| "provider-capability-catalog"
		| "provider-command-catalog"
		| "provider-model-catalog";
};

type HlidCapabilityMode = {
	owner: "hlid" | "provider";
	availability: CapabilityAvailability;
	summary: string;
	providerGuidance?: ProviderGuidancePointer;
};

type HlidCapability = {
	id: HlidHelpTopic;
	owner: "hlid" | "provider";
	availability: CapabilityAvailability;
	summary: string;
	modes?: Record<string, HlidCapabilityMode>;
	providerGuidance?: ProviderGuidancePointer;
};

type HlidOrchestrationModelTarget = {
	value: string;
	label: string;
	isDefault?: boolean;
	efforts?: HlidExactOptionCatalog;
	serviceTiers?: HlidExactOptionCatalog;
};

type HlidExactOptionCatalog = {
	total: number;
	returned: number;
	truncated: boolean;
	items: string[];
};

type HlidOrchestrationProviderTarget = {
	id: string;
	label: string;
	available: boolean;
	unavailableReason?: string;
	effortLevels?: HlidExactOptionCatalog;
	models: {
		total: number;
		returned: number;
		truncated: boolean;
		items: HlidOrchestrationModelTarget[];
	};
};

export type HlidOrchestrationTargetCatalog = {
	source: "live-provider-catalog";
	snapshot: "current" | "unavailable";
	totalProviders: number;
	availableProviders: number;
	returnedProviders: number;
	truncated: boolean;
	providers: HlidOrchestrationProviderTarget[];
};

export type HlidCapabilityManifest = {
	contractVersion: typeof HLID_OPERATING_CONTRACT_VERSION;
	runtime: {
		providerId: string;
		providerRuntime: "claude" | "codex" | "acp" | "external";
		environment: "windows" | "wsl" | "host" | "unknown";
		model?: string;
		effort?: string;
		sessionScoped: boolean;
	};
	permissions: {
		mode: string;
		policyEnforced: boolean;
		owner: "hlid-and-provider" | "provider";
	};
	references: {
		vaultConfigured: boolean;
		workspaceAvailable: boolean;
		exactSelections: true;
		relatedExpansion: "only-when-requested";
	};
	registry: {
		revision: string;
		commandActions: CommandAction[];
		hlidTools: string[];
		providerSnapshot: "current" | "unavailable";
	};
	capabilities: HlidCapability[];
	orchestrationTargets: HlidOrchestrationTargetCatalog;
	helpTopics: readonly HlidHelpTopic[];
};

function providerRuntime(
	providerId: string,
): HlidCapabilityManifest["runtime"]["providerRuntime"] {
	if (isClaudeRuntimeProvider(providerId)) return "claude";
	if (isCodexRuntimeProvider(providerId)) return "codex";
	if (providerId === "acp" || providerId.startsWith("acp:")) return "acp";
	return "external";
}

function commandAllowedForProvider(
	action: CommandAction,
	providerId: string,
): boolean {
	const capability = COMMAND_CAPABILITY_REGISTRY[action];
	return !capability.providerIds || capability.providerIds.includes(providerId);
}

function activeCommandActions(
	providerId: string,
	provider: ProviderInfo | undefined,
): CommandAction[] {
	const providerCapabilities = provider?.capabilities;
	const hostCapabilities = provider?.hostCapabilities;
	return Object.values(COMMAND_CAPABILITY_REGISTRY)
		.filter((capability) => {
			if (!commandAllowedForProvider(capability.name, providerId)) return false;
			if (capability.owner === "hlid") {
				if (capability.name === "workflows") {
					return (
						provider?.available !== false &&
						providerCapabilities?.workflowCatalog === true
					);
				}
				return true;
			}
			if (provider?.available === false) return false;
			if (capability.name === "goal") {
				return providerCapabilities?.goalControl === true;
			}
			if (capability.name === "compact" || capability.name === "review") {
				return providerCapabilities?.structuredActivities?.includes(
					capability.name,
				);
			}
			if (capability.name === "computer-use") {
				return hostCapabilities?.windowsComputerUse?.available === true;
			}
			return false;
		})
		.map((capability) => capability.name)
		.sort();
}

function canonicalRegistryValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalRegistryValue);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, item]) => [key, canonicalRegistryValue(item)]),
		);
	}
	return value;
}

function revisionFor(value: unknown): string {
	const serialized = JSON.stringify(canonicalRegistryValue(value));
	let hash = 0x811c9dc5;
	for (let index = 0; index < serialized.length; index += 1) {
		hash ^= serialized.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return `v${HLID_OPERATING_CONTRACT_VERSION}-${(hash >>> 0)
		.toString(16)
		.padStart(8, "0")}`;
}

function toolAvailability(
	tools: ReadonlySet<string> | null,
	required: readonly string[],
): CapabilityAvailability {
	if (!tools) return "conditional";
	return required.every((name) => tools.has(name))
		? "available"
		: "unavailable";
}

function buildOrchestrationTargetCatalog(
	providerCatalog: readonly ProviderInfo[] | undefined,
	maxChars = MAX_HLID_ORCHESTRATION_TARGET_CATALOG_CHARS,
): HlidOrchestrationTargetCatalog {
	if (!providerCatalog) {
		return {
			source: "live-provider-catalog",
			snapshot: "unavailable",
			totalProviders: 0,
			availableProviders: 0,
			returnedProviders: 0,
			truncated: false,
			providers: [],
		};
	}

	const totalProviders = providerCatalog.length;
	const availableProviders = providerCatalog.filter(
		(provider) => provider.available,
	).length;
	const orderedProviders = providerCatalog
		.map((provider, index) => ({ provider, index }))
		.sort(
			(left, right) =>
				Number(right.provider.available) - Number(left.provider.available) ||
				left.index - right.index,
		)
		.slice(0, MAX_HLID_ORCHESTRATION_TARGET_PROVIDERS);
	const providers: HlidOrchestrationProviderTarget[] = [];
	const catalogWith = (
		items: HlidOrchestrationProviderTarget[],
	): HlidOrchestrationTargetCatalog => ({
		source: "live-provider-catalog",
		snapshot: "current",
		totalProviders,
		availableProviders,
		returnedProviders: items.length,
		truncated: items.length < totalProviders,
		providers: items,
	});

	for (const { provider } of orderedProviders) {
		const models = (provider.models ?? []).filter((model) => !model.hidden);
		const providerEfforts = provider.effortLevels ?? [];
		let entry: HlidOrchestrationProviderTarget = {
			id: provider.id,
			label: boundedValue(provider.label, 80),
			available: provider.available,
			...(provider.unavailableReason
				? {
						unavailableReason: boundedValue(provider.unavailableReason, 160),
					}
				: {}),
			...(providerEfforts.length
				? {
						effortLevels: {
							total: providerEfforts.length,
							returned: 0,
							truncated: true,
							items: [],
						},
					}
				: {}),
			models: {
				total: models.length,
				returned: 0,
				truncated: models.length > 0,
				items: [],
			},
		};
		if (JSON.stringify(catalogWith([...providers, entry])).length > maxChars) {
			continue;
		}

		for (const model of models.slice(0, MAX_HLID_ORCHESTRATION_TARGET_MODELS)) {
			const modelEfforts = model.efforts ?? [];
			const modelServiceTiers = model.serviceTiers ?? [];
			let modelTarget: HlidOrchestrationModelTarget = {
				value: model.value,
				label: boundedValue(model.label, 80),
				...(model.isDefault ? { isDefault: true } : {}),
				...(modelEfforts.length
					? {
							efforts: {
								total: modelEfforts.length,
								returned: 0,
								truncated: true,
								items: [],
							},
						}
					: {}),
				...(modelServiceTiers.length
					? {
							serviceTiers: {
								total: modelServiceTiers.length,
								returned: 0,
								truncated: true,
								items: [],
							},
						}
					: {}),
			};
			const withModel = (target: HlidOrchestrationModelTarget) => {
				const items = [...entry.models.items, target];
				return {
					...entry,
					models: {
						total: models.length,
						returned: items.length,
						truncated: items.length < models.length,
						items,
					},
				};
			};
			if (
				JSON.stringify(catalogWith([...providers, withModel(modelTarget)]))
					.length > maxChars
			) {
				continue;
			}
			for (const effort of modelEfforts.slice(
				0,
				MAX_HLID_ORCHESTRATION_TARGET_EFFORTS,
			)) {
				const items = [...(modelTarget.efforts?.items ?? []), effort.value];
				const candidate: HlidOrchestrationModelTarget = {
					...modelTarget,
					efforts: {
						total: modelEfforts.length,
						returned: items.length,
						truncated: items.length < modelEfforts.length,
						items,
					},
				};
				if (
					JSON.stringify(catalogWith([...providers, withModel(candidate)]))
						.length > maxChars
				) {
					break;
				}
				modelTarget = candidate;
			}
			for (const serviceTier of modelServiceTiers.slice(
				0,
				MAX_HLID_ORCHESTRATION_TARGET_SERVICE_TIERS,
			)) {
				const items = [
					...(modelTarget.serviceTiers?.items ?? []),
					serviceTier.value,
				];
				const candidate: HlidOrchestrationModelTarget = {
					...modelTarget,
					serviceTiers: {
						total: modelServiceTiers.length,
						returned: items.length,
						truncated: items.length < modelServiceTiers.length,
						items,
					},
				};
				if (
					JSON.stringify(catalogWith([...providers, withModel(candidate)]))
						.length > maxChars
				) {
					break;
				}
				modelTarget = candidate;
			}
			entry = withModel(modelTarget);
		}

		for (const effort of providerEfforts.slice(
			0,
			MAX_HLID_ORCHESTRATION_TARGET_EFFORTS,
		)) {
			const items = [...(entry.effortLevels?.items ?? []), effort.value];
			const candidate: HlidOrchestrationProviderTarget = {
				...entry,
				effortLevels: {
					total: providerEfforts.length,
					returned: items.length,
					truncated: items.length < providerEfforts.length,
					items,
				},
			};
			if (
				JSON.stringify(catalogWith([...providers, candidate])).length > maxChars
			) {
				break;
			}
			entry = candidate;
		}
		providers.push(entry);
	}

	return catalogWith(providers);
}

function runtimeEnvironment(
	runtimeCwd: string | undefined,
): HlidCapabilityManifest["runtime"]["environment"] {
	if (
		process.platform === "win32" ||
		/^[A-Za-z]:[\\/]/.test(runtimeCwd ?? "")
	) {
		return "windows";
	}
	if (process.env.WSL_DISTRO_NAME || (runtimeCwd ?? "").startsWith("/mnt/")) {
		return "wsl";
	}
	if (runtimeCwd) return "host";
	return "unknown";
}

export function buildHlidCapabilityManifest(
	context: HlidOperatingContext,
): HlidCapabilityManifest {
	const providerId = context.providerId?.trim() || "external";
	const runtime = providerRuntime(providerId);
	const sessionScoped = Boolean(context.sessionId);
	const workspaceAvailable = Boolean(context.runtimeCwd);
	const vaultConfigured = Boolean(context.vaultName?.trim());
	const provider = context.providerSnapshot;
	const orchestrationTargets = buildOrchestrationTargetCatalog(
		context.providerCatalog,
	);
	const commandActions = activeCommandActions(providerId, provider);
	const commands = new Set(commandActions);
	const toolNames = context.registeredHlidTools
		? [...new Set(context.registeredHlidTools)].sort()
		: [];
	const tools = context.registeredHlidTools
		? new Set(context.registeredHlidTools)
		: null;
	const orchestrationToolAvailability =
		sessionScoped && workspaceAvailable
			? toolAvailability(tools, [
					"delegate_hlid_agent",
					"list_hlid_agents",
					"inspect_hlid_agent",
					"wait_hlid_agent",
					"steer_hlid_agent",
					"cancel_hlid_agent",
					"resume_hlid_agent",
				])
			: "conditional";
	const orchestrationAvailability: CapabilityAvailability =
		orchestrationToolAvailability !== "available"
			? orchestrationToolAvailability
			: orchestrationTargets.snapshot !== "current"
				? "conditional"
				: orchestrationTargets.availableProviders > 0
					? "available"
					: "unavailable";
	const workflowsAvailable = commands.has("workflows");
	const goalsAvailable = commands.has("goal");
	const computerUse = provider?.hostCapabilities?.windowsComputerUse;
	const selectedModel = provider?.models?.find(
		(model) => model.value === context.model,
	);
	const modelAudioAvailable = selectedModel?.inputModalities?.includes("audio");
	const providerRealtime = provider?.capabilities?.realtime === true;
	const providerGuidance = (
		source: ProviderGuidancePointer["source"],
	): ProviderGuidancePointer => ({
		providerId: boundedValue(providerId, 120),
		source,
	});
	const localDictationAvailability: CapabilityAvailability =
		context.voiceSnapshot?.state === "ready"
			? "available"
			: context.voiceSnapshot?.state === "loading" ||
					context.voiceSnapshot === undefined
				? "conditional"
				: "unavailable";
	const localReadAloudAvailability: CapabilityAvailability =
		context.ttsSnapshot?.state === "ready"
			? "available"
			: context.ttsSnapshot?.state === "loading" ||
					context.ttsSnapshot === undefined
				? "conditional"
				: "unavailable";
	const nativeAudioAvailability: CapabilityAvailability =
		provider?.available === false || modelAudioAvailable === false
			? "unavailable"
			: modelAudioAvailable === true
				? "provider-native"
				: "conditional";
	const realtimeAvailable =
		providerRealtime &&
		context.codexRealtimeEnabled === true &&
		modelAudioAvailable === true &&
		context.codexRealtimeBackendAvailable === true;
	const realtimeClientReady =
		providerRealtime &&
		context.codexRealtimeEnabled === true &&
		modelAudioAvailable === true;
	const ravenLiveAvailability: CapabilityAvailability = realtimeAvailable
		? "provider-native"
		: realtimeClientReady ||
				(providerRealtime &&
					context.codexRealtimeEnabled === true &&
					modelAudioAvailable === undefined)
			? "conditional"
			: "unavailable";
	const voiceAvailability: CapabilityAvailability = [
		localDictationAvailability,
		localReadAloudAvailability,
		nativeAudioAvailability,
		ravenLiveAvailability,
	].some(
		(availability) =>
			availability === "available" || availability === "provider-native",
	)
		? "available"
		: [
					localDictationAvailability,
					localReadAloudAvailability,
					nativeAudioAvailability,
					ravenLiveAvailability,
				].includes("conditional")
			? "conditional"
			: "unavailable";
	const hostCapabilities = provider?.hostCapabilities
		? Object.fromEntries(
				Object.entries(provider.hostCapabilities).map(([key, capability]) => [
					boundedValue(key, 120),
					{
						label: boundedValue(capability.label, 160),
						available: capability.available,
						...(capability.reason
							? { reason: boundedValue(capability.reason, 300) }
							: {}),
					},
				]),
			)
		: undefined;
	const registrySnapshot = {
		commandActions,
		hlidTools: toolNames,
		provider: provider
			? {
					id: boundedValue(provider.id, 120),
					available: provider.available,
					capabilities: provider.capabilities
						? {
								...provider.capabilities,
								structuredActivities: provider.capabilities.structuredActivities
									?.slice()
									.sort(),
							}
						: undefined,
					forkCapability: provider.forkCapability,
					hostCapabilities,
					selectedModel: selectedModel
						? {
								value: boundedValue(selectedModel.value, 200),
								inputModalities: selectedModel.inputModalities?.slice().sort(),
							}
						: undefined,
				}
			: null,
		voice: context.voiceSnapshot
			? {
					state: context.voiceSnapshot.state,
					model: context.voiceSnapshot.model
						? boundedValue(context.voiceSnapshot.model, 200)
						: undefined,
				}
			: null,
		tts: context.ttsSnapshot
			? {
					state: context.ttsSnapshot.state,
					model: context.ttsSnapshot.model
						? boundedValue(context.ttsSnapshot.model, 200)
						: undefined,
				}
			: null,
		features: {
			codexRealtimeEnabled: context.codexRealtimeEnabled ?? false,
			codexRealtimeBackendAvailable:
				context.codexRealtimeBackendAvailable ?? false,
		},
		orchestrationTargets,
	};
	return {
		contractVersion: HLID_OPERATING_CONTRACT_VERSION,
		runtime: {
			providerId: boundedValue(providerId, 120),
			providerRuntime: runtime,
			environment: runtimeEnvironment(context.runtimeCwd),
			...(context.model ? { model: boundedValue(context.model, 200) } : {}),
			...(context.effort ? { effort: boundedValue(context.effort, 80) } : {}),
			sessionScoped,
		},
		permissions: {
			mode: boundedValue(context.permissionMode ?? "provider-default", 80),
			policyEnforced: context.policyEnforced ?? false,
			owner: sessionScoped ? "hlid-and-provider" : "provider",
		},
		references: {
			vaultConfigured,
			workspaceAvailable,
			exactSelections: true,
			relatedExpansion: "only-when-requested",
		},
		registry: {
			revision: revisionFor(registrySnapshot),
			commandActions,
			hlidTools: toolNames,
			providerSnapshot: provider ? "current" : "unavailable",
		},
		capabilities: [
			{
				id: "references",
				owner: "hlid",
				availability:
					vaultConfigured || workspaceAvailable ? "available" : "conditional",
				summary:
					"Vault and Workspace @ references are exact selections. Links, neighbors, imports, and related files stay out of scope unless the user asks.",
			},
			{
				id: "permissions",
				owner: sessionScoped ? "hlid" : "provider",
				availability: "available",
				summary:
					"Hlid applies its active approval policy around provider-native permission behavior. Mutations remain subject to the active policy.",
			},
			{
				id: "sessions",
				owner: "hlid",
				availability:
					sessionScoped && commands.has("rename") && commands.has("archive")
						? "available"
						: "unavailable",
				summary:
					"Raven sessions own transcript persistence, rename, archive, exact fork provenance, usage, and retained Relic links.",
			},
			{
				id: "context",
				owner: "hlid",
				availability:
					sessionScoped && commands.has("context")
						? "available"
						: "conditional",
				summary:
					"Hlid records a bounded receipt of the context it adds to each turn. Raven exposes it through /context without adding the receipt to the provider transcript.",
			},
			{
				id: "plans_review",
				owner: "hlid",
				availability: sessionScoped ? "available" : "conditional",
				summary:
					"Hlid presents provider plan decisions and optional HTML plan documents through one approve, revise, or cancel lifecycle.",
			},
			{
				id: "workflows",
				owner: "provider",
				availability: workflowsAvailable ? "provider-native" : "unavailable",
				providerGuidance: providerGuidance("provider-command-catalog"),
				summary: workflowsAvailable
					? "Claude Dynamic Workflows remain provider-native; Hlid supplies the Raven lifecycle and review surface."
					: "The active provider does not expose Claude Dynamic Workflows.",
			},
			{
				id: "orchestration",
				owner: "hlid",
				availability: orchestrationAvailability,
				summary:
					"Hlid can create nested durable Raven children across registered providers and exact configured workspaces, with bounded depth, explicit model, effort, and service-tier selection, explicit handoff, independent transcripts, passive usage reporting, native steering when available, explicit cancellation, restart continuation, provenance, and bounded results. Focused orchestration help includes a bounded snapshot of the live target provider and model catalog.",
			},
			{
				id: "goals",
				owner: "provider",
				availability: goalsAvailable ? "provider-native" : "unavailable",
				providerGuidance: providerGuidance("provider-capability-catalog"),
				summary: goalsAvailable
					? "Goals use Codex's native goal lifecycle; Hlid displays and persists the live provider state."
					: "The active provider does not expose Codex native goals.",
			},
			{
				id: "relics",
				owner: "hlid",
				availability: toolAvailability(tools, ["publish_relic"]),
				summary:
					"Agent-generated reports and durable deliverables can be published to Hlid Relics. Ordinary source files do not belong there.",
			},
			{
				id: "project_preview",
				owner: "hlid",
				availability:
					sessionScoped && workspaceAvailable
						? toolAvailability(tools, [
								"start_project_preview",
								"inspect_project_preview",
								"capture_project_preview",
								"control_project_preview",
								"stop_project_preview",
							])
						: "conditional",
				summary:
					"Project Preview can run, present, inspect, capture, and interact with a session-scoped web project from the active workspace.",
			},
			{
				id: "mcp",
				owner: "hlid",
				availability: commands.has("mcp") ? "available" : "unavailable",
				summary:
					"Hlid discovers and reviews provider MCP state without flattening provider-native server semantics.",
			},
			{
				id: "skills_extensions",
				owner: "hlid",
				availability: "available",
				summary:
					"Hlid keeps selected prompt skills, managed skill packages, and provider-native extensions distinct while supplying shared discovery and review flows.",
			},
			{
				id: "api",
				owner: "hlid",
				availability: toolAvailability(tools, ["hlid_api"]),
				summary:
					"Hlid exposes a curated live HTTP catalog through /api-index. Use hlid_api to discover only the endpoints relevant to the task.",
			},
			{
				id: "computer_use",
				owner: "hlid",
				availability:
					computerUse?.available === true
						? "available"
						: provider
							? "unavailable"
							: "conditional",
				summary:
					computerUse?.available === true
						? "Windows Computer Use is available through a fresh Windows-native Codex worker with Hlid and native per-app approval boundaries."
						: `Windows Computer Use is not currently proven available${
								computerUse?.reason
									? `: ${boundedValue(computerUse.reason, 300)}`
									: "."
							}`,
			},
			{
				id: "voice_audio",
				owner: "hlid",
				availability: voiceAvailability,
				summary:
					"Voice is reported as separate local dictation, local neural read aloud, provider-native audio input, and Raven Live modes.",
				modes: {
					local_dictation: {
						owner: "hlid",
						availability: localDictationAvailability,
						summary:
							context.voiceSnapshot?.state === "ready"
								? "Local Whisper dictation is ready."
								: context.voiceSnapshot?.state === "loading"
									? "The configured local Whisper model is loading."
									: context.voiceSnapshot
										? `Local Whisper dictation is ${context.voiceSnapshot.state}.`
										: "Local Whisper status is not available in this snapshot.",
					},
					local_read_aloud: {
						owner: "hlid",
						availability: localReadAloudAvailability,
						summary:
							context.ttsSnapshot?.state === "ready"
								? "Local neural read aloud is ready."
								: context.ttsSnapshot?.state === "loading"
									? "The configured local neural speech model is loading."
									: context.ttsSnapshot
										? `Local neural read aloud is ${context.ttsSnapshot.state}.`
										: "Local neural read-aloud status is not available in this snapshot.",
					},
					native_audio_input: {
						owner: "provider",
						availability: nativeAudioAvailability,
						providerGuidance: providerGuidance("provider-model-catalog"),
						summary:
							modelAudioAvailable === true
								? "The selected provider model advertises native audio input."
								: modelAudioAvailable === false
									? "The selected provider model does not advertise native audio input."
									: "Native audio input depends on the selected provider model's current modalities.",
					},
					raven_live: {
						owner: "provider",
						availability: ravenLiveAvailability,
						providerGuidance: providerGuidance("provider-capability-catalog"),
						summary: realtimeAvailable
							? "Raven Live is supported by the active provider transport, selected model, Hlid feature flag, and backend."
							: realtimeClientReady
								? "Raven Live is client-ready; backend availability is confirmed only when the realtime session starts."
								: "Raven Live requires a supporting provider transport, the Hlid feature flag, an audio-capable model, and backend availability.",
					},
				},
			},
			{
				id: "providers",
				owner: "provider",
				availability:
					provider?.available === false
						? "unavailable"
						: provider
							? "provider-native"
							: "conditional",
				providerGuidance: providerGuidance("provider-capability-catalog"),
				summary:
					"Claude, Codex, ACP, and future providers retain their own commands, hidden context, forks, models, and lifecycle limits.",
			},
		],
		orchestrationTargets,
		helpTopics: HLID_HELP_TOPICS,
	};
}

const TOPIC_GUIDANCE: Record<HlidHelpTopic, string[]> = {
	overview: [
		"Use focused help topics instead of loading a cross-provider manual.",
		"Treat unavailable capabilities as unavailable; do not simulate provider-native behavior.",
	],
	references: [
		"Hlid @ references select exact Vault notes or Workspace files.",
		"Do not expand links, backlinks, embeds, attachments, imports, neighboring files, directories, or Git history unless the user asks.",
		"Use hlid_obsidian for supported Vault operations instead of shell or filesystem access.",
	],
	permissions: [
		"Hlid approval policy and provider-native permissions are separate layers.",
		"A tool being available does not imply a mutation is pre-approved.",
		"Use the active session policy and preserve provider-native safety boundaries.",
	],
	sessions: [
		"Rename and archive are Hlid-owned metadata operations and stay outside provider transcripts.",
		"Exact forks are exposed only when the provider preserves native hidden context.",
		"Archive is reversible; delete follows retention rules.",
	],
	context: [
		"Hlid adds only the operating brief and the exact instructions, references, skills, attachments, or plan guidance selected for the turn.",
		"Use Raven /context to inspect the persisted receipt: character and token estimates, context blocks, exact references, attachment delivery, provider handoff size, and deferred tool counts.",
		"The receipt is Hlid metadata stored outside the visible provider transcript. Inspecting it does not send another prompt to the provider.",
		"Claude and Codex defer Hlid and Obsidian tool schemas until discovery. ACP receives registered MCP tool schemas because its current transport has no equivalent deferred-loading contract.",
	],
	plans_review: [
		"Provider-native planning remains native; Hlid owns the shared presentation and decision lifecycle.",
		"A completed plan can be approved for implementation, returned with requested revisions, or cancelled.",
		"Optional HTML plans are written to one Hlid-owned path, ingested into a sandboxed review surface, and remain separate from ordinary HTML reports published to Relics.",
		"Provider-native working-tree review is a separate provider activity and must not be presented as plan approval.",
	],
	workflows: [
		"Dynamic Workflows are Claude-native.",
		"Hlid owns their Raven presentation, parent-child correlation, lifecycle controls, and retained transcript state.",
	],
	orchestration: [
		"Choose the exact provider ID and optional model, effort, and model service-tier values from orchestrationTargets. This is a bounded snapshot of the live provider catalog; do not guess unavailable or truncated entries.",
		"For Codex user-input children, set permission_mode=plan: request_user_input is unavailable in default mode. A question-only turn does not enter plan review without a real plan.",
		"Use provider-native same-provider subagents when a durable Raven child is unnecessary. Hlid delegation is an explicit ordinary child session.",
		"Delegation is bounded to three levels, four active direct children per parent, and twelve active delegated children across Hlid. The ordinary session pool has its own separate capacity. Children default to the parent workspace; cwd may select only the exact configured vault or a registered workspace. Permissions must be inherited or narrower.",
		"Visible transcript, selected skills, durable Relics, and exact current-turn Vault or Workspace references are empty by default and require explicit handoff switches. Hlid never expands an exact selection, borrows an ordinary upload, or claims hidden provider context moved.",
		"Hlid imposes no elapsed-time or inactivity cap on delegated work because cross-provider silence is not proof that a child is unresponsive. New runs do not accept timeout_seconds, token_budget, or cost_budget, and do not transition automatically to timed_out or budget_exhausted. Historical snapshots may retain inert timeout_seconds, token_budget, or cost_budget values and timed_out or budget_exhausted states for compatibility. Provider availability is checked before launch. Native launch, transport, or process failures settle the child naturally. Explicit cancel_hlid_agent is the way to stop work. Hlid passively records provider-reported token usage and available cost without using either as a lifecycle cap.",
		"steer_hlid_agent uses only the active provider's native same-turn steering primitive. Unsupported providers return unavailable; Hlid does not substitute cancellation or a queued fresh turn.",
		"cancel_hlid_agent requests cancellation of the addressed child and every active nested descendant immediately. Hlid retains provider control, delegation ownership, and active capacity until each provider turn settles, then persists terminal cancelled state. For a resumable restart-interrupted child with no active provider turn, cancel explicitly abandons continuation and marks it cancelled immediately while retaining its Raven transcript and Ledger provenance. Closing that interrupted child from the live-session surface has the same abandonment semantics. A terminal ancestor stays terminal while active descendants stop. After restart, active work becomes interrupted instead of being replayed.",
		"Children remain independent after the parent turn finishes, the browser disconnects, or the parent is archived. Those events do not imply cancellation. Deleting a parent is blocked while delegated descendants remain; use cancel_hlid_agent when the work should stop.",
		"Parent rollups retain bounded durable waiting, completed, and failed descendant counts. Completed and failed child sessions remain ordinary Raven and Ledger history; Hlid does not present them as live provider processes.",
		"Scheduled Routines may delegate after the delegation call passes both the reviewed Routine envelope and Umbod. Detached descendants share the exact per-run Routine context, grant-use counters, and action-required callback while the Routine run owns their lifecycle after its parent provider turn closes. A late unmatched action pauses the Routine and cancels its remaining children. Restart-interrupted Routine children cannot be continued outside the ended run.",
		"resume_hlid_agent starts an explicit new turn only for a restart-interrupted non-Routine child with a remaining attempt and from a live running parent turn. It revalidates the recorded configured workspace plus provider, model, effort, and service tier, enforces inherited or narrower permissions and active-capacity limits, and supplies bounded visible child transcript context without inheriting references or Relics.",
		"delegate_hlid_agent returns immediately and its parent card retains a bounded current step. Use list_hlid_agents for compact lifecycle and result-availability snapshots; use inspect_hlid_agent or wait_hlid_agent for bounded active progress and terminal result, partial result, and error details.",
	],
	goals: [
		"Goals are Codex-native state, not prompt conventions.",
		"Hlid reflects provider goal status, usage, pause, resume, update, and clear operations.",
	],
	relics: [
		"Publish durable agent-generated reports or outputs to Relics.",
		"Do not publish ordinary source files or use Relics as a substitute for workspace edits.",
	],
	project_preview: [
		"Start one session-scoped web server, then inspect or interact through Hlid's managed Preview browser.",
		"Preview tools are bounded to the active workspace, session, and preview-local routes.",
	],
	mcp: [
		"MCP inventory and controls are provider-scoped.",
		"Do not infer that identical server names imply identical provider behavior or configuration.",
	],
	skills_extensions: [
		"Selected Vault, library, or provider skills are prompt context for the current turn; package instructions remain the package author's contract.",
		"Hlid-managed skills are staged and reviewed before installation, stored in Hlid's managed library, and can be selected in Raven or Watch.",
		"Claude and Codex extensions remain provider-native packages with their own marketplaces, scopes, enablement, executable behavior, and update limits.",
		"Do not flatten skills, extensions, MCP servers, commands, hooks, or agents into one universal plugin model.",
	],
	api: [
		"Use hlid_api for bounded, live endpoint discovery instead of loading or memorizing the full HTTP catalog.",
		"The data and UI listeners can use different ports. Follow the live base URLs returned by hlid_api.",
		"GET endpoints are generally observational. POST, PATCH, and DELETE endpoints can mutate state and remain subject to active permissions and endpoint-specific requirements.",
		"Prefer a curated Hlid tool when one exists; use the HTTP API for direct Hlid integration and capabilities without a dedicated tool.",
	],
	computer_use: [
		"Windows Computer Use is Hlid-owned delegation into a fresh Windows-native Codex worker, not a command executed inside the current WSL or provider process.",
		"Availability requires a Windows host, native Codex CLI, and the installed and enabled Computer Use plugin. Hlid and native per-application approvals both remain active.",
		"The worker closes after the task while its progress, usage, duration, and estimated cost remain associated with Hlid.",
	],
	voice_audio: [
		"Local Whisper dictation is user input and is separate from provider-native audio turns or Raven Live.",
		"Local neural read aloud is host-generated output. It uses its own downloaded model and runtime, independently of Whisper input and provider-native audio.",
		"Native Codex audio requires an audio-capable selected model. Raven Live additionally requires the Hlid feature flag and provider backend support.",
		"Do not claim audio or realtime availability from the provider name alone; use the live capability state.",
	],
	providers: [
		"Provider-native operations remain native and capability-gated.",
		"Never present transcript replay as an exact fork or a prompt convention as a structured provider operation.",
		"When a Raven session changes provider, Hlid can supply a bounded visible-transcript handoff. Native hidden context does not cross that boundary.",
		"Compaction and working-tree review use structured provider activity only when the active provider advertises support.",
	],
};

function boundedJson(value: unknown, maxChars: number): string {
	const serialized = JSON.stringify(value);
	if (serialized.length <= maxChars) return serialized;
	throw new Error(
		`Hlid help response exceeded its ${maxChars}-character budget.`,
	);
}

export function buildHlidHelpResponse(
	topic: HlidHelpTopic,
	context: HlidOperatingContext,
): string {
	const manifest = buildHlidCapabilityManifest(context);
	const capability =
		topic === "overview"
			? manifest.capabilities
			: manifest.capabilities.filter((item) => item.id === topic);
	const shared = {
		contractVersion: manifest.contractVersion,
		topic,
		runtime: manifest.runtime,
		permissions: manifest.permissions,
		references: manifest.references,
		registry: manifest.registry,
		capabilities: capability,
	};
	const tail = {
		guidance: TOPIC_GUIDANCE[topic],
		relatedTopics: manifest.helpTopics.filter((item) => item !== topic),
	};
	if (topic !== "orchestration") {
		return boundedJson({ ...shared, ...tail }, MAX_HLID_HELP_RESPONSE_CHARS);
	}

	// The live runtime and registry fields vary in size. Reserve their exact
	// serialized footprint first, then use only the remaining response budget
	// for target projection so a rich live catalog cannot make focused help fail.
	const withPlaceholder = JSON.stringify({
		...shared,
		orchestrationTargets: null,
		...tail,
	});
	const fixedChars = withPlaceholder.length - JSON.stringify(null).length;
	const targetBudget = Math.min(
		MAX_HLID_ORCHESTRATION_TARGET_CATALOG_CHARS,
		MAX_HLID_HELP_RESPONSE_CHARS - fixedChars,
	);
	const orchestrationTargets = buildOrchestrationTargetCatalog(
		context.providerCatalog,
		targetBudget,
	);
	return boundedJson(
		{ ...shared, orchestrationTargets, ...tail },
		MAX_HLID_HELP_RESPONSE_CHARS,
	);
}

function boundedValue(value: string | undefined, maxChars: number): string {
	const trimmed = value?.trim();
	if (!trimmed) return "unspecified";
	return trimmed.length <= maxChars
		? trimmed
		: `${trimmed.slice(0, maxChars - 1)}…`;
}

export type HlidOperatingBriefResult = {
	text: string;
	preview: string;
	revision: string;
};

export function buildHlidOperatingBriefResult(
	context: HlidOperatingContext,
): HlidOperatingBriefResult {
	const vault = context.vaultName?.trim()
		? ` The configured Obsidian vault is ${JSON.stringify(
				boundedValue(context.vaultName, 50),
			)}.`
		: "";
	const brief = `Hlid operating brief (v${HLID_OPERATING_CONTRACT_VERSION}):
- Hlid @ references are exact selections. Do not expand links, backlinks, embeds, attachments, imports, neighboring files, or related content unless the user asks.${vault}
- Hlid owns shared session, delegation, approval, Relic, Project Preview, and reference flows. Provider-native capabilities keep their own semantics.
- Use hlid_help for current capability availability and focused operating guidance. Do not infer unavailable features.`;
	if (brief.length > MAX_HLID_OPERATING_BRIEF_CHARS) {
		throw new Error(
			`Hlid operating brief exceeded its ${MAX_HLID_OPERATING_BRIEF_CHARS}-character budget.`,
		);
	}
	return {
		text: brief,
		preview: brief,
		revision: revisionFor({ kind: "operating-brief", text: brief }),
	};
}
