import { realpathSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type { ToolCall } from "@umbod/core";
import type { HlidConfig } from "../config";
import * as db from "../db";
import { resolveClaudeExecutable } from "../lib/claudePath";
import {
	expandTilde,
	isPathAccessibleFromRuntime,
	toProviderRuntimePath,
} from "../lib/paths";
import { isCliProxyProvider } from "../lib/providerIds";
import {
	isClaudeRuntimeProvider,
	isCodexRuntimeProvider,
} from "../lib/providerRuntime";
import {
	authorizeRoutineCapability,
	type RoutinePermissionContext,
} from "../lib/routinePermissions";
import { SESSION_LABEL_LENGTH } from "../lib/utils";
import { formatVaultReferencedMessage } from "../lib/vaultReferences";
import {
	computeAllowedAgentRealPaths,
	isAllowedAgentPath,
	resolveAgentMode,
} from "./agentPaths";
import type {
	AgentEvent,
	AgentProvider,
	AgentQueryParams,
	AgentSession,
	AgentToolDecision,
	CanUseTool,
	McpServerStatus,
	ProviderAccountInfo,
	ProviderGoalControl,
	ProviderGoalControlResult,
	ProviderThreadGoal,
	SlashCommand,
	SubagentSnapshot,
} from "./agentProvider";
import { ingestPlanHtml } from "./attachments";
import { prewarmClaudeCli, waitForClaudeWarmupSnapshot } from "./claudeWarmup";
import { loadConfig } from "./config";
import { bumpDataRevision } from "./dataRevision";
import { resolveExecutionContext } from "./executionContext";
import { planStagingPath, prepareLibrary } from "./libraryStore";
import { readObsidianNote } from "./obsidianCli";
import { resolveObsidianCommandPermission } from "./obsidianCommandApproval";
import { parseAskUserQuestion } from "./parseAskUserQuestion";
import {
	persistAlwaysAllowedObsidianCommand,
	persistAlwaysAllowedTool,
} from "./permissionStore";
import {
	AskUserQuestionManager,
	PermissionManager,
	PlanModeManager,
} from "./permissions";
import { buildPlanHtmlInstructions, buildPromptAsync } from "./promptBuilder";
import type {
	AgentSleepMessage,
	AskUserQuestionAnswers,
	AskUserQuestionNotes,
	ChatAttachment,
	QueueStateSnapshot,
	ServerMessage,
} from "./protocol";
import {
	mapMcpServer,
	mapProviderGoal,
	TOOL_RESULT_PREVIEW_CHARS,
} from "./protocol";
import { applyReading, updateWindowMark } from "./proxy";
import { generateTurnRecap } from "./recap";
import { SessionTurnQueue } from "./sessionTurnQueue";
import { authorizeHlidTool, registerUmbodApprovalSession } from "./umbod";
import {
	evaluateSleep,
	reportRateLimitSignal,
	type SleepDecision,
	skipSleep as skipProviderSleep,
	sleepUntilAllowed,
} from "./usageGate";

/** Fallback context window size when the SDK omits it from result metadata. */
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Fire-and-forget DB error: console.error + append to log table. */
function logDbError(operation: string, err: unknown): void {
	console.error(`[db] ${operation} failed:`, err);
	void db.appendLog("error", "db", `${operation} failed`, {
		error: String(err),
	});
}

/** Mutable accumulator for per-turn SDK event state, threaded through the event loop. */
type TurnState = {
	receivedAny: boolean;
	assistantText: string;
	lastAssistantText: string;
	lastBlockType: "text" | "tool_use" | null;
	lastActualModel: string | null;
	lastTurnUsage: {
		input_tokens: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	} | null;
	liveQueryUsage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheCreationTokens: number;
	};
	lastKnownContextWindow: number | null;
	lastContextTokens: number | null;
	hadToolEvents: boolean;
	lastAssistantSeq: number;
	pendingToolEvents: {
		toolId: string;
		name: string;
		input: unknown;
		subagent?: SubagentSnapshot;
	}[];
	pendingToolResults: Map<string, { content: string; isError: boolean }>;
	pendingToolUpdates: Map<string, SubagentSnapshot>;
	/** In-flight inserts that tool results await before exposing lazy detail. */
	pendingToolEventWrites: Map<string, Promise<boolean>>;
	/**
	 * Reserved seq for the assistant message of this turn. Allocated lazily on
	 * the first text_delta or tool_start so live writes (text streaming, tool
	 * event inserts) attach to a real row that mid-turn reloads can render.
	 */
	reservedAssistantSeq: number | null;
	/** Latest native provider turn contributing to this displayed row. */
	providerTurnId: string | null;
	/**
	 * messages.id (DB primary key) for the row reservedAssistantSeq points at,
	 * once the placeholder INSERT resolves. Sent to the client on "done" so a
	 * live-streamed message can offer "branch from here" without waiting for
	 * a history reload (loadSessionSnapshot.ts is otherwise the only place
	 * that learns a message's dbId).
	 */
	dbMessageId: number | null;
	persistedToolIds: Set<string>;
	/**
	 * Throttled text-write state: a setTimeout handle that flushes the current
	 * `assistantText` to the DB row. Many chunks arrive per second; rewriting
	 * the full text column on each one would be O(N²) bytes written across the
	 * turn. Coalescing into ~150ms windows keeps liveness while bounding I/O.
	 */
	textWriteTimer: ReturnType<typeof setTimeout> | null;
	textWriteDirty: boolean;
	lastTurnToolEvents: { toolId: string; name: string; input: unknown }[];
	sdkSummary: string | null;
};

// Coalesce live assistant-text writes. 800ms balances persistence liveness
// against event-loop saturation on Windows (antivirus scans each SQLite write).
const TEXT_WRITE_THROTTLE_MS = 800;

// Structured subscription windows are provider-global but some SDKs (notably
// Claude's) do not emit a rate-limit event for every utilization change. Poll
// the live session while a turn is active so the usage strip and auto-sleep
// high-water mark do not have to wait for the final `done` event. Codex keeps
// its native account/rateLimits/updated notifications as the faster path.
const LIVE_USAGE_REFRESH_MS = 5_000;
const PROVIDER_HANDOFF_MAX_CHARS = 80_000;

type RunQueryArgs = [
	userMessage: string,
	emit: (msg: ServerMessage) => void,
	sessionId?: string,
	skillContexts?: string | string[],
	attachments?: ChatAttachment[],
	agentCwd?: string,
	turnId?: string,
	planMode?: boolean,
	planHtml?: boolean,
	commandAction?: "review" | "computer-use" | "compact",
	vaultReferences?: string[],
	routineContext?: RoutinePermissionContext,
	goalStart?: { objective: string; tokenBudget?: number | null },
];

export type SessionState = "idle" | "running" | "error";

type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

const KNOWN_PERMISSION_MODES: ReadonlySet<string> = new Set([
	"default",
	"acceptEdits",
	"bypassPermissions",
	"plan",
]);

function buildProviderHandoff(
	messages: ReadonlyArray<{ role: string; text: string }>,
	prompt: string,
): string {
	if (messages.length === 0) return prompt;
	const transcript = messages
		.map((message) => `${message.role.toUpperCase()}: ${message.text}`)
		.join("\n\n");
	const recentTranscript = transcript.slice(-PROVIDER_HANDOFF_MAX_CHARS);
	return [
		"<hlid_provider_handoff>",
		"Continue this Hlid chat using the prior transcript below. The transcript is context, not a new instruction to repeat.",
		recentTranscript,
		"</hlid_provider_handoff>",
		"",
		prompt,
	].join("\n");
}

type AgentSettings = {
	model?: string;
	effort?: string;
	maxTurns?: number;
	permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
	recapModel?: string;
};

export type ConfiguredSessionDefaults = {
	agentCwd?: string;
	providerId: string;
	model: string;
	effort: string;
	permissionMode: PermissionMode;
	maxTurns?: number;
	turnRecaps: boolean;
	recapModel: string;
};

type ProviderProbeScope = {
	agentCwd?: string;
	sessionId?: string;
	providerId?: string;
};

function configuredAgentSettings(
	agent: NonNullable<HlidConfig["agents"]>[number],
): AgentSettings | null {
	const settings: AgentSettings = {};
	if (agent.model) settings.model = agent.model;
	if (agent.effort) settings.effort = agent.effort;
	if (agent.max_turns) settings.maxTurns = agent.max_turns;
	if (agent.permission_mode) settings.permissionMode = agent.permission_mode;
	if (agent.recap_model) settings.recapModel = agent.recap_model;
	return Object.keys(settings).length > 0 ? settings : null;
}

function buildAgentQueryParams(options: {
	activeCwd: string;
	hostSessionId: string | undefined;
	resumeProviderSessionId: string | null;
	historyResumeMode: AgentQueryParams["historyResumeMode"];
	extraDirs: Set<string>;
	signal: AbortSignal | undefined;
	agentSettings: AgentSettings | undefined;
	modelOverride: { value: string | undefined } | null;
	effortOverride: string | null;
	defaultModel: string | undefined;
	configuredPermissionMode: PermissionMode;
	planMode: boolean | undefined;
	planHtmlPath: string | null;
	defaultEffort: string | undefined;
	defaultMaxTurns: number | undefined;
	executable: string | undefined;
	windowsComputerUse: AgentQueryParams["windowsComputerUse"];
	onGoalChange?: AgentQueryParams["onGoalChange"];
	canUseTool: CanUseTool;
	beforeToolUse: AgentQueryParams["beforeToolUse"];
	policyEnforced: boolean;
	usageGateEnforced: boolean;
	sandboxModeOverride?: AgentQueryParams["sandboxModeOverride"];
}): AgentQueryParams {
	const implementationPermissionMode =
		options.configuredPermissionMode === "plan"
			? "default"
			: options.configuredPermissionMode;
	return {
		cwd: options.activeCwd,
		hostSessionId: options.hostSessionId,
		sessionId: options.resumeProviderSessionId ?? undefined,
		historyResumeMode: options.historyResumeMode,
		additionalDirectories:
			options.extraDirs.size > 0
				? Array.from(options.extraDirs)
						.filter((path) =>
							isPathAccessibleFromRuntime(options.activeCwd, path),
						)
						.map((path) => toProviderRuntimePath(options.activeCwd, path))
				: undefined,
		signal: options.signal,
		model:
			options.modelOverride !== null
				? options.modelOverride.value
				: (options.agentSettings?.model ?? options.defaultModel),
		permissionMode: options.planMode
			? "plan"
			: options.configuredPermissionMode,
		sandboxModeOverride: options.sandboxModeOverride,
		policyEnforced: options.policyEnforced,
		usageGateEnforced: options.usageGateEnforced,
		...(options.planMode ? { implementationPermissionMode } : {}),
		...(options.planMode && options.planHtmlPath
			? {
					planHtmlPath: toProviderRuntimePath(
						options.activeCwd,
						options.planHtmlPath,
					),
				}
			: {}),
		effort:
			options.effortOverride ??
			options.agentSettings?.effort ??
			options.defaultEffort,
		maxTurns: options.agentSettings?.maxTurns ?? options.defaultMaxTurns,
		executable: options.executable,
		windowsComputerUse: options.windowsComputerUse,
		onGoalChange: options.onGoalChange,
		settingSources: ["user", "project", "local"],
		canUseTool: options.canUseTool,
		beforeToolUse: options.beforeToolUse,
	};
}

function buildQueryData(
	event: Extract<AgentEvent, { type: "done" }>,
	turn: TurnState,
): {
	queryData: db.QueryData;
	primaryModel:
		| { contextWindow?: number; maxOutputTokens?: number }
		| undefined;
	tokensInContext: number | null;
} {
	const primaryModel = event.modelUsage
		? Object.values(event.modelUsage)[0]
		: undefined;
	const primaryModelId = event.modelUsage
		? Object.keys(event.modelUsage)[0]
		: undefined;
	if (primaryModel?.contextWindow) {
		turn.lastKnownContextWindow = primaryModel.contextWindow;
	}
	const tokensInContext =
		turn.lastContextTokens ??
		(turn.lastTurnUsage
			? turn.lastTurnUsage.input_tokens +
				(turn.lastTurnUsage.cache_read_input_tokens ?? 0) +
				(turn.lastTurnUsage.cache_creation_input_tokens ?? 0)
			: null);
	return {
		primaryModel,
		tokensInContext,
		queryData: {
			cost: event.cost ?? 0,
			cost_known:
				event.costKnown ??
				(typeof event.cost === "number" ||
					typeof event.estimatedCost === "number"),
			estimated_cost: event.estimatedCost ?? null,
			input_tokens: event.usage?.inputTokens ?? 0,
			output_tokens: event.usage?.outputTokens ?? 0,
			cache_read_tokens: event.usage?.cacheReadTokens ?? 0,
			cache_creation_tokens: event.usage?.cacheCreationTokens ?? 0,
			duration_ms: event.durationMs,
			turns: event.turns,
			context_window:
				primaryModel?.contextWindow ?? turn.lastKnownContextWindow ?? null,
			stop_reason: event.stopReason ?? null,
			tokens_in_context: tokensInContext,
			model: turn.lastActualModel ?? primaryModelId ?? null,
		},
	};
}

function buildAgentMaps(config: HlidConfig): {
	providers: Map<string, string>;
	settings: Map<string, AgentSettings>;
} {
	const providers = new Map<string, string>();
	const settings = new Map<string, AgentSettings>();
	for (const agent of config.agents ?? []) {
		try {
			const realPath = realpathSync(expandTilde(agent.path));
			providers.set(realPath, agent.provider ?? "claude");
			const agentSettings = configuredAgentSettings(agent);
			if (agentSettings) settings.set(realPath, agentSettings);
		} catch {
			// Paths may not exist yet; they become available on the next config sync.
		}
	}
	return { providers, settings };
}

function configuredSessionDefaultsFromMaps(
	config: HlidConfig,
	configuredAgentCwd: string | undefined,
	agentMaps: ReturnType<typeof buildAgentMaps>,
): ConfiguredSessionDefaults {
	let configuredAgentPath: string | undefined;
	if (configuredAgentCwd) {
		try {
			configuredAgentPath = realpathSync(expandTilde(configuredAgentCwd));
		} catch {
			configuredAgentPath = undefined;
		}
	}
	const configuredAgent = configuredAgentPath
		? agentMaps.settings.get(configuredAgentPath)
		: undefined;
	const vaultProviderId = config.vault_provider ?? "claude";
	const providerId = configuredAgentPath
		? (agentMaps.providers.get(configuredAgentPath) ?? vaultProviderId)
		: vaultProviderId;
	const codexConfig = config.codex ?? {
		model: "",
		effort: "medium" as const,
		permission_mode: "default" as const,
		turn_recaps: true,
	};
	const providerDefaults =
		providerId === "codex"
			? codexConfig
			: isCliProxyProvider(providerId)
				? config.cliproxy
				: config.claude;
	return {
		...(configuredAgentPath ? { agentCwd: configuredAgentPath } : {}),
		providerId,
		model: configuredAgent?.model ?? providerDefaults.model,
		effort: configuredAgent?.effort ?? providerDefaults.effort,
		permissionMode:
			configuredAgent?.permissionMode ?? providerDefaults.permission_mode,
		maxTurns: configuredAgent?.maxTurns ?? providerDefaults.max_turns,
		turnRecaps: providerDefaults.turn_recaps ?? true,
		recapModel:
			configuredAgent?.recapModel ??
			providerDefaults.recap_model ??
			(isClaudeRuntimeProvider(providerId) && providerId === "claude"
				? "claude-haiku-4-5"
				: ""),
	};
}

/** Resolve the controls an idle vault/Einherjar session should advertise. */
export function resolveConfiguredSessionDefaults(
	config: HlidConfig,
	configuredAgentCwd?: string,
): ConfiguredSessionDefaults {
	return configuredSessionDefaultsFromMaps(
		config,
		configuredAgentCwd,
		buildAgentMaps(config),
	);
}

