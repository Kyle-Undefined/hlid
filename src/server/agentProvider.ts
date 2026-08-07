import type { HlidToolLoadingSummary } from "../lib/hlidContext";
import type {
	ProviderAppAuthenticationRequest,
	ProviderAppAuthenticationStart,
	ProviderAppCatalogPage,
	ProviderAppCatalogRequest,
} from "../lib/providerAppTypes";
import type { ProviderCapabilityDiscovery } from "../lib/providerCapabilityTypes";

/**
 * A single rate-limit window reading parsed from a provider's HTTP response headers.
 * Returned by AgentProvider.proxyConfig.parseHeaders and forwarded to DB + WS broadcast.
 */
export type ProviderWindowReading = {
	/** Stable identifier matching the settings key suffix, e.g. "five_hour", "weekly". */
	windowId: string;
	/** Short display label shown in the UI, e.g. "5-HOUR", "7-DAY". */
	label: string;
	/** Plan utilization 0–1 (Anthropic style). Null if provider doesn't expose this. */
	utilization: number | null;
	/** Tokens remaining in window (OpenAI/Google style). Null if not available. */
	remaining: number | null;
	/** Total token cap for the window. Null if not available. */
	limit: number | null;
	/** Unix epoch seconds when this window resets. Null if unknown. */
	resetsAt: number | null;
};

/** Exact live context occupancy reported by a provider control API. */
export type ProviderContextUsage = {
	contextTokens: number;
	contextWindow: number;
	model?: string;
};

/** Normalized MCP server status — compatible with protocol.ts mapMcpServer input. */
export type McpServerStatus = {
	name: string;
	status: "connected" | "failed" | "needs-auth" | "pending" | "disabled";
	scope?: string;
	error?: string;
	/** Claude-native tighten-only override for this live MCP server. */
	permissionModeOverride?: ProviderMcpPermissionModeOverride;
};

/** Claude's session-scoped, tighten-only MCP permission override values. */
export type ProviderMcpPermissionModeOverride = "default" | "auto";

/** Informational result from Claude's native MCP permission override control. */
export type ProviderMcpPermissionModeOverrideResult = {
	warning?: string;
};

/** One Hlid-managed MCP definition read from the workspace config adapter. */
export type ProviderMcpServerDefinition = {
	name: string;
	config: unknown;
	disabled: boolean;
};

/** Exact result returned when a provider replaces its live dynamic MCP set. */
export type ProviderMcpServerApplyResult = {
	added: string[];
	removed: string[];
	errors: Record<string, string>;
};

/** Provider-native preview/result for restoring tracked workspace files. */
export type ProviderFileRewindResult = {
	canRewind: boolean;
	error?: string;
	filesChanged?: string[];
	insertions?: number;
	deletions?: number;
};

/**
 * A slash command exposed by the underlying agent (e.g. /help, /usage).
 * Mirrors the SDK's SlashCommand shape but kept provider-agnostic here.
 */
export type SlashCommand = {
	name: string;
	description: string;
	argumentHint: string;
	aliases?: string[];
	/** Hlid capability action. Omitted commands are sent as provider-native prompts. */
	action?: "review" | "computer-use" | "goal" | "compact";
};

export type ProviderWorkflowSaveScope = "project" | "personal";

/** Provider-owned workflow script saved into a native command location. */
export type ProviderSavedWorkflow = {
	id: string;
	name: string;
	description: string;
	argumentHint: string;
	/** Path expressed in the owning provider runtime's filesystem syntax. */
	scriptPath: string;
	scope: ProviderWorkflowSaveScope;
	scopeLabel: string;
	/** False when a closer project command with the same name wins. */
	availableAsCommand: boolean;
};

export type ProviderWorkflowSaveLocation = {
	scope: ProviderWorkflowSaveScope;
	scopeLabel: string;
	/** Directory expressed in the owning provider runtime's filesystem syntax. */
	path: string;
	available: boolean;
	error?: string;
};

export type ProviderWorkflowCatalog = {
	workflows: ProviderSavedWorkflow[];
	locations: ProviderWorkflowSaveLocation[];
};

export type ProviderWorkflowSaveInput = {
	cwd: string;
	/** Persisted provider-owned script path returned by a prior workflow run. */
	sourceScriptPath: string;
	scope: ProviderWorkflowSaveScope;
	overwrite?: boolean;
};

