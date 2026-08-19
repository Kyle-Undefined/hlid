import type {
	SessionNotificationMode,
	SessionNotificationScope,
} from "../lib/pushNotificationSchemas";
import type { WorkspaceReferenceRequest } from "../lib/vaultReferences";
import type {
	ProviderApprovalsReviewer,
	ProviderGoalStatus,
	ProviderSavedWorkflow,
	ProviderSessionConfigSnapshot,
	ProviderThreadGoal,
	ProviderWorkflowSaveLocation,
	ProviderWorkflowSaveScope,
	SubagentSnapshot,
	TaskActivity,
	ToolProgressSnapshot,
} from "./agentProvider";

/** Maximum tool-result text carried inline in Raven transcript messages. */
export const TOOL_RESULT_PREVIEW_CHARS = 256;

// Server → client messages
export type StatusMessage = {
	type: "status";
	/** Pool or durable session identity used to reject cross-chat status races. */
	session_id?: string;
	state: "idle" | "running" | "error";
	model: string;
	/**
	 * Current permission mode for this session. Session-scoped — reflects
	 * config defaults until a `set_permission_mode` client message overrides
	 * it. Persisted on the chat row, never written back to hlid.config.toml.
	 */
	permission_mode?: string;
	/** Codex-native reviewer selected for interactive provider approvals. */
	approvals_reviewer?: ProviderApprovalsReviewer;
	/**
	 * Current effort/thinking level for this session. Session-scoped like
	 * permission_mode — reflects config defaults until a `set_effort` client
	 * message overrides it, then persists on the chat row.
	 */
	effort?: string;
	/**
	 * Slice C: when state=running, the turn_id of the turn the server is
	 * currently processing. Lets the client distinguish "queued behind
	 * running" from "currently running" in the chat queue UI without
	 * relying on local-only positional heuristics.
	 */
	turn_id?: string;
};

/** Correlated acknowledgement for a transport-only WebSocket liveness probe. */
export type ConnectionAckMessage = {
	type: "connection_ack";
	request_id: string;
};

export type ChunkMessage = {
	type: "chunk";
	text: string;
	/**
	 * `text` is the authoritative full assistant turn, replacing any streamed
	 * text currently shown for that turn.
	 */
	replace?: boolean;
	/**
	 * UTF-16 offset of this delta within the current assistant turn. Replayed
	 * chunks keep the same offset so clients can apply them idempotently after
	 * a remount or WebSocket reconnect.
	 */
	offset?: number;
};

/**
 * Canonical post-persistence reconciliation for provider frame retractions.
 * Text replacement and tool mutations are deliberately independent so Raven
 * never guesses which visible tail belonged to a provider UUID.
 */
export type AssistantRevisionMessage = {
	type: "assistant_revision";
	session_id: string;
	transcript_seq: number;
	/** True when this row is the still-streaming assistant response. */
	current?: boolean;
	text: string;
	removed_tool_ids: string[];
	cleared_tool_result_ids: string[];
	remaining_tool_count: number;
	remaining_tool_error_count: number;
	restored_tool_metadata?: Array<{
		id: string;
		subagent: SubagentSnapshot | null;
		taskActivity: TaskActivity | null;
	}>;
	steer_tool_event_indexes: Array<{
		user_seq: number;
		tool_event_index: number;
	}>;
};

export type ToolEventMessage = {
	type: "tool_event";
	name: string;
	input: unknown;
	id: string;
	/** Exact Raven Live assistant bubble that owns this tool call. */
	realtime_utterance_id?: string;
	/** Hlid-owned Live generation used to discard only matching partial rows. */
	realtime_session_id?: string;
	/** Durable assistant sequence shared with the eventual Live transcript row. */
	transcript_seq?: number;
	/** Live tool rows currently share the same no-fork boundary as speech rows. */
	fork_supported?: boolean;
	/** Populated client-side once a matching tool_result arrives or from history. */
	result?: string;
	/** Historical result is only a preview and should be fetched when expanded. */
	resultTruncated?: boolean;
	resultLength?: number;
	/** Session scope needed by the historical detail endpoint. */
	detailSessionId?: string;
	isError?: boolean;
	subagent?: SubagentSnapshot;
	taskActivity?: TaskActivity;
	/** Latest bounded provider snapshot while this tool is still running. */
	progress?: ToolProgressSnapshot;
};

export type ToolUpdateMessage = {
	type: "tool_update";
	id: string;
	subagent: SubagentSnapshot;
	realtime_utterance_id?: string;
	realtime_session_id?: string;
	transcript_seq?: number;
};

export type ToolActivityUpdateMessage = {
	type: "tool_activity_update";
	id: string;
	taskActivity: TaskActivity;
	realtime_utterance_id?: string;
	realtime_session_id?: string;
	transcript_seq?: number;
};

export type ToolProgressUpdateMessage = {
	type: "tool_progress_update";
	id: string;
	progress: ToolProgressSnapshot;
	realtime_utterance_id?: string;
	realtime_session_id?: string;
	transcript_seq?: number;
};

export type ToolResultMessage = {
	type: "tool_result";
	/** Full result for small/unpersisted tools; otherwise a bounded preview. */
	id: string;
	content: string;
	resultTruncated?: boolean;
	resultLength?: number;
	/** Session scope used to hydrate a compacted live result on expansion. */
	detailSessionId?: string;
	isError?: boolean;
	realtime_utterance_id?: string;
	realtime_session_id?: string;
	transcript_seq?: number;
};

export type DoneMessage = {
	type: "done";
	session_id?: string;
	/**
	 * Slice C: echoes the turn_id from the originating ClientChatMessage,
	 * letting the client correlate this `done` to the specific submitted msg
	 * that produced it. Absent when the turn was started without a turn_id
	 * (e.g. legacy clients or server-internal turns).
	 */
	turn_id?: string;
	/**
	 * messages.id (DB primary key) for this turn's assistant row, when one was
	 * persisted. Lets the client offer "branch from here" on a live-streamed
	 * message immediately, instead of only after a history reload.
	 */
	db_id?: number;
	cost: number | null;
	estimated_cost?: number | null;
	turns: number;
	duration_ms: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
	context_window: number | null;
	max_output_tokens: number | null;
	stop_reason: string | null;
	tokens_in_context: number | null;
};

