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
export const MAX_HLID_PROVIDER_CAPABILITY_PAGE_SIZE = 20;

export const HLID_PROVIDER_CAPABILITY_INTEGRATIONS = [
	"integrated",
	"provider-native",
	"not-integrated",
] as const;
export const HLID_PROVIDER_CAPABILITY_AVAILABILITIES = [
	"available",
	"provider-native",
	"conditional",
	"unavailable",
] as const;

export const HLID_HELP_TOPICS = [
	"overview",
	"references",
	"permissions",
	"sessions",
	"maintenance",
	"ledger",
	"context",
	"diagnostics",
	"plans_review",
	"workflows",
	"routines",
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

export type HlidProviderCapabilityQuery = {
	query?: string;
	capabilityId?: string;
	integration?: (typeof HLID_PROVIDER_CAPABILITY_INTEGRATIONS)[number];
	availability?: (typeof HLID_PROVIDER_CAPABILITY_AVAILABILITIES)[number];
	limit?: number;
	cursor?: string;
};

export type HlidHelpOptions = {
	providerCapabilities?: HlidProviderCapabilityQuery;
};

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
	codexRealtimeBackendReason?: string;
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
	providerDiscovery?: {
		status: "current" | "captured" | "unavailable";
		source: "provider-catalog-cache" | "active-provider-context" | "none";
		retryable: boolean;
		reason?: string;
		revision?: string;
	};
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
	source: "provider-catalog-cache";
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
		providerSnapshot: "current" | "captured" | "unavailable";
		providerDiscovery?: {
			status: "current" | "captured" | "unavailable";
			source: "provider-catalog-cache" | "active-provider-context" | "none";
			retryable: boolean;
			reason?: string;
			revision?: string;
		};
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

const DEFAULT_PROVIDER_CAPABILITY_PAGE_SIZE = 8;
const MAX_PROVIDER_CAPABILITY_INDEX_IDS = 64;
const PROVIDER_CAPABILITY_CURSOR_VERSION = 1;

type NormalizedProviderCapabilityFilters = {
	query: string;
	capabilityId: string;
	integration: HlidProviderCapabilityQuery["integration"] | null;
	availability: HlidProviderCapabilityQuery["availability"] | null;
};

type ProviderCapabilityCursor = {
	v: typeof PROVIDER_CAPABILITY_CURSOR_VERSION;
	revision: string;
	offset: number;
	filters: NormalizedProviderCapabilityFilters;
};

function normalizedProviderCapabilityFilters(
	query: HlidProviderCapabilityQuery,
): NormalizedProviderCapabilityFilters {
	return {
		query: query.query?.trim().toLowerCase() ?? "",
		capabilityId: query.capabilityId?.trim().toLowerCase() ?? "",
		integration: query.integration ?? null,
		availability: query.availability ?? null,
	};
}

function isNormalizedProviderCapabilityFilters(
	value: unknown,
): value is NormalizedProviderCapabilityFilters {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.query === "string" &&
		typeof candidate.capabilityId === "string" &&
		(candidate.integration === null ||
			HLID_PROVIDER_CAPABILITY_INTEGRATIONS.includes(
				candidate.integration as (typeof HLID_PROVIDER_CAPABILITY_INTEGRATIONS)[number],
			)) &&
		(candidate.availability === null ||
			HLID_PROVIDER_CAPABILITY_AVAILABILITIES.includes(
				candidate.availability as (typeof HLID_PROVIDER_CAPABILITY_AVAILABILITIES)[number],
			))
	);
}