export type ProviderWorkflowDeleteInput = {
	cwd: string;
	/** Exact script path returned by the provider workflow catalog. */
	scriptPath: string;
	scope: ProviderWorkflowSaveScope;
};

export type ProviderWorkflowSourceInput = {
	cwd: string;
	/** Provider-owned workflow script path returned by a run or catalog entry. */
	scriptPath: string;
	/** Present for an exact saved workflow; omitted for a persisted run script. */
	scope?: ProviderWorkflowSaveScope;
};

export type ProviderGoalStatus =
	| "active"
	| "paused"
	| "blocked"
	| "usageLimited"
	| "budgetLimited"
	| "complete";

/** Provider-owned durable objective attached to one native session. */
export type ProviderThreadGoal = {
	threadId: string;
	objective: string;
	status: ProviderGoalStatus;
	tokenBudget: number | null;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
};

export type ProviderGoalControl =
	| { action: "get" }
	| { action: "set"; objective: string; tokenBudget?: number | null }
	| { action: "pause" }
	| { action: "resume" }
	| { action: "clear" };

export type ProviderGoalControlResult = {
	providerSessionId: string;
	goal: ProviderThreadGoal | null;
};

export type ProviderRealtimeMode = "dictation" | "live" | "read-aloud";

/**
 * Ordinary Codex item notifications that remain useful while Live owns the
 * user-visible text/audio channel. They bypass the dormant normal-turn event
 * queue so Raven can render and persist tool activity without replaying the
 * mirrored assistant transcript.
 */
export type ProviderRealtimeActivity = Extract<
	AgentEvent,
	{
		type:
			| "tool_start"
			| "tool_update"
			| "tool_activity_update"
			| "tool_result"
			| "generated_media";
	}
>;

export type ProviderRealtimeEvent =
	| { type: "started"; realtimeSessionId?: string }
	| { type: "sdp"; sdp: string }
	| { type: "audio_output_started" }
	| { type: "transcript_delta"; role: string; delta: string }
	| { type: "transcript_done"; role: string; text: string }
	| { type: "activity"; event: ProviderRealtimeActivity }
	| { type: "error"; message: string }
	| { type: "closed"; reason?: string };

export type ProviderRealtimeStart = {
	mode: ProviderRealtimeMode;
	sdp: string;
	voice?: string;
	onEvent: (event: ProviderRealtimeEvent) => void;
};

export type ProviderRealtimeStartResult = {
	providerSessionId: string;
};

/** Provider-native skill metadata used by Hlid's review-before-import catalog. */
export type ProviderSkillInfo = {
	name: string;
	description: string;
	/** Present when the provider SDK exposes the package's SKILL.md location. */
	path?: string;
	scope?: string;
	enabled?: boolean;
};

/**
 * Provider-agnostic account info shape — a subset of the SDK's AccountInfo
 * (email, organization, subscriptionType only; tokenSource/apiKeySource/
 * apiProvider are SDK-internal and not surfaced to the UI).
 */
export type ProviderAccountInfo = {
	email?: string;
	organization?: string;
	subscriptionType?: string;
};

/** A single effort/thinking level entry as reported by a provider's live model catalog. */
export type ProviderEffortInfo = {
	value: string;
	label: string;
	desc?: string;
	isDefault?: boolean;
};

/**
 * A single model entry as reported by a provider's live model catalog
 * (AgentProvider.listModels). Strict superset of the existing static
 * `models` item shape {value,label} — backward compatible.
 */
export type ProviderModelInfo = {
	value: string;
	label: string;
	description?: string;
	isDefault?: boolean;
	hidden?: boolean;
	/** Input kinds the provider says this model accepts. */
	inputModalities?: Array<"text" | "image" | "audio">;
	efforts?: ProviderEffortInfo[];
	/** Provider-native service tiers advertised for this exact model. */
	serviceTiers?: Array<{
		value: string;
		label: string;
		desc?: string;
		isDefault?: boolean;
	}>;
};

export type SubagentStatus =
	| "pending"
	| "running"
	| "paused"
	| "completed"
	| "failed"
	| "interrupted";

