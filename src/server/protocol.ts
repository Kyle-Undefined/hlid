// Server → client messages
export type StatusMessage = {
	type: "status";
	state: "idle" | "running" | "error";
	model: string;
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
};

export type ToolResultMessage = {
	type: "tool_result";
	id: string;
};

export type DoneMessage = {
	type: "done";
	session_id?: string;
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
};

export type McpStatusMessage = {
	type: "mcp_status";
	servers: Array<{
		name: string;
		status: "connected" | "failed" | "needs-auth" | "pending" | "disabled";
		scope?: string;
		error?: string;
	}>;
};

export type AttachmentCreatedMessage = {
	type: "attachment_created";
	id: string;
	kind: "ephemeral" | "vault";
};

export type PermissionResolvedMessage = {
	type: "permission_resolved";
	id: string;
	toolName: string;
	displayName?: string;
	decision: "approved" | "approved_session" | "approved_always" | "denied";
};

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
	| McpStatusMessage
	| AttachmentCreatedMessage;

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
};

export type ClientSyncMessage = {
	type: "sync";
};

export type ClientProbeMcpMessage = {
	type: "probe_mcp";
};

export type ClientSyncMcpListMessage = {
	type: "sync_mcp_list";
};

export type ClientMessage =
	| ClientChatMessage
	| ClientAbortMessage
	| ClientClearMessage
	| ClientReloadMessage
	| ClientPermissionResponseMessage
	| ClientSyncMessage
	| ClientProbeMcpMessage
	| ClientSyncMcpListMessage;