function createTurnState(): TurnState {
	return {
		receivedAny: false,
		assistantText: "",
		lastAssistantText: "",
		lastBlockType: null,
		lastActualModel: null,
		lastTurnUsage: null,
		liveQueryUsage: {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
		},
		lastKnownContextWindow: null,
		lastContextTokens: null,
		hadToolEvents: false,
		lastAssistantSeq: -1,
		pendingToolEvents: [],
		pendingToolResults: new Map(),
		pendingToolUpdates: new Map(),
		pendingToolEventWrites: new Map(),
		reservedAssistantSeq: null,
		providerTurnId: null,
		dbMessageId: null,
		persistedToolIds: new Set(),
		textWriteTimer: null,
		textWriteDirty: false,
		lastTurnToolEvents: [],
		sdkSummary: null,
	};
}

export class SessionManager {
	private providers: Map<string, AgentProvider>;
	private vaultProviderId!: string;
	/** Explicit Raven CLI choice. Session-scoped and never written to config. */
	private providerOverride: string | null = null;
	private agentProviderMap: Map<string, string> = new Map();
	private agentSettingsMap: Map<string, AgentSettings> = new Map();
	private state: SessionState = "idle";
	private abortController: AbortController | null = null;
	private model!: string;
	private effort!: string;
	/** Explicit Raven picker values, which outrank refreshed config and agent defaults. */
	private modelOverride: { value: string | undefined } | null = null;
	private effortOverride: string | null = null;
	private permissionModeOverride: PermissionMode | null = null;
	/** The next provider thread needs the persisted Hlid transcript as context. */
	private providerHandoffPending = false;
	/** Providers without a live effort control (currently Claude) restart on the next turn. */
	private restartAgentSessionForEffort = false;
	/** Extension changes made mid-turn retire the native runtime before its next turn. */
	private restartProviderRuntimeAfterTurn = false;
	private maxTurns: number | undefined;
	private vaultPath!: string;
	private vaultName!: string;
	private permissionMode!: PermissionMode;
	private claudeExecutable: string | undefined;
	private codexExecutable: string | undefined;
	private windowsComputerUse!: NonNullable<
		AgentQueryParams["windowsComputerUse"]
	>;
	// Provider session ID for the active chat. Captured from the `session_start`
	// event on first turn, persisted per chat row, and passed back via `sessionId`
	// on subsequent turns so the provider manages history natively.
	private providerSessionId: string | null = null;
	private providerSessionProviderId: string | null = null;
	private historyResumeMode: AgentQueryParams["historyResumeMode"] = "none";
	private unregisterUmbodApprovalSession: (() => void) | null = null;
	private permissions = new PermissionManager();
	private askUserQuestions = new AskUserQuestionManager();
	private planModeManager = new PlanModeManager();
	// Deterministic path the agent is asked to write its HTML plan to (plan
	// mode + html_plans on). Set per turn in runOneTurn and ingested into the
	// Hlid library at the ExitPlanMode intercept.
	private planHtmlPath: string | null = null;
	/** Tools approved for the entire hlid session (survives provider subprocess restarts). */
	private sessionAllowedTools = new Set<string>();
	/** Exact Obsidian command IDs remembered for this workspace's configured vault. */
	private rememberedObsidianCommands = new Set<string>();
	/** Present only while a server-owned scheduled Routine turn is executing. */
	private activeRoutineContext: RoutinePermissionContext | null = null;
	private currentSessionId: string | null = null;
	private currentSessionLabel: string | null = null;
	private messageSeq = 0;
	/** Last runtime MCP snapshot per provider for this Hlid conversation. */
	private mcpStatusByProvider = new Map<string, McpServerStatus[]>();
	/** Invalidates delayed Claude MCP refreshes when a newer turn starts. */
	private mcpRefreshGeneration = 0;
	/** Serialize temporary provider probes so MCP and command discovery both run. */
	private probeQueue: Promise<void> = Promise.resolve();
	private agentCwd: string | undefined;
	/** Pool-scoped agent path whose configured defaults seed live status. */
	private configuredAgentCwd: string | undefined;
	private agentMode: "cwd" | "context" = "cwd";
	private allowedAgentRealPaths: string[] = [];
	private turnRecaps!: boolean;
	private recapModel!: string;
	// Slice A: re-entrant runQuery. Concurrent calls (typed-while-running) are
	// queued FIFO and drained serially. State stays "running" until the queue
	// fully drains.
	private turnQueue = new SessionTurnQueue<RunQueryArgs>();
	private isDraining = false;
	// Slice B: long-lived AgentSession per chat. Cached by chat-scoped key so
	// consecutive turns reuse one provider.query() invocation. Tear down on
	// chat switch / clearHistory / abort.
	private agentSession: AgentSession | null = null;
	private agentSessionKey: string | null = null;
	// Slice C: turn id of the currently running turn — threaded into the
	// emitted `done` event so clients can correlate completions to specific
	// submissions (and pop their queue display FIFO by id).
	private currentTurnId: string | undefined;
	// Auto-sleep: last emitted "sleeping" message, kept for sync replay so a
	// reconnecting client sees the banner. Cleared on wake/abort.
	private sleepState: AgentSleepMessage | null = null;
	private sleepEmit: ((msg: ServerMessage) => void) | null = null;
	private policyEnforced = false;
	private usageGateEnforced = false;

	constructor(
		config: HlidConfig,
		providers: Map<string, AgentProvider>,
		configuredAgentCwd?: string,
	) {
		this.providers = providers;
		this.configuredAgentCwd = configuredAgentCwd;
		this.applyConfig(config);
	}

	/**
	 * Resolves the provider to use for a given agentCwd. If agentCwd is set,
	 * looks up the provider mapped for that path; otherwise uses the vault
	 * provider. Falls back to the first provider in the map if the resolved id
	 * is not found.
	 */
	private resolveProvider(agentCwd?: string): AgentProvider {
		let providerId: string;
		if (this.providerOverride) {
			providerId = this.providerOverride;
		} else if (agentCwd) {
			providerId = this.agentProviderMap.get(agentCwd) ?? this.vaultProviderId;
		} else {
			providerId = this.vaultProviderId;
		}
		return (
			this.providers.get(providerId) ??
			this.providers.values().next().value ??
			(() => {
				throw new Error(`No providers registered`);
			})()
		);
	}

	/** Apply runtime settings from config. Shared by constructor, reinitialize, and syncConfig. */
	private applyConfig(
		config: HlidConfig,
		preserveSessionOverrides = false,
	): void {
		this.vaultPath = config.vault.path || process.env.HOME || "/";
		this.vaultName = config.vault.name;
		this.rememberedObsidianCommands = new Set(
			config.vault.obsidian_command_allowlist ?? [],
		);
		this.vaultProviderId = config.vault_provider ?? "claude";
		const agentMaps = buildAgentMaps(config);
		this.agentProviderMap = agentMaps.providers;
		this.agentSettingsMap = agentMaps.settings;
		const configuredDefaults = configuredSessionDefaultsFromMaps(
			config,
			this.configuredAgentCwd,
			agentMaps,
		);
		if (configuredDefaults.agentCwd && !this.agentCwd) {
			this.agentCwd = configuredDefaults.agentCwd;
			this.agentMode = resolveAgentMode(configuredDefaults.agentCwd);
		}
		const codexConfig = config.codex ?? {
			model: "",
			effort: "medium" as const,
			permission_mode: "default" as const,
			turn_recaps: true,
		};
		if (!preserveSessionOverrides || this.modelOverride === null)
			this.model = configuredDefaults.model;
		if (!preserveSessionOverrides || this.effortOverride === null)
			this.effort = configuredDefaults.effort;
		this.maxTurns = configuredDefaults.maxTurns;
		if (!preserveSessionOverrides || this.permissionModeOverride === null)
			this.permissionMode = configuredDefaults.permissionMode;
		this.turnRecaps = configuredDefaults.turnRecaps;
		this.recapModel = configuredDefaults.recapModel;
		this.claudeExecutable = resolveClaudeExecutable();
		this.codexExecutable = codexConfig.executable;
		this.windowsComputerUse = codexConfig.windows_computer_use ?? {
			model: "inherit",
			effort: "medium",
		};
		this.allowedAgentRealPaths = computeAllowedAgentRealPaths(config);
		this.policyEnforced = config.umbod?.enabled ?? false;
		this.usageGateEnforced = config.auto_sleep?.enabled ?? false;
	}

	reinitialize(config: HlidConfig): void {
		this.abort();
		this.providerOverride = null;
		this.modelOverride = null;
		this.effortOverride = null;
		this.permissionModeOverride = null;
		this.applyConfig(config);
		this.state = "idle";
		this.currentSessionId = null;
		this.currentSessionLabel = null;
		this.providerSessionId = null;
		this.providerSessionProviderId = null;
		this.historyResumeMode = "none";
		this.providerHandoffPending = false;
		this.messageSeq = 0;
		this.sessionAllowedTools.clear();
		db.clearCurrentSessionId().catch((e) =>
			logDbError("clearCurrentSessionId", e),
		);
	}

	// Lightweight config refresh — updates runtime settings without resetting
	// session history or conversation continuity. Safe to call when idle.
	// Returns true if an effective status field changed (so callers can broadcast it).
	syncConfig(config: HlidConfig): boolean {
		const previous = this.getStatus();
		const nextProviderId = config.vault_provider ?? "claude";
		const providerChanged =
			this.providerOverride === null && nextProviderId !== this.vaultProviderId;
		if (providerChanged) {
			// A picker value from one provider may not be meaningful for another.
			this.modelOverride = null;
			this.effortOverride = null;
			this.permissionModeOverride = null;
		}
		this.applyConfig(config, !providerChanged);
		void this.agentSession?.setWindowsComputerUse?.(this.windowsComputerUse);
		const current = this.getStatus();
		return (
			previous.model !== current.model ||
			previous.effort !== current.effort ||
			previous.permission_mode !== current.permission_mode
		);
	}

	getStatus(): {
		state: SessionState;
		model: string;
		permission_mode: PermissionMode;
		effort: string;
	} {
		return {
			state: this.state,
			model: this.model,
			permission_mode: this.permissionMode,
			effort: this.effort,
		};
	}

	/**
	 * Mid-session model switch (Chunk 6). Session-scoped: updates the field
	 * `runOneTurn` reads for vault chats and delegates to the live
	 * AgentSession (if one exists) so the change is effective starting with
	 * the very next turn instead of waiting for a fresh session. No-op on
	 * providers whose AgentSession doesn't implement setModel (e.g. codex's
	 * setModel always exists, but a future provider might not).
	 * `undefined` resets to the provider default (mirrors the SDK's own
	 * setModel(model?: string) semantics).
	 */
	async setModel(model?: string): Promise<void> {
		this.modelOverride = { value: model };
		this.model = model ?? "";
		await Promise.all([
			this.agentSession?.setModel?.(model),
			this.currentSessionId && model !== undefined
				? db.setSessionModel(this.currentSessionId, model)
				: Promise.resolve(),
		]);
	}

	/**
	 * Explicit Raven CLI switch. The config remains untouched; the selected
	 * provider and compatible controls apply only to this Hlid chat. Switching
	 * providers starts a fresh provider-native thread and hands it the persisted
	 * Hlid transcript on the next turn so conversation context is retained.
	 */
	// fallow-ignore-next-line unused-class-member -- Called by WebSocket settings/chat dispatch in wsHandlers.
	async setProvider(
		providerId: string,
		selection: {
			model?: string;
			effort?: string;
			permissionMode?: string;
		} = {},
	): Promise<void> {
		if (!this.providers.has(providerId)) {
			throw new Error(`Unknown or unavailable provider: ${providerId}`);
		}
		if (this.state === "running") {
			throw new Error("Cannot switch CLI while a turn is running");
		}
		if (
			selection.permissionMode &&
			!KNOWN_PERMISSION_MODES.has(selection.permissionMode)
		) {
			throw new Error(`Unknown permission mode: ${selection.permissionMode}`);
		}

		const currentProviderId = this.resolveProvider(this.agentCwd).providerId;
		const providerChanged = currentProviderId !== providerId;
		if (providerChanged) {
			this.agentSession?.cancel();
			this.agentSession = null;
			this.agentSessionKey = null;
			this.restartAgentSessionForEffort = false;
			this.providerSessionId = null;
			this.providerSessionProviderId = providerId;
			this.providerHandoffPending =
				this.currentSessionId !== null && this.messageSeq > 0;
		}

		this.providerOverride = providerId;
		this.modelOverride = { value: selection.model };
		this.model = selection.model ?? "";
		this.effortOverride = selection.effort ?? null;
		this.effort = selection.effort ?? "";
		this.permissionModeOverride = selection.permissionMode
			? (selection.permissionMode as PermissionMode)
			: null;
		this.permissionMode =
			(selection.permissionMode as PermissionMode | undefined) ?? "default";

		if (this.currentSessionId) {
			await Promise.all([
				db.setSessionProviderId(this.currentSessionId, providerId),
				selection.model
					? db.setSessionModel(this.currentSessionId, selection.model)
					: Promise.resolve(),
				selection.effort
					? db.setSessionEffort(this.currentSessionId, selection.effort)
					: Promise.resolve(),
				selection.permissionMode
					? db.setSessionPermissionMode(
							this.currentSessionId,
							selection.permissionMode,
						)
					: Promise.resolve(),
			]);
		}
	}

	/**
	 * Mid-session permission-mode switch (Chunk 6). Validates against the
	 * known modes before mutating any state — an invalid mode throws rather
	 * than silently no-op'ing so the caller (wsHandlers) can surface a clear
	 * error to the client. Session-scoped like setModel: updates the field
	 * `runOneTurn` reads and delegates to the live AgentSession so the
	 * change applies starting with the next turn.
	 */
	async setPermissionMode(mode: string): Promise<void> {
		if (!KNOWN_PERMISSION_MODES.has(mode)) {
			throw new Error(`Unknown permission mode: ${mode}`);
		}
		this.permissionModeOverride = mode as PermissionMode;
		this.permissionMode = mode as PermissionMode;
		await Promise.all([
			this.agentSession?.setPermissionMode?.(mode),
			this.currentSessionId
				? db.setSessionPermissionMode(this.currentSessionId, mode)
				: Promise.resolve(),
		]);
	}

	/**
	 * Mid-session effort switch. Session-scoped like setModel/setPermissionMode:
	 * updates the field `buildAgentQueryParams` reads as the default effort for
	 * the session's next fresh AgentSession, and delegates to the live
	 * AgentSession when the active provider supports a live switch (codex).
	 * On providers without one (claude), the new value still takes effect —
	 * just starting with the next fresh session rather than the current turn.
	 */
	// fallow-ignore-next-line unused-class-member -- Called by the WebSocket set_effort dispatch in wsHandlers.
	async setEffort(effort: string): Promise<void> {
		this.effortOverride = effort;
		this.effort = effort;
		await (this.currentSessionId
			? db.setSessionEffort(this.currentSessionId, effort)
			: Promise.resolve());
		if (!this.agentSession) return;
		if (this.agentSession.setEffort) {
			await this.agentSession.setEffort(effort);
			return;
		}
		// Do not interrupt an in-flight Claude turn. Rebuild its streaming query
		// at the next turn boundary and resume from the captured provider session.
		this.restartAgentSessionForEffort = true;
	}

	/**
	 * Account info for this session's live AgentSession, or null when there
	 * isn't one (idle session, or the active provider doesn't expose
	 * accountInfo — e.g. codex). Never spawns a session to answer this.
	 */
	async getAccountInfo(): Promise<ProviderAccountInfo | null> {
		if (!this.agentSession?.accountInfo) return null;
		try {
			return await this.agentSession.accountInfo();
		} catch {
			return null;
		}
	}

	getCurrentSessionId(): string | null {
		return this.currentSessionId;
	}

	getAgentCwd(): string | undefined {
		return this.agentCwd;
	}