/** Provider-neutral snapshot rendered inside the originating spawn tool call. */
export type SubagentSnapshot = {
	provider: "codex" | "claude";
	agentId: string;
	taskId?: string;
	/**
	 * Provider-neutral activity kind. Older persisted snapshots omit this and
	 * are treated as ordinary agents.
	 */
	kind?: "agent" | "workflow";
	/**
	 * Agent/activity id of the owning parent. Claude workflow children point to
	 * the workflow task id; durable Hlid children can reuse the same lineage
	 * contract later without pretending they are provider-native tasks.
	 */
	parentActivityId?: string;
	/** Provider-native task discriminator retained for capability-aware UI. */
	activityType?: string;
	/** Provider-assigned display name (for example a Claude teammate name). */
	name?: string;
	/** Agent type/path when it is distinct from the provider-assigned name. */
	label?: string;
	prompt?: string;
	description?: string;
	/** Provider-owned workflow phase containing this agent, when available. */
	phase?: string;
	model?: string;
	/** Optional provider-reported effort. Claude workflows do not emit this today. */
	effort?: string;
	/** Provider-owned retry/attempt number, when available. */
	attempt?: number;
	status: SubagentStatus;
	currentStep?: string;
	lastTool?: string;
	/** Bounded provider-owned final output preview, when available. */
	resultPreview?: string;
	/** Claude local-workflow resume identity. Same-session only. */
	workflowRunId?: string;
	/** Claude confirmed that the prior native workflow task was stopped. */
	workflowStopConfirmed?: boolean;
	/** Provider-owned workflow script retained for a native resume turn. */
	workflowScriptPath?: string;
	/** Provider-owned directory containing workflow child transcripts. */
	workflowTranscriptDir?: string;
	/** Provider-owned remote workflow URL, when the task is remote. */
	workflowSessionUrl?: string;
	startedAtMs: number;
	endedAtMs?: number;
	usage?: {
		totalTokens?: number;
		toolUses?: number;
		durationMs?: number;
	};
};

export type TaskActivityStatus =
	| "pending"
	| "in_progress"
	| "completed"
	| "deleted";

export type TaskActivityItem = {
	id?: string;
	subject: string;
	description?: string;
	activeForm?: string;
	status?: TaskActivityStatus;
	owner?: string;
	blockedBy?: string[];
	blocks?: string[];
};

/** Provider-neutral, read-only task state rendered at the originating tool call. */
export type TaskActivity = {
	kind: "tasks";
	source: "codex-plan" | "claude-todo" | "claude-task-store";
	operation: "snapshot" | "create" | "update" | "list" | "get";
	explanation?: string;
	items: TaskActivityItem[];
};

export type ProviderBackgroundActivityStatus =
	| "running"
	| "completed"
	| "failed"
	| "stopped"
	| "unknown";

/**
 * Session-level provider work that can outlive the visible parent turn.
 * Native identifiers and operations stay provider-owned; Hlid only projects a
 * bounded, capability-gated snapshot for Raven and durable attention.
 */
export type ProviderBackgroundActivity = {
	providerId: string;
	providerSessionId: string;
	/** Stable provider item/task id used as the Hlid activity identity. */
	activityId: string;
	/** Provider runtime process id, when distinct from activityId. */
	processId?: string;
	kind: "terminal" | "shell" | "monitor" | "agent" | "workflow" | "task";
	status: ProviderBackgroundActivityStatus;
	command?: string;
	description?: string;
	cwd?: string;
	/** Bounded recent output or provider summary, never an unbounded transcript. */
	recentOutput?: string;
	osPid?: number;
	cpuPercent?: number;
	rssKb?: number;
	startedAtMs: number;
	updatedAtMs: number;
	endedAtMs?: number;
	capabilities: {
		stop?: boolean;
		terminate?: boolean;
		clean?: boolean;
	};
};

export type ProviderBackgroundActivityControl =
	| { action: "background" }
	| { action: "stop"; activityId: string }
	| { action: "terminate"; activityId: string }
	| { action: "clean" };

