import {
	COMMAND_CAPABILITY_REGISTRY,
	type CommandAction,
} from "../lib/commands";
import { explicitPathEnvironment } from "../lib/paths";
import {
	isClaudeRuntimeProvider,
	isCodexRuntimeProvider,
} from "../lib/providerRuntime";
import type { ProviderInfo } from "../lib/providerTypes";
import type {
	HlidCapabilityManifest,
	HlidHelpTopic,
	HlidOperatingContext,
} from "./hlidHelp";
import { boundedValue, revisionFor } from "./hlidHelpValue";
import { buildOrchestrationTargetCatalog } from "./hlidOrchestrationTargets";
import { providerCapabilityId } from "./providerCapabilities";

type Capability = HlidCapabilityManifest["capabilities"][number];
type Availability = Capability["availability"];
type Guidance = NonNullable<Capability["providerGuidance"]>;
type CapabilityMode = NonNullable<Capability["modes"]>[string];
type SelectedModel = NonNullable<ProviderInfo["models"]>[number];

type ManifestBuildOptions = {
	contractVersion: HlidCapabilityManifest["contractVersion"];
	helpTopics: readonly HlidHelpTopic[];
	maxOrchestrationTargetCatalogChars: number;
};

type ManifestState = {
	context: HlidOperatingContext;
	providerId: string;
	runtime: HlidCapabilityManifest["runtime"]["providerRuntime"];
	sessionScoped: boolean;
	workspaceAvailable: boolean;
	vaultConfigured: boolean;
	provider: ProviderInfo | undefined;
	orchestrationTargets: HlidCapabilityManifest["orchestrationTargets"];
	commandActions: CommandAction[];
	commands: ReadonlySet<CommandAction>;
	toolNames: string[];
	tools: ReadonlySet<string> | null;
	orchestrationAvailability: Availability;
	selectedModel: SelectedModel | undefined;
	modelAudioAvailable: boolean | undefined;
	providerRealtime: boolean;
	providerRealtimeFeature: boolean | undefined;
	hostCapabilities:
		| Record<string, { label: string; available: boolean; reason?: string }>
		| undefined;
};

