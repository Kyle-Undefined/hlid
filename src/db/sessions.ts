import { HLID_DELEGATION_MAX_ATTEMPTS } from "../lib/hlidDelegation";
import {
	estimateProviderCost,
	hasProviderPricing,
	isSyntheticModel,
} from "../lib/providerPricing";
import { normalizeSearchText } from "../lib/search";
import type { ProviderApprovalsReviewer } from "../server/agentProvider";
import { markAnalyticsChanged } from "./analyticsRevision";
import { type LedgerStatsRange, ledgerRangeCondition } from "./ledgerAnalytics";
import type { Db } from "./schema";
import { getDb } from "./schema";
import type {
	QueryData,
	SessionCleanupPreview,
	SessionRow,
	SessionSelection,
	SessionSort,
} from "./types";

const HISTORICAL_TOOL_ERROR_PREVIEW_CHARS = 4_096;
const SESSION_CLEANUP_BATCH_SIZE = 25;
const SESSION_LAST_ACTIVITY_SQL = `MAX(
	session.started_at,
	COALESCE(session.ended_at, session.started_at),
	COALESCE((SELECT MAX(message.timestamp) FROM messages message
	          WHERE message.session_id = session.id), session.started_at),
	COALESCE((SELECT MAX(event.timestamp) FROM tool_events event
	          WHERE event.session_id = session.id), session.started_at),
	COALESCE((SELECT MAX(permission.timestamp) FROM permission_events permission
	          WHERE permission.session_id = session.id), session.started_at),
	COALESCE((SELECT MAX(proposal.timestamp) FROM plan_proposals proposal
	          WHERE proposal.session_id = session.id), session.started_at),
	COALESCE((SELECT MAX(question.timestamp) FROM ask_user_questions question
	          WHERE question.session_id = session.id), session.started_at),
	COALESCE((SELECT MAX(attachment.created_at) FROM attachments attachment
	          WHERE attachment.session_id = session.id), session.started_at)
)`;

export class SessionHasDelegationDescendantsError extends Error {
	constructor(readonly sessionId: string) {
		super(
			"Delete this session's delegated descendants before deleting their delegated parent.",
		);
		this.name = "SessionHasDelegationDescendantsError";
	}
}

export class SessionDelegationOwnershipError extends Error {
	constructor(
		readonly sessionId: string,
		readonly operation: "archive" | "delete",
	) {
		super(
			operation === "archive"
				? "Cannot archive a session owned by a pending or running delegation."
				: "Cannot delete a session owned by a pending, running, or resumable interrupted delegation.",
		);
		this.name = "SessionDelegationOwnershipError";
	}
}

export async function setSessionAgentCwd(
	sessionId: string,
	cwd: string,
): Promise<void> {
	const db = await getDb();
	db.run(`UPDATE sessions SET agent_cwd = ? WHERE id = ?`, [cwd, sessionId]);
	markAnalyticsChanged(["stats", "activity"], "session_agent_cwd");
}

export async function getSessionAgentCwd(
	sessionId: string,
): Promise<string | null> {
	const db = await getDb();
	const row = db
		.query<{ agent_cwd: string | null }, [string]>(
			`SELECT agent_cwd FROM sessions WHERE id = ?`,
		)
		.get(sessionId);
	return row?.agent_cwd ?? null;
}

export async function setSessionModel(
	sessionId: string,
	model: string,
): Promise<void> {
	const db = await getDb();
	db.run(
		`UPDATE sessions
		 SET actual_model = CASE
		       WHEN COALESCE(selected_model, model, '') = ? THEN actual_model
		       ELSE NULL
		     END,
		     model = ?,
		     selected_model = ?
		 WHERE id = ?`,
		[model, model, model, sessionId],
	);
	markAnalyticsChanged(["stats", "activity"], "session_model");
}

export async function getSessionModel(
	sessionId: string,
): Promise<string | null> {
	const db = await getDb();
	const row = db
		.query<{ model: string | null }, [string]>(
			`SELECT COALESCE(selected_model, actual_model, model) AS model
			 FROM sessions WHERE id = ?`,
		)
		.get(sessionId);
	return row?.model ?? null;
}

export async function getSessionSelection(
	sessionId: string,
): Promise<SessionSelection | null> {
	const db = await getDb();
	const row = db
		.query<
			{
				agent_cwd: string | null;
				provider_id: string | null;
				model: string | null;
				effort: string | null;
				permission_mode: string | null;
				approvals_reviewer: string | null;
			},
			[string]
		>(
			`SELECT agent_cwd,
			        provider_id,
			        COALESCE(selected_model, actual_model, model) AS model,
			        selected_effort AS effort,
			        selected_permission_mode AS permission_mode,
			        selected_approvals_reviewer AS approvals_reviewer
			 FROM sessions WHERE id = ?`,
		)
		.get(sessionId);
	return row
		? {
				agentCwd: row.agent_cwd,
				providerId: row.provider_id,
				model: row.model,
				effort: row.effort,
				permissionMode: row.permission_mode,
				approvalsReviewer:
					row.approvals_reviewer === "user" ||
					row.approvals_reviewer === "auto_review"
						? row.approvals_reviewer
						: null,
			}
		: null;
}

export async function setSessionEffort(
	sessionId: string,
	effort: string,
): Promise<void> {
	const db = await getDb();
	db.run(`UPDATE sessions SET selected_effort = ? WHERE id = ?`, [
		effort,
		sessionId,
	]);
}

export async function setSessionPermissionMode(
	sessionId: string,
	permissionMode: string,
): Promise<void> {
	const db = await getDb();
	db.run(`UPDATE sessions SET selected_permission_mode = ? WHERE id = ?`, [
		permissionMode,
		sessionId,
	]);
}

export async function setSessionApprovalsReviewer(
	sessionId: string,
	approvalsReviewer: ProviderApprovalsReviewer,
): Promise<void> {
	const db = await getDb();
	db.run(`UPDATE sessions SET selected_approvals_reviewer = ? WHERE id = ?`, [
		approvalsReviewer,
		sessionId,
	]);
}

export async function getSessionClaudeId(
	sessionId: string,
): Promise<string | null> {
	return getSessionProviderSession(sessionId, "claude");
}

/**
 * Persist provider-native continuity without transferring provider ownership.
 * Callers must establish provider_id first; a delayed retired-provider write is
 * rejected instead of reclaiming the session row.
 */
