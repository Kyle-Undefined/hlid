import { resolve } from "node:path";
import { APP_DIR } from "./lib/paths";

const DB_PATH = resolve(APP_DIR, "hlid.db");

let _initPromise: Promise<import("bun:sqlite").Database> | null = null;

export type SessionRow = {
	id: string;
	label: string | null;
	model: string | null;
	started_at: number;
	ended_at: number | null;
	query_count: number;
	total_cost: number;
	total_input_tokens: number;
	total_output_tokens: number;
	total_cache_read_tokens: number;
	total_cache_creation_tokens: number;
	total_turns: number;
};

export type MessageRow = {
	id: number;
	session_id: string;
	seq: number;
	role: string;
	text: string;
	timestamp: number;
};

export type ToolEventRow = {
	id: number;
	session_id: string;
	assistant_seq: number;
	tool_id: string;
	name: string;
	input_json: string;
};

export type QueryData = {
	cost: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
	duration_ms: number;
	turns: number;
	context_window: number | null;
	stop_reason: string | null;
};

export type AggWindow = {
	cost: number;
	queries: number;
	tokens: number;
};

export type AggStats = {
	allTime: {
		cost: number;
		queries: number;
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

export function getDb(): Promise<import("bun:sqlite").Database> {
	if (!_initPromise) {
		_initPromise = (async () => {
			const { Database } = await import("bun:sqlite");
			const db = new Database(DB_PATH);
			db.run("PRAGMA journal_mode=WAL");
			initSchema(db);
			return db;
		})();
	}
	return _initPromise;
}

function initSchema(db: import("bun:sqlite").Database): void {
	db.run("PRAGMA foreign_keys = ON");
	db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);
	db.run(`
    CREATE TABLE IF NOT EXISTS env_vars (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);
	db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      label TEXT,
      model TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      query_count INTEGER DEFAULT 0,
      total_cost REAL DEFAULT 0,
      total_input_tokens INTEGER DEFAULT 0,
      total_output_tokens INTEGER DEFAULT 0,
      total_cache_read_tokens INTEGER DEFAULT 0,
      total_cache_creation_tokens INTEGER DEFAULT 0,
      total_turns INTEGER DEFAULT 0
    )
  `);
	db.run(`
    CREATE TABLE IF NOT EXISTS queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      timestamp INTEGER NOT NULL,
      cost REAL DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      turns INTEGER DEFAULT 0,
      context_window INTEGER,
      stop_reason TEXT
    )
  `);
	db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    )
  `);
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_queries_session ON queries(session_id)`,
	);
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)`,
	);
	db.run(`
    CREATE TABLE IF NOT EXISTS tool_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      assistant_seq INTEGER NOT NULL,
      tool_id TEXT NOT NULL,
      name TEXT NOT NULL,
      input_json TEXT NOT NULL
    )`);
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_tool_events_session ON tool_events(session_id)`,
	);
	db.run(`
    CREATE TABLE IF NOT EXISTS usage_daily (
      date TEXT PRIMARY KEY,
      cost REAL DEFAULT 0,
      queries INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      turns INTEGER DEFAULT 0
    )
  `);
	db.run(`
    CREATE TABLE IF NOT EXISTS usage_queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      timestamp INTEGER NOT NULL,
      cost REAL DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      turns INTEGER DEFAULT 0
    )
  `);
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_usage_queries_ts ON usage_queries(timestamp)`,
	);
	db.run(`
    CREATE TABLE IF NOT EXISTS event_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
      level     TEXT NOT NULL CHECK(level IN ('error','warn','info')),
      source    TEXT NOT NULL,
      message   TEXT NOT NULL,
      detail    TEXT
    )
  `);
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_event_log_ts ON event_log(timestamp DESC)`,
	);
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_event_log_level_ts ON event_log(level, timestamp DESC)`,
	);
	db.run(`
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      message_seq INTEGER,
      kind TEXT NOT NULL CHECK(kind IN ('ephemeral','vault')),
      filename TEXT NOT NULL,
      path TEXT NOT NULL,
      mime TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT,
      created_at INTEGER NOT NULL
    )
  `);
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_attachments_session ON attachments(session_id)`,
	);
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_attachments_kind ON attachments(kind)`,
	);
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_attachments_created ON attachments(created_at DESC)`,
	);

	const fkMigrated = db
		.query<{ value: string }, [string]>(
			`SELECT value FROM settings WHERE key = ?`,
		)
		.get("_migrated_attachments_no_fk");
	if (!fkMigrated) {
		const fkRows = db
			.query<{ id: number }, []>(`PRAGMA foreign_key_list(attachments)`)
			.all();
		if (fkRows.length > 0) {
			db.transaction(() => {
				db.run(`
          CREATE TABLE attachments_new (
            id TEXT PRIMARY KEY,
            session_id TEXT,
            message_seq INTEGER,
            kind TEXT NOT NULL CHECK(kind IN ('ephemeral','vault')),
            filename TEXT NOT NULL,
            path TEXT NOT NULL,
            mime TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            sha256 TEXT,
            created_at INTEGER NOT NULL
          )
        `);
				db.run(
					`INSERT INTO attachments_new SELECT id, session_id, message_seq, kind, filename, path, mime, size_bytes, sha256, created_at FROM attachments`,
				);
				db.run(`DROP TABLE attachments`);
				db.run(`ALTER TABLE attachments_new RENAME TO attachments`);
				db.run(
					`CREATE INDEX idx_attachments_session ON attachments(session_id)`,
				);
				db.run(`CREATE INDEX idx_attachments_kind ON attachments(kind)`);
				db.run(
					`CREATE INDEX idx_attachments_created ON attachments(created_at DESC)`,
				);
			})();
		}
		db.run(
			`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())`,
			["_migrated_attachments_no_fk", "1"],
		);
	}

	const migrated = db
		.query<{ value: string }, [string]>(
			`SELECT value FROM settings WHERE key = ?`,
		)
		.get("_migrated_usage_tables");
	if (!migrated) {
		db.transaction(() => {
			db.run(`
        INSERT OR IGNORE INTO usage_daily (date, cost, queries, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, turns)
        SELECT
          DATE(timestamp, 'unixepoch', 'localtime'),
          COALESCE(SUM(cost), 0), COUNT(*),
          COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
          COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_creation_tokens), 0),
          COALESCE(SUM(turns), 0)
        FROM queries
        GROUP BY DATE(timestamp, 'unixepoch', 'localtime')
      `);
			db.run(`
        INSERT INTO usage_queries (session_id, timestamp, cost, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, turns)
        SELECT session_id, timestamp, cost, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, turns
        FROM queries
      `);
			db.run(
				`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('_migrated_usage_tables', '1', unixepoch())`,
			);
		})();
	}

	const agentCwdMigrated = db
		.query<{ value: string }, [string]>(
			`SELECT value FROM settings WHERE key = ?`,
		)
		.get("_migrated_sessions_agent_cwd");
	if (!agentCwdMigrated) {
		db.transaction(() => {
			db.run(`ALTER TABLE sessions ADD COLUMN agent_cwd TEXT`);
			db.run(
				`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('_migrated_sessions_agent_cwd', '1', unixepoch())`,
			);
		})();
	}
}

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
): Promise<void> {
	const database = await getDb();
	database.transaction(() => {
		database.run(
			`INSERT INTO queries (session_id, timestamp, cost, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, duration_ms, turns, context_window, stop_reason)
       VALUES (?, unixepoch(), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
			`INSERT INTO usage_queries (session_id, timestamp, cost, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, turns)
       VALUES (?, unixepoch(), ?, ?, ?, ?, ?, ?)`,
			[
				sessionId,
				data.cost,
				data.input_tokens,
				data.output_tokens,
				data.cache_read_tokens,
				data.cache_creation_tokens,
				data.turns,
			],
		);
	})();
}

export async function appendMessage(
	sessionId: string,
	seq: number,
	role: string,
	text: string,
): Promise<void> {
	const db = await getDb();
	db.run(
		`INSERT INTO messages (session_id, seq, role, text, timestamp) VALUES (?, ?, ?, ?, unixepoch())`,
		[sessionId, seq, role, text],
	);
}

export async function appendToolEvent(
	sessionId: string,
	assistantSeq: number,
	toolId: string,
	name: string,
	input: unknown,
): Promise<void> {
	const db = await getDb();
	db.run(
		`INSERT INTO tool_events (session_id, assistant_seq, tool_id, name, input_json) VALUES (?, ?, ?, ?, ?)`,
		[sessionId, assistantSeq, toolId, name, JSON.stringify(input)],
	);
}

export async function getSessionToolEvents(
	sessionId: string,
): Promise<ToolEventRow[]> {
	const db = await getDb();
	return db
		.query<ToolEventRow, [string]>(
			`SELECT * FROM tool_events WHERE session_id = ? ORDER BY id ASC`,
		)
		.all(sessionId);
}

export async function getSessionsPaginated(
	page: number,
	pageSize: number,
): Promise<{ sessions: SessionRow[]; total: number }> {
	const db = await getDb();
	const offset = (page - 1) * pageSize;
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

export async function deleteSession(
	id: string,
): Promise<{ ephemeralPaths: string[] }> {
	const db = await getDb();
	const ephemeralPaths: string[] = [];
	db.transaction(() => {
		const rows = db
			.query<{ path: string }, [string]>(
				`SELECT path FROM attachments WHERE session_id = ? AND kind = 'ephemeral'`,
			)
			.all(id);
		for (const r of rows) ephemeralPaths.push(r.path);
		db.run(
			`DELETE FROM attachments WHERE session_id = ? AND kind = 'ephemeral'`,
			[id],
		);
		db.run(
			`UPDATE attachments SET session_id = NULL, message_seq = NULL WHERE session_id = ? AND kind = 'vault'`,
			[id],
		);
		db.run(`DELETE FROM tool_events WHERE session_id = ?`, [id]);
		db.run(`DELETE FROM messages WHERE session_id = ?`, [id]);
		db.run(`DELETE FROM queries WHERE session_id = ?`, [id]);
		db.run(`DELETE FROM sessions WHERE id = ?`, [id]);
	})();
	return { ephemeralPaths };
}

export async function deleteSessionsOlderThan(
	days: number,
): Promise<{ count: number; ephemeralPaths: string[] }> {
	const db = await getDb();
	const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
	const row = db
		.query<{ total: number }, [number]>(
			`SELECT COUNT(*) as total FROM sessions WHERE started_at < ?`,
		)
		.get(cutoff);
	const total = row?.total ?? 0;
	if (total === 0) return { count: 0, ephemeralPaths: [] };
	const ephemeralPaths: string[] = [];
	db.transaction(() => {
		const rows = db
			.query<{ path: string }, [number]>(
				`SELECT path FROM attachments WHERE kind = 'ephemeral' AND session_id IN (SELECT id FROM sessions WHERE started_at < ?)`,
			)
			.all(cutoff);
		for (const r of rows) ephemeralPaths.push(r.path);
		db.run(
			`DELETE FROM attachments WHERE kind = 'ephemeral' AND session_id IN (SELECT id FROM sessions WHERE started_at < ?)`,
			[cutoff],
		);
		db.run(
			`UPDATE attachments SET session_id = NULL, message_seq = NULL WHERE kind = 'vault' AND session_id IN (SELECT id FROM sessions WHERE started_at < ?)`,
			[cutoff],
		);
		db.run(
			`DELETE FROM tool_events WHERE session_id IN (SELECT id FROM sessions WHERE started_at < ?)`,
			[cutoff],
		);
		db.run(
			`DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE started_at < ?)`,
			[cutoff],
		);
		db.run(
			`DELETE FROM queries WHERE session_id IN (SELECT id FROM sessions WHERE started_at < ?)`,
			[cutoff],
		);
		db.run(`DELETE FROM sessions WHERE started_at < ?`, [cutoff]);
	})();
	return { count: total, ephemeralPaths };
}

export async function getRecentSessions(limit = 14): Promise<SessionRow[]> {
	const db = await getDb();
	return db
		.query<SessionRow, [number]>(
			`SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?`,
		)
		.all(limit);
}

export async function getSessionMessages(
	sessionId: string,
): Promise<MessageRow[]> {
	const db = await getDb();
	return db
		.query<MessageRow, [string]>(
			`SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC`,
		)
		.all(sessionId);
}

export async function getCurrentSessionId(): Promise<string | null> {
	const db = await getDb();
	const row = db
		.query<{ value: string }, [string]>(
			`SELECT value FROM settings WHERE key = ?`,
		)
		.get("current_session_id");
	return row?.value ?? null;
}

export async function getSetting(key: string): Promise<string | null> {
	const db = await getDb();
	const row = db
		.query<{ value: string }, [string]>(
			`SELECT value FROM settings WHERE key = ?`,
		)
		.get(key);
	return row?.value ?? null;
}

export async function saveSetting(key: string, value: string): Promise<void> {
	const db = await getDb();
	db.run(
		`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())`,
		[key, value],
	);
}

export async function setCurrentSessionId(id: string): Promise<void> {
	const db = await getDb();
	db.run(
		`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())`,
		["current_session_id", id],
	);
}

export async function clearCurrentSessionId(): Promise<void> {
	const db = await getDb();
	db.run(`DELETE FROM settings WHERE key = ?`, ["current_session_id"]);
}

export async function getAggregatedStats(): Promise<AggStats> {
	const db = await getDb();

	type AllTimeRow = {
		cost: number;
		queries: number;
		input_tokens: number;
		output_tokens: number;
		cache_read_tokens: number;
		cache_creation_tokens: number;
		turns: number;
	};
	type WindowRow = { cost: number; queries: number; tokens: number };

	const EMPTY_ALLTIME: AllTimeRow = {
		cost: 0,
		queries: 0,
		input_tokens: 0,
		output_tokens: 0,
		cache_read_tokens: 0,
		cache_creation_tokens: 0,
		turns: 0,
	};
	const EMPTY_WINDOW: WindowRow = { cost: 0, queries: 0, tokens: 0 };

	const allTime =
		db
			.query<AllTimeRow, []>(`
    SELECT
      COALESCE(SUM(cost), 0) as cost,
      COALESCE(SUM(queries), 0) as queries,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
      COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens,
      COALESCE(SUM(turns), 0) as turns
    FROM usage_daily
  `)
			.get() ?? EMPTY_ALLTIME;

	const today =
		db
			.query<WindowRow, []>(`
    SELECT
      COALESCE(SUM(cost), 0) as cost,
      COALESCE(SUM(queries), 0) as queries,
      COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
    FROM usage_daily
    WHERE date = DATE('now', 'localtime')
  `)
			.get() ?? EMPTY_WINDOW;

	const thisMonth =
		db
			.query<WindowRow, []>(`
    SELECT
      COALESCE(SUM(cost), 0) as cost,
      COALESCE(SUM(queries), 0) as queries,
      COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
    FROM usage_daily
    WHERE date >= DATE('now', 'localtime', 'start of month')
  `)
			.get() ?? EMPTY_WINDOW;

	return { allTime, today, thisMonth };
}

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

export async function getUsageWindows(): Promise<UsageWindows> {
	const db = await getDb();

	type WindowRow = {
		tokens: number;
		sessions: number;
		queries: number;
		cost: number;
	};
	const EMPTY: WindowRow = { tokens: 0, sessions: 0, queries: 0, cost: 0 };

	const fiveHourRow =
		db
			.query<WindowRow, []>(`
      SELECT
        COALESCE(SUM(input_tokens + output_tokens), 0) as tokens,
        COUNT(DISTINCT session_id) as sessions,
        COUNT(*) as queries,
        COALESCE(SUM(cost), 0) as cost
      FROM usage_queries
      WHERE timestamp >= unixepoch('now', '-5 hours')
    `)
			.get() ?? EMPTY;

	const weeklyRow =
		db
			.query<WindowRow, []>(`
      SELECT
        COALESCE(SUM(input_tokens + output_tokens), 0) as tokens,
        COUNT(DISTINCT session_id) as sessions,
        COUNT(*) as queries,
        COALESCE(SUM(cost), 0) as cost
      FROM usage_queries
      WHERE timestamp >= unixepoch('now', '-7 days')
    `)
			.get() ?? EMPTY;

	type SettingsRow = { value: string };
	type RlState = {
		utilization: number | null;
		resetsAt: number | null;
		rateLimitType: string | null;
	};
	const NULL_RL: RlState = {
		utilization: null,
		resetsAt: null,
		rateLimitType: null,
	};

	const parseRl = (row: SettingsRow | null): RlState => {
		if (!row) return NULL_RL;
		try {
			const parsed = JSON.parse(row.value) as RlState;
			if (parsed.resetsAt != null && parsed.resetsAt < Date.now() / 1000) {
				return NULL_RL;
			}
			return parsed;
		} catch {
			return NULL_RL;
		}
	};

	const rl5hr = db
		.query<SettingsRow, [string]>(`SELECT value FROM settings WHERE key = ?`)
		.get("rl_5hr");
	const rlWeekly = db
		.query<SettingsRow, [string]>(`SELECT value FROM settings WHERE key = ?`)
		.get("rl_weekly");
	const rlWeeklySonnet = db
		.query<SettingsRow, [string]>(`SELECT value FROM settings WHERE key = ?`)
		.get("rl_weekly_sonnet");

	const sonnetRl = parseRl(rlWeeklySonnet);
	return {
		fiveHour: { ...fiveHourRow, ...parseRl(rl5hr) },
		weekly: { ...weeklyRow, ...parseRl(rlWeekly) },
		weeklySonnet:
			sonnetRl.utilization !== null
				? { utilization: sonnetRl.utilization, resetsAt: sonnetRl.resetsAt }
				: null,
	};
}

export type WeeklyStats = {
	total: number;
	days: number[]; // index 0=Sun … 6=Sat
};

export type ThirtyDayStats = {
	days: { date: string; count: number }[];
	total: number;
};

export async function getThirtyDayStats(): Promise<ThirtyDayStats> {
	const db = await getDb();
	const rows = db
		.query<{ date: string; count: number }, []>(`
    SELECT date, queries as count
    FROM usage_daily
    WHERE date >= DATE('now', 'localtime', '-29 days')
    ORDER BY date ASC
  `)
		.all();

	const map = new Map(rows.map((r) => [r.date, r.count]));
	const total = rows.reduce((a, r) => a + r.count, 0);
	const days: { date: string; count: number }[] = [];
	for (let i = 29; i >= 0; i--) {
		const d = new Date();
		d.setDate(d.getDate() - i);
		const date = d.toISOString().slice(0, 10);
		days.push({ date, count: map.get(date) ?? 0 });
	}
	return { days, total };
}

export async function getWeeklyStats(): Promise<WeeklyStats> {
	const db = await getDb();
	const now = new Date();
	const startOfWeek = new Date(now);
	startOfWeek.setHours(0, 0, 0, 0);
	startOfWeek.setDate(startOfWeek.getDate() - now.getDay());
	const y = startOfWeek.getFullYear();
	const m = String(startOfWeek.getMonth() + 1).padStart(2, "0");
	const d = String(startOfWeek.getDate()).padStart(2, "0");
	const startDate = `${y}-${m}-${d}`;

	type Row = { day: number; count: number };
	const rows = db
		.query<Row, [string]>(
			`SELECT CAST(strftime('%w', date) AS INTEGER) as day,
			        SUM(queries) as count
			 FROM usage_daily
			 WHERE date >= ?
			 GROUP BY day`,
		)
		.all(startDate);

	const days = Array(7).fill(0) as number[];
	let total = 0;
	for (const row of rows) {
		days[row.day] = row.count;
		total += row.count;
	}
	return { total, days };
}

export async function appendLog(
	level: LogLevel,
	source: string,
	message: string,
	detail?: unknown,
): Promise<void> {
	try {
		const db = await getDb();
		db.transaction(() => {
			db.run(
				`INSERT INTO event_log (level, source, message, detail) VALUES (?, ?, ?, ?)`,
				[
					level,
					source,
					message,
					detail !== undefined ? JSON.stringify(detail) : null,
				],
			);
			db.run(
				`DELETE FROM event_log WHERE id <= (SELECT id FROM event_log ORDER BY id DESC LIMIT 1 OFFSET 999)`,
			);
		})();
	} catch (e) {
		console.error("[db] appendLog failed:", e);
	}
}

export async function getLogs(
	page: number,
	pageSize: number,
	level?: LogLevel,
): Promise<{ logs: LogRow[]; total: number; counts: LogCounts }> {
	const db = await getDb();
	const offset = (page - 1) * pageSize;

	const rows = level
		? db
				.query<LogRow, [string, number, number]>(
					`SELECT * FROM event_log WHERE level = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
				)
				.all(level, pageSize, offset)
		: db
				.query<LogRow, [number, number]>(
					`SELECT * FROM event_log ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
				)
				.all(pageSize, offset);

	const totalRow = level
		? db
				.query<{ total: number }, [string]>(
					`SELECT COUNT(*) as total FROM event_log WHERE level = ?`,
				)
				.get(level)
		: db
				.query<{ total: number }, []>(`SELECT COUNT(*) as total FROM event_log`)
				.get();

	const countRows = db
		.query<{ level: string; n: number }, []>(
			`SELECT level, COUNT(*) as n FROM event_log GROUP BY level`,
		)
		.all();
	const counts: LogCounts = { error: 0, warn: 0, info: 0 };
	for (const r of countRows) {
		if (r.level === "error" || r.level === "warn" || r.level === "info")
			counts[r.level] = r.n;
	}

	return { logs: rows, total: totalRow?.total ?? 0, counts };
}

export async function clearLogs(): Promise<void> {
	const db = await getDb();
	db.run(`DELETE FROM event_log`);
}

export async function createAttachment(row: {
	id: string;
	session_id: string | null;
	kind: AttachmentKind;
	filename: string;
	path: string;
	mime: string;
	size_bytes: number;
	sha256: string | null;
}): Promise<void> {
	const db = await getDb();
	db.run(
		`INSERT INTO attachments (id, session_id, message_seq, kind, filename, path, mime, size_bytes, sha256, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, unixepoch())`,
		[
			row.id,
			row.session_id,
			row.kind,
			row.filename,
			row.path,
			row.mime,
			row.size_bytes,
			row.sha256,
		],
	);
}

export async function linkAttachmentToMessage(
	id: string,
	sessionId: string,
	messageSeq: number,
): Promise<boolean> {
	const db = await getDb();
	const result = db.run(
		`UPDATE attachments SET session_id = ?, message_seq = ? WHERE id = ?`,
		[sessionId, messageSeq, id],
	);
	return result.changes > 0;
}

export async function getAttachment(id: string): Promise<AttachmentRow | null> {
	const db = await getDb();
	return (
		db
			.query<AttachmentRow, [string]>(`SELECT * FROM attachments WHERE id = ?`)
			.get(id) ?? null
	);
}

export async function getAttachmentsForSession(
	sessionId: string,
): Promise<AttachmentRow[]> {
	const db = await getDb();
	return db
		.query<AttachmentRow, [string]>(
			`SELECT * FROM attachments WHERE session_id = ? ORDER BY created_at ASC`,
		)
		.all(sessionId);
}

export async function deleteAttachment(
	id: string,
): Promise<AttachmentRow | null> {
	const db = await getDb();
	const row = db
		.query<AttachmentRow, [string]>(`SELECT * FROM attachments WHERE id = ?`)
		.get(id);
	if (!row) return null;
	db.run(`DELETE FROM attachments WHERE id = ?`, [id]);
	return row;
}

export type AttachmentListFilter = {
	kind?: AttachmentKind;
	sessionId?: string;
	search?: string;
	since?: number;
	until?: number;
	limit?: number;
	offset?: number;
};

export async function listAttachments(
	filter: AttachmentListFilter = {},
): Promise<{ rows: AttachmentRow[]; total: number; total_bytes: number }> {
	const db = await getDb();
	const where: string[] = [];
	const params: (string | number)[] = [];
	if (filter.kind) {
		where.push("kind = ?");
		params.push(filter.kind);
	}
	if (filter.sessionId) {
		where.push("session_id = ?");
		params.push(filter.sessionId);
	}
	if (filter.search) {
		where.push("filename LIKE ?");
		params.push(`%${filter.search}%`);
	}
	if (filter.since != null) {
		where.push("created_at >= ?");
		params.push(filter.since);
	}
	if (filter.until != null) {
		where.push("created_at <= ?");
		params.push(filter.until);
	}
	const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

	const totals = db
		.query<{ total: number; total_bytes: number }, (string | number)[]>(
			`SELECT COUNT(*) as total, COALESCE(SUM(size_bytes), 0) as total_bytes FROM attachments ${whereSql}`,
		)
		.get(...params) ?? { total: 0, total_bytes: 0 };

	const limit = filter.limit ?? 100;
	const offset = filter.offset ?? 0;
	const rows = db
		.query<AttachmentRow, (string | number)[]>(
			`SELECT * FROM attachments ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
		)
		.all(...params, limit, offset);

	return { rows, total: totals.total, total_bytes: totals.total_bytes };
}