export type RateLimitMessage = {
	type: "rate_limit";
	status: string;
	rateLimitType?: string;
	utilization?: number | null;
	remaining?: number | null;
	limit?: number | null;
	resetsAt?: number | null;
	/** Provider that emitted this rate-limit event, e.g. "claude". */
	providerId?: string;
};

// Auto-sleep gate transitions: the session paused on a usage limit (state
// "sleeping") or came back (state "resumed", with the cause).
export type AgentSleepMessage = {
	type: "agent_sleep";
	state: "sleeping" | "resumed";
	providerId: string;
	windowId?: string;
	/** Epoch seconds the sleep is expected to end (sleeping only). */
	until?: number;
	reason?: "threshold" | "limit_reached";
	/** Utilization reading behind a threshold sleep, 0–1 (sleeping only). */
	utilization?: number;
	cause?: "reset" | "skipped" | "aborted";
	session_id?: string;
};

// Per-call usage snapshot, emitted while a query is active so the UI can update
// the context gauge and display in-flight tokens without waiting for `done`.
// Cost, duration, turns, and stop reason remain result-boundary fields.
export type UsageUpdateMessage = {
	type: "usage_update";
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
	/** Authoritative cumulative token buckets for the active query so far. */
	query_input_tokens: number;
	query_output_tokens: number;
	query_cache_read_tokens: number;
	query_cache_creation_tokens: number;
	/** Hlid's current API-equivalent estimate for the active query. */
	query_estimated_cost?: number | null;
	tokens_in_context: number;
	// The model the CLI actually used for this inference. May differ from
	// the configured vault model if an agent's CLAUDE.md frontmatter, slash
	// command, or subagent overrode it. Includes the dated suffix
	// (e.g. "claude-opus-4-8-20260601"); strip with /-\d{8}$/ to compare.
	actualModel?: string;
	// Max context window for the model used this inference. Carried forward
	// from the most recent `result` message so the gauge can render without
	// waiting for the next `done`. Absent on the very first turn of a fresh
	// session (no prior result yet).
	context_window?: number;
};

/** Authoritative live context snapshot from a provider control API. */
export type ContextUpdateMessage = {
	type: "context_update";
	tokens_in_context: number;
	context_window: number;
	actualModel?: string;
};

export type ErrorMessage = {
	type: "error";
	message: string;
	/** Active user turn that failed, when the error came from a chat run. */
	turn_id?: string;
	/** Distinguishes transcript-bound failures from generic command errors. */
	turn_scoped?: true;
};

/** Correlated rejection for one optimistically applied Raven session control. */
export type SessionControlRejectedMessage = {
	type: "session_control_rejected";
	control: "effort" | "model" | "permission_mode" | "provider";
	/** Exact optimistic value sent by this client. */
	attempted_value: string;
	/** Server-authoritative value retained after the rejection. */
	authoritative_value: string;
	/** Hlid session owning the control, when one already exists. */
	session_id?: string;
};

/** Exact provider activity requesting an interactive permission decision. */
export type PermissionRequester = {
	providerId: string;
	agentId: string;
	/** Provider-owned agent type when the permission hook reports it. */
	agentType?: string;
};

/** Policy-engine context kept separate from the provider's action description. */
export type PermissionPolicyContext = {
	source: "umbod";
	/** Exact engine reason, retained for technical review. */
	reason: string;
};

export type PermissionRequestMessage = {
	type: "permission_request";
	id: string;
	toolName: string;
	title: string;
	displayName?: string;
	description?: string;
	input?: Record<string, unknown>;
	requester?: PermissionRequester;
	policy?: PermissionPolicyContext;
	/** False when a one-shot grant would immediately cause repetitive prompts. */
	allowOnce?: boolean;
	/** False when the provider cannot support chat-scoped one-shot grants. */
	allowSession?: boolean;
	/** False when permanent approval belongs in the policy manifest instead. */
	allowAlways?: boolean;
};

export type UserMessageEvent = {
	type: "user_message";
	text: string;
	session_id?: string;
	attachments?: ChatAttachment[];
	vault_references?: string[];
	workspace_references?: WorkspaceReferenceRequest[];
	/**
	 * Slice C: turn id from the originating ClientChatMessage. Originating
	 * client uses this to correlate UserMsg → chatQueue entry (so the queued
	 * message is rendered ONCE rather than twice — once as UserMsg in the
	 * transcript and once as a duplicate QueuedMsg). Cross-device clients
	 * can use it for the same correlation.
	 */
	id?: string;
};

/**
 * Slice C polish: server-authoritative queue state. Emitted on connect, sync,
 * and queue changes. Clients use it to rebuild pending text and prune orphan
 * items only within the represented chat.
 */
export type PendingTurnSnapshot = {
	id: string;
	text: string;
	session_id: string;
	skill_context?: string;
	skill_contexts?: string[];
	command_action?: "review" | "computer-use" | "compact";
	agent_cwd?: string;
	attachments?: ChatAttachment[];
	vault_references?: string[];
	workspace_references?: WorkspaceReferenceRequest[];
	plan_mode?: boolean;
	plan_html?: boolean;
	goal?: GoalStartRequest;
	/** Whether this queued payload can be folded into the active provider turn. */
	steerable?: boolean;
};

export type QueueStateSnapshot = {
	/** turn_ids currently in the server's pending queue (head is next-up). */
	pending_turn_ids: string[];
	/** Pending content lets another page/device reconstruct the queue display. */
	pending_turns?: PendingTurnSnapshot[];
	/** turn_id of the turn the server is running, if any. */
	running_turn_id: string | null;
	/** Full pre-dispatch running payload, retained while an active turn sleeps. */
	running_turn?: PendingTurnSnapshot;
};