export async function setSessionProviderSession(
	sessionId: string,
	providerId: string,
	providerSessionId: string | null,
): Promise<boolean> {
	const db = await getDb();
	const result = db.run(
		`UPDATE sessions
		 SET provider_session_id = ?,
		     claude_session_id = CASE WHEN ? = 'claude' THEN ? ELSE claude_session_id END
		 WHERE id = ? AND provider_id = ?`,
		[providerSessionId, providerId, providerSessionId, sessionId, providerId],
	);
	if (result.changes > 0) {
		markAnalyticsChanged(["stats", "activity"], "session_provider_session");
		return true;
	}
	return false;
}

export async function getSessionProviderSession(
	sessionId: string,
	providerId?: string,
): Promise<string | null> {
	const db = await getDb();
	const row = db
		.query<
			{
				provider_id: string | null;
				provider_session_id: string | null;
				claude_session_id: string | null;
			},
			[string]
		>(
			`SELECT provider_id, provider_session_id, claude_session_id FROM sessions WHERE id = ?`,
		)
		.get(sessionId);
	if (!row) return null;
	if (providerId && row.provider_id !== providerId) return null;
	return (
		row.provider_session_id ??
		(row.provider_id === "claude" ? row.claude_session_id : null)
	);
}

type ProviderSessionOwner = {
	provider_id: string | null;
	provider_session_id: string | null;
};

function deleteProviderTranscriptIfUnowned(
	db: Db,
	owner: ProviderSessionOwner | null,
): void {
	if (owner?.provider_id == null || owner.provider_session_id == null) return;
	db.run(
		`DELETE FROM provider_history_transcripts
		 WHERE provider_id = ? AND native_session_id = ?
		   AND NOT EXISTS (
		     SELECT 1 FROM sessions survivor
		     WHERE survivor.provider_id = ?
		       AND survivor.provider_session_id = ?
		   )`,
		[
			owner.provider_id,
			owner.provider_session_id,
			owner.provider_id,
			owner.provider_session_id,
		],
	);
}

export async function setSessionProviderId(
	sessionId: string,
	providerId: string,
): Promise<void> {
	const db = await getDb();
	// Legacy callers only own provider identity. Preserve their selected
	// controls, but invalidate runtime values owned by the previous provider.
	db.transaction(() => {
		const previous = db
			.query<ProviderSessionOwner, [string]>(`
				SELECT provider_id, provider_session_id
				FROM sessions WHERE id = ?
			`)
			.get(sessionId);
		db.run(
			`UPDATE sessions
			 SET actual_model = CASE WHEN provider_id = ? THEN actual_model ELSE NULL END,
			     provider_session_id = CASE
			       WHEN provider_id = ? THEN provider_session_id
			       ELSE NULL
			     END,
			     claude_session_id = CASE
			       WHEN provider_id = ? THEN claude_session_id
			       ELSE NULL
			     END,
			     provider_id = ?
			 WHERE id = ?`,
			[providerId, providerId, providerId, providerId, sessionId],
		);
		if (previous?.provider_id !== providerId) {
			deleteProviderTranscriptIfUnowned(db, previous);
		}
	}).immediate();
	markAnalyticsChanged(["stats", "activity"], "session_provider");
}

export async function setSessionProviderSelection(
	sessionId: string,
	providerId: string,
	selection: {
		model?: string;
		effort?: string;
		permissionMode?: string;
		approvalsReviewer?: ProviderApprovalsReviewer;
	},
): Promise<void> {
	const db = await getDb();
	const selectedModel = selection.model ?? "";
	// Provider plus controls form one current-session ownership tuple. Native
	// thread continuity survives a same-provider model change, but the observed
	// runtime model belongs to the exact provider/model selection that produced it.
	db.transaction(() => {
		const previous = db
			.query<ProviderSessionOwner, [string]>(`
				SELECT provider_id, provider_session_id
				FROM sessions WHERE id = ?
			`)
			.get(sessionId);
		db.run(
			`UPDATE sessions
			 SET actual_model = CASE
			       WHEN provider_id = ?
			        AND COALESCE(selected_model, model, '') = ?
			       THEN actual_model
			       ELSE NULL
			     END,
			     provider_session_id = CASE
			       WHEN provider_id = ? THEN provider_session_id
			       ELSE NULL
			     END,
			     claude_session_id = CASE
			       WHEN provider_id = ? THEN claude_session_id
			       ELSE NULL
			     END,
			     provider_id = ?,
			     model = ?,
			     selected_model = ?,
			     selected_effort = ?,
			     selected_permission_mode = ?,
			     selected_approvals_reviewer = ?
			 WHERE id = ?`,
			[
				providerId,
				selectedModel,
				providerId,
				providerId,
				providerId,
				selectedModel,
				selectedModel,
				selection.effort ?? null,
				selection.permissionMode ?? null,
				selection.approvalsReviewer ?? null,
				sessionId,
			],
		);
		if (previous?.provider_id !== providerId) {
			deleteProviderTranscriptIfUnowned(db, previous);
		}
	}).immediate();
	markAnalyticsChanged(["stats", "activity"], "session_provider_selection");
}

export async function getSessionProviderId(
	sessionId: string,
): Promise<string | null> {
	const db = await getDb();
	const row = db
		.query<{ provider_id: string | null }, [string]>(
			`SELECT provider_id FROM sessions WHERE id = ?`,
		)
		.get(sessionId);
	return row?.provider_id ?? null;
}

export async function setSessionActualModelForProvider(
	sessionId: string,
	providerId: string,
	selectedModel: string,
	actualModel: string,
): Promise<boolean> {
	const db = await getDb();
	const result = db.run(
		`UPDATE sessions SET actual_model = ?
		 WHERE id = ?
		   AND provider_id = ?
		   AND COALESCE(selected_model, model, '') = ?`,
		[actualModel, sessionId, providerId, selectedModel],
	);
	if (result.changes > 0) {
		markAnalyticsChanged(["stats", "activity"], "session_actual_model");
		return true;
	}
	return false;
}

export async function getSessionActualModel(
	sessionId: string,
): Promise<string | null> {
	const db = await getDb();
	const row = db
		.query<{ actual_model: string | null }, [string]>(
			`SELECT actual_model FROM sessions WHERE id = ?`,
		)
		.get(sessionId);
	return row?.actual_model ?? null;
}