function encodeProviderCapabilityCursor(
	payload: ProviderCapabilityCursor,
): string {
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeProviderCapabilityCursor(
	value: string,
): ProviderCapabilityCursor {
	try {
		const parsed = JSON.parse(
			Buffer.from(value, "base64url").toString("utf8"),
		) as Partial<ProviderCapabilityCursor>;
		if (
			parsed.v !== PROVIDER_CAPABILITY_CURSOR_VERSION ||
			typeof parsed.revision !== "string" ||
			typeof parsed.offset !== "number" ||
			!Number.isInteger(parsed.offset) ||
			parsed.offset < 0 ||
			!isNormalizedProviderCapabilityFilters(parsed.filters)
		) {
			throw new Error("invalid cursor payload");
		}
		return parsed as ProviderCapabilityCursor;
	} catch {
		throw new Error(
			"Invalid provider capability cursor. Restart the lookup without a cursor.",
		);
	}
}

function hasProviderCapabilityFilters(
	filters: NormalizedProviderCapabilityFilters,
): boolean {
	return Boolean(
		filters.query ||
			filters.capabilityId ||
			filters.integration ||
			filters.availability,
	);
}

function providerCapabilitySearchText(
	item: NonNullable<ProviderInfo["capabilitySnapshot"]>["capabilities"][number],
): string {
	return [
		item.id,
		item.label,
		item.scope,
		item.support,
		item.integration,
		item.readiness,
		item.availability,
		item.maturity,
		...(item.operations ?? []),
		item.reason,
	]
		.filter((value): value is string => typeof value === "string")
		.join(" ")
		.toLowerCase();
}

function compactProviderCapabilityIndex(
	snapshot: NonNullable<ProviderInfo["capabilitySnapshot"]>,
) {
	const categorized = {
		notIntegrated: [] as string[],
		integratedConditional: [] as string[],
		integratedUnavailable: [] as string[],
		integratedAvailable: [] as string[],
	};
	let providerNativeTotal = 0;
	for (const item of [...snapshot.capabilities].sort((a, b) =>
		a.id.localeCompare(b.id),
	)) {
		if (item.integration === "provider-native") {
			providerNativeTotal++;
			continue;
		}
		if (item.integration === "not-integrated") {
			categorized.notIntegrated.push(item.id);
		} else if (item.availability === "conditional") {
			categorized.integratedConditional.push(item.id);
		} else if (item.availability === "unavailable") {
			categorized.integratedUnavailable.push(item.id);
		} else {
			categorized.integratedAvailable.push(item.id);
		}
	}
	const actionableTotal = Object.values(categorized).reduce(
		(total, items) => total + items.length,
		0,
	);
	let remaining = MAX_PROVIDER_CAPABILITY_INDEX_IDS;
	const boundedCategory = (items: string[]) => {
		const selected = items
			.slice(0, remaining)
			.map((id) => boundedValue(id, 180));
		remaining -= selected.length;
		return selected;
	};
	const notIntegrated = boundedCategory(categorized.notIntegrated);
	const integratedConditional = boundedCategory(
		categorized.integratedConditional,
	);
	const integratedUnavailable = boundedCategory(
		categorized.integratedUnavailable,
	);
	const integratedAvailable = boundedCategory(categorized.integratedAvailable);
	const returned =
		notIntegrated.length +
		integratedConditional.length +
		integratedUnavailable.length +
		integratedAvailable.length;
	return {
		actionableTotal,
		returned,
		truncated: returned < actionableTotal,
		providerNativeTotal,
		notIntegrated,
		integratedConditional,
		integratedUnavailable,
		integratedAvailable,
	};
}

function focusedProviderCapabilityCatalog(
	provider: ProviderInfo | undefined,
	query: HlidProviderCapabilityQuery,
	limit: number,
	includeIndex: boolean,
) {
	const snapshot = provider?.capabilitySnapshot;
	if (!snapshot) {
		return {
			source: "resolved-provider-capability-snapshot" as const,
			snapshot: "unavailable" as const,
			total: 0,
			returned: 0,
			truncated: false,
			items: [],
		};
	}
	const requestedFilters = normalizedProviderCapabilityFilters(query);
	const cursor = query.cursor
		? decodeProviderCapabilityCursor(query.cursor)
		: null;
	if (cursor && cursor.revision !== snapshot.revision) {
		throw new Error(
			"Provider capability catalog changed after this cursor was issued. Restart the lookup without a cursor.",
		);
	}
	if (
		cursor &&
		hasProviderCapabilityFilters(requestedFilters) &&
		JSON.stringify(cursor.filters) !== JSON.stringify(requestedFilters)
	) {
		throw new Error(
			"Provider capability filters changed after this cursor was issued. Repeat the original filters or use the cursor by itself.",
		);
	}
	const filters = cursor?.filters ?? requestedFilters;
	const offset = cursor?.offset ?? 0;
	const priority = (item: (typeof snapshot.capabilities)[number]) => {
		if (item.integration === "not-integrated") return 0;
		if (item.availability === "conditional") return 1;
		if (item.integration === "integrated") return 2;
		return 3;
	};
	const sorted = [...snapshot.capabilities]
		.filter((item) => {
			if (
				filters.capabilityId &&
				item.id.toLowerCase() !== filters.capabilityId
			)
				return false;
			if (filters.integration && item.integration !== filters.integration)
				return false;
			if (filters.availability && item.availability !== filters.availability)
				return false;
			return (
				!filters.query ||
				providerCapabilitySearchText(item).includes(filters.query)
			);
		})
		.sort((a, b) => {
			if (filters.query) {
				const aLabel = a.label.toLowerCase();
				const bLabel = b.label.toLowerCase();
				const aExact =
					a.id.toLowerCase() === filters.query || aLabel === filters.query;
				const bExact =
					b.id.toLowerCase() === filters.query || bLabel === filters.query;
				if (aExact !== bExact) return aExact ? -1 : 1;
				const aPrefix =
					a.id.toLowerCase().startsWith(filters.query) ||
					aLabel.startsWith(filters.query);
				const bPrefix =
					b.id.toLowerCase().startsWith(filters.query) ||
					bLabel.startsWith(filters.query);
				if (aPrefix !== bPrefix) return aPrefix ? -1 : 1;
			}
			return priority(a) - priority(b) || a.id.localeCompare(b.id);
		});
	const pageEnd = Math.min(offset + limit, sorted.length);
	const items = sorted.slice(offset, pageEnd).map((item) => ({
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
	const nextCursor =
		limit > 0 && pageEnd < sorted.length
			? encodeProviderCapabilityCursor({
					v: PROVIDER_CAPABILITY_CURSOR_VERSION,
					revision: snapshot.revision,
					offset: pageEnd,
					filters,
				})
			: undefined;
	return {
		source: "resolved-provider-capability-snapshot" as const,
		snapshot: snapshot.status,
		revision: boundedValue(snapshot.revision, 80),
		observedAt: snapshot.observedAt,
		...(snapshot.context
			? { context: { cwd: boundedValue(snapshot.context.cwd, 300) } }
			: {}),
		total: snapshot.capabilities.length,
		matched: sorted.length,
		returned: items.length,
		truncated: offset > 0 || pageEnd < sorted.length,
		offset,
		limit,
		items,
		...(nextCursor ? { nextCursor } : {}),
		...(includeIndex && !cursor && !hasProviderCapabilityFilters(filters)
			? { index: compactProviderCapabilityIndex(snapshot) }
			: {}),
		lookup: {
			filters: ["query", "capability_id", "integration", "availability"],
			pagination:
				"Pass nextCursor back as cursor; it retains the filters and is valid only for this catalog revision.",
			omission:
				"Omission from a truncated page or compact index is not evidence that a capability is unavailable.",
		},
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
	options: HlidHelpOptions = {},
): string {
	const manifest = buildHlidCapabilityManifest(context);
	// Overview is a bounded index. Detailed mode state remains available through
	// each focused topic so additive top-level capabilities cannot exhaust it.
	const capability =
		topic === "overview"
			? manifest.capabilities.map(({ modes: _modes, ...item }) => item)
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
		const providerQuery = options.providerCapabilities ?? {};
		const requestedLimit = Math.max(
			1,
			Math.min(
				MAX_HLID_PROVIDER_CAPABILITY_PAGE_SIZE,
				providerQuery.limit ?? DEFAULT_PROVIDER_CAPABILITY_PAGE_SIZE,
			),
		);
		for (const includeIndex of [true, false]) {
			for (let limit = requestedLimit; limit >= 0; limit--) {
				const response = JSON.stringify({
					...shared,
					providerCapabilities: focusedProviderCapabilityCatalog(
						context.providerSnapshot,
						providerQuery,
						limit,
						includeIndex,
					),
					...tail,
				});
				if (response.length <= MAX_HLID_HELP_RESPONSE_CHARS) return response;
			}
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
