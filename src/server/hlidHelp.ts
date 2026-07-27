import {
	isClaudeRuntimeProvider,
	isCodexRuntimeProvider,
} from "../lib/providerRuntime";

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
};

type CapabilityAvailability =
	| "available"
	| "unavailable"
	| "conditional"
	| "provider-native";

type HlidCapability = {
	id: HlidHelpTopic;
	owner: "hlid" | "provider";
	availability: CapabilityAvailability;
	summary: string;
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
	const workflowsAvailable = runtime === "claude";
	const goalsAvailable = runtime === "codex";
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
				availability: sessionScoped ? "available" : "unavailable",
				summary:
					"Raven sessions own transcript persistence, rename, archive, exact fork provenance, usage, and retained Relic links.",
			},
			{
				id: "context",
				owner: "hlid",
				availability: sessionScoped ? "available" : "conditional",
				summary:
					"Hlid records a bounded receipt of the context it adds to each turn. Raven exposes it through /context without adding the receipt to the provider transcript.",
			},
			{
				id: "plans_review",
				owner: "hlid",
				availability: sessionScoped ? "available" : "conditional",
				summary:
					"Hlid presents provider plan decisions and optional HTML plan documents through one approve, revise, or reject lifecycle.",
			},
			{
				id: "workflows",
				owner: "provider",
				availability: workflowsAvailable ? "provider-native" : "unavailable",
				summary: workflowsAvailable
					? "Claude Dynamic Workflows remain provider-native; Hlid supplies the Raven lifecycle and review surface."
					: "The active provider does not expose Claude Dynamic Workflows.",
			},
			{
				id: "goals",
				owner: "provider",
				availability: goalsAvailable ? "provider-native" : "unavailable",
				summary: goalsAvailable
					? "Goals use Codex's native goal lifecycle; Hlid displays and persists the live provider state."
					: "The active provider does not expose Codex native goals.",
			},
			{
				id: "relics",
				owner: "hlid",
				availability: "available",
				summary:
					"Agent-generated reports and durable deliverables can be published to Hlid Relics. Ordinary source files do not belong there.",
			},
			{
				id: "project_preview",
				owner: "hlid",
				availability:
					sessionScoped && workspaceAvailable ? "available" : "conditional",
				summary:
					"Project Preview can run, present, inspect, capture, and interact with a session-scoped web project from the active workspace.",
			},
			{
				id: "mcp",
				owner: "hlid",
				availability: "available",
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
				availability: "available",
				summary:
					"Hlid exposes a curated live HTTP catalog through /api-index. Use hlid_api to discover only the endpoints relevant to the task.",
			},
			{
				id: "providers",
				owner: "provider",
				availability: "provider-native",
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

export function buildHlidOperatingBrief(context: HlidOperatingContext): string {
	const manifest = buildHlidCapabilityManifest(context);
	const vault = context.vaultName?.trim()
		? ` The configured Obsidian vault is ${JSON.stringify(
				boundedValue(context.vaultName, 50),
			)}.`
		: "";
	const brief = `Hlid operating brief (v${manifest.contractVersion}):
- Runtime: provider ${boundedValue(manifest.runtime.providerId, 50)}; environment ${manifest.runtime.environment}; permissions ${boundedValue(manifest.permissions.mode, 24)}.
- Hlid @ references are exact selections. Do not expand links, backlinks, embeds, attachments, imports, neighboring files, or related content unless the user asks.${vault}
- Hlid owns shared session, approval, Relic, Project Preview, and reference flows. Provider-native capabilities keep their own semantics.
- Use hlid_help for current capability availability and focused operating guidance. Do not infer unavailable features.`;
	if (brief.length > MAX_HLID_OPERATING_BRIEF_CHARS) {
		throw new Error(
			`Hlid operating brief exceeded its ${MAX_HLID_OPERATING_BRIEF_CHARS}-character budget.`,
		);
	}
	return brief;
}
