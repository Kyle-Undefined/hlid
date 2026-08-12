import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type { ToolCall } from "@umbod/core";
import type { HlidConfig } from "../config";
import * as db from "../db";
import {
	type AcpModelVisibilityFilter,
	openCodeModelVisible,
} from "../lib/acpModelFilter";
import { resolveClaudeExecutable } from "../lib/claudePath";
import {
	estimateContextTokens,
	type HlidContextBlock,
	type HlidPromptContextManifest,
	type HlidToolLoadingSummary,
	type HlidTurnContextManifest,
	summarizeHlidStructuredPrompt,
} from "../lib/hlidContext";
import {
	declaredPathKey,
	expandTilde,
	isPathAccessibleFromRuntime,
	parseWslUncSyntax,
	toProviderRuntimePath,
} from "../lib/paths";
import { permissionToolDisplayName } from "../lib/permissionPresentation";
import { compareProviderBackgroundActivity } from "../lib/providerBackgroundActivity";
import {
	CLIPROXY_CODEX_PROVIDER_ID,
	isCliProxyProvider,
} from "../lib/providerIds";
import { estimateProviderCost } from "../lib/providerPricing";
import {
	isClaudeRuntimeProvider,
	isCodexRuntimeProvider,
} from "../lib/providerRuntime";
import {
	authorizeRoutineCapability,
	type RoutinePermissionContext,
} from "../lib/routinePermissions";
import { nextRoutineOccurrence } from "../lib/routineSchedule";
import { orderSteeredTranscript } from "../lib/steeredTranscript";
import { SESSION_LABEL_LENGTH } from "../lib/utils";
import {
	formatVaultReferencedMessage,
	type WorkspaceReferenceRequest,
} from "../lib/vaultReferences";
import {
	computeAllowedAgentRealPaths,
	isAllowedAgentPath,
	resolveAgentMode,
} from "./agentPaths";
import type {
	AgentEvent,
	AgentInputOrigin,
	AgentProvider,
	AgentQueryParams,
	AgentSession,
	AgentToolDecision,
	CanUseTool,
	McpServerStatus,
	ProviderAccountInfo,
	ProviderApprovalReviewContext,
	ProviderApprovalsReviewer,
	ProviderApprovalsReviewerChange,
	ProviderBackgroundActivity,
	ProviderBackgroundActivityControl,
	ProviderFileRewindResult,
	ProviderGoalControl,
	ProviderGoalControlResult,
	ProviderInitiatedTurn,
	ProviderMcpServerApplyResult,
	ProviderMcpServerDefinition,
	ProviderRealtimeActivity,
	ProviderRealtimeEvent,
	ProviderRealtimeMode,
	ProviderRealtimeStartResult,
	ProviderSavedWorkflow,
	ProviderThreadGoal,
	ProviderWorkflowCatalog,
	ProviderWorkflowDeleteInput,
	ProviderWorkflowSaveInput,
	ProviderWorkflowSourceInput,
	SendOptions,
	SlashCommand,
	SubagentSnapshot,
	TaskActivity,
} from "./agentProvider";
import { ProviderPermissionModeRejectedError } from "./agentProvider";
import { ingestGeneratedImage, ingestPlanHtml } from "./attachments";
import {
	type ClaudeWarmupSnapshot,
	prewarmClaudeCli,
	waitForClaudeWarmupSnapshot,
} from "./claudeWarmup";
import { loadConfig } from "./config";
import { bumpDataRevision } from "./dataRevision";
import { resolveExecutionContext } from "./executionContext";
import { finalizeHlidTurnContextManifest } from "./hlidContext";
import {
	buildHlidOperatingBriefResult,
	HLID_OPERATING_CONTRACT_VERSION,
	type HlidOperatingBriefResult,
} from "./hlidHelp";
import { planStagingPath, prepareLibrary } from "./libraryStore";
import { getActiveObsidianNote, readObsidianNote } from "./obsidianCli";
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
	AskUserQuestionProvenance,
	ChatAttachment,
	McpControlAction,
	McpControlOperation,
	QueueStateSnapshot,
	ServerMessage,
} from "./protocol";
import {
	ASK_USER_QUESTION_CANCEL_KEY,
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
	restoreSleepDecision,
	type SleepDecision,
	skipSleep as skipProviderSleep,
	sleepUntilAllowed,
} from "./usageGate";
import type { ResolvedWorkspaceReference } from "./workspaceReferences";

/** Fallback context window size when the SDK omits it from result metadata. */
const DEFAULT_CONTEXT_WINDOW = 200_000;

function providerTransportLimit(message: string): {
	windowId?: "five_hour" | "spend_control";
	resetsAt: number | null;
} | null {
	const sessionLimit = /\bsession limit\b/i.test(message);
	const spendLimit = /\bspend limit reached\b/i.test(message);
	if (
		!sessionLimit &&
		!spendLimit &&
		!/\b(?:usage|rate) limit\b/i.test(message)
	)
		return null;
	const utcReset = message.match(
		/\bresets?\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})\s+UTC\b/i,
	);
	const reset = message.match(
		/\bresets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i,
	);
	let resetsAt: number | null = null;
	if (utcReset) {
		const parsed = Date.parse(
			`${utcReset[1]}T${utcReset[2]}:${utcReset[3]}:00Z`,
		);
		if (Number.isFinite(parsed)) resetsAt = Math.floor(parsed / 1_000);
	} else if (reset) {
		let hour = Number(reset[1]) % 12;
		if (reset[3].toLowerCase() === "pm") hour += 12;
		const time = `${String(hour).padStart(2, "0")}:${reset[2] ?? "00"}`;
		try {
			resetsAt = nextRoutineOccurrence(
				{ kind: "daily", time },
				reset[4],
				Math.floor(Date.now() / 1_000),
			);
		} catch {
			// The explicit provider rejection remains useful even when its timezone
			// text is not a valid IANA identifier.
		}
	}
	return {
		...(spendLimit
			? { windowId: "spend_control" as const }
			: sessionLimit
				? { windowId: "five_hour" as const }
				: {}),
		resetsAt,
	};
}

/** Fire-and-forget DB error: console.error + append to log table. */
function logDbError(operation: string, err: unknown): void {
	console.error(`[db] ${operation} failed:`, err);
	void db.appendLog("error", "db", `${operation} failed`, {
		error: String(err),
	});
}

function providerPermissionOutcomeKey(
	providerSessionId: string,
	toolId: string,
): string {
	return JSON.stringify([providerSessionId, toolId]);
}

async function obsidianCommandApprovalInput(
	toolName: string,
	input: Record<string, unknown>,
	vaultName: string,
): Promise<Record<string, unknown>> {
	if (resolveObsidianCommandPermission(toolName, input, vaultName) === null) {
		return input;
	}
	try {
		const activeNote = await getActiveObsidianNote(
			vaultName,
			{},
			{ launchIfNeeded: false },
		);
		return activeNote ? { ...input, activeNote } : input;
	} catch {
		return input;
	}
}

function objectInput(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function stringInput(
	input: Record<string, unknown>,
	...keys: string[]
): string | undefined {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

function hookToolContext(call: ToolCall): {
	input: Record<string, unknown>;
	requester:
		| { providerId: string; agentId: string; agentType?: string }
		| undefined;
} {
	const hookInput = objectInput(call.inputs) ?? {};
	const input =
		objectInput(hookInput.tool_input) ??
		objectInput(hookInput.toolInput) ??
		objectInput(hookInput.input) ??
		hookInput;
	const agentId = stringInput(hookInput, "agent_id", "agentId");
	const agentType = stringInput(hookInput, "agent_type", "agentType");
	return {
		input,
		requester: agentId
			? {
					providerId: call.agent,
					agentId,
					...(agentType ? { agentType } : {}),
				}
			: undefined,
	};
}

/** Mutable accumulator for per-turn SDK event state, threaded through the event loop. */
type TurnState = {
	startedAtMs: number;
	/** Exact persisted provider/model selection that owns runtime observations. */
	selectedModel: string;
	/** In-memory provider ownership epoch captured before the provider turn. */
	providerOwnershipGeneration: number;
	/** Persisted user row that owns a provider-native file checkpoint. */
	userSeq: number | null;
	receivedAny: boolean;
	receivedUsage: boolean;
	queryRecorded: boolean;
	terminalFailure: Extract<AgentEvent, { type: "done" }>["terminalFailure"];
	assistantText: string;
	lastAssistantText: string;
	assistantMessageBoundaryPending: boolean;
	lastBlockType: "text" | "tool_use" | null;
	lastActualModel: string | null;
	actualModelObservations: Array<{ model: string; local: boolean }>;
	localFallbackModel: string | null;
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
	/** Monotonic count of tool events exposed for this assistant response. */
	rawToolEventCount: number;
	lastAssistantSeq: number;
	pendingToolEvents: {
		toolId: string;
		name: string;
		input: unknown;
		subagent?: SubagentSnapshot;
		taskActivity?: TaskActivity;
		providerFrame?: { providerSessionId: string; providerUuid: string };
		providerLineageFrames?: Array<{
			providerSessionId: string;
			providerUuid: string;
		}>;
	}[];
	pendingToolResults: Map<
		string,
		{
			content: string;
			isError: boolean;
			providerFrame?: { providerSessionId: string; providerUuid: string };
		}
	>;
	pendingToolUpdates: Map<string, SubagentSnapshot>;
	pendingToolUpdateFrames: Map<
		string,
		{ providerSessionId: string; providerUuid: string }
	>;
	pendingToolActivityUpdates: Map<string, TaskActivity>;
	pendingToolActivityUpdateFrames: Map<
		string,
		{ providerSessionId: string; providerUuid: string }
	>;
	/** In-flight inserts that tool results await before exposing lazy detail. */
	pendingToolEventWrites: Map<string, Promise<boolean>>;
	/** In-flight subagent/task-activity snapshots that terminal history must await. */
	pendingToolMetadataWrites: Set<Promise<void>>;
	/**
	 * Reserved seq for the assistant message of this turn. Allocated lazily on
	 * the first text_delta or tool_start so live writes (text streaming, tool
	 * event inserts) attach to a real row that mid-turn reloads can render.
	 */
	reservedAssistantSeq: number | null;
	/**
	 * Durable placeholder insert for reservedAssistantSeq. Steering awaits this
	 * before persisting its user row so an accepted boundary cannot outlive its
	 * target assistant row after a crash or an otherwise empty provider turn.
	 */
	assistantRowWrite: Promise<void> | null;
	/** Steering user rows awaiting the assistant sequence allocated later. */
	pendingSteerTargetSeqs: Set<number>;
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
	/** Tool starts removed by a provider retraction; later updates stay hidden. */
	retractedToolIds: Set<string>;
	/** Synthetic results paired with quarantined provider-outcome collisions. */
	quarantinedProviderPermissionResults: Set<string>;
	providerFrameOrder: number;
	acceptedProviderFrames: Set<string>;
	currentProviderFrame: {
		providerSessionId: string;
		providerUuid: string;
		accepted: boolean;
		assistantSeq?: number;
		duplicateReplay?: {
			textBlocksPending: number;
			toolStartIds: Set<string>;
			toolResultIds: Set<string>;
		};
	} | null;
	/**
	 * Throttled text-write state: a setTimeout handle that flushes the current
	 * `assistantText` to the DB row. Many chunks arrive per second; rewriting
	 * the full text column on each one would be O(N²) bytes written across the
	 * turn. Coalescing into ~150ms windows keeps liveness while bounding I/O.
	 */
	textWriteTimer: ReturnType<typeof setTimeout> | null;
	textWritePromise: Promise<void> | null;
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
const CLAUDE_PEER_BODY_MAX_CHARS = 80_000;
const CLAUDE_PEER_ADDRESS_MAX_CHARS = 1_024;
const CLAUDE_PEER_NAME_MAX_CHARS = 512;
const CLAUDE_PEER_SESSION_MAX_CHARS = 1_024;
const FILE_REWIND_PREVIEW_TTL_MS = 5 * 60_000;
const BACKGROUND_ACTIVITY_ACTIVE_POLL_MS = 2_000;
const BACKGROUND_ACTIVITY_IDLE_POLL_MS = 10_000;
const BACKGROUND_ACTIVITY_LIMIT = 50;
const PROVIDER_HISTORY_WARNING_DEDUPE_LIMIT = 512;
const PEER_ORIGIN_PREFLIGHT_EVENT_TYPES: ReadonlySet<AgentEvent["type"]> =
	new Set([
		"session_start",
		"provider_context_reset",
		"provider_permission_mode_changed",
		"provider_history_warning",
		"provider_peer_message",
		"commands_changed",
		"transport_error",
		"rate_limit",
		"mcp_status",
	]);

function normalizeFileRewindResult(
	result: ProviderFileRewindResult,
): ProviderFileRewindResult {
	return {
		canRewind: result.canRewind,
		...(result.error ? { error: result.error } : {}),
		filesChanged: [...(result.filesChanged ?? [])].sort(),
		insertions: result.insertions ?? 0,
		deletions: result.deletions ?? 0,
	};
}

function sameFileRewindPreview(
	left: ProviderFileRewindResult,
	right: ProviderFileRewindResult,
): boolean {
	return (
		JSON.stringify(normalizeFileRewindResult(left)) ===
		JSON.stringify(normalizeFileRewindResult(right))
	);
}

export interface RunQueryOptions {
	sessionId?: string;
	skillContexts?: string | string[];
	attachments?: ChatAttachment[];
	agentCwd?: string;
	turnId?: string;
	planMode?: boolean;
	planHtml?: boolean;
	commandAction?: "review" | "computer-use" | "compact";
	vaultReferences?: string[];
	routineContext?: RoutinePermissionContext;
	goalStart?: { objective: string; tokenBudget?: number | null };
	workspaceReferences?: WorkspaceReferenceRequest[];
	delegationContext?: string;
	backgroundSession?: boolean;
	/** Captured at the Hlid input boundary; never inferred from mutable state. */
	inputOrigin?: AgentInputOrigin;
}

type RunQueryArgs = {
	userMessage: string;
	emit: (msg: ServerMessage) => void;
	options: RunQueryOptions;
	readonly inputOrigin: AgentInputOrigin;
	/** Settings work already accepted when this turn entered the queue. */
	readonly effortReady?: Promise<void>;
	/** Permission work already accepted when this turn entered the queue. */
	readonly permissionModeReady?: Promise<void>;
	/** Provider-native mode work already accepted when this turn entered the queue. */
	readonly providerSessionModeReady?: Promise<void>;
	/** Codex profile selection in effect when this turn entered the queue. */
	readonly codexPermissionProfileGeneration?: number;
	/** Accepted while a Codex Routine owned the active purpose-built runtime. */
	readonly acceptedBehindCodexPurposeBuiltTurn?: boolean;
	durableReady?: Promise<boolean>;
};

type EffortChangeTarget = {
	sessionId: string | null;
	providerId: string;
	providerOwnershipGeneration: number;
	effortControlGeneration: number;
	agentSession: AgentSession | null;
	agentSessionKey: string | null;
};

type PermissionModeChangeTarget = {
	sessionId: string | null;
	providerId: string;
	providerOwnershipGeneration: number;
	permissionModeControlGeneration: number;
	agentSession: AgentSession | null;
	agentSessionKey: string | null;
	skipLiveSetter: boolean;
};

class EffortChangeSupersededError extends Error {
	constructor() {
		super("Effort change was superseded by a session or provider change.");
		this.name = "EffortChangeSupersededError";
	}
}

class PermissionModeChangeSupersededError extends Error {
	constructor() {
		super(
			"Permission-mode change was superseded by a session or provider change.",
		);
		this.name = "PermissionModeChangeSupersededError";
	}
}

class CodexPermissionProfileBackgroundBlockedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodexPermissionProfileBackgroundBlockedError";
	}
}

type ProviderContinuationJob = {
	trigger: ProviderInitiatedTurn;
	sessionId: string;
	emit: (msg: ServerMessage) => void;
	provider: AgentProvider;
	agentSettings: AgentSettings | undefined;
	ownershipGeneration: number;
	expectedSessionKey: string;
	peerOriginObserved: boolean;
	consumerAttached: boolean;
	abortController: AbortController;
	dialogAbortHandler?: () => void;
	ready: Promise<boolean>;
	readySettled: boolean;
	resolveReady: (ready: boolean) => void;
};

type DurableRunQueryPayload = {
	userMessage: string;
	/** Optional only for rows written before input provenance was persisted. */
	inputOrigin?: AgentInputOrigin;
	options: Pick<
		RunQueryOptions,
		| "skillContexts"
		| "attachments"
		| "agentCwd"
		| "planMode"
		| "planHtml"
		| "commandAction"
		| "vaultReferences"
		| "goalStart"
		| "workspaceReferences"
	>;
};

function durableTurnPayload(args: RunQueryArgs): DurableRunQueryPayload {
	const o = args.options;
	return {
		userMessage: args.userMessage,
		inputOrigin: args.inputOrigin,
		options: {
			...(o.skillContexts !== undefined
				? { skillContexts: o.skillContexts }
				: {}),
			...(o.attachments !== undefined ? { attachments: o.attachments } : {}),
			...(o.agentCwd !== undefined ? { agentCwd: o.agentCwd } : {}),
			...(o.planMode !== undefined ? { planMode: o.planMode } : {}),
			...(o.planHtml !== undefined ? { planHtml: o.planHtml } : {}),
			...(o.commandAction !== undefined
				? { commandAction: o.commandAction }
				: {}),
			...(o.vaultReferences !== undefined
				? { vaultReferences: o.vaultReferences }
				: {}),
			...(o.goalStart !== undefined ? { goalStart: o.goalStart } : {}),
			...(o.workspaceReferences !== undefined
				? { workspaceReferences: o.workspaceReferences }
				: {}),
		},
	};
}

const AGENT_INPUT_ORIGINS = new Set<AgentInputOrigin>([
	"human",
	"scheduled-task",
	"coordinator",
	"background-notification",
	"auto-continuation",
	"unclassified",
]);

function normalizeAgentInputOrigin(value: unknown): AgentInputOrigin {
	return typeof value === "string" &&
		AGENT_INPUT_ORIGINS.has(value as AgentInputOrigin)
		? (value as AgentInputOrigin)
		: "unclassified";
}

function isDurableInteractiveTurn(args: RunQueryArgs): boolean {
	const o = args.options;
	return Boolean(
		o.sessionId &&
			o.turnId &&
			!o.routineContext &&
			!o.backgroundSession &&
			!o.delegationContext,
	);
}

export type CurrentDelegationHandoff = {
	skillContexts: string[];
	relics: ChatAttachment[];
	vaultReferences: string[];
	workspaceReferences: WorkspaceReferenceRequest[];
	currentAssistantSequence: number | null;
};

type ActiveSteeringTarget = {
	turnId: string;
	sessionId: string | null;
	agentSession: AgentSession;
	steer: (prompt: string, options?: SendOptions) => Promise<void>;
	turnState: TurnState;
	/** Assistant sequence before provider acceptance can race with turn done. */
	assistantSeqAtCapture: number | null;
	handoff: CurrentDelegationHandoff | null;
};

export type SteeringReceipt = {
	/** Original user turn whose live assistant accepted the steer. */
	targetTurnId: string;
	/** Persisted assistant sequence, when the response already owns one. */
	targetAssistantSeq?: number;
	/** Persisted sequence of the steering user message. */
	steerSeq: number;
	/** Raw tool-event count at the provider acceptance boundary. */
	steerToolEventIndex: number;
};

export type SessionState = "idle" | "running" | "error";

export type ProviderSkillReloadResult =
	| { providerId: string; status: "reloaded"; skillCount: number }
	| { providerId: string; status: "not-live"; reason: string };

export type ProviderMcpConfigApplyResult =
	| {
			providerId: string;
			status: "applied";
			result: ProviderMcpServerApplyResult;
			statuses: McpServerStatus[];
	  }
	| { providerId: string; status: "not-live"; reason: string };

type PermissionMode =
	| "default"
	| "acceptEdits"
	| "bypassPermissions"
	| "plan"
	| "dontAsk"
	| "auto";

const KNOWN_PERMISSION_MODES: ReadonlySet<string> = new Set([
	"default",
	"acceptEdits",
	"bypassPermissions",
	"plan",
	"dontAsk",
	"auto",
]);

function buildProviderHandoff(
	messages: ReadonlyArray<{
		role: string;
		text: string;
		seq?: number;
		steer_target_seq?: number | null;
	}>,
	prompt: string,
): string {
	if (messages.length === 0) return prompt;
	const transcript = orderSteeredTranscript(messages, {
		role: (message) => message.role,
		sequence: (message) => message.seq,
		steerTargetSequence: (message) => message.steer_target_seq,
	})
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

function providerCommandContextManifest(
	context: HlidPromptContextManifest,
	commandChars: number,
	hlidAddedChars: number,
	blocks: HlidContextBlock[],
): HlidPromptContextManifest {
	const { instructionFile: _instructionFile, ...delivered } = context;
	return {
		...delivered,
		promptChars: commandChars,
		hlidAddedChars,
		estimatedHlidTokens: estimateContextTokens(hlidAddedChars),
		blocks,
		skills: [],
		attachments: [],
		planHtml: false,
		...(context.operatingBrief
			? {
					operatingBrief: {
						...context.operatingBrief,
						included: false,
						delivery: "not-delivered",
						chars: 0,
					},
				}
			: {}),
	};
}

function appendProviderCommandReferences<T>(
	commandArgs: string,
	heading: string,
	references: readonly T[],
	kind: HlidContextBlock["kind"],
	formatReference: (reference: T) => string,
): {
	commandArgs: string;
	addedChars: number;
	block: HlidContextBlock;
} {
	const next =
		`${commandArgs}\n\n${heading}:\n${references.map(formatReference).join("\n")}`.trim();
	const addedChars = Math.max(0, next.length - commandArgs.length);
	return {
		commandArgs: next,
		addedChars,
		block: {
			kind,
			chars: addedChars,
			count: references.length,
		},
	};
}

type AgentSettings = {
	model?: string;
	effort?: string;
	maxTurns?: number;
	permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
	recapModel?: string;
};

type RealtimeControl =
	| {
			action: "start";
			mode: ProviderRealtimeMode;
			sdp: string;
			voice?: string;
	  }
	| { action: "speak"; mode: "read-aloud"; text: string }
	| { action: "stop" };

type RealtimeStartControl = Extract<RealtimeControl, { action: "start" }>;

type RealtimeControlOptions = {
	sessionId: string;
	requestId?: string;
	agentCwd?: string;
	/** Skip Raven session persistence for Cockpit-only dictation. */
	transient?: boolean;
	emit: (msg: ServerMessage) => void;
};

type RealtimeProviderContext = {
	persistenceSessionId: string | undefined;
	provider: AgentProvider;
	agentSettings: AgentSettings | undefined;
	resumeProviderSessionId: string | null;
	ownershipGeneration: number;
	realtimeAgentCwd: string | undefined;
	realtimeAgentMode: "cwd" | "context";
};

type PreparedRealtimeStart = {
	provider: AgentProvider;
	agentSettings: AgentSettings | undefined;
	ownershipGeneration: number;
	agentSession: AgentSession;
	startRealtime: NonNullable<AgentSession["startRealtime"]>;
};

type RealtimeRequestIdentity = { request_id?: string };

type RealtimeUtterance = {
	utteranceId: string;
	transcriptSeq: number;
};

type RealtimeTranscriptRole = "user" | "assistant";

type LiveAssistantActivity = {
	utterance: RealtimeUtterance;
	turn: TurnState;
	finalQueued: boolean;
	completedToolIds: Set<string>;
};

type LiveRealtimeCoordination = {
	setProviderRealtimeSessionId: (sessionId: string | undefined) => void;
	publishTranscriptDelta: (
		event: Extract<ProviderRealtimeEvent, { type: "transcript_delta" }>,
	) => void;
	queueTranscriptFinal: (
		event: Extract<ProviderRealtimeEvent, { type: "transcript_done" }>,
	) => void;
	publishActivity: (event: ProviderRealtimeActivity) => void;
	settleActivities: () => Promise<void>;
	flushToolOnlyActivities: () => Promise<void>;
};

type RealtimeCloseNotifier = (
	reason?: string,
	emitOverride?: (message: ServerMessage) => void,
) => Promise<void>;

type RealtimeTerminalLifecycle = {
	publishClosed: RealtimeCloseNotifier;
	publishError: (message: string) => Promise<void>;
	isFinishing: () => boolean;
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
	if (!agent.provider?.startsWith("acp:") && agent.max_turns) {
		settings.maxTurns = agent.max_turns;
	}
	if (agent.permission_mode) settings.permissionMode = agent.permission_mode;
	if (agent.recap_model) settings.recapModel = agent.recap_model;
	return Object.keys(settings).length > 0 ? settings : null;
}

function buildAgentQueryParams(options: {
	activeCwd: string;
	providerId: string;
	vaultName: string;
	agentMode: "cwd" | "context";
	hostSessionId: string | undefined;
	resumeProviderSessionId: string | null;
	historyResumeMode: AgentQueryParams["historyResumeMode"];
	persistSession?: boolean;
	extraDirs: Set<string>;
	signal: AbortSignal | undefined;
	agentSettings: AgentSettings | undefined;
	modelOverride: { value: string | undefined } | null;
	effortOverride: string | null;
	serviceTierOverride: string | null;
	defaultModel: string | undefined;
	configuredPermissionMode: PermissionMode;
	approvalsReviewer: ProviderApprovalsReviewer | undefined;
	onApprovalsReviewerChange?: AgentQueryParams["onApprovalsReviewerChange"];
	planMode: boolean | undefined;
	planHtmlPath: string | null;
	defaultEffort: string | undefined;
	defaultMaxTurns: number | undefined;
	executable: string | undefined;
	windowsComputerUse: AgentQueryParams["windowsComputerUse"];
	onGoalChange?: AgentQueryParams["onGoalChange"];
	onSessionConfigChange?: AgentQueryParams["onSessionConfigChange"];
	onProviderInitiatedTurn?: AgentQueryParams["onProviderInitiatedTurn"];
	claudeCrossSessionInbound?: AgentQueryParams["claudeCrossSessionInbound"];
	claude?: AgentQueryParams["claude"];
	codex?: AgentQueryParams["codex"];
	canUseTool: CanUseTool;
	beforeToolUse: AgentQueryParams["beforeToolUse"];
	policyEnforced: boolean;
	usageGateEnforced: boolean;
	sandboxModeOverride?: AgentQueryParams["sandboxModeOverride"];
	codexRealtimeEnabled: boolean;
}): AgentQueryParams {
	const implementationPermissionMode:
		| "default"
		| "acceptEdits"
		| "bypassPermissions" =
		options.configuredPermissionMode === "acceptEdits" ||
		options.configuredPermissionMode === "bypassPermissions"
			? options.configuredPermissionMode
			: "default";
	return {
		cwd: options.activeCwd,
		providerId: options.providerId,
		vaultName: options.vaultName,
		agentMode: options.agentMode,
		hostSessionId: options.hostSessionId,
		sessionId: options.resumeProviderSessionId ?? undefined,
		historyResumeMode: options.historyResumeMode,
		persistSession: options.persistSession,
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
		approvalsReviewer: options.approvalsReviewer,
		onApprovalsReviewerChange: options.onApprovalsReviewerChange,
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
		serviceTier: options.serviceTierOverride ?? undefined,
		...(options.providerId.startsWith("acp:")
			? {}
			: {
					maxTurns: options.agentSettings?.maxTurns ?? options.defaultMaxTurns,
				}),
		executable: options.executable,
		windowsComputerUse: options.windowsComputerUse,
		onGoalChange: options.onGoalChange,
		onSessionConfigChange: options.onSessionConfigChange,
		onProviderInitiatedTurn: options.onProviderInitiatedTurn,
		claudeCrossSessionInbound: options.claudeCrossSessionInbound,
		...(options.claude ? { claude: options.claude } : {}),
		...(options.codex ? { codex: options.codex } : {}),
		codexRealtimeEnabled: options.codexRealtimeEnabled,
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
			stop_reason: event.terminalFailure?.code ?? event.stopReason ?? null,
			tokens_in_context: tokensInContext,
			model:
				(turn.lastActualModel ?? primaryModelId ?? turn.selectedModel) || null,
		},
	};
}

function configuredAgentIdentity(
	path: string,
): { mapKey: string; resolvedPath: string } | undefined {
	const expanded = expandTilde(path);
	if (parseWslUncSyntax(expanded)) {
		return { mapKey: declaredPathKey(expanded), resolvedPath: expanded };
	}
	try {
		const resolvedPath = realpathSync(expanded);
		return { mapKey: resolvedPath, resolvedPath };
	} catch {
		return undefined;
	}
}

function agentMapKey(path: string): string {
	return parseWslUncSyntax(path) ? declaredPathKey(path) : path;
}

function buildAgentMaps(config: HlidConfig): {
	providers: Map<string, string>;
	settings: Map<string, AgentSettings>;
} {
	const providers = new Map<string, string>();
	const settings = new Map<string, AgentSettings>();
	for (const agent of config.agents ?? []) {
		const identity = configuredAgentIdentity(agent.path);
		if (!identity) continue;
		providers.set(identity.mapKey, agent.provider ?? "claude");
		const agentSettings = configuredAgentSettings(agent);
		if (agentSettings) settings.set(identity.mapKey, agentSettings);
	}
	return { providers, settings };
}

function sessionDefaultsFromSelection(
	config: HlidConfig,
	configuredAgentPath: string | undefined,
	providerId: string,
	configuredAgent: AgentSettings | undefined,
): ConfiguredSessionDefaults {
	const codexConfig = config.codex ?? {
		model: "",
		effort: "medium" as const,
		permission_mode: "default" as const,
		turn_recaps: true,
	};
	const acpDefaults = providerId.startsWith("acp:")
		? (config.acp_agents ?? []).find(
				(agent) => agent.id === providerId.slice("acp:".length),
			)
		: undefined;
	const providerDefaults: {
		model?: string;
		effort?: string;
		permission_mode?: PermissionMode;
		max_turns?: number;
		turn_recaps?: boolean;
		recap_model?: string;
	} =
		providerId === "claude"
			? config.claude
			: providerId === "codex"
				? codexConfig
				: isCliProxyProvider(providerId)
					? config.cliproxy
					: (acpDefaults ?? {});
	return {
		...(configuredAgentPath ? { agentCwd: configuredAgentPath } : {}),
		providerId,
		model: configuredAgent?.model ?? providerDefaults.model ?? "",
		effort: configuredAgent?.effort ?? providerDefaults.effort ?? "",
		permissionMode:
			configuredAgent?.permissionMode ??
			providerDefaults.permission_mode ??
			"default",
		maxTurns: providerId.startsWith("acp:")
			? undefined
			: (configuredAgent?.maxTurns ?? providerDefaults.max_turns),
		turnRecaps: providerDefaults.turn_recaps ?? true,
		recapModel:
			configuredAgent?.recapModel ??
			providerDefaults.recap_model ??
			(isClaudeRuntimeProvider(providerId) && providerId === "claude"
				? "claude-haiku-4-5"
				: ""),
	};
}

function configuredSessionDefaultsFromMaps(
	config: HlidConfig,
	configuredAgentCwd: string | undefined,
	agentMaps: ReturnType<typeof buildAgentMaps>,
): ConfiguredSessionDefaults {
	const configuredAgentIdentityValue = configuredAgentCwd
		? configuredAgentIdentity(configuredAgentCwd)
		: undefined;
	const configuredAgentPath = configuredAgentIdentityValue?.resolvedPath;
	const configuredAgent = configuredAgentIdentityValue
		? agentMaps.settings.get(configuredAgentIdentityValue.mapKey)
		: undefined;
	const vaultProviderId = config.vault_provider ?? "claude";
	const providerId = configuredAgentIdentityValue
		? (agentMaps.providers.get(configuredAgentIdentityValue.mapKey) ??
			vaultProviderId)
		: vaultProviderId;
	return sessionDefaultsFromSelection(
		config,
		configuredAgentPath,
		providerId,
		configuredAgent,
	);
}

/**
 * Resolve display-only controls from declared configuration without touching
 * the filesystem. Use this for detached/history-only sessions; provider
 * execution continues to use canonical path validation.
 */
export function resolveDeclaredSessionDefaults(
	config: HlidConfig,
	configuredAgentCwd?: string,
	configuredProviderId?: string,
): ConfiguredSessionDefaults {
	const configuredAgentPathKey = configuredAgentCwd
		? declaredPathKey(configuredAgentCwd)
		: undefined;
	const configuredAgent = configuredAgentPathKey
		? (config.agents ?? []).find(
				(agent) => declaredPathKey(agent.path) === configuredAgentPathKey,
			)
		: undefined;
	const configuredAgentPath = configuredAgent
		? expandTilde(configuredAgent.path)
		: undefined;
	const vaultProviderId = config.vault_provider ?? "claude";
	const configuredAgentProviderId = configuredAgent
		? (configuredAgent.provider ?? "claude")
		: undefined;
	// A detached chat's saved provider is a session-scoped override. Agent controls
	// only remain defaults while that chat still uses the agent's own provider.
	const providerId =
		configuredProviderId ?? configuredAgentProviderId ?? vaultProviderId;
	const configuredAgentOverrides =
		configuredAgent && configuredAgentProviderId === providerId
			? configuredAgentSettings(configuredAgent)
			: undefined;
	return sessionDefaultsFromSelection(
		config,
		configuredAgentPath,
		providerId,
		configuredAgentOverrides ?? undefined,
	);
}

function createTurnState(
	selectedModel: string,
	providerOwnershipGeneration: number,
): TurnState {
	return {
		startedAtMs: Date.now(),
		selectedModel,
		providerOwnershipGeneration,
		userSeq: null,
		receivedAny: false,
		receivedUsage: false,
		queryRecorded: false,
		terminalFailure: undefined,
		assistantText: "",
		lastAssistantText: "",
		assistantMessageBoundaryPending: false,
		lastBlockType: null,
		lastActualModel: null,
		actualModelObservations: [],
		localFallbackModel: null,
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
		rawToolEventCount: 0,
		lastAssistantSeq: -1,
		pendingToolEvents: [],
		pendingToolResults: new Map(),
		pendingToolUpdates: new Map(),
		pendingToolUpdateFrames: new Map(),
		pendingToolActivityUpdates: new Map(),
		pendingToolActivityUpdateFrames: new Map(),
		pendingToolEventWrites: new Map(),
		pendingToolMetadataWrites: new Set(),
		reservedAssistantSeq: null,
		assistantRowWrite: null,
		pendingSteerTargetSeqs: new Set(),
		providerTurnId: null,
		dbMessageId: null,
		persistedToolIds: new Set(),
		retractedToolIds: new Set(),
		quarantinedProviderPermissionResults: new Set(),
		providerFrameOrder: 0,
		acceptedProviderFrames: new Set(),
		currentProviderFrame: null,
		textWriteTimer: null,
		textWritePromise: null,
		textWriteDirty: false,
		lastTurnToolEvents: [],
		sdkSummary: null,
	};
}

function joinAssistantMessageText(previous: string, next: string): string {
	if (!previous || !next) return next;
	const trailingNewlines = previous.match(/\n*$/)?.[0].length ?? 0;
	const leadingNewlines = next.match(/^\n*/)?.[0].length ?? 0;
	const missingNewlines = Math.max(0, 2 - trailingNewlines - leadingNewlines);
	return `${"\n".repeat(missingNewlines)}${next}`;
}

function providerFrameKey(
	providerSessionId: string,
	providerUuid: string,
): string {
	return `${providerSessionId}\0${providerUuid}`;
}

export function assertSupportedProviderEffort(
	provider: AgentProvider,
	effort: string,
): void {
	const supported =
		provider.providerId === "claude"
			? new Set(["low", "medium", "high", "xhigh", "max"])
			: provider.providerId === CLIPROXY_CODEX_PROVIDER_ID
				? new Set(
						provider.effortLevels?.map((candidate) => candidate.value) ?? [],
					)
				: null;
	// Other provider catalogs can be model-specific and are not complete
	// allowlists (Codex, for example, adds max/ultra on live model entries).
	if (!supported || supported.size === 0 || supported.has(effort)) return;
	throw new UnsupportedProviderEffortError(
		`${provider.label ?? provider.providerId} does not support effort ${effort}`,
	);
}

export class UnsupportedProviderEffortError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsupportedProviderEffortError";
	}
}

export class UnsupportedProviderPermissionModeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsupportedProviderPermissionModeError";
	}
}

export async function validateProviderPermissionMode(
	provider: AgentProvider,
	mode: string,
	context: {
		cwd: string;
		capabilityCwd?: string;
		executable?: string;
		additionalDirectories?: string[];
		model?: string;
		policyEnforced: boolean;
		usageGateEnforced: boolean;
		forceExact?: boolean;
	},
): Promise<void> {
	if (!KNOWN_PERMISSION_MODES.has(mode)) {
		throw new UnsupportedProviderPermissionModeError(
			`Unknown permission mode: ${mode}`,
		);
	}
	if (
		mode !== "plan" &&
		(provider.sessionPermissionModes ?? provider.permissionModes)?.length &&
		!(provider.sessionPermissionModes ?? provider.permissionModes)?.some(
			(candidate) => candidate.value === mode,
		)
	) {
		throw new UnsupportedProviderPermissionModeError(
			`${provider.label ?? provider.providerId} does not support permission mode ${mode}`,
		);
	}
	if (
		(mode === "auto" || mode === "dontAsk") &&
		provider.providerId !== "claude"
	) {
		throw new UnsupportedProviderPermissionModeError(
			`${provider.label ?? provider.providerId} does not support permission mode ${mode}`,
		);
	}
	await provider.validatePermissionMode?.(mode, context);
}

export class SessionManager {
	private providers: Map<string, AgentProvider>;
	private vaultProviderId!: string;
	/** Explicit Raven CLI choice. Session-scoped and never written to config. */
	private providerOverride: string | null = null;
	private agentProviderMap: Map<string, string> = new Map();
	private agentSettingsMap: Map<string, AgentSettings> = new Map();
	private openCodeModelFilter: AcpModelVisibilityFilter | null = null;
	private state: SessionState = "idle";
	private abortController: AbortController | null = null;
	private model!: string;
	/** Invalidates saved-model capability evidence after an explicit model/provider change. */
	private modelGeneration = 0;
	private effort!: string;
	/** Explicit Raven picker values, which outrank refreshed config and agent defaults. */
	private modelOverride: { value: string | undefined } | null = null;
	private effortOverride: string | null = null;
	private serviceTierOverride: string | null = null;
	private permissionModeOverride: PermissionMode | null = null;
	private approvalsReviewerOverride: ProviderApprovalsReviewer | null = null;
	/** Serializes effective permission changes across isolated provider turns. */
	private permissionModeGeneration = 0;
	/** Ordered settings barrier installed synchronously by every permission request. */
	private permissionModeChangeTail: Promise<void> = Promise.resolve();
	/** Latest permission/model/provider control whose rejection must fail queued chat. */
	private permissionModeAcceptanceBarrier: Promise<void> = Promise.resolve();
	private permissionModeAcceptanceControl: {
		operation: Promise<void>;
		capturedByTurn: boolean;
	} | null = null;
	/** Invalidates pending permission requests on provider/session replacement. */
	private permissionModeControlGeneration = 0;
	/** The next provider thread needs the persisted Hlid transcript as context. */
	private providerHandoffPending = false;
	/** Provider conversation that has accepted the compact Hlid operating brief. */
	private operatingBriefProviderKey: string | null = null;
	/** Providers without a live effort control restart on the next turn. */
	private restartAgentSessionForEffort = false;
	/** Ordered settings barrier installed synchronously by every effort request. */
	private effortChangeTail: Promise<void> = Promise.resolve();
	/** Invalidates an in-flight effort request when setProvider replaces its selection. */
	private effortControlGeneration = 0;
	/** Preserves provider-declared mode ordering when Raven sends rapid choices. */
	private providerSessionModeChangeTail: Promise<void> = Promise.resolve();
	/** Extension changes made mid-turn retire the native runtime before its next turn. */
	private restartProviderRuntimeAfterTurn = false;
	private maxTurns: number | undefined;
	/** Explicit opt-in; live Claude sessions hold peers for Raven instead of accepting. */
	private claudePeerInbox = false;
	/** Claude SDK initialization flag; changing it requires a fresh native Query. */
	private claudeAgentProgressSummaries = false;
	/** Retire only after the current turn and any SDK background subagents settle. */
	private restartClaudeRuntimeForAgentProgressSummaries = false;
	/** Explicit Codex profiles are construction-time state; retire without losing resume identity. */
	private codexPermissionProfile: string | undefined;
	private restartCodexRuntimeForPermissionProfile = false;
	/** Distinguishes turns accepted before a construction-time profile change. */
	private codexPermissionProfileGeneration = 0;
	private vaultPath!: string;
	private vaultName!: string;
	private permissionMode!: PermissionMode;
	/** Provider-observed live mode; configured selection remains separate. */
	private effectivePermissionMode: PermissionMode | null = null;
	/** User-selected reviewer persisted with the Hlid session. */
	private approvalsReviewer: ProviderApprovalsReviewer | null = null;
	/** Provider-authoritative reviewer currently in effect for truthful status. */
	private effectiveApprovalsReviewer: ProviderApprovalsReviewer | null = null;
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
	/** Bounded provider history warnings already surfaced for this chat runtime. */
	private providerHistoryWarningIds = new Set<string>();
	/**
	 * Invalidates async provider results across A→B→A ownership round trips.
	 * DB ownership mutations are also serialized so an accepted old write always
	 * lands before the switch that retires it.
	 */
	private providerOwnershipGeneration = 0;
	private providerOwnershipWriteTail: Promise<void> = Promise.resolve();
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
	/** Distinguishes provider switches from actual Raven session ownership changes. */
	private sessionControlGeneration = 0;
	private currentSessionLabel: string | null = null;
	private currentSessionPinned = false;
	private currentForkParentSessionId: string | null = null;
	private currentForkParentLabel: string | null = null;
	private currentForkKind: "exact" | "recap" | null = null;
	private currentDelegationParentSessionId: string | null = null;
	private currentDelegationParentLabel: string | null = null;
	private currentDelegationParentTurnId: string | null = null;
	private currentDelegationDepth: number | null = null;
	private currentGoal: ProviderThreadGoal | null = null;
	private messageSeq = 0;
	/** Last runtime MCP snapshot per provider for this Hlid conversation. */
	private mcpStatusByProvider = new Map<string, McpServerStatus[]>();
	/** Invalidates delayed Claude MCP refreshes when a newer turn starts. */
	private mcpRefreshGeneration = 0;
	/** Short-lived, session-bound dry-run receipts required before file mutation. */
	private fileRewindPreviews = new Map<
		string,
		{
			sessionId: string;
			turnId: string;
			checkpointUuid: string;
			providerSessionId: string;
			createdAt: number;
			result: ProviderFileRewindResult;
		}
	>();
	/** Serialize temporary provider probes so MCP and command discovery both run. */
	private probeQueue: Promise<void> = Promise.resolve();
	private agentCwd: string | undefined;
	/** Pool-scoped agent path whose configured defaults seed live status. */
	private configuredAgentCwd: string | undefined;
	private agentMode: "cwd" | "context" = "cwd";
	private allowedAgentRealPaths: string[] = [];
	/** Provider-owned recap defaults, resolved against the provider that ran the turn. */
	private providerRecapSettings = new Map<
		string,
		{ turnRecaps: boolean; recapModel: string }
	>();
	// Slice A: re-entrant runQuery. Concurrent calls (typed-while-running) are
	// queued FIFO and drained serially. State stays "running" until the queue
	// fully drains.
	private turnQueue = new SessionTurnQueue<RunQueryArgs>();
	/** Provider-originated turns run before queued human prompts after approval. */
	private providerContinuationQueue: ProviderContinuationJob[] = [];
	private isDraining = false;
	private durableTurns = new Map<string, db.PendingSessionTurnRow>();
	private cancelledDurableTurns = new Set<string>();
	private currentTurnArgs: RunQueryArgs | null = null;
	private currentProviderContinuation: ProviderContinuationJob | null = null;
	/** Last durable run-state emitter, retained for idle provider dialogs. */
	private sessionEmit: ((msg: ServerMessage) => void) | null = null;
	/** Insert barriers prevent an answer from racing its persisted question row. */
	private askUserQuestionPersistence = new Map<
		string,
		{
			sessionId?: string;
			pending: Promise<void>;
			request: Extract<ServerMessage, { type: "ask_user_question" }>;
			emit: (msg: ServerMessage) => void;
		}
	>();
	/** Only one browser may claim a pending provider/user question response. */
	private askUserQuestionResponsesInFlight = new Set<string>();
	private suspendingForRestart = false;
	// Slice B: long-lived AgentSession per chat. Cached by chat-scoped key so
	// consecutive turns reuse one provider.query() invocation. Tear down on
	// chat switch / abort.
	private agentSession: AgentSession | null = null;
	private agentSessionKey: string | null = null;
	/** Exact provider wrapper that owns the active realtime transport. */
	private realtimeAgentSession: AgentSession | null = null;
	private backgroundActivities: ProviderBackgroundActivity[] = [];
	private backgroundActivityChangeHandler: (() => void) | null = null;
	private backgroundActivityRevision = 0;
	private backgroundActivityWaiters = new Set<() => void>();
	private backgroundActivityWriteTail: Promise<void> = Promise.resolve();
	private backgroundActivityObserver: {
		session: AgentSession;
		providerId: string;
		timer?: ReturnType<typeof setTimeout>;
	} | null = null;
	private realtimeMode: ProviderRealtimeMode | null = null;
	/** Browser request identity that owns the active realtime generation. */
	private realtimeRequestId: string | null = null;
	private realtimeCloseNotifier:
		| ((
				reason?: string,
				emitOverride?: (message: ServerMessage) => void,
		  ) => Promise<void>)
		| null = null;
	private realtimeStopPromise: Promise<void> | null = null;
	private realtimeStopMode: ProviderRealtimeMode | null = null;
	private realtimeStoppingGeneration: number | null = null;
	/** Final Live transcript writes are ordered exactly as provider events arrive. */
	private realtimeTranscriptWriteTail: Promise<void> = Promise.resolve();
	/** Invalidates provider callbacks after stop, abort, or a replacement start. */
	private realtimeGeneration = 0;
	private codexRealtimeEnabled = false;
	// Slice C: turn id of the currently running turn — threaded into the
	// emitted `done` event so clients can correlate completions to specific
	// submissions (and pop their queue display FIFO by id).
	private currentTurnId: string | undefined;
	/** Effective permission boundary for the running turn, including plan mode and Routines. */
	private currentTurnPermissionMode: PermissionMode | null = null;
	/** Exact, validated current-turn inputs available only for explicit child handoff. */
	private currentDelegationHandoff: CurrentDelegationHandoff | null = null;
	/** Active turn accumulator, shared only so accepted steering can persist its target row. */
	private currentTurnState: TurnState | null = null;
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
			providerId =
				this.agentProviderMap.get(agentMapKey(agentCwd)) ??
				this.vaultProviderId;
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

	private defaultApprovalsReviewer(
		provider?: AgentProvider,
	): ProviderApprovalsReviewer | null {
		if (!provider && this.providers.size === 0) return null;
		const resolvedProvider = provider ?? this.resolveProvider(this.agentCwd);
		return (
			resolvedProvider.approvalReviewers?.find((reviewer) => reviewer.isDefault)
				?.value ??
			resolvedProvider.approvalReviewers?.[0]?.value ??
			null
		);
	}

	private supportedApprovalsReviewer(
		provider: AgentProvider,
		reviewer: string | null | undefined,
	): reviewer is ProviderApprovalsReviewer {
		return Boolean(
			reviewer &&
				provider.approvalReviewers?.some(
					(candidate) => candidate.value === reviewer,
				),
		);
	}

	private autoReviewUnavailableReason(): string | null {
		if (this.policyEnforced) {
			return "Auto-review is unavailable while Hlid policy enforcement is enabled.";
		}
		if (this.usageGateEnforced) {
			return "Auto-review is unavailable while Hlid's auto-sleep usage gate is enabled.";
		}
		return null;
	}

	private effectiveReviewerForSelection(
		reviewer: ProviderApprovalsReviewer | null,
	): ProviderApprovalsReviewer | null {
		return reviewer === "auto_review" && this.autoReviewUnavailableReason()
			? "user"
			: reviewer;
	}

	private permissionControlRuntimeIdentity(): string {
		const activeAgentCwd = this.agentCwd ?? this.configuredAgentCwd;
		const agentSettings = activeAgentCwd
			? this.agentSettingsMap.get(agentMapKey(activeAgentCwd))
			: undefined;
		return JSON.stringify({
			providerId:
				this.providerOverride ??
				(activeAgentCwd
					? this.agentProviderMap.get(agentMapKey(activeAgentCwd))
					: undefined) ??
				this.vaultProviderId,
			model:
				this.modelOverride !== null
					? this.modelOverride.value
					: (agentSettings?.model ?? this.model),
			permissionMode:
				this.permissionModeOverride ??
				agentSettings?.permissionMode ??
				this.permissionMode,
			cwd: activeAgentCwd ?? this.vaultPath,
			vaultPath: this.vaultPath,
			claudeExecutable: this.claudeExecutable,
			additionalDirectories: this.allowedAgentRealPaths,
			policyEnforced: this.policyEnforced,
			usageGateEnforced: this.usageGateEnforced,
		});
	}

	private resetEffectiveApprovalsReviewer(): void {
		this.effectiveApprovalsReviewer = this.effectiveReviewerForSelection(
			this.approvalsReviewer,
		);
	}

	private statusApprovalsReviewer(): ProviderApprovalsReviewer | null {
		return this.effectiveApprovalsReviewer ?? this.approvalsReviewer;
	}

	private approvalsReviewerStatusField(): {
		approvals_reviewer?: ProviderApprovalsReviewer;
	} {
		const reviewer = this.statusApprovalsReviewer();
		return reviewer ? { approvals_reviewer: reviewer } : {};
	}

	/**
	 * Reconcile provider-authoritative reviewer state without letting temporary
	 * Hlid forcing overwrite the user's stored preference. The callback is tied
	 * to the provider generation and Hlid session that created the native stream,
	 * so a late notification from a retired stream cannot mutate the new chat.
	 */
	private reconcileProviderApprovalsReviewer(
		change: ProviderApprovalsReviewerChange,
		context: {
			sessionId: string | undefined;
			providerId: string;
			ownershipGeneration: number;
			emit: (message: ServerMessage) => void;
		},
	): void {
		if (
			!this.ownsProviderGeneration(
				context.providerId,
				context.ownershipGeneration,
			) ||
			(this.currentSessionId ?? undefined) !== context.sessionId
		) {
			return;
		}

		const selectedChanged =
			change.persistPreference && this.approvalsReviewer !== change.reviewer;
		if (selectedChanged) {
			this.approvalsReviewer = change.reviewer;
			this.approvalsReviewerOverride = change.reviewer;
		}
		// The callback already carries the provider's effective value. Local policy
		// only predicts the value before provider authority arrives; remapping this
		// report would hide a provider that failed to honor Hlid's forced reviewer.
		const nextEffectiveReviewer = change.reviewer;
		const effectiveChanged =
			this.effectiveApprovalsReviewer !== nextEffectiveReviewer;
		if (effectiveChanged) {
			this.effectiveApprovalsReviewer = nextEffectiveReviewer;
			context.emit({ type: "status", ...this.getStatus() });
		}

		if (selectedChanged && context.sessionId) {
			const sessionId = context.sessionId;
			void this.enqueueProviderOwnershipWrite(() =>
				db.setSessionApprovalsReviewer(sessionId, change.reviewer),
			).catch((error) =>
				logDbError("reconcile provider approval reviewer", error),
			);
		}
	}

	/** Apply runtime settings from config. Shared by constructor, reinitialize, and syncConfig. */
	private applyConfig(
		config: HlidConfig,
		preserveSessionOverrides = false,
	): void {
		const previousPermissionControlIdentity =
			this.permissionControlRuntimeIdentity();
		this.vaultPath = config.vault.path || process.env.HOME || "/";
		this.vaultName = config.vault.name;
		this.rememberedObsidianCommands = new Set(
			config.vault.obsidian_command_allowlist ?? [],
		);
		this.vaultProviderId = config.vault_provider ?? "claude";
		this.openCodeModelFilter =
			config.acp_agents?.find((agent) => agent.id === "opencode")
				?.model_filter ?? null;
		const agentMaps = buildAgentMaps(config);
		this.agentProviderMap = agentMaps.providers;
		this.agentSettingsMap = agentMaps.settings;
		const configuredDefaults = configuredSessionDefaultsFromMaps(
			config,
			this.configuredAgentCwd,
			agentMaps,
		);
		this.providerRecapSettings = new Map(
			[...this.providers.values()].map((provider) => {
				const defaults = sessionDefaultsFromSelection(
					config,
					undefined,
					provider.providerId,
					undefined,
				);
				return [
					provider.providerId,
					{
						turnRecaps: defaults.turnRecaps,
						recapModel: defaults.recapModel,
					},
				];
			}),
		);
		if (
			configuredDefaults.agentCwd &&
			!parseWslUncSyntax(configuredDefaults.agentCwd) &&
			!this.agentCwd
		) {
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
		this.claudePeerInbox = config.claude.peer_inbox ?? false;
		this.claudeAgentProgressSummaries =
			config.claude.agent_progress_summaries ?? false;
		if (!preserveSessionOverrides || this.permissionModeOverride === null)
			this.permissionMode = configuredDefaults.permissionMode;
		this.claudeExecutable = resolveClaudeExecutable();
		this.codexExecutable = codexConfig.executable;
		this.codexPermissionProfile = codexConfig.permission_profile;
		this.windowsComputerUse = codexConfig.windows_computer_use ?? {
			model: "inherit",
			effort: "medium",
		};
		this.allowedAgentRealPaths = computeAllowedAgentRealPaths(config);
		this.policyEnforced = config.umbod?.enabled ?? false;
		this.usageGateEnforced = config.auto_sleep?.enabled ?? false;
		if (
			this.permissionControlRuntimeIdentity() !==
			previousPermissionControlIdentity
		) {
			this.effectivePermissionMode = null;
			this.permissionModeGeneration += 1;
			this.permissionModeControlGeneration += 1;
		}
		this.codexRealtimeEnabled = config.voice?.codex_live_mode ?? false;
		if (!preserveSessionOverrides || this.approvalsReviewerOverride === null) {
			this.approvalsReviewer = this.defaultApprovalsReviewer();
		}
		this.resetEffectiveApprovalsReviewer();
	}

	reinitialize(config: HlidConfig): void {
		this.sessionControlGeneration += 1;
		this.abort();
		this.replaceBackgroundActivities([], false);
		this.providerOverride = null;
		this.modelOverride = null;
		this.effortOverride = null;
		this.serviceTierOverride = null;
		this.permissionModeOverride = null;
		this.approvalsReviewerOverride = null;
		this.applyConfig(config);
		this.state = "idle";
		this.clearCurrentSessionIdentity();
		this.providerSessionId = null;
		this.providerSessionProviderId = null;
		this.providerOwnershipGeneration += 1;
		this.historyResumeMode = "none";
		this.providerHandoffPending = false;
		this.operatingBriefProviderKey = null;
		this.restartClaudeRuntimeForAgentProgressSummaries = false;
		this.restartCodexRuntimeForPermissionProfile = false;
		this.messageSeq = 0;
		this.sessionAllowedTools.clear();
		db.clearCurrentSessionId().catch((e) =>
			logDbError("clearCurrentSessionId", e),
		);
	}

	private clearSessionProvenance(): void {
		this.currentSessionPinned = false;
		this.currentForkParentSessionId = null;
		this.currentForkParentLabel = null;
		this.currentForkKind = null;
		this.currentDelegationParentSessionId = null;
		this.currentDelegationParentLabel = null;
		this.currentDelegationParentTurnId = null;
		this.currentDelegationDepth = null;
		this.currentTurnPermissionMode = null;
		this.currentDelegationHandoff = null;
		this.currentGoal = null;
	}

	private clearCurrentSessionIdentity(): void {
		this.currentSessionId = null;
		this.currentSessionLabel = null;
		this.providerHistoryWarningIds.clear();
		this.resetEffectiveApprovalsReviewer();
		this.clearSessionProvenance();
	}

	private reconcileCodexRuntimeIdentity(
		previousCodexRealtimeEnabled: boolean,
		previousCodexExecutable: string | undefined,
	): void {
		const codexRealtimeChanged =
			previousCodexRealtimeEnabled !== this.codexRealtimeEnabled;
		const codexExecutableChanged =
			previousCodexExecutable !== this.codexExecutable;
		const codexRuntimeIdentityChanged =
			codexRealtimeChanged || codexExecutableChanged;
		if (!codexRuntimeIdentityChanged) return;
		const activeProviderId = this.agentSessionKey?.split("|", 1)[0];
		const activeSession =
			activeProviderId === "codex" ? this.agentSession : null;
		const retireOrdinaryCodexSession = () => {
			if (!activeSession || this.agentSession !== activeSession) return;
			if (this.state === "running") {
				this.restartProviderRuntimeAfterTurn = true;
				return;
			}
			this.stopBackgroundActivityObserver();
			activeSession.cancel();
			this.agentSession = null;
			this.agentSessionKey = null;
			this.resetEffectiveApprovalsReviewer();
		};
		const mustStopRealtime =
			Boolean(this.realtimeAgentSession && this.realtimeMode) &&
			((previousCodexRealtimeEnabled && !this.codexRealtimeEnabled) ||
				codexExecutableChanged);
		if (mustStopRealtime) {
			const closeReason =
				previousCodexRealtimeEnabled && !this.codexRealtimeEnabled
					? "Codex realtime voice was disabled in Forge."
					: "The Codex executable changed in Forge.";
			void this.stopRealtimeSession(closeReason).then(
				retireOrdinaryCodexSession,
				retireOrdinaryCodexSession,
			);
		} else {
			retireOrdinaryCodexSession();
		}
	}

	private reconcileClaudePeerInbox(previousEnabled: boolean): void {
		if (previousEnabled === this.claudePeerInbox) return;
		this.cancelQueuedProviderContinuations();
		if (
			!this.claudePeerInbox &&
			this.currentProviderContinuation &&
			!this.currentProviderContinuation.readySettled
		) {
			this.cancelProviderContinuationBeforeOrigin(
				this.currentProviderContinuation,
			);
		}
		const activeProviderId = this.agentSessionKey?.split("|", 1)[0];
		if (activeProviderId !== "claude" || !this.agentSession) return;
		if (this.state === "running") {
			this.restartProviderRuntimeAfterTurn = true;
			return;
		}
		this.stopBackgroundActivityObserver();
		this.agentSession.cancel();
		this.agentSession = null;
		this.agentSessionKey = null;
	}

	private hasRunningProviderBackgroundActivities(): boolean {
		return this.backgroundActivities.some(
			(activity) => activity.status === "running",
		);
	}

	private retireConstructionTimeRuntime(retiredSession: AgentSession): void {
		this.agentSession = null;
		this.agentSessionKey = null;
		try {
			this.stopBackgroundActivityObserver();
		} catch {
			// Runtime ownership is already retired; observer cleanup is best effort.
		}
		try {
			retiredSession.cancel();
		} catch {
			// A throwing transport cannot restore construction-time settings.
		}
		this.resetEffectiveApprovalsReviewer();
	}

	private retireClaudeProgressSummaryRuntimeIfSafe(
		options: { betweenTurns?: boolean } = {},
	): boolean {
		if (!this.restartClaudeRuntimeForAgentProgressSummaries) return false;
		const activeProviderId = this.agentSessionKey?.split("|", 1)[0];
		if (activeProviderId !== "claude" || !this.agentSession) {
			this.restartClaudeRuntimeForAgentProgressSummaries = false;
			return false;
		}
		if (
			(this.state === "running" && !options.betweenTurns) ||
			this.hasRunningProviderBackgroundActivities()
		) {
			return false;
		}
		const retiredSession = this.agentSession;
		this.restartClaudeRuntimeForAgentProgressSummaries = false;
		this.retireConstructionTimeRuntime(retiredSession);
		return true;
	}

	private reconcileClaudeAgentProgressSummaries(
		previousEnabled: boolean,
	): void {
		if (previousEnabled === this.claudeAgentProgressSummaries) return;
		const activeProviderId = this.agentSessionKey?.split("|", 1)[0];
		if (activeProviderId !== "claude" || !this.agentSession) return;
		this.restartClaudeRuntimeForAgentProgressSummaries = true;
		this.retireClaudeProgressSummaryRuntimeIfSafe();
	}

	private retireCodexPermissionProfileRuntimeIfSafe(
		options: { betweenTurns?: boolean } = {},
	): boolean {
		if (!this.restartCodexRuntimeForPermissionProfile) return false;
		const activeProviderId = this.agentSessionKey?.split("|", 1)[0];
		if (activeProviderId !== "codex" || !this.agentSession) {
			this.restartCodexRuntimeForPermissionProfile = false;
			return false;
		}
		if (
			(this.state === "running" && !options.betweenTurns) ||
			this.hasRunningProviderBackgroundActivities()
		) {
			return false;
		}
		const retiredSession = this.agentSession;
		this.restartCodexRuntimeForPermissionProfile = false;
		this.retireConstructionTimeRuntime(retiredSession);
		return true;
	}

	private async refreshAndRetireCodexPermissionProfileRuntimeIfSafe(
		options: { betweenTurns?: boolean } = {},
	): Promise<boolean> {
		if (!this.restartCodexRuntimeForPermissionProfile) return false;
		const session = this.agentSession;
		if (!session?.listBackgroundActivities) {
			return this.retireCodexPermissionProfileRuntimeIfSafe(options);
		}
		try {
			await this.refreshOwnedProviderBackgroundActivities(session, "codex");
		} catch {
			// A profile transition must fail closed when native background ownership
			// cannot be refreshed. The observer will retry without losing the runtime.
			return false;
		}
		return this.retireCodexPermissionProfileRuntimeIfSafe(options);
	}

	private reconcileCodexPermissionProfile(
		previousPermissionProfile: string | undefined,
	): void {
		if (previousPermissionProfile === this.codexPermissionProfile) return;
		this.codexPermissionProfileGeneration += 1;
		if (this.agentSessionKey?.endsWith("|codex-permissions:purpose-built")) {
			return;
		}
		const activeProviderId = this.agentSessionKey?.split("|", 1)[0];
		if (activeProviderId !== "codex" || !this.agentSession) return;
		void this.agentSession
			.setPermissionProfile?.(this.codexPermissionProfile)
			.catch((error) =>
				logDbError("reconcile Codex permission profile", error),
			);
		this.restartCodexRuntimeForPermissionProfile = true;
		if (this.agentSession.listBackgroundActivities) {
			void this.refreshAndRetireCodexPermissionProfileRuntimeIfSafe();
		} else {
			this.retireCodexPermissionProfileRuntimeIfSafe();
		}
	}

	/**
	 * Refresh only the process-identity settings required to start Codex realtime.
	 * Unlike syncConfig, this deliberately avoids rebuilding filesystem-backed
	 * agent maps on the latency-sensitive WebSocket control path.
	 */
	private matchesRealtimeRequest(requestId: string | undefined): boolean {
		return this.realtimeRequestId === (requestId ?? null);
	}

	// fallow-ignore-next-line unused-class-member -- Called by WebSocket realtime controls in wsHandlers.
	syncRealtimeConfig(config: Pick<HlidConfig, "codex" | "voice">): void {
		const previousCodexRealtimeEnabled = this.codexRealtimeEnabled;
		const previousCodexExecutable = this.codexExecutable;
		this.codexRealtimeEnabled = config.voice?.codex_live_mode ?? false;
		this.codexExecutable = config.codex?.executable;
		this.reconcileCodexRuntimeIdentity(
			previousCodexRealtimeEnabled,
			previousCodexExecutable,
		);
	}

	// Lightweight config refresh — updates runtime settings without resetting
	// session history or conversation continuity. Safe to call when idle.
	// Returns true if an effective status field changed (so callers can broadcast it).
	syncConfig(config: HlidConfig): boolean {
		const previous = this.getStatus();
		const previousOpenCodeModelFilter = JSON.stringify(
			this.openCodeModelFilter,
		);
		const previousClaudePeerInbox = this.claudePeerInbox;
		const previousClaudeAgentProgressSummaries =
			this.claudeAgentProgressSummaries;
		const previousCodexRealtimeEnabled = this.codexRealtimeEnabled;
		const previousCodexExecutable = this.codexExecutable;
		const previousCodexPermissionProfile = this.codexPermissionProfile;
		const previousApprovalReviewContext: ProviderApprovalReviewContext = {
			policyEnforced: this.policyEnforced,
			usageGateEnforced: this.usageGateEnforced,
		};
		const nextProviderId = config.vault_provider ?? "claude";
		const providerChanged =
			this.providerOverride === null && nextProviderId !== this.vaultProviderId;
		if (providerChanged) {
			// A picker value from one provider may not be meaningful for another.
			this.modelOverride = null;
			this.effortOverride = null;
			this.serviceTierOverride = null;
			this.permissionModeOverride = null;
			this.approvalsReviewerOverride = null;
		}
		this.applyConfig(config, !providerChanged);
		const selectedProviderId = this.getProviderId();
		const openCodeFilterChanged =
			previousOpenCodeModelFilter !== JSON.stringify(this.openCodeModelFilter);
		const excludedModelSelected =
			this.modelOverride !== null &&
			!openCodeModelVisible(
				selectedProviderId,
				this.modelOverride.value,
				this.openCodeModelFilter,
			);
		if (excludedModelSelected) {
			this.modelOverride = { value: undefined };
			this.model = "";
			this.modelGeneration += 1;
			this.effortOverride = null;
			this.serviceTierOverride = null;
			this.restartAgentSessionForEffort = false;
		}
		if (selectedProviderId === "acp:opencode" && openCodeFilterChanged) {
			this.providerSessionId = null;
			this.historyResumeMode = "none";
			this.providerHandoffPending =
				this.currentSessionId !== null && this.messageSeq > 0;
		}
		if (
			this.currentSessionId &&
			selectedProviderId === "acp:opencode" &&
			(excludedModelSelected || openCodeFilterChanged)
		) {
			const sessionId = this.currentSessionId;
			const sessionControlGeneration = this.sessionControlGeneration;
			const modelGeneration = this.modelGeneration;
			const ownsReset = () =>
				this.currentSessionId === sessionId &&
				this.sessionControlGeneration === sessionControlGeneration &&
				this.modelGeneration === modelGeneration &&
				this.getProviderId() === "acp:opencode";
			void this.enqueueProviderOwnershipWrite(async () => {
				if (excludedModelSelected) {
					await db.setSessionModel(sessionId, "", { guard: ownsReset });
					await db.setSessionEffort(sessionId, null, { guard: ownsReset });
				}
				if (openCodeFilterChanged && ownsReset()) {
					await db.setSessionProviderSession(sessionId, "acp:opencode", null);
				}
			}).catch((error) =>
				logDbError("reset filtered OpenCode session selection", error),
			);
		}
		this.enforcePermissionPolicyTransition();
		if (
			(previousApprovalReviewContext.policyEnforced !== this.policyEnforced ||
				previousApprovalReviewContext.usageGateEnforced !==
					this.usageGateEnforced) &&
			this.agentSessionKey?.startsWith("claude|") &&
			this.agentSession
		) {
			const retiredSession = this.agentSession;
			this.agentSession = null;
			this.agentSessionKey = null;
			this.effectivePermissionMode = null;
			try {
				this.stopBackgroundActivityObserver();
			} catch {
				// Runtime ownership is already retired; observer cleanup is best effort.
			}
			try {
				retiredSession.cancel();
			} catch {
				// A throwing transport cannot restore the stale construction-time policy.
			}
		}
		this.reconcileCodexRuntimeIdentity(
			previousCodexRealtimeEnabled,
			previousCodexExecutable,
		);
		this.reconcileCodexPermissionProfile(previousCodexPermissionProfile);
		this.reconcileClaudePeerInbox(previousClaudePeerInbox);
		this.reconcileClaudeAgentProgressSummaries(
			previousClaudeAgentProgressSummaries,
		);
		void this.agentSession?.setWindowsComputerUse?.(this.windowsComputerUse);
		if (
			previousApprovalReviewContext.policyEnforced !== this.policyEnforced ||
			previousApprovalReviewContext.usageGateEnforced !== this.usageGateEnforced
		) {
			this.agentSession?.setApprovalReviewContext?.({
				policyEnforced: this.policyEnforced,
				usageGateEnforced: this.usageGateEnforced,
			});
		}
		if (
			previous.approvals_reviewer !== this.effectiveApprovalsReviewer &&
			this.approvalsReviewer
		) {
			void this.agentSession
				?.setApprovalsReviewer?.(this.approvalsReviewer)
				.catch((error) =>
					logDbError("reconcile effective approval reviewer", error),
				);
		}
		const current = this.getStatus();
		return (
			previous.model !== current.model ||
			previous.effort !== current.effort ||
			previous.permission_mode !== current.permission_mode ||
			previous.approvals_reviewer !== current.approvals_reviewer
		);
	}

	private enforcePermissionPolicyTransition(): void {
		const desired = this.desiredPermissionMode();
		const forbidden =
			(this.policyEnforced && (desired === "auto" || desired === "dontAsk")) ||
			(this.usageGateEnforced && desired === "auto");
		if (!forbidden) return;
		this.commitAuthoritativePermissionMode("default", this.agentSession);
		const sessionId = this.currentSessionId;
		if (!sessionId) return;
		const providerId = this.getProviderId();
		const providerOwnershipGeneration = this.providerOwnershipGeneration;
		const sessionControlGeneration = this.sessionControlGeneration;
		const permissionModeControlGeneration =
			this.permissionModeControlGeneration;
		const ownsNarrowing = () =>
			this.currentSessionId === sessionId &&
			this.getProviderId() === providerId &&
			this.providerOwnershipGeneration === providerOwnershipGeneration &&
			this.sessionControlGeneration === sessionControlGeneration &&
			this.permissionModeControlGeneration ===
				permissionModeControlGeneration &&
			this.desiredPermissionMode() === "default";
		const persistence = this.permissionModeChangeTail.then(() =>
			this.enqueueProviderOwnershipWrite(() =>
				db.setSessionPermissionMode(sessionId, "default", {
					guard: ownsNarrowing,
				}),
			),
		);
		void persistence.catch((error) => {
			logDbError("force safe permission mode after policy change", error);
			if (!ownsNarrowing()) return;
			this.schedulePermissionModePersistenceRepair({
				sessionId,
				providerId,
				providerOwnershipGeneration,
				sessionControlGeneration,
				permissionModeControlGeneration,
				mode: "default",
			});
		});
		this.permissionModeChangeTail = persistence.then(
			() => undefined,
			() => undefined,
		);
	}

	getStatus(): {
		state: SessionState;
		model: string;
		permission_mode: PermissionMode;
		approvals_reviewer?: ProviderApprovalsReviewer;
		effort: string;
		turn_id?: string;
	} {
		return {
			state: this.state,
			model: this.model,
			permission_mode: this.statusPermissionMode(),
			...this.approvalsReviewerStatusField(),
			effort: this.effort,
			...(this.state === "running" && this.currentTurnId !== undefined
				? { turn_id: this.currentTurnId }
				: {}),
		};
	}

	private statusPermissionMode(): PermissionMode {
		return this.effectivePermissionMode ?? this.permissionMode;
	}

	private configuredPermissionModeForTurn(
		agentSettings: AgentSettings | undefined,
	): PermissionMode {
		// Routine roots retain their fixed read-only/full-access envelope. A child
		// admitted through Hlid delegation has its own validated session selection;
		// applying the root mapping again would silently widen an explicit Auto child
		// to bypassPermissions.
		if (this.activeRoutineContext && !this.currentDelegationParentSessionId) {
			return this.activeRoutineContext.mode === "full_access"
				? "bypassPermissions"
				: "default";
		}
		return (
			this.permissionModeOverride ??
			agentSettings?.permissionMode ??
			this.permissionMode
		);
	}

	private commitAuthoritativePermissionMode(
		mode: PermissionMode,
		retireSession: AgentSession | null,
	): void {
		if (retireSession && this.agentSession === retireSession) {
			this.agentSession = null;
			this.agentSessionKey = null;
		}
		this.permissionModeControlGeneration += 1;
		this.permissionModeGeneration += 1;
		this.permissionModeOverride = mode;
		this.permissionMode = mode;
		this.effectivePermissionMode = mode;
		if (!retireSession) return;
		try {
			this.stopBackgroundActivityObserver();
		} catch {
			// Authoritative ownership was already retired; cleanup is best effort.
		}
		try {
			retireSession.cancel();
		} catch {
			// Transport cleanup cannot reopen a retired permission owner.
		}
	}

	private installPermissionAcceptanceBarrier(operation: Promise<void>): void {
		const control = { operation, capturedByTurn: false };
		this.permissionModeAcceptanceControl = control;
		this.permissionModeAcceptanceBarrier = operation;
		void operation.then(
			() => {
				if (this.permissionModeAcceptanceControl === control) {
					this.permissionModeAcceptanceControl = null;
					this.permissionModeAcceptanceBarrier = Promise.resolve();
				}
			},
			() => {
				// Keep an already-rejected control visible until the next ordered turn
				// captures it. Otherwise a fast validation failure can settle between two
				// adjacent WebSocket frames and let the chat run under the old mode.
				if (
					this.permissionModeAcceptanceControl === control &&
					control.capturedByTurn
				) {
					this.permissionModeAcceptanceControl = null;
					this.permissionModeAcceptanceBarrier = Promise.resolve();
				}
			},
		);
	}

	/**
	 * Clear only the exact rejected control Raven has already reconciled. A chat
	 * that captured the promise before this acknowledgement still observes its
	 * rejection, while later unrelated turns can proceed under authoritative state.
	 */
	// fallow-ignore-next-line unused-class-member -- Called by WebSocket control rejection correlation in wsHandlers.
	acknowledgeSessionControlRejection(
		operation: Promise<void> | undefined,
	): void {
		if (
			!operation ||
			this.permissionModeAcceptanceControl?.operation !== operation
		) {
			return;
		}
		this.permissionModeAcceptanceControl = null;
		this.permissionModeAcceptanceBarrier = Promise.resolve();
	}

	private capturePermissionAcceptanceBarrier(): Promise<void> {
		const control = this.permissionModeAcceptanceControl;
		if (!control) return this.permissionModeAcceptanceBarrier;
		control.capturedByTurn = true;
		void control.operation.catch(() => {
			if (this.permissionModeAcceptanceControl === control) {
				this.permissionModeAcceptanceControl = null;
				this.permissionModeAcceptanceBarrier = Promise.resolve();
			}
		});
		return control.operation;
	}

	getCurrentGoal(): ProviderThreadGoal | null {
		return this.currentGoal;
	}

	setBackgroundActivityChangeHandler(handler: (() => void) | null): void {
		this.backgroundActivityChangeHandler = handler;
	}

	getBackgroundActivities(): ProviderBackgroundActivity[] {
		return this.backgroundActivities;
	}

	private backgroundActivitySnapshotChanged(
		next: readonly ProviderBackgroundActivity[],
	): boolean {
		return JSON.stringify(this.backgroundActivities) !== JSON.stringify(next);
	}

	private replaceBackgroundActivities(
		next: ProviderBackgroundActivity[],
		persist = true,
	): void {
		if (!this.backgroundActivitySnapshotChanged(next)) return;
		this.backgroundActivities = next;
		this.backgroundActivityRevision += 1;
		for (const notify of this.backgroundActivityWaiters) notify();
		this.backgroundActivityWaiters.clear();
		this.backgroundActivityChangeHandler?.();
		this.retireClaudeProgressSummaryRuntimeIfSafe();
		this.retireCodexPermissionProfileRuntimeIfSafe();
		const sessionId = this.currentSessionId;
		if (!persist || !sessionId) return;
		const snapshot = next.map((activity) => ({
			...activity,
			capabilities: { ...activity.capabilities },
		}));
		const persistSnapshot = () =>
			db.replaceSessionBackgroundActivities(sessionId, snapshot);
		this.backgroundActivityWriteTail = this.backgroundActivityWriteTail
			.then(persistSnapshot, persistSnapshot)
			.catch((error) =>
				logDbError("replaceSessionBackgroundActivities", error),
			);
	}

	private mergedBackgroundActivities(
		observed: readonly ProviderBackgroundActivity[],
	): ProviderBackgroundActivity[] {
		// This is a live monitor, not a second provider-history surface. Settled
		// work remains in its durable transcript tool call and leaves this snapshot.
		return observed
			.filter((activity) => activity.status === "running")
			.sort(compareProviderBackgroundActivity)
			.slice(0, BACKGROUND_ACTIVITY_LIMIT);
	}

	private async refreshProviderBackgroundActivities(
		session: AgentSession,
		providerId: string,
	): Promise<void> {
		const observer = this.backgroundActivityObserver;
		if (
			this.agentSession !== session ||
			observer?.session !== session ||
			observer.providerId !== providerId ||
			!session.listBackgroundActivities
		) {
			return;
		}
		await this.refreshOwnedProviderBackgroundActivities(session, providerId);
	}

	private async refreshOwnedProviderBackgroundActivities(
		session: AgentSession,
		providerId: string,
	): Promise<void> {
		if (this.agentSession !== session || !session.listBackgroundActivities) {
			return;
		}
		const observed = await session.listBackgroundActivities();
		if (this.agentSession !== session) return;
		const observer = this.backgroundActivityObserver;
		if (observer?.session === session && observer.providerId !== providerId)
			return;
		this.replaceBackgroundActivities(this.mergedBackgroundActivities(observed));
	}

	private waitForBackgroundActivityRevision(
		revision: number,
		signal: AbortSignal | undefined,
	): Promise<void> {
		if (revision !== this.backgroundActivityRevision) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const cleanup = () => {
				this.backgroundActivityWaiters.delete(onChange);
				signal?.removeEventListener("abort", onAbort);
			};
			const onChange = () => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve();
			};
			const onAbort = () => {
				if (settled) return;
				settled = true;
				cleanup();
				const error = new Error(
					"Aborted while waiting for Codex background activity",
				);
				error.name = "AbortError";
				reject(error);
			};
			this.backgroundActivityWaiters.add(onChange);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (revision !== this.backgroundActivityRevision) onChange();
			else if (signal?.aborted) onAbort();
		});
	}

	private scheduleBackgroundActivityPoll(
		observer: NonNullable<SessionManager["backgroundActivityObserver"]>,
	): void {
		if (
			this.backgroundActivityObserver !== observer ||
			this.agentSession !== observer.session
		) {
			return;
		}
		const active = this.backgroundActivities.some(
			(activity) => activity.status === "running",
		);
		const delay =
			active || this.state === "running"
				? BACKGROUND_ACTIVITY_ACTIVE_POLL_MS
				: BACKGROUND_ACTIVITY_IDLE_POLL_MS;
		observer.timer = setTimeout(() => {
			void this.pollBackgroundActivities(observer);
		}, delay);
		observer.timer.unref?.();
	}

	private async pollBackgroundActivities(
		observer: NonNullable<SessionManager["backgroundActivityObserver"]>,
	): Promise<void> {
		if (
			this.backgroundActivityObserver !== observer ||
			this.agentSession !== observer.session
		) {
			return;
		}
		try {
			await this.refreshProviderBackgroundActivities(
				observer.session,
				observer.providerId,
			);
		} catch {
			// Background activity is optional and experimental. A failed observation
			// must not disconnect or fail the owning conversation.
		}
		this.scheduleBackgroundActivityPoll(observer);
	}

	private startBackgroundActivityObserver(
		session: AgentSession,
		providerId: string,
	): void {
		if (!session.listBackgroundActivities) return;
		if (this.backgroundActivityObserver?.session === session) return;
		this.stopBackgroundActivityObserver(false);
		const observer = {
			session,
			providerId,
		};
		this.backgroundActivityObserver = observer;
		void this.pollBackgroundActivities(observer);
	}

	private stopBackgroundActivityObserver(markRunningUnknown = true): void {
		const observer = this.backgroundActivityObserver;
		if (observer?.timer) clearTimeout(observer.timer);
		this.backgroundActivityObserver = null;
		if (markRunningUnknown) this.replaceBackgroundActivities([]);
	}

	// fallow-ignore-next-line unused-class-member -- Called by the WebSocket background_activity_control dispatch in wsHandlers.
	async controlProviderBackgroundActivity(
		request: ProviderBackgroundActivityControl,
	): Promise<void> {
		const session = this.agentSession;
		const providerId =
			this.backgroundActivityObserver?.session === session
				? this.backgroundActivityObserver.providerId
				: this.getProviderId();
		if (!session?.controlBackgroundActivity) {
			throw new Error(
				`${this.resolveProvider(this.agentCwd).label ?? "This provider"} cannot control background activity from Raven`,
			);
		}
		if (request.action === "stop" || request.action === "terminate") {
			const capability = request.action;
			const activity = this.backgroundActivities.find(
				(candidate) =>
					candidate.providerId === providerId &&
					candidate.activityId === request.activityId &&
					candidate.status === "running" &&
					candidate.capabilities[capability],
			);
			if (!activity) {
				throw new Error("That background activity is no longer controllable");
			}
		} else if (
			request.action === "clean" &&
			!this.backgroundActivities.some(
				(activity) =>
					activity.providerId === providerId &&
					activity.status === "running" &&
					activity.capabilities.clean,
			)
		) {
			throw new Error(
				"There are no controllable background activities to clean",
			);
		}
		await session.controlBackgroundActivity(request);
		await this.refreshProviderBackgroundActivities(session, providerId);
	}

	private selectedModelFor(agentSettings?: AgentSettings): string {
		const selected =
			this.modelOverride !== null
				? (this.modelOverride.value ?? "")
				: (agentSettings?.model ?? this.model);
		return openCodeModelVisible(
			this.getProviderId(),
			selected,
			this.openCodeModelFilter,
		)
			? selected
			: "";
	}

	private modelOverrideForProvider(
		providerId: string,
	): { value: string | undefined } | null {
		if (
			this.modelOverride === null ||
			openCodeModelVisible(
				providerId,
				this.modelOverride.value,
				this.openCodeModelFilter,
			)
		) {
			return this.modelOverride;
		}
		return { value: undefined };
	}

	private desiredPermissionMode(): PermissionMode {
		const currentAgentSettings = this.agentCwd
			? this.agentSettingsMap.get(agentMapKey(this.agentCwd))
			: undefined;
		return (
			this.permissionModeOverride ??
			currentAgentSettings?.permissionMode ??
			this.permissionMode
		);
	}

	private enqueueProviderOwnershipWrite<T>(
		write: () => Promise<T>,
	): Promise<T> {
		const operation = this.providerOwnershipWriteTail.then(write, write);
		this.providerOwnershipWriteTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	private ownsProviderGeneration(
		providerId: string,
		generation: number,
	): boolean {
		return (
			this.providerOwnershipGeneration === generation &&
			this.providerSessionProviderId === providerId
		);
	}

	private persistProviderSession(
		sessionId: string,
		providerId: string,
		providerSessionId: string,
		generation: number,
		providerRuntimeIdentity: string | null = null,
	): Promise<boolean> {
		return this.enqueueProviderOwnershipWrite(async () => {
			if (!this.ownsProviderGeneration(providerId, generation)) return false;
			const accepted = await db.setSessionProviderSession(
				sessionId,
				providerId,
				providerSessionId,
				providerRuntimeIdentity,
			);
			return accepted && this.ownsProviderGeneration(providerId, generation);
		});
	}

	getActiveRoutine(): { routineId: string; runId: string } | null {
		return this.activeRoutineContext
			? {
					routineId: this.activeRoutineContext.routineId,
					runId: this.activeRoutineContext.runId,
				}
			: null;
	}

	private providerForOwnedSessionControl(
		sessionId: string | null,
		sessionGeneration: number,
	): AgentProvider {
		if (
			this.currentSessionId !== sessionId ||
			this.sessionControlGeneration !== sessionGeneration
		) {
			throw new PermissionModeChangeSupersededError();
		}
		return (
			this.providers.get(this.getProviderId()) ??
			this.resolveProvider(this.agentCwd)
		);
	}

	private enqueuePermissionSelectionChange(
		operation: () => Promise<void>,
	): Promise<void> {
		const pending = this.permissionModeChangeTail.then(operation);
		this.installPermissionAcceptanceBarrier(pending);
		this.permissionModeChangeTail = pending.then(
			() => undefined,
			() => undefined,
		);
		return pending;
	}

	private enqueueOwnedPermissionSelectionChange(
		sessionId: string | null,
		sessionGeneration: number,
		skipLiveSetter: boolean,
		operation: (target: PermissionModeChangeTarget) => Promise<void>,
	): Promise<void> {
		return this.enqueuePermissionSelectionChange(() => {
			const provider = this.providerForOwnedSessionControl(
				sessionId,
				sessionGeneration,
			);
			return operation({
				sessionId,
				providerId: provider.providerId,
				providerOwnershipGeneration: this.providerOwnershipGeneration,
				permissionModeControlGeneration: this.permissionModeControlGeneration,
				agentSession: this.agentSession,
				agentSessionKey: this.agentSessionKey,
				skipLiveSetter,
			});
		});
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
	setModel(model?: string): Promise<void> {
		try {
			this.assertRealtimeIdle("changing the model");
			if (
				!openCodeModelVisible(
					this.getProviderId(),
					model,
					this.openCodeModelFilter,
				)
			) {
				throw new Error(
					`Model ${JSON.stringify(model)} is excluded by Hlid's OpenCode model visibility`,
				);
			}
		} catch (error) {
			return Promise.reject(error);
		}
		const sessionId = this.currentSessionId;
		const sessionGeneration = this.sessionControlGeneration;
		return this.enqueueOwnedPermissionSelectionChange(
			sessionId,
			sessionGeneration,
			false,
			(target) => this.applyModelChange(target, model),
		);
	}

	private async applyModelChange(
		target: PermissionModeChangeTarget,
		model: string | undefined,
	): Promise<void> {
		if (!this.ownsPermissionModeChangeTarget(target)) {
			this.retirePermissionModeTarget(target);
			throw new PermissionModeChangeSupersededError();
		}
		let downgradeAuto = false;
		if (this.desiredPermissionMode() === "auto") {
			try {
				await this.validatePermissionMode(
					"auto",
					target.providerId,
					model ?? "",
					true,
				);
			} catch {
				downgradeAuto = true;
			}
		}
		if (!this.ownsPermissionModeChangeTarget(target)) {
			this.retirePermissionModeTarget(target);
			throw new PermissionModeChangeSupersededError();
		}
		const previousModel = this.selectedModelFor(
			this.agentCwd
				? this.agentSettingsMap.get(agentMapKey(this.agentCwd))
				: undefined,
		);
		let liveApplied = false;
		let livePermissionDowngraded = false;
		const commitModelSelection = () => {
			this.modelOverride = { value: model };
			this.model = model ?? "";
			this.modelGeneration += 1;
			if (downgradeAuto) {
				this.permissionModeControlGeneration += 1;
				this.permissionModeGeneration += 1;
				this.permissionModeOverride = "default";
				this.permissionMode = "default";
				this.effectivePermissionMode = "default";
			}
		};
		try {
			if (downgradeAuto && target.agentSession?.setPermissionMode) {
				await target.agentSession.setPermissionMode("default");
				livePermissionDowngraded = true;
				if (!this.ownsPermissionModeChangeTarget(target)) {
					throw new PermissionModeChangeSupersededError();
				}
			}
			if (target.agentSession?.setModel) {
				await target.agentSession.setModel(model);
				liveApplied = true;
				if (!this.ownsPermissionModeChangeTarget(target)) {
					throw new PermissionModeChangeSupersededError();
				}
			}
			if (target.sessionId) {
				const committed = await this.enqueueProviderOwnershipWrite(() =>
					downgradeAuto
						? db.setSessionModelAndPermissionMode(
								target.sessionId as string,
								model ?? "",
								"default",
								{
									guard: () => this.ownsPermissionModeChangeTarget(target),
									onCommitted: commitModelSelection,
								},
							)
						: db.setSessionModel(target.sessionId as string, model ?? "", {
								guard: () => this.ownsPermissionModeChangeTarget(target),
								onCommitted: commitModelSelection,
							}),
				);
				if (!committed) throw new PermissionModeChangeSupersededError();
			} else {
				if (!this.ownsPermissionModeChangeTarget(target)) {
					throw new PermissionModeChangeSupersededError();
				}
				commitModelSelection();
			}
		} catch (error) {
			let rollbackFailed = false;
			if (liveApplied && target.agentSession?.setModel) {
				if (this.ownsPermissionModeChangeTarget(target)) {
					try {
						await target.agentSession.setModel(previousModel || undefined);
					} catch {
						rollbackFailed = true;
					}
				} else {
					rollbackFailed = true;
				}
			}
			if (livePermissionDowngraded && target.agentSession?.setPermissionMode) {
				if (this.ownsPermissionModeChangeTarget(target)) {
					try {
						await target.agentSession.setPermissionMode("auto");
					} catch {
						rollbackFailed = true;
					}
				} else {
					rollbackFailed = true;
				}
			}
			if (rollbackFailed) this.retirePermissionModeTarget(target);
			throw error;
		}
	}

	/**
	 * Explicit Raven CLI switch. The config remains untouched; the selected
	 * provider and compatible controls apply only to this Hlid chat. Switching
	 * providers starts a fresh provider-native thread and hands it the persisted
	 * Hlid transcript on the next turn so conversation context is retained.
	 */
	setProvider(
		providerId: string,
		selection: {
			model?: string;
			effort?: string;
			serviceTier?: string;
			permissionMode?: string;
			approvalsReviewer?: string;
			persistSessionSelection?: boolean;
		} = {},
	): Promise<void> {
		try {
			this.assertRealtimeIdle("switching CLI");
		} catch (error) {
			return Promise.reject(error);
		}
		const sessionId = this.currentSessionId;
		const sessionGeneration = this.sessionControlGeneration;
		const operation = this.permissionModeChangeTail.then(() => {
			const permissionControlGeneration = this.permissionModeControlGeneration;
			return this.applyProviderSelection(providerId, selection, {
				sessionId,
				sessionGeneration,
				permissionControlGeneration,
			});
		});
		this.installPermissionAcceptanceBarrier(operation);
		this.permissionModeChangeTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	/** Apply the controls repeated by the first chat as one provider transaction. */
	// fallow-ignore-next-line unused-class-member -- Called by first-chat WebSocket dispatch in wsHandlers.
	setInitialChatSelection(selection: {
		model?: string;
		effort?: string;
		permissionMode?: string;
		approvalsReviewer?: string;
	}): Promise<void> {
		const agentSettings = this.agentCwd
			? this.agentSettingsMap.get(agentMapKey(this.agentCwd))
			: undefined;
		const selectedModel = this.selectedModelFor(agentSettings);
		const selectedEffort =
			this.effortOverride ?? agentSettings?.effort ?? this.effort;
		return this.setProvider(this.getProviderId(), {
			model: selection.model ?? (selectedModel || undefined),
			effort: selection.effort ?? (selectedEffort || undefined),
			serviceTier: this.serviceTierOverride ?? undefined,
			permissionMode: selection.permissionMode ?? this.desiredPermissionMode(),
			approvalsReviewer:
				selection.approvalsReviewer ??
				this.approvalsReviewerOverride ??
				this.approvalsReviewer ??
				undefined,
		});
	}

	private async applyProviderSelection(
		providerId: string,
		selection: {
			model?: string;
			effort?: string;
			serviceTier?: string;
			permissionMode?: string;
			approvalsReviewer?: string;
			/** Internal orchestration can persist selection in its own DB CAS. */
			persistSessionSelection?: boolean;
		},
		guard: {
			sessionId: string | null;
			sessionGeneration: number;
			permissionControlGeneration: number;
		},
	): Promise<void> {
		const ownsInvocation = () =>
			this.currentSessionId === guard.sessionId &&
			this.sessionControlGeneration === guard.sessionGeneration &&
			this.permissionModeControlGeneration ===
				guard.permissionControlGeneration;
		this.assertRealtimeIdle("switching CLI");
		if (!ownsInvocation()) throw new PermissionModeChangeSupersededError();
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
		const nextProvider = this.providers.get(providerId);
		if (!nextProvider) {
			throw new Error(`Unknown or unavailable provider: ${providerId}`);
		}
		if (
			!openCodeModelVisible(
				providerId,
				selection.model,
				this.openCodeModelFilter,
			)
		) {
			throw new Error(
				`Model ${JSON.stringify(selection.model)} is excluded by Hlid's OpenCode model visibility`,
			);
		}
		const currentProviderId =
			this.providerSessionProviderId ??
			this.resolveProvider(this.agentCwd).providerId;
		const providerChanged = currentProviderId !== providerId;
		if (selection.effort !== undefined) {
			assertSupportedProviderEffort(nextProvider, selection.effort);
		}
		if (selection.permissionMode !== undefined) {
			await validateProviderPermissionMode(
				nextProvider,
				selection.permissionMode,
				this.permissionModeValidationContext(
					selection.model ??
						(providerChanged
							? ""
							: this.selectedModelFor(
									this.agentCwd
										? this.agentSettingsMap.get(agentMapKey(this.agentCwd))
										: undefined,
								)),
					selection.permissionMode === "auto",
				),
			);
		}
		if (!ownsInvocation()) throw new PermissionModeChangeSupersededError();
		if (
			selection.approvalsReviewer !== undefined &&
			!this.supportedApprovalsReviewer(
				nextProvider,
				selection.approvalsReviewer,
			)
		) {
			throw new Error(
				`${nextProvider.label ?? providerId} does not support approval reviewer ${selection.approvalsReviewer}`,
			);
		}
		const unavailableReason = this.autoReviewUnavailableReason();
		if (selection.approvalsReviewer === "auto_review" && unavailableReason) {
			throw new Error(unavailableReason);
		}
		if (!ownsInvocation()) throw new PermissionModeChangeSupersededError();
		const previousPermissionMode = this.desiredPermissionMode();
		const previousModel = this.selectedModelFor(
			this.agentCwd
				? this.agentSettingsMap.get(agentMapKey(this.agentCwd))
				: undefined,
		);
		const previousEffort =
			this.effortOverride ??
			(this.agentCwd
				? this.agentSettingsMap.get(agentMapKey(this.agentCwd))?.effort
				: undefined) ??
			this.effort;
		const previousApprovalsReviewer = this.approvalsReviewer;
		const liveSession = providerChanged ? null : this.agentSession;
		const nextApprovalsReviewer = selection.approvalsReviewer
			? (selection.approvalsReviewer as ProviderApprovalsReviewer)
			: this.defaultApprovalsReviewer(nextProvider);
		let liveModelApplied = false;
		let liveEffortApplied = false;
		let livePermissionApplied = false;
		let liveReviewerApplied = false;
		const commitSelection = () => {
			const retiredSession = providerChanged ? this.agentSession : null;
			this.effortControlGeneration += 1;
			this.permissionModeControlGeneration += 1;
			if (providerChanged) {
				this.providerOwnershipGeneration += 1;
				this.agentSession = null;
				this.agentSessionKey = null;
				this.restartAgentSessionForEffort = false;
				this.currentGoal = null;
				this.providerSessionId = null;
				this.providerSessionProviderId = providerId;
				this.providerHandoffPending =
					this.currentSessionId !== null && this.messageSeq > 0;
				this.operatingBriefProviderKey = null;
			}

			this.providerOverride = providerId;
			this.modelOverride = { value: selection.model };
			this.model = selection.model ?? "";
			this.modelGeneration += 1;
			this.effortOverride = selection.effort ?? null;
			this.effort = selection.effort ?? "";
			if (
				!providerChanged &&
				selection.effort !== undefined &&
				liveSession &&
				!liveSession.setEffort
			) {
				this.restartAgentSessionForEffort = true;
			}
			this.serviceTierOverride = selection.serviceTier ?? null;
			this.permissionModeOverride = selection.permissionMode
				? (selection.permissionMode as PermissionMode)
				: null;
			this.permissionMode =
				(selection.permissionMode as PermissionMode | undefined) ?? "default";
			this.effectivePermissionMode = livePermissionApplied
				? this.permissionMode
				: null;
			this.permissionModeGeneration += 1;
			this.approvalsReviewerOverride = nextApprovalsReviewer;
			this.approvalsReviewer = nextApprovalsReviewer;
			this.resetEffectiveApprovalsReviewer();
			if (providerChanged) {
				try {
					this.stopBackgroundActivityObserver();
				} catch {
					// Runtime retirement is best effort after the owner tuple commits.
				}
				try {
					retiredSession?.cancel();
				} catch {
					// The committed owner tuple must not be rolled back by transport cleanup.
				}
			}
		};
		try {
			if (
				selection.model !== undefined &&
				liveSession?.setModel &&
				!this.currentProviderContinuation
			) {
				await liveSession.setModel(selection.model);
				liveModelApplied = true;
			}
			if (
				selection.effort !== undefined &&
				liveSession?.setEffort &&
				!this.currentProviderContinuation
			) {
				await liveSession.setEffort(selection.effort);
				liveEffortApplied = true;
			}
			if (
				selection.permissionMode !== undefined &&
				liveSession?.setPermissionMode &&
				!this.currentProviderContinuation
			) {
				await liveSession.setPermissionMode(selection.permissionMode);
				livePermissionApplied = true;
			}
			if (
				selection.approvalsReviewer !== undefined &&
				liveSession?.setApprovalsReviewer &&
				!this.currentProviderContinuation
			) {
				await liveSession.setApprovalsReviewer(nextApprovalsReviewer ?? "user");
				liveReviewerApplied = true;
			}
			if (!ownsInvocation()) throw new PermissionModeChangeSupersededError();
			if (guard.sessionId && selection.persistSessionSelection !== false) {
				const committed = await this.enqueueProviderOwnershipWrite(() =>
					db.setSessionProviderSelection(
						guard.sessionId as string,
						providerId,
						{
							model: selection.model,
							effort: selection.effort,
							permissionMode: selection.permissionMode,
							approvalsReviewer: nextApprovalsReviewer ?? undefined,
						},
						{ guard: ownsInvocation, onCommitted: commitSelection },
					),
				);
				if (!committed) throw new PermissionModeChangeSupersededError();
			} else {
				if (!ownsInvocation()) throw new PermissionModeChangeSupersededError();
				commitSelection();
			}
		} catch (error) {
			let rollbackFailed = false;
			if (liveReviewerApplied && liveSession?.setApprovalsReviewer) {
				try {
					await liveSession.setApprovalsReviewer(
						previousApprovalsReviewer ?? "user",
					);
				} catch {
					rollbackFailed = true;
				}
			}
			if (livePermissionApplied && liveSession?.setPermissionMode) {
				try {
					await liveSession.setPermissionMode(previousPermissionMode);
				} catch {
					rollbackFailed = true;
				}
			}
			if (liveEffortApplied && liveSession?.setEffort) {
				try {
					await liveSession.setEffort(previousEffort);
				} catch {
					rollbackFailed = true;
				}
			}
			if (liveModelApplied && liveSession?.setModel) {
				try {
					await liveSession.setModel(previousModel || undefined);
				} catch {
					rollbackFailed = true;
				}
			}
			if (rollbackFailed && liveSession && this.agentSession === liveSession) {
				this.agentSession = null;
				this.agentSessionKey = null;
				this.effectivePermissionMode = null;
				this.resetEffectiveApprovalsReviewer();
				try {
					this.stopBackgroundActivityObserver();
				} catch {
					// Ownership is already retired; observer cleanup is best effort.
				}
				try {
					liveSession.cancel();
				} catch {
					// A throwing transport cannot restore the rejected provider owner.
				}
			}
			throw error;
		}
	}

	/** Select who evaluates Codex-native approval requests for future turns. */
	// fallow-ignore-next-line unused-class-member -- Called by the WebSocket set_approvals_reviewer dispatch in wsHandlers.
	async setApprovalsReviewer(reviewer: string): Promise<void> {
		this.assertRealtimeIdle("changing the approval reviewer");
		const sessionId = this.currentSessionId;
		const sessionGeneration = this.sessionControlGeneration;
		const effortReady = this.effortChangeTail;
		const permissionReady = this.permissionModeChangeTail;
		const operation = Promise.all([effortReady, permissionReady]).then(
			async () => {
				const provider = this.providerForOwnedSessionControl(
					sessionId,
					sessionGeneration,
				);
				if (!this.supportedApprovalsReviewer(provider, reviewer)) {
					throw new Error(
						`${provider.label ?? provider.providerId} does not support approval reviewer ${reviewer}`,
					);
				}
				const unavailableReason = this.autoReviewUnavailableReason();
				if (reviewer === "auto_review" && unavailableReason) {
					throw new Error(unavailableReason);
				}
				const liveSession = this.agentSession;
				const previousReviewer = this.approvalsReviewer;
				let liveApplied = false;
				try {
					if (liveSession?.setApprovalsReviewer) {
						await liveSession.setApprovalsReviewer(reviewer);
						liveApplied = true;
					}
					if (sessionId) {
						await this.enqueueProviderOwnershipWrite(() =>
							db.setSessionApprovalsReviewer(sessionId, reviewer),
						);
					}
					if (
						this.currentSessionId !== sessionId ||
						this.sessionControlGeneration !== sessionGeneration ||
						this.agentSession !== liveSession
					) {
						throw new PermissionModeChangeSupersededError();
					}
					this.approvalsReviewerOverride = reviewer;
					this.approvalsReviewer = reviewer;
					this.resetEffectiveApprovalsReviewer();
				} catch (error) {
					if (
						liveApplied &&
						previousReviewer &&
						liveSession?.setApprovalsReviewer
					) {
						try {
							await liveSession.setApprovalsReviewer(previousReviewer);
						} catch {
							if (this.agentSession === liveSession) {
								liveSession.cancel();
								this.agentSession = null;
								this.agentSessionKey = null;
							}
						}
					}
					throw error;
				}
			},
		);
		const settled = operation.then(
			() => undefined,
			() => undefined,
		);
		this.permissionModeChangeTail = settled;
		this.effortChangeTail = settled;
		return operation;
	}

	async validatePermissionMode(
		mode: string,
		providerId = this.getProviderId(),
		model = this.selectedModelFor(
			this.agentCwd
				? this.agentSettingsMap.get(agentMapKey(this.agentCwd))
				: undefined,
		),
		forceExact = false,
	): Promise<void> {
		const provider =
			this.providers.get(providerId) ?? this.resolveProvider(this.agentCwd);
		await validateProviderPermissionMode(
			provider,
			mode,
			this.permissionModeValidationContext(model, forceExact),
		);
	}

	private permissionModeValidationContext(
		model: string,
		forceExact = false,
	): {
		cwd: string;
		capabilityCwd: string;
		executable?: string;
		additionalDirectories: string[];
		model?: string;
		policyEnforced: boolean;
		usageGateEnforced: boolean;
		forceExact?: boolean;
	} {
		const capabilityCwd = this.agentCwd ?? this.vaultPath;
		const execution = resolveExecutionContext({
			agentMode: this.agentMode,
			agentCwd: this.agentCwd,
			vaultPath: this.vaultPath,
			allowedAgentRealPaths: this.allowedAgentRealPaths,
			claudeExecutable: this.claudeExecutable,
			wrapperCommand: "claude",
			safeAttachments: [],
		});
		return {
			cwd: execution.activeCwd,
			capabilityCwd,
			executable: execution.executable,
			additionalDirectories: [...execution.extraDirs],
			...(model ? { model } : {}),
			policyEnforced: this.policyEnforced,
			usageGateEnforced: this.usageGateEnforced,
			...(forceExact ? { forceExact: true } : {}),
		};
	}

	/**
	 * Apply a session-scoped permission change transactionally. The native
	 * control accepts first, durable state commits second, and Raven-visible
	 * memory changes last. A synchronously installed tail also prevents an
	 * immediately following chat frame from starting with the old mode.
	 */
	setPermissionMode(mode: string): Promise<void> {
		try {
			this.assertRealtimeIdle("changing permissions");
			if (!KNOWN_PERMISSION_MODES.has(mode)) {
				throw new Error(`Unknown permission mode: ${mode}`);
			}
		} catch (error) {
			return Promise.reject(error);
		}
		const sessionId = this.currentSessionId;
		const sessionGeneration = this.sessionControlGeneration;
		return this.enqueueOwnedPermissionSelectionChange(
			sessionId,
			sessionGeneration,
			this.currentProviderContinuation !== null,
			(target) =>
				this.applyPermissionModeChange(target, mode as PermissionMode),
		);
	}

	private ownsPermissionModeChangeTarget(
		target: PermissionModeChangeTarget,
	): boolean {
		return (
			this.currentSessionId === target.sessionId &&
			this.getProviderId() === target.providerId &&
			this.providerOwnershipGeneration === target.providerOwnershipGeneration &&
			this.permissionModeControlGeneration ===
				target.permissionModeControlGeneration &&
			this.agentSession === target.agentSession &&
			this.agentSessionKey === target.agentSessionKey
		);
	}

	private retirePermissionModeTarget(target: PermissionModeChangeTarget): void {
		if (
			!target.agentSession ||
			this.agentSession !== target.agentSession ||
			this.agentSessionKey !== target.agentSessionKey
		) {
			return;
		}
		this.agentSession = null;
		this.agentSessionKey = null;
		this.effectivePermissionMode = null;
		this.resetEffectiveApprovalsReviewer();
		try {
			this.stopBackgroundActivityObserver();
		} catch {
			// Ownership is already retired; observer cleanup is best effort.
		}
		try {
			target.agentSession.cancel();
		} catch {
			// A throwing transport cannot restore the superseded owner.
		}
	}

	private async persistPermissionModeChange(
		target: PermissionModeChangeTarget,
		mode: PermissionMode,
	): Promise<void> {
		if (!target.sessionId) {
			if (!this.ownsPermissionModeChangeTarget(target)) {
				throw new PermissionModeChangeSupersededError();
			}
			return;
		}
		await this.enqueueProviderOwnershipWrite(async () => {
			if (!this.ownsPermissionModeChangeTarget(target)) {
				throw new PermissionModeChangeSupersededError();
			}
			const prior =
				(await db.getSessionSelection(target.sessionId as string))
					?.permissionMode ?? null;
			if (!this.ownsPermissionModeChangeTarget(target)) {
				throw new PermissionModeChangeSupersededError();
			}
			const committed = await db.setSessionPermissionMode(
				target.sessionId as string,
				mode,
				{ guard: () => this.ownsPermissionModeChangeTarget(target) },
			);
			if (!committed) throw new PermissionModeChangeSupersededError();
			if (!this.ownsPermissionModeChangeTarget(target)) {
				await db.setSessionPermissionMode(target.sessionId as string, prior);
				throw new PermissionModeChangeSupersededError();
			}
		});
	}

	private schedulePermissionModePersistenceRepair(options: {
		sessionId: string;
		providerId: string;
		providerOwnershipGeneration: number;
		sessionControlGeneration: number;
		permissionModeControlGeneration: number;
		mode: PermissionMode;
	}): void {
		const repair = this.enqueueProviderOwnershipWrite(async () => {
			if (
				this.currentSessionId !== options.sessionId ||
				this.getProviderId() !== options.providerId ||
				this.providerOwnershipGeneration !==
					options.providerOwnershipGeneration ||
				this.sessionControlGeneration !== options.sessionControlGeneration ||
				this.permissionModeControlGeneration !==
					options.permissionModeControlGeneration ||
				this.desiredPermissionMode() !== options.mode
			) {
				return;
			}
			await db.setSessionPermissionMode(options.sessionId, options.mode, {
				guard: () =>
					this.currentSessionId === options.sessionId &&
					this.getProviderId() === options.providerId &&
					this.providerOwnershipGeneration ===
						options.providerOwnershipGeneration &&
					this.sessionControlGeneration === options.sessionControlGeneration &&
					this.permissionModeControlGeneration ===
						options.permissionModeControlGeneration &&
					this.desiredPermissionMode() === options.mode,
			});
		});
		void repair.catch((error) =>
			logDbError("repair provider permission mode rejection", error),
		);
	}

	private async restorePermissionModeAfterFailure(
		target: PermissionModeChangeTarget,
		previousMode: PermissionMode,
	): Promise<void> {
		if (!target.agentSession?.setPermissionMode) return;
		if (!this.ownsPermissionModeChangeTarget(target)) {
			this.retirePermissionModeTarget(target);
			return;
		}
		try {
			await target.agentSession.setPermissionMode(previousMode);
		} catch {
			this.retirePermissionModeTarget(target);
			return;
		}
		if (!this.ownsPermissionModeChangeTarget(target)) {
			this.retirePermissionModeTarget(target);
		}
	}

	private async applyPermissionModeChange(
		target: PermissionModeChangeTarget,
		mode: PermissionMode,
	): Promise<void> {
		if (!this.ownsPermissionModeChangeTarget(target)) {
			this.retirePermissionModeTarget(target);
			throw new PermissionModeChangeSupersededError();
		}
		const provider = this.providers.get(target.providerId);
		if (!provider) throw new PermissionModeChangeSupersededError();
		const model = this.selectedModelFor(
			this.agentCwd
				? this.agentSettingsMap.get(agentMapKey(this.agentCwd))
				: undefined,
		);
		await validateProviderPermissionMode(
			provider,
			mode,
			this.permissionModeValidationContext(model, mode === "auto"),
		);
		if (!this.ownsPermissionModeChangeTarget(target)) {
			this.retirePermissionModeTarget(target);
			throw new PermissionModeChangeSupersededError();
		}
		const previousMode = this.desiredPermissionMode();
		let liveApplied = false;
		try {
			if (!target.skipLiveSetter && target.agentSession?.setPermissionMode) {
				await target.agentSession.setPermissionMode(mode);
				liveApplied = true;
				if (!this.ownsPermissionModeChangeTarget(target)) {
					throw new PermissionModeChangeSupersededError();
				}
			}
			await this.persistPermissionModeChange(target, mode);
			if (!this.ownsPermissionModeChangeTarget(target)) {
				throw new PermissionModeChangeSupersededError();
			}
			this.permissionModeOverride = mode;
			this.permissionMode = mode;
			this.effectivePermissionMode = mode;
			this.permissionModeGeneration += 1;
		} catch (error) {
			if (liveApplied) {
				await this.restorePermissionModeAfterFailure(target, previousMode);
			} else if (
				error instanceof PermissionModeChangeSupersededError ||
				!this.ownsPermissionModeChangeTarget(target)
			) {
				this.retirePermissionModeTarget(target);
			}
			throw error;
		}
	}

	private async reconcileNativePermissionFallback(
		sourceSession: AgentSession,
		providerSessionId: string,
	): Promise<boolean> {
		const provider =
			this.providers.get(this.getProviderId()) ??
			this.resolveProvider(this.agentCwd);
		const target: PermissionModeChangeTarget = {
			sessionId: this.currentSessionId,
			providerId: provider.providerId,
			providerOwnershipGeneration: this.providerOwnershipGeneration,
			permissionModeControlGeneration: this.permissionModeControlGeneration,
			agentSession: sourceSession,
			agentSessionKey: this.agentSessionKey,
			skipLiveSetter: true,
		};
		const operation = this.permissionModeChangeTail.then(async () => {
			if (
				!this.ownsPermissionModeChangeTarget(target) ||
				this.providerSessionId !== providerSessionId ||
				this.desiredPermissionMode() !== "auto"
			) {
				return false;
			}
			let persistenceFailed = false;
			try {
				await this.persistPermissionModeChange(target, "default");
			} catch (error) {
				if (!this.ownsPermissionModeChangeTarget(target)) return false;
				persistenceFailed = true;
				logDbError("persist native permission mode fallback", error);
			}
			if (!this.ownsPermissionModeChangeTarget(target)) return false;
			this.commitAuthoritativePermissionMode("default", null);
			if (persistenceFailed && target.sessionId) {
				this.schedulePermissionModePersistenceRepair({
					sessionId: target.sessionId,
					providerId: target.providerId,
					providerOwnershipGeneration: target.providerOwnershipGeneration,
					sessionControlGeneration: this.sessionControlGeneration,
					permissionModeControlGeneration: this.permissionModeControlGeneration,
					mode: "default",
				});
			}
			return true;
		});
		this.permissionModeChangeTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	private async reconcilePreInputPermissionRejection(options: {
		sourceSession: AgentSession;
		sessionId: string | undefined;
		provider: AgentProvider;
		ownershipGeneration: number;
		rejection: ProviderPermissionModeRejectedError;
		emit: (message: ServerMessage) => void;
	}): Promise<void> {
		const {
			sourceSession,
			sessionId,
			provider,
			ownershipGeneration,
			rejection,
		} = options;
		if (
			this.agentSession !== sourceSession ||
			this.providerOwnershipGeneration !== ownershipGeneration ||
			this.getProviderId() !== provider.providerId ||
			this.currentSessionId !== (sessionId ?? null) ||
			this.desiredPermissionMode() !== rejection.attempted ||
			!KNOWN_PERMISSION_MODES.has(rejection.authoritative)
		) {
			return;
		}
		const authoritative = rejection.authoritative as PermissionMode;
		const target: PermissionModeChangeTarget = {
			sessionId: sessionId ?? null,
			providerId: provider.providerId,
			providerOwnershipGeneration: ownershipGeneration,
			permissionModeControlGeneration: this.permissionModeControlGeneration,
			agentSession: sourceSession,
			agentSessionKey: this.agentSessionKey,
			skipLiveSetter: true,
		};
		let persistenceFailed = false;
		try {
			await this.persistPermissionModeChange(target, authoritative);
		} catch (error) {
			if (!this.ownsPermissionModeChangeTarget(target)) return;
			persistenceFailed = true;
			logDbError("persist provider permission mode rejection", error);
		}
		if (!this.ownsPermissionModeChangeTarget(target)) return;
		this.commitAuthoritativePermissionMode(authoritative, sourceSession);
		if (persistenceFailed && sessionId) {
			this.schedulePermissionModePersistenceRepair({
				sessionId,
				providerId: provider.providerId,
				providerOwnershipGeneration: ownershipGeneration,
				sessionControlGeneration: this.sessionControlGeneration,
				permissionModeControlGeneration: this.permissionModeControlGeneration,
				mode: authoritative,
			});
		}
		options.emit({
			type: "session_control_rejected",
			control: "permission_mode",
			attempted_value: rejection.attempted,
			authoritative_value: authoritative,
			...(sessionId ? { session_id: sessionId } : {}),
		});
		options.emit({
			type: "status",
			state: this.state,
			model: this.model,
			permission_mode: authoritative,
			...this.approvalsReviewerStatusField(),
			effort: this.effort,
			...(this.currentTurnId ? { turn_id: this.currentTurnId } : {}),
		});
	}

	/**
	 * Mid-session effort switch. Session-scoped like setModel/setPermissionMode:
	 * applies a live provider control first when available, then persists and
	 * advertises the accepted selection. Providers without a live control use
	 * the persisted value after a restart/resume at the next turn boundary.
	 */
	validateEffort(effort: string, providerId = this.getProviderId()): void {
		const provider =
			this.providers.get(providerId) ?? this.resolveProvider(this.agentCwd);
		assertSupportedProviderEffort(provider, effort);
	}

	// fallow-ignore-next-line unused-class-member -- Called by the WebSocket set_effort dispatch in wsHandlers.
	async setEffort(effort: string): Promise<void> {
		this.assertRealtimeIdle("changing effort");
		const sessionId = this.currentSessionId;
		const sessionGeneration = this.sessionControlGeneration;
		const effortReady = this.effortChangeTail;
		const permissionReady = this.permissionModeChangeTail;
		const operation = Promise.all([effortReady, permissionReady]).then(() => {
			if (
				this.currentSessionId !== sessionId ||
				this.sessionControlGeneration !== sessionGeneration
			) {
				throw new EffortChangeSupersededError();
			}
			const provider =
				this.providers.get(this.getProviderId()) ??
				this.resolveProvider(this.agentCwd);
			this.validateEffort(effort, provider.providerId);
			return this.applyEffortChange(
				{
					sessionId,
					providerId: provider.providerId,
					providerOwnershipGeneration: this.providerOwnershipGeneration,
					effortControlGeneration: this.effortControlGeneration,
					agentSession: this.agentSession,
					agentSessionKey: this.agentSessionKey,
				},
				effort,
			);
		});
		// Install a settled barrier before the first provider/DB await so a chat
		// frame received immediately afterward cannot race the old selection.
		this.effortChangeTail = operation.then(
			() => undefined,
			() => undefined,
		);
		this.permissionModeChangeTail = this.effortChangeTail;
		return operation;
	}

	private async applyProviderSessionModeControl(
		control: (session: AgentSession) => Promise<void>,
	): Promise<void> {
		this.assertRealtimeIdle("changing the provider session mode");
		const sessionId = this.currentSessionId;
		const sessionGeneration = this.sessionControlGeneration;
		const providerGeneration = this.providerOwnershipGeneration;
		const providerId = this.getProviderId();
		const agentSession = this.agentSession;
		if (!agentSession) {
			throw new Error(
				`${this.providers.get(providerId)?.label ?? providerId} session mode control requires a live compatible session.`,
			);
		}
		const configReady = Promise.all([
			this.providerSessionModeChangeTail,
			this.effortChangeTail,
			this.permissionModeChangeTail,
		]);
		const operation = configReady.then(async () => {
			const ownsControl = () =>
				this.currentSessionId === sessionId &&
				this.sessionControlGeneration === sessionGeneration &&
				this.providerOwnershipGeneration === providerGeneration &&
				this.getProviderId() === providerId &&
				this.agentSession === agentSession;
			if (!ownsControl()) {
				throw new Error(
					"The provider session changed before its mode was updated.",
				);
			}
			await control(agentSession);
			if (!ownsControl()) {
				throw new Error(
					"The provider session changed while its mode was updating.",
				);
			}
		});
		const settled = operation.then(
			() => undefined,
			() => undefined,
		);
		this.providerSessionModeChangeTail = settled;
		// Model, effort, permission, and ACP mode setters all exchange complete
		// configOptions snapshots. Share their ordering lane so a later response
		// cannot overwrite a newer dependent selection.
		this.permissionModeChangeTail = settled;
		await operation;
	}

	// fallow-ignore-next-line unused-class-member -- Called by the WebSocket set_provider_mode dispatch in wsHandlers.
	async setProviderSessionMode(mode: string): Promise<void> {
		await this.applyProviderSessionModeControl(async (session) => {
			if (!session.setSessionMode) {
				throw new Error(
					`${this.providers.get(this.getProviderId())?.label ?? this.getProviderId()} session mode control requires a live compatible session.`,
				);
			}
			await session.setSessionMode(mode);
		});
	}

	// fallow-ignore-next-line unused-class-member -- Called by the WebSocket restore_provider_mode dispatch in wsHandlers.
	async restoreProviderSessionMode(): Promise<void> {
		await this.applyProviderSessionModeControl(async (session) => {
			if (!session.restoreSessionMode) {
				throw new Error(
					`${this.providers.get(this.getProviderId())?.label ?? this.getProviderId()} cannot restore a previous provider session mode.`,
				);
			}
			await session.restoreSessionMode();
		});
	}

	private ownsEffortChangeTarget(target: EffortChangeTarget): boolean {
		return (
			this.currentSessionId === target.sessionId &&
			this.getProviderId() === target.providerId &&
			this.providerOwnershipGeneration === target.providerOwnershipGeneration &&
			this.effortControlGeneration === target.effortControlGeneration &&
			this.agentSession === target.agentSession &&
			this.agentSessionKey === target.agentSessionKey
		);
	}

	private retireEffortTarget(target: EffortChangeTarget): void {
		if (
			!target.agentSession ||
			this.agentSession !== target.agentSession ||
			this.agentSessionKey !== target.agentSessionKey
		) {
			return;
		}
		this.stopBackgroundActivityObserver();
		target.agentSession.cancel();
		this.agentSession = null;
		this.agentSessionKey = null;
		this.restartAgentSessionForEffort = false;
		this.resetEffectiveApprovalsReviewer();
	}

	private async persistEffortChange(
		target: EffortChangeTarget,
		effort: string,
	): Promise<void> {
		if (!target.sessionId) {
			if (!this.ownsEffortChangeTarget(target)) {
				throw new EffortChangeSupersededError();
			}
			return;
		}
		await this.enqueueProviderOwnershipWrite(async () => {
			if (!this.ownsEffortChangeTarget(target)) {
				throw new EffortChangeSupersededError();
			}
			const previousPersistedEffort =
				(await db.getSessionSelection(target.sessionId as string))?.effort ??
				null;
			if (!this.ownsEffortChangeTarget(target)) {
				throw new EffortChangeSupersededError();
			}
			await db.setSessionEffort(target.sessionId as string, effort);
			if (!this.ownsEffortChangeTarget(target)) {
				// The guarded write committed just before ownership changed. Restore
				// the exact prior durable selection in this same serialized write lane
				// before a replacement session/provider can enqueue its own selection.
				await db.setSessionEffort(
					target.sessionId as string,
					previousPersistedEffort,
				);
				throw new EffortChangeSupersededError();
			}
		});
	}

	private async restoreEffortAfterFailure(
		target: EffortChangeTarget,
		previousEffort: string,
	): Promise<void> {
		if (!target.agentSession?.setEffort) return;
		if (!this.ownsEffortChangeTarget(target)) {
			this.retireEffortTarget(target);
			return;
		}
		try {
			await target.agentSession.setEffort(previousEffort);
		} catch {
			this.retireEffortTarget(target);
			return;
		}
		if (!this.ownsEffortChangeTarget(target)) {
			this.retireEffortTarget(target);
		}
	}

	private async applyEffortChange(
		target: EffortChangeTarget,
		effort: string,
	): Promise<void> {
		if (!this.ownsEffortChangeTarget(target)) {
			this.retireEffortTarget(target);
			throw new EffortChangeSupersededError();
		}
		const previousEffort = this.effort;
		const hasLiveSetter = Boolean(target.agentSession?.setEffort);
		let liveApplied = false;
		try {
			if (target.agentSession?.setEffort) {
				await target.agentSession.setEffort(effort);
				liveApplied = true;
				if (!this.ownsEffortChangeTarget(target)) {
					throw new EffortChangeSupersededError();
				}
			}
			await this.persistEffortChange(target, effort);
			if (!this.ownsEffortChangeTarget(target)) {
				throw new EffortChangeSupersededError();
			}
			this.effortOverride = effort;
			this.effort = effort;
			if (target.agentSession && !hasLiveSetter) {
				// Rebuild at the next turn boundary and resume the captured provider
				// session when the transport encodes effort at process creation.
				this.restartAgentSessionForEffort = true;
			}
		} catch (error) {
			if (liveApplied) {
				await this.restoreEffortAfterFailure(target, previousEffort);
			} else if (
				error instanceof EffortChangeSupersededError ||
				!this.ownsEffortChangeTarget(target)
			) {
				this.retireEffortTarget(target);
			}
			throw error;
		}
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

	/** Stop one provider-owned background task without aborting its parent turn. */
	// fallow-ignore-next-line unused-class-member -- Called by the WebSocket workflow_control dispatch in wsHandlers.
	async stopProviderTask(taskId: string): Promise<void> {
		if (!taskId.trim()) throw new Error("Task id is required");
		if (!this.agentSession?.stopTask) {
			throw new Error(
				`${this.resolveProvider(this.agentCwd).label ?? "This provider"} cannot stop background tasks from Raven`,
			);
		}
		await this.agentSession.stopTask(taskId);
	}

	getCurrentSessionId(): string | null {
		return this.currentSessionId;
	}

	// fallow-ignore-next-line unused-class-member -- HlidDelegationManager correlates the durable child with its active parent turn.
	getCurrentTurnId(): string | null {
		return this.currentTurnId ?? null;
	}

	// fallow-ignore-next-line unused-class-member -- HlidDelegationManager enforces inherited-or-narrower permissions against the effective turn boundary.
	getCurrentTurnPermissionMode(): PermissionMode | null {
		return this.currentTurnState ? this.currentTurnPermissionMode : null;
	}

	// fallow-ignore-next-line unused-class-member -- HlidDelegationManager prevents ordinary delegation from escaping a Routine's grant-scoped authorization context.
	isCurrentTurnRoutine(): boolean {
		return this.activeRoutineContext !== null;
	}

	// fallow-ignore-next-line unused-class-member -- HlidDelegationManager preserves the exact shared per-run Routine grant envelope in detached children.
	getCurrentRoutinePermissionContext(): RoutinePermissionContext | null {
		return this.activeRoutineContext;
	}

	// fallow-ignore-next-line unused-class-member -- HlidDelegationManager reads only this active turn's exact validated selections.
	getCurrentDelegationHandoff(): CurrentDelegationHandoff | null {
		const handoff = this.currentDelegationHandoff;
		return handoff
			? {
					skillContexts: [...handoff.skillContexts],
					relics: handoff.relics.map((relic) => ({ ...relic })),
					vaultReferences: [...handoff.vaultReferences],
					workspaceReferences: handoff.workspaceReferences.map((reference) => ({
						...reference,
					})),
					currentAssistantSequence: handoff.currentAssistantSequence,
				}
			: null;
	}

	getAgentCwd(): string | undefined {
		return this.agentCwd;
	}

	getProviderId(agentCwd?: string): string {
		if (
			agentCwd === undefined &&
			this.providerSessionProviderId &&
			this.providers.has(this.providerSessionProviderId)
		) {
			return this.providerSessionProviderId;
		}
		return this.resolveProvider(
			agentCwd ?? this.agentCwd ?? this.configuredAgentCwd,
		).providerId;
	}

	getSessionLabel(): string | null {
		return this.currentSessionLabel;
	}

	/** Sync the in-memory label after a DB rename so live status shows it. */
	setSessionLabel(label: string): void {
		this.currentSessionLabel = label;
	}

	getSessionPresentation(): {
		pinned: boolean;
		forkParentSessionId: string | null;
		forkParentLabel: string | null;
		forkKind: "exact" | "recap" | null;
		delegationParentSessionId: string | null;
		delegationParentLabel: string | null;
		delegationParentTurnId: string | null;
		delegationDepth: number | null;
	} {
		return {
			pinned: this.currentSessionPinned,
			forkParentSessionId: this.currentForkParentSessionId,
			forkParentLabel: this.currentForkParentLabel,
			forkKind: this.currentForkKind,
			delegationParentSessionId: this.currentDelegationParentSessionId,
			delegationParentLabel: this.currentDelegationParentLabel,
			delegationParentTurnId: this.currentDelegationParentTurnId,
			delegationDepth: this.currentDelegationDepth,
		};
	}

	// fallow-ignore-next-line unused-class-member -- Called through SessionPool entries in the DB session mutation route.
	setSessionPinned(pinned: boolean): void {
		this.currentSessionPinned = pinned;
	}

	// fallow-ignore-next-line unused-class-member -- Called through SessionPool entries in the DB session mutation route.
	setForkParentLabel(parentSessionId: string, label: string): void {
		if (this.currentForkParentSessionId === parentSessionId) {
			this.currentForkParentLabel = label;
		}
		if (this.currentDelegationParentSessionId === parentSessionId) {
			this.currentDelegationParentLabel = label;
		}
	}

	getLastMcpStatus(
		providerId = this.getProviderId(),
	): McpServerStatus[] | null {
		return this.mcpStatusByProvider.get(providerId) ?? null;
	}

	getMcpControlOperations(): McpControlOperation[] {
		const operations: McpControlOperation[] = [];
		if (this.agentSession?.reconnectMcpServer) operations.push("reconnect");
		if (this.agentSession?.toggleMcpServer) operations.push("toggle");
		if (
			this.agentSession?.setMcpPermissionModeOverride &&
			this.agentSession.mcpPermissionModeOverrideAvailable
		) {
			operations.push("permission-override");
		}
		return operations;
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
	 * Reload provider-native skills only through this session's existing Query.
	 * A missing or cold session reports not-live so callers can still refresh
	 * Hlid's disk catalog without spawning a hidden provider process.
	 */
	// fallow-ignore-next-line unused-class-member -- Called through SessionPool entries by the provider skill refresh coordinator.
	async reloadProviderSkills(
		emit: (msg: ServerMessage) => void,
	): Promise<ProviderSkillReloadResult> {
		const providerId = this.getProviderId();
		const session = this.agentSession;
		if (providerId !== "claude" || !session?.reloadSkills) {
			return {
				providerId,
				status: "not-live",
				reason:
					providerId === "claude"
						? "This Claude session does not have a live native skill-reload channel."
						: "This session is not owned by the Claude Agent SDK provider.",
			};
		}
		const skills = await session.reloadSkills();
		if (!skills) {
			return {
				providerId,
				status: "not-live",
				reason:
					"This Claude session has not established its native Query yet. Complete a Claude turn before refreshing its live skill catalog.",
			};
		}
		// Claude's supportedCommands() is an initialization snapshot and remains
		// stale after a mid-session reload. reloadSkills() returns the refreshed
		// full skill-command list, so publish that response directly.
		emit({
			type: "slash_commands",
			provider_id: providerId,
			...(this.agentCwd ? { agent_cwd: this.agentCwd } : {}),
			...(this.currentSessionId ? { session_id: this.currentSessionId } : {}),
			commands: skills,
		});
		return { providerId, status: "reloaded", skillCount: skills.length };
	}

	/**
	 * Reconcile Hlid's canonical workspace MCP definitions through an existing
	 * Claude Query. A cold session is deliberately deferred so this control never
	 * creates a hidden provider process merely because Forge changed a file.
	 */
	// fallow-ignore-next-line unused-class-member -- Called by MCP inventory sync after Forge mutations.
	async applyProviderMcpServers(
		servers: ProviderMcpServerDefinition[],
		emit: (msg: ServerMessage) => void,
	): Promise<ProviderMcpConfigApplyResult> {
		const providerId = this.getProviderId();
		const session = this.agentSession;
		if (providerId !== "claude" || !session?.setMcpServers) {
			return {
				providerId,
				status: "not-live",
				reason:
					providerId === "claude"
						? "This Claude session does not expose live MCP replacement."
						: "This session is not owned by the Claude Agent SDK provider.",
			};
		}
		const result = await session.setMcpServers(servers);
		if (!result) {
			return {
				providerId,
				status: "not-live",
				reason:
					"This Claude session has not established its native Query yet. Its next turn will load the updated MCP configuration.",
			};
		}
		const statuses = (await session.mcpServerStatus?.()) ?? [];
		this.mcpStatusByProvider.set(providerId, statuses);
		emit({
			type: "mcp_status",
			provider_id: providerId,
			...(this.getMcpControlOperations().length
				? { operations: this.getMcpControlOperations() }
				: {}),
			...(this.agentCwd ? { agent_cwd: this.agentCwd } : {}),
			...(this.currentSessionId ? { session_id: this.currentSessionId } : {}),
			servers: statuses.map(mapMcpServer),
		});
		return { providerId, status: "applied", result, statuses };
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
		this.stopBackgroundActivityObserver();
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

	// fallow-ignore-next-line unused-class-member -- Called by the WebSocket probe_provider_config dispatch in wsHandlers.
	probeProviderSessionConfig(
		emit: (msg: ServerMessage) => void,
		scope: ProviderProbeScope = {},
	): void {
		const { providerId, targetsLiveScope } = this.resolveProbeContext(scope);
		if (!targetsLiveScope || !scope.sessionId) return;
		const config = this.agentSession?.sessionConfig?.();
		if (!config) return;
		emit({
			type: "provider_config_options",
			provider_id: providerId,
			session_id: scope.sessionId,
			...(scope.agentCwd ? { agent_cwd: scope.agentCwd } : {}),
			...config,
		});
	}

	private async publishLiveProviderSnapshot<T>(options: {
		targetsLiveScope: boolean;
		isLiveScopeCurrent: () => boolean;
		expectedProviderId: string;
		read: (session: AgentSession) => T | Promise<T> | undefined;
		publish: (value: T) => void;
	}): Promise<"published" | "unavailable" | "superseded"> {
		if (!options.targetsLiveScope) return "unavailable";
		if (!options.isLiveScopeCurrent()) return "superseded";
		const session = this.agentSession;
		const sessionKey = this.agentSessionKey;
		if (!session) return "unavailable";
		if (!this.agentSessionMatchesProbeScope(options.expectedProviderId)) {
			return "unavailable";
		}
		const pending = options.read(session);
		if (pending === undefined) return "unavailable";
		const value = await pending;
		if (
			this.agentSession !== session ||
			this.agentSessionKey !== sessionKey ||
			!this.agentSessionMatchesProbeScope(options.expectedProviderId) ||
			!options.isLiveScopeCurrent()
		) {
			return "superseded";
		}
		options.publish(value);
		return "published";
	}

	private agentSessionMatchesProbeScope(providerId: string): boolean {
		if (!this.agentSessionKey) return false;
		const baseKey = `${providerId}|${this.currentSessionId ?? "ephemeral"}|${this.agentSessionContextKey()}`;
		return (
			this.agentSessionKey === baseKey ||
			(providerId === "codex" &&
				this.agentSessionKey.startsWith(`${baseKey}|codex-permissions:`))
		);
	}

	private probeTargetsLiveProvider(
		scope: ProviderProbeScope,
		provider: AgentProvider,
	): boolean {
		const current = this.resolveProbeContext(scope);
		return current.targetsLiveScope && current.provider === provider;
	}

	private async probeProviderSessionMetadata<T>(options: {
		activeAgentCwd?: string;
		agentCwd?: string;
		provider: AgentProvider;
		targetsLiveScope: boolean;
		isLiveScopeCurrent: () => boolean;
		read: (session: AgentSession) => T | Promise<T> | undefined;
		fromClaudeWarmup: (snapshot: ClaudeWarmupSnapshot) => T;
		empty: T;
		publish: (value: T) => void;
	}): Promise<void> {
		const publishLiveSession = () =>
			this.publishLiveProviderSnapshot({
				targetsLiveScope: options.targetsLiveScope,
				isLiveScopeCurrent: options.isLiveScopeCurrent,
				expectedProviderId: options.provider.providerId,
				read: options.read,
				publish: options.publish,
			});
		const publishCurrent = (value: T) => {
			if (!options.targetsLiveScope || options.isLiveScopeCurrent()) {
				options.publish(value);
			}
		};
		if ((await publishLiveSession()) !== "unavailable") return;
		if (options.provider.probeRequiresTurn) {
			const cached = isClaudeRuntimeProvider(options.provider.providerId)
				? await waitForClaudeWarmupSnapshot(
						options.activeAgentCwd ?? this.vaultPath,
					)
				: null;
			if ((await publishLiveSession()) !== "unavailable") return;
			publishCurrent(cached ? options.fromClaudeWarmup(cached) : options.empty);
			return;
		}
		await this.runProbe(
			async (session) => {
				const pending = options.read(session);
				const value = pending === undefined ? options.empty : await pending;
				if ((await publishLiveSession()) !== "unavailable") return;
				publishCurrent(value);
			},
			options.agentCwd,
			options.provider,
		);
	}

	async probeMcpStatus(
		emit: (msg: ServerMessage) => void,
		scope: ProviderProbeScope = {},
	): Promise<void> {
		const { activeAgentCwd, provider, providerId, targetsLiveScope } =
			this.resolveProbeContext(scope);
		const publish = (statuses: McpServerStatus[]) => {
			const operations = targetsLiveScope ? this.getMcpControlOperations() : [];
			// Archived-session probes may be proxied through the vault manager. Keep
			// their scoped result out of the vault cache or Watch will inherit the
			// wrong provider context on its next connection.
			if (targetsLiveScope) {
				this.mcpStatusByProvider.set(providerId, statuses);
			}
			emit({
				type: "mcp_status",
				provider_id: providerId,
				...(operations.length ? { operations } : {}),
				...(scope.agentCwd ? { agent_cwd: scope.agentCwd } : {}),
				...(scope.sessionId ? { session_id: scope.sessionId } : {}),
				servers: statuses.map(mapMcpServer),
			});
		};
		await this.probeProviderSessionMetadata<McpServerStatus[]>({
			activeAgentCwd,
			agentCwd: scope.agentCwd,
			provider,
			targetsLiveScope,
			isLiveScopeCurrent: () => this.probeTargetsLiveProvider(scope, provider),
			read: (session) => session.mcpServerStatus?.(),
			fromClaudeWarmup: (snapshot) => snapshot.mcpServers,
			empty: [],
			publish,
		});
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
		await this.probeProviderSessionMetadata<SlashCommand[]>({
			activeAgentCwd,
			agentCwd: scope.agentCwd,
			provider,
			targetsLiveScope,
			isLiveScopeCurrent: () => this.probeTargetsLiveProvider(scope, provider),
			read: (session) => session.supportedCommands?.(),
			fromClaudeWarmup: (snapshot) => snapshot.commands,
			empty: [],
			publish,
		});
	}

	// fallow-ignore-next-line unused-class-member -- Called by the WebSocket probe_workflows dispatch in wsHandlers.
	async probeWorkflowCatalog(
		emit: (msg: ServerMessage) => void,
		scope: ProviderProbeScope = {},
	): Promise<void> {
		const { activeAgentCwd, provider, providerId } =
			this.resolveProbeContext(scope);
		let catalog: ProviderWorkflowCatalog = {
			workflows: [],
			locations: [],
		};
		if (provider.listWorkflows) {
			try {
				catalog = await provider.listWorkflows({
					cwd: activeAgentCwd ?? this.vaultPath,
				});
			} catch {
				// A missing provider home or detached workspace should not block Raven.
			}
		}
		emit({
			type: "workflow_catalog",
			provider_id: providerId,
			...(scope.agentCwd ? { agent_cwd: scope.agentCwd } : {}),
			...(scope.sessionId ? { session_id: scope.sessionId } : {}),
			...catalog,
		});
	}

	// fallow-ignore-next-line unused-class-member -- Called through SessionPool entries by the WebSocket MCP control dispatch.
	async controlMcpServer(
		request: { serverName: string; action: McpControlAction },
		options: {
			sessionId: string;
			emit: (msg: ServerMessage) => void;
		},
	): Promise<{
		providerId: string;
		statuses: McpServerStatus[];
		warning?: string;
	}> {
		const provider = this.resolveProvider(this.agentCwd);
		const session = this.agentSession;
		if (!session) {
			throw new Error(
				`${provider.label ?? provider.providerId} MCP controls require a live session.`,
			);
		}
		let warning: string | undefined;
		if (request.action === "reconnect") {
			if (!session.reconnectMcpServer) {
				throw new Error(
					`${provider.label ?? provider.providerId} does not expose native MCP reconnect.`,
				);
			}
			await session.reconnectMcpServer(request.serverName);
		} else if (request.action === "enable" || request.action === "disable") {
			if (!session.toggleMcpServer) {
				throw new Error(
					`${provider.label ?? provider.providerId} does not expose native MCP toggle.`,
				);
			}
			await session.toggleMcpServer(
				request.serverName,
				request.action === "enable",
			);
		} else {
			if (
				!session.setMcpPermissionModeOverride ||
				!session.mcpPermissionModeOverrideAvailable
			) {
				throw new Error(
					`${provider.label ?? provider.providerId} does not expose a native MCP permission override in this session.`,
				);
			}
			const mode =
				request.action === "permission-default"
					? "default"
					: request.action === "permission-auto"
						? "auto"
						: null;
			const result = await session.setMcpPermissionModeOverride(
				request.serverName,
				mode,
			);
			warning = result.warning;
		}
		let statuses = this.getLastMcpStatus(provider.providerId) ?? [];
		if (session.mcpServerStatus) {
			try {
				statuses = await session.mcpServerStatus();
			} catch {
				// The native control already succeeded. Keep the last known snapshot
				// instead of misreporting a follow-up status refresh as action failure.
			}
		}
		this.mcpStatusByProvider.set(provider.providerId, statuses);
		const operations = this.getMcpControlOperations();
		options.emit({
			type: "mcp_status",
			provider_id: provider.providerId,
			...(operations.length ? { operations } : {}),
			...(this.agentCwd ? { agent_cwd: this.agentCwd } : {}),
			session_id: options.sessionId,
			servers: statuses.map(mapMcpServer),
		});
		return {
			providerId: provider.providerId,
			statuses,
			...(warning ? { warning } : {}),
		};
	}

	// fallow-ignore-next-line unused-class-member -- Called by the WebSocket file_rewind dispatch.
	async controlFileRewind(
		request: {
			turnId: string;
			action: "preview" | "execute";
			previewId?: string;
		},
		options: { sessionId: string },
	): Promise<ProviderFileRewindResult & { previewId?: string }> {
		if (!this.currentSessionId || this.currentSessionId !== options.sessionId) {
			throw new Error("File rewind must target the active Hlid session.");
		}
		if (this.state !== "idle") {
			throw new Error(
				"Wait for the active turn to finish before rewinding files.",
			);
		}
		if (this.historyResumeMode === "session-store") {
			throw new Error(
				"Imported Claude histories use the SDK session store and cannot use file checkpoints.",
			);
		}
		const provider = this.resolveProvider(this.agentCwd);
		const session = this.agentSession;
		if (
			!session?.rewindFiles ||
			!isClaudeRuntimeProvider(provider.providerId)
		) {
			throw new Error(
				"File rewind requires a live direct Claude session created with checkpointing enabled.",
			);
		}
		const checkpoint = await db.getUserMessageCheckpoint(
			options.sessionId,
			request.turnId,
		);
		if (!checkpoint) {
			throw new Error("This user turn does not have a Claude file checkpoint.");
		}
		if (
			this.providerSessionProviderId !== provider.providerId ||
			this.providerSessionId !== checkpoint.providerSessionId
		) {
			throw new Error(
				"This checkpoint belongs to a different native Claude session.",
			);
		}

		const now = Date.now();
		for (const [id, preview] of this.fileRewindPreviews) {
			if (now - preview.createdAt > FILE_REWIND_PREVIEW_TTL_MS) {
				this.fileRewindPreviews.delete(id);
			}
		}
		if (request.action === "preview") {
			const result = normalizeFileRewindResult(
				await session.rewindFiles(checkpoint.checkpointUuid, { dryRun: true }),
			);
			const previewId = randomUUID();
			this.fileRewindPreviews.set(previewId, {
				sessionId: options.sessionId,
				turnId: request.turnId,
				checkpointUuid: checkpoint.checkpointUuid,
				providerSessionId: checkpoint.providerSessionId,
				createdAt: now,
				result,
			});
			return { ...result, previewId };
		}

		const previewId = request.previewId;
		const preview = previewId
			? this.fileRewindPreviews.get(previewId)
			: undefined;
		if (
			!preview ||
			preview.sessionId !== options.sessionId ||
			preview.turnId !== request.turnId ||
			preview.checkpointUuid !== checkpoint.checkpointUuid ||
			preview.providerSessionId !== checkpoint.providerSessionId ||
			now - preview.createdAt > FILE_REWIND_PREVIEW_TTL_MS
		) {
			throw new Error(
				"The file rewind preview expired. Preview the change again.",
			);
		}
		this.fileRewindPreviews.delete(previewId as string);
		if (!preview.result.canRewind) {
			throw new Error(
				preview.result.error ?? "Claude cannot rewind this checkpoint.",
			);
		}
		const currentPreview = normalizeFileRewindResult(
			await session.rewindFiles(checkpoint.checkpointUuid, { dryRun: true }),
		);
		if (!sameFileRewindPreview(preview.result, currentPreview)) {
			throw new Error(
				"Tracked files changed after the preview. Review a fresh preview before rewinding.",
			);
		}
		return normalizeFileRewindResult(
			await session.rewindFiles(checkpoint.checkpointUuid),
		);
	}

	// fallow-ignore-next-line unused-class-member -- Called by the WebSocket save_workflow dispatch in wsHandlers.
	async saveProviderWorkflow(
		input: Omit<ProviderWorkflowSaveInput, "cwd">,
		scope: ProviderProbeScope = {},
	): Promise<ProviderSavedWorkflow> {
		const { activeAgentCwd, provider } = this.resolveProbeContext(scope);
		if (!provider.saveWorkflow) {
			throw new Error(
				`${provider.label ?? "This provider"} does not expose reusable workflows`,
			);
		}
		return provider.saveWorkflow({
			...input,
			cwd: activeAgentCwd ?? this.vaultPath,
		});
	}

	// fallow-ignore-next-line unused-class-member -- Called by the WebSocket delete_workflow dispatch in wsHandlers.
	async deleteProviderWorkflow(
		input: Omit<ProviderWorkflowDeleteInput, "cwd">,
		scope: ProviderProbeScope = {},
	): Promise<void> {
		const { activeAgentCwd, provider } = this.resolveProbeContext(scope);
		if (!provider.deleteWorkflow) {
			throw new Error(
				`${provider.label ?? "This provider"} does not expose reusable workflows`,
			);
		}
		await provider.deleteWorkflow({
			...input,
			cwd: activeAgentCwd ?? this.vaultPath,
		});
	}

	// fallow-ignore-next-line unused-class-member -- Called by the WebSocket read_workflow_source dispatch in wsHandlers.
	async readProviderWorkflowSource(
		input: Omit<ProviderWorkflowSourceInput, "cwd">,
		scope: ProviderProbeScope = {},
	): Promise<string> {
		const { activeAgentCwd, provider } = this.resolveProbeContext(scope);
		if (!provider.readWorkflowSource) {
			throw new Error(
				`${provider.label ?? "This provider"} does not expose workflow definitions`,
			);
		}
		return provider.readWorkflowSource({
			...input,
			cwd: activeAgentCwd ?? this.vaultPath,
		});
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
		const {
			provider,
			agentSettings,
			resumeProviderSessionId,
			ownershipGeneration,
		} = await this.prepareProviderForTurn(options.sessionId);
		if (!isCodexRuntimeProvider(provider.providerId)) {
			throw new Error("/goal is only available for Codex sessions.");
		}
		const ordinaryGoalTarget = this.codexPermissionProfileRuntimeTarget({
			providerId: provider.providerId,
			sessionId: options.sessionId,
			forceOrdinaryCodexRuntime: true,
		});
		const activeRuntimeKeyMismatch = Boolean(
			this.agentSession && this.agentSessionKey !== ordinaryGoalTarget.key,
		);
		if ((this.isDraining || this.isRunning()) && activeRuntimeKeyMismatch) {
			if (control.action === "get") {
				return { providerId: provider.providerId, goal: this.currentGoal };
			}
			throw new Error(
				"Wait for the current turn to finish before changing the Codex goal.",
			);
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
		const publishGoal = (goal: ProviderThreadGoal | null) => {
			this.currentGoal = goal;
			options.emit({
				type: "goal_state",
				session_id: options.sessionId,
				provider_id: provider.providerId,
				goal: goal ? mapProviderGoal(goal) : null,
			});
		};
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
			await this.prepareCodexPermissionProfileRuntimeForTurn({
				provider,
				sessionId: options.sessionId,
				acceptedProfileGeneration: this.codexPermissionProfileGeneration,
				acceptedBehindPurposeBuiltTurn: false,
				signal: this.abortController?.signal,
			});
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
			const accepted = await this.persistProviderSession(
				options.sessionId,
				provider.providerId,
				result.providerSessionId,
				ownershipGeneration,
			);
			if (!accepted) {
				throw new Error(
					"The provider changed while goal control was in progress.",
				);
			}
			this.currentGoal = result.goal;
			this.providerSessionId = result.providerSessionId;
			this.providerSessionProviderId = provider.providerId;
			if (ownsContinuationDrain) {
				this.runGoalContinuation({
					agentSession,
					sessionId: options.sessionId,
					emit: options.emit,
					provider,
					agentSettings,
					ownershipGeneration,
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

	// fallow-ignore-next-line unused-class-member -- Called by WebSocket realtime controls in wsHandlers.
	async controlRealtime(
		control: RealtimeControl,
		options: RealtimeControlOptions,
	): Promise<void> {
		if (control.action !== "start") {
			await this.controlActiveRealtime(control, options);
			return;
		}

		const prepared = await this.prepareRealtimeStart(control, options);
		const realtimeGeneration = ++this.realtimeGeneration;
		this.realtimeRequestId = options.requestId ?? null;
		const requestIdentity: RealtimeRequestIdentity = options.requestId
			? { request_id: options.requestId }
			: {};
		let publishRealtimeError = (_message: string): Promise<void> =>
			Promise.resolve();
		const liveCoordination =
			control.mode === "live"
				? this.createLiveRealtimeCoordination({
						sessionId: options.sessionId,
						emit: options.emit,
						requestIdentity,
						provider: prepared.provider,
						agentSettings: prepared.agentSettings,
						ownershipGeneration: prepared.ownershipGeneration,
						onError: (message) => {
							void publishRealtimeError(message);
						},
					})
				: null;
		const terminal = this.createRealtimeTerminalLifecycle({
			mode: control.mode,
			sessionId: options.sessionId,
			emit: options.emit,
			requestIdentity,
			realtimeGeneration,
			agentSession: prepared.agentSession,
			liveCoordination,
		});
		publishRealtimeError = terminal.publishError;
		const publish = this.createRealtimeEventPublisher({
			mode: control.mode,
			sessionId: options.sessionId,
			emit: options.emit,
			requestIdentity,
			realtimeGeneration,
			agentSession: prepared.agentSession,
			liveCoordination,
			terminal,
		});
		await this.startPreparedRealtimeSession({
			control,
			options,
			prepared,
			realtimeGeneration,
			requestIdentity,
			publish,
			publishClosed: terminal.publishClosed,
		});
	}

	private async controlActiveRealtime(
		control: Exclude<RealtimeControl, { action: "start" }>,
		options: RealtimeControlOptions,
	): Promise<void> {
		if (control.action === "speak") {
			if (
				!this.realtimeAgentSession?.appendRealtimeSpeech ||
				this.realtimeMode !== control.mode
			) {
				throw new Error("No Codex voice session is active.");
			}
			if (!this.matchesRealtimeRequest(options.requestId)) {
				throw new Error(
					"This Codex voice request was replaced by a newer session.",
				);
			}
			await this.realtimeAgentSession.appendRealtimeSpeech(control.text);
			return;
		}
		if (this.realtimeMode && !this.matchesRealtimeRequest(options.requestId)) {
			// The WebSocket handler publishes the request-correlated idempotent close
			// acknowledgement. An old browser generation cannot stop its replacement.
			return;
		}
		await this.stopRealtimeSession(undefined, options.emit);
	}

	private async prepareRealtimeStart(
		control: RealtimeStartControl,
		options: RealtimeControlOptions,
	): Promise<PreparedRealtimeStart> {
		if (!this.codexRealtimeEnabled) {
			throw new Error(
				"Codex realtime voice is disabled. Enable the Developer Preview in Forge first.",
			);
		}
		if (control.mode === "live" && this.isRunning()) {
			throw new Error(
				"Wait for the current turn to finish before starting Live.",
			);
		}
		if (this.realtimeStopPromise) {
			await this.realtimeStopPromise.catch(() => {});
		} else if (this.realtimeMode) {
			await this.stopRealtimeSession().catch(() => {});
		}

		const context = await this.prepareRealtimeProviderContext(control, options);
		if (context.provider.providerId !== "codex") {
			throw new Error(
				"Codex voice is only available in native Codex sessions.",
			);
		}
		const { activeCwd, extraDirs, executable } = resolveExecutionContext({
			agentMode: context.realtimeAgentMode,
			agentCwd: context.realtimeAgentCwd,
			vaultPath: this.vaultPath,
			allowedAgentRealPaths: this.allowedAgentRealPaths,
			claudeExecutable: this.codexExecutable,
			wrapperCommand: "codex",
			safeAttachments: [],
		});
		if (control.mode === "live") {
			await this.prepareCodexPurposeBuiltRuntimeTransition({
				providerId: context.provider.providerId,
				sessionId: context.persistenceSessionId,
			});
		}
		const agentSession =
			control.mode === "live"
				? this.getOrCreateAgentSession({
						provider: context.provider,
						sessionId: context.persistenceSessionId,
						resumeProviderSessionId: context.resumeProviderSessionId,
						activeCwd,
						extraDirs,
						executable,
						agentSettings: context.agentSettings,
						planMode: false,
						emit: options.emit,
						reconcileApprovalsReviewer: false,
						useCodexPermissionProfile: false,
					})
				: this.createDetachedRealtimeAgentSession({
						provider: context.provider,
						activeCwd,
						executable,
						agentSettings: context.agentSettings,
						agentMode: context.realtimeAgentMode,
					});
		this.realtimeAgentSession = agentSession;
		const startRealtime = agentSession.startRealtime;
		if (!startRealtime) {
			this.retireAgentSessionAfterRealtime(agentSession);
			throw new Error(
				"The active Codex version does not support realtime voice.",
			);
		}
		return {
			provider: context.provider,
			agentSettings: context.agentSettings,
			ownershipGeneration: context.ownershipGeneration,
			agentSession,
			startRealtime,
		};
	}

	private async prepareRealtimeProviderContext(
		control: RealtimeStartControl,
		options: RealtimeControlOptions,
	): Promise<RealtimeProviderContext> {
		const persistenceSessionId = options.transient
			? undefined
			: options.sessionId;
		return control.mode === "live"
			? this.prepareLiveRealtimeProviderContext(options, persistenceSessionId)
			: this.prepareSpeechRealtimeProviderContext(
					options,
					persistenceSessionId,
				);
	}

	private async prepareLiveRealtimeProviderContext(
		options: RealtimeControlOptions,
		persistenceSessionId: string | undefined,
	): Promise<RealtimeProviderContext> {
		await this.initSessionContext(
			persistenceSessionId,
			options.agentCwd,
			"Live voice",
		);
		const {
			provider,
			agentSettings,
			resumeProviderSessionId,
			ownershipGeneration,
		} = await this.prepareProviderForTurn(persistenceSessionId);
		return {
			persistenceSessionId,
			provider,
			agentSettings,
			resumeProviderSessionId,
			ownershipGeneration,
			realtimeAgentCwd: this.agentCwd,
			realtimeAgentMode: this.agentMode,
		};
	}

	private async prepareSpeechRealtimeProviderContext(
		options: RealtimeControlOptions,
		persistenceSessionId: string | undefined,
	): Promise<RealtimeProviderContext> {
		const establishedAgentMode = this.agentMode;
		// Restoring an idle archived chat is safe, but an active ordinary turn owns
		// every mutable Raven field. Speech only observes that established context.
		if (
			!this.isRunning() &&
			persistenceSessionId &&
			persistenceSessionId !== this.currentSessionId
		) {
			await this.initSessionContext(
				persistenceSessionId,
				options.agentCwd,
				"Voice",
				false,
			);
		}
		const realtimeAgentCwd =
			options.agentCwd ?? this.agentCwd ?? this.configuredAgentCwd;
		const realtimeAgentMode =
			realtimeAgentCwd !== this.agentCwd ? "cwd" : establishedAgentMode;
		const configuredProvider = this.resolveProvider(realtimeAgentCwd);
		const provider =
			(this.providerSessionProviderId
				? this.providers.get(this.providerSessionProviderId)
				: undefined) ?? configuredProvider;
		const configuredProviderId = realtimeAgentCwd
			? (this.agentProviderMap.get(agentMapKey(realtimeAgentCwd)) ??
				this.vaultProviderId)
			: this.vaultProviderId;
		const agentSettings =
			realtimeAgentCwd && provider.providerId === configuredProviderId
				? this.agentSettingsMap.get(agentMapKey(realtimeAgentCwd))
				: undefined;
		return {
			persistenceSessionId,
			provider,
			agentSettings,
			resumeProviderSessionId: null,
			ownershipGeneration: this.providerOwnershipGeneration,
			realtimeAgentCwd,
			realtimeAgentMode,
		};
	}

	private createLiveRealtimeCoordination(options: {
		sessionId: string;
		emit: (message: ServerMessage) => void;
		requestIdentity: RealtimeRequestIdentity;
		provider: AgentProvider;
		agentSettings: AgentSettings | undefined;
		ownershipGeneration: number;
		onError: (message: string) => void;
	}): LiveRealtimeCoordination {
		const realtimeSessionId = `raven-live-${randomUUID()}`;
		let providerRealtimeSessionId: string | undefined;
		const activeUtterances = new Map<
			RealtimeTranscriptRole,
			RealtimeUtterance
		>();
		const utteranceFor = (role: RealtimeTranscriptRole): RealtimeUtterance => {
			const active = activeUtterances.get(role);
			if (active) return active;
			const transcriptSeq = this.messageSeq++;
			const utterance = {
				utteranceId: `codex-realtime-${transcriptSeq}`,
				transcriptSeq,
			};
			activeUtterances.set(role, utterance);
			return utterance;
		};
		const transcriptMetadata = (utterance: RealtimeUtterance) => ({
			utterance_id: utterance.utteranceId,
			realtime_session_id: realtimeSessionId,
			...(providerRealtimeSessionId
				? { provider_realtime_session_id: providerRealtimeSessionId }
				: {}),
			transcript_seq: utterance.transcriptSeq,
			source: "codex_realtime" as const,
			fork_supported: false,
		});
		let currentLiveAssistantActivity: LiveAssistantActivity | null = null;
		const liveActivitiesByUtterance = new Map<string, LiveAssistantActivity>();
		const liveActivitiesByToolId = new Map<string, LiveAssistantActivity>();
		const liveAssistantActivity = (): LiveAssistantActivity => {
			const utterance = utteranceFor("assistant");
			if (
				currentLiveAssistantActivity?.utterance.utteranceId ===
				utterance.utteranceId
			) {
				return currentLiveAssistantActivity;
			}
			const turn = createTurnState(
				this.selectedModelFor(options.agentSettings),
				options.ownershipGeneration,
			);
			// Live transcript persistence owns the messages row. Tool persistence can
			// safely use the reserved sequence before that row is finalized.
			turn.reservedAssistantSeq = utterance.transcriptSeq;
			turn.assistantRowWrite = Promise.resolve();
			const activity = {
				utterance,
				turn,
				finalQueued: false,
				completedToolIds: new Set<string>(),
			};
			currentLiveAssistantActivity = activity;
			liveActivitiesByUtterance.set(utterance.utteranceId, activity);
			return activity;
		};
		const queuePersistedLiveTranscriptFinal = (
			role: RealtimeTranscriptRole,
			text: string,
			utterance: RealtimeUtterance,
		): Promise<void> => {
			const activity = liveActivitiesByUtterance.get(utterance.utteranceId);
			if (activity?.finalQueued) return Promise.resolve();
			if (activity) activity.finalQueued = true;
			const pending = this.realtimeTranscriptWriteTail.then(async () => {
				const persisted = await db.appendRealtimeTranscriptMessage({
					sessionId: options.sessionId,
					seq: utterance.transcriptSeq,
					role,
					text,
					utteranceId: utterance.utteranceId,
					realtimeSessionId,
					providerRealtimeSessionId,
				});
				if (persisted.inserted) bumpDataRevision("sessions");
				options.emit({
					type: "realtime_transcript",
					session_id: options.sessionId,
					...options.requestIdentity,
					mode: "live",
					role,
					text,
					done: true,
					db_id: persisted.id,
					...transcriptMetadata(utterance),
				});
			});
			this.realtimeTranscriptWriteTail = pending.then(
				() => undefined,
				() => undefined,
			);
			void pending.catch((error) => {
				logDbError("append realtime transcript", error);
				options.onError(
					"Raven Live stopped because its transcript could not be saved.",
				);
			});
			return pending.catch(() => {});
		};
		const queueTranscriptFinal = (
			event: Extract<ProviderRealtimeEvent, { type: "transcript_done" }>,
		) => {
			const text = event.text.trim();
			const role =
				event.role === "user" || event.role === "assistant" ? event.role : null;
			if (!role) return;
			const active = activeUtterances.get(role);
			const utterance = active ?? (text ? utteranceFor(role) : undefined);
			if (!utterance) return;
			activeUtterances.delete(role);
			const activity = liveActivitiesByUtterance.get(utterance.utteranceId);
			if (role === "assistant" && currentLiveAssistantActivity === activity) {
				currentLiveAssistantActivity = null;
			}
			if (!text && !(activity?.turn.hadToolEvents ?? false)) {
				options.emit({
					type: "realtime_transcript",
					session_id: options.sessionId,
					...options.requestIdentity,
					mode: "live",
					role,
					text: "",
					done: true,
					...transcriptMetadata(utterance),
				});
				return;
			}
			void queuePersistedLiveTranscriptFinal(role, text, utterance);
		};
		const flushToolOnlyActivities = async () => {
			const pending = [...liveActivitiesByUtterance.values()].filter(
				(activity) => activity.turn.hadToolEvents && !activity.finalQueued,
			);
			for (const activity of pending) {
				await Promise.all(activity.turn.pendingToolEventWrites.values());
				await Promise.all(activity.turn.pendingToolMetadataWrites.values());
				await queuePersistedLiveTranscriptFinal(
					"assistant",
					"",
					activity.utterance,
				);
			}
		};
		const emitLiveActivityMessage = (
			activity: LiveAssistantActivity,
			message: ServerMessage,
		) => {
			if (
				message.type !== "tool_event" &&
				message.type !== "tool_result" &&
				message.type !== "tool_update" &&
				message.type !== "tool_activity_update" &&
				message.type !== "tool_progress_update"
			) {
				options.emit(message);
				return;
			}
			options.emit({
				...message,
				realtime_utterance_id: activity.utterance.utteranceId,
				realtime_session_id: realtimeSessionId,
				transcript_seq: activity.utterance.transcriptSeq,
				...(message.type === "tool_event" ? { fork_supported: false } : {}),
			});
		};
		const ownerForLiveActivity = (
			event: ProviderRealtimeActivity,
		): LiveAssistantActivity => {
			const existing = liveActivitiesByToolId.get(event.toolId);
			if (existing) return existing;
			const activity = liveAssistantActivity();
			liveActivitiesByToolId.set(event.toolId, activity);
			return activity;
		};
		const queueLiveActivityWork = (work: () => Promise<void>) => {
			const pending = this.realtimeTranscriptWriteTail.then(work);
			this.realtimeTranscriptWriteTail = pending.then(
				() => undefined,
				() => undefined,
			);
			void pending.catch((error) =>
				logDbError("process realtime tool activity", error),
			);
		};
		const publishActivity = (event: ProviderRealtimeActivity) => {
			const activity = ownerForLiveActivity(event);
			const emit = (message: ServerMessage) =>
				emitLiveActivityMessage(activity, message);
			switch (event.type) {
				case "tool_start":
					queueLiveActivityWork(() =>
						this.handleToolStart(
							event,
							activity.turn,
							options.sessionId,
							emit,
							options.provider,
						),
					);
					break;
				case "tool_update":
					this.handleToolUpdate(event, activity.turn, options.sessionId, emit);
					break;
				case "tool_activity_update":
					this.handleToolActivityUpdate(
						event,
						activity.turn,
						options.sessionId,
						emit,
					);
					break;
				case "tool_progress":
					this.handleToolProgress(event, activity.turn, emit);
					break;
				case "tool_result":
					queueLiveActivityWork(async () => {
						await this.handleToolResult(
							event,
							activity.turn,
							options.sessionId,
							emit,
							options.provider,
						);
						activity.completedToolIds.add(event.toolId);
					});
					break;
				case "generated_media":
					queueLiveActivityWork(async () => {
						await this.handleGeneratedMedia(
							event,
							activity.turn,
							options.sessionId,
							emit,
							options.provider,
						);
						activity.completedToolIds.add(event.toolId);
					});
					break;
			}
		};
		const settleActivities = async () => {
			for (const activity of liveActivitiesByUtterance.values()) {
				const emit = (message: ServerMessage) =>
					emitLiveActivityMessage(activity, message);
				this.settleIncompleteSubagents(activity.turn, options.sessionId, emit);
				for (const tool of activity.turn.pendingToolEvents) {
					if (activity.completedToolIds.has(tool.toolId)) continue;
					queueLiveActivityWork(async () => {
						await this.handleToolResult(
							{
								type: "tool_result",
								toolId: tool.toolId,
								content:
									"Raven Live ended before Codex reported this tool's result.",
								isError: true,
							},
							activity.turn,
							options.sessionId,
							emit,
							options.provider,
						);
						activity.completedToolIds.add(tool.toolId);
					});
				}
			}
		};
		const publishTranscriptDelta = (
			event: Extract<ProviderRealtimeEvent, { type: "transcript_delta" }>,
		) => {
			if (
				!event.delta ||
				(event.role !== "user" && event.role !== "assistant")
			) {
				return;
			}
			const utterance = utteranceFor(event.role);
			options.emit({
				type: "realtime_transcript",
				session_id: options.sessionId,
				...options.requestIdentity,
				mode: "live",
				role: event.role,
				text: event.delta,
				done: false,
				...transcriptMetadata(utterance),
			});
		};
		return {
			setProviderRealtimeSessionId: (sessionId) => {
				providerRealtimeSessionId = sessionId;
			},
			publishTranscriptDelta,
			queueTranscriptFinal,
			publishActivity,
			settleActivities,
			flushToolOnlyActivities,
		};
	}

	private createRealtimeTerminalLifecycle(options: {
		mode: ProviderRealtimeMode;
		sessionId: string;
		emit: (message: ServerMessage) => void;
		requestIdentity: RealtimeRequestIdentity;
		realtimeGeneration: number;
		agentSession: AgentSession;
		liveCoordination: LiveRealtimeCoordination | null;
	}): RealtimeTerminalLifecycle {
		let terminalPending = false;
		let terminalPublished = false;
		let terminalFailureMessage: string | null = null;
		let terminalFailureDeferredDuringStop = false;
		let terminalCompletion: Promise<void> | null = null;
		let deferredCloseReason: string | undefined;
		let terminalEmitter = options.emit;
		const beginTerminal = () => {
			if (
				terminalPending ||
				terminalPublished ||
				this.realtimeCloseNotifier !== publishClosed
			) {
				return false;
			}
			terminalPending = true;
			this.realtimeCloseNotifier = null;
			return true;
		};
		const retireAfterUnsolicitedTerminal = () => {
			// An explicit stop owns its wrapper through provider teardown. A provider
			// terminal has no outer cleanup, so retire before delayed events can leak.
			if (this.realtimeStopMode === options.mode) return;
			this.retireAgentSessionAfterRealtime(options.agentSession);
		};
		const finishTerminal = async (
			publish: () => void,
			clearRealtimeMode = true,
		) => {
			await this.drainRealtimeTranscriptWrites();
			await options.liveCoordination?.settleActivities();
			await this.drainRealtimeTranscriptWrites();
			await options.liveCoordination?.flushToolOnlyActivities();
			await this.drainRealtimeTranscriptWrites();
			if (
				terminalPublished ||
				(this.realtimeCloseNotifier !== null &&
					this.realtimeCloseNotifier !== publishClosed)
			) {
				return;
			}
			terminalPublished = true;
			if (terminalFailureMessage) {
				if (!terminalFailureDeferredDuringStop) {
					await this.stopRealtimeSession().catch(() => {});
				}
				terminalEmitter({
					type: "realtime_error",
					session_id: options.sessionId,
					...options.requestIdentity,
					mode: options.mode,
					message: terminalFailureMessage,
				});
				retireAfterUnsolicitedTerminal();
				return;
			}
			if (clearRealtimeMode) {
				this.realtimeMode = null;
				this.realtimeRequestId = null;
			}
			publish();
			retireAfterUnsolicitedTerminal();
		};
		const publishClosed: RealtimeCloseNotifier = (reason, emitOverride) => {
			if (reason) deferredCloseReason = reason;
			if (emitOverride) terminalEmitter = emitOverride;
			if (this.realtimeStoppingGeneration === options.realtimeGeneration) {
				return Promise.resolve();
			}
			if (terminalCompletion) return terminalCompletion;
			if (!beginTerminal()) return Promise.resolve();
			terminalCompletion = finishTerminal(() =>
				terminalEmitter({
					type: "realtime_state",
					session_id: options.sessionId,
					...options.requestIdentity,
					mode: options.mode,
					state: "closed",
					...(deferredCloseReason ? { reason: deferredCloseReason } : {}),
				}),
			);
			return terminalCompletion;
		};
		const publishError = (message: string): Promise<void> => {
			terminalFailureMessage = message;
			if (this.realtimeStoppingGeneration === options.realtimeGeneration) {
				terminalFailureDeferredDuringStop = true;
				return Promise.resolve();
			}
			if (terminalCompletion) return terminalCompletion;
			if (!beginTerminal()) return Promise.resolve();
			terminalCompletion = finishTerminal(() => {}, false);
			return terminalCompletion;
		};
		return {
			publishClosed,
			publishError,
			isFinishing: () => terminalPending || terminalPublished,
		};
	}

	private createRealtimeEventPublisher(options: {
		mode: ProviderRealtimeMode;
		sessionId: string;
		emit: (message: ServerMessage) => void;
		requestIdentity: RealtimeRequestIdentity;
		realtimeGeneration: number;
		agentSession: AgentSession;
		liveCoordination: LiveRealtimeCoordination | null;
		terminal: RealtimeTerminalLifecycle;
	}): (event: ProviderRealtimeEvent) => void {
		let audioOutputStarted = false;
		const speechMode = options.mode === "live" ? null : options.mode;
		return (event) => {
			if (
				this.realtimeGeneration !== options.realtimeGeneration ||
				this.realtimeAgentSession !== options.agentSession ||
				options.terminal.isFinishing()
			) {
				return;
			}
			switch (event.type) {
				case "started":
					options.liveCoordination?.setProviderRealtimeSessionId(
						event.realtimeSessionId,
					);
					options.emit({
						type: "realtime_state",
						session_id: options.sessionId,
						...options.requestIdentity,
						mode: options.mode,
						state: "connected",
					});
					break;
				case "sdp":
					options.emit({
						type: "realtime_sdp",
						session_id: options.sessionId,
						...options.requestIdentity,
						mode: options.mode,
						sdp: event.sdp,
					});
					break;
				case "audio_output_started":
					if (audioOutputStarted) break;
					audioOutputStarted = true;
					options.emit({
						type: "realtime_audio",
						session_id: options.sessionId,
						...options.requestIdentity,
						mode: options.mode,
						state: "started",
					});
					break;
				case "transcript_delta":
					if (options.liveCoordination) {
						options.liveCoordination.publishTranscriptDelta(event);
					} else if (event.delta && speechMode) {
						options.emit({
							type: "realtime_transcript",
							session_id: options.sessionId,
							...options.requestIdentity,
							mode: speechMode,
							role: event.role,
							text: event.delta,
							done: false,
						});
					}
					break;
				case "transcript_done":
					if (options.liveCoordination) {
						options.liveCoordination.queueTranscriptFinal(event);
					} else if (speechMode) {
						options.emit({
							type: "realtime_transcript",
							session_id: options.sessionId,
							...options.requestIdentity,
							mode: speechMode,
							role: event.role,
							text: event.text,
							done: true,
						});
					}
					break;
				case "activity":
					options.liveCoordination?.publishActivity(event.event);
					break;
				case "error":
					void options.terminal.publishError(event.message);
					break;
				case "closed":
					void options.terminal.publishClosed(event.reason);
					break;
			}
		};
	}

	private async startPreparedRealtimeSession(options: {
		control: RealtimeStartControl;
		options: RealtimeControlOptions;
		prepared: PreparedRealtimeStart;
		realtimeGeneration: number;
		requestIdentity: RealtimeRequestIdentity;
		publish: (event: ProviderRealtimeEvent) => void;
		publishClosed: RealtimeCloseNotifier;
	}): Promise<void> {
		const {
			control,
			options: controlOptions,
			prepared,
			realtimeGeneration,
			requestIdentity,
			publish,
			publishClosed,
		} = options;
		controlOptions.emit({
			type: "realtime_state",
			session_id: controlOptions.sessionId,
			...requestIdentity,
			mode: control.mode,
			state: "starting",
		});
		this.realtimeMode = control.mode;
		this.realtimeCloseNotifier = publishClosed;
		let result: ProviderRealtimeStartResult;
		try {
			result = await prepared.startRealtime.call(prepared.agentSession, {
				mode: control.mode,
				sdp: control.sdp,
				voice: control.voice,
				onEvent: publish,
			});
		} catch (error) {
			// A user can stop Dictate while its isolated Codex process is still
			// starting. That deliberately kills the startup transport, which rejects
			// the original start promise with "Codex dictation stopped". The stop
			// path already owns the terminal closed state, so do not turn an explicit
			// stop into a visible startup failure.
			const stoppedDuringStartup =
				this.realtimeStopMode === control.mode ||
				(this.realtimeGeneration !== realtimeGeneration &&
					this.realtimeMode !== control.mode);
			if (stoppedDuringStartup) {
				await this.realtimeStopPromise?.catch(() => {});
				return;
			}
			if (
				this.realtimeGeneration === realtimeGeneration &&
				this.realtimeCloseNotifier === publishClosed
			) {
				this.realtimeGeneration += 1;
				this.realtimeCloseNotifier = null;
				this.realtimeMode = null;
				this.realtimeRequestId = null;
				this.retireAgentSessionAfterRealtime(prepared.agentSession);
			}
			throw error;
		}
		// Speech runs on a transient realtime thread. Its result must never replace
		// the Raven chat thread that the next ordinary turn will resume.
		const accepted =
			control.mode === "live"
				? await this.persistProviderSession(
						controlOptions.sessionId,
						prepared.provider.providerId,
						result.providerSessionId,
						prepared.ownershipGeneration,
					)
				: this.providerOwnershipGeneration === prepared.ownershipGeneration;
		if (!accepted) {
			await this.stopRealtimeSession().catch(() => {});
			throw new Error(
				"The provider changed while realtime startup was in progress.",
			);
		}
		if (control.mode === "live") {
			this.providerSessionId = result.providerSessionId;
			this.providerSessionProviderId = prepared.provider.providerId;
		}
	}

	private retireAgentSessionAfterRealtime(
		agentSession: AgentSession | null,
	): void {
		if (!agentSession) return;
		if (this.realtimeAgentSession === agentSession) {
			this.realtimeAgentSession = null;
		}
		if (this.agentSession !== agentSession) {
			agentSession.cancel();
			return;
		}
		// Realtime wrappers capture request-local callbacks and can also retain
		// provider events after their transport closes. Detaching the wrapper keeps
		// those callbacks and queues out of the next typed turn. providerSessionId
		// remains intact, so that turn cold-resumes through a fresh wrapper.
		this.stopBackgroundActivityObserver();
		agentSession.cancel();
		this.agentSession = null;
		this.agentSessionKey = null;
	}

	private stopRealtimeSession(
		reason?: string,
		emitTerminal?: (message: ServerMessage) => void,
	): Promise<void> {
		if (this.realtimeStopPromise) return this.realtimeStopPromise;
		const stoppingMode = this.realtimeMode;
		if (!stoppingMode) return Promise.resolve();
		const stoppingGeneration = this.realtimeGeneration;
		const agentSession = this.realtimeAgentSession;
		const closeNotifier = this.realtimeCloseNotifier;
		this.realtimeStopMode = stoppingMode;
		this.realtimeStoppingGeneration = stoppingGeneration;
		const stopping = (async () => {
			try {
				await agentSession?.stopRealtime?.();
			} finally {
				await this.drainRealtimeTranscriptWrites();
				const ownsStoppingGeneration =
					this.realtimeStoppingGeneration === stoppingGeneration;
				if (ownsStoppingGeneration) {
					this.realtimeStoppingGeneration = null;
					if (this.realtimeGeneration === stoppingGeneration) {
						this.realtimeGeneration += 1;
					}
					await closeNotifier?.(reason, emitTerminal);
				}
				if (
					ownsStoppingGeneration &&
					this.realtimeAgentSession === agentSession &&
					this.realtimeStopMode === stoppingMode
				) {
					this.realtimeCloseNotifier = null;
					this.realtimeMode = null;
					this.realtimeRequestId = null;
					this.realtimeStopMode = null;
					this.retireAgentSessionAfterRealtime(agentSession);
				}
			}
		})();
		this.realtimeStopPromise = stopping;
		const clearStopping = () => {
			if (this.realtimeStopPromise === stopping) {
				this.realtimeStopPromise = null;
			}
		};
		void stopping.then(clearStopping, clearStopping);
		return stopping;
	}

	private settleProviderContinuationReady(
		job: ProviderContinuationJob,
		ready: boolean,
	): void {
		if (job.readySettled) return;
		job.readySettled = true;
		job.resolveReady(ready);
	}

	private detachProviderContinuationDialogSignal(
		job: ProviderContinuationJob,
	): void {
		if (!job.dialogAbortHandler) return;
		job.trigger.signal?.removeEventListener("abort", job.dialogAbortHandler);
		job.dialogAbortHandler = undefined;
	}

	private cancelProviderContinuationBeforeOrigin(
		job: ProviderContinuationJob,
	): void {
		if (job.peerOriginObserved) return;
		job.abortController.abort();
		this.detachProviderContinuationDialogSignal(job);
		const queuedIndex = this.providerContinuationQueue.indexOf(job);
		if (queuedIndex >= 0) this.providerContinuationQueue.splice(queuedIndex, 1);
		this.settleProviderContinuationReady(job, false);
		if (
			this.currentProviderContinuation === job &&
			job.consumerAttached &&
			this.agentSessionKey === job.expectedSessionKey &&
			this.agentSession
		) {
			this.stopBackgroundActivityObserver();
			this.agentSession.cancel();
			this.agentSession = null;
			this.agentSessionKey = null;
		}
	}

	private cancelQueuedProviderContinuations(): void {
		const queued = this.providerContinuationQueue.splice(0);
		for (const job of queued) {
			job.abortController.abort();
			this.detachProviderContinuationDialogSignal(job);
			this.settleProviderContinuationReady(job, false);
		}
	}

	private queueProviderInitiatedTurn(options: {
		trigger: ProviderInitiatedTurn;
		sessionId: string;
		emit: (msg: ServerMessage) => void;
		provider: AgentProvider;
		agentSettings: AgentSettings | undefined;
		ownershipGeneration: number;
		expectedSessionKey: string;
	}): Promise<boolean> {
		const duplicate = [
			...(this.currentProviderContinuation
				? [this.currentProviderContinuation]
				: []),
			...this.providerContinuationQueue,
		].find(
			(job) => job.trigger.interactionId === options.trigger.interactionId,
		);
		if (duplicate) return duplicate.ready;
		if (
			!this.claudePeerInbox ||
			this.suspendingForRestart ||
			this.currentSessionId !== options.sessionId ||
			this.providerOwnershipGeneration !== options.ownershipGeneration ||
			this.agentSessionKey !== options.expectedSessionKey ||
			this.agentSession === null
		) {
			return Promise.resolve(false);
		}
		let resolveReady!: (ready: boolean) => void;
		const ready = new Promise<boolean>((resolve) => {
			resolveReady = resolve;
		});
		const job: ProviderContinuationJob = {
			...options,
			peerOriginObserved: false,
			consumerAttached: false,
			abortController: new AbortController(),
			ready,
			readySettled: false,
			resolveReady,
		};
		this.providerContinuationQueue.push(job);
		if (job.trigger.signal) {
			job.dialogAbortHandler = () =>
				this.cancelProviderContinuationBeforeOrigin(job);
			job.trigger.signal.addEventListener("abort", job.dialogAbortHandler, {
				once: true,
			});
			if (job.trigger.signal.aborted) {
				this.cancelProviderContinuationBeforeOrigin(job);
				return ready;
			}
		}
		void this.drainTurnQueue();
		return ready;
	}

	private async runProviderContinuation(
		job: ProviderContinuationJob,
	): Promise<void> {
		const agentSession = this.agentSession;
		if (
			!agentSession ||
			this.agentSessionKey !== job.expectedSessionKey ||
			this.currentSessionId !== job.sessionId ||
			this.providerOwnershipGeneration !== job.ownershipGeneration
		) {
			this.settleProviderContinuationReady(job, false);
			return;
		}
		this.currentProviderContinuation = job;
		this.currentTurnId = undefined;
		const turn = createTurnState(
			this.selectedModelFor(job.agentSettings),
			job.ownershipGeneration,
		);
		this.currentTurnState = turn;
		this.currentTurnPermissionMode = "default";
		this.currentDelegationHandoff = null;
		const drainSignal = this.abortController?.signal;
		const expectedStop = () =>
			drainSignal?.aborted === true ||
			job.abortController.signal.aborted ||
			this.suspendingForRestart ||
			this.agentSession !== agentSession ||
			this.agentSessionKey !== job.expectedSessionKey;
		this.emitRunningStatus(job.emit);
		try {
			if (
				(await this.gateOnUsage(
					job.provider,
					job.emit,
					job.abortController.signal,
				)) === "aborted"
			) {
				this.settleProviderContinuationReady(job, false);
				return;
			}
			if (
				job.abortController.signal.aborted ||
				!this.claudePeerInbox ||
				this.agentSession !== agentSession ||
				this.agentSessionKey !== job.expectedSessionKey ||
				this.currentSessionId !== job.sessionId
			) {
				this.settleProviderContinuationReady(job, false);
				return;
			}
			await agentSession.setPermissionMode?.("default");
			if (
				job.abortController.signal.aborted ||
				!this.claudePeerInbox ||
				this.agentSession !== agentSession ||
				this.agentSessionKey !== job.expectedSessionKey
			) {
				this.settleProviderContinuationReady(job, false);
				return;
			}
			const iteration = this.iterateConversation(
				agentSession,
				job.sessionId,
				job.emit,
				turn,
				job.provider,
			);
			job.consumerAttached = true;
			// iterateConversation reaches the provider iterator's first next() before
			// returning this promise, so releasing the dialog after this point cannot
			// race a queued human turn for ownership of the peer response.
			this.settleProviderContinuationReady(job, true);
			await iteration;
			if (!turn.queryRecorded) {
				if (expectedStop()) return;
				throw new Error(
					"Claude peer continuation ended before a turn boundary",
				);
			}
			if (!turn.terminalFailure) {
				this.scheduleTurnRecap({
					turn,
					sessionId: job.sessionId,
					userMessage: "Approved Claude peer message",
					emit: job.emit,
					provider: job.provider,
					agentSettings: job.agentSettings,
				});
			}
		} catch (error) {
			this.settleProviderContinuationReady(job, false);
			if (!expectedStop()) {
				this.state = "error";
				const message =
					error instanceof Error
						? error.message
						: "Claude peer continuation failed";
				void db.appendLog("error", "session", "peer continuation error", {
					message,
					name: error instanceof Error ? error.name : undefined,
					stack:
						error instanceof Error ? error.stack?.slice(0, 500) : undefined,
				});
				job.emit({ type: "error", message, turn_scoped: true });
				this.stopBackgroundActivityObserver();
				agentSession.cancel();
				if (this.agentSession === agentSession) {
					this.agentSession = null;
					this.agentSessionKey = null;
				}
			}
		} finally {
			let incompleteAssistantSeq: number | null = null;
			if (
				job.peerOriginObserved &&
				(turn.reservedAssistantSeq !== null || turn.assistantText)
			) {
				try {
					const assistantSeq = await this.persistAssistantMessage(
						job.sessionId,
						turn,
					);
					incompleteAssistantSeq = assistantSeq;
					await this.persistPendingToolEvents(
						job.sessionId,
						assistantSeq,
						turn,
						"peer continuation",
						job.provider.providerId,
					);
				} catch (error) {
					logDbError("appendMessage (peer continuation)", error);
				}
			}
			if (job.peerOriginObserved && !turn.queryRecorded) {
				await this.persistIncompleteQuery(
					job.sessionId,
					turn,
					job.provider,
					incompleteAssistantSeq,
				).catch((error) =>
					logDbError("recordQuery (peer continuation)", error),
				);
			}
			if (this.agentSession === agentSession) {
				for (;;) {
					const permissionModeGeneration = this.permissionModeGeneration;
					const restorePermissionMode = this.desiredPermissionMode();
					try {
						await agentSession.setPermissionMode?.(restorePermissionMode);
					} catch (error) {
						if (
							this.agentSession === agentSession &&
							(permissionModeGeneration !== this.permissionModeGeneration ||
								restorePermissionMode !== this.desiredPermissionMode())
						) {
							// A newer picker change won while the older native restore was in
							// flight. Apply that latest desired value before deciding whether the
							// native default is an authoritative rejection.
							continue;
						}
						if (restorePermissionMode !== "default") {
							if (this.currentTurnState === turn) {
								this.currentTurnState = null;
								this.currentTurnPermissionMode = null;
								this.currentDelegationHandoff = null;
							}
							if (this.currentProviderContinuation === job) {
								this.currentProviderContinuation = null;
							}
							const rejection =
								error instanceof ProviderPermissionModeRejectedError
									? error
									: new ProviderPermissionModeRejectedError(
											restorePermissionMode,
											"default",
											error instanceof Error ? error.message : String(error),
										);
							await this.reconcilePreInputPermissionRejection({
								sourceSession: agentSession,
								sessionId: job.sessionId,
								provider: job.provider,
								ownershipGeneration: job.ownershipGeneration,
								rejection,
								emit: job.emit,
							});
						} else {
							logDbError("restore permission mode after peer", error);
						}
						break;
					}
					if (
						this.agentSession !== agentSession ||
						permissionModeGeneration === this.permissionModeGeneration
					) {
						break;
					}
				}
			}
			if (this.currentTurnState === turn) {
				this.currentTurnState = null;
				this.currentTurnPermissionMode = null;
				this.currentDelegationHandoff = null;
			}
			if (this.currentProviderContinuation === job) {
				this.currentProviderContinuation = null;
			}
			this.detachProviderContinuationDialogSignal(job);
			this.settleProviderContinuationReady(job, false);
		}
	}

	private runGoalContinuation(options: {
		agentSession: AgentSession;
		sessionId: string;
		emit: (msg: ServerMessage) => void;
		provider: AgentProvider;
		agentSettings: AgentSettings | undefined;
		ownershipGeneration: number;
		objective: string;
	}): void {
		const {
			agentSession,
			sessionId,
			emit,
			provider,
			agentSettings,
			ownershipGeneration,
			objective,
		} = options;
		const turn = createTurnState(
			this.selectedModelFor(agentSettings),
			ownershipGeneration,
		);
		void (async () => {
			try {
				await this.iterateConversation(
					agentSession,
					sessionId,
					emit,
					turn,
					provider,
				);
				if (!turn.terminalFailure) {
					this.scheduleTurnRecap({
						turn,
						sessionId,
						userMessage: objective,
						emit,
						provider,
						agentSettings,
					});
				}
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
				emit({ type: "error", message, turn_scoped: true });
				this.stopBackgroundActivityObserver();
				this.agentSession?.cancel();
				this.agentSession = null;
				this.agentSessionKey = null;
				this.restartAgentSessionForEffort = false;
			} finally {
				if (turn.reservedAssistantSeq !== null || turn.assistantText) {
					try {
						const assistantSeq = await this.persistAssistantMessage(
							sessionId,
							turn,
						);
						await this.persistPendingToolEvents(
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
			permission_mode: this.statusPermissionMode(),
			...this.approvalsReviewerStatusField(),
			effort: this.effort,
		});
	}

	isRunning(): boolean {
		return this.state === "running";
	}

	/** Live is provider work even though it does not use the ordinary turn queue. */
	// fallow-ignore-next-line unused-class-member -- Read by dbRoutes before allowing a session fork.
	hasActiveRealtime(): boolean {
		return this.realtimeMode !== null || this.realtimeStopPromise !== null;
	}

	private assertRealtimeIdle(action: string): void {
		if (this.realtimeMode === "live" || this.realtimeStopMode === "live") {
			throw new Error(`Stop Raven Live before ${action}.`);
		}
	}

	private async drainRealtimeTranscriptWrites(): Promise<void> {
		for (;;) {
			const pending = this.realtimeTranscriptWriteTail;
			await pending.catch(() => {});
			if (pending === this.realtimeTranscriptWriteTail) return;
		}
	}

	private tearDownNativeSessionState(): void {
		this.cancelQueuedProviderContinuations();
		if (this.currentProviderContinuation) {
			this.currentProviderContinuation.abortController.abort();
			this.detachProviderContinuationDialogSignal(
				this.currentProviderContinuation,
			);
			this.settleProviderContinuationReady(
				this.currentProviderContinuation,
				false,
			);
		}
		this.abortController?.abort();
		// Tear down long-lived provider wrappers so the next query rebuilds its
		// event stream instead of retaining request-local callbacks.
		this.stopBackgroundActivityObserver();
		if (
			this.realtimeAgentSession &&
			this.realtimeAgentSession !== this.agentSession
		) {
			this.realtimeAgentSession.cancel();
		}
		this.realtimeAgentSession = null;
		this.agentSession?.cancel();
		this.agentSession = null;
		this.agentSessionKey = null;
		this.realtimeMode = null;
		this.realtimeRequestId = null;
		this.realtimeCloseNotifier = null;
		this.realtimeStopPromise = null;
		this.realtimeStopMode = null;
		this.realtimeStoppingGeneration = null;
		this.resetEffectiveApprovalsReviewer();
	}

	abort(): void {
		this.realtimeGeneration += 1;
		this.unregisterUmbodApprovalSession?.();
		this.unregisterUmbodApprovalSession = null;
		this.permissions.clearAll();
		this.cancelAllAskUserQuestions();
		this.planModeManager.clearAll();
		this.currentDelegationHandoff = null;
		// Explicit abort cancels durable work too. A process restart uses
		// suspendForRestart() instead so pre-dispatch turns remain recoverable.
		const durableIds = [
			...(this.currentTurnId &&
			this.currentTurnArgs &&
			isDurableInteractiveTurn(this.currentTurnArgs)
				? [this.currentTurnId]
				: []),
			...this.turnQueue
				.pendingTurns()
				.filter((turn) => isDurableInteractiveTurn(turn.args))
				.flatMap((turn) => (turn.turnId ? [turn.turnId] : [])),
		];
		for (const id of durableIds) this.cancelledDurableTurns.add(id);
		for (const id of durableIds) this.durableTurns.delete(id);
		void db
			.deletePendingSessionTurns(durableIds)
			.catch((error) => logDbError("cancel pending turns", error));
		this.turnQueue.resolveAll();
		this.tearDownNativeSessionState();
		this.restartAgentSessionForEffort = false;
	}

	/** Stop native processes while retaining every pre-dispatch durable turn. */
	suspendForRestart(): void {
		this.realtimeGeneration += 1;
		this.suspendingForRestart = true;
		this.unregisterUmbodApprovalSession?.();
		this.unregisterUmbodApprovalSession = null;
		this.permissions.clearAll();
		this.cancelAllAskUserQuestions();
		this.planModeManager.clearAll();
		this.tearDownNativeSessionState();
	}

	/** Stop native processes and await transports that expose owned cleanup. */
	async suspendForRestartAndWait(): Promise<void> {
		const sessions = [this.agentSession, this.realtimeAgentSession].filter(
			(session, index, all) => session && all.indexOf(session) === index,
		);
		this.suspendForRestart();
		await Promise.all(
			sessions.map(
				(session) => session?.cancelAndWait?.() ?? Promise.resolve(),
			),
		);
	}

	/**
	 * Tear down provider-native state when a runtime integration disappears.
	 * The Hlid transcript remains intact and the next turn hands it to the
	 * configured fallback provider instead of talking to a stopped sidecar.
	 */
	async retireProviderSessions(
		providerIds: ReadonlySet<string>,
		options?: { preserveSelection?: boolean },
	): Promise<boolean> {
		const retiredSessions = new Set<AgentSession>();
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
		const retiresRealtimeSession = Boolean(
			this.realtimeAgentSession && providerIds.has("codex"),
		);
		if (
			!retiresActiveSession &&
			!retiresResumeSession &&
			!retiresOverride &&
			!retiresRealtimeSession
		) {
			return false;
		}

		if (retiresRealtimeSession) {
			this.realtimeGeneration += 1;
			if (this.realtimeAgentSession) {
				retiredSessions.add(this.realtimeAgentSession);
			}
			this.realtimeAgentSession = null;
			this.realtimeMode = null;
			this.realtimeRequestId = null;
			this.realtimeCloseNotifier = null;
			this.realtimeStopPromise = null;
			this.realtimeStopMode = null;
			this.realtimeStoppingGeneration = null;
		}
		if (retiresActiveSession) {
			this.stopBackgroundActivityObserver();
			if (this.agentSession) retiredSessions.add(this.agentSession);
			this.agentSession = null;
			this.agentSessionKey = null;
			this.restartAgentSessionForEffort = false;
		}
		if (retiresResumeSession) {
			this.providerOwnershipGeneration += 1;
			this.providerSessionId = null;
			this.providerSessionProviderId = null;
			this.historyResumeMode = "none";
			this.providerHandoffPending =
				this.currentSessionId !== null && this.messageSeq > 0;
			this.resetEffectiveApprovalsReviewer();
		}
		if (retiresOverride && !options?.preserveSelection) {
			this.providerOverride = null;
			this.modelOverride = null;
			this.effortOverride = null;
			this.serviceTierOverride = null;
			this.permissionModeOverride = null;
			this.approvalsReviewerOverride = null;
			this.approvalsReviewer = this.defaultApprovalsReviewer();
			this.resetEffectiveApprovalsReviewer();
		}
		await Promise.all(
			[...retiredSessions].map(async (session) => {
				if (session.cancelAndWait) {
					await session.cancelAndWait();
					return;
				}
				session.cancel();
			}),
		);
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

	async handleAskUserQuestionResponse(
		id: string,
		answers: AskUserQuestionAnswers,
		notes?: AskUserQuestionNotes,
	): Promise<boolean> {
		if (
			!this.askUserQuestions.has(id) ||
			this.askUserQuestionResponsesInFlight.has(id)
		) {
			return false;
		}
		this.askUserQuestionResponsesInFlight.add(id);
		const persistence = this.askUserQuestionPersistence.get(id);
		try {
			if (persistence) {
				await persistence.pending;
			}
			if (!this.askUserQuestions.has(id)) return false;
			if (persistence?.sessionId) {
				await db.setAskUserQuestionResolution(
					persistence.sessionId,
					id,
					JSON.stringify(answers),
					notes !== undefined ? JSON.stringify(notes) : null,
				);
				if (!this.askUserQuestions.has(id)) {
					await db.setAskUserQuestionResolution(
						persistence.sessionId,
						id,
						JSON.stringify({ [ASK_USER_QUESTION_CANCEL_KEY]: [] }),
						null,
					);
					return false;
				}
			}
			this.askUserQuestions.complete(id, answers, notes);
			this.askUserQuestionPersistence.delete(id);
			return true;
		} catch (error) {
			if (this.askUserQuestions.has(id)) {
				this.askUserQuestions.complete(id, {
					[ASK_USER_QUESTION_CANCEL_KEY]: [],
				});
				if (persistence) {
					this.emitAskUserQuestionCancellation(
						persistence.request,
						persistence.sessionId,
						persistence.emit,
					);
				}
			}
			this.askUserQuestionPersistence.delete(id);
			throw error;
		} finally {
			this.askUserQuestionResponsesInFlight.delete(id);
		}
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

	private async restoreSessionContext(
		sessionId: string,
		updateGlobalFocus = true,
	): Promise<boolean> {
		// Snapshot control ownership before any asynchronous reads. An incompatible
		// import must fail without changing the currently open manager or stopping
		// its provider observer.
		const expectedSessionControlGeneration = this.sessionControlGeneration;
		const expectedProviderOwnershipGeneration =
			this.providerOwnershipGeneration;
		const restorePermissionModeGeneration = this.permissionModeGeneration;
		const restorePermissionModeControlGeneration =
			this.permissionModeControlGeneration;
		const restoreModelGeneration = this.modelGeneration;
		const [
			savedSession,
			prior,
			nextMessageSeq,
			savedAgentCwd,
			savedModel,
			savedProviderId,
			savedProviderSessionId,
			savedProviderRuntimeIdentity,
			savedBackgroundActivities,
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
			db.getSessionProviderRuntimeIdentity(sessionId),
			db.listProviderBackgroundActivities(sessionId),
		]);
		if (
			this.sessionControlGeneration !== expectedSessionControlGeneration ||
			this.providerOwnershipGeneration !==
				expectedProviderOwnershipGeneration ||
			this.permissionModeGeneration !== restorePermissionModeGeneration ||
			this.modelGeneration !== restoreModelGeneration ||
			this.permissionModeControlGeneration !==
				restorePermissionModeControlGeneration
		) {
			throw new PermissionModeChangeSupersededError();
		}
		if (
			savedSession?.history_imported &&
			(savedSession.history_resume_mode ?? "none") === "none"
		) {
			throw new Error(
				"This imported provider history has accounting data only and cannot be resumed.",
			);
		}
		const restoredProviderId =
			savedProviderId ??
			this.resolveProvider(savedAgentCwd ?? undefined).providerId;
		const restoredProviderRuntimeIdentity =
			this.providers.get(restoredProviderId)?.sessionContinuityIdentity ?? null;
		const incompatibleAcpRuntime =
			restoredProviderId.startsWith("acp:") &&
			savedProviderSessionId !== null &&
			(savedProviderRuntimeIdentity === null ||
				savedProviderRuntimeIdentity !== restoredProviderRuntimeIdentity);
		if (savedSession?.history_imported && incompatibleAcpRuntime) {
			throw new Error(
				"This provider-native import belongs to a different ACP executable or storage context. Restore that context or import the provider session again.",
			);
		}

		// Compatibility is established. Claim the restore before stopping the old
		// observer so queued writes from its provider generation cannot cross the
		// session boundary.
		const restoreGeneration = ++this.sessionControlGeneration;
		this.providerOwnershipGeneration += 1;
		const restoreProviderOwnershipGeneration = this.providerOwnershipGeneration;
		this.stopBackgroundActivityObserver();
		await this.backgroundActivityWriteTail;
		if (
			this.sessionControlGeneration !== restoreGeneration ||
			this.providerOwnershipGeneration !== restoreProviderOwnershipGeneration ||
			this.permissionModeGeneration !== restorePermissionModeGeneration ||
			this.modelGeneration !== restoreModelGeneration ||
			this.permissionModeControlGeneration !==
				restorePermissionModeControlGeneration
		) {
			throw new PermissionModeChangeSupersededError();
		}
		if (this.currentSessionId !== sessionId) {
			this.providerHistoryWarningIds.clear();
			this.effectivePermissionMode = null;
		}
		this.resetEffectiveApprovalsReviewer();
		this.clearSessionProvenance();
		this.agentCwd = undefined;
		this.agentMode = "cwd";
		this.sessionAllowedTools.clear();
		// The persisted max accounts for sequence values consumed by messages,
		// tools, plans, questions, and linked attachments. The one-row existence
		// sample is a defensive floor for older or partially migrated databases.
		this.messageSeq = Math.max(nextMessageSeq, prior.length);
		this.currentSessionId = sessionId;
		this.replaceBackgroundActivities(savedBackgroundActivities, false);
		this.currentSessionLabel = savedSession?.label ?? null;
		this.currentSessionPinned = savedSession?.pinned === 1;
		this.currentForkParentSessionId =
			savedSession?.fork_parent_session_id ?? null;
		this.currentForkParentLabel = savedSession?.fork_parent_label ?? null;
		this.currentForkKind = savedSession?.fork_kind ?? null;
		this.currentDelegationParentSessionId =
			savedSession?.delegation_parent_session_id ?? null;
		this.currentDelegationParentLabel =
			savedSession?.delegation_parent_label ?? null;
		this.currentDelegationParentTurnId =
			savedSession?.delegation_parent_turn_id ?? null;
		this.currentDelegationDepth = savedSession?.delegation_depth ?? null;
		this.providerSessionId = savedProviderSessionId;
		this.providerSessionProviderId = savedProviderId;
		this.historyResumeMode = savedSession?.history_resume_mode ?? "none";
		// Detached provider changes persist the selected provider without reviving a
		// runtime. If that change retired the previous native thread, the next live
		// manager must hand the existing Hlid transcript to the fresh provider.
		this.providerHandoffPending =
			prior.length > 0 && savedProviderSessionId === null;
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
		if (incompatibleAcpRuntime) {
			this.providerSessionId = null;
			this.providerSessionProviderId = restoredProviderId;
			this.historyResumeMode = "none";
			this.providerHandoffPending = prior.length > 0;
		}
		const savedModelExcluded =
			savedModel !== null &&
			!openCodeModelVisible(
				restoredProviderId,
				savedModel,
				this.openCodeModelFilter,
			);
		const restoredSavedModel = savedModelExcluded ? "" : savedModel;
		// Resume with the chat's saved selection, not today's configured
		// vault/Einherjar model.
		if (restoredSavedModel !== null && this.modelOverride === null) {
			this.model = restoredSavedModel;
			this.modelOverride = {
				value: restoredSavedModel === "" ? undefined : restoredSavedModel,
			};
		}
		if (
			!savedModelExcluded &&
			savedSession?.selected_effort &&
			this.effortOverride === null
		) {
			this.effort = savedSession.selected_effort;
			this.effortOverride = savedSession.selected_effort;
		}
		if (incompatibleAcpRuntime || savedModelExcluded) {
			const ownsRestore = () =>
				this.sessionControlGeneration === restoreGeneration &&
				this.currentSessionId === sessionId &&
				this.providerOwnershipGeneration === restoreProviderOwnershipGeneration;
			try {
				if (savedModelExcluded) {
					await db.setSessionModel(sessionId, "", { guard: ownsRestore });
					await db.setSessionEffort(sessionId, null, { guard: ownsRestore });
				}
				if (incompatibleAcpRuntime && ownsRestore()) {
					await db.setSessionProviderSession(
						sessionId,
						restoredProviderId,
						null,
					);
				}
			} catch (error) {
				logDbError("reset incompatible restored ACP session", error);
			}
			if (!ownsRestore()) throw new PermissionModeChangeSupersededError();
		}
		if (
			savedSession?.selected_permission_mode &&
			KNOWN_PERMISSION_MODES.has(savedSession.selected_permission_mode) &&
			this.permissionModeOverride === null
		) {
			const savedPermissionMode =
				savedSession.selected_permission_mode as PermissionMode;
			let mustNarrowPermissionMode =
				(this.policyEnforced &&
					(savedPermissionMode === "auto" ||
						savedPermissionMode === "dontAsk")) ||
				(this.usageGateEnforced && savedPermissionMode === "auto");
			if (
				(savedPermissionMode === "auto" || savedPermissionMode === "dontAsk") &&
				!mustNarrowPermissionMode
			) {
				// Advanced modes are direct-Claude session state. Fail closed when the
				// persisted provider is absent or no longer exposes that exact mode;
				// falling back to today's vault provider could widen an archived session.
				const restoredProvider = savedProviderId
					? this.providers.get(savedProviderId)
					: undefined;
				if (!restoredProvider) {
					mustNarrowPermissionMode = true;
				} else {
					try {
						await validateProviderPermissionMode(
							restoredProvider,
							savedPermissionMode,
							this.permissionModeValidationContext(
								restoredSavedModel ?? "",
								savedPermissionMode === "auto",
							),
						);
					} catch {
						mustNarrowPermissionMode = true;
					}
				}
				if (
					this.sessionControlGeneration !== restoreGeneration ||
					this.currentSessionId !== sessionId
				) {
					throw new PermissionModeChangeSupersededError();
				}
			}
			const stillOwnsPermissionRestore =
				this.providerOwnershipGeneration ===
					restoreProviderOwnershipGeneration &&
				this.permissionModeGeneration === restorePermissionModeGeneration &&
				this.modelGeneration === restoreModelGeneration &&
				this.permissionModeControlGeneration ===
					restorePermissionModeControlGeneration &&
				this.permissionModeOverride === null;
			if (stillOwnsPermissionRestore) {
				const restoredPermissionMode = mustNarrowPermissionMode
					? "default"
					: savedPermissionMode;
				this.permissionMode = restoredPermissionMode;
				this.permissionModeOverride = restoredPermissionMode;
			}
			if (mustNarrowPermissionMode && stillOwnsPermissionRestore) {
				const restoreSessionControlGeneration = this.sessionControlGeneration;
				const restoreProviderOwnershipGeneration =
					this.providerOwnershipGeneration;
				const ownsRestore = () =>
					this.currentSessionId === sessionId &&
					this.sessionControlGeneration === restoreSessionControlGeneration &&
					this.providerOwnershipGeneration ===
						restoreProviderOwnershipGeneration &&
					this.desiredPermissionMode() === "default";
				let persistenceFailed = false;
				try {
					const committed = await this.enqueueProviderOwnershipWrite(() =>
						db.setSessionPermissionMode(sessionId, "default", {
							guard: ownsRestore,
						}),
					);
					if (!committed && ownsRestore()) persistenceFailed = true;
				} catch (error) {
					persistenceFailed = ownsRestore();
					logDbError("narrow restored provider permission mode", error);
				}
				if (persistenceFailed) {
					const restoredProvider =
						(savedProviderId
							? this.providers.get(savedProviderId)
							: undefined) ?? this.resolveProvider(this.agentCwd);
					this.schedulePermissionModePersistenceRepair({
						sessionId,
						providerId: restoredProvider.providerId,
						providerOwnershipGeneration: restoreProviderOwnershipGeneration,
						sessionControlGeneration: restoreSessionControlGeneration,
						permissionModeControlGeneration:
							this.permissionModeControlGeneration,
						mode: "default",
					});
				}
			}
		}
		if (this.approvalsReviewerOverride === null) {
			const restoredProvider =
				(savedProviderId ? this.providers.get(savedProviderId) : undefined) ??
				this.resolveProvider(this.agentCwd);
			const savedReviewer = savedSession?.selected_approvals_reviewer;
			const reviewer = this.supportedApprovalsReviewer(
				restoredProvider,
				savedReviewer,
			)
				? savedReviewer
				: this.defaultApprovalsReviewer(restoredProvider);
			this.approvalsReviewer = reviewer;
			this.approvalsReviewerOverride = this.approvalsReviewer;
		}
		this.resetEffectiveApprovalsReviewer();
		if (updateGlobalFocus) {
			db.setCurrentSessionId(sessionId).catch((e) =>
				logDbError("setCurrentSessionId", e),
			);
		}
		return Boolean(savedSession);
	}

	/**
	 * Restore a claimed archived chat before WebSocket first-chat controls are
	 * validated. This lets policy and exact Claude Auto checks narrow stale saved
	 * selections before Raven receives an authoritative rejection/status.
	 */
	// fallow-ignore-next-line unused-class-member -- Called by first-chat WebSocket dispatch in wsHandlers.
	async prepareSessionControlsForChat(sessionId: string): Promise<{
		restored: boolean;
		permissionModeNarrowing?: {
			attempted: PermissionMode;
			authoritative: PermissionMode;
			providerId: string;
			model: string;
		};
	}> {
		if (this.currentSessionId === sessionId) return { restored: true };
		const savedSession = await db.getSessionById(sessionId);
		if (!savedSession) return { restored: false };
		const priorSelection = await db.getSessionSelection(sessionId);
		const restored = await this.restoreSessionContext(sessionId, false);
		const attempted = priorSelection?.permissionMode;
		const authoritative = this.statusPermissionMode();
		return {
			restored,
			...(attempted &&
			KNOWN_PERMISSION_MODES.has(attempted) &&
			attempted !== authoritative
				? {
						permissionModeNarrowing: {
							attempted: attempted as PermissionMode,
							authoritative,
							providerId: priorSelection.providerId ?? this.getProviderId(),
							model: priorSelection.model ?? "",
						},
					}
				: {}),
		};
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
		updateGlobalFocus = true,
	): Promise<void> {
		let sessionExists = Boolean(
			sessionId && sessionId === this.currentSessionId,
		);
		if (sessionId && sessionId !== this.currentSessionId) {
			sessionExists = await this.restoreSessionContext(
				sessionId,
				updateGlobalFocus,
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
			this.replaceBackgroundActivities([], false);
			const label = userMessage.slice(0, SESSION_LABEL_LENGTH).toUpperCase();
			this.currentSessionLabel = label;
			const agentSettings = this.agentCwd
				? this.agentSettingsMap.get(agentMapKey(this.agentCwd))
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
				approvalsReviewer: this.approvalsReviewer ?? undefined,
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
	private async handleSessionStart(
		event: Extract<AgentEvent, { type: "session_start" }>,
		sessionId: string | undefined,
		provider: AgentProvider,
		ownershipGeneration: number,
		emit: (msg: ServerMessage) => void,
	): Promise<void> {
		const newId = event.sessionId;
		if (
			!this.ownsProviderGeneration(provider.providerId, ownershipGeneration)
		) {
			return;
		}
		// Always update on every session_start — the provider may reassign on
		// compaction/fork, and we want the latest valid id persisted for the next
		// turn's resume.
		if (newId) {
			if (newId !== this.providerSessionId) {
				if (sessionId) {
					const accepted = await this.persistProviderSession(
						sessionId,
						provider.providerId,
						newId,
						ownershipGeneration,
						provider.sessionContinuityIdentity,
					).catch((e) => {
						logDbError("setSessionProviderSession", e);
						return false;
					});
					if (!accepted) return;
				} else if (
					!this.ownsProviderGeneration(provider.providerId, ownershipGeneration)
				) {
					return;
				}
				this.providerSessionId = newId;
				this.providerSessionProviderId = provider.providerId;
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

	private async emitDurableLocalCommandOutput(
		sessionId: string | undefined,
		content: string,
		emit: (msg: ServerMessage) => void,
		dbOperation: string,
	): Promise<void> {
		let id: string | undefined;
		if (sessionId) {
			const seq = this.messageSeq++;
			try {
				const dbId = await db.appendMessage(
					sessionId,
					seq,
					"local_command_output",
					content,
				);
				if (Number.isInteger(dbId)) id = `persisted-message:${dbId}`;
			} catch (error) {
				logDbError(dbOperation, error);
			}
		}
		emit({ type: "local_command_output", ...(id ? { id } : {}), content });
	}

	/**
	 * Keep Raven's durable transcript intact when a provider rotates its native
	 * context (for example Claude's /clear). Persist the replacement native id
	 * for future resume, then add a small visible boundary to Hlid's transcript.
	 */
	private async handleProviderContextReset(
		event: Extract<AgentEvent, { type: "provider_context_reset" }>,
		sessionId: string | undefined,
		provider: AgentProvider,
		ownershipGeneration: number,
		emit: (msg: ServerMessage) => void,
	): Promise<void> {
		const previousProviderSessionId =
			this.providerSessionProviderId === provider.providerId
				? this.providerSessionId
				: null;
		await this.handleSessionStart(
			{ type: "session_start", sessionId: event.sessionId },
			sessionId,
			provider,
			ownershipGeneration,
			emit,
		);
		if (
			!previousProviderSessionId ||
			previousProviderSessionId === event.sessionId ||
			this.providerSessionProviderId !== provider.providerId ||
			this.providerSessionId !== event.sessionId
		) {
			return;
		}

		const content = `${provider.label ?? provider.providerId} started a new native context`;
		await this.emitDurableLocalCommandOutput(
			sessionId,
			content,
			emit,
			"appendMessage (provider context reset)",
		);
	}

	/**
	 * Surface provider-side history loss without changing the live turn's
	 * lifecycle. The provider continues running after this event, so the warning
	 * is a durable transcript boundary rather than a transport failure.
	 */
	private async handleProviderHistoryWarning(
		event: Extract<AgentEvent, { type: "provider_history_warning" }>,
		sessionId: string | undefined,
		provider: AgentProvider,
		emit: (msg: ServerMessage) => void,
	): Promise<void> {
		if (event.providerSessionId && event.providerEventId) {
			const warningKey = `${provider.providerId}\0${event.providerSessionId}\0${event.providerEventId}`;
			if (this.providerHistoryWarningIds.has(warningKey)) return;
			this.providerHistoryWarningIds.add(warningKey);
			if (
				this.providerHistoryWarningIds.size >
				PROVIDER_HISTORY_WARNING_DEDUPE_LIMIT
			) {
				const oldest = this.providerHistoryWarningIds.values().next().value;
				if (oldest !== undefined) this.providerHistoryWarningIds.delete(oldest);
			}
		}
		const providerLabel = provider.label ?? provider.providerId;
		void db.appendLog(
			"warn",
			provider.providerId,
			"Provider native history mirror failed",
			{
				sessionId,
				providerSessionId: event.providerSessionId,
				providerEventId: event.providerEventId,
				code: event.code,
				reason: event.reason,
				scope: event.scope,
			},
		);

		const content = `${providerLabel} could not save part of its native resume history. This turn is continuing, but future ${providerLabel} resume or fork history may be incomplete.`;
		await this.emitDurableLocalCommandOutput(
			sessionId,
			content,
			emit,
			"appendMessage (provider history warning)",
		);
	}

	private async promptForHookApproval(
		call: ToolCall,
		reason: string,
		provider: AgentProvider,
		emit: (msg: ServerMessage) => void,
	): Promise<"allow" | "block"> {
		const toolUseID = call.toolUseId ?? `umbod-${Date.now()}`;
		const toolName = call.tool;
		const { input: toolInput, requester } = hookToolContext(call);
		const obsidianCommand = resolveObsidianCommandPermission(
			toolName,
			toolInput,
			this.vaultName,
		);
		const permissionKey = obsidianCommand?.key ?? toolName;
		if (this.activeRoutineContext) {
			return authorizeRoutineCapability({
				context: this.activeRoutineContext,
				tool: toolName,
				input: toolInput,
				cwd: call.workingDirectory ?? this.vaultPath,
				toolUseId: toolUseID,
			}).then((result) => (result.allowed ? "allow" : "block"));
		}
		if (
			this.sessionAllowedTools.has(permissionKey) ||
			(obsidianCommand !== null &&
				this.rememberedObsidianCommands.has(obsidianCommand.commandId))
		) {
			return "allow";
		}
		const approvalInput = await obsidianCommandApprovalInput(
			toolName,
			toolInput,
			this.vaultName,
		);
		const request = {
			type: "permission_request" as const,
			id: toolUseID,
			toolName,
			title:
				obsidianCommand !== null
					? `Run an Obsidian command in ${this.vaultName}?`
					: `${provider.label ?? provider.providerId} requests ${permissionToolDisplayName(toolName)}`,
			displayName:
				obsidianCommand !== null
					? "Obsidian command"
					: permissionToolDisplayName(toolName),
			description:
				obsidianCommand !== null
					? `Always applies only to command ${obsidianCommand.commandId} in the configured ${this.vaultName} vault.`
					: undefined,
			input: approvalInput,
			requester,
			policy: { source: "umbod" as const, reason },
		};
		return new Promise((finish) => {
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
			// Mirror into the in-memory high-water mark so /db/provider-usage
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
		if (turn.textWritePromise) await turn.textWritePromise;
		turn.textWriteDirty = false;
		if (reused) {
			await turn.assistantRowWrite;
			await db.setMessageText(sessionId, assistantSeq, turn.assistantText);
		} else {
			await db.appendMessage(
				sessionId,
				assistantSeq,
				"assistant",
				turn.assistantText,
			);
		}
		await this.backfillPendingSteerTargets(sessionId, turn, assistantSeq);
		return assistantSeq;
	}

	private async backfillPendingSteerTargets(
		sessionId: string,
		turn: TurnState,
		assistantSeq: number,
	): Promise<void> {
		const pending = [...turn.pendingSteerTargetSeqs];
		await Promise.all(
			pending.map(async (steerSeq) => {
				await db.setMessageSteerTargetSeq(sessionId, steerSeq, assistantSeq);
				turn.pendingSteerTargetSeqs.delete(steerSeq);
			}),
		);
	}

	private async persistPendingToolEvents(
		sessionId: string,
		assistantSeq: number,
		turn: TurnState,
		operationSuffix: string,
		providerId: string,
	): Promise<void> {
		await Promise.all([
			...turn.pendingToolEventWrites.values(),
			...turn.pendingToolMetadataWrites,
		]);
		const dimensions = {
			providerId,
			...(turn.lastActualModel ? { model: turn.lastActualModel } : {}),
			agentCwd: this.agentCwd ?? null,
		};
		await Promise.all(
			turn.pendingToolEvents
				.map(async (toolEvent) => {
					const result = turn.pendingToolResults.get(toolEvent.toolId);
					const subagent =
						turn.pendingToolUpdates.get(toolEvent.toolId) ?? toolEvent.subagent;
					const taskActivity =
						turn.pendingToolActivityUpdates.get(toolEvent.toolId) ??
						toolEvent.taskActivity;
					const subagentFrame = turn.pendingToolUpdateFrames.get(
						toolEvent.toolId,
					);
					const activityFrame = turn.pendingToolActivityUpdateFrames.get(
						toolEvent.toolId,
					);
					if (turn.persistedToolIds.has(toolEvent.toolId)) {
						await Promise.all([
							...(result
								? [
										result.providerFrame
											? db.setToolEventResult(
													sessionId,
													toolEvent.toolId,
													result.content,
													result.isError,
													result.providerFrame,
												)
											: db.setToolEventResult(
													sessionId,
													toolEvent.toolId,
													result.content,
													result.isError,
												),
									]
								: []),
							...(subagent
								? [
										this.persistToolSubagent(
											sessionId,
											toolEvent.toolId,
											subagent,
											subagentFrame,
										),
									]
								: []),
							...(taskActivity
								? [
										this.persistToolActivity(
											sessionId,
											toolEvent.toolId,
											taskActivity,
											activityFrame,
										),
									]
								: []),
						]);
						return;
					}

					let append: Promise<void>;
					if (taskActivity) {
						append = toolEvent.providerFrame
							? db.appendToolEvent(
									sessionId,
									assistantSeq,
									toolEvent.toolId,
									toolEvent.name,
									toolEvent.input,
									subagent,
									dimensions,
									taskActivity,
									{
										...toolEvent.providerFrame,
										...(toolEvent.providerLineageFrames
											? { lineageFrames: toolEvent.providerLineageFrames }
											: {}),
									},
								)
							: db.appendToolEvent(
									sessionId,
									assistantSeq,
									toolEvent.toolId,
									toolEvent.name,
									toolEvent.input,
									subagent,
									dimensions,
									taskActivity,
								);
					} else {
						append = toolEvent.providerFrame
							? db.appendToolEvent(
									sessionId,
									assistantSeq,
									toolEvent.toolId,
									toolEvent.name,
									toolEvent.input,
									subagent,
									dimensions,
									undefined,
									{
										...toolEvent.providerFrame,
										...(toolEvent.providerLineageFrames
											? { lineageFrames: toolEvent.providerLineageFrames }
											: {}),
									},
								)
							: db.appendToolEvent(
									sessionId,
									assistantSeq,
									toolEvent.toolId,
									toolEvent.name,
									toolEvent.input,
									subagent,
									dimensions,
								);
					}
					await append;
					if (result) {
						if (result.providerFrame) {
							await db.setToolEventResult(
								sessionId,
								toolEvent.toolId,
								result.content,
								result.isError,
								result.providerFrame,
							);
						} else {
							await db.setToolEventResult(
								sessionId,
								toolEvent.toolId,
								result.content,
								result.isError,
							);
						}
					}
					if (subagent) {
						await this.persistToolSubagent(
							sessionId,
							toolEvent.toolId,
							subagent,
							subagentFrame,
						);
					}
					if (taskActivity) {
						await this.persistToolActivity(
							sessionId,
							toolEvent.toolId,
							taskActivity,
							activityFrame,
						);
					}
				})
				.map((write) =>
					write.catch((error) =>
						logDbError(`persist tool event (${operationSuffix})`, error),
					),
				),
		);
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
		turn.terminalFailure = event.terminalFailure;
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
			turn.queryRecorded = true;
			if (recorded) queryData.estimated_cost = recorded.estimatedCost;
			bumpDataRevision("stats", "sessions");
			if (turn.lastActualModel) {
				await db
					.setSessionActualModelForProvider(
						sessionId,
						provider.providerId,
						turn.selectedModel,
						turn.lastActualModel,
					)
					.catch((error) =>
						logDbError("setSessionActualModelForProvider", error),
					);
			}
			if (turn.reservedAssistantSeq !== null || turn.assistantText) {
				turn.lastAssistantText = turn.assistantText;
				const assistantSeq = await this.persistAssistantMessage(
					sessionId,
					turn,
				);
				turn.lastAssistantSeq = assistantSeq;
				if (recorded?.queryId != null) {
					await db.setMessageQueryId(sessionId, assistantSeq, recorded.queryId);
				}
				await this.persistPendingToolEvents(
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
				turn.pendingToolActivityUpdates.clear();
				turn.pendingToolEventWrites.clear();
				turn.persistedToolIds.clear();
				turn.reservedAssistantSeq = null;
				turn.assistantRowWrite = null;
				turn.dbMessageId = null;
				turn.assistantText = "";
			}
		}
		if (event.terminalFailure) {
			emit({
				type: "error",
				message: event.terminalFailure.message,
				turn_scoped: true,
				...(this.currentTurnId !== undefined
					? { turn_id: this.currentTurnId }
					: {}),
			});
			return;
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
	 * Provider turns can be stopped before the provider emits its ordinary `done`
	 * event. Their incremental usage is still authoritative and belongs in Ledger.
	 * Guard with `queryRecorded` so completed turns continue through handleDone
	 * without being counted twice.
	 */
	private async persistIncompleteQuery(
		sessionId: string,
		turn: TurnState,
		provider: AgentProvider,
		assistantSeq: number | null,
	): Promise<void> {
		if (turn.queryRecorded || !turn.receivedUsage) return;
		const usage = turn.liveQueryUsage;
		const model = turn.lastActualModel ?? (turn.selectedModel || this.model);
		const estimatedCost = estimateProviderCost(
			provider.providerId,
			model,
			usage,
		);
		const recorded = await db.recordQuery(
			sessionId,
			{
				cost: 0,
				cost_known: false,
				estimated_cost: estimatedCost,
				input_tokens: usage.inputTokens,
				output_tokens: usage.outputTokens,
				cache_read_tokens: usage.cacheReadTokens,
				cache_creation_tokens: usage.cacheCreationTokens,
				duration_ms: Math.max(0, Date.now() - turn.startedAtMs),
				turns: 1,
				context_window: turn.lastKnownContextWindow,
				stop_reason: null,
				tokens_in_context:
					turn.lastContextTokens ??
					(turn.lastTurnUsage
						? turn.lastTurnUsage.input_tokens +
							(turn.lastTurnUsage.cache_read_input_tokens ?? 0) +
							(turn.lastTurnUsage.cache_creation_input_tokens ?? 0)
						: null),
				model,
				agent_cwd: this.agentCwd ?? null,
			},
			provider.providerId,
		);
		if (assistantSeq !== null) {
			await db.setMessageQueryId(sessionId, assistantSeq, recorded.queryId);
		}
		if (turn.lastActualModel) {
			await db.setSessionActualModelForProvider(
				sessionId,
				provider.providerId,
				turn.selectedModel,
				turn.lastActualModel,
			);
		}
		turn.queryRecorded = true;
		bumpDataRevision("stats", "sessions");
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
			const text = turn.assistantText;
			const previousWrite = turn.textWritePromise ?? Promise.resolve();
			const write = previousWrite
				.then(() => db.setMessageText(sessionId, seq, text))
				.catch((e) => logDbError("setMessageText (live)", e));
			turn.textWritePromise = write;
			void write.finally(() => {
				if (turn.textWritePromise === write) turn.textWritePromise = null;
			});
		}, TEXT_WRITE_THROTTLE_MS);
	}

	/**
	 * Allocate the assistant message seq + insert an empty placeholder row on
	 * first call. Subsequent calls return the same seq. Used by text_delta,
	 * tool_start, and accepted early steers so live state attaches to a real row
	 * that mid-turn reloads can render.
	 */
	private ensureAssistantRow(turn: TurnState, sessionId: string): number {
		if (turn.reservedAssistantSeq != null) return turn.reservedAssistantSeq;
		const seq = this.messageSeq++;
		turn.reservedAssistantSeq = seq;
		if (
			this.currentTurnState === turn &&
			this.currentDelegationHandoff !== null
		) {
			this.currentDelegationHandoff.currentAssistantSequence = seq;
		}
		const rowWrite = db
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
				await this.backfillPendingSteerTargets(sessionId, turn, seq);
			});
		turn.assistantRowWrite = rowWrite;
		void rowWrite.catch((e) => logDbError("appendMessage (placeholder)", e));
		return seq;
	}

	private handleTextDelta(
		event: Extract<AgentEvent, { type: "text_delta" }>,
		turn: TurnState,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
	): void {
		if (
			!this.providerDirectContributionAccepted(
				event.providerFrame,
				turn,
				"text",
			)
		) {
			return;
		}
		const beginsNewAssistantMessage =
			turn.assistantMessageBoundaryPending && Boolean(event.text);
		if (event.text) turn.assistantMessageBoundaryPending = false;
		const text = beginsNewAssistantMessage
			? joinAssistantMessageText(turn.assistantText, event.text)
			: turn.lastBlockType === "tool_use" &&
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

	private async handleResultTextFallback(
		event: Extract<AgentEvent, { type: "result_text_fallback" }>,
		turn: TurnState,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
		provider: AgentProvider,
	): Promise<void> {
		if (turn.assistantText) return;
		const providerFrame =
			event.providerSessionId && event.providerUuid
				? {
						providerSessionId: event.providerSessionId,
						providerUuid: event.providerUuid,
					}
				: undefined;
		if (providerFrame) {
			await this.handleProviderMessageFrame(
				{
					type: "provider_message_frame",
					id: providerFrame.providerUuid,
					providerSessionId: providerFrame.providerSessionId,
					kind: "result_text",
					text: event.text,
				},
				turn,
				sessionId,
				provider,
			);
			if (!this.providerContributionAccepted(providerFrame, turn)) return;
		}
		this.handleTextDelta(
			{
				type: "text_delta",
				text: event.text,
				...(providerFrame ? { providerFrame } : {}),
			},
			turn,
			sessionId,
			emit,
		);
	}

	private handleTextReplacement(
		event: Extract<AgentEvent, { type: "text_replace" }>,
		turn: TurnState,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
	): void {
		const previousOffset = event.previousText
			? turn.assistantText.lastIndexOf(event.previousText)
			: turn.assistantText.length;
		const replacesCurrentTail =
			previousOffset >= 0 &&
			previousOffset + event.previousText.length === turn.assistantText.length;
		// The provider and SessionManager consume the same ordered AgentEvent
		// stream, so this should always identify the current tail. Preserve the
		// accumulated turn rather than erasing earlier commentary if that
		// invariant is ever violated.
		if (!replacesCurrentTail) return;
		const prefix = turn.assistantText.slice(0, previousOffset);
		const beginsNewAssistantMessage =
			turn.assistantMessageBoundaryPending && Boolean(event.text);
		if (event.text) turn.assistantMessageBoundaryPending = false;
		const text = beginsNewAssistantMessage
			? joinAssistantMessageText(prefix, event.text)
			: event.previousText.length === 0 &&
					turn.lastBlockType === "tool_use" &&
					event.text &&
					!event.text.startsWith("\n")
				? `\n\n${event.text}`
				: event.text;
		turn.assistantText = prefix + text;
		emit({
			type: "chunk",
			text: turn.assistantText,
			offset: 0,
			replace: true,
		});
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
	private rejectProviderMessageFrame(
		event: Extract<AgentEvent, { type: "provider_message_frame" }>,
		turn: TurnState,
		status: "duplicate" | "retracted",
		assistantSeq?: number,
	): void {
		if (status === "retracted") {
			turn.acceptedProviderFrames.delete(
				providerFrameKey(event.providerSessionId, event.id),
			);
			for (const toolId of event.toolStartIds ?? []) {
				turn.retractedToolIds.add(toolId);
			}
		}
		turn.currentProviderFrame = {
			providerSessionId: event.providerSessionId,
			providerUuid: event.id,
			accepted: false,
			...(assistantSeq !== undefined ? { assistantSeq } : {}),
			...(status === "duplicate"
				? {
						duplicateReplay: {
							textBlocksPending: event.textBlockCount ?? (event.text ? 1 : 0),
							toolStartIds: new Set(event.toolStartIds ?? []),
							toolResultIds: new Set(event.toolResultIds ?? []),
						},
					}
				: {}),
		};
	}

	private async handleProviderMessageFrame(
		event: Extract<AgentEvent, { type: "provider_message_frame" }>,
		turn: TurnState,
		sessionId: string | undefined,
		provider: AgentProvider,
	): Promise<void> {
		if (!sessionId) {
			turn.acceptedProviderFrames.add(
				providerFrameKey(event.providerSessionId, event.id),
			);
			turn.currentProviderFrame = {
				providerSessionId: event.providerSessionId,
				providerUuid: event.id,
				accepted: true,
			};
			return;
		}
		const frameInput = {
			sessionId,
			providerId: provider.providerId,
			providerSessionId: event.providerSessionId,
			providerUuid: event.id,
			kind: event.kind,
			...(event.text !== undefined ? { text: event.text } : {}),
			...(event.toolStartIds ? { toolStartIds: event.toolStartIds } : {}),
			...(event.toolResultIds ? { toolResultIds: event.toolResultIds } : {}),
		};
		const disposition = await db.getProviderMessageFrameDisposition(frameInput);
		if (disposition !== "new") {
			this.rejectProviderMessageFrame(event, turn, disposition);
			return;
		}
		let seq: number;
		if (event.kind === "tool_result") {
			await Promise.all(
				(event.toolResultIds ?? []).flatMap((toolId) => {
					const pending = turn.pendingToolEventWrites.get(toolId);
					return pending ? [pending] : [];
				}),
			);
			const owningSeq = await db.getProviderToolAssistantSeq(
				sessionId,
				provider.providerId,
				event.providerSessionId,
				event.toolResultIds ?? [],
			);
			if (owningSeq === null) {
				turn.currentProviderFrame = {
					providerSessionId: event.providerSessionId,
					providerUuid: event.id,
					accepted: false,
				};
				return;
			}
			seq = owningSeq;
		} else {
			seq = this.ensureAssistantRow(turn, sessionId);
			await turn.assistantRowWrite;
		}
		const status = await db.recordProviderMessageFrame({
			assistantSeq: seq,
			...frameInput,
			frameOrder: turn.providerFrameOrder++,
		});
		if (status === "recorded") {
			turn.currentProviderFrame = {
				providerSessionId: event.providerSessionId,
				providerUuid: event.id,
				accepted: true,
				assistantSeq: seq,
			};
			turn.acceptedProviderFrames.add(
				providerFrameKey(event.providerSessionId, event.id),
			);
		} else {
			this.rejectProviderMessageFrame(event, turn, status, seq);
		}
	}

	private providerContributionAccepted(
		providerFrame:
			| { providerSessionId: string; providerUuid: string }
			| undefined,
		turn: TurnState,
	): boolean {
		if (!providerFrame) return true;
		return turn.acceptedProviderFrames.has(
			providerFrameKey(
				providerFrame.providerSessionId,
				providerFrame.providerUuid,
			),
		);
	}

	private providerDirectContributionAccepted(
		providerFrame:
			| { providerSessionId: string; providerUuid: string }
			| undefined,
		turn: TurnState,
		kind: "boundary" | "text" | "tool_start" | "tool_result",
		toolId?: string,
	): boolean {
		if (!providerFrame) return true;
		const current = turn.currentProviderFrame;
		const isCurrent =
			current?.providerSessionId === providerFrame.providerSessionId &&
			current.providerUuid === providerFrame.providerUuid;
		const replay = isCurrent ? current.duplicateReplay : undefined;
		if (replay) {
			if (kind === "boundary") return false;
			if (kind === "text" && replay.textBlocksPending > 0) {
				replay.textBlocksPending--;
				return false;
			}
			if (
				kind === "tool_start" &&
				toolId !== undefined &&
				replay.toolStartIds.delete(toolId)
			) {
				return false;
			}
			if (
				kind === "tool_result" &&
				toolId !== undefined &&
				replay.toolResultIds.delete(toolId)
			) {
				return false;
			}
		}
		return this.providerContributionAccepted(providerFrame, turn);
	}

	private async handleProviderMessageRetraction(
		event: Extract<AgentEvent, { type: "provider_message_retraction" }>,
		turn: TurnState,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
		provider: AgentProvider,
	): Promise<void> {
		if (!sessionId) return;
		// Serialize every writer that could otherwise recreate stale text/results
		// after the retraction transaction commits.
		if (turn.textWriteTimer) {
			clearTimeout(turn.textWriteTimer);
			turn.textWriteTimer = null;
		}
		if (turn.textWritePromise) await turn.textWritePromise;
		if (turn.assistantRowWrite) await turn.assistantRowWrite;
		if (turn.reservedAssistantSeq != null && turn.textWriteDirty) {
			await db.setMessageText(
				sessionId,
				turn.reservedAssistantSeq,
				turn.assistantText,
			);
		}
		turn.textWriteDirty = false;
		await Promise.all([
			...turn.pendingToolEventWrites.values(),
			...turn.pendingToolMetadataWrites,
		]);
		const revisions = await db.retractProviderMessageFrames(
			sessionId,
			provider.providerId,
			event.providerSessionId,
			event.ids,
			event.source,
		);
		if (
			turn.currentProviderFrame?.providerSessionId ===
				event.providerSessionId &&
			event.ids.includes(turn.currentProviderFrame.providerUuid)
		) {
			turn.currentProviderFrame.accepted = false;
		}
		for (const providerUuid of event.ids) {
			turn.acceptedProviderFrames.delete(
				providerFrameKey(event.providerSessionId, providerUuid),
			);
		}
		for (const revision of revisions) {
			const current = revision.assistantSeq === turn.reservedAssistantSeq;
			if (current) {
				turn.assistantText = revision.text;
				const removed = new Set(revision.removedToolIds);
				for (const toolId of removed) {
					turn.retractedToolIds.add(toolId);
					turn.pendingToolResults.delete(toolId);
					turn.pendingToolUpdates.delete(toolId);
					turn.pendingToolUpdateFrames.delete(toolId);
					turn.pendingToolActivityUpdates.delete(toolId);
					turn.pendingToolActivityUpdateFrames.delete(toolId);
					turn.pendingToolEventWrites.delete(toolId);
					turn.persistedToolIds.delete(toolId);
				}
				turn.pendingToolEvents = turn.pendingToolEvents.filter(
					(toolEvent) => !removed.has(toolEvent.toolId),
				);
				for (const toolId of revision.clearedToolResultIds) {
					turn.pendingToolResults.delete(toolId);
				}
				for (const metadata of revision.restoredToolMetadata ?? []) {
					if (metadata.subagent) {
						turn.pendingToolUpdates.set(metadata.toolId, metadata.subagent);
					} else {
						turn.pendingToolUpdates.delete(metadata.toolId);
					}
					turn.pendingToolUpdateFrames.delete(metadata.toolId);
					if (metadata.taskActivity) {
						turn.pendingToolActivityUpdates.set(
							metadata.toolId,
							metadata.taskActivity,
						);
					} else {
						turn.pendingToolActivityUpdates.delete(metadata.toolId);
					}
					turn.pendingToolActivityUpdateFrames.delete(metadata.toolId);
					const pending = turn.pendingToolEvents.find(
						(toolEvent) => toolEvent.toolId === metadata.toolId,
					);
					if (pending) {
						if (metadata.subagent) pending.subagent = metadata.subagent;
						else delete pending.subagent;
						if (metadata.taskActivity) {
							pending.taskActivity = metadata.taskActivity;
						} else {
							delete pending.taskActivity;
						}
					}
				}
				turn.lastBlockType =
					turn.pendingToolEvents.length > 0
						? "tool_use"
						: turn.assistantText
							? "text"
							: null;
				turn.rawToolEventCount = Math.max(
					0,
					turn.rawToolEventCount - revision.removedToolIds.length,
				);
			}
			emit({
				type: "assistant_revision",
				session_id: sessionId,
				transcript_seq: revision.assistantSeq,
				...(current ? { current: true } : {}),
				text: revision.text,
				removed_tool_ids: revision.removedToolIds,
				cleared_tool_result_ids: revision.clearedToolResultIds,
				remaining_tool_count: revision.remainingToolCount,
				remaining_tool_error_count: revision.remainingToolErrorCount,
				...(revision.restoredToolMetadata?.length
					? {
							restored_tool_metadata: revision.restoredToolMetadata.map(
								(metadata) => ({
									id: metadata.toolId,
									subagent: metadata.subagent,
									taskActivity: metadata.taskActivity,
								}),
							),
						}
					: {}),
				steer_tool_event_indexes: revision.steerToolEventIndexes.map(
					(steer) => ({
						user_seq: steer.userSeq,
						tool_event_index: steer.toolEventIndex,
					}),
				),
			});
		}
	}

	private async handleAssistantMessageId(
		event: Extract<AgentEvent, { type: "assistant_message_id" }>,
		turn: TurnState,
		sessionId: string | undefined,
	): Promise<void> {
		if (!sessionId) return;
		if (
			turn.currentProviderFrame?.providerUuid === event.id &&
			(event.providerSessionId === undefined ||
				turn.currentProviderFrame.providerSessionId ===
					event.providerSessionId) &&
			!turn.currentProviderFrame.accepted
		) {
			return;
		}
		const seq = this.ensureAssistantRow(turn, sessionId);
		await turn.assistantRowWrite;
		await db.setMessageSdkUuid(sessionId, seq, event.id);
	}

	private async handleProviderPermissionDenied(
		event: Extract<AgentEvent, { type: "provider_permission_denied" }>,
		turn: TurnState,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
		provider: AgentProvider,
	): Promise<void> {
		const displayName = permissionToolDisplayName(event.toolName);
		if (sessionId) {
			try {
				const accepted = await db.recordProviderPermissionDenied({
					sessionId,
					toolId: event.toolId,
					toolName: event.toolName,
					displayName,
					providerId: provider.providerId,
					providerSessionId: event.providerSessionId,
					...(event.reasonType ? { reasonType: event.reasonType } : {}),
					...(event.reason ? { reason: event.reason } : {}),
					...(event.message ? { message: event.message } : {}),
				});
				if (!accepted) {
					turn.quarantinedProviderPermissionResults.add(
						providerPermissionOutcomeKey(event.providerSessionId, event.toolId),
					);
					return;
				}
			} catch (error) {
				// Provider outcome persistence is evidence/accounting, not authority
				// over the provider lifecycle. Keep the live turn moving.
				logDbError("recordProviderPermissionDenied", error);
			}
		}
		emit({
			type: "provider_permission_denied",
			id: event.toolId,
			toolName: event.toolName,
			displayName,
			providerId: provider.providerId,
			...(event.reasonType ? { reasonType: event.reasonType } : {}),
			...(event.reason ? { reason: event.reason } : {}),
			...(event.message ? { providerMessage: event.message } : {}),
		});
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

	private trackToolMetadataWrite(
		turn: TurnState,
		write: Promise<void>,
		label: string,
	): void {
		const tracked = write.catch((error) => logDbError(label, error));
		turn.pendingToolMetadataWrites.add(tracked);
		void tracked.finally(() => turn.pendingToolMetadataWrites.delete(tracked));
	}

	private persistToolSubagent(
		sessionId: string,
		toolId: string,
		subagent: SubagentSnapshot,
		providerFrame?: { providerSessionId: string; providerUuid: string },
	): Promise<void> {
		return providerFrame
			? db.setToolEventSubagent(sessionId, toolId, subagent, providerFrame)
			: db.setToolEventSubagent(sessionId, toolId, subagent);
	}

	private persistToolActivity(
		sessionId: string,
		toolId: string,
		taskActivity: TaskActivity,
		providerFrame?: { providerSessionId: string; providerUuid: string },
	): Promise<void> {
		return providerFrame
			? db.setToolEventActivity(sessionId, toolId, taskActivity, providerFrame)
			: db.setToolEventActivity(sessionId, toolId, taskActivity);
	}

	private async handleToolStart(
		event: Extract<AgentEvent, { type: "tool_start" }>,
		turn: TurnState,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
		provider: AgentProvider,
	): Promise<void> {
		if (
			!this.providerDirectContributionAccepted(
				event.providerFrame,
				turn,
				"tool_start",
				event.toolId,
			)
		) {
			return;
		}
		if (sessionId && event.providerFrame) {
			const lineageFrames = [
				event.providerFrame,
				...(event.providerLineageFrames ?? []),
			].filter(
				(frame, index, frames) =>
					frames.findIndex(
						(candidate) =>
							candidate.providerSessionId === frame.providerSessionId &&
							candidate.providerUuid === frame.providerUuid,
					) === index,
			);
			const linked = await Promise.all(
				lineageFrames.map((frame) =>
					db.linkProviderFrameToolStart(
						sessionId,
						provider.providerId,
						frame.providerSessionId,
						frame.providerUuid,
						event.toolId,
					),
				),
			);
			if (linked.some((accepted) => !accepted)) {
				turn.retractedToolIds.add(event.toolId);
				return;
			}
		}
		turn.retractedToolIds.delete(event.toolId);
		turn.hadToolEvents = true;
		if (event.name === "ExitPlanMode") {
			turn.lastBlockType = "tool_use";
			return;
		}
		turn.rawToolEventCount++;
		turn.pendingToolEvents.push({
			toolId: event.toolId,
			name: event.name,
			input: event.input,
			...(event.subagent ? { subagent: event.subagent } : {}),
			...(event.taskActivity ? { taskActivity: event.taskActivity } : {}),
			...(event.providerFrame ? { providerFrame: event.providerFrame } : {}),
			...(event.providerLineageFrames
				? { providerLineageFrames: event.providerLineageFrames }
				: {}),
		});
		emit({
			type: "tool_event",
			id: event.toolId,
			name: event.name,
			input: event.input,
			...(event.subagent ? { subagent: event.subagent } : {}),
			...(event.taskActivity ? { taskActivity: event.taskActivity } : {}),
		});
		if (sessionId) {
			const seq = this.ensureAssistantRow(turn, sessionId);
			const toolId = event.toolId;
			const dimensions = {
				providerId: provider.providerId,
				...(turn.lastActualModel ? { model: turn.lastActualModel } : {}),
				agentCwd: this.agentCwd ?? null,
			};
			let append: Promise<void>;
			if (event.taskActivity) {
				append = event.providerFrame
					? db.appendToolEvent(
							sessionId,
							seq,
							toolId,
							event.name,
							event.input,
							event.subagent,
							dimensions,
							event.taskActivity,
							{
								...event.providerFrame,
								...(event.providerLineageFrames
									? { lineageFrames: event.providerLineageFrames }
									: {}),
							},
						)
					: db.appendToolEvent(
							sessionId,
							seq,
							toolId,
							event.name,
							event.input,
							event.subagent,
							dimensions,
							event.taskActivity,
						);
			} else {
				append = event.providerFrame
					? db.appendToolEvent(
							sessionId,
							seq,
							toolId,
							event.name,
							event.input,
							event.subagent,
							dimensions,
							undefined,
							{
								...event.providerFrame,
								...(event.providerLineageFrames
									? { lineageFrames: event.providerLineageFrames }
									: {}),
							},
						)
					: db.appendToolEvent(
							sessionId,
							seq,
							toolId,
							event.name,
							event.input,
							event.subagent,
							dimensions,
						);
			}
			const persisted = append
				.then(() => {
					turn.persistedToolIds.add(toolId);
					const latest = turn.pendingToolUpdates.get(toolId);
					if (latest) {
						this.trackToolMetadataWrite(
							turn,
							this.persistToolSubagent(
								sessionId,
								toolId,
								latest,
								turn.pendingToolUpdateFrames.get(toolId),
							),
							"setToolEventSubagent (live)",
						);
					}
					const latestActivity = turn.pendingToolActivityUpdates.get(toolId);
					if (latestActivity) {
						this.trackToolMetadataWrite(
							turn,
							this.persistToolActivity(
								sessionId,
								toolId,
								latestActivity,
								turn.pendingToolActivityUpdateFrames.get(toolId),
							),
							"setToolEventActivity (live)",
						);
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
		if (
			turn.retractedToolIds.has(event.toolId) ||
			!this.providerContributionAccepted(event.providerFrame, turn)
		) {
			return;
		}
		turn.pendingToolUpdates.set(event.toolId, event.subagent);
		if (event.providerFrame) {
			turn.pendingToolUpdateFrames.set(event.toolId, event.providerFrame);
		} else {
			turn.pendingToolUpdateFrames.delete(event.toolId);
		}
		const pending = turn.pendingToolEvents.find(
			(toolEvent) => toolEvent.toolId === event.toolId,
		);
		if (pending) pending.subagent = event.subagent;
		emit({ type: "tool_update", id: event.toolId, subagent: event.subagent });
		if (sessionId && turn.persistedToolIds.has(event.toolId)) {
			this.trackToolMetadataWrite(
				turn,
				this.persistToolSubagent(
					sessionId,
					event.toolId,
					event.subagent,
					event.providerFrame,
				),
				"setToolEventSubagent (live)",
			);
		}
	}

	private handleToolActivityUpdate(
		event: Extract<AgentEvent, { type: "tool_activity_update" }>,
		turn: TurnState,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
	): void {
		if (
			turn.retractedToolIds.has(event.toolId) ||
			!this.providerContributionAccepted(event.providerFrame, turn)
		) {
			return;
		}
		turn.pendingToolActivityUpdates.set(event.toolId, event.taskActivity);
		if (event.providerFrame) {
			turn.pendingToolActivityUpdateFrames.set(
				event.toolId,
				event.providerFrame,
			);
		} else {
			turn.pendingToolActivityUpdateFrames.delete(event.toolId);
		}
		const pending = turn.pendingToolEvents.find(
			(toolEvent) => toolEvent.toolId === event.toolId,
		);
		if (pending) pending.taskActivity = event.taskActivity;
		emit({
			type: "tool_activity_update",
			id: event.toolId,
			taskActivity: event.taskActivity,
		});
		if (sessionId && turn.persistedToolIds.has(event.toolId)) {
			this.trackToolMetadataWrite(
				turn,
				this.persistToolActivity(
					sessionId,
					event.toolId,
					event.taskActivity,
					event.providerFrame,
				),
				"setToolEventActivity (live)",
			);
		}
	}

	private handleToolProgress(
		event: Extract<AgentEvent, { type: "tool_progress" }>,
		turn: TurnState,
		emit: (msg: ServerMessage) => void,
	): void {
		if (
			turn.retractedToolIds.has(event.toolId) ||
			!this.providerContributionAccepted(event.providerFrame, turn)
		) {
			return;
		}
		emit({
			type: "tool_progress_update",
			id: event.toolId,
			progress: event.progress,
		});
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
		provider: AgentProvider,
	): Promise<void> {
		if (event.providerSessionId) {
			const permissionOutcomeKey = providerPermissionOutcomeKey(
				event.providerSessionId,
				event.toolId,
			);
			if (turn.quarantinedProviderPermissionResults.has(permissionOutcomeKey)) {
				turn.quarantinedProviderPermissionResults.delete(permissionOutcomeKey);
				return;
			}
		}
		if (
			turn.retractedToolIds.has(event.toolId) ||
			!this.providerDirectContributionAccepted(
				event.providerFrame,
				turn,
				"tool_result",
				event.toolId,
			)
		) {
			return;
		}
		turn.pendingToolResults.set(event.toolId, {
			content: event.content,
			isError: event.isError === true,
			...(event.providerFrame ? { providerFrame: event.providerFrame } : {}),
		});

		let persisted = false;
		let providerFrameSeq =
			event.providerFrame &&
			turn.currentProviderFrame?.accepted === true &&
			turn.currentProviderFrame.providerSessionId ===
				event.providerFrame.providerSessionId &&
			turn.currentProviderFrame.providerUuid ===
				event.providerFrame.providerUuid
				? turn.currentProviderFrame.assistantSeq
				: undefined;
		if (sessionId) {
			const pendingInsert = turn.pendingToolEventWrites.get(event.toolId);
			if (event.providerSessionId && !event.providerFrame) {
				if (pendingInsert) await pendingInsert;
				try {
					providerFrameSeq =
						(await db.getProviderToolAssistantSeq(
							sessionId,
							provider.providerId,
							event.providerSessionId,
							[event.toolId],
						)) ?? undefined;
				} catch (error) {
					turn.pendingToolResults.delete(event.toolId);
					logDbError("getProviderToolAssistantSeq (synthetic result)", error);
					return;
				}
				if (providerFrameSeq === undefined) {
					turn.pendingToolResults.delete(event.toolId);
					return;
				}
			}
			persisted = pendingInsert
				? await pendingInsert
				: turn.persistedToolIds.has(event.toolId) ||
					providerFrameSeq !== undefined;
			if (persisted) {
				try {
					if (event.providerFrame || providerFrameSeq !== undefined) {
						await db.setToolEventResult(
							sessionId,
							event.toolId,
							event.content,
							event.isError === true,
							event.providerFrame,
							providerFrameSeq,
						);
					} else {
						await db.setToolEventResult(
							sessionId,
							event.toolId,
							event.content,
							event.isError === true,
						);
					}
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

	private async handleGeneratedMedia(
		event: Extract<AgentEvent, { type: "generated_media" }>,
		turn: TurnState,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
		provider: AgentProvider,
	): Promise<void> {
		const failure = async (
			stage: "provider" | "persistence",
			error: string,
		): Promise<void> => {
			await this.handleToolResult(
				{
					type: "tool_result",
					toolId: event.toolId,
					content: JSON.stringify({
						type: "hlid_generated_media",
						version: 1,
						status: "failed",
						provider: provider.providerId,
						provider_item_id: event.toolId,
						failure_stage: stage,
						error: error.slice(0, 1_000),
					}),
					isError: true,
				},
				turn,
				sessionId,
				emit,
				provider,
			);
		};

		if (event.status.toLowerCase() !== "completed" || !event.dataBase64) {
			await failure(
				"provider",
				`Image generation ended with status ${event.status || "unknown"}.`,
			);
			return;
		}
		if (!sessionId) {
			await failure(
				"persistence",
				"Generated media requires a durable Hlid session.",
			);
			return;
		}

		const seq = this.ensureAssistantRow(turn, sessionId);
		try {
			await turn.assistantRowWrite;
			const config = loadConfig();
			const image = await ingestGeneratedImage({
				dataBase64: event.dataBase64,
				providerItemId: event.toolId,
				providerPath: event.providerPath,
				sessionId,
				messageSeq: seq,
				agentCwd: this.agentCwd,
				maxBytes: config.attachments.max_bytes,
				allowedMimes: config.attachments.allowed_mimes,
			});
			bumpDataRevision("relics", "storage");
			emit({ type: "attachment_created", id: image.id, kind: "ephemeral" });
			await this.handleToolResult(
				{
					type: "tool_result",
					toolId: event.toolId,
					content: JSON.stringify({
						type: "hlid_generated_media",
						version: 1,
						status: "ready",
						provider: provider.providerId,
						provider_item_id: event.toolId,
						attachment_id: image.id,
						filename: image.filename,
						mime: image.mime,
						size_bytes: image.sizeBytes,
						width: image.width,
						height: image.height,
						...(event.prompt ? { prompt: event.prompt.slice(0, 4_000) } : {}),
					}),
				},
				turn,
				sessionId,
				emit,
				provider,
			);
		} catch (error) {
			await failure(
				"persistence",
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	private handleUsage(
		event: Extract<AgentEvent, { type: "usage" }>,
		turn: TurnState,
		emit: (msg: ServerMessage) => void,
		provider: AgentProvider,
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
		turn.receivedUsage = true;
		turn.lastTurnUsage = {
			input_tokens: event.inputTokens,
			cache_read_input_tokens: event.cacheReadTokens,
			cache_creation_input_tokens: event.cacheCreationTokens,
		};
		if (event.model) {
			turn.actualModelObservations.push({
				model: event.model,
				local: turn.localFallbackModel === event.model,
			});
			turn.lastActualModel =
				[...turn.actualModelObservations]
					.reverse()
					.find((observation) => !observation.local)?.model ?? null;
		}
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
			query_estimated_cost: estimateProviderCost(
				provider.providerId,
				event.model ?? this.model,
				turn.liveQueryUsage,
			),
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
		sourceSession: AgentSession,
	): Promise<boolean> {
		const providerContinuation = this.currentProviderContinuation;
		if (
			providerContinuation &&
			!providerContinuation.peerOriginObserved &&
			!PEER_ORIGIN_PREFLIGHT_EVENT_TYPES.has(event.type)
		) {
			throw new Error(
				`Claude peer continuation emitted ${event.type} before its peer origin`,
			);
		}
		switch (event.type) {
			case "provider_permission_mode_changed":
				if (
					provider.providerId === "claude" &&
					this.agentSession === sourceSession &&
					this.currentSessionId === (sessionId ?? null) &&
					this.providerOwnershipGeneration ===
						turn.providerOwnershipGeneration &&
					this.providerSessionId === event.providerSessionId &&
					this.currentTurnPermissionMode === "auto" &&
					event.permissionMode === "default"
				) {
					const reconciled = await this.reconcileNativePermissionFallback(
						sourceSession,
						event.providerSessionId,
					);
					if (reconciled) {
						this.currentTurnPermissionMode = "default";
						emit({
							type: "session_control_rejected",
							control: "permission_mode",
							attempted_value: "auto",
							authoritative_value: "default",
							...(sessionId ? { session_id: sessionId } : {}),
						});
						emit({
							type: "status",
							state: this.state,
							model: this.model,
							permission_mode: this.statusPermissionMode(),
							...this.approvalsReviewerStatusField(),
							effort: this.effort,
							...(this.currentTurnId ? { turn_id: this.currentTurnId } : {}),
						});
					}
				}
				break;
			case "session_start":
				await this.handleSessionStart(
					event,
					sessionId,
					provider,
					turn.providerOwnershipGeneration,
					emit,
				);
				break;
			case "provider_context_reset":
				await this.handleProviderContextReset(
					event,
					sessionId,
					provider,
					turn.providerOwnershipGeneration,
					emit,
				);
				break;
			case "provider_history_warning":
				await this.handleProviderHistoryWarning(
					event,
					sessionId,
					provider,
					emit,
				);
				break;
			case "transport_error": {
				const limit = providerTransportLimit(event.message);
				if (limit) {
					this.handleRateLimit(
						{
							type: "rate_limit",
							status: "rejected",
							rateLimitType: limit.windowId,
							resetsAt: limit.resetsAt,
						},
						emit,
						provider,
					);
				}
				throw new Error(event.message);
			}
			case "commands_changed":
				emit({
					type: "slash_commands",
					provider_id: provider.providerId,
					...(this.agentCwd ? { agent_cwd: this.agentCwd } : {}),
					...(sessionId ? { session_id: sessionId } : {}),
					commands: event.commands,
				});
				break;
			case "file_checkpoint":
				if (sessionId && turn.userSeq !== null && this.currentTurnId) {
					await db.setMessageCheckpointUuid(
						sessionId,
						turn.userSeq,
						event.id,
						event.providerSessionId,
					);
					emit({
						type: "file_checkpoint",
						session_id: sessionId,
						turn_id: this.currentTurnId,
					});
				}
				break;
			case "provider_peer_message": {
				const continuation = this.currentProviderContinuation;
				if (
					!sessionId ||
					provider.providerId !== "claude" ||
					!continuation ||
					continuation.sessionId !== sessionId ||
					continuation.trigger.kind !== "claude_peer_message"
				) {
					throw new Error(
						"Claude emitted a peer message outside an owned peer continuation",
					);
				}
				if (continuation.peerOriginObserved) {
					throw new Error(
						"Claude peer continuation emitted more than one peer origin",
					);
				}
				if (
					(event.body?.length ?? 0) > CLAUDE_PEER_BODY_MAX_CHARS ||
					(event.fromAddress?.length ?? 0) > CLAUDE_PEER_ADDRESS_MAX_CHARS ||
					(event.claimedName?.length ?? 0) > CLAUDE_PEER_NAME_MAX_CHARS ||
					(event.fromSession?.length ?? 0) > CLAUDE_PEER_SESSION_MAX_CHARS
				) {
					throw new Error("Claude peer message exceeded Hlid's safe bounds");
				}
				continuation.peerOriginObserved = true;
				this.detachProviderContinuationDialogSignal(continuation);
				const { trigger } = continuation;
				const provenance: AskUserQuestionProvenance = {
					provider_id: "claude",
					kind: "provider_dialog",
					source_name:
						event.fromAddress ?? trigger.fromAddress ?? trigger.sourceName,
					summary: "Inbound peer message held for review",
					...(trigger.toolUseId ? { tool_use_id: trigger.toolUseId } : {}),
					peer: {
						preview: trigger.preview,
						...(event.body !== undefined ? { body: event.body } : {}),
						...((event.fromAddress ?? trigger.fromAddress)
							? { from_address: event.fromAddress ?? trigger.fromAddress }
							: {}),
						...((event.claimedName ?? trigger.claimedName)
							? { claimed_name: event.claimedName ?? trigger.claimedName }
							: {}),
						...(event.fromSession ? { from_session: event.fromSession } : {}),
						...((event.verifiedPeerPid ?? trigger.verifiedPeerPid)
							? {
									verified_peer_pid:
										event.verifiedPeerPid ?? trigger.verifiedPeerPid,
								}
							: {}),
						...(trigger.holdCause ? { hold_cause: trigger.holdCause } : {}),
					},
				};
				await db.setAskUserQuestionProvenance(
					sessionId,
					trigger.interactionId,
					JSON.stringify(provenance),
				);
				emit({
					type: "ask_user_question_provenance_updated",
					id: trigger.interactionId,
					provenance,
				});
				break;
			}
			case "assistant_message_boundary":
				if (
					!this.providerDirectContributionAccepted(
						event.providerFrame,
						turn,
						"boundary",
					)
				) {
					break;
				}
				turn.assistantMessageBoundaryPending = true;
				break;
			case "text_delta":
				this.handleTextDelta(event, turn, sessionId, emit);
				break;
			case "result_text_fallback":
				await this.handleResultTextFallback(
					event,
					turn,
					sessionId,
					emit,
					provider,
				);
				break;
			case "text_replace":
				this.handleTextReplacement(event, turn, sessionId, emit);
				break;
			case "assistant_message_id":
				await this.handleAssistantMessageId(event, turn, sessionId);
				break;
			case "provider_message_frame":
				await this.handleProviderMessageFrame(event, turn, sessionId, provider);
				break;
			case "provider_message_retraction":
				await this.handleProviderMessageRetraction(
					event,
					turn,
					sessionId,
					emit,
					provider,
				);
				break;
			case "provider_permission_denied":
				await this.handleProviderPermissionDenied(
					event,
					turn,
					sessionId,
					emit,
					provider,
				);
				break;
			case "provider_refusal":
				if (
					event.outcome === "fallback" &&
					event.scope === "local" &&
					event.fallbackModel
				) {
					turn.localFallbackModel = event.fallbackModel;
					for (
						let index = turn.actualModelObservations.length - 1;
						index >= 0;
						index--
					) {
						const observation = turn.actualModelObservations[index];
						if (observation?.model !== event.fallbackModel) break;
						observation.local = true;
					}
					turn.lastActualModel =
						[...turn.actualModelObservations]
							.reverse()
							.find((observation) => !observation.local)?.model ?? null;
				}
				void db.appendLog(
					event.outcome === "no_fallback" ? "warn" : "info",
					provider.providerId,
					event.outcome === "no_fallback"
						? "Claude model refusal had no fallback"
						: "Claude model refusal fallback",
					{
						sessionId,
						providerSessionId: event.providerSessionId,
						originalModel: event.originalModel,
						fallbackModel: event.fallbackModel,
						direction: event.direction,
						scope: event.scope,
						requestId: event.requestId,
						refusedUserMessageUuid: event.refusedUserMessageUuid,
						category: event.category,
						explanation: event.explanation,
						content: event.content.slice(0, 2_000),
					},
				);
				break;
			case "provider_turn_id":
				this.handleProviderTurnId(event, turn, sessionId);
				break;
			case "tool_start":
				await this.handleToolStart(event, turn, sessionId, emit, provider);
				break;
			case "tool_update":
				this.handleToolUpdate(event, turn, sessionId, emit);
				break;
			case "tool_activity_update":
				this.handleToolActivityUpdate(event, turn, sessionId, emit);
				break;
			case "tool_progress":
				this.handleToolProgress(event, turn, emit);
				break;
			case "tool_result":
				await this.handleToolResult(event, turn, sessionId, emit, provider);
				break;
			case "generated_media":
				await this.handleGeneratedMedia(event, turn, sessionId, emit, provider);
				break;
			case "usage":
				this.handleUsage(event, turn, emit, provider);
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
				this.emitMcpStatus(event.servers, sessionId, emit, provider);
				break;
			case "done":
				this.settleIncompleteSubagents(turn, sessionId, emit);
				await this.handleDone(event, turn, sessionId, emit, provider);
				return true;
		}
		return false;
	}

	private emitMcpStatus(
		statuses: McpServerStatus[],
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
		provider: AgentProvider,
	): void {
		this.mcpStatusByProvider.set(provider.providerId, statuses);
		const operations = this.getMcpControlOperations();
		emit({
			type: "mcp_status",
			provider_id: provider.providerId,
			...(operations.length ? { operations } : {}),
			...(this.agentCwd ? { agent_cwd: this.agentCwd } : {}),
			...(sessionId ? { session_id: sessionId } : {}),
			servers: statuses.map(mapMcpServer),
		});
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
			this.emitMcpStatus(statuses, sessionId, emit, provider);
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
						session,
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
	async runQuery(
		userMessage: string,
		emit: (msg: ServerMessage) => void,
		options: RunQueryOptions = {},
	): Promise<void> {
		this.assertRealtimeIdle("sending a message");
		const inputOrigin = normalizeAgentInputOrigin(options.inputOrigin);
		const activeTurnArgs = this.currentTurnArgs;
		const acceptedBehindCodexPurposeBuiltTurn = Boolean(
			activeTurnArgs?.options.routineContext &&
				this.resolveProvider(activeTurnArgs.options.agentCwd).providerId ===
					"codex",
		);
		const args: RunQueryArgs = {
			userMessage,
			emit,
			options,
			inputOrigin,
			effortReady: this.effortChangeTail,
			permissionModeReady: this.capturePermissionAcceptanceBarrier(),
			providerSessionModeReady: this.providerSessionModeChangeTail,
			codexPermissionProfileGeneration: this.codexPermissionProfileGeneration,
			acceptedBehindCodexPurposeBuiltTurn,
		};
		if (isDurableInteractiveTurn(args)) {
			args.durableReady = this.persistDurableTurn(args);
		}
		const completion = this.turnQueue.enqueue(args, options.turnId);
		if (!this.isDraining) void this.drainTurnQueue();
		return completion;
	}

	private async persistDurableTurn(args: RunQueryArgs): Promise<boolean> {
		const { sessionId, agentCwd, turnId } = args.options;
		if (!sessionId || !turnId) return false;
		// The pending-turn table owns a real Raven session FK. Create or restore
		// that row before acknowledging durable queue ownership.
		await this.initSessionContext(sessionId, agentCwd, args.userMessage);
		const inserted = await db.enqueuePendingSessionTurn({
			turnId,
			sessionId,
			payloadJson: JSON.stringify(durableTurnPayload(args)),
		});
		if (!inserted) return false;
		if (this.cancelledDurableTurns.delete(turnId)) {
			await db.deletePendingSessionTurn(turnId);
			return false;
		}
		const now = Math.floor(Date.now() / 1_000);
		this.durableTurns.set(turnId, {
			turn_id: turnId,
			session_id: sessionId,
			position: this.durableTurns.size + 1,
			payload_json: JSON.stringify(durableTurnPayload(args)),
			state: "queued",
			provider_id: null,
			window_id: null,
			sleep_reason: null,
			sleep_until: null,
			sleep_target: null,
			sleep_utilization: null,
			cap_deadline: null,
			created_at: now,
			updated_at: now,
		});
		return true;
	}

	private async settleDurableTurn(turnId: string | undefined): Promise<void> {
		if (!turnId || !this.durableTurns.has(turnId)) return;
		this.durableTurns.delete(turnId);
		this.cancelledDurableTurns.delete(turnId);
		await db.deletePendingSessionTurn(turnId);
	}

	/** Rebuild pre-dispatch work loaded from SQLite after a Hlid restart. */
	restoreDurableTurns(
		rows: readonly db.PendingSessionTurnRow[],
		emit: (msg: ServerMessage) => void,
	): number {
		let restored = 0;
		for (const row of rows) {
			let payload: DurableRunQueryPayload;
			try {
				payload = JSON.parse(row.payload_json) as DurableRunQueryPayload;
			} catch {
				void db.deletePendingSessionTurn(row.turn_id);
				continue;
			}
			if (
				typeof payload?.userMessage !== "string" ||
				!payload.userMessage.trim() ||
				typeof payload.options !== "object" ||
				payload.options === null
			) {
				void db.deletePendingSessionTurn(row.turn_id);
				continue;
			}
			this.durableTurns.set(row.turn_id, row);
			if (
				row.state === "sleeping" &&
				row.provider_id &&
				(row.window_id === "five_hour" ||
					row.window_id === "weekly" ||
					row.window_id === "spend_control") &&
				row.sleep_reason
			) {
				restoreSleepDecision(
					row.provider_id,
					{
						reason: row.sleep_reason,
						windowId: row.window_id,
						targetResetsAt: row.sleep_target,
						utilization: row.sleep_utilization,
					},
					loadConfig()?.auto_sleep ?? { resume_buffer_seconds: 0 },
					row.created_at,
				);
			}
			const args: RunQueryArgs = {
				userMessage: payload.userMessage,
				emit,
				inputOrigin: normalizeAgentInputOrigin(payload.inputOrigin),
				effortReady: this.effortChangeTail,
				permissionModeReady: this.capturePermissionAcceptanceBarrier(),
				providerSessionModeReady: this.providerSessionModeChangeTail,
				codexPermissionProfileGeneration: this.codexPermissionProfileGeneration,
				options: {
					...payload.options,
					sessionId: row.session_id,
					turnId: row.turn_id,
				},
				durableReady: Promise.resolve(true),
			};
			void this.turnQueue
				.enqueue(args, row.turn_id)
				.catch((error) => logDbError("restore pending turn", error));
			restored += 1;
		}
		if (restored > 0 && !this.isDraining) void this.drainTurnQueue();
		return restored;
	}

	/**
	 * Explain whether a queued payload can safely join the active provider
	 * turn. Settings, commands, and new file roots retain turn boundaries.
	 */
	private queuedTurnSteeringBlocker(args: RunQueryArgs): string | null {
		const {
			sessionId,
			attachments,
			agentCwd,
			planMode,
			planHtml,
			commandAction,
			routineContext,
			goalStart,
			workspaceReferences,
			delegationContext,
		} = args.options;
		if (this.state !== "running" || !this.currentTurnId) {
			return "There is no active turn to steer.";
		}
		if (!this.agentSession?.steer) {
			return "The active provider does not support steering.";
		}
		if (sessionId && sessionId !== this.currentSessionId) {
			return "The queued message belongs to a different session.";
		}
		if (agentCwd && agentCwd !== this.agentCwd) {
			return "A workspace change must run as a separate turn.";
		}
		if (
			(attachments?.length ?? 0) > 0 ||
			(workspaceReferences?.length ?? 0) > 0
		) {
			return "Messages with file attachments must run as a separate turn.";
		}
		if (delegationContext) {
			return "Delegation context must run as a separate turn.";
		}
		if (commandAction) {
			return "Slash commands must run as a separate turn.";
		}
		if (routineContext || goalStart) {
			return "Goal and Routine turns cannot steer an active turn.";
		}
		if (planMode || planHtml) {
			return "Plan-mode changes must run as a separate turn.";
		}
		return null;
	}

	private operatingBriefFor(
		providerId: string,
		runtimeCwd: string,
		permissionMode: string,
	): HlidOperatingBriefResult {
		const result = buildHlidOperatingBriefResult({
			providerId,
			model: this.model,
			effort: this.effort,
			permissionMode,
			policyEnforced: this.policyEnforced,
			runtimeCwd,
			sessionId: this.currentSessionId ?? undefined,
			vaultName: this.vaultName,
			agentMode: this.agentMode,
		});
		const providerKey = `${providerId}|${this.currentSessionId ?? "ephemeral"}`;
		if (
			this.operatingBriefProviderKey === providerKey &&
			!this.providerHandoffPending
		) {
			return { ...result, text: "" };
		}
		return result;
	}

	private async toolLoadingFor(
		provider: AgentProvider,
	): Promise<HlidToolLoadingSummary[] | undefined> {
		return provider.hlidToolLoading
			? await provider.hlidToolLoading()
			: undefined;
	}

	private async buildQueuedSteeringPrompt(args: RunQueryArgs): Promise<{
		prompt: string;
		safeSkillContexts: string[];
		safeVaultReferences: string[];
		contextManifest: HlidTurnContextManifest;
	}> {
		const { userMessage } = args;
		const { skillContexts, vaultReferences } = args.options;
		const runtimeCwd =
			this.agentMode === "cwd" && this.agentCwd
				? this.agentCwd
				: this.vaultPath;
		const provider = this.resolveProvider(this.agentCwd);
		const operatingBrief = this.operatingBriefFor(
			provider.providerId,
			runtimeCwd,
			this.permissionMode,
		);
		const toolLoading = await this.toolLoadingFor(provider);
		const built = await buildPromptAsync({
			vaultPath: this.vaultPath,
			providerId: provider.providerId,
			vaultName: this.vaultName,
			allowedAgentRealPaths: this.allowedAgentRealPaths,
			agentMode: this.agentMode,
			agentCwd: this.agentCwd,
			claudeSessionId: this.providerSessionId,
			runtimeCwd,
			operatingBrief: operatingBrief.text,
			operatingBriefVersion: HLID_OPERATING_CONTRACT_VERSION,
			operatingBriefRevision: operatingBrief.revision,
			operatingBriefPreview: operatingBrief.preview,
			operatingBriefDelivery: operatingBrief.text
				? "included"
				: "already-established",
			userMessage,
			skillContexts,
			attachments: [],
			vaultReferences,
			workspaceReferences: [],
			nativeAudio: false,
			readVaultReference: (relativePath: string) =>
				readObsidianNote(this.vaultName, relativePath),
		});
		return {
			prompt: built.prompt,
			safeSkillContexts: built.safeSkillContexts ?? [],
			safeVaultReferences: (built.safeVaultReferences ?? []).map(
				(reference) => reference.relativePath,
			),
			contextManifest: finalizeHlidTurnContextManifest(built.contextManifest, {
				delivery: "steer",
				providerId: provider.providerId,
				model: this.model,
				effort: this.effort,
				permissionMode: this.permissionMode,
				providerPromptChars: built.prompt.length,
				...(toolLoading ? { toolLoading } : {}),
			}),
		};
	}

	private captureActiveSteeringTarget(
		args: RunQueryArgs,
	): ActiveSteeringTarget {
		const blocker = this.queuedTurnSteeringBlocker(args);
		if (blocker) throw new Error(blocker);
		const turnId = this.currentTurnId;
		const agentSession = this.agentSession;
		const turnState = this.currentTurnState;
		const steer = agentSession?.steer;
		if (!turnId || !agentSession || !turnState || !steer) {
			throw new Error("There is no active provider turn to steer.");
		}
		return {
			turnId,
			sessionId: this.currentSessionId,
			agentSession,
			steer: steer.bind(agentSession),
			turnState,
			assistantSeqAtCapture: turnState.reservedAssistantSeq,
			handoff: this.currentDelegationHandoff,
		};
	}

	private assertActiveSteeringTarget(target: ActiveSteeringTarget): void {
		if (
			this.currentTurnId !== target.turnId ||
			this.currentSessionId !== target.sessionId ||
			this.agentSession !== target.agentSession ||
			this.currentTurnState !== target.turnState
		) {
			throw new Error(
				"The active provider turn changed while steering was being prepared. The instruction was not sent; retry only against the intended active turn.",
			);
		}
	}

	private async deliverPreparedSteer(
		args: RunQueryArgs,
		turnId: string,
		prepared: Awaited<ReturnType<SessionManager["buildQueuedSteeringPrompt"]>>,
		target: ActiveSteeringTarget,
		onAccepted?: () => void,
	): Promise<SteeringReceipt> {
		this.assertActiveSteeringTarget(target);
		await target.steer(prepared.prompt, {
			inputOrigin: args.inputOrigin,
		});
		const steerToolEventIndex = target.turnState.rawToolEventCount;
		onAccepted?.();
		try {
			if (prepared.contextManifest.operatingBrief?.included) {
				this.operatingBriefProviderKey = `${prepared.contextManifest.providerId}|${target.sessionId ?? "ephemeral"}`;
			}
			const { userMessage } = args;
			const { sessionId } = args.options;
			let steerTargetSeq =
				target.assistantSeqAtCapture ??
				target.turnState.reservedAssistantSeq ??
				(target.turnState.lastAssistantSeq >= 0
					? target.turnState.lastAssistantSeq
					: undefined);
			if (sessionId) {
				if (steerTargetSeq === undefined) {
					steerTargetSeq = this.ensureAssistantRow(target.turnState, sessionId);
				}
				if (steerTargetSeq === target.turnState.reservedAssistantSeq) {
					await target.turnState.assistantRowWrite;
				}
			}
			const steerSeq = await this.persistUserMessage(
				sessionId,
				userMessage,
				[],
				turnId,
				prepared.safeVaultReferences,
				[],
				steerTargetSeq,
				prepared.contextManifest,
				steerToolEventIndex,
			);
			if (sessionId && steerTargetSeq === undefined) {
				const allocatedAfterAcceptance =
					target.turnState.reservedAssistantSeq ??
					(target.turnState.lastAssistantSeq >= 0
						? target.turnState.lastAssistantSeq
						: undefined);
				target.turnState.pendingSteerTargetSeqs.add(steerSeq);
				if (allocatedAfterAcceptance !== undefined) {
					await this.backfillPendingSteerTargets(
						sessionId,
						target.turnState,
						allocatedAfterAcceptance,
					);
					steerTargetSeq = allocatedAfterAcceptance;
				}
			}
			if (target.handoff) {
				target.handoff.skillContexts = [
					...new Set([
						...target.handoff.skillContexts,
						...prepared.safeSkillContexts,
					]),
				];
				target.handoff.vaultReferences = [
					...new Set([
						...target.handoff.vaultReferences,
						...prepared.safeVaultReferences,
					]),
				];
			}
			return {
				targetTurnId: target.turnId,
				...(steerTargetSeq !== undefined
					? { targetAssistantSeq: steerTargetSeq }
					: {}),
				steerSeq,
				steerToolEventIndex,
			};
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(
				`The provider accepted the steering instruction, but Hlid could not persist its transcript record: ${detail}. Do not retry this instruction automatically because that may duplicate it.`,
			);
		}
	}

	/**
	 * Fold one pending prompt into the active native provider turn. The pending
	 * queue promise is settled only after the provider accepts the steer. A
	 * rejected or raced request is restored at its original queue position.
	 */
	// fallow-ignore-next-line unused-class-member -- Called by the WebSocket steer_queued dispatch in wsHandlers.
	async steerQueued(turnId: string): Promise<false | SteeringReceipt> {
		const pending = this.turnQueue
			.pendingTurns()
			.find((turn) => turn.turnId === turnId);
		if (!pending) return false;
		const target = this.captureActiveSteeringTarget(pending.args);
		const prepared = await this.buildQueuedSteeringPrompt(pending.args);
		this.assertActiveSteeringTarget(target);
		const extracted = this.turnQueue.extract(turnId);
		if (!extracted) return false;
		let accepted = false;
		try {
			const receipt = await this.deliverPreparedSteer(
				extracted.turn.args,
				turnId,
				prepared,
				target,
				() => {
					accepted = true;
				},
			);
			await this.settleDurableTurn(turnId);
			extracted.turn.resolve();
			return receipt;
		} catch (error) {
			if (!accepted) {
				this.turnQueue.restore(extracted);
				if (!this.isDraining) void this.drainTurnQueue();
			} else {
				await this.settleDurableTurn(turnId).catch((settleError) =>
					logDbError("settle steered pending turn", settleError),
				);
				extracted.turn.resolve();
			}
			throw error;
		}
	}

	/**
	 * Deliver a Hlid-owned child instruction only through the provider's native
	 * active-turn steering primitive. This never queues a fallback turn.
	 */
	// fallow-ignore-next-line unused-class-member -- Called by HlidDelegationManager.
	async steerActiveTurn(
		instruction: string,
		emit: (msg: ServerMessage) => void,
		sessionId: string,
		turnId: string,
		inputOrigin: AgentInputOrigin,
	): Promise<SteeringReceipt> {
		const capturedInputOrigin = normalizeAgentInputOrigin(inputOrigin);
		const args: RunQueryArgs = {
			userMessage: instruction,
			emit,
			inputOrigin: capturedInputOrigin,
			codexPermissionProfileGeneration: this.codexPermissionProfileGeneration,
			options: {
				sessionId,
				attachments: [],
				agentCwd: this.agentCwd,
				turnId,
				inputOrigin: capturedInputOrigin,
			},
		};
		const target = this.captureActiveSteeringTarget(args);
		const prepared = await this.buildQueuedSteeringPrompt(args);
		this.assertActiveSteeringTarget(target);
		return this.deliverPreparedSteer(args, turnId, prepared, target);
	}

	/**
	 * Slice C polish: snapshot of the server's queue state. Used by clients
	 * (on connect / sync) to prune orphan chatQueue entries that no longer have
	 * a matching durable or in-memory turn.
	 */
	getQueueState(): QueueStateSnapshot {
		const pendingTurns = this.turnQueue.pendingTurns().flatMap((turn) => {
			const id = turn.turnId;
			return id ? [this.queueTurnSnapshot(turn.args, id)] : [];
		});
		const runningTurn =
			this.currentTurnId && this.currentTurnArgs
				? this.queueTurnSnapshot(this.currentTurnArgs, this.currentTurnId)
				: undefined;
		return {
			pending_turn_ids: this.turnQueue.pendingTurnIds(),
			pending_turns: pendingTurns,
			running_turn_id:
				this.state === "running" ? (this.currentTurnId ?? null) : null,
			...(runningTurn ? { running_turn: runningTurn } : {}),
		};
	}

	private queueTurnSnapshot(
		args: RunQueryArgs,
		id: string,
	): NonNullable<QueueStateSnapshot["pending_turns"]>[number] {
		const o = args.options;
		const sessionId = o.sessionId ?? this.currentSessionId ?? "";
		return {
			id,
			text: args.userMessage,
			session_id: sessionId,
			...(typeof o.skillContexts === "string"
				? { skill_context: o.skillContexts }
				: o.skillContexts?.length
					? { skill_contexts: o.skillContexts }
					: {}),
			...(o.attachments ? { attachments: o.attachments } : {}),
			...(o.agentCwd ? { agent_cwd: o.agentCwd } : {}),
			...(o.planMode !== undefined ? { plan_mode: o.planMode } : {}),
			...(o.planHtml !== undefined ? { plan_html: o.planHtml } : {}),
			...(o.commandAction ? { command_action: o.commandAction } : {}),
			...(o.vaultReferences?.length
				? { vault_references: o.vaultReferences }
				: {}),
			steerable: this.queuedTurnSteeringBlocker(args) === null,
			...(o.workspaceReferences?.length
				? { workspace_references: o.workspaceReferences }
				: {}),
			...(o.goalStart
				? {
						goal: {
							objective: o.goalStart.objective,
							...(o.goalStart.tokenBudget !== undefined
								? { token_budget: o.goalStart.tokenBudget }
								: {}),
						},
					}
				: {}),
		};
	}

	cancelQueued(turnId: string): boolean {
		const pending = this.turnQueue
			.pendingTurns()
			.find((turn) => turn.turnId === turnId);
		if (!pending || !this.turnQueue.cancel(turnId)) return false;
		if (isDurableInteractiveTurn(pending.args)) {
			this.cancelledDurableTurns.add(turnId);
			this.durableTurns.delete(turnId);
			void db
				.deletePendingSessionTurn(turnId)
				.catch((error) => logDbError("cancel pending turn", error));
		}
		return true;
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
		const pending = this.turnQueue
			.pendingTurns()
			.find((turn) => turn.turnId === turnId);
		if (!pending || !this.turnQueue.promote(turnId)) return false;
		const sessionId = pending.args.options.sessionId;
		if (sessionId && isDurableInteractiveTurn(pending.args)) {
			void (pending.args.durableReady ?? Promise.resolve(true))
				.then((accepted) =>
					accepted
						? db.promotePendingSessionTurn({ sessionId, turnId })
						: undefined,
				)
				.catch((error) => logDbError("promote pending turn", error));
		}
		// Interrupt current — drain loop's await iterateConversation returns,
		// drain proceeds to the next queue head (the promoted turn).
		if (!this.currentProviderContinuation) {
			void this.agentSession?.interrupt?.();
		}
		return true;
	}

	private async drainTurnQueue(): Promise<void> {
		if (this.isDraining) return;
		this.isDraining = true;

		// Initialize the abortController once for the whole drain. Status
		// running is emitted PER ITERATION below (with turn_id) so the client
		// can distinguish "queued behind" from "currently running."
		const hasQueuedWork =
			this.providerContinuationQueue.length > 0 ||
			this.turnQueue.peek() !== undefined;
		if (hasQueuedWork && this.state !== "running") {
			this.state = "running";
			this.abortController = new AbortController();
		}

		let lastEmit: ((msg: ServerMessage) => void) | null = null;
		try {
			while (
				this.providerContinuationQueue.length > 0 ||
				this.turnQueue.length > 0
			) {
				const providerContinuation = this.providerContinuationQueue.shift();
				if (providerContinuation) {
					if (this.suspendingForRestart) {
						this.settleProviderContinuationReady(providerContinuation, false);
						break;
					}
					if (this.state === "error") this.state = "running";
					lastEmit = providerContinuation.emit;
					this.currentTurnId = undefined;
					this.currentTurnArgs = null;
					await this.runProviderContinuation(providerContinuation);
					this.retireClaudeProgressSummaryRuntimeIfSafe({
						betweenTurns: true,
					});
					if (this.restartCodexRuntimeForPermissionProfile) {
						await this.refreshAndRetireCodexPermissionProfileRuntimeIfSafe({
							betweenTurns: true,
						});
					}
					continue;
				}
				const next = this.turnQueue.shift();
				if (!next) break;
				if (this.suspendingForRestart) break;
				// Recover from a prior turn's error so the next queued turn runs
				// cleanly. Per-turn errors are already signaled to the UI via the
				// "error" event emitted from runOneTurn.
				if (this.state === "error") this.state = "running";
				lastEmit = next.args.emit;
				this.currentTurnId = next.turnId;
				this.currentTurnArgs = next.args;
				try {
					if (next.args.durableReady && !(await next.args.durableReady)) {
						next.resolve();
						continue;
					}
					await this.runOneTurn(next.args);
					next.resolve();
				} catch (err) {
					if (!this.suspendingForRestart) {
						await this.settleDurableTurn(next.turnId).catch((error) =>
							logDbError("settle pending turn", error),
						);
					}
					next.reject(err instanceof Error ? err : new Error(String(err)));
				} finally {
					this.retireClaudeProgressSummaryRuntimeIfSafe({
						betweenTurns: true,
					});
					if (this.restartCodexRuntimeForPermissionProfile) {
						await this.refreshAndRetireCodexPermissionProfileRuntimeIfSafe({
							betweenTurns: true,
						});
					}
				}
			}
		} finally {
			this.isDraining = false;
			this.currentTurnArgs = null;
			this.currentProviderContinuation = null;
			this.abortController = null;
			if (this.restartProviderRuntimeAfterTurn && this.agentSession) {
				this.stopBackgroundActivityObserver();
				this.agentSession.cancel();
				this.agentSession = null;
				this.agentSessionKey = null;
				this.restartProviderRuntimeAfterTurn = false;
			}
			// Settle final state. Per-turn errors set state="error" via the
			// runOneTurn catch; preserve that. Otherwise return to idle.
			if (this.state === "running") this.state = "idle";
			this.retireClaudeProgressSummaryRuntimeIfSafe();
			if (this.restartCodexRuntimeForPermissionProfile) {
				await this.refreshAndRetireCodexPermissionProfileRuntimeIfSafe();
			}
			// An idle/error session is not sleeping. The status message clears the
			// client banner; clear the replay copy as the matching server invariant.
			this.sleepState = null;
			this.sleepEmit = null;
			lastEmit?.({
				type: "status",
				state: this.state,
				model: this.model,
				permission_mode: this.statusPermissionMode(),
				...this.approvalsReviewerStatusField(),
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
		signal?: AbortSignal,
	): Promise<"proceeded" | "aborted"> {
		const cfg = loadConfig()?.auto_sleep;
		if (!cfg?.enabled) return "proceeded";
		const providerId = provider.providerId;
		const durable = this.currentTurnId
			? this.durableTurns.get(this.currentTurnId)
			: undefined;
		let recoverable = durable?.state !== "dispatching" ? durable : undefined;
		return sleepUntilAllowed({
			providerId,
			cfg,
			signal: signal ?? this.abortController?.signal ?? undefined,
			capDeadline: recoverable?.cap_deadline,
			onSleep: async (decision: SleepDecision) => {
				this.publishSleepState(providerId, decision, emit);
				if (!recoverable) return;
				const capDeadline = decision.capApplied
					? (recoverable.cap_deadline ?? decision.until)
					: recoverable.cap_deadline;
				const updated: db.PendingSessionTurnRow = {
					...recoverable,
					state: "sleeping",
					provider_id: providerId,
					window_id: decision.windowId,
					sleep_reason: decision.reason,
					sleep_until: decision.until,
					sleep_target: decision.targetResetsAt,
					sleep_utilization: decision.utilization,
					cap_deadline: capDeadline,
					updated_at: Math.floor(Date.now() / 1_000),
				};
				this.durableTurns.set(recoverable.turn_id, updated);
				recoverable = updated;
				await db.markPendingSessionTurnSleeping({
					turnId: recoverable.turn_id,
					providerId,
					windowId: decision.windowId,
					reason: decision.reason,
					until: decision.until,
					target: decision.targetResetsAt,
					utilization: decision.utilization,
					capDeadline,
				});
			},
			onWake: async (cause) => {
				this.clearSleepState(providerId, cause, emit);
				if (!recoverable || this.suspendingForRestart) return;
				// Keep the last sleep decision durable until the provider-dispatch
				// boundary. If Hlid stops while prompt construction is underway, the
				// restored gate can still prove whether this turn may proceed. A manual
				// Resume now becomes an expired cap so that choice also survives.
				const sleepingProviderId = recoverable.provider_id;
				const sleepingWindowId = recoverable.window_id;
				const sleepingReason = recoverable.sleep_reason;
				const sleepingUntil = recoverable.sleep_until;
				if (
					cause === "skipped" &&
					sleepingProviderId &&
					sleepingWindowId &&
					sleepingReason &&
					sleepingUntil != null
				) {
					const capDeadline = Math.floor(Date.now() / 1_000);
					recoverable = { ...recoverable, cap_deadline: capDeadline };
					this.durableTurns.set(recoverable.turn_id, recoverable);
					await db.markPendingSessionTurnSleeping({
						turnId: recoverable.turn_id,
						providerId: sleepingProviderId,
						windowId: sleepingWindowId,
						reason: sleepingReason,
						until: sleepingUntil,
						target: recoverable.sleep_target,
						utilization: recoverable.sleep_utilization,
						capDeadline,
					});
				}
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
			sleepingWindow === "five_hour" ||
				sleepingWindow === "weekly" ||
				sleepingWindow === "spend_control"
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
			{
				toolUseID,
				signal,
				title,
				displayName,
				description,
				allowOnce,
				allowSession,
				allowAlways,
				agentID,
				interaction,
			},
		) => {
			if (
				interaction?.peer === undefined &&
				(await this.gateOnUsage(provider, emit)) === "aborted"
			) {
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
						signal,
						interaction,
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
					allowOnce,
					allowSession,
					allowAlways,
					agentID,
					signal,
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
		signal: AbortSignal,
		interaction: Omit<AskUserQuestionProvenance, "turn_id"> | undefined,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
		resolve: (decision: AgentToolDecision) => void,
	): void {
		const { questions } = parseAskUserQuestion(passInput, title);
		const provenance: AskUserQuestionProvenance | undefined = interaction
			? {
					...interaction,
					...(interaction.peer === undefined &&
					this.currentTurnArgs &&
					this.currentTurnId
						? { turn_id: this.currentTurnId }
						: {}),
				}
			: undefined;
		const request = {
			type: "ask_user_question" as const,
			id: toolUseID,
			questions,
			...(provenance ? { provenance } : {}),
		};
		const persistence = sessionId
			? db.appendAskUserQuestion(
					sessionId,
					toolUseID,
					this.messageSeq++,
					JSON.stringify(questions),
					provenance ? JSON.stringify(provenance) : null,
				)
			: Promise.resolve();
		this.askUserQuestionPersistence.set(toolUseID, {
			...(sessionId ? { sessionId } : {}),
			pending: persistence,
			request,
			emit,
		});
		void persistence.catch((error) => {
			logDbError("appendAskUserQuestion", error);
			if (!this.askUserQuestions.has(toolUseID)) return;
			this.askUserQuestions.complete(toolUseID, {
				[ASK_USER_QUESTION_CANCEL_KEY]: [],
			});
			this.emitAskUserQuestionCancellation(request, sessionId, emit);
		});
		if (!sessionId) {
			this.messageSeq++;
		}
		const onAbort = () => {
			if (!this.askUserQuestions.has(toolUseID)) return;
			this.askUserQuestions.complete(toolUseID, {});
			this.emitAskUserQuestionCancellation(request, sessionId, emit);
		};
		this.askUserQuestions.register(toolUseID, request, (answers, notes) => {
			signal.removeEventListener("abort", onAbort);
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
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) {
			onAbort();
			return;
		}
		emit(request);
	}

	private emitAskUserQuestionCancellation(
		request: Extract<ServerMessage, { type: "ask_user_question" }>,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
	): void {
		emit({
			type: "ask_user_question_resolved",
			id: request.id,
			answers: { [ASK_USER_QUESTION_CANCEL_KEY]: [] },
		});
		const persistence = this.askUserQuestionPersistence.get(request.id);
		if (!sessionId) {
			this.askUserQuestionPersistence.delete(request.id);
			return;
		}
		void (persistence?.pending ?? Promise.resolve())
			.then(() =>
				db.setAskUserQuestionResolution(
					sessionId,
					request.id,
					JSON.stringify({ [ASK_USER_QUESTION_CANCEL_KEY]: [] }),
					null,
				),
			)
			.catch((error) => logDbError("cancel ask user question", error))
			.finally(() => this.askUserQuestionPersistence.delete(request.id));
	}

	private cancelAllAskUserQuestions(): void {
		const pending = this.askUserQuestions.getPending();
		this.askUserQuestions.clearAll();
		for (const request of pending) {
			const persistence = this.askUserQuestionPersistence.get(request.id);
			const emit =
				persistence?.emit ?? this.currentTurnArgs?.emit ?? this.sessionEmit;
			if (!emit) continue;
			this.emitAskUserQuestionCancellation(
				request,
				persistence?.sessionId,
				persistence?.emit ?? emit,
			);
		}
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
			this.currentTurnPermissionMode === "plan" &&
				this.currentTurnArgs &&
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
					input: { task },
					policy: { source: "umbod" as const, reason },
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
		allowOnce: boolean | undefined;
		allowSession: boolean | undefined;
		allowAlways: boolean | undefined;
		agentID: string | undefined;
		signal: AbortSignal;
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
			allowOnce,
			allowSession,
			allowAlways,
			agentID,
			signal,
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
						`${provider.label ?? provider.providerId} requests ${permissionToolDisplayName(toolName)}`),
			displayName:
				obsidianCommand !== null
					? "Obsidian command"
					: (displayName ?? permissionToolDisplayName(toolName)),
			description:
				obsidianCommand !== null
					? `Always applies only to command ${obsidianCommand.commandId} in the configured ${this.vaultName} vault.`
					: description,
			input: passInput as Record<string, unknown> | undefined,
			requester: agentID
				? { providerId: provider.providerId, agentId: agentID }
				: undefined,
			...(toolName.startsWith("hlid.windows_computer_use:")
				? { allowOnce: false }
				: allowOnce !== undefined
					? { allowOnce }
					: {}),
			...(allowSession !== undefined ? { allowSession } : {}),
			...(allowAlways !== undefined ? { allowAlways } : {}),
		};
		let denyMessage: string | undefined;
		let approvalSaveScope: "session" | "local" | undefined;
		const isWindowsComputerUseApproval = toolName.startsWith(
			"hlid.windows_computer_use:",
		);
		let routineDecision: Promise<"allow" | "block"> | null = null;
		const prompt = async (reason?: string) => {
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
			if (
				this.sessionAllowedTools.has(permissionKey) ||
				(obsidianCommand !== null &&
					this.rememberedObsidianCommands.has(obsidianCommand.commandId))
			) {
				if (obsidianCommand === null) approvalSaveScope = "session";
				return "allow" as const;
			}
			const approvalInput = await obsidianCommandApprovalInput(
				toolName,
				passInput,
				this.vaultName,
			);
			const approvalRequest = { ...request, input: approvalInput };
			return new Promise<"allow" | "block">((finish) => {
				let settled = false;
				let emitted = false;
				const onAbort = () => {
					if (settled) return;
					const pending = this.permissions
						.getPending()
						.some((candidate) => candidate.id === toolUseID);
					if (!pending) return;
					if (emitted) {
						emit({
							type: "permission_resolved",
							id: toolUseID,
							toolName,
							displayName: approvalRequest.displayName,
							decision: "denied",
						});
					}
					this.permissions.complete(
						toolUseID,
						false,
						undefined,
						"Provider cleared the request",
					);
				};
				this.permissions.register(
					toolUseID,
					{
						...approvalRequest,
						policy: reason ? { source: "umbod" as const, reason } : undefined,
					},
					(approved, saveScope, customDenyMessage) => {
						if (settled) return;
						settled = true;
						signal.removeEventListener("abort", onAbort);
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
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) onAbort();
				if (!settled) {
					emitted = true;
					emit({
						...approvalRequest,
						policy: reason ? { source: "umbod" as const, reason } : undefined,
					});
				}
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
			this.currentTurnPermissionMode === "bypassPermissions" &&
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
			permission_mode: this.statusPermissionMode(),
			...this.approvalsReviewerStatusField(),
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
		workspaceReferences: ResolvedWorkspaceReference[] = [],
		steerTargetSeq?: number,
		contextManifest?: HlidTurnContextManifest,
		steerToolEventIndex?: number,
	): Promise<number> {
		const existingUserSeq =
			sessionId && turnId
				? await db.getUserMessageSeqByTurnId(sessionId, turnId)
				: null;
		const userSeq = existingUserSeq ?? this.messageSeq++;
		if (!sessionId) return userSeq;
		const persistedMessage = formatVaultReferencedMessage(
			userMessage,
			vaultReferences,
			attachments
				.filter((attachment) => attachment.reference === "relic")
				.map((attachment) => attachment.filename),
			workspaceReferences,
		);
		if (existingUserSeq !== null) {
			// A restart can occur after the transcript write but before provider
			// dispatch. Reuse that row rather than duplicating the visible prompt.
		} else if (turnId && steerToolEventIndex !== undefined) {
			await db.appendMessage(
				sessionId,
				userSeq,
				"user",
				persistedMessage,
				turnId,
				steerTargetSeq,
				contextManifest ? JSON.stringify(contextManifest) : undefined,
				steerToolEventIndex,
			);
		} else if (turnId) {
			if (steerTargetSeq !== undefined) {
				await db.appendMessage(
					sessionId,
					userSeq,
					"user",
					persistedMessage,
					turnId,
					steerTargetSeq,
					contextManifest ? JSON.stringify(contextManifest) : undefined,
				);
			} else {
				await db.appendMessage(
					sessionId,
					userSeq,
					"user",
					persistedMessage,
					turnId,
					undefined,
					contextManifest ? JSON.stringify(contextManifest) : undefined,
				);
			}
		} else {
			await db.appendMessage(
				sessionId,
				userSeq,
				"user",
				persistedMessage,
				undefined,
				undefined,
				contextManifest ? JSON.stringify(contextManifest) : undefined,
			);
		}
		for (const attachment of attachments) {
			if (attachment.reference === "relic") continue;
			await db
				.linkAttachmentToMessage(attachment.id, sessionId, userSeq)
				.catch((error) => {
					console.error("[session] linkAttachmentToMessage failed:", error);
				});
		}
		return userSeq;
	}

	private async markDurableTurnDispatching(
		turnId: string | undefined,
	): Promise<void> {
		if (!turnId) return;
		const durable = this.durableTurns.get(turnId);
		if (!durable || durable.state === "dispatching") return;
		await db.markPendingSessionTurnDispatching(turnId);
		this.durableTurns.set(turnId, {
			...durable,
			state: "dispatching",
			updated_at: Math.floor(Date.now() / 1_000),
		});
	}

	private createDetachedRealtimeAgentSession(options: {
		provider: AgentProvider;
		activeCwd: string;
		executable: string | undefined;
		agentSettings: AgentSettings | undefined;
		agentMode: "cwd" | "context";
	}): AgentSession {
		const { provider, activeCwd, executable, agentSettings, agentMode } =
			options;
		return provider.query(
			buildAgentQueryParams({
				activeCwd,
				providerId: provider.providerId,
				vaultName: this.vaultName,
				agentMode,
				hostSessionId: undefined,
				resumeProviderSessionId: null,
				historyResumeMode: "none",
				persistSession: false,
				extraDirs: new Set(),
				signal: undefined,
				agentSettings,
				modelOverride: this.modelOverrideForProvider(provider.providerId),
				effortOverride: this.effortOverride,
				serviceTierOverride: this.serviceTierOverride,
				defaultModel: this.agentCwd ? undefined : this.model,
				configuredPermissionMode: "default",
				approvalsReviewer: undefined,
				planMode: false,
				planHtmlPath: null,
				defaultEffort: this.effort,
				defaultMaxTurns: 1,
				executable,
				windowsComputerUse: undefined,
				policyEnforced: false,
				usageGateEnforced: false,
				codexRealtimeEnabled: this.codexRealtimeEnabled,
				sandboxModeOverride: "read-only",
				beforeToolUse: undefined,
				canUseTool: async () => ({
					behavior: "deny",
					message: "Isolated speech sessions cannot use tools.",
				}),
			}),
		);
	}

	private codexPermissionProfileRuntimeTarget(options: {
		providerId: string;
		sessionId: string | undefined;
		useCodexPermissionProfile?: boolean;
		forceOrdinaryCodexRuntime?: boolean;
	}): {
		eligible: boolean;
		permissionProfile: string | undefined;
		purposeBuilt: boolean;
		key: string;
	} {
		const eligible =
			options.providerId === "codex" &&
			(options.useCodexPermissionProfile ?? true) &&
			(options.forceOrdinaryCodexRuntime || !this.activeRoutineContext);
		const permissionProfile = eligible
			? this.codexPermissionProfile
			: undefined;
		const purposeBuilt = options.providerId === "codex" && !eligible;
		const suffix =
			options.providerId === "codex"
				? `|codex-permissions:${
						purposeBuilt
							? "purpose-built"
							: permissionProfile
								? `selected:${encodeURIComponent(permissionProfile)}`
								: "hlid-sandbox"
					}`
				: "";
		return {
			eligible,
			permissionProfile,
			purposeBuilt,
			key: `${options.providerId}|${options.sessionId ?? "ephemeral"}|${this.agentSessionContextKey()}${suffix}`,
		};
	}

	/**
	 * Keep the vault singleton and an explicit copy of its path on one provider
	 * runtime. A new chat can clear and then restore that path across its first
	 * restore/config-sync boundary without changing the process cwd. Preserve a
	 * distinct identity when a configured agent there changes runtime behavior.
	 */
	private agentSessionContextKey(): string {
		if (!this.agentCwd) return "";
		const agentKey = declaredPathKey(this.agentCwd);
		if (agentKey !== declaredPathKey(this.vaultPath)) return agentKey;
		const agentSettings = this.agentSettingsMap.get(agentMapKey(this.agentCwd));
		return this.agentMode === "cwd" && !agentSettings ? "" : agentKey;
	}

	private async prepareCodexPermissionProfileRuntimeForTurn(options: {
		provider: AgentProvider;
		sessionId: string | undefined;
		acceptedProfileGeneration: number;
		acceptedBehindPurposeBuiltTurn: boolean;
		signal: AbortSignal | undefined;
	}): Promise<void> {
		if (
			options.provider.providerId !== "codex" ||
			!this.agentSession ||
			!this.agentSessionKey?.startsWith("codex|")
		) {
			return;
		}
		const session = this.agentSession;
		const target = this.codexPermissionProfileRuntimeTarget({
			providerId: options.provider.providerId,
			sessionId: options.sessionId,
		});
		const keyMismatch = this.agentSessionKey !== target.key;
		const activePurposeBuilt = this.agentSessionKey.endsWith(
			"|codex-permissions:purpose-built",
		);
		const profileReplacement =
			this.restartCodexRuntimeForPermissionProfile &&
			target.eligible &&
			keyMismatch;
		const purposeBoundaryReplacement =
			keyMismatch && (target.purposeBuilt || activePurposeBuilt);
		if (!profileReplacement && !purposeBoundaryReplacement) {
			if (
				this.restartCodexRuntimeForPermissionProfile &&
				target.eligible &&
				!keyMismatch
			) {
				this.restartCodexRuntimeForPermissionProfile = false;
			}
			return;
		}

		await this.refreshCodexBackgroundOwnershipForRuntimeTransition(session);
		if (this.agentSession !== session) return;
		if (!this.hasRunningProviderBackgroundActivities()) {
			if (profileReplacement) {
				this.retireCodexPermissionProfileRuntimeIfSafe({ betweenTurns: true });
			}
			return;
		}

		const acceptedBeforeProfileChange =
			profileReplacement &&
			options.acceptedProfileGeneration < this.codexPermissionProfileGeneration;
		const acceptedBeforePurposeBuiltTurnSettled =
			purposeBoundaryReplacement &&
			activePurposeBuilt &&
			target.eligible &&
			options.acceptedBehindPurposeBuiltTurn;
		if (
			(acceptedBeforeProfileChange || acceptedBeforePurposeBuiltTurnSettled) &&
			session.listBackgroundActivities
		) {
			while (
				this.agentSession === session &&
				this.hasRunningProviderBackgroundActivities()
			) {
				const revision = this.backgroundActivityRevision;
				await this.waitForBackgroundActivityRevision(revision, options.signal);
				if (this.agentSession !== session) return;
				await this.refreshCodexBackgroundOwnershipForRuntimeTransition(session);
			}
			if (this.agentSession === session) {
				this.retireCodexPermissionProfileRuntimeIfSafe({ betweenTurns: true });
			}
			return;
		}

		throw new CodexPermissionProfileBackgroundBlockedError(
			target.purposeBuilt
				? "Wait for Codex background activity to finish before starting this purpose-built runtime."
				: activePurposeBuilt
					? "Wait for the purpose-built Codex runtime's background activity to finish before starting an ordinary turn."
					: "Wait for Codex background activity to finish before starting a turn with the updated permission profile.",
		);
	}

	private async refreshCodexBackgroundOwnershipForRuntimeTransition(
		session: AgentSession,
	): Promise<void> {
		if (!session.listBackgroundActivities) return;
		try {
			await this.refreshOwnedProviderBackgroundActivities(session, "codex");
		} catch {
			throw new CodexPermissionProfileBackgroundBlockedError(
				"Codex background ownership could not be verified. Wait for its background activity to finish before changing runtimes.",
			);
		}
	}

	private async prepareCodexPurposeBuiltRuntimeTransition(options: {
		providerId: string;
		sessionId: string | undefined;
	}): Promise<void> {
		if (
			options.providerId !== "codex" ||
			!this.agentSession ||
			!this.agentSessionKey?.startsWith("codex|")
		) {
			return;
		}
		const target = this.codexPermissionProfileRuntimeTarget({
			...options,
			useCodexPermissionProfile: false,
		});
		if (this.agentSessionKey === target.key) return;

		const session = this.agentSession;
		await this.refreshCodexBackgroundOwnershipForRuntimeTransition(session);
		if (
			this.agentSession === session &&
			this.hasRunningProviderBackgroundActivities()
		) {
			throw new CodexPermissionProfileBackgroundBlockedError(
				"Wait for Codex background activity to finish before starting this purpose-built runtime.",
			);
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
		ownershipGeneration?: number;
		/** Dictation owns an isolated process and must not initialize the ordinary thread. */
		observeBackgroundActivities?: boolean;
		/** Realtime startup must not reconcile ordinary thread preferences. */
		reconcileApprovalsReviewer?: boolean;
		/** Purpose-built runtimes retain Hlid's legacy sandbox envelope. */
		useCodexPermissionProfile?: boolean;
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
			ownershipGeneration = this.providerOwnershipGeneration,
			observeBackgroundActivities = true,
			reconcileApprovalsReviewer = true,
			useCodexPermissionProfile = true,
		} = options;
		const codexTarget = this.codexPermissionProfileRuntimeTarget({
			providerId: provider.providerId,
			sessionId,
			useCodexPermissionProfile,
		});
		const codexPermissionProfileEligible = codexTarget.eligible;
		const codexPermissionProfile = codexTarget.permissionProfile;
		const desiredKey = codexTarget.key;
		const targetIsPurposeBuiltCodex = codexTarget.purposeBuilt;
		const hasRunningBackgroundActivity =
			this.hasRunningProviderBackgroundActivities();
		const activeIsPurposeBuiltCodex =
			this.agentSessionKey?.startsWith("codex|") === true &&
			this.agentSessionKey.endsWith("|codex-permissions:purpose-built");
		if (
			targetIsPurposeBuiltCodex &&
			this.agentSession &&
			this.agentSessionKey !== desiredKey &&
			hasRunningBackgroundActivity
		) {
			throw new CodexPermissionProfileBackgroundBlockedError(
				"Wait for Codex background activity to finish before starting this purpose-built runtime.",
			);
		}
		if (
			codexPermissionProfileEligible &&
			activeIsPurposeBuiltCodex &&
			this.agentSession &&
			this.agentSessionKey !== desiredKey &&
			hasRunningBackgroundActivity
		) {
			throw new CodexPermissionProfileBackgroundBlockedError(
				"Wait for the purpose-built Codex runtime's background activity to finish before starting an ordinary turn.",
			);
		}
		if (
			this.restartCodexRuntimeForPermissionProfile &&
			provider.providerId === "codex" &&
			codexPermissionProfileEligible &&
			this.agentSession &&
			this.agentSessionKey !== desiredKey &&
			hasRunningBackgroundActivity
		) {
			throw new CodexPermissionProfileBackgroundBlockedError(
				"Wait for Codex background activity to finish before starting a turn with the updated permission profile.",
			);
		}
		if (sessionId) this.sessionEmit = emit;
		if (
			this.agentSession &&
			(this.agentSessionKey !== desiredKey ||
				this.restartAgentSessionForEffort ||
				this.restartProviderRuntimeAfterTurn)
		) {
			this.stopBackgroundActivityObserver();
			this.agentSession.cancel();
			this.agentSession = null;
			this.agentSessionKey = null;
			this.effectivePermissionMode = null;
			this.restartAgentSessionForEffort = false;
			this.restartProviderRuntimeAfterTurn = false;
			this.resetEffectiveApprovalsReviewer();
		}
		if (this.agentSession) {
			if (onGoalChange) {
				this.agentSession.setGoalChangeHandler?.(onGoalChange);
			}
			if (observeBackgroundActivities) {
				this.startBackgroundActivityObserver(
					this.agentSession,
					provider.providerId,
				);
			}
			return this.agentSession;
		}
		this.restartProviderRuntimeAfterTurn = false;
		const configuredPermissionMode =
			this.configuredPermissionModeForTurn(agentSettings);
		const autoApproveTools =
			configuredPermissionMode === "bypassPermissions" &&
			!this.policyEnforced &&
			this.usageGateEnforced;
		const reviewerOwnershipGeneration = this.providerOwnershipGeneration;
		const peerInboxEnabled =
			provider.providerId === "claude" &&
			Boolean(sessionId) &&
			this.claudePeerInbox;
		const claude =
			provider.providerId === "claude"
				? {
						agentProgressSummaries: this.claudeAgentProgressSummaries,
					}
				: undefined;
		const codex = codexPermissionProfile
			? { permissionProfile: codexPermissionProfile }
			: undefined;
		const session = provider.query(
			buildAgentQueryParams({
				activeCwd,
				providerId: provider.providerId,
				vaultName: this.vaultName,
				agentMode: this.agentMode,
				hostSessionId: sessionId,
				resumeProviderSessionId,
				historyResumeMode: this.historyResumeMode,
				extraDirs,
				signal: this.abortController?.signal,
				agentSettings,
				modelOverride: this.modelOverrideForProvider(provider.providerId),
				effortOverride: this.effortOverride,
				serviceTierOverride: this.serviceTierOverride,
				defaultModel: this.agentCwd ? undefined : this.model,
				configuredPermissionMode,
				approvalsReviewer: this.activeRoutineContext
					? "user"
					: (this.approvalsReviewer ?? undefined),
				onApprovalsReviewerChange: reconcileApprovalsReviewer
					? (change) =>
							this.reconcileProviderApprovalsReviewer(change, {
								sessionId,
								providerId: provider.providerId,
								ownershipGeneration: reviewerOwnershipGeneration,
								emit,
							})
					: undefined,
				planMode,
				planHtmlPath: this.planHtmlPath,
				defaultEffort: this.effort,
				defaultMaxTurns: this.maxTurns,
				executable,
				windowsComputerUse: this.windowsComputerUse,
				onGoalChange,
				onSessionConfigChange: sessionId
					? (config) => {
							if (
								this.currentSessionId !== sessionId ||
								!this.ownsProviderGeneration(
									provider.providerId,
									ownershipGeneration,
								)
							) {
								return;
							}
							emit({
								type: "provider_config_options",
								provider_id: provider.providerId,
								session_id: sessionId,
								...(this.agentCwd ? { agent_cwd: this.agentCwd } : {}),
								...config,
							});
						}
					: undefined,
				onProviderInitiatedTurn:
					peerInboxEnabled && sessionId
						? (trigger) =>
								this.queueProviderInitiatedTurn({
									trigger,
									sessionId,
									emit: this.sessionEmit ?? emit,
									provider,
									agentSettings,
									ownershipGeneration,
									expectedSessionKey: desiredKey,
								})
						: undefined,
				claudeCrossSessionInbound: peerInboxEnabled ? "hold" : "refuse",
				claude,
				codex,
				policyEnforced: this.policyEnforced,
				usageGateEnforced: this.usageGateEnforced,
				codexRealtimeEnabled: this.codexRealtimeEnabled,
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
		if (observeBackgroundActivities) {
			this.startBackgroundActivityObserver(session, provider.providerId);
		}
		return session;
	}

	private async prepareProviderForTurn(sessionId: string | undefined): Promise<{
		provider: AgentProvider;
		agentSettings: AgentSettings | undefined;
		resumeProviderSessionId: string | null;
		ownershipGeneration: number;
	}> {
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
			? (this.agentProviderMap.get(agentMapKey(this.agentCwd)) ??
				this.vaultProviderId)
			: this.vaultProviderId;
		const agentSettings =
			this.agentCwd && provider.providerId === configuredProviderId
				? this.agentSettingsMap.get(agentMapKey(this.agentCwd))
				: undefined;
		const sameProvider = this.providerSessionProviderId === provider.providerId;
		const resumeProviderSessionId = sameProvider
			? this.providerSessionId
			: null;
		if (!sameProvider) {
			this.providerOwnershipGeneration += 1;
			this.providerSessionId = null;
			this.providerSessionProviderId = provider.providerId;
			this.historyResumeMode = "none";
			this.resetEffectiveApprovalsReviewer();
		}
		const ownershipGeneration = this.providerOwnershipGeneration;
		if (sessionId) {
			await this.enqueueProviderOwnershipWrite(() =>
				db.setSessionProviderId(sessionId, provider.providerId),
			);
			if (
				!this.ownsProviderGeneration(provider.providerId, ownershipGeneration)
			) {
				throw new Error("The provider changed while preparing the turn.");
			}
		}
		return {
			provider,
			agentSettings,
			resumeProviderSessionId,
			ownershipGeneration,
		};
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
		const recapSettings = this.providerRecapSettings.get(
			provider.providerId,
		) ?? {
			turnRecaps: true,
			recapModel: "",
		};
		if (
			!turn.hadToolEvents ||
			!recapSettings.turnRecaps ||
			!turn.lastAssistantText
		)
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
			recapModel: agentSettings?.recapModel ?? recapSettings.recapModel,
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

	private async runOneTurn(args: RunQueryArgs): Promise<void> {
		await (args.providerSessionModeReady ?? this.providerSessionModeChangeTail);
		await (args.effortReady ?? this.effortChangeTail);
		await (args.permissionModeReady ?? this.permissionModeAcceptanceBarrier);
		const authoritativeSessionConfig = this.agentSession?.sessionConfig?.();
		const { userMessage, emit } = args;
		const {
			sessionId,
			skillContexts,
			attachments,
			agentCwd,
			turnId,
			planMode: requestedPlanMode,
			planHtml,
			commandAction,
			vaultReferences,
			routineContext,
			goalStart,
			workspaceReferences,
			delegationContext,
			backgroundSession,
		} = args.options;
		const planMode =
			authoritativeSessionConfig?.activeMode &&
			authoritativeSessionConfig.planModeValue
				? authoritativeSessionConfig.activeMode ===
					authoritativeSessionConfig.planModeValue
				: requestedPlanMode;
		this.currentTurnId = turnId;
		await this.initSessionContext(
			sessionId,
			agentCwd,
			userMessage,
			!backgroundSession,
		);
		await this.syncPlanHtmlPath(Boolean(planMode && planHtml), sessionId);
		this.activeRoutineContext = routineContext ?? null;

		// Slice C: emit status=running AFTER initSessionContext so getCurrentSessionId()
		// is non-null when clients receive this event. This lets the ledger detect new
		// sessions immediately via the non-null db_session_id in sessions_status broadcasts.
		this.emitRunningStatus(emit);

		// Resolve provider after initSessionContext so this.agentCwd is final.
		const {
			provider: currentProvider,
			agentSettings,
			resumeProviderSessionId,
			ownershipGeneration,
		} = await this.prepareProviderForTurn(sessionId);
		const configuredPermissionMode =
			this.configuredPermissionModeForTurn(agentSettings);

		// Turn-boundary usage gate: hold the turn before any provider spend.
		// State stays "running" while sleeping; agent_sleep carries the nuance.
		if ((await this.gateOnUsage(currentProvider, emit)) === "aborted") {
			this.activeRoutineContext = null;
			if (!this.suspendingForRestart) {
				await this.settleDurableTurn(turnId);
			}
			return;
		}

		const turn = createTurnState(
			this.selectedModelFor(agentSettings),
			ownershipGeneration,
		);
		this.currentTurnState = turn;
		this.currentTurnPermissionMode = planMode
			? "plan"
			: configuredPermissionMode;
		let turnAgentSession: AgentSession | null = null;

		try {
			const runtimeCwd =
				this.agentMode === "cwd" && this.agentCwd
					? this.agentCwd
					: this.vaultPath;
			const runtimePlanHtmlPath = this.planHtmlPath
				? toProviderRuntimePath(runtimeCwd, this.planHtmlPath)
				: undefined;
			const operatingBriefResult = this.operatingBriefFor(
				currentProvider.providerId,
				runtimeCwd,
				planMode ? "plan" : configuredPermissionMode,
			);
			const operatingBrief = commandAction ? "" : operatingBriefResult.text;
			const {
				prompt,
				safeSkillContexts = [],
				safeAttachments,
				resourcePaths,
				safeVaultReferences = [],
				safeWorkspaceReferences = [],
				structuredContent = [],
				contextManifest,
			} = await buildPromptAsync({
				vaultPath: this.vaultPath,
				providerId: currentProvider.providerId,
				vaultName: this.vaultName,
				allowedAgentRealPaths: this.allowedAgentRealPaths,
				agentMode: this.agentMode,
				agentCwd: this.agentCwd,
				claudeSessionId: resumeProviderSessionId,
				runtimeCwd,
				operatingBrief,
				operatingBriefVersion: HLID_OPERATING_CONTRACT_VERSION,
				operatingBriefRevision: operatingBriefResult.revision,
				operatingBriefPreview: operatingBriefResult.preview,
				operatingBriefDelivery: commandAction
					? "not-delivered"
					: operatingBrief
						? "included"
						: "already-established",
				userMessage,
				skillContexts,
				attachments,
				vaultReferences,
				workspaceReferences,
				delegationContext,
				nativeAudio: currentProvider.providerId === "codex",
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
			let commandArgs: string | undefined;
			let commandHlidAddedChars = 0;
			const commandBlocks: HlidContextBlock[] = [];
			if (commandAction) {
				commandArgs = userMessage
					.replace(new RegExp(`^/${commandAction}(?:\\s+|:\\s*)?`, "i"), "")
					.trim();
				if (commandAction === "computer-use" && !commandArgs) {
					throw new Error("/computer-use requires a Windows desktop task");
				}
				const commandReferencePath = (path: string) =>
					commandAction === "computer-use"
						? path
						: toProviderRuntimePath(runtimeCwd, path);
				if (safeVaultReferences.length > 0) {
					const appended = appendProviderCommandReferences(
						commandArgs,
						"Vault references",
						safeVaultReferences,
						"vault_references",
						(reference) =>
							`- ${commandReferencePath(reference.path)} (Vault: ${reference.relativePath})`,
					);
					commandArgs = appended.commandArgs;
					commandHlidAddedChars += appended.addedChars;
					commandBlocks.push(appended.block);
				}
				if (safeWorkspaceReferences.length > 0) {
					const appended = appendProviderCommandReferences(
						commandArgs,
						"Workspace references",
						safeWorkspaceReferences,
						"workspace_references",
						(reference) =>
							`- ${commandReferencePath(reference.path)} (Workspace: ${reference.relativePath}, ${reference.mime}, sha256:${reference.sha256})`,
					);
					commandArgs = appended.commandArgs;
					commandHlidAddedChars += appended.addedChars;
					commandBlocks.push(appended.block);
				}
			}
			const deliveredContextManifest = commandAction
				? providerCommandContextManifest(
						contextManifest,
						commandArgs?.length ?? 0,
						commandHlidAddedChars,
						commandBlocks,
					)
				: contextManifest;
			const toolLoading = await this.toolLoadingFor(currentProvider);
			const finalizedTurnContextManifest = finalizeHlidTurnContextManifest(
				deliveredContextManifest,
				{
					delivery: commandAction ? "provider-command" : "chat",
					providerId: currentProvider.providerId,
					model: this.model,
					effort: this.effort,
					permissionMode: planMode ? "plan" : configuredPermissionMode,
					providerPromptChars: commandAction
						? (commandArgs?.length ?? 0)
						: providerPrompt.length,
					providerHandoffChars: commandAction
						? 0
						: Math.max(0, providerPrompt.length - prompt.length),
					...(toolLoading ? { toolLoading } : {}),
				},
			);
			// Native ACP blocks are only candidates until the agent advertises its
			// prompt capabilities. Persist the textual receipt first, then let the
			// provider callback add only the blocks it actually retained.
			const {
				structuredPrompt: _candidateStructuredPrompt,
				...turnContextManifest
			} = finalizedTurnContextManifest;
			const initialContextManifestJson = JSON.stringify(turnContextManifest);

			// With `resume`, the CLI maintains conversation state on its end. We
			// send only the new user turn — no transcript replay. The Hlid-owned
			// manifest is stored beside the user row, not in its visible text.
			turn.userSeq = await this.persistUserMessage(
				sessionId,
				userMessage,
				safeAttachments,
				turnId,
				safeVaultReferences.map((reference) => reference.relativePath),
				safeWorkspaceReferences,
				undefined,
				turnContextManifest,
			);
			const retainedRelics = (
				await Promise.all(
					safeAttachments
						.filter((attachment) => attachment.reference === "relic")
						.map(async (attachment): Promise<ChatAttachment | null> => {
							try {
								const retained = await db.getAttachment(attachment.id);
								if (!retained || retained.retention !== "retained") return null;
								return {
									id: retained.id,
									path: retained.path,
									filename: retained.filename,
									mime: retained.mime,
									kind: retained.kind,
									reference: "relic",
								};
							} catch (error) {
								logDbError("getAttachment (delegation handoff)", error);
								return null;
							}
						}),
				)
			).filter((relic): relic is ChatAttachment => relic !== null);
			this.currentDelegationHandoff = {
				skillContexts: [...safeSkillContexts],
				relics: retainedRelics,
				vaultReferences: safeVaultReferences.map(
					(reference) => reference.relativePath,
				),
				workspaceReferences: safeWorkspaceReferences.map((reference) => ({
					relativePath: reference.relativePath,
					sha256: reference.sha256,
				})),
				currentAssistantSequence: turn.reservedAssistantSeq,
			};

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

			if (commandAction === "computer-use") {
				await this.authorizeWindowsComputerUseCommand({
					provider: currentProvider,
					activeCwd,
					sessionId,
					turnId,
					task: commandArgs ?? "",
					emit,
				});
			}

			await this.prepareCodexPermissionProfileRuntimeForTurn({
				provider: currentProvider,
				sessionId,
				acceptedProfileGeneration:
					args.codexPermissionProfileGeneration ??
					this.codexPermissionProfileGeneration,
				acceptedBehindPurposeBuiltTurn:
					args.acceptedBehindCodexPurposeBuiltTurn ?? false,
				signal: this.abortController?.signal,
			});

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
				ownershipGeneration,
				onGoalChange: sessionId
					? (goal) => {
							this.currentGoal = goal;
							emit({
								type: "goal_state",
								session_id: sessionId,
								provider_id: currentProvider.providerId,
								goal: goal ? mapProviderGoal(goal) : null,
							});
						}
					: undefined,
			});
			turnAgentSession = agentSession;
			if (goalStart) {
				await this.markDurableTurnDispatching(turnId);
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
				if (sessionId) {
					const accepted = await this.persistProviderSession(
						sessionId,
						currentProvider.providerId,
						result.providerSessionId,
						ownershipGeneration,
					);
					if (!accepted) {
						throw new Error(
							"The provider changed while goal startup was in progress.",
						);
					}
				}
				this.currentGoal = result.goal;
				this.providerSessionId = result.providerSessionId;
				this.providerSessionProviderId = currentProvider.providerId;
				emit({
					type: "goal_state",
					session_id: sessionId ?? result.providerSessionId,
					provider_id: currentProvider.providerId,
					goal: result.goal ? mapProviderGoal(result.goal) : null,
				});
			}
			await agentSession.setPermissionMode?.(
				planMode ? "plan" : configuredPermissionMode,
			);
			agentSession.setPlanHtmlPath?.(runtimePlanHtmlPath);

			// Slice B: deliver this turn's user message via send() rather than
			// passing it as a one-shot prompt. The long-lived stream pushes it
			// onto the SDK's input AsyncIterable and the next assistant turn
			// runs inside the same SDK query.
			if (commandAction) {
				await this.markDurableTurnDispatching(turnId);
				if (!agentSession.executeCommand) {
					throw new Error(
						`/${commandAction} is not supported by the active provider`,
					);
				}
				await agentSession.executeCommand(commandAction, commandArgs);
			} else {
				await this.markDurableTurnDispatching(turnId);
				const audioPaths =
					currentProvider.providerId === "codex"
						? safeAttachments
								.filter((attachment) => attachment.mime.startsWith("audio/"))
								.map((attachment) =>
									toProviderRuntimePath(activeCwd, attachment.path),
								)
						: [];
				await agentSession.send(providerPrompt, {
					inputOrigin: args.inputOrigin,
					...(audioPaths.length > 0 ? { audioPaths } : {}),
					...(currentProvider.providerId.startsWith("acp:") &&
					structuredContent.length > 0
						? {
								structuredContent,
								onStructuredContentAccepted: async (acceptedContent) => {
									const userSeq = turn.userSeq;
									if (!sessionId || userSeq === null) return;
									const structuredPrompt =
										summarizeHlidStructuredPrompt(acceptedContent);
									if (!structuredPrompt) return;
									try {
										await db.replaceUserMessageContextManifest(
											sessionId,
											userSeq,
											initialContextManifestJson,
											JSON.stringify({
												...turnContextManifest,
												structuredPrompt,
											}),
										);
									} catch (error) {
										logDbError(
											"replace user structured prompt context receipt",
											error,
										);
									}
								},
							}
						: {}),
				});
				if (contextManifest.operatingBrief?.included) {
					this.operatingBriefProviderKey = `${currentProvider.providerId}|${this.currentSessionId ?? "ephemeral"}`;
				}
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

			if (!turn.terminalFailure) {
				this.scheduleTurnRecap({
					turn,
					sessionId,
					userMessage,
					emit,
					provider: currentProvider,
					agentSettings,
				});
			}
		} catch (err) {
			if (
				err instanceof ProviderPermissionModeRejectedError &&
				turnAgentSession
			) {
				try {
					await this.reconcilePreInputPermissionRejection({
						sourceSession: turnAgentSession,
						sessionId,
						provider: currentProvider,
						ownershipGeneration,
						rejection: err,
						emit,
					});
				} catch (reconciliationError) {
					logDbError(
						"reconcile provider permission mode rejection",
						reconciliationError,
					);
				}
			}
			const expectedAbort = this.abortController?.signal.aborted === true;
			if (!expectedAbort) this.state = "error";
			const msg = err instanceof Error ? err.message : "Unknown error";
			// Compiled Hlið redirects console.error into this same table. Keep the
			// development console useful without storing every production failure
			// twice (once as console and once as the structured session record).
			if (!expectedAbort && !process.execPath.endsWith(".exe")) {
				console.error("[session] runQuery error:", err);
			}
			if (!expectedAbort) {
				void db.appendLog("error", "session", "runQuery error", {
					message: msg,
					name: err instanceof Error ? err.name : undefined,
					stack: err instanceof Error ? err.stack?.slice(0, 500) : undefined,
				});
				emit({
					type: "error",
					message: msg,
					turn_scoped: true,
					...(turnId !== undefined ? { turn_id: turnId } : {}),
				});
			}
			const preserveCodexBackgroundRuntime =
				err instanceof CodexPermissionProfileBackgroundBlockedError &&
				this.agentSession !== null &&
				this.agentSessionKey?.startsWith("codex|") === true;
			if (!preserveCodexBackgroundRuntime) {
				// Slice B: tear down an AgentSession whose iterator may be inconsistent.
				// The profile-change guard runs before provider input and keeps the old
				// runtime solely so its already-running background work can settle.
				this.stopBackgroundActivityObserver();
				this.agentSession?.cancel();
				this.agentSession = null;
				this.agentSessionKey = null;
				this.restartAgentSessionForEffort = false;
			}
		} finally {
			// Persist any remaining assistant text (the success path clears it).
			let incompleteAssistantSeq: number | null = null;
			if (
				sessionId &&
				(turn.reservedAssistantSeq !== null || turn.assistantText)
			) {
				try {
					const assistantSeq = await this.persistAssistantMessage(
						sessionId,
						turn,
					);
					incompleteAssistantSeq = assistantSeq;
					await this.persistPendingToolEvents(
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
			if (sessionId && !turn.queryRecorded) {
				try {
					await this.persistIncompleteQuery(
						sessionId,
						turn,
						currentProvider,
						incompleteAssistantSeq,
					);
				} catch (error) {
					logDbError("recordQuery (incomplete)", error);
				}
			}
			// drainTurnQueue handles the final status emit + abortController
			// reset after the queue fully drains. We intentionally do not emit
			// per-turn status here so queued turns never see a transient idle
			// flicker between turns.
			this.activeRoutineContext = null;
			if (this.currentTurnState === turn) {
				this.currentTurnState = null;
				this.currentTurnPermissionMode = null;
				this.currentDelegationHandoff = null;
			}
			if (!this.suspendingForRestart) {
				await this.settleDurableTurn(turnId).catch((error) =>
					logDbError("settle pending turn", error),
				);
			}
		}
	}
}