export async function createSession(
	id: string,
	label: string,
	model: string,
	selection: {
		effort?: string;
		permissionMode?: string;
		approvalsReviewer?: ProviderApprovalsReviewer;
		agentCwd?: string;
		providerId?: string;
	} = {},
): Promise<void> {
	const db = await getDb();
	let changes = 0;
	db.transaction(() => {
		({ changes } = db.run(
			`INSERT OR IGNORE INTO sessions
			 (id, label, model, selected_model, selected_effort,
			  selected_permission_mode, selected_approvals_reviewer, agent_cwd,
			  provider_id, started_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
			[
				id,
				label,
				model,
				model,
				selection.effort ?? null,
				selection.permissionMode ?? null,
				selection.approvalsReviewer ?? null,
				selection.agentCwd ?? null,
				selection.providerId ?? "claude",
			],
		));
		if (changes > 0) {
			db.run(`INSERT INTO session_search (session_id, text) VALUES (?, ?)`, [
				id,
				normalizeSearchText(label),
			]);
		}
	})();
	if (changes > 0) {
		markAnalyticsChanged(["stats", "activity"], "session_created");
	}
}

/**
 * Create a new session row copying the durable selection (model/effort/
 * permission mode/approval reviewer/cwd/provider) from an existing source
 * session, pointing it at an already-forked native provider session id. Used
 * by the fork-session flow — the transcript fork itself happens provider-side
 * before this runs.
 */
export async function createForkedSessionRow(
	sourceId: string,
	newId: string,
	newProviderSessionId: string,
	options: {
		parentMessageId?: number;
		forkKind?: "exact" | "recap";
	} = {},
): Promise<void> {
	const source = await getSessionById(sourceId);
	if (!source) throw new Error("Source session not found");
	const label = source.label ? `${source.label} (fork)` : "Forked session";
	await createSession(
		newId,
		label,
		source.selected_model ?? source.model ?? "",
		{
			effort: source.selected_effort ?? undefined,
			permissionMode: source.selected_permission_mode ?? undefined,
			approvalsReviewer:
				source.selected_approvals_reviewer === "user" ||
				source.selected_approvals_reviewer === "auto_review"
					? source.selected_approvals_reviewer
					: undefined,
			providerId: source.provider_id ?? "claude",
		},
	);
	if (source.agent_cwd) await setSessionAgentCwd(newId, source.agent_cwd);
	await setSessionProviderSession(
		newId,
		source.provider_id ?? "claude",
		newProviderSessionId,
	);
	const db = await getDb();
	db.run(
		`UPDATE sessions
		 SET fork_parent_session_id = ?, fork_parent_message_id = ?, fork_kind = ?,
		     history_resume_mode = ?
		 WHERE id = ?`,
		[
			sourceId,
			options.parentMessageId ?? null,
			options.forkKind ?? "exact",
			source.history_resume_mode ?? "none",
			newId,
		],
	);
}

export async function recordQuery(
	sessionId: string,
	data: QueryData,
	providerId = "claude",
): Promise<{ estimatedCost: number | null; queryId: number }> {
	const database = await getDb();
	const sessionDimensions = database
		.query<{ model: string | null; agent_cwd: string | null }, [string]>(
			`SELECT COALESCE(NULLIF(selected_model, ''), NULLIF(actual_model, ''), NULLIF(model, '')) AS model,
			        agent_cwd
			 FROM sessions WHERE id = ?`,
		)
		.get(sessionId);
	const sessionModel = sessionDimensions?.model ?? null;
	const queryModel = isSyntheticModel(data.model)
		? hasProviderPricing(providerId, sessionModel)
			? sessionModel
			: (data.model ?? null)
		: data.model?.trim()
			? data.model
			: sessionModel;
	const estimatedCost =
		data.estimated_cost ??
		(data.cost === 0 && data.cost_known !== true
			? estimateProviderCost(providerId, queryModel, {
					inputTokens: data.input_tokens,
					outputTokens: data.output_tokens,
					cacheReadTokens: data.cache_read_tokens,
					cacheCreationTokens: data.cache_creation_tokens,
				})
			: null);
	const costKnown =
		data.cost_known === true || data.cost !== 0 || estimatedCost !== null;
	const unpriced = estimatedCost === null && !costKnown ? 1 : 0;
	const queryAgentCwd =
		data.agent_cwd === undefined
			? (sessionDimensions?.agent_cwd ?? null)
			: data.agent_cwd;
	const queryId = database.transaction(() => {
		const queryResult = database.run(
			`INSERT INTO queries (session_id, timestamp, cost, cost_known, estimated_cost, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, duration_ms, turns, context_window, stop_reason, tokens_in_context, provider_id, model, agent_cwd)
			 VALUES (?, unixepoch(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				sessionId,
				data.cost,
				costKnown ? 1 : 0,
				estimatedCost,
				data.input_tokens,
				data.output_tokens,
				data.cache_read_tokens,
				data.cache_creation_tokens,
				data.duration_ms,
				data.turns,
				data.context_window,
				data.stop_reason,
				data.tokens_in_context ?? null,
				providerId,
				queryModel,
				queryAgentCwd,
			],
		);
		database.run(
			`UPDATE sessions SET
         query_count = query_count + 1,
         total_cost = total_cost + ?,
         total_estimated_cost = total_estimated_cost + ?,
         unpriced_query_count = unpriced_query_count + ?,
         total_input_tokens = total_input_tokens + ?,
         total_output_tokens = total_output_tokens + ?,
         total_cache_read_tokens = total_cache_read_tokens + ?,
         total_cache_creation_tokens = total_cache_creation_tokens + ?,
         total_turns = total_turns + ?,
         ended_at = unixepoch()
       WHERE id = ?`,
			[
				data.cost,
				estimatedCost ?? 0,
				unpriced,
				data.input_tokens,
				data.output_tokens,
				data.cache_read_tokens,
				data.cache_creation_tokens,
				data.turns,
				sessionId,
			],
		);
		database.run(
			`INSERT INTO usage_daily (date, cost, estimated_cost, unpriced_queries, queries, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, turns)
			 VALUES (DATE('now', 'localtime'), ?, ?, ?, 1, ?, ?, ?, ?, ?)
			 ON CONFLICT(date) DO UPDATE SET
			   cost = cost + excluded.cost,
			   estimated_cost = estimated_cost + excluded.estimated_cost,
			   unpriced_queries = unpriced_queries + excluded.unpriced_queries,
         queries = queries + 1,
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
         cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
         turns = turns + excluded.turns`,
			[
				data.cost,
				estimatedCost ?? 0,
				unpriced,
				data.input_tokens,
				data.output_tokens,
				data.cache_read_tokens,
				data.cache_creation_tokens,
				data.turns,
			],
		);
		database.run(
			`INSERT INTO usage_queries (session_id, timestamp, cost, cost_known, estimated_cost, unpriced, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, turns, stop_reason, provider_id, model, agent_cwd)
			 VALUES (?, unixepoch(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				sessionId,
				data.cost,
				costKnown ? 1 : 0,
				estimatedCost,
				unpriced,
				data.input_tokens,
				data.output_tokens,
				data.cache_read_tokens,
				data.cache_creation_tokens,
				data.turns,
				data.stop_reason,
				providerId,
				queryModel,
				queryAgentCwd,
			],
		);
		return Number(queryResult.lastInsertRowid);
	})();
	markAnalyticsChanged(undefined, "query_recorded");
	return { estimatedCost, queryId };
}

export async function getSessionLastQueryContext(sessionId: string): Promise<{
	context_window: number | null;
	last_context_used: number | null;
} | null> {
	const db = await getDb();
	return (
		db
			.query<
				{ context_window: number | null; last_context_used: number | null },
				[string]
			>(
				`SELECT context_window,
				        COALESCE(tokens_in_context, input_tokens + cache_read_tokens + cache_creation_tokens) AS last_context_used
				 FROM queries
				 WHERE session_id = ? AND COALESCE(stop_reason, '') <> 'turn_recap'
				 ORDER BY timestamp DESC
				 LIMIT 1`,
			)
			.get(sessionId) ?? null
	);
}

/** Whitelisted ORDER BY clauses — `sort` is a typed union, never raw input. */
const SESSION_SORT_SQL: Record<SessionSort, string> = {
	recent: "COALESCE(ended_at, started_at) DESC",
	cost: "(total_cost + COALESCE(total_estimated_cost, 0)) DESC",
	tokens:
		"(total_input_tokens + total_output_tokens + total_cache_read_tokens + total_cache_creation_tokens) DESC",
};

const SESSION_EFFECTIVE_MODEL_SQL =
	"COALESCE(NULLIF(actual_model, ''), NULLIF(selected_model, ''), NULLIF(model, ''))";

function sessionToolCallCountColumn(sessionAlias: string): string {
	return `(SELECT COUNT(*)
		 FROM tool_events tool_call
		 WHERE tool_call.session_id = ${sessionAlias}.id)
		 AS tool_call_count`;
}

function sessionDelegationColumns(sessionAlias: string): string {
	return `
		(SELECT delegation.parent_session_id
		 FROM session_delegations delegation
		 WHERE delegation.child_session_id = ${sessionAlias}.id)
		 AS delegation_parent_session_id,
		(SELECT COALESCE(
				(SELECT parent.label
				 FROM sessions parent
				 WHERE parent.id = delegation.parent_session_id),
				delegation.parent_label
			)
		 FROM session_delegations delegation
		 WHERE delegation.child_session_id = ${sessionAlias}.id)
		 AS delegation_parent_label,
			(SELECT delegation.parent_turn_id
			 FROM session_delegations delegation
			 WHERE delegation.child_session_id = ${sessionAlias}.id)
			 AS delegation_parent_turn_id,
			(SELECT delegation.depth
			 FROM session_delegations delegation
			 WHERE delegation.child_session_id = ${sessionAlias}.id)
			 AS delegation_depth,
			(SELECT CASE
					WHEN ${sessionAlias}.archived_at IS NULL
					 AND (
					   delegation.status IN ('pending', 'running')
					   OR (
					     delegation.status = 'interrupted'
					     AND delegation.routine_run_id IS NULL
					     AND delegation.attempt_count < ${HLID_DELEGATION_MAX_ATTEMPTS}
					   )
					 )
					THEN 1
					ELSE 0
				END
			 FROM session_delegations delegation
			 WHERE delegation.child_session_id = ${sessionAlias}.id)
			 AS delegation_control_owned,
			(SELECT delegation.tokens_used
			 FROM session_delegations delegation
			 WHERE delegation.child_session_id = ${sessionAlias}.id)
			 AS delegation_tokens_used,
			(SELECT delegation.cost_used
			 FROM session_delegations delegation
			 WHERE delegation.child_session_id = ${sessionAlias}.id)
			 AS delegation_cost_used`;
}

type SessionListOptions = {
	search?: string;
	sort?: SessionSort;
	/** False/default lists active sessions; true lists archived sessions. */
	archived?: boolean;
	/** "vault" matches rows without an agent cwd; any other value is exact. */
	agent?: string;
	model?: string;
	provider?: string;
	stop?: string;
	range?: LedgerStatsRange;
	from?: string;
	to?: string;
};

function buildSessionFilter(opts: Omit<SessionListOptions, "sort">): {
	whereSql: string;
	params: string[];
} {
	const conditions: string[] = [
		opts.archived ? "archived_at IS NOT NULL" : "archived_at IS NULL",
	];
	const params: string[] = [];
	if (opts.search) {
		const escaped = opts.search
			.replace(/\\/g, "\\\\")
			.replace(/%/g, "\\%")
			.replace(/_/g, "\\_");
		conditions.push(
			`EXISTS (SELECT 1 FROM session_search search_idx WHERE search_idx.session_id = sessions.id AND search_idx.text LIKE ? ESCAPE '\\')`,
		);
		params.push(`%${normalizeSearchText(escaped)}%`);
	}
	const queryScoped = opts.stop !== undefined || opts.range !== undefined;
	if (!queryScoped) {
		if (opts.agent === "vault") {
			conditions.push("(agent_cwd IS NULL OR TRIM(agent_cwd) = '')");
		} else if (opts.agent) {
			conditions.push("agent_cwd = ?");
			params.push(opts.agent);
		}
		if (opts.model) {
			conditions.push(`${SESSION_EFFECTIVE_MODEL_SQL} = ?`);
			params.push(opts.model);
		}
		if (opts.provider) {
			conditions.push("provider_id = ?");
			params.push(opts.provider);
		}
	} else {
		const queryConditions = ["q_filter.session_id = sessions.id"];
		if (opts.agent === "vault") {
			queryConditions.push(
				"(q_filter.agent_cwd IS NULL OR TRIM(q_filter.agent_cwd) = '')",
			);
		} else if (opts.agent) {
			queryConditions.push("q_filter.agent_cwd = ?");
			params.push(opts.agent);
		}
		if (opts.model) {
			queryConditions.push("q_filter.model = ?");
			params.push(opts.model);
		}
		if (opts.provider) {
			queryConditions.push("q_filter.provider_id = ?");
			params.push(opts.provider);
		}
		if (opts.stop) {
			queryConditions.push("q_filter.stop_reason = ?");
			params.push(opts.stop);
		}
		if (opts.range) {
			const range = ledgerRangeCondition(
				{ range: opts.range, from: opts.from, to: opts.to },
				"q_filter.timestamp",
			);
			if (range.condition) queryConditions.push(range.condition);
			params.push(...range.params);
		}
		conditions.push(
			`EXISTS (SELECT 1 FROM queries q_filter WHERE ${queryConditions.join(" AND ")})`,
		);
	}
	return {
		whereSql: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
		params,
	};
}

export async function getSessionsPaginated(
	page: number,
	pageSize: number,
	opts: SessionListOptions = {},
): Promise<{
	sessions: SessionRow[];
	total: number;
	/** Unix seconds of the oldest session overall (ignores search filter); null when empty. */
	oldest_started_at: number | null;
	/** Persisted Einherjar cwd facets, including agents removed from config. */
	agent_cwds: string[];
	/** Effective model facets narrowed by the selected Vault/agent owner. */
	models: string[];
}> {
	const db = await getDb();
	const offset = Math.max(0, (page - 1) * pageSize);
	const { whereSql, params } = buildSessionFilter(opts);
	const orderSql = SESSION_SORT_SQL[opts.sort ?? "recent"];
	const sessions = db
		.query<SessionRow, (string | number)[]>(
			`SELECT sessions.*,
			        ${sessionToolCallCountColumn("sessions")},
			        ${sessionDelegationColumns("sessions")}
			 FROM sessions ${whereSql}
			 ORDER BY pinned DESC, ${orderSql} LIMIT ? OFFSET ?`,
		)
		.all(...params, pageSize, offset);
	const row = db
		.query<{ total: number }, (string | number)[]>(
			`SELECT COUNT(*) as total FROM sessions ${whereSql}`,
		)
		.get(...params);
	const oldest = db
		.query<{ oldest: number | null }, []>(
			`SELECT MIN(started_at) as oldest FROM sessions
			 WHERE history_imported = 0 AND archived_at IS NULL`,
		)
		.get();
	const agentCwds = db
		.query<{ agent_cwd: string }, []>(
			`SELECT DISTINCT agent_cwd
			 FROM sessions
			 WHERE agent_cwd IS NOT NULL AND TRIM(agent_cwd) <> ''
			   AND archived_at ${opts.archived ? "IS NOT NULL" : "IS NULL"}
			 ORDER BY agent_cwd COLLATE NOCASE ASC`,
		)
		.all()
		.map((row) => row.agent_cwd);
	const agentFilter = buildSessionFilter({
		agent: opts.agent,
		archived: opts.archived,
	});
	const modelWhere = agentFilter.whereSql
		? `${agentFilter.whereSql} AND ${SESSION_EFFECTIVE_MODEL_SQL} IS NOT NULL`
		: `WHERE ${SESSION_EFFECTIVE_MODEL_SQL} IS NOT NULL`;
	const models = db
		.query<{ model: string }, string[]>(
			`SELECT DISTINCT ${SESSION_EFFECTIVE_MODEL_SQL} AS model
			 FROM sessions ${modelWhere}
			 ORDER BY model COLLATE NOCASE ASC`,
		)
		.all(...agentFilter.params)
		.map((row) => row.model);
	return {
		sessions,
		total: row?.total ?? 0,
		oldest_started_at: oldest?.oldest ?? null,
		agent_cwds: agentCwds,
		models,
	};
}

/** Every session row, most recent first — used by ledger export. */
export async function getAllSessions(): Promise<SessionRow[]> {
	const db = await getDb();
	return db
		.query<SessionRow, []>(
			`SELECT sessions.*,
			        ${sessionToolCallCountColumn("sessions")},
			        ${sessionDelegationColumns("sessions")}
			 FROM sessions
			 ORDER BY COALESCE(ended_at, started_at) DESC`,
		)
		.all();
}

/** Delete every Hlid-owned row/file link while preserving immutable ledgers. */
function cascadeDeleteSessionIds(db: Db, ids: string[]): string[] {
	if (ids.length === 0) return [];
	const ph = ids.map(() => "?").join(",");
	const rows = db
		.query<{ path: string }, string[]>(
			`SELECT path FROM attachments
			 WHERE kind = 'ephemeral' AND session_id IN (${ph})`,
		)
		.all(...ids);
	const ephemeralPaths = rows.map((r) => r.path);
	db.run(
		`INSERT OR IGNORE INTO historical_sessions
		 (session_id, started_at, ended_at, provider_id, model, agent_cwd)
		 SELECT id, started_at, ended_at, provider_id,
		        COALESCE(NULLIF(actual_model, ''), NULLIF(selected_model, ''), model),
		        agent_cwd
		 FROM sessions WHERE id IN (${ph})`,
		ids,
	);
	db.run(
		`INSERT OR IGNORE INTO pending_file_deletions(path)
		 SELECT path FROM attachments
		 WHERE kind = 'ephemeral' AND session_id IN (${ph})`,
		ids,
	);

	// Preserve compact historical tool/error analytics before deleting bulky
	// transcript results. Full successful results are intentionally not retained.
	db.run(
		`INSERT OR IGNORE INTO historical_tool_events
		 (source_event_id, session_id, timestamp, name, is_error, result_text,
		  provider_id, model, agent_cwd)
		 SELECT event.id,
		        event.session_id,
		        COALESCE(
		          event.timestamp,
		          (SELECT MIN(message.timestamp)
		           FROM messages message
		           WHERE message.session_id = event.session_id
		             AND message.seq = event.assistant_seq
		             AND message.role = 'assistant'),
		          session.ended_at,
		          session.started_at
		        ),
		        event.name,
		        COALESCE(event.is_error, 0),
		        CASE WHEN event.is_error = 1
		             THEN substr(COALESCE(event.result_text, ''), 1, ${HISTORICAL_TOOL_ERROR_PREVIEW_CHARS})
		             ELSE NULL END,
		        event.provider_id,
		        event.model,
		        event.agent_cwd
		 FROM tool_events event
		 JOIN sessions session ON session.id = event.session_id
		 WHERE event.session_id IN (${ph})`,
		ids,
	);

	// Feedback rows refer to generated report attachments. Remove both sides of
	// that ownership boundary before deleting all Hlid-owned attachment rows.
	db.run(
		`DELETE FROM project_preview_feedback WHERE session_id IN (${ph})`,
		ids,
	);
	db.run(
		`DELETE FROM attachments
		 WHERE kind = 'ephemeral' AND session_id IN (${ph})`,
		ids,
	);
	db.run(
		`UPDATE attachments SET session_id = NULL, message_seq = NULL
		 WHERE kind = 'vault' AND session_id IN (${ph})`,
		ids,
	);
	for (const table of [
		"provider_background_activities",
		"provider_tool_start_lineage",
		"provider_tool_metadata_contributions",
		"provider_message_retractions",
		"provider_message_frames",
		"tool_events",
		"project_previews",
		"plan_proposals",
		"ask_user_questions",
		"session_pending_turns",
		"permission_events",
		"messages",
		"queries",
	] as const) {
		db.run(`DELETE FROM ${table} WHERE session_id IN (${ph})`, ids);
	}
	db.run(
		`DELETE FROM session_delegations WHERE child_session_id IN (${ph})`,
		ids,
	);
	db.run(
		`UPDATE routine_runs SET session_id = NULL WHERE session_id IN (${ph})`,
		ids,
	);
	db.run(
		`UPDATE history_import_items SET imported_query_id = NULL
		 WHERE imported_session_id IN (${ph})`,
		ids,
	);
	db.run(
		`DELETE FROM provider_history_transcripts
		 WHERE EXISTS (
		   SELECT 1 FROM sessions doomed
		   WHERE doomed.id IN (${ph})
		     AND doomed.provider_id = provider_history_transcripts.provider_id
		     AND doomed.provider_session_id = provider_history_transcripts.native_session_id
		 )
		 AND NOT EXISTS (
		   SELECT 1 FROM sessions survivor
		   WHERE survivor.id NOT IN (${ph})
		     AND survivor.provider_id = provider_history_transcripts.provider_id
		     AND survivor.provider_session_id = provider_history_transcripts.native_session_id
		 )`,
		[...ids, ...ids],
	);
	// usage_queries intentionally NOT deleted — immutable ledger for all-time stats
	db.run(`DELETE FROM sessions WHERE id IN (${ph})`, ids);
	return ephemeralPaths;
}

function cleanupSessionIds(
	db: Db,
	cutoff: number,
	excludedSessionIds: readonly string[],
	limit?: number,
): string[] {
	const excludedIds = [...new Set(excludedSessionIds.filter(Boolean))];
	const excludedSql =
		excludedIds.length > 0
			? `AND session.id NOT IN (${excludedIds.map(() => "?").join(",")})`
			: "";
	const limitSql = limit == null ? "" : "LIMIT ?";
	const params: (number | string)[] = [cutoff, ...excludedIds];
	if (limit != null) params.push(limit);
	return db
		.query<{ id: string }, (number | string)[]>(
			`WITH RECURSIVE
			 cleanup_candidates(id, last_activity) AS (
			   SELECT session.id, ${SESSION_LAST_ACTIVITY_SQL}
			   FROM sessions session
			   WHERE ${SESSION_LAST_ACTIVITY_SQL} < ?
			     AND session.history_imported = 0
			     AND session.archived_at IS NULL
			     AND COALESCE(session.pinned, 0) = 0
			     AND NOT EXISTS (
			       SELECT 1 FROM session_pending_turns pending
			       WHERE pending.session_id = session.id
			     )
			     ${excludedSql}
			 ),
			 blocked_delegations(id, parent_delegation_id) AS (
			   SELECT delegation.id, delegation.parent_delegation_id
			   FROM session_delegations delegation
			   WHERE NOT EXISTS (
			     SELECT 1 FROM cleanup_candidates candidate
			     WHERE candidate.id = delegation.child_session_id
			   )
			      OR delegation.status IN ('pending', 'running')
			      OR (
			        delegation.status = 'interrupted'
			        AND delegation.routine_run_id IS NULL
			        AND delegation.attempt_count < ${HLID_DELEGATION_MAX_ATTEMPTS}
			      )
			   UNION
			   SELECT parent.id, parent.parent_delegation_id
			   FROM session_delegations parent
			   JOIN blocked_delegations child
			     ON child.parent_delegation_id = parent.id
			 )
			 SELECT candidate.id
			 FROM cleanup_candidates candidate
			 WHERE NOT EXISTS (
			   SELECT 1
			   FROM session_delegations protected_lineage
			   JOIN blocked_delegations blocked ON blocked.id = protected_lineage.id
			   WHERE protected_lineage.child_session_id = candidate.id
			      OR protected_lineage.parent_session_id = candidate.id
			 )
			 ORDER BY candidate.last_activity, candidate.id
			 ${limitSql}`,
		)
		.all(...params)
		.map((row) => row.id);
}

function emptyCleanupPreview(
	days: number,
	cutoff: number,
): SessionCleanupPreview {
	return {
		days,
		cutoff,
		sessions: 0,
		messages: 0,
		toolEvents: 0,
		providerMessageFrames: 0,
		estimatedDatabaseBytes: 0,
		usageQueriesPreserved: 0,
		managedAttachments: 0,
		managedAttachmentBytes: 0,
		retainedRelics: 0,
		retainedRelicBytes: 0,
		vaultLinksDetached: 0,
		planProposals: 0,
		askUserQuestions: 0,
		projectPreviewFeedback: 0,
	};
}

function cleanupPreviewForIds(
	db: Db,
	days: number,
	cutoff: number,
	ids: readonly string[],
): SessionCleanupPreview {
	if (ids.length === 0) return emptyCleanupPreview(days, cutoff);
	const ph = ids.map(() => "?").join(",");
	type PreviewCounts = Omit<SessionCleanupPreview, "days" | "cutoff">;
	const row = db
		.query<PreviewCounts, string[]>(
			`SELECT
			 (SELECT COUNT(*) FROM sessions WHERE id IN (${ph})) AS sessions,
			 (SELECT COUNT(*) FROM messages WHERE session_id IN (${ph})) AS messages,
			 (SELECT COUNT(*) FROM tool_events WHERE session_id IN (${ph})) AS toolEvents,
				 ((SELECT COUNT(*) FROM provider_message_frames
				   WHERE session_id IN (${ph})) +
				  (SELECT COUNT(*) FROM provider_message_retractions
				   WHERE session_id IN (${ph})) +
				  (SELECT COUNT(*) FROM provider_tool_metadata_contributions
				   WHERE session_id IN (${ph})) +
				  (SELECT COUNT(*) FROM provider_tool_start_lineage
				   WHERE session_id IN (${ph}))) AS providerMessageFrames,
			 (SELECT COALESCE(SUM(
			    length(COALESCE(text, '')) + length(COALESCE(recap, '')) +
			    length(COALESCE(context_manifest_json, ''))
			  ), 0) FROM messages WHERE session_id IN (${ph})) +
				 (SELECT COALESCE(SUM(
				    length(COALESCE(input_json, '')) + length(COALESCE(result_text, '')) +
				    length(COALESCE(subagent_json, '')) + length(COALESCE(activity_json, ''))
				  ), 0) FROM tool_events WHERE session_id IN (${ph})) +
				 (SELECT COALESCE(SUM(
				    length(tool_id) + length(tool_name) +
				    length(COALESCE(display_name, '')) + length(decision) +
				    length(COALESCE(human_decision, '')) +
				    length(COALESCE(provider_outcome, '')) +
				    length(COALESCE(provider_id, '')) +
				    length(COALESCE(provider_session_id, '')) +
				    length(COALESCE(provider_reason_type, '')) +
				    length(COALESCE(provider_reason, '')) +
				    length(COALESCE(provider_message, ''))
				  ), 0) FROM permission_events WHERE session_id IN (${ph})) +
				 (SELECT COALESCE(SUM(
				    length(provider_id) + length(COALESCE(provider_session_id, '')) +
				    length(COALESCE(provider_uuid, '')) +
				    length(COALESCE(subagent_json, '')) +
				    length(COALESCE(activity_json, ''))
				  ), 0) FROM provider_tool_metadata_contributions
				  WHERE session_id IN (${ph})) +
				 (SELECT COALESCE(SUM(
				    length(provider_id) + length(provider_session_id) + length(provider_uuid)
				  ), 0) FROM provider_tool_start_lineage
				  WHERE session_id IN (${ph})) +
			 (SELECT COALESCE(SUM(
			    length(provider_id) + length(provider_session_id) +
			    length(provider_uuid) + length(COALESCE(text_fragment, '')) +
			    length(COALESCE(raw_tool_start_ids_json, '')) +
			    length(COALESCE(tool_start_ids_json, '')) +
			    length(COALESCE(tool_result_ids_json, ''))
			  ), 0) FROM provider_message_frames WHERE session_id IN (${ph})) +
			 (SELECT COALESCE(SUM(
			    length(provider_id) + length(provider_session_id) +
			    length(provider_uuid) + length(source)
			  ), 0) FROM provider_message_retractions
			  WHERE session_id IN (${ph})) AS estimatedDatabaseBytes,
			 (SELECT COUNT(*) FROM usage_queries WHERE session_id IN (${ph})) AS usageQueriesPreserved,
			 (SELECT COUNT(*) FROM attachments
			  WHERE kind = 'ephemeral' AND session_id IN (${ph})) AS managedAttachments,
			 (SELECT COALESCE(SUM(size_bytes), 0) FROM attachments
			  WHERE kind = 'ephemeral' AND session_id IN (${ph})) AS managedAttachmentBytes,
			 (SELECT COUNT(*) FROM attachments
			  WHERE kind = 'ephemeral' AND retention = 'retained'
			    AND session_id IN (${ph})) AS retainedRelics,
			 (SELECT COALESCE(SUM(size_bytes), 0) FROM attachments
			  WHERE kind = 'ephemeral' AND retention = 'retained'
			    AND session_id IN (${ph})) AS retainedRelicBytes,
			 (SELECT COUNT(*) FROM attachments
			  WHERE kind = 'vault' AND session_id IN (${ph})) AS vaultLinksDetached,
			 (SELECT COUNT(*) FROM plan_proposals WHERE session_id IN (${ph})) AS planProposals,
			 (SELECT COUNT(*) FROM ask_user_questions WHERE session_id IN (${ph})) AS askUserQuestions,
			 (SELECT COUNT(*) FROM project_preview_feedback
			  WHERE session_id IN (${ph})) AS projectPreviewFeedback`,
		)
		.get(...Array.from({ length: 23 }, () => ids).flat());
	return row ? { days, cutoff, ...row } : emptyCleanupPreview(days, cutoff);
}

export async function getSessionCleanupPreview(
	days: number,
	excludedSessionIds: readonly string[] = [],
): Promise<SessionCleanupPreview> {
	const db = await getDb();
	const cutoff = Math.floor(Date.now() / 1000) - days * 86_400;
	const ids = cleanupSessionIds(db, cutoff, excludedSessionIds);
	const preview = emptyCleanupPreview(days, cutoff);
	for (let offset = 0; offset < ids.length; offset += 250) {
		const part = cleanupPreviewForIds(
			db,
			days,
			cutoff,
			ids.slice(offset, offset + 250),
		);
		for (const key of Object.keys(part) as (keyof SessionCleanupPreview)[]) {
			if (key === "days" || key === "cutoff") continue;
			preview[key] += part[key];
		}
	}
	return preview;
}

/**
 * Atomically remove a delegated child whose setup failed before launch.
 * The exact pending provenance row is deleted before ordinary session cleanup
 * so delegation ownership cannot block its own rollback.
 */
export async function rollbackHlidDelegationSetup(
	delegationId: string,
	childSessionId: string,
): Promise<void> {
	const db = await getDb();
	let removedSession = false;
	db.transaction(() => {
		const delegation = db
			.query<{ child_session_id: string; status: string }, [string]>(
				`SELECT child_session_id, status
				 FROM session_delegations
				 WHERE id = ?`,
			)
			.get(delegationId);
		if (
			delegation &&
			(delegation.child_session_id !== childSessionId ||
				delegation.status !== "pending")
		) {
			throw new Error(
				"Delegated child setup rollback no longer owns an exact pending child.",
			);
		}
		if (delegation) {
			const removed = db.run(
				`DELETE FROM session_delegations
				 WHERE id = ? AND child_session_id = ? AND status = 'pending'`,
				[delegationId, childSessionId],
			);
			if (removed.changes !== 1) {
				throw new Error(
					"Delegated child setup rollback lost its pending lifecycle claim.",
				);
			}
		}
		removedSession =
			db
				.query<{ present: number }, [string]>(
					`SELECT 1 AS present FROM sessions WHERE id = ?`,
				)
				.get(childSessionId)?.present === 1;
		cascadeDeleteSessionIds(db, [childSessionId]);
	})();
	if (removedSession) {
		markAnalyticsChanged(["stats", "activity"], "delegation_setup_rolled_back");
	}
}

function hasDelegationDescendants(db: Db, sessionId: string): boolean {
	return (
		db
			.query<{ present: number }, [string]>(
				`SELECT 1 AS present
				 FROM session_delegations
				 WHERE parent_session_id = ?
				 LIMIT 1`,
			)
			.get(sessionId)?.present === 1
	);
}

function hasBlockingDelegationOwnership(
	db: Db,
	sessionId: string,
	operation: "archive" | "delete",
): boolean {
	const resumableInterrupted =
		operation === "delete"
			? `OR (
			     delegation.status = 'interrupted'
			     AND delegation.routine_run_id IS NULL
			     AND delegation.attempt_count < ${HLID_DELEGATION_MAX_ATTEMPTS}
			     AND child.archived_at IS NULL
			   )`
			: "";
	return (
		db
			.query<{ present: number }, [string]>(
				`SELECT 1 AS present
				 FROM session_delegations delegation
				 JOIN sessions child
				   ON child.id = delegation.child_session_id
				 WHERE delegation.child_session_id = ?
				   AND (
				     delegation.status IN ('pending', 'running')
				     ${resumableInterrupted}
				   )
				 LIMIT 1`,
			)
			.get(sessionId)?.present === 1
	);
}

export async function deleteSession(
	id: string,
): Promise<{ ephemeralPaths: string[] }> {
	const db = await getDb();
	let ephemeralPaths: string[] = [];
	db.transaction(() => {
		if (hasBlockingDelegationOwnership(db, id, "delete")) {
			throw new SessionDelegationOwnershipError(id, "delete");
		}
		if (hasDelegationDescendants(db, id)) {
			throw new SessionHasDelegationDescendantsError(id);
		}
		ephemeralPaths = cascadeDeleteSessionIds(db, [id]);
	})();
	markAnalyticsChanged(["stats", "activity"], "session_deleted");
	return { ephemeralPaths };
}

export async function deleteSessionsOlderThan(
	days: number,
	excludedSessionIds: readonly string[] = [],
): Promise<{ count: number; ephemeralPaths: string[]; sessionIds: string[] }> {
	const db = await getDb();
	const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
	const ids: string[] = [];
	const ephemeralPaths: string[] = [];
	while (true) {
		const batch = cleanupSessionIds(
			db,
			cutoff,
			excludedSessionIds,
			SESSION_CLEANUP_BATCH_SIZE,
		);
		if (batch.length === 0) break;
		let batchPaths: string[] = [];
		db.transaction(() => {
			batchPaths = cascadeDeleteSessionIds(db, batch);
		})();
		ids.push(...batch);
		ephemeralPaths.push(...batchPaths);
		// Keep the server responsive between bounded SQLite transactions.
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	if (ids.length > 0) {
		markAnalyticsChanged(["stats", "activity"], "sessions_cleaned_up");
	}
	return { count: ids.length, ephemeralPaths, sessionIds: ids };
}

export async function renameSession(id: string, label: string): Promise<void> {
	const db = await getDb();
	let changes = 0;
	db.transaction(() => {
		({ changes } = db.run(`UPDATE sessions SET label = ? WHERE id = ?`, [
			label,
			id,
		]));
		if (changes > 0) {
			db.run(
				`INSERT INTO session_search (session_id, text) VALUES (?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET text = excluded.text`,
				[id, normalizeSearchText(label)],
			);
			db.run(
				`UPDATE session_delegations
				 SET parent_label = ?
				 WHERE parent_session_id = ?`,
				[label, id],
			);
		}
	})();
	if (changes === 0) throw new Error("Session not found");
	if (changes > 0) markAnalyticsChanged(["stats"], "session_renamed");
}

export async function setSessionPinned(
	id: string,
	pinned: boolean,
): Promise<void> {
	const db = await getDb();
	db.run(`UPDATE sessions SET pinned = ? WHERE id = ?`, [pinned ? 1 : 0, id]);
}

export async function setSessionArchived(
	id: string,
	archived: boolean,
): Promise<void> {
	const db = await getDb();
	db.transaction(() => {
		if (archived && hasBlockingDelegationOwnership(db, id, "archive")) {
			throw new SessionDelegationOwnershipError(id, "archive");
		}
		const result = archived
			? db.run(
					`UPDATE sessions
					 SET archived_at = unixepoch(), pinned = 0
					 WHERE id = ? AND archived_at IS NULL`,
					[id],
				)
			: db.run(
					`UPDATE sessions SET archived_at = NULL
					 WHERE id = ? AND archived_at IS NOT NULL`,
					[id],
				);
		if (result.changes === 0) {
			const existing = db
				.query<{ id: string }, [string]>(`SELECT id FROM sessions WHERE id = ?`)
				.get(id);
			if (!existing) throw new Error("Session not found");
		}
	})();
}

export async function getSessionById(id: string): Promise<SessionRow | null> {
	const db = await getDb();
	return (
		db
			.query<SessionRow, [string]>(
				`SELECT child.*, parent.label AS fork_parent_label,
				        ${sessionToolCallCountColumn("child")},
				        ${sessionDelegationColumns("child")}
				 FROM sessions child
				 LEFT JOIN sessions parent ON parent.id = child.fork_parent_session_id
				 WHERE child.id = ?`,
			)
			.get(id) ?? null
	);
}

export async function getRecentSessions(limit = 14): Promise<SessionRow[]> {
	const db = await getDb();
	return db
		.query<SessionRow, [number]>(
			`SELECT child.*, parent.label AS fork_parent_label,
			        ${sessionToolCallCountColumn("child")},
			        ${sessionDelegationColumns("child")}
			 FROM sessions child
			 LEFT JOIN sessions parent ON parent.id = child.fork_parent_session_id
			 WHERE child.history_imported = 0 AND child.archived_at IS NULL
			 ORDER BY child.pinned DESC,
			  COALESCE(child.ended_at, child.started_at) DESC
			 LIMIT ?`,
		)
		.all(limit);
}