	getProviderId(agentCwd?: string): string {
		return this.resolveProvider(agentCwd ?? this.agentCwd).providerId;
	}

	getSessionLabel(): string | null {
		return this.currentSessionLabel;
	}

	/** Sync the in-memory label after a DB rename so live status shows it. */
	setSessionLabel(label: string): void {
		this.currentSessionLabel = label;
	}

	getLastMcpStatus(
		providerId = this.getProviderId(),
	): McpServerStatus[] | null {
		return this.mcpStatusByProvider.get(providerId) ?? null;
	}

	// fallow-ignore-next-line unused-class-member -- Read by Cockpit inventory aggregation in wsHandlers.
	getMcpSnapshots(): Array<{
		providerId: string;
		servers: McpServerStatus[];
	}> {
		return [...this.mcpStatusByProvider].map(([providerId, servers]) => ({
			providerId,
			servers,
		}));
	}

	restoreMcpStatus(
		statuses: McpServerStatus[],
		providerId = this.getProviderId(),
	): void {
		this.mcpStatusByProvider.set(providerId, statuses);
	}

	/**
	 * Apply provider-extension changes without interrupting active work.
	 * Idle native processes are retired so the next turn reloads plugins, then
	 * scoped command and MCP metadata is refreshed for connected clients.
	 */
	// fallow-ignore-next-line unused-class-member -- Called by the extension mutation refresh hook in server/index.
	retireProviderRuntime(): boolean {
		if (this.state === "running") {
			this.restartProviderRuntimeAfterTurn = true;
			return false;
		}
		const provider = this.resolveProvider(this.agentCwd);
		this.agentSession?.cancel();
		this.agentSession = null;
		this.agentSessionKey = null;
		this.mcpStatusByProvider.delete(provider.providerId);
		this.restartProviderRuntimeAfterTurn = false;
		return true;
	}

	// fallow-ignore-next-line unused-class-member -- Called by the extension mutation refresh hook in server/index.
	async refreshProviderMetadata(
		emit: (msg: ServerMessage) => void,
	): Promise<void> {
		const provider = this.resolveProvider(this.agentCwd);
		if (isClaudeRuntimeProvider(provider.providerId)) {
			const execution = resolveExecutionContext({
				agentMode: this.agentMode,
				agentCwd: this.agentCwd,
				vaultPath: this.vaultPath,
				allowedAgentRealPaths: this.allowedAgentRealPaths,
				claudeExecutable: this.claudeExecutable,
				wrapperCommand: "claude",
				safeAttachments: [],
			});
			await prewarmClaudeCli({
				executable: execution.executable,
				cwd: execution.activeCwd,
				cacheCwd: this.agentCwd ?? this.vaultPath,
				additionalDirectories: [...execution.extraDirs],
				waitTimeoutMs: 10_000,
			});
		}

		const scope = {
			...(this.agentCwd ? { agentCwd: this.agentCwd } : {}),
			...(this.currentSessionId ? { sessionId: this.currentSessionId } : {}),
		};
		await Promise.all([
			this.probeMcpStatus(emit, scope),
			this.probeSlashCommands(emit, scope),
		]);
	}

	private async runProbe(
		inspect: (session: AgentSession) => Promise<void>,
		agentCwd?: string,
		providerOverride?: AgentProvider,
	): Promise<void> {
		const run = async () => {
			const provider = providerOverride ?? this.resolveProvider(agentCwd);
			// Providers such as Claude require an initialized chat process for these
			// methods. Their no-session metadata is served from the startup cache.
			if (provider.probeRequiresTurn) return;
			const ac = new AbortController();
			const timeout = setTimeout(() => ac.abort(), 30_000);
			let session: AgentSession | undefined;
			try {
				session = provider.query({
					cwd: agentCwd ?? this.agentCwd ?? this.vaultPath,
					signal: ac.signal,
					permissionMode: "default",
					effort: "low",
					maxTurns: 1,
					persistSession: false,
					settingSources: ["user", "project"],
					executable: isClaudeRuntimeProvider(provider.providerId)
						? this.claudeExecutable
						: this.codexExecutable,
					canUseTool: () =>
						Promise.resolve({ behavior: "deny" as const, message: "probe" }),
				});
				await inspect(session);
			} catch {
				// Abort errors are expected when a probe reaches its time limit.
			} finally {
				clearTimeout(timeout);
				session?.cancel();
			}
		};
		const queued = this.probeQueue.then(run, run);
		this.probeQueue = queued;
		await queued;
	}

	private resolveProbeContext(scope: ProviderProbeScope): {
		activeAgentCwd?: string;
		provider: AgentProvider;
		providerId: string;
		targetsLiveScope: boolean;
	} {
		const activeAgentCwd = scope.agentCwd ?? this.getAgentCwd();
		const configuredProvider = this.resolveProvider(activeAgentCwd);
		const provider = scope.providerId
			? (this.providers.get(scope.providerId) ?? configuredProvider)
			: configuredProvider;
		const providerId = provider.providerId;
		return {
			activeAgentCwd,
			provider,
			providerId,
			targetsLiveScope:
				(!scope.agentCwd || scope.agentCwd === this.agentCwd) &&
				(!scope.sessionId || scope.sessionId === this.currentSessionId) &&
				providerId === this.getProviderId(activeAgentCwd),
		};
	}

	async probeMcpStatus(
		emit: (msg: ServerMessage) => void,
		scope: ProviderProbeScope = {},
	): Promise<void> {
		const { activeAgentCwd, provider, providerId, targetsLiveScope } =
			this.resolveProbeContext(scope);
		const publish = (statuses: McpServerStatus[]) => {
			// Archived-session probes may be proxied through the vault manager. Keep
			// their scoped result out of the vault cache or Watch will inherit the
			// wrong provider context on its next connection.
			if (targetsLiveScope) {
				this.mcpStatusByProvider.set(providerId, statuses);
			}
			emit({
				type: "mcp_status",
				provider_id: providerId,
				...(scope.agentCwd ? { agent_cwd: scope.agentCwd } : {}),
				...(scope.sessionId ? { session_id: scope.sessionId } : {}),
				servers: statuses.map(mapMcpServer),
			});
		};
		if (provider.probeRequiresTurn) {
			if (targetsLiveScope && this.agentSession?.mcpServerStatus) {
				publish(await this.agentSession.mcpServerStatus());
				return;
			}
			const cached = isClaudeRuntimeProvider(providerId)
				? await waitForClaudeWarmupSnapshot(activeAgentCwd ?? this.vaultPath)
				: null;
			publish(cached?.mcpServers ?? []);
			return;
		}
		await this.runProbe(
			async (session) => {
				const statuses = (await session.mcpServerStatus?.()) ?? [];
				publish(statuses);
			},
			scope.agentCwd,
			provider,
		);
	}

	async probeSlashCommands(
		emit: (msg: ServerMessage) => void,
		scope: ProviderProbeScope = {},
	): Promise<void> {
		const { activeAgentCwd, provider, providerId, targetsLiveScope } =
			this.resolveProbeContext(scope);
		const publish = (commands: SlashCommand[]) =>
			emit({
				type: "slash_commands",
				provider_id: providerId,
				...(scope.agentCwd ? { agent_cwd: scope.agentCwd } : {}),
				...(scope.sessionId ? { session_id: scope.sessionId } : {}),
				commands,
			});
		if (provider.probeRequiresTurn) {
			if (targetsLiveScope && this.agentSession?.supportedCommands) {
				publish(await this.agentSession.supportedCommands());
				return;
			}
			const cached = isClaudeRuntimeProvider(providerId)
				? await waitForClaudeWarmupSnapshot(activeAgentCwd ?? this.vaultPath)
				: null;
			publish(cached?.commands ?? []);
			return;
		}
		await this.runProbe(
			async (session) => {
				const commands = (await session.supportedCommands?.()) ?? [];
				publish(commands);
			},
			scope.agentCwd,
			provider,
		);
	}

	// fallow-ignore-next-line unused-class-member -- Called by the WebSocket goal_control dispatch in wsHandlers.
	async controlGoal(
		control: ProviderGoalControl,
		options: {
			sessionId: string;
			agentCwd?: string;
			emit: (msg: ServerMessage) => void;
		},
	): Promise<{ providerId: string; goal: ProviderThreadGoal | null }> {
		if (this.currentSessionId !== options.sessionId) {
			const saved = await db.getSessionById(options.sessionId);
			if (!saved) {
				if (control.action === "get")
					return { providerId: "codex", goal: null };
				throw new Error(
					control.action === "set"
						? "Start the goal by submitting it from Raven."
						: "This session does not have an active goal.",
				);
			}
		}
		await this.initSessionContext(
			options.sessionId,
			options.agentCwd,
			control.action === "set" ? control.objective : "",
		);
		const { provider, agentSettings, resumeProviderSessionId } =
			this.prepareProviderForTurn(options.sessionId);
		if (!isCodexRuntimeProvider(provider.providerId)) {
			throw new Error("/goal is only available for Codex sessions.");
		}
		if (
			control.action !== "set" &&
			!resumeProviderSessionId &&
			!this.agentSession
		) {
			if (control.action === "get") {
				return { providerId: provider.providerId, goal: null };
			}
			throw new Error("This Codex session does not have an active goal.");
		}
		const { activeCwd, extraDirs, executable } = resolveExecutionContext({
			agentMode: this.agentMode,
			agentCwd: this.agentCwd,
			vaultPath: this.vaultPath,
			allowedAgentRealPaths: this.allowedAgentRealPaths,
			claudeExecutable: this.codexExecutable,
			wrapperCommand: "codex",
			safeAttachments: [],
		});
		const publishGoal = (goal: ProviderThreadGoal | null) =>
			options.emit({
				type: "goal_state",
				session_id: options.sessionId,
				provider_id: provider.providerId,
				goal: goal ? mapProviderGoal(goal) : null,
			});
		const ownsContinuationDrain =
			(control.action === "resume" || control.action === "set") &&
			!this.isDraining;
		if (ownsContinuationDrain) {
			this.isDraining = true;
			this.state = "running";
			this.currentTurnId = undefined;
			this.abortController = new AbortController();
			this.emitRunningStatus(options.emit);
			if ((await this.gateOnUsage(provider, options.emit)) === "aborted") {
				this.finishGoalContinuation(options.emit);
				throw new Error("Goal continuation was cancelled.");
			}
		}
		let continuationLaunched = false;
		try {
			const agentSession = this.getOrCreateAgentSession({
				provider,
				sessionId: options.sessionId,
				resumeProviderSessionId,
				activeCwd,
				extraDirs,
				executable,
				agentSettings,
				planMode: false,
				emit: options.emit,
				onGoalChange: publishGoal,
			});
			if (!agentSession.controlGoal) {
				throw new Error("The active Codex version does not support goals.");
			}
			const result: ProviderGoalControlResult =
				await agentSession.controlGoal(control);
			this.providerSessionId = result.providerSessionId;
			this.providerSessionProviderId = provider.providerId;
			await db.setSessionProviderSession(
				options.sessionId,
				provider.providerId,
				result.providerSessionId,
			);
			if (ownsContinuationDrain) {
				this.runGoalContinuation({
					agentSession,
					sessionId: options.sessionId,
					emit: options.emit,
					provider,
					agentSettings,
					objective: result.goal?.objective ?? "Goal continuation",
				});
				continuationLaunched = true;
			}
			return { providerId: provider.providerId, goal: result.goal };
		} catch (error) {
			if (ownsContinuationDrain && !continuationLaunched) {
				this.finishGoalContinuation(options.emit);
			}
			throw error;
		}
	}

	private runGoalContinuation(options: {
		agentSession: AgentSession;
		sessionId: string;
		emit: (msg: ServerMessage) => void;
		provider: AgentProvider;
		agentSettings: AgentSettings | undefined;
		objective: string;
	}): void {
		const {
			agentSession,
			sessionId,
			emit,
			provider,
			agentSettings,
			objective,
		} = options;
		const turn = createTurnState();
		void (async () => {
			try {
				await this.iterateConversation(
					agentSession,
					sessionId,
					emit,
					turn,
					provider,
				);
				this.scheduleTurnRecap({
					turn,
					sessionId,
					userMessage: objective,
					emit,
					provider,
					agentSettings,
				});
			} catch (error) {
				this.state = "error";
				const message =
					error instanceof Error ? error.message : "Goal continuation failed";
				void db.appendLog("error", "session", "goal continuation error", {
					message,
					name: error instanceof Error ? error.name : undefined,
					stack:
						error instanceof Error ? error.stack?.slice(0, 500) : undefined,
				});
				emit({ type: "error", message });
				this.agentSession?.cancel();
				this.agentSession = null;
				this.agentSessionKey = null;
				this.restartAgentSessionForEffort = false;
			} finally {
				if (turn.assistantText) {
					try {
						const assistantSeq = await this.persistAssistantMessage(
							sessionId,
							turn,
						);
						this.persistPendingToolEvents(
							sessionId,
							assistantSeq,
							turn,
							"goal continuation",
							provider.providerId,
						);
					} catch (error) {
						logDbError("appendMessage (goal continuation)", error);
					}
				}
				this.finishGoalContinuation(emit);
			}
		})();
	}

	private finishGoalContinuation(emit: (msg: ServerMessage) => void): void {
		this.isDraining = false;
		this.currentTurnId = undefined;
		if (this.turnQueue.length > 0) {
			void this.drainTurnQueue();
			return;
		}
		this.abortController = null;
		if (this.state === "running") this.state = "idle";
		this.sleepState = null;
		this.sleepEmit = null;
		emit({
			type: "status",
			state: this.state,
			model: this.model,
			permission_mode: this.permissionMode,
			effort: this.effort,
		});
	}

	isRunning(): boolean {
		return this.state === "running";
	}

	abort(): void {
		this.unregisterUmbodApprovalSession?.();
		this.unregisterUmbodApprovalSession = null;
		this.permissions.clearAll();
		this.askUserQuestions.clearAll();
		this.planModeManager.clearAll();
		// Drop queued turns so abort cancels everything in flight, not just
		// the currently running turn.
		this.turnQueue.resolveAll();
		this.abortController?.abort();
		// Slice B: tear down the long-lived AgentSession so the next runQuery
		// rebuilds the SDK stream from scratch.
		this.agentSession?.cancel();
		this.agentSession = null;
		this.agentSessionKey = null;
		this.restartAgentSessionForEffort = false;
	}

	/**
	 * Tear down provider-native state when a runtime integration disappears.
	 * The Hlid transcript remains intact and the next turn hands it to the
	 * configured fallback provider instead of talking to a stopped sidecar.
	 */
	retireProviderSessions(providerIds: ReadonlySet<string>): boolean {
		const activeProviderId = this.agentSessionKey?.split("|", 1)[0];
		const retiresActiveSession = Boolean(
			activeProviderId && providerIds.has(activeProviderId),
		);
		const retiresResumeSession = Boolean(
			this.providerSessionProviderId &&
				providerIds.has(this.providerSessionProviderId),
		);
		const retiresOverride = Boolean(
			this.providerOverride && providerIds.has(this.providerOverride),
		);
		if (!retiresActiveSession && !retiresResumeSession && !retiresOverride) {
			return false;
		}

		if (retiresActiveSession) {
			this.agentSession?.cancel();
			this.agentSession = null;
			this.agentSessionKey = null;
			this.restartAgentSessionForEffort = false;
		}
		if (retiresResumeSession) {
			this.providerSessionId = null;
			this.providerSessionProviderId = null;
			this.historyResumeMode = "none";
			this.providerHandoffPending =
				this.currentSessionId !== null && this.messageSeq > 0;
		}
		if (retiresOverride) {
			this.providerOverride = null;
			this.modelOverride = null;
			this.effortOverride = null;
			this.permissionModeOverride = null;
		}
		return true;
	}

	handlePermissionResponse(
		id: string,
		approved: boolean,
		saveScope?: "session" | "local",
		denyMessage?: string,
	): void {
		this.permissions.complete(id, approved, saveScope, denyMessage);
	}

