import type { SubagentSnapshot } from "./agentProvider";

// Server → client messages
export type StatusMessage = {
	type: "status";
	state: "idle" | "running" | "error";
	model: string;
	/**
	 * Current permission mode for this session. Session-scoped — reflects
	 * config defaults until a `set_permission_mode` client message overrides
	 * it; never persisted to hlid.config.toml.
	 */
	permission_mode?: string;
	/**
	 * Current effort/thinking level for this session. Session-scoped like
	 * permission_mode — reflects config defaults until a `set_effort` client
	 * message overrides it; never persisted to hlid.config.toml.
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

export type ChunkMessage = {
	type: "chunk";
	text: string;
	/**
	 * UTF-16 offset of this delta within the current assistant turn. Replayed
	 * chunks keep the same offset so clients can apply them idempotently after
	 * a remount or WebSocket reconnect.
	 */
	offset?: number;
};

export type ToolEventMessage = {
	type: "tool_event";
	name: string;
	input: unknown;
	id: string;
	/** Populated client-side once a matching tool_result arrives or from history. */
	result?: string;
	isError?: boolean;
	subagent?: SubagentSnapshot;
};

export type ToolUpdateMessage = {
	type: "tool_update";
	id: string;
	subagent: SubagentSnapshot;
};

export type ToolResultMessage = {
	type: "tool_result";
	id: string;
	content: string;
	isError?: boolean;
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

// Per-turn usage snapshot, emitted on every assistant message so the UI
// can update the context gauge / live stats without waiting for `done`.
// Cumulative fields (cost, duration, num_turns, stop_reason, total tokens)
// are NOT included here — those only land at the result boundary.
export type UsageUpdateMessage = {
	type: "usage_update";
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
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
};

export type PermissionRequestMessage = {
	type: "permission_request";
	id: string;
	toolName: string;
	title: string;
	displayName?: string;
	description?: string;
	input?: Record<string, unknown>;
	/** False when a one-shot grant would immediately cause repetitive prompts. */
	allowOnce?: boolean;
	/** False when permanent approval belongs in the policy manifest instead. */
	allowAlways?: boolean;
};

export type UserMessageEvent = {
	type: "user_message";
	text: string;
	session_id?: string;
	attachments?: ChatAttachment[];
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
 * Slice C polish: server-authoritative queue state. Emitted on connect and
 * sync. Client uses it to prune orphan chatQueue items (e.g. items that
 * were _sent before a server restart and the server no longer has a
 * matching QueuedTurn).
 */
export type QueueStateMessage = {
	type: "queue_state";
	/** turn_ids currently in the server's pending queue (head is next-up). */
	pending_turn_ids: string[];
	/** turn_id of the turn the server is running, if any. */
	running_turn_id: string | null;
};

export type McpStatusMessage = {
	type: "mcp_status";
	/** Provider that produced this runtime snapshot. Optional for legacy cached payloads. */
	provider_id?: string;
	servers: Array<{
		name: string;
		status: "connected" | "failed" | "needs-auth" | "pending" | "disabled";
		/** Provider owning this server when the message is a Cockpit inventory. */
		provider_id?: string;
		scope?: string;
		error?: string;
	}>;
	/** Set when this status response is scoped to a specific cwd-agent's .mcp.json. */
	agent_cwd?: string;
	/** Set when the snapshot belongs to a specific live Raven session. */
	session_id?: string;
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
		action?: "review" | "computer-use";
	}>;
};

export type AskQuestion = {
	question: string;
	options: string[];
	multiSelect: boolean;
	/** Render a direct input instead of choices (used by ACP elicitation forms). */
	freeText?: boolean;
	inputType?: "text" | "number";
	placeholder?: string;
};

export type AskUserQuestionMessage = {
	type: "ask_user_question";
	id: string;
	questions: AskQuestion[];
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

/** Narrow an MCP server object to the wire shape used in mcp_status messages. */
export function mapMcpServer(s: {
	name: string;
	status: McpStatusMessage["servers"][number]["status"];
	providerId?: string;
	scope?: string;
	error?: string;
}): McpStatusMessage["servers"][number] {
	return {
		name: s.name,
		status: s.status,
		provider_id: s.providerId,
		scope: s.scope,
		error: s.error,
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

/** Status snapshot for a single live session in the pool. */
export type SessionStatusEntry = {
	session_id: string;
	agent_cwd: string;
	agent_name: string;
	state: "idle" | "running" | "error";
	model: string;
	hasPendingPermissions: boolean;
	/** True when the session has started at least one DB chat (getCurrentSessionId !== null). */
	hasDbSession: boolean;
	/** The DB chat session ID currently open in this pool session, if any. */
	db_session_id: string | null;
	lastLabel?: string;
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

export type ServerMessage =
	| StatusMessage
	| ChunkMessage
	| ToolEventMessage
	| ToolUpdateMessage
	| ToolResultMessage
	| DoneMessage
	| RateLimitMessage
	| AgentSleepMessage
	| UsageUpdateMessage
	| ContextUpdateMessage
	| ErrorMessage
	| PermissionRequestMessage
	| PermissionResolvedMessage
	| UserMessageEvent
	| QueueStateMessage
	| McpStatusMessage
	| AttachmentCreatedMessage
	| ToolUseSummaryMessage
	| AskUserQuestionMessage
	| AskUserQuestionResolvedMessage
	| PlanModeExitMessage
	| PlanModeExitResolvedMessage
	| LocalCommandOutputMessage
	| SlashCommandsMessage
	| SessionsStatusMessage
	| SessionClosedMessage
	| SessionCreatedMessage;

export type ChatAttachment = {
	id: string;
	path: string;
	filename: string;
	mime: string;
	kind: string;
};

// Client → server messages
export type ClientChatMessage = {
	type: "chat";
	text: string;
	session_id?: string;
	skill_context?: string;
	/** Hlid-owned capability action, executed directly instead of prompt passthrough. */
	command_action?: "review" | "computer-use";
	agent_cwd?: string;
	attachments?: ChatAttachment[];
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
};

export type ClientCancelQueuedMessage = {
	type: "cancel_queued";
	turn_id: string;
};

export type ClientPromoteQueuedMessage = {
	type: "promote_queued";
	turn_id: string;
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

export type ClientProbeMcpMessage = {
	type: "probe_mcp";
	agent_cwd?: string;
	session_id?: string;
};

export type ClientProbeSlashCommandsMessage = {
	type: "probe_slash_commands";
	agent_cwd?: string;
	session_id?: string;
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

/** Create a new session (optionally for a specific agent). Server replies with session_created. */
export type ClientNewSessionMessage = {
	type: "new_session";
	agent_cwd?: string;
	agent_name?: string;
};

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

export type ClientMessage =
	| ClientChatMessage
	| ClientCancelQueuedMessage
	| ClientPromoteQueuedMessage
	| ClientAbortMessage
	| ClientSkipSleepMessage
	| ClientClearMessage
	| ClientReloadMessage
	| ClientPermissionResponseMessage
	| ClientSyncMessage
	| ClientProbeMcpMessage
	| ClientProbeSlashCommandsMessage
	| ClientSyncMcpListMessage
	| ClientAskUserQuestionResponseMessage
	| ClientPlanModeExitResponseMessage
	| ClientNewSessionMessage
	| ClientSubscribeSessionMessage
	| ClientStopSessionMessage
	| ClientCloseSessionMessage
	| ClientSetProviderMessage
	| ClientSetModelMessage
	| ClientSetPermissionModeMessage
	| ClientSetEffortMessage;
