import {
	estimateProviderCost,
	hasProviderPricing,
	isSyntheticModel,
} from "../lib/providerPricing";
import { normalizeSearchText } from "../lib/search";
import { markAnalyticsChanged } from "./analyticsRevision";
import { type LedgerStatsRange, ledgerRangeCondition } from "./ledgerAnalytics";
import type { Db } from "./schema";
import { getDb } from "./schema";
import type {
	QueryData,
	SessionRow,
	SessionSelection,
	SessionSort,
} from "./types";

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
	db.run(`UPDATE sessions SET model = ?, selected_model = ? WHERE id = ?`, [
		model,
		model,
		sessionId,
	]);
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
			},
			[string]
		>(
			`SELECT agent_cwd,
			        provider_id,
			        COALESCE(selected_model, actual_model, model) AS model,
			        selected_effort AS effort,
			        selected_permission_mode AS permission_mode
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

export async function setSessionClaudeId(
	sessionId: string,
	claudeId: string | null,
): Promise<void> {
	await setSessionProviderSession(sessionId, "claude", claudeId);
}

export async function getSessionClaudeId(
	sessionId: string,
): Promise<string | null> {
	return getSessionProviderSession(sessionId, "claude");
}

export async function setSessionProviderSession(
	sessionId: string,
	providerId: string,
	providerSessionId: string | null,
): Promise<void> {
	const db = await getDb();
	db.run(
		`UPDATE sessions
		 SET provider_id = ?, provider_session_id = ?,
		     claude_session_id = CASE WHEN ? = 'claude' THEN ? ELSE claude_session_id END
		 WHERE id = ?`,
		[providerId, providerSessionId, providerId, providerSessionId, sessionId],
	);
	markAnalyticsChanged(["stats", "activity"], "session_provider_session");
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
	return row.provider_session_id ?? row.claude_session_id ?? null;
}

export async function setSessionProviderId(
	sessionId: string,
	providerId: string,
): Promise<void> {
	const db = await getDb();
	db.run(`UPDATE sessions SET provider_id = ? WHERE id = ?`, [
		providerId,
		sessionId,
	]);
	markAnalyticsChanged(["stats", "activity"], "session_provider");
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

export async function setSessionActualModel(
	sessionId: string,
	actualModel: string,
): Promise<void> {
	const db = await getDb();
	db.run(`UPDATE sessions SET actual_model = ? WHERE id = ?`, [
		actualModel,
		sessionId,
	]);
	markAnalyticsChanged(["stats", "activity"], "session_actual_model");
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
	selection: { effort?: string; permissionMode?: string } = {},
): Promise<void> {
	const db = await getDb();
	let changes = 0;
	db.transaction(() => {
		({ changes } = db.run(
			`INSERT OR IGNORE INTO sessions
			 (id, label, model, selected_model, selected_effort, selected_permission_mode, started_at)
			 VALUES (?, ?, ?, ?, ?, ?, unixepoch())`,
			[
				id,
				label,
				model,
				model,
				selection.effort ?? null,
				selection.permissionMode ?? null,
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
 * permission mode/cwd/provider) from an existing source session, pointing it
 * at an already-forked native provider session id. Used by the fork-session
 * flow — the transcript fork itself happens provider-side before this runs.
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
		 SET fork_parent_session_id = ?, fork_parent_message_id = ?, fork_kind = ?
		 WHERE id = ?`,
		[
			sourceId,
			options.parentMessageId ?? null,
			options.forkKind ?? "exact",
			newId,
		],
	);
}