type VoiceState = {
	localDictationAvailability: Availability;
	localReadAloudAvailability: Availability;
	codexDictationAvailability: Availability;
	nativeAudioAvailability: Availability;
	ravenLiveAvailability: Availability;
	voiceAvailability: Availability;
	realtimeConfigured: boolean;
	realtimeAvailable: boolean;
	realtimeClientReady: boolean;
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

function resolvedProviderCapability(
	provider: ProviderInfo | undefined,
	fallback: boolean,
	...segments: string[]
): boolean {
	const snapshot = provider?.capabilitySnapshot;
	if (!snapshot) return fallback;
	const id = providerCapabilityId(provider.id, ...segments);
	const capability = snapshot.capabilities.find((item) => item.id === id);
	if (!capability) return fallback;
	return (
		capability.integration === "integrated" &&
		capability.availability === "available"
	);
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
						resolvedProviderCapability(
							provider,
							providerCapabilities?.workflowCatalog === true,
							"workflow-catalog",
						)
					);
				}
				return true;
			}
			if (provider?.available === false) return false;
			if (capability.name === "goal") {
				return resolvedProviderCapability(
					provider,
					providerCapabilities?.goalControl === true,
					"goal-control",
				);
			}
			if (capability.name === "compact" || capability.name === "review") {
				return resolvedProviderCapability(
					provider,
					providerCapabilities?.structuredActivities?.includes(
						capability.name,
					) ?? false,
					"structured-activity",
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

function toolAvailability(
	tools: ReadonlySet<string> | null,
	required: readonly string[],
): Availability {
	if (!tools) return "conditional";
	return required.every((name) => tools.has(name))
		? "available"
		: "unavailable";
}

function orchestrationAvailability(
	sessionScoped: boolean,
	workspaceAvailable: boolean,
	tools: ReadonlySet<string> | null,
	targets: HlidCapabilityManifest["orchestrationTargets"],
): Availability {
	if (!sessionScoped || !workspaceAvailable) return "conditional";
	const availability = toolAvailability(tools, [
		"delegate_hlid_agent",
		"list_hlid_agents",
		"inspect_hlid_agent",
		"wait_hlid_agent",
		"steer_hlid_agent",
		"cancel_hlid_agent",
		"resume_hlid_agent",
	]);
	if (availability !== "available") return availability;
	if (targets.snapshot !== "current") return "conditional";
	return targets.availableProviders > 0 ? "available" : "unavailable";
}

function hostCapabilitiesSnapshot(
	provider: ProviderInfo | undefined,
): ManifestState["hostCapabilities"] {
	if (!provider?.hostCapabilities) return undefined;
	return Object.fromEntries(
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
	);
}

function providerExperimentalFeatureEnabled(
	provider: ProviderInfo | undefined,
	feature: string,
): boolean | undefined {
	const snapshot = provider?.capabilitySnapshot;
	if (!snapshot || snapshot.status === "stale") return undefined;
	const capability = snapshot.capabilities.find(
		(item) =>
			item.id ===
			providerCapabilityId(provider.id, "experimental-feature", feature),
	);
	if (!capability || capability.availability === "conditional")
		return undefined;
	return (
		capability.availability === "available" ||
		capability.availability === "provider-native"
	);
}

function buildManifestState(
	context: HlidOperatingContext,
	maxOrchestrationTargetCatalogChars: number,
): ManifestState {
	const providerId = context.providerId?.trim() || "external";
	const provider = context.providerSnapshot;
	const sessionScoped = Boolean(context.sessionId);
	const workspaceAvailable = Boolean(context.runtimeCwd);
	const orchestrationTargets = buildOrchestrationTargetCatalog(
		context.providerCatalog,
		maxOrchestrationTargetCatalogChars,
	);
	const commandActions = activeCommandActions(providerId, provider);
	const toolNames = context.registeredHlidTools
		? [...new Set(context.registeredHlidTools)].sort()
		: [];
	const tools = context.registeredHlidTools
		? new Set(context.registeredHlidTools)
		: null;
	const selectedModel = provider?.models?.find(
		(model) => model.value === context.model,
	);
	return {
		context,
		providerId,
		runtime: providerRuntime(providerId),
		sessionScoped,
		workspaceAvailable,
		vaultConfigured: Boolean(context.vaultName?.trim()),
		provider,
		orchestrationTargets,
		commandActions,
		commands: new Set(commandActions),
		toolNames,
		tools,
		orchestrationAvailability: orchestrationAvailability(
			sessionScoped,
			workspaceAvailable,
			tools,
			orchestrationTargets,
		),
		selectedModel,
		modelAudioAvailable: selectedModel?.inputModalities?.includes("audio"),
		providerRealtime: provider?.capabilities?.realtime === true,
		providerRealtimeFeature: providerExperimentalFeatureEnabled(
			provider,
			"realtime_conversation",
		),
		hostCapabilities: hostCapabilitiesSnapshot(provider),
	};
}

function localRuntimeAvailability(
	snapshot: { state: string } | undefined,
): Availability {
	if (snapshot?.state === "ready") return "available";
	if (snapshot?.state === "loading" || snapshot === undefined) {
		return "conditional";
	}
	return "unavailable";
}

function combinedAvailability(values: Availability[]): Availability {
	if (
		values.some((value) => value === "available" || value === "provider-native")
	) {
		return "available";
	}
	return values.includes("conditional") ? "conditional" : "unavailable";
}

function buildVoiceState(state: ManifestState): VoiceState {
	const localDictationAvailability = localRuntimeAvailability(
		state.context.voiceSnapshot,
	);
	const localReadAloudAvailability = localRuntimeAvailability(
		state.context.ttsSnapshot,
	);
	const nativeAudioAvailability: Availability =
		state.provider?.available === false || state.modelAudioAvailable === false
			? "unavailable"
			: state.modelAudioAvailable === true
				? "provider-native"
				: "conditional";
	const realtimeConfigured =
		state.providerId === "codex" &&
		state.provider?.available !== false &&
		state.providerRealtime &&
		state.context.codexRealtimeEnabled === true;
	const realtimeClientReady =
		realtimeConfigured &&
		(state.providerRealtimeFeature === true ||
			state.context.codexRealtimeBackendAvailable === true);
	const realtimeAvailable =
		realtimeConfigured && state.context.codexRealtimeBackendAvailable === true;
	const codexDictationAvailability: Availability = !realtimeConfigured
		? "unavailable"
		: state.context.codexRealtimeBackendAvailable === false
			? "unavailable"
			: realtimeAvailable
				? "provider-native"
				: "conditional";
	const ravenLiveAvailability: Availability = !realtimeConfigured
		? "unavailable"
		: realtimeAvailable
			? "provider-native"
			: state.providerRealtimeFeature === false ||
					state.context.codexRealtimeBackendAvailable === false
				? "unavailable"
				: "conditional";
	return {
		localDictationAvailability,
		localReadAloudAvailability,
		codexDictationAvailability,
		nativeAudioAvailability,
		ravenLiveAvailability,
		voiceAvailability: combinedAvailability([
			localDictationAvailability,
			localReadAloudAvailability,
			codexDictationAvailability,
			nativeAudioAvailability,
			ravenLiveAvailability,
		]),
		realtimeConfigured,
		realtimeAvailable,
		realtimeClientReady,
	};
}

type RuntimeEnvironment =
	HlidCapabilityManifest["runtime"]["providerEnvironment"];

type RuntimeEnvironmentDependencies = {
	platform: string;
	environment: {
		WSL_DISTRO_NAME?: string;
		WSL_INTEROP?: string;
	};
};

export function runtimeEnvironments(
	runtimeCwd: string | undefined,
	dependencies: RuntimeEnvironmentDependencies = {
		platform: process.platform,
		environment: {
			WSL_DISTRO_NAME: process.env.WSL_DISTRO_NAME,
			WSL_INTEROP: process.env.WSL_INTEROP,
		},
	},
): {
	hostEnvironment: Exclude<RuntimeEnvironment, "unknown">;
	providerEnvironment: RuntimeEnvironment;
} {
	const hostEnvironment =
		dependencies.platform === "win32"
			? "windows"
			: dependencies.environment.WSL_DISTRO_NAME ||
					dependencies.environment.WSL_INTEROP
				? "wsl"
				: "host";
	if (!runtimeCwd) return { hostEnvironment, providerEnvironment: "unknown" };

	const explicitProviderEnvironment = explicitPathEnvironment(runtimeCwd, {
		platform: dependencies.platform,
		allowWindowsUnc: true,
	});
	return {
		hostEnvironment,
		providerEnvironment:
			explicitProviderEnvironment?.environment ?? hostEnvironment,
	};
}

function providerGuidance(
	state: ManifestState,
	source: Guidance["source"],
): Guidance {
	return {
		providerId: boundedValue(state.providerId, 120),
		source,
	};
}

function providerCapabilitySummary(provider: ProviderInfo | undefined) {
	const snapshot = provider?.capabilitySnapshot;
	if (!snapshot) return undefined;
	const capabilities = snapshot.capabilities;
	const count = (predicate: (item: (typeof capabilities)[number]) => boolean) =>
		capabilities.filter(predicate).length;
	return {
		status: snapshot.status,
		revision: boundedValue(snapshot.revision, 80),
		total: capabilities.length,
		integrated: count((item) => item.integration === "integrated"),
		providerNative: count((item) => item.integration === "provider-native"),
		notIntegrated: count((item) => item.integration === "not-integrated"),
		available: count(
			(item) =>
				item.availability === "available" ||
				item.availability === "provider-native",
		),
		conditional: count((item) => item.availability === "conditional"),
		unavailable: count((item) => item.availability === "unavailable"),
	};
}

function buildRegistrySnapshot(state: ManifestState) {
	const { context, provider, selectedModel } = state;
	return {
		commandActions: state.commandActions,
		hlidTools: state.toolNames,
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
					providerCapabilities: providerCapabilitySummary(provider),
					hostCapabilities: state.hostCapabilities,
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
				context.codexRealtimeBackendAvailable ?? null,
			codexRealtimeBackendReason: context.codexRealtimeBackendReason
				? boundedValue(context.codexRealtimeBackendReason, 300)
				: null,
		},
		orchestrationTargets: state.orchestrationTargets,
	};
}

function referencesCapability(state: ManifestState): Capability {
	return {
		id: "references",
		owner: "hlid",
		availability:
			state.vaultConfigured || state.workspaceAvailable
				? "available"
				: "conditional",
		summary:
			"Vault and Workspace @ references are exact selections. Links, neighbors, imports, and related files stay out of scope unless the user asks.",
	};
}

function permissionsCapability(state: ManifestState): Capability {
	return {
		id: "permissions",
		owner: state.sessionScoped ? "hlid" : "provider",
		availability: "available",
		summary:
			"Hlid applies its active approval policy around provider-native permission behavior. Mutations remain subject to the active policy.",
	};
}

function sessionsCapability(state: ManifestState): Capability {
	return {
		id: "sessions",
		owner: "hlid",
		availability:
			state.sessionScoped &&
			state.commands.has("rename") &&
			state.commands.has("archive")
				? "available"
				: "unavailable",
		summary:
			"Raven sessions own transcript persistence, rename, archive, exact fork provenance, usage, and retained Relic links.",
	};
}

function maintenanceCapability(state: ManifestState): Capability {
	return {
		id: "maintenance",
		owner: "hlid",
		availability: toolAvailability(state.tools, [
			"inspect_hlid_storage",
			"optimize_hlid_storage",
			"cleanup_hlid_sessions",
		]),
		summary:
			"Hlid agents can inspect storage, preview and perform guarded age-based cleanup, and run lightweight SQLite optimization. Physical database reclaim remains Forge-only.",
	};
}

function contextCapability(state: ManifestState): Capability {
	return {
		id: "context",
		owner: "hlid",
		availability:
			state.sessionScoped && state.commands.has("context")
				? "available"
				: "conditional",
		summary:
			"Hlid records a bounded receipt of the context it adds to each turn. Raven exposes it through /context without adding the receipt to the provider transcript.",
	};
}

function plansReviewCapability(state: ManifestState): Capability {
	return {
		id: "plans_review",
		owner: "hlid",
		availability: state.sessionScoped ? "available" : "conditional",
		summary:
			"Hlid presents provider plan decisions and optional HTML plan documents through one approve, revise, or cancel lifecycle.",
	};
}

function workflowsCapability(state: ManifestState): Capability {
	const available = state.commands.has("workflows");
	return {
		id: "workflows",
		owner: "provider",
		availability: available ? "provider-native" : "unavailable",
		providerGuidance: providerGuidance(state, "provider-command-catalog"),
		summary: available
			? "Claude Dynamic Workflows remain provider-native; Hlid supplies the Raven lifecycle and review surface."
			: "The active provider does not expose Claude Dynamic Workflows.",
	};
}

function orchestrationCapability(state: ManifestState): Capability {
	return {
		id: "orchestration",
		owner: "hlid",
		availability: state.orchestrationAvailability,
		summary:
			"Hlid can create nested durable Raven children across registered providers and exact configured workspaces, with bounded depth, explicit model, effort, and service-tier selection, explicit handoff, independent transcripts, passive usage reporting, native steering when available, explicit cancellation, restart continuation, provenance, and bounded results. Focused orchestration help includes a bounded snapshot of the live target provider and model catalog.",
	};
}

function goalsCapability(state: ManifestState): Capability {
	const available = state.commands.has("goal");
	return {
		id: "goals",
		owner: "provider",
		availability: available ? "provider-native" : "unavailable",
		providerGuidance: providerGuidance(state, "provider-capability-catalog"),
		summary: available
			? "Goals use Codex's native goal lifecycle; Hlid displays and persists the live provider state."
			: "The active provider does not expose Codex native goals.",
	};
}

function relicsCapability(state: ManifestState): Capability {
	return {
		id: "relics",
		owner: "hlid",
		availability: toolAvailability(state.tools, ["publish_relic"]),
		summary:
			"Agent-generated reports and durable deliverables can be published to Hlid Relics. Ordinary source files do not belong there.",
	};
}

function projectPreviewCapability(state: ManifestState): Capability {
	return {
		id: "project_preview",
		owner: "hlid",
		availability:
			state.sessionScoped && state.workspaceAvailable
				? toolAvailability(state.tools, [
						"start_project_preview",
						"inspect_project_preview",
						"capture_project_preview",
						"export_project_preview_capture",
						"control_project_preview",
						"stop_project_preview",
					])
				: "conditional",
		summary:
			"Project Preview can run, present, inspect, capture a high-density PNG, export an approved capture into the active workspace, and interact with a session-scoped web project.",
	};
}

function mcpCapability(state: ManifestState): Capability {
	return {
		id: "mcp",
		owner: "hlid",
		availability: state.commands.has("mcp") ? "available" : "unavailable",
		summary:
			"Hlid discovers and reviews provider MCP state without flattening provider-native server semantics.",
	};
}

function skillsExtensionsCapability(state: ManifestState): Capability {
	const visualize = state.provider?.hostCapabilities?.windowsVisualize;
	const codexVisualize = state.runtime === "codex";
	return {
		id: "skills_extensions",
		owner: "hlid",
		availability: "available",
		summary:
			"Hlid keeps selected prompt skills, managed skill packages, and provider-native extensions distinct while supplying shared discovery and review flows.",
		modes: {
			windows_visualize_bridge: {
				owner: "hlid",
				availability:
					codexVisualize && visualize?.available === true
						? "available"
						: visualize
							? "unavailable"
							: "conditional",
				summary:
					codexVisualize && visualize?.available === true
						? "Codex can create inline Raven visualizations through a fresh Windows-native worker using the enabled provider-native Visualize skill."
						: `The Windows Visualize bridge is Codex-only and is not currently proven available${visualize?.reason ? `: ${boundedValue(visualize.reason, 300)}` : "."}`,
			},
		},
	};
}

function apiCapability(state: ManifestState): Capability {
	return {
		id: "api",
		owner: "hlid",
		availability: toolAvailability(state.tools, ["hlid_api"]),
		summary:
			"Hlid exposes a curated live HTTP catalog through /api-index. Use hlid_api to discover only the endpoints relevant to the task.",
	};
}

function computerUseCapability(state: ManifestState): Capability {
	const computerUse = state.provider?.hostCapabilities?.windowsComputerUse;
	return {
		id: "computer_use",
		owner: "hlid",
		availability:
			computerUse?.available === true
				? "available"
				: state.provider
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
	};
}

function localDictationMode(
	state: ManifestState,
	voice: VoiceState,
): CapabilityMode {
	const snapshot = state.context.voiceSnapshot;
	return {
		owner: "hlid",
		availability: voice.localDictationAvailability,
		summary:
			snapshot?.state === "ready"
				? "Local Whisper dictation is ready."
				: snapshot?.state === "loading"
					? "The configured local Whisper model is loading."
					: snapshot
						? `Local Whisper dictation is ${snapshot.state}.`
						: "Local Whisper status is not available in this snapshot.",
	};
}

function localReadAloudMode(
	state: ManifestState,
	voice: VoiceState,
): CapabilityMode {
	const snapshot = state.context.ttsSnapshot;
	return {
		owner: "hlid",
		availability: voice.localReadAloudAvailability,
		summary:
			snapshot?.state === "ready"
				? "Local neural read aloud is ready."
				: snapshot?.state === "loading"
					? "The configured local neural speech model is loading."
					: snapshot
						? `Local neural read aloud is ${snapshot.state}.`
						: "Local neural read-aloud status is not available in this snapshot.",
	};
}

function codexDictationMode(
	state: ManifestState,
	voice: VoiceState,
): CapabilityMode {
	return {
		owner: "provider",
		availability: voice.codexDictationAvailability,
		providerGuidance: providerGuidance(state, "provider-capability-catalog"),
		summary: !voice.realtimeConfigured
			? "Codex realtime dictation requires the native Codex provider, its realtime capability, and the Hlid preview setting. The selected coding model's audio modalities do not gate dictation."
			: state.context.codexRealtimeBackendAvailable === false
				? boundedValue(
						state.context.codexRealtimeBackendReason ??
							"Codex realtime dictation is unavailable for the signed-in account or realtime backend.",
						300,
					)
				: voice.realtimeAvailable
					? "Codex realtime dictation is available and returns editable text to the composer. It is independent of the selected coding model's audio modalities."
					: "Codex realtime dictation is ready to try and returns editable text to the composer. Account backend support is confirmed on first use, independently of the selected coding model's audio modalities.",
	};
}

function nativeAudioMode(
	state: ManifestState,
	voice: VoiceState,
): CapabilityMode {
	return {
		owner: "provider",
		availability: voice.nativeAudioAvailability,
		providerGuidance: providerGuidance(state, "provider-model-catalog"),
		summary:
			state.modelAudioAvailable === true
				? "Talk to Codex is available because the selected provider model advertises native audio input."
				: state.modelAudioAvailable === false
					? "Talk to Codex is unavailable because the selected provider model does not advertise native audio input."
					: "Talk to Codex is a normal provider audio turn whose availability depends on the selected model's current modalities.",
	};
}

function ravenLiveMode(
	state: ManifestState,
	voice: VoiceState,
): CapabilityMode {
	return {
		owner: "provider",
		availability: voice.ravenLiveAvailability,
		providerGuidance: providerGuidance(state, "provider-capability-catalog"),
		summary: voice.realtimeAvailable
			? "Raven Live is supported by the active Codex transport, Hlid preview setting, provider feature, and account backend."
			: state.context.codexRealtimeBackendAvailable === false
				? boundedValue(
						state.context.codexRealtimeBackendReason ??
							"Raven Live is unavailable for the signed-in account or realtime backend.",
						300,
					)
				: voice.realtimeClientReady
					? "Raven Live is client-ready; account backend availability is confirmed only when the realtime session starts."
					: "Raven Live requires native Codex, the Hlid preview setting, the provider realtime feature, and account backend availability. The selected coding model's audio modalities do not gate Live.",
	};
}

function voiceCapability(state: ManifestState, voice: VoiceState): Capability {
	return {
		id: "voice_audio",
		owner: "hlid",
		availability: voice.voiceAvailability,
		summary:
			"Voice is reported as separate local Whisper dictation, Codex realtime editable dictation, normal provider audio turns, local neural read aloud, and Raven Live modes.",
		modes: {
			local_dictation: localDictationMode(state, voice),
			codex_dictation: codexDictationMode(state, voice),
			local_read_aloud: localReadAloudMode(state, voice),
			native_audio_input: nativeAudioMode(state, voice),
			raven_live: ravenLiveMode(state, voice),
		},
	};
}

function providersCapability(state: ManifestState): Capability {
	const snapshot = providerCapabilitySummary(state.provider);
	return {
		id: "providers",
		owner: "provider",
		availability:
			state.provider?.available === false
				? "unavailable"
				: state.provider
					? "provider-native"
					: "conditional",
		providerGuidance: providerGuidance(state, "provider-capability-catalog"),
		summary: snapshot
			? `The ${state.providerId} provider capability snapshot is ${snapshot.status}: ${snapshot.total} observed, ${snapshot.integrated} integrated, ${snapshot.providerNative} provider-native, and ${snapshot.notIntegrated} not integrated. Provider commands, hidden context, forks, models, and lifecycle limits retain their native semantics.`
			: "Claude, Codex, ACP, and future providers retain their own commands, hidden context, forks, models, and lifecycle limits. A provider capability snapshot is not available in this context.",
	};
}

function buildCapabilities(
	state: ManifestState,
	voice: VoiceState,
): Capability[] {
	return [
		referencesCapability(state),
		permissionsCapability(state),
		sessionsCapability(state),
		maintenanceCapability(state),
		contextCapability(state),
		plansReviewCapability(state),
		workflowsCapability(state),
		orchestrationCapability(state),
		goalsCapability(state),
		relicsCapability(state),
		projectPreviewCapability(state),
		mcpCapability(state),
		skillsExtensionsCapability(state),
		apiCapability(state),
		computerUseCapability(state),
		voiceCapability(state, voice),
		providersCapability(state),
	];
}

function manifestRuntime(
	state: ManifestState,
): HlidCapabilityManifest["runtime"] {
	const { context } = state;
	const { hostEnvironment, providerEnvironment } = runtimeEnvironments(
		context.runtimeCwd,
	);
	return {
		providerId: boundedValue(state.providerId, 120),
		providerRuntime: state.runtime,
		hostEnvironment,
		providerEnvironment,
		// Compatibility alias for the pre-split runtime environment field.
		environment: providerEnvironment,
		...(context.model ? { model: boundedValue(context.model, 200) } : {}),
		...(context.effort ? { effort: boundedValue(context.effort, 80) } : {}),
		sessionScoped: state.sessionScoped,
	};
}

export function buildHlidCapabilityManifestImpl(
	context: HlidOperatingContext,
	options: ManifestBuildOptions,
): HlidCapabilityManifest {
	const state = buildManifestState(
		context,
		options.maxOrchestrationTargetCatalogChars,
	);
	return {
		contractVersion: options.contractVersion,
		runtime: manifestRuntime(state),
		permissions: {
			mode: boundedValue(context.permissionMode ?? "provider-default", 80),
			policyEnforced: context.policyEnforced ?? false,
			owner: state.sessionScoped ? "hlid-and-provider" : "provider",
		},
		references: {
			vaultConfigured: state.vaultConfigured,
			workspaceAvailable: state.workspaceAvailable,
			exactSelections: true,
			relatedExpansion: "only-when-requested",
		},
		registry: {
			revision: revisionFor(
				buildRegistrySnapshot(state),
				options.contractVersion,
			),
			commandActions: state.commandActions,
			hlidTools: state.toolNames,
			providerSnapshot: state.provider ? "current" : "unavailable",
			...(providerCapabilitySummary(state.provider)
				? {
						providerCapabilities: providerCapabilitySummary(state.provider),
					}
				: {}),
		},
		capabilities: buildCapabilities(state, buildVoiceState(state)),
		orchestrationTargets: state.orchestrationTargets,
		helpTopics: options.helpTopics,
	};
}