export type AgentEvent =
	| { type: "session_start"; sessionId: string }
	/** Claude checkpoint attached to the current root user turn. */
	| { type: "file_checkpoint"; id: string; providerSessionId: string }
	| { type: "commands_changed"; commands: SlashCommand[] }
	| { type: "transport_error"; message: string }
	/** A distinct root assistant message follows within the same visible turn. */
	| { type: "assistant_message_boundary" }
	| { type: "text_delta"; text: string }
	| {
			/**
			 * Replace the most recently emitted assistant-message tail with the
			 * provider's authoritative completed text.
			 */
			type: "text_replace";
			text: string;
			previousText: string;
	  }
	/**
	 * Native transcript id of the raw provider message currently contributing
	 * to this turn. Claude-only today (SDKAssistantMessage.uuid) — used to
	 * persist a fork cutoff (forkSession's upToMessageId) per displayed
	 * assistant row. Other providers simply never emit this.
	 */
	| { type: "assistant_message_id"; id: string }
	/** Native provider turn id used for exact turn-boundary forks (Codex). */
	| { type: "provider_turn_id"; id: string }
	| { type: "local_command_output"; content: string }
	| {
			type: "tool_start";
			toolId: string;
			name: string;
			input: unknown;
			subagent?: SubagentSnapshot;
			taskActivity?: TaskActivity;
	  }
	| { type: "tool_update"; toolId: string; subagent: SubagentSnapshot }
	| { type: "tool_activity_update"; toolId: string; taskActivity: TaskActivity }
	| {
			type: "tool_result";
			toolId: string;
			content: string;
			isError?: boolean;
	  }
	/** Provider-produced media that Hlid must retain before exposing to Raven. */
	| {
			type: "generated_media";
			toolId: string;
			kind: "image";
			status: string;
			mime: "image/png";
			/** Provider result bytes. Never persisted directly in transcript text. */
			dataBase64?: string;
			prompt?: string;
			/** Optional provider-owned copy, retained only as bounded provenance. */
			providerPath?: string;
	  }
	| { type: "summary"; text: string }
	| {
			type: "usage";
			inputTokens: number;
			outputTokens: number;
			cacheReadTokens?: number;
			cacheCreationTokens?: number;
			/** Authoritative cumulative usage for the active query, when available. */
			queryUsage?: {
				inputTokens: number;
				outputTokens: number;
				cacheReadTokens: number;
				cacheCreationTokens: number;
			};
			model?: string;
			/** Context window of the model serving this turn, when the provider reports it. */
			contextWindow?: number;
			/** Exact tokens currently occupying context, when distinct from turn input. */
			contextTokens?: number;
	  }
	| {
			type: "rate_limit";
			status: string;
			rateLimitType?: string;
			utilization?: number;
			resetsAt?: number | null;
	  }
	| { type: "mcp_status"; servers: McpServerStatus[] }
	| {
			type: "done";
			cost?: number;
			/** Whether `cost` is provider-reported, including a genuine known zero. */
			costKnown?: boolean;
			/** API-equivalent estimate when the provider does not report actual cost. */
			estimatedCost?: number | null;
			turns: number;
			durationMs: number;
			stopReason?: string;
			modelUsage?: Record<
				string,
				{ contextWindow: number; maxOutputTokens: number }
			>;
			usage?: {
				inputTokens: number;
				outputTokens: number;
				cacheReadTokens?: number;
				cacheCreationTokens?: number;
			};
	  };

export type AgentToolDecision =
	| {
			behavior: "allow";
			updatedInput?: unknown;
			/** Hlid approval-card persistence chosen by the user. */
			saveScope?: "session" | "local";
	  }
	| { behavior: "deny"; message?: string };

export type ToolMeta = {
	toolUseID: string;
	signal: AbortSignal;
	title?: string;
	displayName?: string;
	description?: string;
	suggestions?: unknown[];
	blockedPath?: string;
	decisionReason?: string;
	agentID?: string;
	/** Provider callback provenance for Hlid's shared blocking-input surface. */
	interaction?: {
		provider_id: string;
		kind: "mcp_elicitation" | "provider_dialog";
		source_name: string;
		tool_name?: string;
		summary?: string;
		tool_use_id?: string;
		url?: string;
	};
};

export type CanUseTool = (
	toolName: string,
	input: unknown,
	meta: ToolMeta,
) => Promise<AgentToolDecision>;

export type BeforeToolUse = (
	toolName: string,
	input: unknown,
	meta: { toolUseID?: string; signal?: AbortSignal },
) => Promise<"proceeded" | "aborted">;

