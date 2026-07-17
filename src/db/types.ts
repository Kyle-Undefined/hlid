export type SessionRow = {
	id: string;
	label: string | null;
	model: string | null;
	selected_model?: string | null;
	selected_effort?: string | null;
	selected_permission_mode?: string | null;
	provider_id?: string | null;
	agent_cwd?: string | null;
	history_imported?: number;
	started_at: number;
	ended_at: number | null;
	query_count: number;
	total_cost: number;
	total_estimated_cost?: number;
	unpriced_query_count?: number;
	total_input_tokens: number;
	total_output_tokens: number;
	total_cache_read_tokens: number;
	total_cache_creation_tokens: number;
	total_turns: number;
};

export type SessionSelection = {
	agentCwd: string | null;
	providerId: string | null;
	model: string | null;
	effort: string | null;
	permissionMode: string | null;
};

export type MessageRow = {
	id: number;
	session_id: string;
	seq: number;
	role: string;
	text: string;
	timestamp: number;
	recap: string | null;
	/** Stable queued-turn identity for user messages created by Raven. */
	turn_id?: string | null;
};

type ToolEventRow = {
	id: number;
	session_id: string;
	assistant_seq: number;
	tool_id: string;
	name: string;
	input_json: string;
	result_text: string | null;
	is_error: number | null;
	subagent_json?: string | null;
};

/** Lightweight transcript projection; result_text contains only a preview. */
export type ToolEventSummaryRow = ToolEventRow & {
	result_length: number | null;
	result_truncated: number;
};

/** Full result returned only when a historical tool event is expanded. */
export type ToolEventDetailRow = Pick<
	ToolEventRow,
	"tool_id" | "result_text" | "is_error"
>;

export type QueryData = {
	cost: number;
	/**
	 * True when `cost` is a provider-reported value, including a genuine zero.
	 * False/omitted means a zero `cost` is only the storage fallback and must not
	 * be presented as priced unless `estimated_cost` is available.
	 */
	cost_known?: boolean;
	estimated_cost?: number | null;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
	duration_ms: number;
	turns: number;
	context_window: number | null;
	stop_reason: string | null;
	tokens_in_context?: number | null;
	/** Provider model that produced this query, snapshotted for historical filters. */
	model?: string | null;
	/** Canonical agent/CWD owner at query time; null represents the vault. */
	agent_cwd?: string | null;
};

export type AggWindow = {
	cost: number;
	estimated_cost?: number;
	unpriced_queries?: number;
	queries: number;
	turns: number;
	/** input_tokens + output_tokens (for backwards compat) */
	tokens: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
};

export type AggStats = {
	allTime: {
		cost: number;
		estimated_cost?: number;
		unpriced_queries?: number;
		queries: number;
		sessions: number;
		input_tokens: number;
		output_tokens: number;
		cache_read_tokens: number;
		cache_creation_tokens: number;
		turns: number;
	};
	today: AggWindow;
	thisMonth: AggWindow;
};

export type AttachmentKind = "ephemeral" | "vault";

export type AttachmentRow = {
	id: string;
	session_id: string | null;
	message_seq: number | null;
	kind: AttachmentKind;
	filename: string;
	path: string;
	mime: string;
	size_bytes: number;
	sha256: string | null;
	created_at: number;
};

export type LogLevel = "error" | "warn" | "info";

export type LogRow = {
	id: number;
	timestamp: number;
	level: LogLevel;
	source: string;
	message: string;
	detail: string | null;
};

export type LogCounts = { error: number; warn: number; info: number };

export type PermissionEventRow = {
	tool_id: string;
	tool_name: string;
	display_name: string | null;
	decision: string;
	timestamp: number;
};

export type UsageWindow = {
	tokens: number;
	sessions: number;
	queries: number;
	cost: number;
	utilization: number | null;
	resetsAt: number | null;
	rateLimitType: string | null;
};

export type UsageWindows = {
	fiveHour: UsageWindow;
	weekly: UsageWindow;
	weeklySonnet: { utilization: number | null; resetsAt: number | null } | null;
};

/**
 * A single rate-limit window entry within a provider's usage snapshot.
 * `utilization` is set for plan-% style providers (Anthropic).
 * `remaining`/`limit` are set for remaining-capacity style providers (OpenAI/Google).
 */
export type ProviderWindowEntry = {
	windowId: string;
	label: string;
	/** Rolling window size in seconds (used for DB time-range queries). */
	windowSecs: number;
	tokens: number;
	queries: number;
	sessions: number;
	cost: number;
	/** Queries whose provider model has no published cost estimate. */
	unpricedQueries?: number;
	/** Plan utilization 0–1. Null if not available for this provider. */
	utilization: number | null;
	/** Tokens remaining in window. Null if not available. */
	remaining: number | null;
	/** Window token cap. Null if not available. */
	limit: number | null;
	resetsAt: number | null;
};

export type ProviderUsageSnapshot = {
	providerId: string;
	providerLabel: string;
	windows: ProviderWindowEntry[];
};

export type WeeklyStats = {
	total: number;
	days: number[]; // index 0=Sun … 6=Sat
};

export type ThirtyDayStats = {
	days: { date: string; count: number }[];
	total: number;
};

export type AttachmentTypeFilter = "image" | "pdf" | "text" | "other";

export type AttachmentSort = "created_at" | "size_bytes";

export type SortDir = "asc" | "desc";

export type AttachmentListFilter = {
	kind?: AttachmentKind;
	sessionId?: string;
	search?: string;
	/** Broad MIME class filter (image/pdf/text/other). */
	type?: AttachmentTypeFilter;
	since?: number;
	until?: number;
	sort?: AttachmentSort;
	dir?: SortDir;
	limit?: number;
	offset?: number;
};

export type SessionSort = "recent" | "cost" | "tokens";