	getPendingPermissionRequests(): Extract<
		ServerMessage,
		{ type: "permission_request" }
	>[] {
		return this.permissions.getPending();
	}

	getPendingAskUserQuestions(): Extract<
		ServerMessage,
		{ type: "ask_user_question" }
	>[] {
		return this.askUserQuestions.getPending();
	}

	handleAskUserQuestionResponse(
		id: string,
		answers: AskUserQuestionAnswers,
		notes?: AskUserQuestionNotes,
	): void {
		this.askUserQuestions.complete(id, answers, notes);
	}

	handlePlanModeExitResponse(
		id: string,
		decision: "approved" | "edited" | "cancelled",
		feedback?: string,
	): void {
		this.planModeManager.complete(id, decision, feedback);
	}

	getPendingPlanModeExits(): Extract<
		ServerMessage,
		{ type: "plan_mode_exit" }
	>[] {
		return this.planModeManager.getPending();
	}

	clearHistory(): void {
		this.unregisterUmbodApprovalSession?.();
		this.unregisterUmbodApprovalSession = null;
		this.currentSessionId = null;
		this.currentSessionLabel = null;
		this.providerSessionId = null;
		this.providerSessionProviderId = null;
		this.historyResumeMode = "none";
		this.providerOverride = null;
		this.providerHandoffPending = false;
		this.messageSeq = 0;
		this.agentCwd = undefined;
		this.agentMode = "cwd";
		this.sessionAllowedTools.clear();
		this.askUserQuestions.clearAll();
		this.planModeManager.clearAll();
		// Drop any queued (not-yet-started) turns silently.
		this.turnQueue.resolveAll();
		// Slice B: tear down the AgentSession (cancels any running turn) so the
		// next runQuery starts a fresh SDK stream for the new chat.
		this.agentSession?.cancel();
		this.agentSession = null;
		this.agentSessionKey = null;
		this.restartAgentSessionForEffort = false;
		db.clearCurrentSessionId().catch((e) =>
			logDbError("clearCurrentSessionId", e),
		);
	}

	/**
	 * Switches to the given session (loading saved state from DB) and resolves
	 * the agent cwd. Creates the session row when this is the first message.
	 * Must run before buildPrompt so messageSeq, agentCwd, and agentMode are
	 * correct for the turn.
	 */
	private async initSessionContext(
		sessionId: string | undefined,
		agentCwd: string | undefined,
		userMessage: string,
	): Promise<void> {
		let sessionExists = Boolean(
			sessionId && sessionId === this.currentSessionId,
		);
		if (sessionId && sessionId !== this.currentSessionId) {
			const [
				savedSession,
				prior,
				nextMessageSeq,
				savedAgentCwd,
				savedModel,
				savedProviderId,
				savedProviderSessionId,
			] = await Promise.all([
				db.getSessionById(sessionId),
				// Only existence matters here. Provider handoff loads the transcript
				// later and only when needed; do not materialize a long chat on every
				// ordinary session resume.
				db.getSessionMessages(sessionId, undefined, 1),
				db.getSessionNextMessageSeq(sessionId),
				db.getSessionAgentCwd(sessionId),
				db.getSessionModel(sessionId),
				db.getSessionProviderId(sessionId),
				db.getSessionProviderSession(sessionId),
			]);
			sessionExists = Boolean(savedSession);
			if (
				savedSession?.history_imported &&
				(savedSession.history_resume_mode ?? "none") === "none"
			) {
				throw new Error(
					"This imported provider history has accounting data only and cannot be resumed.",
				);
			}
			this.agentCwd = undefined;
			this.agentMode = "cwd";
			this.sessionAllowedTools.clear();
			// The persisted max accounts for sequence values consumed by messages,
			// tools, plans, questions, and linked attachments. The one-row existence
			// sample is a defensive floor for older or partially migrated databases.
			this.messageSeq = Math.max(nextMessageSeq, prior.length);
			this.currentSessionId = sessionId;
			this.currentSessionLabel = savedSession?.label ?? null;
			this.providerSessionId = savedProviderSessionId;
			this.providerSessionProviderId = savedProviderId;
			this.historyResumeMode = savedSession?.history_resume_mode ?? "none";
			if (
				this.providerOverride &&
				savedProviderId &&
				this.providerOverride !== savedProviderId &&
				prior.length > 0
			) {
				this.providerSessionId = null;
				this.providerSessionProviderId = this.providerOverride;
				this.providerHandoffPending = true;
			}
			if (savedAgentCwd) {
				this.agentCwd = savedAgentCwd;
				this.agentMode = resolveAgentMode(savedAgentCwd);
			}
			// Resume with the chat's saved selection, not today's configured
			// vault/Einherjar model.
			if (savedModel !== null && this.modelOverride === null) {
				this.model = savedModel;
				this.modelOverride = { value: savedModel };
			}
			if (savedSession?.selected_effort && this.effortOverride === null) {
				this.effort = savedSession.selected_effort;
				this.effortOverride = savedSession.selected_effort;
			}
			if (
				savedSession?.selected_permission_mode &&
				KNOWN_PERMISSION_MODES.has(savedSession.selected_permission_mode) &&
				this.permissionModeOverride === null
			) {
				this.permissionMode =
					savedSession.selected_permission_mode as PermissionMode;
				this.permissionModeOverride =
					savedSession.selected_permission_mode as PermissionMode;
			}
			db.setCurrentSessionId(sessionId).catch((e) =>
				logDbError("setCurrentSessionId", e),
			);
		}

		// Set agent dir + mode on first message of an agent session (in-memory).
		// Registration is gated by allow_external_agents at save time; here we
		// just confirm the path still matches a registered agent before locking
		// it onto the session. Mode is locked once and survives until session end.
		if (agentCwd && !this.agentCwd) {
			try {
				this.allowedAgentRealPaths = computeAllowedAgentRealPaths(loadConfig());
				const realAgent = realpathSync(expandTilde(agentCwd));
				if (isAllowedAgentPath(this.allowedAgentRealPaths, realAgent)) {
					this.agentCwd = realAgent;
					this.agentMode = resolveAgentMode(realAgent);
				}
			} catch {
				// path doesn't exist or symlink cycle, deny
			}
		}

		// Create DB session record for new sessions
		if (sessionId && this.messageSeq === 0 && !sessionExists) {
			const label = userMessage.slice(0, SESSION_LABEL_LENGTH).toUpperCase();
			this.currentSessionLabel = label;
			const agentSettings = this.agentCwd
				? this.agentSettingsMap.get(this.agentCwd)
				: undefined;
			const selectedModel =
				this.modelOverride !== null
					? (this.modelOverride.value ?? "")
					: (agentSettings?.model ?? this.model);
			const selectedEffort =
				this.effortOverride ?? agentSettings?.effort ?? this.effort;
			const selectedPermissionMode =
				this.permissionModeOverride ??
				agentSettings?.permissionMode ??
				this.permissionMode;
			await db.createSession(sessionId, label, selectedModel, {
				effort: selectedEffort,
				permissionMode: selectedPermissionMode,
			});
		}

		// Persist agent cwd after session row exists
		if (this.agentCwd && sessionId && agentCwd) {
			db.setSessionAgentCwd(sessionId, this.agentCwd).catch((e) => {
				console.error("[session] setSessionAgentCwd failed:", e);
			});
		}
	}

	/** Handle session_start: capture and persist the provider session ID. */
	private handleSessionStart(
		event: Extract<AgentEvent, { type: "session_start" }>,
		sessionId: string | undefined,
		provider: AgentProvider,
		emit: (msg: ServerMessage) => void,
	): void {
		const newId = event.sessionId;
		// Always update on every session_start — the provider may reassign on
		// compaction/fork, and we want the latest valid id persisted for the next
		// turn's resume.
		if (newId) {
			if (newId !== this.providerSessionId) {
				this.providerSessionId = newId;
				this.providerSessionProviderId = provider.providerId;
				if (sessionId) {
					void db
						.setSessionProviderSession(sessionId, provider.providerId, newId)
						.catch((e) => logDbError("setSessionProviderSession", e));
				}
			}
			this.unregisterUmbodApprovalSession?.();
			this.unregisterUmbodApprovalSession = registerUmbodApprovalSession(
				newId,
				(call, reason) =>
					this.promptForHookApproval(call, reason, provider, emit),
				this.usageGateEnforced
					? async () => this.gateOnUsage(provider, emit)
					: undefined,
			);
		}
	}

	private promptForHookApproval(
		call: ToolCall,
		reason: string,
		provider: AgentProvider,
		emit: (msg: ServerMessage) => void,
	): Promise<"allow" | "block"> {
		const toolUseID = call.toolUseId ?? `umbod-${Date.now()}`;
		const toolName = call.tool;
		const obsidianCommand = resolveObsidianCommandPermission(
			toolName,
			call.inputs,
			this.vaultName,
		);
		const permissionKey = obsidianCommand?.key ?? toolName;
		if (this.activeRoutineContext) {
			const routineInput =
				call.inputs &&
				typeof call.inputs === "object" &&
				!Array.isArray(call.inputs)
					? (call.inputs as Record<string, unknown>)
					: {};
			return authorizeRoutineCapability({
				context: this.activeRoutineContext,
				tool: toolName,
				input: routineInput,
				cwd: call.workingDirectory ?? this.vaultPath,
				toolUseId: toolUseID,
			}).then((result) => (result.allowed ? "allow" : "block"));
		}
		const request = {
			type: "permission_request" as const,
			id: toolUseID,
			toolName,
			title:
				obsidianCommand !== null
					? `Run an Obsidian command in ${this.vaultName}?`
					: `${provider.label ?? provider.providerId} wants to use ${toolName}`,
			displayName: obsidianCommand !== null ? "Obsidian command" : undefined,
			description:
				obsidianCommand !== null
					? `${reason}\n\nAlways applies only to command ${obsidianCommand.commandId} in the configured ${this.vaultName} vault.`
					: reason,
			input: call.inputs,
		};
		return new Promise((finish) => {
			if (
				this.sessionAllowedTools.has(permissionKey) ||
				(obsidianCommand !== null &&
					this.rememberedObsidianCommands.has(obsidianCommand.commandId))
			) {
				finish("allow");
				return;
			}
			this.permissions.register(toolUseID, request, (approved, saveScope) => {
				if (approved && saveScope === "session")
					this.sessionAllowedTools.add(permissionKey);
				if (approved && saveScope === "local") {
					try {
						if (obsidianCommand !== null) {
							persistAlwaysAllowedObsidianCommand(
								this.vaultName,
								this.vaultPath,
								obsidianCommand.commandId,
							);
							this.rememberedObsidianCommands.add(obsidianCommand.commandId);
						} else {
							persistAlwaysAllowedTool(
								call.workingDirectory ?? this.vaultPath,
								toolName,
							);
						}
					} catch (error) {
						console.error(
							"[session] failed to write always-allow rule:",
							error,
						);
					}
				}
				finish(approved ? "allow" : "block");
			});
			emit(request);
		});
	}

	/** Handle rate_limit event: emit and persist utilization to DB settings. */
	private handleRateLimit(
		event: Extract<AgentEvent, { type: "rate_limit" }>,
		emit: (msg: ServerMessage) => void,
		provider: AgentProvider,
	): void {
		const providerId = provider.providerId;
		// The Claude Agent SDK emits "seven_day" / "seven_day_sonnet" but hlid
		// uses "weekly" / "weekly_sonnet" as canonical window IDs everywhere
		// (DB settings keys, providerWindows map, applyRateLimitToSnapshot).
		// Translate here so the rest of the system sees consistent names.
		const SDK_TO_WINDOW_ID: Record<string, string> = {
			five_hour: "five_hour",
			seven_day: "weekly",
			seven_day_sonnet: "weekly_sonnet",
		};
		const windowId = event.rateLimitType
			? (SDK_TO_WINDOW_ID[event.rateLimitType] ?? event.rateLimitType)
			: undefined;
		emit({
			type: "rate_limit",
			status: event.status,
			rateLimitType: windowId,
			utilization: event.utilization,
			resetsAt: event.resetsAt as number | undefined,
			providerId,
		});
		// Feed the auto-sleep gate before the utilization guard below — a hard
		// rejection can arrive without a utilization reading.
		reportRateLimitSignal(
			providerId,
			windowId,
			event.status,
			event.resetsAt ?? null,
			loadConfig()?.auto_sleep,
		);
		// Persist for usage windows display, skip if utilization is null
		// (proxy server writes the authoritative value from API response headers)
		if (event.utilization != null && windowId) {
			void db.saveSetting(
				`rl_${providerId}_${windowId}`,
				JSON.stringify({
					utilization: event.utilization,
					resetsAt: event.resetsAt ?? null,
					windowId,
				}),
			);
			// Mirror into the in-memory high-water mark so /db/usage-windows
			// overlay reflects live values immediately (not just on next cold start).
			updateWindowMark(
				providerId,
				windowId,
				event.utilization,
				event.resetsAt ?? null,
			);
		}
		this.reconcileSleepState(provider, emit);
	}

	private async persistAssistantMessage(
		sessionId: string,
		turn: TurnState,
	): Promise<number> {
		const reused = turn.reservedAssistantSeq != null;
		const assistantSeq = turn.reservedAssistantSeq ?? this.messageSeq++;
		if (turn.textWriteTimer) {
			clearTimeout(turn.textWriteTimer);
			turn.textWriteTimer = null;
		}
		turn.textWriteDirty = false;
		if (reused) {
			await db.setMessageText(sessionId, assistantSeq, turn.assistantText);
		} else {
			await db.appendMessage(
				sessionId,
				assistantSeq,
				"assistant",
				turn.assistantText,
			);
		}
		return assistantSeq;
	}

	private persistPendingToolEvents(
		sessionId: string,
		assistantSeq: number,
		turn: TurnState,
		operationSuffix: string,
		providerId: string,
	): void {
		const dimensions = {
			providerId,
			...(turn.lastActualModel ? { model: turn.lastActualModel } : {}),
			agentCwd: this.agentCwd ?? null,
		};
		for (const toolEvent of turn.pendingToolEvents) {
			const result = turn.pendingToolResults.get(toolEvent.toolId);
			const subagent =
				turn.pendingToolUpdates.get(toolEvent.toolId) ?? toolEvent.subagent;
			if (turn.persistedToolIds.has(toolEvent.toolId)) {
				if (result) {
					db.setToolEventResult(
						sessionId,
						toolEvent.toolId,
						result.content,
						result.isError,
					).catch((error) =>
						logDbError(`setToolEventResult (${operationSuffix})`, error),
					);
				}
				if (subagent) {
					db.setToolEventSubagent(sessionId, toolEvent.toolId, subagent).catch(
						(error) =>
							logDbError(`setToolEventSubagent (${operationSuffix})`, error),
					);
				}
				continue;
			}
			const append = subagent
				? db.appendToolEvent(
						sessionId,
						assistantSeq,
						toolEvent.toolId,
						toolEvent.name,
						toolEvent.input,
						subagent,
						dimensions,
					)
				: db.appendToolEvent(
						sessionId,
						assistantSeq,
						toolEvent.toolId,
						toolEvent.name,
						toolEvent.input,
						undefined,
						dimensions,
					);
			append
				.then(async () => {
					if (result) {
						await db.setToolEventResult(
							sessionId,
							toolEvent.toolId,
							result.content,
							result.isError,
						);
					}
					if (subagent) {
						await db.setToolEventSubagent(
							sessionId,
							toolEvent.toolId,
							subagent,
						);
					}
				})
				.catch((error) =>
					logDbError(`appendToolEvent (${operationSuffix})`, error),
				);
		}
	}