export type AgentQueryParams = {
	cwd: string;
	/** Active Hlid provider identity for capability-gated host guidance. */
	providerId?: string;
	/** Configured Hlid Vault name, when this runtime belongs to Raven. */
	vaultName?: string;
	/** Whether the workspace supplies cwd or context-only agent instructions. */
	agentMode?: "cwd" | "context";
	/** Owning Hlid conversation id for host-managed artifacts and auditing. */
	hostSessionId?: string;
	/** Resume token from a prior session; undefined starts fresh. */
	sessionId?: string;
	/** Imported Claude transcripts are resumed through the SDK SessionStore adapter. */
	historyResumeMode?: "none" | "native" | "session-store";
	additionalDirectories?: string[];
	model?: string;
	effort?: string;
	/** Provider-native service tier selected from the live model catalog. */
	serviceTier?: string;
	maxTurns?: number;
	permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
	/** Narrow a provider sandbox independently of its conversational mode. */
	sandboxModeOverride?: "read-only";
	/** A host policy layer must see calls even when interactive prompts are bypassed. */
	policyEnforced?: boolean;
	/** Keep provider host boundaries active so auto-sleep can gate continuation. */
	usageGateEnforced?: boolean;
	/** Provider-native pre-tool boundary used to pause before autonomous tools. */
	beforeToolUse?: BeforeToolUse;
	/** Permission mode to restore after a provider-specific plan is approved. */
	implementationPermissionMode?:
		| "default"
		| "acceptEdits"
		| "bypassPermissions";
	/** Exact server-owned HTML plan path when the HTML handoff is enabled. */
	planHtmlPath?: string;
	/** false = ephemeral session (recap queries). */
	persistSession?: boolean;
	signal?: AbortSignal;
	canUseTool: CanUseTool;
	settingSources?: ("user" | "project" | "local")[];
	executable?: string;
	/** Windows-native Codex Computer Use delegation preferences. */
	windowsComputerUse?: { model: string; effort: string };
	/** Provider-owned goal changes that can arrive outside a normal chat turn. */
	onGoalChange?: (goal: ProviderThreadGoal | null) => void;
	/** Explicitly enable Codex's under-development realtime conversation RPCs. */
	codexRealtimeEnabled?: boolean;
};

/**
 * Options controlling how a sent message is delivered into the long-lived
 * SDK stream. Slice B: defaults to "next" (queue at next turn boundary,
 * matching CLI semantics). "now" interrupts the current turn (pending
 * verification in Slice C). "later" appends to end of queue.
 */
export type SendOptions = {
	priority?: "now" | "next" | "later";
	/** Provider-visible paths to audio files included as native turn input. */
	audioPaths?: string[];
};

