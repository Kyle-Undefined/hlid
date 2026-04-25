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
};

export type RateLimitMessage = {
	type: "rate_limit";
	status: string;
	rateLimitType?: string;
	utilization?: number;
	resetsAt?: number;
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
};

export type UserMessageEvent = {
	type: "user_message";
	text: string;
	session_id?: string;
};

export type ServerMessage =
	| StatusMessage
	| ChunkMessage
	| ToolEventMessage
	| ToolResultMessage
	| DoneMessage
	| RateLimitMessage
	| ErrorMessage
	| PermissionRequestMessage
	| UserMessageEvent;

// Client → server messages
export type ClientChatMessage = {
	type: "chat";
	text: string;
	session_id?: string;
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
};

export type ClientMessage =
	| ClientChatMessage
	| ClientAbortMessage
	| ClientClearMessage
	| ClientReloadMessage
	| ClientPermissionResponseMessage;