export type QueueStateMessage = QueueStateSnapshot & {
	type: "queue_state";
	/** DB session whose queue is represented by this snapshot. */
	session_id?: string;
};

/** A queued user message was accepted into the provider's active turn. */
export type TurnSteeredMessage = {
	type: "turn_steered";
	turn_id: string;
	/**
	 * Original user turn whose assistant response accepted this instruction.
	 * Lets Raven place a late acknowledgement above the exact response even
	 * when that response has already completed or a newer turn has started.
	 */
	target_turn_id?: string;
	/** Persisted assistant sequence targeted by this steer, when available. */
	target_assistant_seq?: number;
	/** Persisted sequence of the steering user row. */
	steer_seq?: number;
	/** Raw assistant tool-event count when the provider accepted the steer. */
	steer_tool_event_index?: number;
	session_id?: string;
};

export type McpStatusMessage = {
	type: "mcp_status";
	/** Full cross-provider inventory; provider-scoped updates omit this flag. */
	inventory?: boolean;
	/** Provider that produced this runtime snapshot. Optional for legacy cached payloads. */
	provider_id?: string;
	/** Provider-native controls ready on this live session. */
	operations?: McpControlOperation[];
	servers: Array<{
		name: string;
		status:
			| "connected"
			| "failed"
			| "needs-auth"
			| "pending"
			| "disabled"
			| "unknown";
		/** Provider owning this server when the message is a Cockpit inventory. */
		provider_id?: string;
		scope?: string;
		error?: string;
		/** Claude-native tighten-only override; omission means inherit session mode. */
		permission_mode_override?: "default" | "auto";
	}>;
	/** Set when this status response is scoped to a specific cwd-agent's .mcp.json. */
	agent_cwd?: string;
	/** Set when the snapshot belongs to a specific live Raven session. */
	session_id?: string;
};

export type McpControlOperation =
	| "reconnect"
	| "toggle"
	| "permission-override";
export type McpControlAction =
	| "reconnect"
	| "enable"
	| "disable"
	| "permission-default"
	| "permission-auto"
	| "permission-clear";

export type McpControlResultMessage = {
	type: "mcp_control_result";
	request_id: string;
	session_id: string;
	provider_id?: string;
	server_name: string;
	action: McpControlAction;
	error?: string;
	warning?: string;
};

/** A provider-native file checkpoint captured for one persisted user turn. */
export type FileCheckpointMessage = {
	type: "file_checkpoint";
	session_id: string;
	turn_id: string;
};

export type FileRewindAction = "preview" | "execute";

/** Result of a guarded Claude file-checkpoint preview or rewind. */
export type FileRewindResultMessage = {
	type: "file_rewind_result";
	request_id: string;
	session_id: string;
	turn_id: string;
	action: FileRewindAction;
	can_rewind: boolean;
	files_changed: string[];
	insertions: number;
	deletions: number;
	/** Receipt required by the matching execute request. */
	preview_id?: string;
	error?: string;
};

export type AttachmentCreatedMessage = {
	type: "attachment_created";
	id: string;
	kind: "ephemeral" | "vault";
};

export type ToolUseSummaryMessage = {
	type: "tool_use_summary";
	summary: string;
};

export type LocalCommandOutputMessage = {
	type: "local_command_output";
	/** Stable transcript identity when this output is durably persisted. */
	id?: string;
	content: string;
};

export type SlashCommandsMessage = {
	type: "slash_commands";
	provider_id: string;
	agent_cwd?: string;
	session_id?: string;
	commands: Array<{
		name: string;
		description: string;
		argumentHint: string;
		aliases?: string[];
		action?: "review" | "computer-use" | "goal" | "compact";
	}>;
};

/** Live, session-scoped provider options after dependent configuration changes. */
export type ProviderConfigOptionsMessage = ProviderSessionConfigSnapshot & {
	type: "provider_config_options";
	provider_id: string;
	session_id: string;
	agent_cwd?: string;
};

export type WorkflowCatalogMessage = {
	type: "workflow_catalog";
	provider_id: string;
	agent_cwd?: string;
	session_id?: string;
	workflows: ProviderSavedWorkflow[];
	locations: ProviderWorkflowSaveLocation[];
};

export type WorkflowSaveResultMessage = {
	type: "workflow_save_result";
	request_id: string;
	workflow?: ProviderSavedWorkflow;
	error?: string;
	error_code?:
		| "exists"
		| "invalid-script"
		| "location-unavailable"
		| "unsafe-path";
};

export type WorkflowDeleteResultMessage = {
	type: "workflow_delete_result";
	request_id: string;
	script_path?: string;
	error?: string;
	error_code?: "not-found" | "location-unavailable" | "unsafe-path";
};

export type WorkflowSourceResultMessage = {
	type: "workflow_source_result";
	request_id: string;
	script_path: string;
	source?: string;
	error?: string;
	error_code?:
		| "not-found"
		| "invalid-script"
		| "location-unavailable"
		| "unsafe-path";
};

export type GoalState = {
	thread_id: string;
	objective: string;
	status: ProviderGoalStatus;
	token_budget: number | null;
	tokens_used: number;
	time_used_seconds: number;
	created_at: number;
	updated_at: number;
};

export type GoalStateMessage = {
	type: "goal_state";
	session_id: string;
	provider_id: string;
	request_id?: string;
	goal: GoalState | null;
};

export type GoalErrorMessage = {
	type: "goal_error";
	session_id: string;
	request_id: string;
	message: string;
};

export function mapProviderGoal(goal: ProviderThreadGoal): GoalState {
	return {
		thread_id: goal.threadId,
		objective: goal.objective,
		status: goal.status,
		token_budget: goal.tokenBudget,
		tokens_used: goal.tokensUsed,
		time_used_seconds: goal.timeUsedSeconds,
		created_at: goal.createdAt,
		updated_at: goal.updatedAt,
	};
}