	/** Handle done event: persist query + assistant message to DB, emit done. */
	private async handleDone(
		event: Extract<AgentEvent, { type: "done" }>,
		turn: TurnState,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
		provider: AgentProvider,
	): Promise<void> {
		const { primaryModel, tokensInContext, queryData } = buildQueryData(
			event,
			turn,
		);
		// Captured before any reset below — sent on "done" so the client can
		// offer "branch from here" on this row without a history reload.
		const dbMessageId = turn.dbMessageId;
		if (sessionId) {
			queryData.agent_cwd = this.agentCwd ?? null;
			const recorded = await db.recordQuery(
				sessionId,
				queryData,
				provider.providerId,
			);
			if (recorded) queryData.estimated_cost = recorded.estimatedCost;
			bumpDataRevision("stats", "sessions");
			if (turn.lastActualModel) {
				db.setSessionActualModel(sessionId, turn.lastActualModel).catch((e) => {
					console.error("[db] setSessionActualModel failed:", e);
				});
			}
			if (turn.assistantText) {
				turn.lastAssistantText = turn.assistantText;
				const assistantSeq = await this.persistAssistantMessage(
					sessionId,
					turn,
				);
				turn.lastAssistantSeq = assistantSeq;
				this.persistPendingToolEvents(
					sessionId,
					assistantSeq,
					turn,
					"done",
					provider.providerId,
				);
				turn.lastTurnToolEvents = [...turn.pendingToolEvents];
				turn.pendingToolEvents.length = 0;
				turn.pendingToolResults.clear();
				turn.pendingToolUpdates.clear();
				turn.pendingToolEventWrites.clear();
				turn.persistedToolIds.clear();
				turn.reservedAssistantSeq = null;
				turn.dbMessageId = null;
				turn.assistantText = "";
			}
		}
		emit({
			type: "done",
			session_id: sessionId,
			...(this.currentTurnId !== undefined
				? { turn_id: this.currentTurnId }
				: {}),
			...(dbMessageId != null ? { db_id: dbMessageId } : {}),
			cost: event.cost ?? null,
			estimated_cost: queryData.estimated_cost ?? null,
			turns: event.turns,
			duration_ms: event.durationMs,
			input_tokens: queryData.input_tokens,
			output_tokens: queryData.output_tokens,
			cache_read_tokens: queryData.cache_read_tokens,
			cache_creation_tokens: queryData.cache_creation_tokens,
			context_window: queryData.context_window ?? DEFAULT_CONTEXT_WINDOW,
			max_output_tokens: primaryModel?.maxOutputTokens ?? null,
			stop_reason: queryData.stop_reason,
			tokens_in_context: tokensInContext,
		});
	}

	/**
	 * Processes the provider AgentEvent stream for one query, updating
	 * turn state in place.
	 */
	/**
	 * Schedule a throttled DB write of the accumulated assistant text. Called on
	 * every text_delta. The first chunk after an idle window starts an 800ms
	 * timer; subsequent chunks within the window mark the row dirty without
	 * rescheduling. When the timer fires, the *current* (latest) text is
	 * written, so coalesced chunks land in a single UPDATE.
	 */
	private scheduleTextWrite(turn: TurnState, sessionId: string): void {
		const seq = turn.reservedAssistantSeq;
		if (seq == null) return;
		turn.textWriteDirty = true;
		if (turn.textWriteTimer) return;
		turn.textWriteTimer = setTimeout(() => {
			turn.textWriteTimer = null;
			turn.textWriteDirty = false;
			void db
				.setMessageText(sessionId, seq, turn.assistantText)
				.catch((e) => logDbError("setMessageText (live)", e));
		}, TEXT_WRITE_THROTTLE_MS);
	}

	/**
	 * Allocate the assistant message seq + insert an empty placeholder row on
	 * first call. Subsequent calls return the same seq. Used by text_delta and
	 * tool_start so live writes (text streaming, tool_event inserts) attach to
	 * a real row that mid-turn reloads can render.
	 */
	private ensureAssistantRow(turn: TurnState, sessionId: string): number {
		if (turn.reservedAssistantSeq != null) return turn.reservedAssistantSeq;
		const seq = this.messageSeq++;
		turn.reservedAssistantSeq = seq;
		void db
			.appendMessage(sessionId, seq, "assistant", "")
			.then(async (dbId) => {
				turn.dbMessageId = dbId;
				if (turn.providerTurnId) {
					await db.setMessageProviderTurnId(
						sessionId,
						seq,
						turn.providerTurnId,
					);
				}
			})
			.catch((e) => logDbError("appendMessage (placeholder)", e));
		return seq;
	}

	private handleTextDelta(
		event: Extract<AgentEvent, { type: "text_delta" }>,
		turn: TurnState,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
	): void {
		const text =
			turn.lastBlockType === "tool_use" &&
			event.text &&
			!event.text.startsWith("\n")
				? `\n\n${event.text}`
				: event.text;
		const offset = turn.assistantText.length;
		turn.assistantText += text;
		emit({ type: "chunk", text, offset });
		if (sessionId) {
			this.ensureAssistantRow(turn, sessionId);
			this.scheduleTextWrite(turn, sessionId);
		}
		turn.lastBlockType = "text";
	}

	/**
	 * Stamps the current turn's row with the native transcript id of whichever
	 * raw SDK message is contributing right now. Fires once per incoming SDK
	 * message (not throttled like scheduleTextWrite) so a tool-only content
	 * block — text_delta never fires, so the throttled text-write path never
	 * runs — still gets its uuid recorded. The row ends up holding the *last*
	 * uuid seen, i.e. the whole turn, which is what forkSession's
	 * upToMessageId needs to branch "up to and including this displayed row".
	 */
	private handleAssistantMessageId(
		event: Extract<AgentEvent, { type: "assistant_message_id" }>,
		turn: TurnState,
		sessionId: string | undefined,
	): void {
		if (!sessionId) return;
		const seq = this.ensureAssistantRow(turn, sessionId);
		void db
			.setMessageSdkUuid(sessionId, seq, event.id)
			.catch((e) => logDbError("setMessageSdkUuid", e));
	}

	private handleProviderTurnId(
		event: Extract<AgentEvent, { type: "provider_turn_id" }>,
		turn: TurnState,
		sessionId: string | undefined,
	): void {
		turn.providerTurnId = event.id;
		if (!sessionId || turn.reservedAssistantSeq == null) return;
		void db
			.setMessageProviderTurnId(sessionId, turn.reservedAssistantSeq, event.id)
			.catch((e) => logDbError("setMessageProviderTurnId", e));
	}

	private handleToolStart(
		event: Extract<AgentEvent, { type: "tool_start" }>,
		turn: TurnState,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
		provider: AgentProvider,
	): void {
		turn.hadToolEvents = true;
		if (event.name === "ExitPlanMode") {
			turn.lastBlockType = "tool_use";
			return;
		}
		turn.pendingToolEvents.push({
			toolId: event.toolId,
			name: event.name,
			input: event.input,
			...(event.subagent ? { subagent: event.subagent } : {}),
		});
		emit({
			type: "tool_event",
			id: event.toolId,
			name: event.name,
			input: event.input,
			...(event.subagent ? { subagent: event.subagent } : {}),
		});
		if (sessionId) {
			const seq = this.ensureAssistantRow(turn, sessionId);
			const toolId = event.toolId;
			const dimensions = {
				providerId: provider.providerId,
				...(turn.lastActualModel ? { model: turn.lastActualModel } : {}),
				agentCwd: this.agentCwd ?? null,
			};
			const append = event.subagent
				? db.appendToolEvent(
						sessionId,
						seq,
						toolId,
						event.name,
						event.input,
						event.subagent,
						dimensions,
					)
				: db.appendToolEvent(
						sessionId,
						seq,
						toolId,
						event.name,
						event.input,
						undefined,
						dimensions,
					);
			const persisted = append
				.then(() => {
					turn.persistedToolIds.add(toolId);
					const latest = turn.pendingToolUpdates.get(toolId);
					if (latest) {
						void db
							.setToolEventSubagent(sessionId, toolId, latest)
							.catch((e) => logDbError("setToolEventSubagent (live)", e));
					}
					return true;
				})
				.catch((e) => {
					logDbError("appendToolEvent (live)", e);
					return false;
				});
			turn.pendingToolEventWrites.set(toolId, persisted);
			void persisted.finally(() => {
				if (turn.pendingToolEventWrites.get(toolId) === persisted) {
					turn.pendingToolEventWrites.delete(toolId);
				}
			});
		}
		turn.lastBlockType = "tool_use";
	}

	private handleToolUpdate(
		event: Extract<AgentEvent, { type: "tool_update" }>,
		turn: TurnState,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
	): void {
		turn.pendingToolUpdates.set(event.toolId, event.subagent);
		const pending = turn.pendingToolEvents.find(
			(toolEvent) => toolEvent.toolId === event.toolId,
		);
		if (pending) pending.subagent = event.subagent;
		emit({ type: "tool_update", id: event.toolId, subagent: event.subagent });
		if (sessionId && turn.persistedToolIds.has(event.toolId)) {
			void db
				.setToolEventSubagent(sessionId, event.toolId, event.subagent)
				.catch((e) => logDbError("setToolEventSubagent (live)", e));
		}
	}

	/**
	 * A provider turn cannot leave a child card live after the parent has ended.
	 * Some transports finish or are cancelled without emitting a final child
	 * update, so settle every active snapshot before persisting/emitting `done`.
	 */
	private settleIncompleteSubagents(
		turn: TurnState,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
	): void {
		const snapshots = new Map<string, SubagentSnapshot>();
		for (const event of turn.pendingToolEvents) {
			if (event.subagent) snapshots.set(event.toolId, event.subagent);
		}
		for (const [toolId, subagent] of turn.pendingToolUpdates) {
			snapshots.set(toolId, subagent);
		}
		for (const [toolId, subagent] of snapshots) {
			if (
				subagent.status !== "pending" &&
				subagent.status !== "running" &&
				subagent.status !== "paused"
			) {
				continue;
			}
			this.handleToolUpdate(
				{
					type: "tool_update",
					toolId,
					subagent: {
						...subagent,
						status: "interrupted",
						currentStep: "Parent turn ended before the subagent completed",
						endedAtMs: Date.now(),
					},
				},
				turn,
				sessionId,
				emit,
			);
		}
	}

	private async handleToolResult(
		event: Extract<AgentEvent, { type: "tool_result" }>,
		turn: TurnState,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
	): Promise<void> {
		turn.pendingToolResults.set(event.toolId, {
			content: event.content,
			isError: event.isError === true,
		});

		let persisted = false;
		if (sessionId) {
			const pendingInsert = turn.pendingToolEventWrites.get(event.toolId);
			persisted = pendingInsert
				? await pendingInsert
				: turn.persistedToolIds.has(event.toolId);
			if (persisted) {
				try {
					await db.setToolEventResult(
						sessionId,
						event.toolId,
						event.content,
						event.isError === true,
					);
					// Once the database owns the complete result, the per-turn accumulator
					// no longer needs another full-size reference.
					turn.pendingToolResults.delete(event.toolId);
				} catch (error) {
					persisted = false;
					logDbError("setToolEventResult (live)", error);
				}
			}
		}

		const compact =
			persisted &&
			Boolean(sessionId) &&
			event.content.length > TOOL_RESULT_PREVIEW_CHARS;
		emit({
			type: "tool_result",
			id: event.toolId,
			content: compact
				? event.content.slice(0, TOOL_RESULT_PREVIEW_CHARS)
				: event.content,
			...(compact
				? {
						resultTruncated: true,
						resultLength: event.content.length,
						detailSessionId: sessionId,
					}
				: {}),
			...(event.isError ? { isError: true } : {}),
		});
	}

	private handleUsage(
		event: Extract<AgentEvent, { type: "usage" }>,
		turn: TurnState,
		emit: (msg: ServerMessage) => void,
	): void {
		const cacheRead = event.cacheReadTokens ?? 0;
		const cacheCreation = event.cacheCreationTokens ?? 0;
		turn.liveQueryUsage = event.queryUsage
			? { ...event.queryUsage }
			: {
					inputTokens: turn.liveQueryUsage.inputTokens + event.inputTokens,
					outputTokens: turn.liveQueryUsage.outputTokens + event.outputTokens,
					cacheReadTokens: turn.liveQueryUsage.cacheReadTokens + cacheRead,
					cacheCreationTokens:
						turn.liveQueryUsage.cacheCreationTokens + cacheCreation,
				};
		turn.lastTurnUsage = {
			input_tokens: event.inputTokens,
			cache_read_input_tokens: event.cacheReadTokens,
			cache_creation_input_tokens: event.cacheCreationTokens,
		};
		turn.lastActualModel = event.model ?? null;
		if (event.contextWindow) turn.lastKnownContextWindow = event.contextWindow;
		if (event.contextTokens != null)
			turn.lastContextTokens = event.contextTokens;
		const tokensInContext =
			event.contextTokens ?? event.inputTokens + cacheRead + cacheCreation;
		emit({
			type: "usage_update",
			input_tokens: event.inputTokens,
			output_tokens: event.outputTokens,
			cache_read_tokens: cacheRead,
			cache_creation_tokens: cacheCreation,
			query_input_tokens: turn.liveQueryUsage.inputTokens,
			query_output_tokens: turn.liveQueryUsage.outputTokens,
			query_cache_read_tokens: turn.liveQueryUsage.cacheReadTokens,
			query_cache_creation_tokens: turn.liveQueryUsage.cacheCreationTokens,
			tokens_in_context: tokensInContext,
			actualModel: event.model,
			context_window: turn.lastKnownContextWindow ?? DEFAULT_CONTEXT_WINDOW,
		});
	}

	private async handleConversationEvent(
		event: AgentEvent,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
		turn: TurnState,
		provider: AgentProvider,
	): Promise<boolean> {
		switch (event.type) {
			case "session_start":
				this.handleSessionStart(event, sessionId, provider, emit);
				break;
			case "transport_error":
				throw new Error(event.message);
			case "commands_changed":
				emit({
					type: "slash_commands",
					provider_id: provider.providerId,
					...(this.agentCwd ? { agent_cwd: this.agentCwd } : {}),
					...(sessionId ? { session_id: sessionId } : {}),
					commands: event.commands,
				});
				break;
			case "text_delta":
				this.handleTextDelta(event, turn, sessionId, emit);
				break;
			case "assistant_message_id":
				this.handleAssistantMessageId(event, turn, sessionId);
				break;
			case "provider_turn_id":
				this.handleProviderTurnId(event, turn, sessionId);
				break;
			case "tool_start":
				this.handleToolStart(event, turn, sessionId, emit, provider);
				break;
			case "tool_update":
				this.handleToolUpdate(event, turn, sessionId, emit);
				break;
			case "tool_result":
				await this.handleToolResult(event, turn, sessionId, emit);
				break;
			case "usage":
				this.handleUsage(event, turn, emit);
				break;
			case "summary":
				turn.sdkSummary = event.text;
				emit({ type: "tool_use_summary", summary: event.text });
				break;
			case "rate_limit":
				this.handleRateLimit(event, emit, provider);
				break;
			case "local_command_output":
				emit({ type: "local_command_output", content: event.content });
				break;
			case "mcp_status":
				this.mcpStatusByProvider.set(provider.providerId, event.servers);
				emit({
					type: "mcp_status",
					provider_id: provider.providerId,
					...(this.agentCwd ? { agent_cwd: this.agentCwd } : {}),
					...(sessionId ? { session_id: sessionId } : {}),
					servers: event.servers.map(mapMcpServer),
				});
				break;
			case "done":
				this.settleIncompleteSubagents(turn, sessionId, emit);
				await this.handleDone(event, turn, sessionId, emit, provider);
				return true;
		}
		return false;
	}

	private async refreshMcpStatus(
		session: AgentSession,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
		provider: AgentProvider,
	): Promise<McpServerStatus[]> {
		if (!session.mcpServerStatus) return [];
		try {
			const statuses = await session.mcpServerStatus();
			this.mcpStatusByProvider.set(provider.providerId, statuses);
			emit({
				type: "mcp_status",
				provider_id: provider.providerId,
				...(this.agentCwd ? { agent_cwd: this.agentCwd } : {}),
				...(sessionId ? { session_id: sessionId } : {}),
				servers: statuses.map(mapMcpServer),
			});
			return statuses;
		} catch {
			// Runtime MCP discovery is optional and must not fail a turn.
			return [];
		}
	}