export interface AgentSession extends AsyncIterable<AgentEvent> {
	/**
	 * Push a user message into the long-lived agent stream. Resolves once the
	 * message has been accepted by the provider (not when the assistant turn
	 * completes — for that, await the next `done` AgentEvent).
	 */
	send(message: string, opts?: SendOptions): Promise<void>;
	/**
	 * Add user guidance to the provider's currently active turn without ending
	 * it or starting a second turn. Providers without a native steering
	 * primitive omit this method.
	 */
	steer?(message: string, opts?: SendOptions): Promise<void>;
	cancel(): void;
	/**
	 * Slice C: stop the currently running assistant turn early and return
	 * control to the caller. The session stays alive for subsequent send()s
	 * (unlike cancel(), which tears down the SDK process). Used by the
	 * "promote queued msg to now" UX — interrupts current, drain proceeds
	 * to the next queued turn.
	 */
	interrupt?(): Promise<void>;
	/**
	 * Stop one provider-owned background task without interrupting the parent
	 * turn. Claude exposes this as a native streaming control request.
	 */
	stopTask?(taskId: string): Promise<void>;
	/** Read a bounded snapshot of live and recently settled provider work. */
	listBackgroundActivities?(): Promise<ProviderBackgroundActivity[]>;
	/** Execute an exact provider-native background activity operation. */
	controlBackgroundActivity?(
		request: ProviderBackgroundActivityControl,
	): Promise<void>;
	/**
	 * Close the input stream without aborting the session. Use for one-shot
	 * queries (e.g. recap) after the final send() so the SDK process sees EOF
	 * on stdin and exits cleanly after its turn instead of waiting indefinitely.
	 */
	closeInput?(): void;
	/** Available on providers that expose MCP server connectivity info. */
	mcpServerStatus?(): Promise<McpServerStatus[]>;
	/** Reconnect one provider-owned MCP server inside this live session. */
	reconnectMcpServer?(serverName: string): Promise<void>;
	/** Enable or disable one provider-owned MCP server inside this live session. */
	toggleMcpServer?(serverName: string, enabled: boolean): Promise<void>;
	/**
	 * True only while the provider's native, tighten-only per-MCP permission
	 * override can affect this live session. Hlid policy enforcement remains
	 * authoritative and makes this provider control unavailable.
	 */
	readonly mcpPermissionModeOverrideAvailable?: boolean;
	/** Pin or clear one provider-native, session-scoped MCP permission override. */
	setMcpPermissionModeOverride?(
		serverName: string,
		mode: ProviderMcpPermissionModeOverride | null,
	): Promise<ProviderMcpPermissionModeOverrideResult>;
	/**
	 * Replace the Hlid-managed MCP subset inside an existing provider session.
	 * Returns null when the provider Query is not live; implementations must not
	 * start a hidden provider process for this control.
	 */
	setMcpServers?(
		servers: ProviderMcpServerDefinition[],
	): Promise<ProviderMcpServerApplyResult | null>;
	/**
	 * Reload provider-native skills inside an already-live session. Returns the
	 * refreshed native skill commands, or null when no provider Query is live.
	 * Implementations must not start a hidden provider process for this control.
	 */
	reloadSkills?(): Promise<SlashCommand[] | null>;
	/** Preview or execute a provider-native file checkpoint rewind. */
	rewindFiles?(
		userMessageId: string,
		options?: { dryRun?: boolean },
	): Promise<ProviderFileRewindResult>;
	/** Available on providers that expose the list of supported slash commands. */
	supportedCommands?(): Promise<SlashCommand[]>;
	/** Execute a provider capability without relying on prompt-parsed CLI syntax. */
	executeCommand?(
		action: "review" | "computer-use" | "compact",
		args?: string,
	): Promise<void>;
	/** Read or mutate a provider-owned durable objective without a chat turn. */
	controlGoal?(
		request: ProviderGoalControl,
	): Promise<ProviderGoalControlResult>;
	/** Start the provider's native low-latency voice transport for this thread. */
	startRealtime?(
		request: ProviderRealtimeStart,
	): Promise<ProviderRealtimeStartResult>;
	/** Add text that should be spoken by an active native realtime session. */
	appendRealtimeSpeech?(text: string): Promise<void>;
	/** Stop the active native realtime session without closing the agent thread. */
	stopRealtime?(): Promise<void>;
	/** Replace the live goal notification sink when a persisted session is reattached. */
	setGoalChangeHandler?(handler: AgentQueryParams["onGoalChange"]): void;
	/**
	 * Fetch the provider's current subscription/rate-limit windows. Unlike
	 * passive rate-limit events, this can return a reading even when the
	 * provider has not crossed a warning threshold during the current turn.
	 */
	usageWindows?(): Promise<ProviderWindowReading[]>;
	/**
	 * Fetch the provider's current context occupancy and model window. This is
	 * separate from per-inference token usage because some providers only expose
	 * the authoritative window through a live control API.
	 */
	contextUsage?(): Promise<ProviderContextUsage | null>;
	/**
	 * Switch the model used for subsequent turns in this already-running
	 * session. `undefined` resets to the provider's default. No-op (absent)
	 * on providers that can't change model mid-session.
	 */
	setModel?(model?: string): Promise<void>;
	/**
	 * Switch the permission mode used for subsequent turns in this
	 * already-running session. No-op (absent) on providers that can't change
	 * permission mode mid-session.
	 */
	setPermissionMode?(mode: string): Promise<void>;
	/**
	 * Switch the effort/thinking level used for subsequent turns in this
	 * already-running session. No-op (absent) on providers that can't change
	 * effort mid-session — e.g. Claude's SDK Query exposes setModel but no
	 * live effort setter, so a Claude session only picks up a new effort on
	 * its next fresh AgentSession, not the current stream.
	 */
	setEffort?(effort: string): Promise<void>;
	/** Update preferences used by the next Windows-native Computer Use worker. */
	setWindowsComputerUse?(settings: {
		model: string;
		effort: string;
	}): Promise<void>;
	/** Update the per-turn HTML plan handoff without recreating the conversation. */
	setPlanHtmlPath?(path: string | undefined): void;
	/**
	 * Fetch info about the authenticated account backing this session, or
	 * null when unavailable (no live session, not authenticated via a
	 * provider that exposes this, or the lookup failed). Available on
	 * providers that expose account info.
	 */
	accountInfo?(): Promise<ProviderAccountInfo | null>;
}