export type AskQuestion = {
	question: string;
	options: string[];
	multiSelect: boolean;
	/** Render a direct input instead of choices for provider elicitation forms. */
	freeText?: boolean;
	inputType?: "text" | "number";
	placeholder?: string;
	/** Optional schema fields do not block submission when left empty. */
	optional?: boolean;
};

export type AskUserQuestionPeerProvenance = {
	/** Provider-sanitized and truncated preview. This is not the exact message body. */
	preview: string;
	/** Exact envelope-stripped body supplied by the provider after delivery. */
	body?: string;
	/** Sender-authored reply address. Treat as a claim, never human authority. */
	from_address?: string;
	/** Provider-sanitized sender display name. Treat as reported speech. */
	claimed_name?: string;
	/** Sender-claimed session target for navigation only, never authority. */
	from_session?: string;
	/** Kernel-verified connecting process, which may be a relay and is not identity. */
	verified_peer_pid?: number;
	/** Provider-reported reason the inbound message was held. */
	hold_cause?:
		| "mode-mismatch"
		| "no-mode-asserted"
		| "explicit-setting"
		| "bypass-default"
		| "mode-unknown";
};

export type AskUserQuestionProvenance = {
	provider_id: string;
	kind: "mcp_elicitation" | "provider_dialog";
	/** MCP server name or provider-native dialog kind. */
	source_name: string;
	/** Provider tool/display label associated with the request, when known. */
	tool_name?: string;
	/** Provider-authored prompt context shown above the shared fields. */
	summary?: string;
	/** Hlid durable turn that originated the blocking interaction. */
	turn_id?: string;
	/** Provider tool invocation tied to the interaction, when supplied. */
	tool_use_id?: string;
	/** URL-mode MCP elicitation target, rendered as an explicit external link. */
	url?: string;
	/** Inbound Claude peer message held outside the model until the user reviews it. */
	peer?: AskUserQuestionPeerProvenance;
};

export const ASK_USER_QUESTION_CANCEL_KEY = "__hlid_cancelled__";

export type AskUserQuestionMessage = {
	type: "ask_user_question";
	id: string;
	questions: AskQuestion[];
	provenance?: AskUserQuestionProvenance;
};

/** answers keyed by question text; arrays support multiSelect (single-select uses a 1-element array). */
export type AskUserQuestionAnswers = Record<string, string[]>;

/** Optional free-text notes the user added per question, keyed by question text. */
export type AskUserQuestionNotes = Record<string, string>;

export type AskUserQuestionResolvedMessage = {
	type: "ask_user_question_resolved";
	id: string;
	answers: AskUserQuestionAnswers;
	notes?: AskUserQuestionNotes;
};

/** Late provider provenance learned only after an approved prompt is released. */
export type AskUserQuestionProvenanceUpdatedMessage = {
	type: "ask_user_question_provenance_updated";
	id: string;
	provenance: AskUserQuestionProvenance;
};

export type PlanModeExitMessage = {
	type: "plan_mode_exit";
	id: string;
	/** Raw ExitPlanMode input from Claude — contains allowedPrompts and any extra fields. */
	input: Record<string, unknown>;
	/** Attachment id of the ingested HTML plan document, when the agent produced one. */
	html_relic_id?: string;
};

export type PlanModeExitResolvedMessage = {
	type: "plan_mode_exit_resolved";
	id: string;
	decision: "approved" | "edited" | "cancelled";
};

export type PermissionDecision =
	| "approved"
	| "approved_session"
	| "approved_always"
	| "denied";

export type PermissionResolvedMessage = {
	type: "permission_resolved";
	id: string;
	toolName: string;
	displayName?: string;
	decision: PermissionDecision;
};

/** Provider-reported block evidence, independent of any human decision. */
export type ProviderPermissionDeniedMessage = {
	type: "provider_permission_denied";
	id: string;
	toolName: string;
	displayName?: string;
	providerId: string;
	reasonType?: string;
	reason?: string;
	providerMessage?: string;
};

/** Narrow an MCP server object to the wire shape used in mcp_status messages. */
export function mapMcpServer(s: {
	name: string;
	status: McpStatusMessage["servers"][number]["status"];
	providerId?: string;
	scope?: string;
	error?: string;
	permissionModeOverride?: "default" | "auto";
}): McpStatusMessage["servers"][number] {
	return {
		name: s.name,
		status: s.status,
		provider_id: s.providerId,
		scope: s.scope,
		error: s.error,
		permission_mode_override: s.permissionModeOverride,
	};
}

/** Map (approved, saveScope) from the WS client into a stable decision string. */
export function decisionFromScope(
	approved: boolean,
	saveScope?: "session" | "local",
): PermissionDecision {
	if (!approved) return "denied";
	if (saveScope === "local") return "approved_always";
	if (saveScope === "session") return "approved_session";
	return "approved";
}

/**
 * Human label shown in chat UI for approval decisions. Returns null for
 * non-approval values ("denied", "pending", or any unknown string) so
 * callers can fall back to their own treatment.
 */
export function approvedLabel(decision: string): string | null {
	switch (decision) {
		case "approved_always":
			return "APPROVED ALWAYS";
		case "approved_session":
			return "APPROVED FOR SESSION";
		case "approved":
			return "APPROVED";
		default:
			return null;
	}
}

// ── Multi-session types ───────────────────────────────────────────────────────

export type SessionAttentionBucket =
	| "needs_attention"
	| "working"
	| "sleeping"
	| "queued"
	| "recent";