	private scheduleDeferredMcpRefresh(
		session: AgentSession,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
		provider: AgentProvider,
		initialStatuses: McpServerStatus[],
	): void {
		const generation = ++this.mcpRefreshGeneration;
		if (
			!provider.probeRequiresTurn ||
			(initialStatuses.length > 0 &&
				initialStatuses.every((server) => server.status !== "pending"))
		)
			return;
		void (async () => {
			for (const delayMs of [500, 1_500, 3_000, 5_000]) {
				await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
				if (
					generation !== this.mcpRefreshGeneration ||
					this.agentSession !== session
				)
					return;
				const statuses = await this.refreshMcpStatus(
					session,
					sessionId,
					emit,
					provider,
				);
				if (
					statuses.length > 0 &&
					statuses.every((server) => server.status !== "pending")
				)
					return;
			}
		})();
	}

	private async iterateConversation(
		session: AgentSession,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
		turn: TurnState,
		provider: AgentProvider,
	): Promise<void> {
		let mcpChecked = false;
		let initialMcpRefresh: Promise<McpServerStatus[]> | undefined;
		let commandsChecked = false;
		let usageRefresh:
			| ReturnType<SessionManager["startLiveProviderUsageRefresh"]>
			| undefined;
		try {
			for await (const event of session) {
				turn.receivedAny = true;
				usageRefresh ??= this.startLiveProviderUsageRefresh(
					session,
					provider,
					turn,
					emit,
				);
				if (!mcpChecked) {
					mcpChecked = true;
					if (session.mcpServerStatus) {
						initialMcpRefresh = this.refreshMcpStatus(
							session,
							sessionId,
							emit,
							provider,
						);
					}
				}
				if (!commandsChecked) {
					commandsChecked = true;
					if (session.supportedCommands) {
						try {
							emit({
								type: "slash_commands",
								provider_id: provider.providerId,
								...(this.agentCwd ? { agent_cwd: this.agentCwd } : {}),
								...(sessionId ? { session_id: sessionId } : {}),
								commands: await session.supportedCommands(),
							});
						} catch {
							// Command discovery is optional and must not fail a turn.
						}
					}
				}
				if (event.type === "done") {
					await usageRefresh.finish();
					await initialMcpRefresh;
					const statuses = await this.refreshMcpStatus(
						session,
						sessionId,
						emit,
						provider,
					);
					this.scheduleDeferredMcpRefresh(
						session,
						sessionId,
						emit,
						provider,
						statuses,
					);
				}
				if (
					await this.handleConversationEvent(
						event,
						sessionId,
						emit,
						turn,
						provider,
					)
				)
					return;
			}
		} finally {
			usageRefresh?.stop();
			// Covers iterator exhaustion, transport errors, and cancellation. The done
			// path already settled these snapshots, making this call idempotent.
			this.settleIncompleteSubagents(turn, sessionId, emit);
		}
	}

	/**
	 * Submit a turn. Re-entrant: if a turn is already running, this call queues
	 * behind it and resolves when *its* turn completes. Status stays "running"
	 * across queued turns and only flips to "idle" when the queue is fully
	 * drained (mirrors CLI behavior — typed-while-running messages are accepted
	 * and processed at the next turn boundary).
	 */
	async runQuery(...args: RunQueryArgs): Promise<void> {
		const completion = this.turnQueue.enqueue(args, args[6]);
		if (!this.isDraining) void this.drainTurnQueue();
		return completion;
	}

	/**
	 * Slice C: drop a not-yet-started turn from the queue. Returns true if a
	 * matching pending turn was found and removed (its promise resolves
	 * silently). Returns false if the turn id is unknown OR refers to the
	 * currently running turn (which has already been shifted off the queue
	 * — use abort() to stop it instead).
	 */
	/**
	 * Slice C polish: snapshot of the server's queue state. Used by clients
	 * (on connect / sync) to prune orphan chatQueue entries — e.g. items
	 * that were _sent before a server restart and have no matching QueuedTurn
	 * anymore.
	 */
	getQueueState(): QueueStateSnapshot {
		const pendingTurns = this.turnQueue.pendingTurns().flatMap((turn) => {
			const id = turn.turnId;
			const sessionId = turn.args[2] ?? this.currentSessionId;
			if (!id || !sessionId) return [];
			return [
				{
					id,
					text: turn.args[0],
					session_id: sessionId,
					...(typeof turn.args[3] === "string"
						? { skill_context: turn.args[3] }
						: turn.args[3]?.length
							? { skill_contexts: turn.args[3] }
							: {}),
					...(turn.args[4] ? { attachments: turn.args[4] } : {}),
					...(turn.args[5] ? { agent_cwd: turn.args[5] } : {}),
					...(turn.args[7] !== undefined ? { plan_mode: turn.args[7] } : {}),
					...(turn.args[8] !== undefined ? { plan_html: turn.args[8] } : {}),
					...(turn.args[9] ? { command_action: turn.args[9] } : {}),
					...(turn.args[10]?.length ? { vault_references: turn.args[10] } : {}),
					...(turn.args[12]
						? {
								goal: {
									objective: turn.args[12].objective,
									...(turn.args[12].tokenBudget !== undefined
										? { token_budget: turn.args[12].tokenBudget }
										: {}),
								},
							}
						: {}),
				},
			];
		});
		return {
			pending_turn_ids: this.turnQueue.pendingTurnIds(),
			pending_turns: pendingTurns,
			running_turn_id:
				this.state === "running" ? (this.currentTurnId ?? null) : null,
		};
	}

	cancelQueued(turnId: string): boolean {
		return this.turnQueue.cancel(turnId);
	}

	/**
	 * Slice C: move a queued turn to the head of the queue and interrupt the
	 * currently running turn so the promoted msg runs next. Returns false if
	 * the turn id is unknown OR refers to the running turn (already shifted
	 * off the queue). The current turn's partial output is preserved by the
	 * SDK's interrupt mechanism — the promoted turn runs as a fresh user msg
	 * in the same session.
	 */
	promoteQueued(turnId: string): boolean {
		if (!this.turnQueue.promote(turnId)) return false;
		// Interrupt current — drain loop's await iterateConversation returns,
		// drain proceeds to the next queue head (the promoted turn).
		void this.agentSession?.interrupt?.();
		return true;
	}

	private async drainTurnQueue(): Promise<void> {
		if (this.isDraining) return;
		this.isDraining = true;

		// Initialize the abortController once for the whole drain. Status
		// running is emitted PER ITERATION below (with turn_id) so the client
		// can distinguish "queued behind" from "currently running."
		const head = this.turnQueue.peek();
		if (head && this.state !== "running") {
			this.state = "running";
			this.abortController = new AbortController();
		}

		let lastEmit: ((msg: ServerMessage) => void) | null = null;
		try {
			while (this.turnQueue.length > 0) {
				const next = this.turnQueue.shift();
				if (!next) break;
				// Recover from a prior turn's error so the next queued turn runs
				// cleanly. Per-turn errors are already signaled to the UI via the
				// "error" event emitted from runOneTurn.
				if (this.state === "error") this.state = "running";
				lastEmit = next.args[1];
				try {
					await this.runOneTurn(...next.args);
					next.resolve();
				} catch (err) {
					next.reject(err instanceof Error ? err : new Error(String(err)));
				}
			}
		} finally {
			this.isDraining = false;
			this.abortController = null;
			// Settle final state. Per-turn errors set state="error" via the
			// runOneTurn catch; preserve that. Otherwise return to idle.
			if (this.state === "running") this.state = "idle";
			// An idle/error session is not sleeping. The status message clears the
			// client banner; clear the replay copy as the matching server invariant.
			this.sleepState = null;
			this.sleepEmit = null;
			lastEmit?.({
				type: "status",
				state: this.state,
				model: this.model,
				permission_mode: this.permissionMode,
				effort: this.effort,
			});
		}
	}

	/**
	 * Auto-sleep gate. Blocks while the provider's preferred usage window is at
	 * the configured threshold (or hard-limited) and auto_sleep is enabled,
	 * waking at the window reset, on "resume now", or on abort. The five-hour
	 * window is preferred, with weekly as the fallback. Emits agent_sleep
	 * transitions and tracks sleepState for sync replay.
	 *
	 * Provider sessions keep host pre-tool boundaries active while auto-sleep is
	 * enabled, even when bypassPermissions is configured. Permission results
	 * remain automatic, but only after the usage gate has run.
	 */
	private async gateOnUsage(
		provider: AgentProvider,
		emit: (msg: ServerMessage) => void,
	): Promise<"proceeded" | "aborted"> {
		const cfg = loadConfig()?.auto_sleep;
		if (!cfg?.enabled) return "proceeded";
		const providerId = provider.providerId;
		return sleepUntilAllowed({
			providerId,
			cfg,
			signal: this.abortController?.signal ?? undefined,
			onSleep: (decision: SleepDecision) => {
				this.publishSleepState(providerId, decision, emit);
			},
			onWake: (cause) => {
				this.clearSleepState(providerId, cause, emit);
			},
		});
	}

	private publishSleepState(
		providerId: string,
		decision: SleepDecision,
		emit: (msg: ServerMessage) => void,
	): void {
		const current = this.sleepState;
		// A capped decision is recomputed from the current clock. Preserve the
		// first deadline so live usage polling cannot slide max_sleep forward.
		const until =
			decision.capApplied &&
			current?.state === "sleeping" &&
			current.providerId === providerId &&
			current.reason === decision.reason &&
			current.until != null
				? current.until
				: decision.until;
		const message: AgentSleepMessage = {
			type: "agent_sleep",
			state: "sleeping",
			providerId,
			windowId: decision.windowId,
			until,
			reason: decision.reason,
			...(decision.utilization != null
				? { utilization: decision.utilization }
				: {}),
			...(this.currentSessionId ? { session_id: this.currentSessionId } : {}),
		};
		this.sleepEmit = emit;
		if (
			current?.state === "sleeping" &&
			current.providerId === message.providerId &&
			current.windowId === message.windowId &&
			current.until === message.until &&
			current.reason === message.reason &&
			current.utilization === message.utilization &&
			current.session_id === message.session_id
		) {
			return;
		}
		this.sleepState = message;
		emit(message);
	}

	private clearSleepState(
		providerId: string,
		cause: "reset" | "skipped" | "aborted",
		emit: (msg: ServerMessage) => void,
	): void {
		if (
			this.sleepState?.state !== "sleeping" ||
			this.sleepState.providerId !== providerId
		) {
			return;
		}
		this.sleepState = null;
		this.sleepEmit = null;
		emit({
			type: "agent_sleep",
			state: "resumed",
			providerId,
			cause,
			...(this.currentSessionId ? { session_id: this.currentSessionId } : {}),
		});
	}

	/**
	 * Keep the banner aligned with provider-global usage even when utilization
	 * crosses the threshold after a turn has already started. Tool/turn gates
	 * still enforce the pause; this reconciliation makes their state visible to
	 * the current client and available for late subscription replay.
	 */
	private reconcileSleepState(
		provider: AgentProvider,
		emit: (msg: ServerMessage) => void,
	): void {
		if (this.state !== "running") return;
		const cfg = loadConfig()?.auto_sleep;
		const decision = evaluateSleep(provider.providerId, cfg);
		if (decision) {
			this.publishSleepState(provider.providerId, decision, emit);
			return;
		}
		this.clearSleepState(provider.providerId, "reset", emit);
	}

	/** "Resume now": wake every session sleeping on this session's provider. */
	skipSleep(): void {
		const providerId = this.resolveProvider(this.agentCwd).providerId;
		const sleepingWindow = this.sleepState?.windowId;
		skipProviderSleep(
			providerId,
			sleepingWindow === "five_hour" || sleepingWindow === "weekly"
				? sleepingWindow
				: undefined,
		);
		if (this.sleepEmit) {
			this.clearSleepState(providerId, "skipped", this.sleepEmit);
		}
	}

	/** Pending sleep banner for sync replay, or null when not sleeping. */
	getSleepState(): AgentSleepMessage | null {
		return this.state === "running" ? this.sleepState : null;
	}

	private createToolPermissionHandler(
		provider: AgentProvider,
		activeCwd: string,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
		autoApproveTools: boolean,
	): CanUseTool {
		return async (
			toolName,
			input,
			{ toolUseID, title, displayName, description },
		) => {
			if ((await this.gateOnUsage(provider, emit)) === "aborted") {
				return {
					behavior: "deny",
					message: "Aborted while sleeping on usage limit",
				};
			}
			return new Promise((resolve) => {
				const passInput = input as Record<string, unknown>;
				if (toolName === "AskUserQuestion") {
					if (this.activeRoutineContext) {
						const reason =
							"AskUserQuestion requires an interactive response and cannot run unattended";
						this.activeRoutineContext.actionRequired ??= {
							tool: toolName,
							reason,
						};
						void this.activeRoutineContext.onActionRequired?.(reason);
						resolve({ behavior: "deny", message: reason });
						return;
					}
					this.interceptAskUserQuestion(
						passInput,
						toolUseID,
						title,
						sessionId,
						emit,
						resolve,
					);
					return;
				}
				if (this.isPreApprovedPlanWrite(toolName, passInput)) {
					resolve({ behavior: "allow", updatedInput: passInput });
					return;
				}
				if (toolName === "ExitPlanMode") {
					if (this.activeRoutineContext) {
						const reason =
							"ExitPlanMode requires interactive approval and cannot run unattended";
						this.activeRoutineContext.actionRequired ??= {
							tool: toolName,
							reason,
						};
						void this.activeRoutineContext.onActionRequired?.(reason);
						resolve({ behavior: "deny", message: reason });
						return;
					}
					this.interceptExitPlanMode(
						passInput,
						toolUseID,
						sessionId,
						emit,
						resolve,
					);
					return;
				}
				this.resolveToolPermission({
					provider,
					activeCwd,
					sessionId,
					emit,
					toolName,
					toolUseID,
					title,
					displayName,
					description,
					passInput,
					autoApproveTools,
					resolve,
				});
			});
		};
	}

	/** AskUserQuestion never shows a permission card: persist the questions, emit the modal, and resolve with the user's answers merged into the tool input. */
	private interceptAskUserQuestion(
		passInput: Record<string, unknown>,
		toolUseID: string,
		title: string | undefined,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
		resolve: (decision: AgentToolDecision) => void,
	): void {
		const { questions } = parseAskUserQuestion(passInput, title);
		const request = {
			type: "ask_user_question" as const,
			id: toolUseID,
			questions,
		};
		if (sessionId) {
			void db
				.appendAskUserQuestion(
					sessionId,
					toolUseID,
					this.messageSeq++,
					JSON.stringify(questions),
				)
				.catch((error) => logDbError("appendAskUserQuestion", error));
		} else {
			this.messageSeq++;
		}
		this.askUserQuestions.register(toolUseID, request, (answers, notes) => {
			const existing = (passInput.answers as Record<string, string>) ?? {};
			const sdkAnswers: Record<string, string> = { ...existing };
			for (const [question, picks] of Object.entries(answers)) {
				const note = notes?.[question]?.trim();
				sdkAnswers[question] = note
					? `${picks.join(", ")}\n\nNotes: ${note}`
					: picks.join(", ");
			}
			resolve({
				behavior: "allow",
				updatedInput: { ...passInput, answers: sdkAnswers },
			});
		});
		emit(request);
	}

	/**
	 * Plan-mode HTML handoff: the agent is instructed to write its plan
	 * document to exactly this.planHtmlPath, so that one write is
	 * pre-approved (plan mode otherwise routes writes through the
	 * permission card).
	 */
	private isPreApprovedPlanWrite(
		toolName: string,
		passInput: Record<string, unknown>,
	): boolean {
		return Boolean(
			this.planHtmlPath &&
				(toolName === "Write" || toolName === "Edit") &&
				typeof passInput.file_path === "string" &&
				(resolvePath(passInput.file_path) === this.planHtmlPath ||
					passInput.file_path ===
						toProviderRuntimePath(
							this.agentMode === "cwd" && this.agentCwd
								? this.agentCwd
								: this.vaultPath,
							this.planHtmlPath,
						)),
		);
	}

