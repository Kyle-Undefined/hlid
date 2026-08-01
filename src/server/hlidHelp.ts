import type { CommandAction } from "../lib/commands";
import type { ProviderInfo } from "../lib/providerTypes";
import { buildHlidCapabilityManifestImpl } from "./hlidCapabilityManifest";
import { TOPIC_GUIDANCE } from "./hlidHelpGuidance";
import { boundedValue, revisionFor } from "./hlidHelpValue";
import { buildOrchestrationTargetCatalog } from "./hlidOrchestrationTargets";

export const HLID_OPERATING_CONTRACT_VERSION = 1 as const;
export const MAX_HLID_OPERATING_BRIEF_CHARS = 700;
export const MAX_HLID_HELP_RESPONSE_CHARS = 8_000;
export const MAX_HLID_ORCHESTRATION_TARGET_CATALOG_CHARS = 2_600;

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
		hostEnvironment: "windows" | "wsl" | "host";
		providerEnvironment: "windows" | "wsl" | "host" | "unknown";
		/** @deprecated Use providerEnvironment. */
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
		providerCapabilities?: {
			status: "current" | "stale" | "partial" | "unavailable";
			revision: string;
			total: number;
			integrated: number;
			providerNative: number;
			notIntegrated: number;
			available: number;
			conditional: number;
			unavailable: number;
		};
	};
	capabilities: HlidCapability[];
	orchestrationTargets: HlidOrchestrationTargetCatalog;
	helpTopics: readonly HlidHelpTopic[];
};

export function buildHlidCapabilityManifest(
	context: HlidOperatingContext,
): HlidCapabilityManifest {
	return buildHlidCapabilityManifestImpl(context, {
		contractVersion: HLID_OPERATING_CONTRACT_VERSION,
		helpTopics: HLID_HELP_TOPICS,
		maxOrchestrationTargetCatalogChars:
			MAX_HLID_ORCHESTRATION_TARGET_CATALOG_CHARS,
	});
}

function boundedJson(value: unknown, maxChars: number): string {
	const serialized = JSON.stringify(value);
	if (serialized.length <= maxChars) return serialized;
	throw new Error(
		`Hlid help response exceeded its ${maxChars}-character budget.`,
	);
}

function focusedProviderCapabilityCatalog(
	provider: ProviderInfo | undefined,
	limit: number,
) {
	const snapshot = provider?.capabilitySnapshot;
	if (!snapshot) {
		return {
			source: "live-provider-capability-catalog" as const,
			snapshot: "unavailable" as const,
			total: 0,
			returned: 0,
			truncated: false,
			items: [],
		};
	}
	const priority = (item: (typeof snapshot.capabilities)[number]) => {
		if (item.integration === "not-integrated") return 0;
		if (item.availability === "conditional") return 1;
		if (item.integration === "integrated") return 2;
		return 3;
	};
	const sorted = [...snapshot.capabilities].sort(
		(a, b) => priority(a) - priority(b) || a.id.localeCompare(b.id),
	);
	const items = sorted.slice(0, limit).map((item) => ({
		id: boundedValue(item.id, 180),
		label: boundedValue(item.label, 120),
		scope: item.scope,
		support: item.support,
		integration: item.integration,
		readiness: item.readiness,
		availability: item.availability,
		maturity: item.maturity ?? "unknown",
		...(item.operations?.length
			? {
					operations: item.operations
						.slice(0, 6)
						.map((value) => boundedValue(value, 60)),
				}
			: {}),
		...(item.reason ? { reason: boundedValue(item.reason, 180) } : {}),
	}));
	return {
		source: "live-provider-capability-catalog" as const,
		snapshot: snapshot.status,
		revision: boundedValue(snapshot.revision, 80),
		observedAt: snapshot.observedAt,
		...(snapshot.context
			? { context: { cwd: boundedValue(snapshot.context.cwd, 300) } }
			: {}),
		total: snapshot.capabilities.length,
		returned: items.length,
		truncated: items.length < snapshot.capabilities.length,
		items,
		...(snapshot.issues?.length
			? {
					issues: snapshot.issues
						.slice(0, 3)
						.map((value) => boundedValue(value, 180)),
				}
			: {}),
	};
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
	if (topic === "providers") {
		for (let limit = 8; limit >= 0; limit--) {
			const response = JSON.stringify({
				...shared,
				providerCapabilities: focusedProviderCapabilityCatalog(
					context.providerSnapshot,
					limit,
				),
				...tail,
			});
			if (response.length <= MAX_HLID_HELP_RESPONSE_CHARS) return response;
		}
	}
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
		revision: revisionFor(
			{ kind: "operating-brief", text: brief },
			HLID_OPERATING_CONTRACT_VERSION,
		),
	};
}