/** Params for AgentProvider.forkSession — branch a session's transcript into a new one. */
export type ProviderForkCapability = {
	kind: "exact";
	/** Native cutoff identifier, absent when only whole-session forks exist. */
	cutoff?: "message" | "turn";
	wholeSession: true;
	throughMessage: boolean;
};

export type ProviderCapabilityMetadata = {
	/** Provider-native durable goal control exposed through Hlid. */
	goalControl?: boolean;
	/** Provider-native activities Hlid can invoke without prompt parsing. */
	structuredActivities?: ReadonlyArray<"compact" | "review">;
	/** Provider-native reusable workflow discovery and management. */
	workflowCatalog?: boolean;
	/** Provider exposes the realtime conversation transport; config/model/backend still gate use. */
	realtime?: boolean;
	/** Provider exposes an account-scoped Apps and connector inventory. */
	appCatalog?: boolean;
	/** Hlid can start provider-native app or connector authentication. */
	appAuthentication?: boolean;
	/** Provider background activity is observable and controllable through Hlid. */
	backgroundActivities?: {
		maturity: "experimental" | "beta" | "stable";
		operations: ReadonlyArray<
			"background" | "list" | "stop" | "terminate" | "clean"
		>;
	};
	/** Provider media results that Hlid persists and presents as durable Relics. */
	generatedMedia?: {
		maturity: "experimental" | "beta" | "stable";
		operations: ReadonlyArray<"persist" | "preview" | "download">;
	};
};

export type ForkSessionParams = {
	/** Native provider session id to fork from (not hlid's own session id). */
	sessionId: string;
	/**
	 * Project working directory the source session belongs to, when known.
	 * Not required for lookup — providers that key sessions by UUID (Claude)
	 * can and should search across all project directories rather than
	 * trusting this to exactly match the on-disk indexed path (it often
	 * doesn't, e.g. WSL UNC vs POSIX form). Kept optional for providers that
	 * need it to scope the fork.
	 */
	cwd?: string;
	/** From SessionRow.history_resume_mode — selects the right transcript source. */
	historyResumeMode?: "none" | "native" | "session-store";
	/** Custom title for the forked session. If omitted, the provider picks a default. */
	title?: string;
	/** Native inclusive cutoff for a branch through one displayed assistant row. */
	cutoff?: { kind: "message" | "turn"; id: string };
};

export type ForkSessionResult = {
	/** New native provider session id, resumable like any other. */
	sessionId: string;
	/**
	 * Best-effort transcript read-back for legacy or imported sessions whose
	 * visible transcript is not already stored by Hlid. Normal exact forks copy
	 * Hlid's own messages and tool events through the selected branch boundary;
	 * this provider result is only the fallback when that copy is empty.
	 */
	messages?: { role: "user" | "assistant"; text: string; uuid?: string }[];
};