	/** ExitPlanMode becomes a plan proposal: ingest the HTML artifact, persist the proposal, and resolve allow/deny from the user's decision on the plan card. */
	private interceptExitPlanMode(
		passInput: Record<string, unknown>,
		toolUseID: string,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
		resolve: (decision: AgentToolDecision) => void,
	): void {
		const planText =
			typeof passInput.plan === "string"
				? passInput.plan
				: JSON.stringify(passInput.plan ?? "");
		const planSeq = this.messageSeq++;
		// Keep Raven visibly active while the HTML artifact is validated,
		// copied, linked, and persisted before the proposal can be shown.
		this.emitRunningStatus(emit);
		void (async () => {
			let htmlRelicId: string | null = null;
			if (this.planHtmlPath && sessionId) {
				htmlRelicId = await ingestPlanHtml({
					sourcePath: this.planHtmlPath,
					sessionId,
					planSeq,
					maxBytes: loadConfig().attachments.max_bytes,
				});
			}
			const request = {
				type: "plan_mode_exit" as const,
				id: toolUseID,
				input: passInput,
				...(htmlRelicId ? { html_relic_id: htmlRelicId } : {}),
			};
			if (sessionId) {
				void db
					.appendPlanProposal(
						sessionId,
						toolUseID,
						planSeq,
						planText,
						"pending",
						htmlRelicId,
					)
					.catch((error) => logDbError("appendPlanProposal", error));
			}
			this.planModeManager.register(
				toolUseID,
				request,
				(decision, feedback) => {
					if (sessionId) {
						void db
							.setPlanProposalDecision(sessionId, toolUseID, decision)
							.catch((error) => logDbError("setPlanProposalDecision", error));
					}
					if (decision === "approved") {
						resolve({ behavior: "allow", updatedInput: passInput });
					} else {
						resolve({
							behavior: "deny",
							message:
								decision === "edited"
									? `User requested changes to the plan:\n\n${feedback ?? ""}`
									: "Plan was cancelled by the user.",
						});
					}
				},
			);
			// Re-broadcast after registration so pool-wide status includes the
			// pending plan interaction before the modal event arrives.
			this.emitRunningStatus(emit);
			if (htmlRelicId) {
				bumpDataRevision("relics", "storage");
				emit({
					type: "attachment_created",
					id: htmlRelicId,
					kind: "ephemeral",
				});
			}
			emit(request);
		})();
	}