export type SessionAttentionReason =
	| "permission"
	| "question"
	| "plan_review"
	| "error"
	| "provider_turn"
	| "provider_activity"
	| "background_completed"
	| "background_failed"
	| "usage_sleep"
	| "terminal"
	| "queued_prompt"
	| "goal_active"
	| "goal_blocked"
	| "goal_budget"
	| "goal_paused"
	| "goal_usage_wait"
	| "routine_running"
	| "routine_queued"
	| "routine_action_required"
	| "routine_delivery_error"
	| "routine_failed"
	| "routine_unavailable"
	| "routine_recent"
	| "delegation_interrupted"
	| "delegated_child_attention"
	| "delegated_child_working"
	| "delegated_child_sleeping"
	| "delegated_child_queued"
	| "ready";

/**
 * Server-owned presentation snapshot derived from existing session state.
 * This is not another lifecycle source of truth.
 */
export type SessionAttentionSnapshot = {
	bucket: SessionAttentionBucket;
	reason: SessionAttentionReason;
	/** Millisecond timestamp for when the current bucket and reason began. */
	since: number;
	/** Millisecond timestamp for the latest meaningful state transition. */
	last_activity_at: number;
	queue_count: number;
	pending_count: number;
	/** Count for the highest-priority direct request reason. */
	pending_reason_count?: number;
	/** Bounded opaque IDs for the current direct request category. */
	pending_ids?: string[];
	/** Epoch seconds when the current usage sleep is expected to end. */
	sleep_until?: number;
	/** Usage window responsible for the current sleep. */
	sleep_window_id?: string;
};

export type DelegatedAttentionRollup = {
	direct_count: number;
	descendant_count: number;
	/** Durable descendants that are pending or resumably restart-interrupted. */
	waiting_count: number;
	/** Durable descendants that completed successfully. */
	completed_count: number;
	/** Durable descendants that failed, timed out, exhausted budget, or cannot resume. */
	failed_count: number;
	/** Cumulative tokens reported across durable descendants. */
	total_tokens?: number;
	/** Cumulative available reported or estimated cost across durable descendants. */
	total_cost?: number;
	/** Wall-clock span from the first descendant start through the last stop or now. */
	elapsed_duration_seconds?: number;
	needs_attention_count: number;
	working_count: number;
	/** Optional for compatibility with snapshots from older Hlid servers. */
	sleeping_count?: number;
	queued_count: number;
	recent_count: number;
	leading_bucket: SessionAttentionBucket;
	since: number;
	last_activity_at: number;
};

/** Status snapshot for a single live session in the pool. */
export type SessionStatusEntry = {
	session_id: string;
	agent_cwd: string;
	agent_name: string;
	state: "idle" | "running" | "error";
	/** Provider currently configured for this live session. */
	provider_id?: string;
	model: string;
	/** Current session-scoped effort, when the live session exposes one. */
	effort?: string;
	/** Current session-scoped permission mode, when available. */
	permission_mode?: string;
	/** Codex-native reviewer selected for interactive provider approvals. */
	approvals_reviewer?: ProviderApprovalsReviewer;
	/** Live and recently settled provider work that outlives its parent turn. */
	background_activities?: import("./agentProvider").ProviderBackgroundActivity[];
	hasPendingPermissions: boolean;
	/** True while this pool entry is owned by the Routine scheduler's outcome path. */
	routine_owned?: boolean;
	/**
	 * Rich attention state. Optional for compatibility with older connected
	 * clients and deterministic fixtures; current servers always include it.
	 */
	attention?: SessionAttentionSnapshot;
	/** Fixed durable lifecycle counts plus cycle-safe live descendant attention. */
	delegated_attention?: DelegatedAttentionRollup;
	/** True when the session has started at least one DB chat (getCurrentSessionId !== null). */
	hasDbSession: boolean;
	/** The DB chat session ID currently open in this pool session, if any. */
	db_session_id: string | null;
	lastLabel?: string;
	/** Navigation preference; never changes the attention bucket. */
	pinned?: boolean;
	/** Existing exact or recap fork provenance for compact disambiguation. */
	fork_parent_session_id?: string | null;
	fork_parent_label?: string | null;
	fork_kind?: "exact" | "recap" | null;
	/** Durable Hlid delegation provenance, kept distinct from native forks. */
	delegation_parent_session_id?: string | null;
	delegation_parent_label?: string | null;
	delegation_parent_turn_id?: string | null;
	delegation_depth?: number | null;
	/** Durable delegation lifecycle projected after its provider process is gone. */
	delegation_id?: string;
	delegation_status?: "interrupted";
	delegation_resumable?: boolean;
	/** True when this attention row is DB-backed but has no live provider process. */
	durable_only?: boolean;
	/**
	 * "sdk" = custom UI backed by the Claude Agent SDK (default, undefined = sdk).
	 * "terminal" = raw PTY session running claude CLI via xterm.js.
	 */
	mode?: "sdk" | "terminal";
};

/**
 * Sent to ALL connected clients whenever pool state changes.
 * Used to render the RAVEN sidebar and LEDGER ACTIVE tab.
 */
export type SessionsStatusMessage = {
	type: "sessions_status";
	sessions: SessionStatusEntry[];
};

/** Broadcast when a session entry is removed from the pool. */
export type SessionClosedMessage = {
	type: "session_closed";
	session_id: string;
};

/** Sent to the requesting client when a new session entry is created. */
export type SessionCreatedMessage = {
	type: "session_created";
	session_id: string;
	agent_cwd: string;
	agent_name: string;
};

export type DataRevisionsMessage = {
	type: "data_revisions";
	revisions: import("../lib/dataRevision").DataRevisionSnapshot;
};

export type RealtimeMode = "dictation" | "live" | "read-aloud";

