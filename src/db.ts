import { resolve } from "node:path";

const DB_PATH = resolve(process.cwd(), "hlid.db");

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
      COALESCE(SUM(total_cost), 0) as cost,
      COALESCE(SUM(query_count), 0) as queries,
      COALESCE(SUM(total_input_tokens), 0) as input_tokens,
      COALESCE(SUM(total_output_tokens), 0) as output_tokens,
      COALESCE(SUM(total_cache_read_tokens), 0) as cache_read_tokens,
      COALESCE(SUM(total_cache_creation_tokens), 0) as cache_creation_tokens,
      COALESCE(SUM(total_turns), 0) as turns
    FROM sessions
  `)
			.get() ?? EMPTY_ALLTIME;

	const today =
		db
			.query<WindowRow, []>(`
    SELECT
      COALESCE(SUM(total_cost), 0) as cost,
      COALESCE(SUM(query_count), 0) as queries,
      COALESCE(SUM(total_input_tokens + total_output_tokens), 0) as tokens
    FROM sessions
    WHERE started_at >= unixepoch('now', 'start of day')
  `)
			.get() ?? EMPTY_WINDOW;

	const thisMonth =
		db
			.query<WindowRow, []>(`
    SELECT
      COALESCE(SUM(total_cost), 0) as cost,
      COALESCE(SUM(query_count), 0) as queries,
      COALESCE(SUM(total_input_tokens + total_output_tokens), 0) as tokens
    FROM sessions
    WHERE started_at >= unixepoch('now', 'start of month')
  `)
			.get() ?? EMPTY_WINDOW;

	return { allTime, today, thisMonth };
}

export type WeeklyStats = {
	total: number;
	days: number[]; // index 0=Sun … 6=Sat
};

export async function getWeeklyStats(): Promise<WeeklyStats> {
	const db = await getDb();
	const now = new Date();
	const startOfWeek = new Date(now);
	startOfWeek.setHours(0, 0, 0, 0);
	startOfWeek.setDate(startOfWeek.getDate() - now.getDay());
	const startUnix = Math.floor(startOfWeek.getTime() / 1000);

	type Row = { day: number; count: number };
	const rows = db
		.query<Row, [number]>(
			`SELECT CAST(strftime('%w', started_at, 'unixepoch', 'localtime') AS INTEGER) as day,
			        COUNT(*) as count
			 FROM sessions
			 WHERE started_at >= ?
			 GROUP BY day`,
		)
		.all(startUnix);

	const days = Array(7).fill(0) as number[];
	let total = 0;
	for (const row of rows) {
		days[row.day] = row.count;
		total += row.count;
	}
	return { total, days };
}
