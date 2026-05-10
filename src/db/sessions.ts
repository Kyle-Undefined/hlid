import type { Db } from "./schema";
import { getDb } from "./schema";
import type { QueryData, SessionRow } from "./types";

export async function setSessionAgentCwd(
	sessionId: string,
	cwd: string,
): Promise<void> {
	const db = await getDb();
	db.run(`UPDATE sessions SET agent_cwd = ? WHERE id = ?`, [cwd, sessionId]);
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

export async function setSessionClaudeId(
	sessionId: string,
	claudeId: string | null,
): Promise<void> {
	const db = await getDb();
	db.run(`UPDATE sessions SET claude_session_id = ? WHERE id = ?`, [
		claudeId,
		sessionId,
	]);
}

export async function getSessionClaudeId(
	sessionId: string,
): Promise<string | null> {
	const db = await getDb();
	const row = db
		.query<{ claude_session_id: string | null }, [string]>(
			`SELECT claude_session_id FROM sessions WHERE id = ?`,
		)
		.get(sessionId);
	return row?.claude_session_id ?? null;
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
): Promise<void> {
	const db = await getDb();
	db.run(
		`INSERT OR IGNORE INTO sessions (id, label, model, started_at) VALUES (?, ?, ?, unixepoch())`,
		[id, label, model],
	);
}

export async function recordQuery(
	sessionId: string,
	data: QueryData,
	providerId = "claude",
): Promise<void> {
	const database = await getDb();
	database.transaction(() => {
		database.run(
			`INSERT INTO queries (session_id, timestamp, cost, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, duration_ms, turns, context_window, stop_reason, tokens_in_context)
       VALUES (?, unixepoch(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				sessionId,
				data.cost,
				data.input_tokens,
				data.output_tokens,
				data.cache_read_tokens,
				data.cache_creation_tokens,
				data.duration_ms,
				data.turns,
				data.context_window,
				data.stop_reason,
				data.tokens_in_context ?? null,
			],
		);
		database.run(
			`UPDATE sessions SET
         query_count = query_count + 1,
         total_cost = total_cost + ?,
         total_input_tokens = total_input_tokens + ?,
         total_output_tokens = total_output_tokens + ?,
         total_cache_read_tokens = total_cache_read_tokens + ?,
         total_cache_creation_tokens = total_cache_creation_tokens + ?,
         total_turns = total_turns + ?,
         ended_at = unixepoch()
       WHERE id = ?`,
			[
				data.cost,
				data.input_tokens,
				data.output_tokens,
				data.cache_read_tokens,
				data.cache_creation_tokens,
				data.turns,
				sessionId,
			],
		);
		database.run(
			`INSERT INTO usage_daily (date, cost, queries, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, turns)
       VALUES (DATE('now', 'localtime'), ?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         cost = cost + excluded.cost,
         queries = queries + 1,
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
         cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
         turns = turns + excluded.turns`,
			[
				data.cost,
				data.input_tokens,
				data.output_tokens,
				data.cache_read_tokens,
				data.cache_creation_tokens,
				data.turns,
			],
		);
		database.run(
			`INSERT INTO usage_queries (session_id, timestamp, cost, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, turns, provider_id)
       VALUES (?, unixepoch(), ?, ?, ?, ?, ?, ?, ?)`,
			[
				sessionId,
				data.cost,
				data.input_tokens,
				data.output_tokens,
				data.cache_read_tokens,
				data.cache_creation_tokens,
				data.turns,
				providerId,
			],
		);
	})();
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
				 WHERE session_id = ?
				 ORDER BY timestamp DESC
				 LIMIT 1`,
			)
			.get(sessionId) ?? null
	);
}

export async function getSessionsPaginated(
	page: number,
	pageSize: number,
): Promise<{ sessions: SessionRow[]; total: number }> {
	const db = await getDb();
	const offset = Math.max(0, (page - 1) * pageSize);
	const sessions = db
		.query<SessionRow, [number, number]>(
			`SELECT * FROM sessions ORDER BY started_at DESC LIMIT ? OFFSET ?`,
		)
		.all(pageSize, offset);
	const row = db
		.query<{ total: number }, []>(`SELECT COUNT(*) as total FROM sessions`)
		.get();
	return { sessions, total: row?.total ?? 0 };
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
			`SELECT path FROM attachments WHERE kind = 'ephemeral' AND session_id IN (${ph})`,
		)
		.all(...ids);
	const ephemeralPaths = rows.map((r) => r.path);
	db.run(
		`DELETE FROM attachments WHERE kind = 'ephemeral' AND session_id IN (${ph})`,
		ids,
	);
	db.run(
		`UPDATE attachments SET session_id = NULL, message_seq = NULL WHERE kind = 'vault' AND session_id IN (${ph})`,
		ids,
	);
	db.run(`DELETE FROM tool_events WHERE session_id IN (${ph})`, ids);
	db.run(`DELETE FROM permission_events WHERE session_id IN (${ph})`, ids);
	db.run(`DELETE FROM messages WHERE session_id IN (${ph})`, ids);
	db.run(`DELETE FROM queries WHERE session_id IN (${ph})`, ids);
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
				`SELECT id FROM sessions WHERE started_at < ?`,
			)
			.all(cutoff);
		ids = sessionRows.map((r) => r.id);
		if (ids.length > 0) {
			ephemeralPaths = cascadeDeleteSessionIds(db, ids);
		}
	})();
	return { count: ids.length, ephemeralPaths };
}

export async function renameSession(id: string, label: string): Promise<void> {
	const db = await getDb();
	db.run(`UPDATE sessions SET label = ? WHERE id = ?`, [label, id]);
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
			`SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?`,
		)
		.all(limit);
}