	/**
	 * Umbod governs whether Hlid may start a Computer Use task. This is separate
	 * from the native per-app approval boundary enforced later by Computer Use.
	 */
	private async authorizeWindowsComputerUseCommand(options: {
		provider: AgentProvider;
		activeCwd: string;
		sessionId: string | undefined;
		turnId: string | undefined;
		task: string;
		emit: (msg: ServerMessage) => void;
	}): Promise<void> {
		const { provider, activeCwd, sessionId, turnId, task, emit } = options;
		if (this.activeRoutineContext) {
			const reason =
				"Windows Computer Use cannot be preapproved for unattended Routines";
			this.activeRoutineContext.actionRequired ??= {
				tool: "hlid.windows_computer_use",
				reason,
			};
			await this.activeRoutineContext.onActionRequired?.(reason);
			throw new Error(reason);
		}
		const toolName = "hlid.windows_computer_use";
		const toolUseId = `hlid-windows-computer-use-${turnId ?? Date.now()}`;
		let denyMessage: string | undefined;
		const prompt = (reason: string) =>
			new Promise<"allow" | "block">((finish) => {
				if (this.sessionAllowedTools.has(toolName)) {
					finish("allow");
					return;
				}
				const request = {
					type: "permission_request" as const,
					id: toolUseId,
					toolName,
					title: "Allow Hlid to start Windows Computer Use?",
					displayName: "Windows Computer Use",
					description: reason,
					input: { task },
					// Permanent capability policy belongs in umbod.toml. The approval
					// card may still remember this decision for the current chat.
					allowAlways: false,
				};
				this.permissions.register(
					toolUseId,
					request,
					(approved, saveScope, customDenyMessage) => {
						if (!approved) {
							denyMessage = customDenyMessage;
							finish("block");
							return;
						}
						if (saveScope === "session") this.sessionAllowedTools.add(toolName);
						finish("allow");
					},
				);
				emit(request);
			});

		let policy: Awaited<ReturnType<typeof authorizeHlidTool>>;
		try {
			policy = await authorizeHlidTool({
				agent: provider.providerId,
				tool: toolName,
				input: { task },
				cwd: activeCwd,
				sessionId,
				toolUseId,
				bypassApproval: false,
				prompt,
			});
		} catch (error) {
			throw new Error(
				`Umbod policy error: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!policy || policy.decision === "allow") return;
		throw new Error(
			policy.policyDecision === "block"
				? (policy.reason ?? "Windows Computer Use was blocked by Umbod")
				: (denyMessage ?? "Windows Computer Use was denied by user"),
		);
	}

	/** Generic tool path: usage gate, then Umbod policy, then (if the policy defers) the interactive permission card. */
	private resolveToolPermission(options: {
		provider: AgentProvider;
		activeCwd: string;
		sessionId: string | undefined;
		emit: (msg: ServerMessage) => void;
		toolName: string;
		toolUseID: string;
		title: string | undefined;
		displayName: string | undefined;
		description: string | undefined;
		passInput: Record<string, unknown>;
		autoApproveTools: boolean;
		resolve: (decision: AgentToolDecision) => void;
	}): void {
		const {
			provider,
			activeCwd,
			sessionId,
			emit,
			toolName,
			toolUseID,
			title,
			displayName,
			description,
			passInput,
			autoApproveTools,
			resolve,
		} = options;
		const obsidianCommand = resolveObsidianCommandPermission(
			toolName,
			passInput,
			this.vaultName,
		);
		const permissionKey = obsidianCommand?.key ?? toolName;
		const request = {
			type: "permission_request" as const,
			id: toolUseID,
			toolName,
			title:
				obsidianCommand !== null
					? `Run an Obsidian command in ${this.vaultName}?`
					: (title ??
						`${provider.label ?? provider.providerId} wants to use ${toolName}`),
			displayName: obsidianCommand !== null ? "Obsidian command" : displayName,
			description:
				obsidianCommand !== null
					? `Always applies only to command ${obsidianCommand.commandId} in the configured ${this.vaultName} vault.`
					: description,
			input: passInput as Record<string, unknown> | undefined,
			...(toolName.startsWith("hlid.windows_computer_use:")
				? { allowOnce: false }
				: {}),
		};
		let denyMessage: string | undefined;
		let approvalSaveScope: "session" | "local" | undefined;
		const isWindowsComputerUseApproval = toolName.startsWith(
			"hlid.windows_computer_use:",
		);
		let routineDecision: Promise<"allow" | "block"> | null = null;
		const prompt = (reason?: string) => {
			if (this.activeRoutineContext) {
				if (!routineDecision) {
					routineDecision = authorizeRoutineCapability({
						context: this.activeRoutineContext,
						tool: toolName,
						input: passInput,
						cwd: activeCwd,
						toolUseId: toolUseID,
					}).then((result) => {
						if (!result.allowed && reason) denyMessage = reason;
						return result.allowed ? "allow" : "block";
					});
				}
				return routineDecision;
			}
			return new Promise<"allow" | "block">((finish) => {
				if (
					this.sessionAllowedTools.has(permissionKey) ||
					(obsidianCommand !== null &&
						this.rememberedObsidianCommands.has(obsidianCommand.commandId))
				) {
					approvalSaveScope = "session";
					finish("allow");
					return;
				}
				this.permissions.register(
					toolUseID,
					{ ...request, description: reason ?? request.description },
					(approved, saveScope, customDenyMessage) => {
						this.permissions.delete(toolUseID);
						if (!approved) {
							denyMessage = customDenyMessage;
							finish("block");
							return;
						}
						approvalSaveScope = saveScope;
						if (saveScope === "session") {
							this.sessionAllowedTools.add(permissionKey);
						}
						if (saveScope === "local" && !isWindowsComputerUseApproval) {
							try {
								if (obsidianCommand !== null) {
									persistAlwaysAllowedObsidianCommand(
										this.vaultName,
										this.vaultPath,
										obsidianCommand.commandId,
									);
									this.rememberedObsidianCommands.add(
										obsidianCommand.commandId,
									);
								} else {
									persistAlwaysAllowedTool(activeCwd, toolName);
								}
							} catch (error) {
								console.error(
									"[session] failed to write always-allow rule:",
									error,
								);
							}
						}
						finish("allow");
					},
				);
				emit({ ...request, description: reason ?? request.description });
			});
		};

		// Windows Computer Use has its own per-app approval boundary. The app ID is
		// part of toolName, so session persistence remains scoped to that exact app.
		// Do not let Umbod policy defaults or provider-wide bypass mode silently
		// grant a new Windows app. "Always" persistence is returned to the native
		// Computer Use plugin instead of being written as a generic Hlid tool rule.
		if (isWindowsComputerUseApproval) {
			void prompt().then((decision) => {
				resolve(
					decision === "allow"
						? {
								behavior: "allow",
								updatedInput: passInput,
								...(approvalSaveScope && obsidianCommand === null
									? { saveScope: approvalSaveScope }
									: {}),
							}
						: {
								behavior: "deny",
								message: denyMessage ?? "Denied by user",
							},
				);
			});
			return;
		}

		// createToolPermissionHandler has already applied the usage gate to every
		// tool path, including special question/plan paths. Preserve bypass mode
		// as an auto-allow only after that gate has had a chance to sleep.
		if (
			autoApproveTools &&
			obsidianCommand === null &&
			this.activeRoutineContext === null
		) {
			resolve({ behavior: "allow", updatedInput: passInput });
			return;
		}
		void authorizeHlidTool({
			agent: provider.providerId,
			tool: toolName,
			input: passInput,
			cwd: activeCwd,
			sessionId,
			toolUseId: toolUseID,
			// Once Umbod is enabled it is the policy authority. Provider-level
			// bypassPermissions must not turn an Umbod `approve` decision into a
			// silent allow; the approval still belongs in the originating chat.
			bypassApproval: false,
			prompt: (reason) => prompt(reason),
		})
			.then(async (policy) => {
				let decision: "allow" | "block";
				if (policy?.policyDecision === "block") {
					decision = "block";
					if (this.activeRoutineContext) {
						const reason = policy.reason ?? `${toolName} was blocked by Umbod`;
						this.activeRoutineContext.actionRequired ??= {
							tool: toolName,
							reason,
						};
						await this.activeRoutineContext.onActionRequired?.(reason);
					}
				} else if (this.activeRoutineContext) {
					// Routine permissions are an envelope, not an Umbod bypass. Even a
					// broad Umbod allow must also match the reviewed Routine profile.
					decision = await prompt(policy?.reason);
				} else if (
					obsidianCommand !== null &&
					policy?.policyDecision !== "approve"
				) {
					// A generic policy allow cannot grant a newly discovered Obsidian
					// command. The exact command ID must be remembered or approved in
					// the originating chat. An Umbod approve rule already invoked this
					// same prompt callback, so reuse its decision without asking twice.
					decision = await prompt();
				} else {
					decision = policy?.decision ?? (await prompt());
				}
				resolve(
					decision === "allow"
						? {
								behavior: "allow",
								updatedInput: passInput,
								...(approvalSaveScope && obsidianCommand === null
									? { saveScope: approvalSaveScope }
									: {}),
							}
						: {
								behavior: "deny",
								message:
									policy?.policyDecision === "block"
										? policy.reason
										: (denyMessage ?? "Denied by user"),
							},
				);
			})
			.catch((error) => {
				if (this.activeRoutineContext) {
					const reason = `Umbod policy error: ${error instanceof Error ? error.message : String(error)}`;
					this.activeRoutineContext.actionRequired ??= {
						tool: toolName,
						reason,
					};
					void this.activeRoutineContext.onActionRequired?.(reason);
				}
				resolve({
					behavior: "deny",
					message: `Umbod policy error: ${error instanceof Error ? error.message : String(error)}`,
				});
			});
	}

	/** Emit the running-status heartbeat for the current turn. */
	private emitRunningStatus(emit: (msg: ServerMessage) => void): void {
		emit({
			type: "status",
			state: "running",
			model: this.model,
			permission_mode: this.permissionMode,
			effort: this.effort,
			...(this.currentTurnId !== undefined
				? { turn_id: this.currentTurnId }
				: {}),
		});
	}

	/**
	 * Arm or clear the HTML-plan handoff path for this turn. When armed, the
	 * prompt gains buildPlanHtmlInstructions(path), the Write/Edit permission
	 * handler auto-allows that exact path, and the ExitPlanMode intercept
	 * ingests the file as an ephemeral relic.
	 */
	private async syncPlanHtmlPath(
		enabled: boolean,
		sessionId: string | undefined,
	): Promise<void> {
		if (!enabled || !sessionId) {
			this.planHtmlPath = null;
			return;
		}
		const path = planStagingPath(sessionId);
		try {
			await prepareLibrary();
			await unlink(path).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		} catch (error) {
			console.warn("[session] could not prepare HTML plan directory:", error);
			this.planHtmlPath = null;
			return;
		}
		this.planHtmlPath = path;
	}

	private async persistUserMessage(
		sessionId: string | undefined,
		userMessage: string,
		attachments: ChatAttachment[],
		turnId?: string,
		vaultReferences: string[] = [],
	): Promise<void> {
		const userSeq = this.messageSeq++;
		if (!sessionId) return;
		const persistedMessage = formatVaultReferencedMessage(
			userMessage,
			vaultReferences,
			attachments
				.filter((attachment) => attachment.reference === "relic")
				.map((attachment) => attachment.filename),
		);
		if (turnId) {
			await db.appendMessage(
				sessionId,
				userSeq,
				"user",
				persistedMessage,
				turnId,
			);
		} else {
			await db.appendMessage(sessionId, userSeq, "user", persistedMessage);
		}
		for (const attachment of attachments) {
			if (attachment.reference === "relic") continue;
			await db
				.linkAttachmentToMessage(attachment.id, sessionId, userSeq)
				.catch((error) => {
					console.error("[session] linkAttachmentToMessage failed:", error);
				});
		}
	}

	private getOrCreateAgentSession(options: {
		provider: AgentProvider;
		sessionId: string | undefined;
		resumeProviderSessionId: string | null;
		activeCwd: string;
		extraDirs: Set<string>;
		executable: string | undefined;
		agentSettings: AgentSettings | undefined;
		planMode: boolean | undefined;
		emit: (msg: ServerMessage) => void;
		onGoalChange?: AgentQueryParams["onGoalChange"];
	}): AgentSession {
		const {
			provider,
			sessionId,
			resumeProviderSessionId,
			activeCwd,
			extraDirs,
			executable,
			agentSettings,
			planMode,
			emit,
			onGoalChange,
		} = options;
		const desiredKey = `${provider.providerId}|${sessionId ?? "ephemeral"}|${this.agentCwd ?? ""}`;
		if (
			this.agentSession &&
			(this.agentSessionKey !== desiredKey ||
				this.restartAgentSessionForEffort ||
				this.restartProviderRuntimeAfterTurn)
		) {
			this.agentSession.cancel();
			this.agentSession = null;
			this.agentSessionKey = null;
			this.restartAgentSessionForEffort = false;
			this.restartProviderRuntimeAfterTurn = false;
		}
		if (this.agentSession) {
			if (onGoalChange) {
				this.agentSession.setGoalChangeHandler?.(onGoalChange);
			}
			return this.agentSession;
		}
		this.restartProviderRuntimeAfterTurn = false;
		const configuredPermissionMode = this.activeRoutineContext
			? this.activeRoutineContext.mode === "full_access"
				? "bypassPermissions"
				: "default"
			: (this.permissionModeOverride ??
				agentSettings?.permissionMode ??
				this.permissionMode);
		const autoApproveTools =
			configuredPermissionMode === "bypassPermissions" &&
			!this.policyEnforced &&
			this.usageGateEnforced;
		const session = provider.query(
			buildAgentQueryParams({
				activeCwd,
				hostSessionId: sessionId,
				resumeProviderSessionId,
				historyResumeMode: this.historyResumeMode,
				extraDirs,
				signal: this.abortController?.signal,
				agentSettings,
				modelOverride: this.modelOverride,
				effortOverride: this.effortOverride,
				defaultModel: this.agentCwd ? undefined : this.model,
				configuredPermissionMode,
				planMode,
				planHtmlPath: this.planHtmlPath,
				defaultEffort: this.effort,
				defaultMaxTurns: this.maxTurns,
				executable,
				windowsComputerUse: this.windowsComputerUse,
				onGoalChange,
				policyEnforced: this.policyEnforced,
				usageGateEnforced: this.usageGateEnforced,
				sandboxModeOverride:
					this.activeRoutineContext &&
					this.activeRoutineContext.mode !== "full_access"
						? "read-only"
						: undefined,
				// Configured Claude/Codex hooks use the normalized embedded Umbod
				// path. Provider-native boundaries are a fallback when Umbod is off.
				beforeToolUse:
					this.usageGateEnforced && !this.policyEnforced
						? async () => this.gateOnUsage(provider, emit)
						: undefined,
				canUseTool: this.createToolPermissionHandler(
					provider,
					activeCwd,
					sessionId,
					emit,
					autoApproveTools,
				),
			}),
		);
		this.agentSession = session;
		this.agentSessionKey = desiredKey;
		this.restartAgentSessionForEffort = false;
		return session;
	}

	private prepareProviderForTurn(sessionId: string | undefined): {
		provider: AgentProvider;
		agentSettings: AgentSettings | undefined;
		resumeProviderSessionId: string | null;
	} {
		const configuredProvider = this.resolveProvider(this.agentCwd);
		// Provider identity is part of conversation continuity. A restored Claude
		// thread must stay on Claude even if the vault or agent is configured to use
		// Codex today; otherwise the saved provider session cannot be resumed and the
		// next turn silently starts a different conversation on another harness.
		const provider =
			(this.providerSessionProviderId
				? this.providers.get(this.providerSessionProviderId)
				: undefined) ?? configuredProvider;
		const configuredProviderId = this.agentCwd
			? (this.agentProviderMap.get(this.agentCwd) ?? this.vaultProviderId)
			: this.vaultProviderId;
		const agentSettings =
			this.agentCwd && provider.providerId === configuredProviderId
				? this.agentSettingsMap.get(this.agentCwd)
				: undefined;
		const sameProvider = this.providerSessionProviderId === provider.providerId;
		const resumeProviderSessionId = sameProvider
			? this.providerSessionId
			: null;
		if (!sameProvider) {
			this.providerSessionId = null;
			this.providerSessionProviderId = provider.providerId;
			this.historyResumeMode = "none";
		}
		if (sessionId) {
			void db
				.setSessionProviderId(sessionId, provider.providerId)
				.catch((error) => logDbError("setSessionProviderId", error));
		}
		return { provider, agentSettings, resumeProviderSessionId };
	}

	private scheduleTurnRecap(options: {
		turn: TurnState;
		sessionId: string | undefined;
		userMessage: string;
		emit: (msg: ServerMessage) => void;
		provider: AgentProvider;
		agentSettings: AgentSettings | undefined;
	}): void {
		const { turn, sessionId, userMessage, emit, provider, agentSettings } =
			options;
		if (!turn.hadToolEvents || !this.turnRecaps || !turn.lastAssistantText)
			return;
		const executable = isClaudeRuntimeProvider(provider.providerId)
			? this.claudeExecutable
			: this.codexExecutable;
		void generateTurnRecap({
			sessionId: sessionId ?? null,
			assistantSeq: turn.lastAssistantSeq,
			userMessage,
			toolEvents: turn.lastTurnToolEvents,
			assistantText: turn.lastAssistantText,
			emit,
			vaultPath: this.vaultPath,
			executable,
			sdkSummary: turn.sdkSummary,
			provider,
			recapModel: agentSettings?.recapModel ?? this.recapModel,
			agentCwd: this.agentCwd ?? null,
		}).catch(() => {});
	}

	private async refreshProviderUsage(
		agentSession: AgentSession,
		provider: AgentProvider,
		emit: (msg: ServerMessage) => void,
	): Promise<void> {
		if (!agentSession.usageWindows) return;
		try {
			const readings = await agentSession.usageWindows();
			await Promise.all(
				readings.map((reading) => applyReading(provider.providerId, reading)),
			);
			this.reconcileSleepState(provider, emit);
		} catch {
			// Usage enrichment is best-effort and must never fail an otherwise
			// successful agent turn.
		}
	}

	private async refreshProviderContext(
		agentSession: AgentSession,
		turn: TurnState,
		emit: (msg: ServerMessage) => void,
	): Promise<void> {
		if (!agentSession.contextUsage) return;
		try {
			const usage = await agentSession.contextUsage();
			if (!usage) return;
			turn.lastKnownContextWindow = usage.contextWindow;
			turn.lastContextTokens = usage.contextTokens;
			if (usage.model) turn.lastActualModel = usage.model;
			emit({
				type: "context_update",
				tokens_in_context: usage.contextTokens,
				context_window: usage.contextWindow,
				...(usage.model ? { actualModel: usage.model } : {}),
			});
		} catch {
			// Context enrichment is best-effort and must not fail a turn.
		}
	}

	private startLiveProviderUsageRefresh(
		agentSession: AgentSession,
		provider: AgentProvider,
		turn: TurnState,
		emit: (msg: ServerMessage) => void,
	): {
		finish: () => Promise<void>;
		stop: () => void;
	} {
		if (!agentSession.usageWindows && !agentSession.contextUsage) {
			return { finish: async () => {}, stop: () => {} };
		}

		let timer: ReturnType<typeof setInterval> | null = null;
		let inFlight: Promise<void> | null = null;
		const refresh = (): Promise<void> => {
			if (inFlight) return inFlight;
			inFlight = Promise.all([
				this.refreshProviderUsage(agentSession, provider, emit),
				this.refreshProviderContext(agentSession, turn, emit),
			])
				.then(() => {})
				.finally(() => {
					inFlight = null;
				});
			return inFlight;
		};
		const stop = () => {
			if (timer === null) return;
			clearInterval(timer);
			timer = null;
		};

		// Seed immediately once the provider stream is active, then reconcile at
		// a small bounded cadence for long-running reasoning/tool loops.
		void refresh();
		timer = setInterval(() => void refresh(), LIVE_USAGE_REFRESH_MS);

		return {
			stop,
			finish: async () => {
				stop();
				// Preserve the existing post-turn refresh even when a timer tick was
				// already in flight: wait for it, then fetch the completed-turn value.
				if (inFlight) await inFlight;
				await refresh();
			},
		};
	}

	private async runOneTurn(...args: RunQueryArgs): Promise<void> {
		const [
			userMessage,
			emit,
			sessionId,
			skillContexts,
			attachments,
			agentCwd,
			turnId,
			planMode,
			planHtml,
			commandAction,
			vaultReferences,
			routineContext,
			goalStart,
		] = args;
		this.currentTurnId = turnId;
		await this.initSessionContext(sessionId, agentCwd, userMessage);
		await this.syncPlanHtmlPath(Boolean(planMode && planHtml), sessionId);

		// Slice C: emit status=running AFTER initSessionContext so getCurrentSessionId()
		// is non-null when clients receive this event. This lets the ledger detect new
		// sessions immediately via the non-null db_session_id in sessions_status broadcasts.
		this.emitRunningStatus(emit);

		// Resolve provider after initSessionContext so this.agentCwd is final.
		const {
			provider: currentProvider,
			agentSettings,
			resumeProviderSessionId,
		} = this.prepareProviderForTurn(sessionId);

		// Turn-boundary usage gate: hold the turn before any provider spend.
		// State stays "running" while sleeping; agent_sleep carries the nuance.
		if ((await this.gateOnUsage(currentProvider, emit)) === "aborted") return;

		this.activeRoutineContext = routineContext ?? null;
		const turn = createTurnState();

		try {
			const runtimeCwd =
				this.agentMode === "cwd" && this.agentCwd
					? this.agentCwd
					: this.vaultPath;
			const runtimePlanHtmlPath = this.planHtmlPath
				? toProviderRuntimePath(runtimeCwd, this.planHtmlPath)
				: undefined;
			const {
				prompt,
				safeAttachments,
				resourcePaths,
				safeVaultReferences = [],
			} = await buildPromptAsync({
				vaultPath: this.vaultPath,
				vaultName: this.vaultName,
				allowedAgentRealPaths: this.allowedAgentRealPaths,
				agentMode: this.agentMode,
				agentCwd: this.agentCwd,
				claudeSessionId: resumeProviderSessionId,
				runtimeCwd,
				userMessage,
				skillContexts,
				attachments,
				vaultReferences,
				...(commandAction
					? {}
					: {
							readVaultReference: (relativePath: string) =>
								readObsidianNote(this.vaultName, relativePath),
						}),
				...(runtimePlanHtmlPath
					? {
							planHtmlInstructions:
								buildPlanHtmlInstructions(runtimePlanHtmlPath),
						}
					: {}),
			});
			let providerPrompt = prompt;
			if (this.providerHandoffPending && sessionId) {
				try {
					providerPrompt = buildProviderHandoff(
						await db.getSessionMessages(sessionId),
						prompt,
					);
				} catch (error) {
					logDbError("getSessionMessages provider handoff", error);
				}
			}
			// With `resume`, the CLI maintains conversation state on its end. We
			// send only the new user turn — no transcript replay.
			await this.persistUserMessage(
				sessionId,
				userMessage,
				safeAttachments,
				turnId,
				safeVaultReferences.map((reference) => reference.relativePath),
			);

			const { activeCwd, extraDirs, executable } = resolveExecutionContext({
				agentMode: this.agentMode,
				agentCwd: this.agentCwd,
				vaultPath: this.vaultPath,
				allowedAgentRealPaths: this.allowedAgentRealPaths,
				claudeExecutable: isClaudeRuntimeProvider(currentProvider.providerId)
					? this.claudeExecutable
					: this.codexExecutable,
				wrapperCommand: isCodexRuntimeProvider(currentProvider.providerId)
					? "codex"
					: "claude",
				safeAttachments,
				resourcePaths,
			});
			let commandArgs: string | undefined;
			if (commandAction) {
				commandArgs = userMessage
					.replace(new RegExp(`^/${commandAction}(?:\\s+|:\\s*)?`, "i"), "")
					.trim();
				if (commandAction === "computer-use" && !commandArgs) {
					throw new Error("/computer-use requires a Windows desktop task");
				}
				if (safeVaultReferences.length > 0) {
					const referenceLines = safeVaultReferences.map((reference) => {
						const path =
							commandAction === "computer-use"
								? reference.path
								: toProviderRuntimePath(runtimeCwd, reference.path);
						return `- ${path} (Vault: ${reference.relativePath})`;
					});
					commandArgs =
						`${commandArgs}\n\nVault references:\n${referenceLines.join("\n")}`.trim();
				}
				if (commandAction === "computer-use") {
					await this.authorizeWindowsComputerUseCommand({
						provider: currentProvider,
						activeCwd,
						sessionId,
						turnId,
						task: commandArgs,
						emit,
					});
				}
			}

			const agentSession = this.getOrCreateAgentSession({
				provider: currentProvider,
				sessionId,
				resumeProviderSessionId,
				activeCwd,
				extraDirs,
				executable,
				agentSettings,
				planMode,
				emit,
			});
			if (goalStart) {
				if (!isCodexRuntimeProvider(currentProvider.providerId)) {
					throw new Error("/goal is only available for Codex sessions.");
				}
				if (!agentSession.controlGoal) {
					throw new Error("The active Codex version does not support goals.");
				}
				const result = await agentSession.controlGoal({
					action: "set",
					objective: goalStart.objective,
					...(goalStart.tokenBudget !== undefined
						? { tokenBudget: goalStart.tokenBudget }
						: {}),
				});
				this.providerSessionId = result.providerSessionId;
				this.providerSessionProviderId = currentProvider.providerId;
				if (sessionId) {
					await db.setSessionProviderSession(
						sessionId,
						currentProvider.providerId,
						result.providerSessionId,
					);
				}
				emit({
					type: "goal_state",
					session_id: sessionId ?? result.providerSessionId,
					provider_id: currentProvider.providerId,
					goal: result.goal ? mapProviderGoal(result.goal) : null,
				});
			}
			const configuredPermissionMode = this.activeRoutineContext
				? this.activeRoutineContext.mode === "full_access"
					? "bypassPermissions"
					: "default"
				: (this.permissionModeOverride ??
					agentSettings?.permissionMode ??
					this.permissionMode);
			await agentSession.setPermissionMode?.(
				planMode ? "plan" : configuredPermissionMode,
			);
			agentSession.setPlanHtmlPath?.(runtimePlanHtmlPath);

			// Slice B: deliver this turn's user message via send() rather than
			// passing it as a one-shot prompt. The long-lived stream pushes it
			// onto the SDK's input AsyncIterable and the next assistant turn
			// runs inside the same SDK query.
			if (commandAction) {
				if (!agentSession.executeCommand) {
					throw new Error(
						`/${commandAction} is not supported by the active provider`,
					);
				}
				await agentSession.executeCommand(commandAction, commandArgs);
			} else {
				await agentSession.send(providerPrompt);
			}
			this.providerHandoffPending = false;

			await this.iterateConversation(
				agentSession,
				sessionId,
				emit,
				turn,
				currentProvider,
			);
			// Per-turn success: drainTurnQueue settles the final session state
			// after the queue empties. Successful turns leave state alone so the
			// drain loop sees "running" → resets to "idle" at end.

			this.scheduleTurnRecap({
				turn,
				sessionId,
				userMessage,
				emit,
				provider: currentProvider,
				agentSettings,
			});
		} catch (err) {
			this.state = "error";
			const msg = err instanceof Error ? err.message : "Unknown error";
			// Compiled Hlið redirects console.error into this same table. Keep the
			// development console useful without storing every production failure
			// twice (once as console and once as the structured session record).
			if (!process.execPath.endsWith(".exe")) {
				console.error("[session] runQuery error:", err);
			}
			void db.appendLog("error", "session", "runQuery error", {
				message: msg,
				name: err instanceof Error ? err.name : undefined,
				stack: err instanceof Error ? err.stack?.slice(0, 500) : undefined,
			});
			emit({ type: "error", message: msg });
			// Slice B: tear down the AgentSession on error — its iterator may
			// be in an inconsistent state. The next queued turn (or new
			// runQuery) rebuilds a fresh SDK stream.
			this.agentSession?.cancel();
			this.agentSession = null;
			this.agentSessionKey = null;
			this.restartAgentSessionForEffort = false;
		} finally {
			// Persist any remaining assistant text (the success path clears it).
			if (turn.assistantText && sessionId) {
				try {
					const assistantSeq = await this.persistAssistantMessage(
						sessionId,
						turn,
					);
					this.persistPendingToolEvents(
						sessionId,
						assistantSeq,
						turn,
						"finally",
						currentProvider.providerId,
					);
				} catch (error) {
					logDbError("appendMessage (assistant)", error);
				}
			}
			// drainTurnQueue handles the final status emit + abortController
			// reset after the queue fully drains. We intentionally do not emit
			// per-turn status here so queued turns never see a transient idle
			// flicker between turns.
			this.activeRoutineContext = null;
		}
	}
}