export type RealtimeEventMessage =
	| {
			type: "realtime_state";
			session_id: string;
			request_id?: string;
			mode: RealtimeMode;
			state: "starting" | "connected" | "closed";
			reason?: string;
	  }
	| {
			type: "realtime_sdp";
			session_id: string;
			request_id?: string;
			mode: RealtimeMode;
			sdp: string;
	  }
	| {
			type: "realtime_audio";
			session_id: string;
			request_id?: string;
			mode: RealtimeMode;
			state: "started";
	  }
	| {
			type: "realtime_transcript";
			session_id: string;
			request_id?: string;
			mode: "live";
			role: "user" | "assistant";
			text: string;
			done: boolean;
			/** Stable Hlid-owned identity for one role-bearing realtime utterance. */
			utterance_id: string;
			/** Hlid-owned identity for one realtime start generation. */
			realtime_session_id: string;
			/** Provider-owned realtime call identity, when Codex reports one. */
			provider_realtime_session_id?: string;
			/** Durable Raven transcript position reserved for this utterance. */
			transcript_seq: number;
			/** Persisted messages.id, present only after a final transcript is durable. */
			db_id?: number;
			source: "codex_realtime";
			/** Live rows lack a provider-native turn cutoff in the current protocol. */
			fork_supported: boolean;
	  }
	| {
			type: "realtime_transcript";
			session_id: string;
			request_id?: string;
			mode: "dictation" | "read-aloud";
			role: string;
			text: string;
			done: boolean;
	  }
	| {
			type: "realtime_error";
			session_id: string;
			request_id?: string;
			mode: RealtimeMode;
			message: string;
	  };

export type ProjectPreviewState = "starting" | "ready" | "failed" | "stopped";

export type ProjectPreviewSnapshot = {
	id: string;
	target_kind?: "project" | "browser";
	session_id: string;
	label: string;
	command: string;
	cwd: string;
	port: number;
	path: string;
	url: string;
	relay_url: string;
	state: ProjectPreviewState;
	present: boolean;
	started_at: string;
	expires_at: string;
	ended_at?: string;
	exit_code?: number;
	error?: string;
	stop_reason?: string;
	logs: string[];
};

export type ProjectPreviewAgentElement = {
	ref: string;
	role: string;
	name: string;
	tag: string;
	type?: string;
	disabled?: boolean;
	x: number;
	y: number;
	width: number;
	height: number;
};

export type ProjectPreviewAgentFrame = {
	preview_id: string;
	session_id: string;
	path: string;
	viewport: "desktop" | "tablet" | "mobile";
	width: number;
	height: number;
	pixel_width?: number;
	pixel_height?: number;
	device_scale_factor?: number;
	pixel_ratio?: number;
	full_page: boolean;
	captured_at: number;
	mime: "image/png";
	size_bytes: number;
	image_base64: string;
	frame_id: string;
	title: string;
	elements: ProjectPreviewAgentElement[];
	console_messages: string[];
	failed_requests: string[];
	target_kind?: "project" | "browser";
	recording?: boolean;
	last_action?:
		| "click"
		| "type"
		| "key"
		| "scroll"
		| "navigate"
		| "reload"
		| "viewport";
};

export type ProjectPreviewAgentFrameSummary = Pick<
	ProjectPreviewAgentFrame,
	| "frame_id"
	| "captured_at"
	| "path"
	| "viewport"
	| "width"
	| "height"
	| "full_page"
	| "last_action"
>;

export type ProjectPreviewAgentFrameWindow = {
	preview_id: string;
	session_id: string;
	frames: ProjectPreviewAgentFrameSummary[];
	latest_frame: ProjectPreviewAgentFrame | null;
};

export type ProjectPreviewFeedbackResult = {
	attachment: ChatAttachment;
	open_url: string;
};

export type ProjectPreviewFeedbackAnnotation = {
	mark_index: number;
	mark_kind: "highlight" | "rectangle" | "arrow" | "text";
	ref: string;
	role: string;
	name: string;
	tag: string;
	type?: string;
	disabled?: boolean;
	bounds: { x: number; y: number; width: number; height: number };
};

export type ProjectPreviewStatusMessage = {
	type: "project_preview_status";
	session_id: string;
	preview: ProjectPreviewSnapshot | null;
};

/**
 * Messages retained for an in-flight session so a reconnecting Raven can
 * reconstruct the active response. Live delivery remains one message at a
 * time; only reconnect catch-up uses SessionReplayMessage envelopes.
 */
export type ReplayBufferMessage =
	| ChunkMessage
	| AssistantRevisionMessage
	| ToolEventMessage
	| ToolUpdateMessage
	| ToolActivityUpdateMessage
	| ToolProgressUpdateMessage
	| ToolResultMessage
	| PermissionRequestMessage
	| PermissionResolvedMessage
	| ProviderPermissionDeniedMessage;

/** Bounded reconnect catch-up batch for one focused live session. */
export type SessionReplayMessage = {
	type: "session_replay";
	session_id?: string;
	messages: ReplayBufferMessage[];
};

export type ServerMessage =
	| StatusMessage
	| ConnectionAckMessage
	| ChunkMessage
	| AssistantRevisionMessage
	| ToolEventMessage
	| ToolUpdateMessage
	| ToolActivityUpdateMessage
	| ToolProgressUpdateMessage
	| ToolResultMessage
	| DoneMessage
	| RateLimitMessage
	| AgentSleepMessage
	| UsageUpdateMessage
	| ContextUpdateMessage
	| ErrorMessage
	| SessionControlRejectedMessage
	| PermissionRequestMessage
	| PermissionResolvedMessage
	| ProviderPermissionDeniedMessage
	| UserMessageEvent
	| QueueStateMessage
	| TurnSteeredMessage
	| McpStatusMessage
	| McpControlResultMessage
	| FileCheckpointMessage
	| FileRewindResultMessage
	| AttachmentCreatedMessage
	| ToolUseSummaryMessage
	| AskUserQuestionMessage
	| AskUserQuestionResolvedMessage
	| AskUserQuestionProvenanceUpdatedMessage
	| PlanModeExitMessage
	| PlanModeExitResolvedMessage
	| LocalCommandOutputMessage
	| SlashCommandsMessage
	| ProviderConfigOptionsMessage
	| WorkflowCatalogMessage
	| WorkflowSaveResultMessage
	| WorkflowDeleteResultMessage
	| WorkflowSourceResultMessage
	| GoalStateMessage
	| GoalErrorMessage
	| SessionsStatusMessage
	| SessionClosedMessage
	| SessionCreatedMessage
	| RealtimeEventMessage
	| ProjectPreviewStatusMessage
	| SessionReplayMessage
	| DataRevisionsMessage;

