import { resolve } from "node:path";
import { APP_DIR } from "../lib/paths";

const DB_PATH = resolve(APP_DIR, "hlid.db");

let _initPromise: Promise<import("bun:sqlite").Database> | null = null;

export type Db = import("bun:sqlite").Database;

/**
 * Inject a pre-built in-memory Database for tests.
 * Initializes schema on the provided DB so callers don't need to.
 * Never call this in production code.
 */
export function setDbForTest(db: Db): void {
	initSchema(db);
	_initPromise = Promise.resolve(db);
}

export function getDb(): Promise<Db> {
	if (!_initPromise) {
		_initPromise = (async () => {
			const { Database } = await import("bun:sqlite");
			const db = new Database(DB_PATH);
			db.run("PRAGMA journal_mode=WAL");
			initSchema(db);
			return db;
		})().catch((err) => {
			_initPromise = null;
			throw err;
		});
	}
	return _initPromise;
}

/** Run a named migration exactly once, gated by a settings flag. */
function runMigration(db: Db, name: string, fn: (db: Db) => void): void {
	const done = db
		.query<{ value: string }, [string]>(
			`SELECT value FROM settings WHERE key = ?`,
		)
		.get(name);
	if (!done) {
		db.transaction(() => {
			fn(db);
			db.run(
				`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, '1', unixepoch())`,
				[name],
			);
		})();
	}
}

function initSchema(db: Db): void {
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
    CREATE TABLE IF NOT EXISTS permission_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      tool_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      display_name TEXT,
      decision TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    )`);
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_permission_events_session ON permission_events(session_id)`,
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

	runMigration(db, "_migrated_usage_tables", (db) => {
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
	});

	runMigration(db, "_migrated_sessions_agent_cwd", (db) => {
		db.run(`ALTER TABLE sessions ADD COLUMN agent_cwd TEXT`);
	});

	// claude_session_id: the SDK's internal session UUID for `resume`. Captured
	// from the `system/init` event on the first turn of each chat and reused
	// thereafter so the CLI manages conversation history natively (no manual
	// transcript replay). Existing chats migrate with NULL — their next message
	// starts a fresh CLI session, losing model-side context for that one turn.
	runMigration(db, "_migrated_sessions_claude_session_id", (db) => {
		db.run(`ALTER TABLE sessions ADD COLUMN claude_session_id TEXT`);
	});

	// actual_model: the model the CLI actually used (may differ from `model`
	// when an agent's CLAUDE.md frontmatter overrides the vault default).
	runMigration(db, "_migrated_sessions_actual_model", (db) => {
		db.run(`ALTER TABLE sessions ADD COLUMN actual_model TEXT`);
	});

	runMigration(db, "_migrated_queries_tokens_in_context", (db) => {
		db.run(`ALTER TABLE queries ADD COLUMN tokens_in_context INTEGER`);
	});

	runMigration(db, "_migrated_messages_recap", (db) => {
		db.run(`ALTER TABLE messages ADD COLUMN recap TEXT`);
	});

	runMigration(db, "_migrated_tool_events_result", (db) => {
		db.run(`ALTER TABLE tool_events ADD COLUMN result_text TEXT`);
		db.run(`ALTER TABLE tool_events ADD COLUMN is_error INTEGER`);
	});

	runMigration(db, "_migrated_plan_proposals_table", (db) => {
		db.run(`
      CREATE TABLE IF NOT EXISTS plan_proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        proposal_id TEXT NOT NULL UNIQUE,
        seq INTEGER NOT NULL,
        plan TEXT NOT NULL,
        decision TEXT NOT NULL,
        timestamp INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
		db.run(
			`CREATE INDEX IF NOT EXISTS idx_plan_proposals_session ON plan_proposals(session_id)`,
		);
	});

	// provider_id: tracks which agent provider recorded each query row so
	// usage windows can be filtered per-provider in the multi-provider UI.
	// Existing rows default to 'claude' (the only provider before this migration).
	runMigration(db, "_migrated_usage_queries_provider_id", (db) => {
		db.run(
			`ALTER TABLE usage_queries ADD COLUMN provider_id TEXT NOT NULL DEFAULT 'claude'`,
		);
	});

	// Rename Anthropic-specific settings keys to provider-namespaced format.
	// Old: rl_5hr / rl_weekly / rl_weekly_sonnet
	// New: rl_claude_five_hour / rl_claude_weekly / rl_claude_weekly_sonnet
	runMigration(db, "_migrated_rl_keys_provider_namespaced", (db) => {
		db.run(
			`UPDATE settings SET key = 'rl_claude_five_hour' WHERE key = 'rl_5hr'`,
		);
		db.run(
			`UPDATE settings SET key = 'rl_claude_weekly' WHERE key = 'rl_weekly'`,
		);
		db.run(
			`UPDATE settings SET key = 'rl_claude_weekly_sonnet' WHERE key = 'rl_weekly_sonnet'`,
		);
	});
}