export interface AgentProvider {
	/** Stable identifier used to namespace DB keys and UI tabs, e.g. "claude". */
	readonly providerId: string;
	/** Human-readable display name, e.g. "Claude". Defaults to providerId. */
	readonly label?: string;
	/** Static provider-owned capability shape combined with live catalog evidence. */
	readonly capabilities?: ProviderCapabilityMetadata;
	/**
	 * Describe the Hlid-owned tool schemas this provider transport registers.
	 * The turn receipt uses this instead of assuming every transport is alike.
	 */
	hlidToolLoading?():
		| HlidToolLoadingSummary[]
		| Promise<HlidToolLoadingSummary[]>;
	/**
	 * Models this provider supports. UI uses this to populate the model picker.
	 * Omit for providers with fully dynamic or unconstrained model lists.
	 */
	readonly models?: ReadonlyArray<{ value: string; label: string }>;
	/**
	 * Effort / thinking levels this provider supports.
	 * Omit if the provider has no such concept (e.g. OpenAI doesn't expose it).
	 */
	readonly effortLevels?: ReadonlyArray<{
		value: string;
		label: string;
		desc?: string;
	}>;
	/**
	 * Permission gate modes this provider honours.
	 * Omit if the provider ignores permissionMode entirely.
	 */
	readonly permissionModes?: ReadonlyArray<{
		value: string;
		label: string;
		desc?: string;
	}>;
	/** Rolling usage windows shown in Cockpit/Ledger for this provider. */
	readonly usageWindows?: ReadonlyArray<{
		windowId: string;
		label: string;
		windowSecs: number;
		optional?: boolean;
	}>;
	/**
	 * True when mcpServerStatus()/supportedCommands() require an initialized
	 * chat process. Public metadata probes must use a provider cache when no
	 * live session exists rather than creating a hidden chat process.
	 */
	readonly probeRequiresTurn?: boolean;
	/** Exact native fork behavior, when the provider implements it. */
	readonly forkCapability?: ProviderForkCapability;
	/** Negotiate a runtime fork capability when the provider protocol requires it. */
	resolveForkCapability?(): Promise<ProviderForkCapability | undefined>;
	/** Optional availability check. Returns false + reason if provider can't run. */
	check?(): Promise<{ available: boolean; reason?: string }>;
	/** Optional host-only capabilities surfaced in Forge diagnostics. */
	hostCapabilities?(): Promise<
		Record<string, { label: string; available: boolean; reason?: string }>
	>;
	/**
	 * Read provider-described capability evidence without starting a chat turn.
	 * Callers own caching and must keep support, Hlid integration, and runtime
	 * readiness distinct when building a user-facing snapshot.
	 */
	discoverCapabilities?(context: {
		cwd: string;
	}): Promise<ProviderCapabilityDiscovery>;
	/** Read one bounded provider-native Apps and connector page without starting a chat turn. */
	listApps?(
		context: ProviderAppCatalogRequest,
	): Promise<ProviderAppCatalogPage>;
	/** Begin provider-native authentication. The caller owns opening the returned safe URL. */
	startAppAuthentication?(
		request: ProviderAppAuthenticationRequest,
	): Promise<ProviderAppAuthenticationStart>;
	/** Live-fetch the provider's model catalog. Falls back to the static `models` list on failure. */
	listModels?(): Promise<ProviderModelInfo[]>;
	/** Discover skills visible to this provider for a concrete working directory. */
	listSkills?(context: {
		cwd: string;
		executable?: string;
	}): Promise<ProviderSkillInfo[]>;
	/** Discover reusable workflow commands in this provider's native locations. */
	listWorkflows?(context: { cwd: string }): Promise<ProviderWorkflowCatalog>;
	/** Promote one provider-persisted workflow script into a native command. */
	saveWorkflow?(
		input: ProviderWorkflowSaveInput,
	): Promise<ProviderSavedWorkflow>;
	/** Permanently delete one exact workflow returned by listWorkflows(). */
	deleteWorkflow?(input: ProviderWorkflowDeleteInput): Promise<void>;
	/** Read one provider-owned workflow definition for an on-demand preview. */
	readWorkflowSource?(input: ProviderWorkflowSourceInput): Promise<string>;
	query(params: AgentQueryParams): AgentSession;
	/**
	 * Fork an existing (typically idle) session's transcript into a brand-new
	 * session without a live query. Providers that can't do this omit the
	 * method entirely — callers must feature-detect with
	 * `typeof provider.forkSession === "function"`.
	 */
	forkSession?(params: ForkSessionParams): Promise<ForkSessionResult>;
	/**
	 * When present, the generic proxy infra will spin up an HTTP proxy for this
	 * provider, set `envVar` in the environment, and call `parseHeaders` on every
	 * upstream response to extract rate-limit window readings.
	 */
	proxyConfig?: {
		/** Environment variable the provider SDK reads for its base URL. */
		envVar: string;
		/** Window IDs this provider can report on (used for cold-start DB seeding). */
		windowIds: string[];
		/** Parse provider-specific response headers into zero or more window readings. */
		parseHeaders(headers: Headers): ProviderWindowReading[];
	};
}