export type ChatAttachment = {
	id: string;
	path: string;
	filename: string;
	mime: string;
	kind: string;
	/** Existing Relic selected as context, not a newly uploaded attachment. */
	reference?: "relic";
};

export type GoalStartRequest = {
	objective: string;
	token_budget?: number | null;
};

export type ClientInitialNotificationPolicy = {
	mode: Exclude<SessionNotificationMode, "default">;
	scope: SessionNotificationScope;
	target_device_ids: string[] | null;
};

// Client → server messages
export type ClientChatMessage = {
	type: "chat";
	text: string;
	session_id?: string;
	skill_context?: string;
	skill_contexts?: string[];
	/** Hlid-owned capability action, executed directly instead of prompt passthrough. */
	command_action?: "review" | "computer-use" | "compact";
	agent_cwd?: string;
	attachments?: ChatAttachment[];
	/** Vault-root-relative files selected with the @ picker. */
	vault_references?: string[];
	/** Exact active-workspace files selected after previewing this revision. */
	workspace_references?: WorkspaceReferenceRequest[];
	/**
	 * Slice C: client-generated turn id. Server stores it on the QueuedTurn
	 * and echoes it back in the matching `done` event so the client can
	 * correlate done events to specific submitted msgs (and cancel by id).
	 */
	turn_id?: string;
	/** Enable plan mode for this session (only effective on first turn). */
	plan_mode?: boolean;
	/** With plan_mode: ask the agent to render its plan as an HTML document. */
	plan_html?: boolean;
	/** Raven's session-scoped CLI/model controls, repeated on chat for archived-session restoration. */
	provider?: string;
	model?: string;
	effort?: string;
	permission_mode?: string;
	approvals_reviewer?: ProviderApprovalsReviewer;
	/** Provisional policy committed atomically when this first chat creates its DB session. */
	notification_policy?: ClientInitialNotificationPolicy;
	/** Start or replace the native Codex goal before submitting this turn. */
	goal?: GoalStartRequest;
};

export type ClientCancelQueuedMessage = {
	type: "cancel_queued";
	turn_id: string;
};

export type ClientPromoteQueuedMessage = {
	type: "promote_queued";
	turn_id: string;
};

export type ClientSteerQueuedMessage = {
	type: "steer_queued";
	turn_id: string;
};

/**
 * Send a text-only instruction directly into a delegation-owned provider turn.
 * This never enters the ordinary fresh-turn queue.
 */
export type ClientSteerActiveMessage = {
	type: "steer_active";
	session_id: string;
	turn_id: string;
	text: string;
};

export type ClientAbortMessage = {
	type: "abort";
};

// "Resume now" for an auto-sleep pause: wake every session sleeping on this
// session's provider (the usage budget is shared provider-wide).
export type ClientSkipSleepMessage = {
	type: "skip_sleep";
};

export type ClientClearMessage = {
	type: "clear";
};

export type ClientReloadMessage = {
	type: "reload_session";
};

export type ClientPermissionResponseMessage = {
	type: "permission_response";
	id: string;
	approved: boolean;
	saveScope?: "session" | "local";
	/** Custom message fed to Claude when denying — "tell Claude what to do instead". */
	denyMessage?: string;
};

export type ClientSyncMessage = {
	type: "sync";
};

/** Transport-only round-trip probe; it must not trigger session restoration. */
export type ClientConnectionProbeMessage = {
	type: "connection_probe";
	request_id: string;
};

/**
 * Short-lived proof that this browser is visibly showing Hlid. Presence is
 * app-global; the optional session ID is accepted for rolling compatibility
 * with older clients and has no effect on notification routing.
 */
export type ClientNotificationPresenceMessage = {
	type: "notification_presence";
	session_id?: string;
	visible: boolean;
};

export type ClientProbeMcpMessage = {
	type: "probe_mcp";
	agent_cwd?: string;
	session_id?: string;
};

/** Replay dependent options from an already-live provider session. */
export type ClientProbeProviderConfigMessage = {
	type: "probe_provider_config";
	agent_cwd?: string;
	session_id?: string;
};

export type ClientMcpControlMessage = {
	type: "mcp_control";
	request_id: string;
	session_id: string;
	server_name: string;
	action: McpControlAction;
};

export type ClientFileRewindMessage = {
	type: "file_rewind";
	request_id: string;
	session_id: string;
	/** Hlid user turn; the server resolves the owned native checkpoint. */
	turn_id: string;
	action: FileRewindAction;
	/** Required for execute and issued by the immediately preceding preview. */
	preview_id?: string;
};

export type ClientProbeSlashCommandsMessage = {
	type: "probe_slash_commands";
	agent_cwd?: string;
	session_id?: string;
};

export type ClientProbeWorkflowsMessage = {
	type: "probe_workflows";
	agent_cwd?: string;
	session_id?: string;
};

export type ClientSaveWorkflowMessage = {
	type: "save_workflow";
	request_id: string;
	session_id?: string;
	source_script_path: string;
	scope: ProviderWorkflowSaveScope;
	overwrite?: boolean;
};

export type ClientDeleteWorkflowMessage = {
	type: "delete_workflow";
	request_id: string;
	session_id?: string;
	script_path: string;
	scope: ProviderWorkflowSaveScope;
};

export type ClientReadWorkflowSourceMessage = {
	type: "read_workflow_source";
	request_id: string;
	session_id?: string;
	script_path: string;
	scope?: ProviderWorkflowSaveScope;
};

export type ClientGoalControlMessage = {
	type: "goal_control";
	request_id: string;
	session_id: string;
	action: "get" | "set" | "pause" | "resume" | "clear";
	objective?: string;
	token_budget?: number | null;
	agent_cwd?: string;
};

