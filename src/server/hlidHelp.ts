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

export const HLID_HELP_TOPICS = [
	"overview",
	"references",
	"permissions",
	"sessions",
	"context",
	"plans_review",
	"workflows",
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
	const commandActions = activeCommandActions(providerId, provider);
	const commands = new Set(commandActions);
	const toolNames = context.registeredHlidTools
		? [...new Set(context.registeredHlidTools)].sort()
		: [];
	const tools = context.registeredHlidTools
		? new Set(context.registeredHlidTools)
		: null;
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
	return boundedJson(
		{
			contractVersion: manifest.contractVersion,
			topic,
			runtime: manifest.runtime,
			permissions: manifest.permissions,
			references: manifest.references,
			registry: manifest.registry,
			capabilities: capability,
			guidance: TOPIC_GUIDANCE[topic],
			relatedTopics: manifest.helpTopics.filter((item) => item !== topic),
		},
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
- Hlid owns shared session, approval, Relic, Project Preview, and reference flows. Provider-native capabilities keep their own semantics.
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