export async function recordQuery(
	sessionId: string,
	data: QueryData,
	providerId = "claude",
): Promise<{ estimatedCost: number | null }> {
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
	database.transaction(() => {
		database.run(
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
			`INSERT INTO usage_queries (session_id, timestamp, cost, cost_known, estimated_cost, unpriced, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, turns, provider_id, model, agent_cwd)
			 VALUES (?, unixepoch(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
				providerId,
				queryModel,
				queryAgentCwd,
			],
		);
	})();
	markAnalyticsChanged(undefined, "query_recorded");
	return { estimatedCost };
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

type SessionListOptions = {
	search?: string;
	sort?: SessionSort;
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
	const conditions: string[] = [];
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
			`SELECT * FROM sessions ${whereSql}
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
			`SELECT MIN(started_at) as oldest FROM sessions WHERE history_imported = 0`,
		)
		.get();
	const agentCwds = db
		.query<{ agent_cwd: string }, []>(
			`SELECT DISTINCT agent_cwd
			 FROM sessions
			 WHERE agent_cwd IS NOT NULL AND TRIM(agent_cwd) <> ''
			 ORDER BY agent_cwd COLLATE NOCASE ASC`,
		)
		.all()
		.map((row) => row.agent_cwd);
	const agentFilter = buildSessionFilter({ agent: opts.agent });
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
			`SELECT * FROM sessions ORDER BY COALESCE(ended_at, started_at) DESC`,
		)
		.all();
}

/**
 * Delete all rows for a set of session IDs across every related table.
 * Must be called inside a transaction. Returns ephemeral attachment paths
 * so the caller can unlink them from disk.
 */
function cascadeDeleteSessionIds(db: Db, ids: string[]): string[] {
	if (ids.length === 0) return [];
	const ph = ids.map(() => "?").join(",");
	const rows = db
		.query<{ path: string }, string[]>(
			`SELECT path FROM attachments WHERE kind = 'ephemeral' AND retention = 'session' AND session_id IN (${ph})`,
		)
		.all(...ids);
	const ephemeralPaths = rows.map((r) => r.path);
	db.run(
		`DELETE FROM attachments WHERE kind = 'ephemeral' AND retention = 'session' AND session_id IN (${ph})`,
		ids,
	);
	db.run(
		`UPDATE attachments SET session_id = NULL, message_seq = NULL WHERE (kind = 'vault' OR retention != 'session') AND session_id IN (${ph})`,
		ids,
	);
	db.run(`DELETE FROM tool_events WHERE session_id IN (${ph})`, ids);
	db.run(`DELETE FROM permission_events WHERE session_id IN (${ph})`, ids);
	db.run(`DELETE FROM messages WHERE session_id IN (${ph})`, ids);
	db.run(`DELETE FROM queries WHERE session_id IN (${ph})`, ids);
	db.run(
		`DELETE FROM provider_history_transcripts
		 WHERE EXISTS (
		   SELECT 1 FROM sessions s
		   WHERE s.id IN (${ph})
		     AND s.history_imported = 1
		     AND s.provider_id = provider_history_transcripts.provider_id
		     AND s.provider_session_id = provider_history_transcripts.native_session_id
		 )`,
		ids,
	);
	// usage_queries intentionally NOT deleted — immutable ledger for all-time stats
	db.run(`DELETE FROM sessions WHERE id IN (${ph})`, ids);
	return ephemeralPaths;
}

export async function deleteSession(
	id: string,
): Promise<{ ephemeralPaths: string[] }> {
	const db = await getDb();
	let ephemeralPaths: string[] = [];
	db.transaction(() => {
		ephemeralPaths = cascadeDeleteSessionIds(db, [id]);
	})();
	markAnalyticsChanged(["stats", "activity"], "session_deleted");
	return { ephemeralPaths };
}

export async function deleteSessionsOlderThan(
	days: number,
): Promise<{ count: number; ephemeralPaths: string[] }> {
	const db = await getDb();
	const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
	let ids: string[] = [];
	let ephemeralPaths: string[] = [];
	db.transaction(() => {
		const sessionRows = db
			.query<{ id: string }, [number]>(
				`SELECT id FROM sessions WHERE started_at < ? AND history_imported = 0`,
			)
			.all(cutoff);
		ids = sessionRows.map((r) => r.id);
		if (ids.length > 0) {
			ephemeralPaths = cascadeDeleteSessionIds(db, ids);
		}
	})();
	if (ids.length > 0) {
		markAnalyticsChanged(["stats", "activity"], "sessions_cleaned_up");
	}
	return { count: ids.length, ephemeralPaths };
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
		}
	})();
	if (changes > 0) markAnalyticsChanged(["stats"], "session_renamed");
}

export async function setSessionPinned(
	id: string,
	pinned: boolean,
): Promise<void> {
	const db = await getDb();
	db.run(`UPDATE sessions SET pinned = ? WHERE id = ?`, [pinned ? 1 : 0, id]);
}

export async function getSessionById(id: string): Promise<SessionRow | null> {
	const db = await getDb();
	return (
		db
			.query<SessionRow, [string]>(`SELECT * FROM sessions WHERE id = ?`)
			.get(id) ?? null
	);
}

export async function getRecentSessions(limit = 14): Promise<SessionRow[]> {
	const db = await getDb();
	return db
		.query<SessionRow, [number]>(
			`SELECT * FROM sessions WHERE history_imported = 0
			 ORDER BY COALESCE(ended_at, started_at) DESC LIMIT ?`,
		)
		.all(limit);
}
