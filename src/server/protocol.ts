// Server → client messages
export type StatusMessage = {
	type: "status";
	state: "idle" | "running" | "error";
	model: string;
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
};

export type ToolEventMessage = {
	type: "tool_event";
	name: string;
	input: unknown;
	id: string;
	/** Populated client-side once a matching tool_result arrives or from history. */
	result?: string;
	isError?: boolean;
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
	utilization?: number;
	resetsAt?: number;
	/** Provider that emitted this rate-limit event, e.g. "claude". */
	providerId?: string;
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
	// (e.g. "claude-opus-4-7-20251001"); strip with /-\d{8}$/ to compare.
	actualModel?: string;
	// Max context window for the model used this inference. Carried forward
	// from the most recent `result` message so the gauge can render without
	// waiting for the next `done`. Absent on the very first turn of a fresh
	// session (no prior result yet).
	context_window?: number;
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
};

export type UserMessageEvent = {
	type: "user_message";
	text: string;
	session_id?: string;
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
	servers: Array<{
		name: string;
		status: "connected" | "failed" | "needs-auth" | "pending" | "disabled";
		scope?: string;
		error?: string;
	}>;
	/** Set when this status response is scoped to a specific cwd-agent's .mcp.json. */
	agent_cwd?: string;
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

export type AskQuestion = {
	question: string;
	options: string[];
	multiSelect: boolean;
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
	scope?: string;
	error?: string;
}): McpStatusMessage["servers"][number] {
	return { name: s.name, status: s.status, scope: s.scope, error: s.error };
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

export type ServerMessage =
	| StatusMessage
	| ChunkMessage
	| ToolEventMessage
	| ToolResultMessage
	| DoneMessage
	| RateLimitMessage
	| UsageUpdateMessage
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
	| PlanModeExitResolvedMessage;

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
};

export type ClientSyncMcpListMessage = {
	type: "sync_mcp_list";
	/** When set, sync MCP servers from this cwd-agent's .mcp.json instead of the vault's. */
	agent_cwd?: string;
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

export type ClientMessage =
	| ClientChatMessage
	| ClientCancelQueuedMessage
	| ClientPromoteQueuedMessage
	| ClientAbortMessage
	| ClientClearMessage
	| ClientReloadMessage
	| ClientPermissionResponseMessage
	| ClientSyncMessage
	| ClientProbeMcpMessage
	| ClientSyncMcpListMessage
	| ClientAskUserQuestionResponseMessage
	| ClientPlanModeExitResponseMessage;