export type ClientRealtimeMessage =
	| {
			type: "realtime_start";
			session_id: string;
			request_id?: string;
			mode: RealtimeMode;
			sdp: string;
			voice?: string;
			agent_cwd?: string;
	  }
	| {
			type: "realtime_speak";
			session_id: string;
			request_id: string;
			mode: "read-aloud";
			text: string;
	  }
	| {
			type: "realtime_stop";
			session_id: string;
			request_id?: string;
			/** Lets the server acknowledge teardown even after the live entry retired. */
			mode?: RealtimeMode;
	  };

export type ClientSyncMcpListMessage = {
	type: "sync_mcp_list";
	/** When set, sync MCP servers from this cwd-agent's .mcp.json instead of the vault's. */
	agent_cwd?: string;
	/** Cockpit requests the known inventory across provider sessions for this context. */
	inventory?: boolean;
};

export type ClientAskUserQuestionResponseMessage = {
	type: "ask_user_question_response";
	id: string;
	answers: AskUserQuestionAnswers;
	/** Optional free-text user feedback per question, keyed by question text. */
	notes?: AskUserQuestionNotes;
};

export type ClientPlanModeExitResponseMessage =
	| {
			type: "plan_mode_exit_response";
			id: string;
			decision: "approved" | "cancelled";
	  }
	| {
			type: "plan_mode_exit_response";
			id: string;
			decision: "edited";
			feedback: string;
	  };

// ── Multi-session client → server messages ────────────────────────────────────

/** Switch this WS connection's focused session. Server replays the new session's buffer. */
export type ClientSubscribeSessionMessage = {
	type: "subscribe_session";
	session_id: string;
};

/** Abort the running turn in a session but keep it in the pool. */
export type ClientStopSessionMessage = {
	type: "stop_session";
	session_id: string;
};

/** Abort the running turn and remove the session from the pool entirely. */
export type ClientCloseSessionMessage = {
	type: "close_session";
	session_id: string;
};

/**
 * Mid-session model switch for the subscribed session. Session-scoped only —
 * never written to hlid.config.toml. `undefined` resets to the provider
 * default.
 */
export type ClientSetModelMessage = {
	type: "set_model";
	model?: string;
	session_id?: string;
};

/** Explicitly move this Hlid chat to another installed CLI without changing config. */
export type ClientSetProviderMessage = {
	type: "set_provider";
	provider: string;
	model?: string;
	effort?: string;
	permission_mode?: string;
	approvals_reviewer?: ProviderApprovalsReviewer;
	session_id?: string;
};

/**
 * Mid-session permission-mode switch for the subscribed session.
 * Session-scoped only — never written to hlid.config.toml. Server rejects
 * unrecognized modes with an `error` message.
 */
export type ClientSetPermissionModeMessage = {
	type: "set_permission_mode";
	mode: string;
	session_id?: string;
};

/** Mid-session switch for Codex's native interactive-approval reviewer. */
export type ClientSetApprovalsReviewerMessage = {
	type: "set_approvals_reviewer";
	reviewer: ProviderApprovalsReviewer;
	session_id?: string;
};

/**
 * Mid-session effort/thinking-level switch for the subscribed session.
 * Session-scoped only — never written to hlid.config.toml. Unlike
 * `set_model`, not every provider can apply this to the already-running
 * provider stream (see AgentSession.setEffort). Hlid rebuilds those streams
 * at the next turn boundary and resumes their provider-side history.
 */
export type ClientSetEffortMessage = {
	type: "set_effort";
	effort: string;
	session_id?: string;
};

/** Select one opaque conversational mode advertised by the live provider. */
export type ClientSetProviderModeMessage = {
	type: "set_provider_mode";
	mode: string;
	session_id?: string;
};

/** Restore the provider mode that was active before entering Plan mode. */
export type ClientRestoreProviderModeMessage = {
	type: "restore_provider_mode";
	session_id?: string;
};

/** Native control for one provider-owned workflow/background task. */
export type ClientWorkflowControlMessage = {
	type: "workflow_control";
	action: "stop";
	task_id: string;
	session_id?: string;
};

/** Exact native control for session-level provider background work. */
export type ClientBackgroundActivityControlMessage = {
	type: "background_activity_control";
	action: "background" | "stop" | "terminate" | "clean";
	activity_id?: string;
	session_id?: string;
};

export type ClientMessage =
	| ClientChatMessage
	| ClientCancelQueuedMessage
	| ClientPromoteQueuedMessage
	| ClientSteerQueuedMessage
	| ClientSteerActiveMessage
	| ClientAbortMessage
	| ClientSkipSleepMessage
	| ClientClearMessage
	| ClientReloadMessage
	| ClientPermissionResponseMessage
	| ClientSyncMessage
	| ClientConnectionProbeMessage
	| ClientNotificationPresenceMessage
	| ClientProbeMcpMessage
	| ClientProbeProviderConfigMessage
	| ClientMcpControlMessage
	| ClientFileRewindMessage
	| ClientProbeSlashCommandsMessage
	| ClientProbeWorkflowsMessage
	| ClientSaveWorkflowMessage
	| ClientDeleteWorkflowMessage
	| ClientReadWorkflowSourceMessage
	| ClientGoalControlMessage
	| ClientRealtimeMessage
	| ClientSyncMcpListMessage
	| ClientAskUserQuestionResponseMessage
	| ClientPlanModeExitResponseMessage
	| ClientSubscribeSessionMessage
	| ClientStopSessionMessage
	| ClientCloseSessionMessage
	| ClientSetProviderMessage
	| ClientSetModelMessage
	| ClientSetPermissionModeMessage
	| ClientSetApprovalsReviewerMessage
	| ClientSetEffortMessage
	| ClientSetProviderModeMessage
	| ClientRestoreProviderModeMessage
	| ClientWorkflowControlMessage
	| ClientBackgroundActivityControlMessage;
