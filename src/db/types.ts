import type { ProviderApprovalsReviewer } from "../server/agentProvider";

export type SessionRow = {
	id: string;
	label: string | null;
	model: string | null;
	selected_model?: string | null;
	selected_effort?: string | null;
	selected_permission_mode?: string | null;
	selected_approvals_reviewer?: string | null;
	provider_id?: string | null;
	agent_cwd?: string | null;
	/** 1 when the user keeps this session above unpinned rows in Ledger. */
	pinned?: number;
	/** Unix seconds when hidden from active session lists; null while active. */
	archived_at?: number | null;
	history_imported?: number;
	/** Provider surface that produced an imported history-only session. */
	history_source?: string | null;
	/** none = accounting only, native = provider thread id, session-store = stored Claude JSONL. */
	history_resume_mode?: "none" | "native" | "session-store";
	/** Original provider transcript path, retained for diagnostics and native fallback. */
	history_resume_path?: string | null;
	/** Hlid session this row was forked from, retained without a destructive FK. */
	fork_parent_session_id?: string | null;
	/** Current source-session label, projected for compact provenance displays. */
	fork_parent_label?: string | null;
	/** Source messages.id cutoff for a through-message fork; null for whole-session. */
	fork_parent_message_id?: number | null;
	fork_kind?: "exact" | "recap" | null;
	/** Hlid session that explicitly delegated this ordinary Raven child. */
	delegation_parent_session_id?: string | null;
	/** Current or snapshotted parent label for compact provenance displays. */
	delegation_parent_label?: string | null;
	/** Stable parent user-turn identity that created this child. */
	delegation_parent_turn_id?: string | null;
	/** Bounded orchestration depth for this delegated Raven child. */
	delegation_depth?: number | null;
	/** 1 while Hlid reserves direct mutation for the parent delegation controls. */
	delegation_control_owned?: number | null;
	/** Durable provider-reported child usage used only as a display fallback. */
	delegation_tokens_used?: number | null;
	/** Durable provider-reported child cost used only as an estimated display fallback. */
	delegation_cost_used?: number | null;
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
	/** Derived from persisted tool events for session list/read projections. */
	tool_call_count?: number;
};

export type SessionSelection = {
	agentCwd: string | null;
	providerId: string | null;
	model: string | null;
	effort: string | null;
	permissionMode: string | null;
	approvalsReviewer?: ProviderApprovalsReviewer | null;
};

/** Read-only impact summary returned before destructive age-based cleanup. */
export type SessionCleanupPreview = {
	days: number;
	cutoff: number;
	sessions: number;
	messages: number;
	toolEvents: number;
	providerMessageFrames: number;
	estimatedDatabaseBytes: number;
	usageQueriesPreserved: number;
	managedAttachments: number;
	managedAttachmentBytes: number;
	retainedRelics: number;
	retainedRelicBytes: number;
	vaultLinksDetached: number;
	planProposals: number;
	askUserQuestions: number;
	projectPreviewFeedback: number;
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
	/** Claude's native transcript UUID for the last SDK message in this turn. */
	sdk_uuid?: string | null;
	/** Provider-native turn id for exact turn-boundary forks (Codex). */
	provider_turn_id?: string | null;
	/** Claude native file checkpoint attached to this user turn. */
	checkpoint_uuid?: string | null;
	/** Native Claude session that owns checkpoint_uuid. */
	checkpoint_provider_session_id?: string | null;
	/** Assistant message sequence this user prompt steered, when applicable. */
	steer_target_seq?: number | null;
	/** Raw assistant tool-event count when the provider accepted this steer. */
	steer_tool_event_index?: number | null;
	/** Hlid-owned context provenance for this user turn. Never sent to providers. */
	context_manifest_json?: string | null;
	/** Durable usage query owned by this completed assistant response. */
	query_id?: number | null;
	/** Hlid transcript source. NULL identifies ordinary typed/provider turns. */
	source?: string | null;
	/** Stable Hlid-owned identity for a provider realtime utterance. */
	utterance_id?: string | null;
	/** Hlid-owned realtime start generation. */
	realtime_session_id?: string | null;
	/** Provider-owned realtime call identity, when one was reported. */
	provider_realtime_session_id?: string | null;
	/** Explicit row-level fork support; NULL defers to ordinary provider rules. */
	fork_supported?: number | null;
	/** Joined query fields projected only by getSessionMessages(). */
	query_cost?: number | null;
	query_cost_known?: number | null;
	query_estimated_cost?: number | null;
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
	activity_json?: string | null;
};

/** Lightweight transcript projection; result_text contains only a preview. */
export type ToolEventSummaryRow = ToolEventRow & {
	result_length: number | null;
	result_truncated: number;
};

export type ToolEventPageMeta = {
	total: number;
	errorCount: number;
	hasEarlier: boolean;
	nextBeforeId: number | null;
};

export type ToolEventSummaryPage = ToolEventPageMeta & {
	items: ToolEventSummaryRow[];
};

/** One compacted assistant response returned by a transcript-window read. */
export type ToolEventTranscriptPage = ToolEventPageMeta & {
	assistantSeq: number;
};

/**
 * Tool summaries selected for an initial transcript window. Responses omitted
 * from pages are complete; listed responses contain only their newest page.
 */
export type ToolEventTranscriptWindow = {
	items: ToolEventSummaryRow[];
	pages: ToolEventTranscriptPage[];
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
export type AttachmentCategory =
	| "upload"
	| "plan"
	| "report"
	| "media"
	| "visualization"
	| "other";
export type AttachmentRetention = "session" | "retained" | "linked";
export type AttachmentOrigin =
	| "upload"
	| "generated"
	| "imported"
	| "vault"
	| "legacy";

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
	storage_key?: string | null;
	category?: AttachmentCategory;
	retention?: AttachmentRetention;
	origin?: AttachmentOrigin;
	agent_cwd?: string | null;
	image_optimized_at?: number | null;
	original_size_bytes?: number | null;
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
	category?: AttachmentCategory;
	retention?: AttachmentRetention;
	origin?: AttachmentOrigin;
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
