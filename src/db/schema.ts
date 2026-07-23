import { resolve } from "node:path";
import { estimateCodexCost } from "../lib/codexPricing";
import { APP_DIR } from "../lib/paths";
import {
	estimateProviderCost,
	hasProviderPricing,
	isSyntheticModel,
} from "../lib/providerPricing";
import { normalizeSearchText } from "../lib/search";

const DB_PATH = resolve(APP_DIR, "hlid.db");

let _initPromise: Promise<import("bun:sqlite").Database> | null = null;

export type Db = import("bun:sqlite").Database;

/**
 * Inject a pre-built in-memory Database for tests.
 * Initializes schema on the provided DB so callers don't need to.
 * Never call this in production code.
 */
export function setDbForTest(db: Db): void {
	initializeSchema(db);
	_initPromise = Promise.resolve(db);
}

/** Apply the current schema/migrations to an explicitly opened database. */
export function initializeSchema(db: Db): void {
	initSchema(db);
}

export function getDb(): Promise<Db> {
	if (!_initPromise) {
		_initPromise = (async () => {
			const { Database } = await import("bun:sqlite");
			const db = new Database(DB_PATH);
			db.run("PRAGMA journal_mode=WAL");
			// Retry for up to 5s when the DB file is locked (e.g. antivirus on Windows)
			db.run("PRAGMA busy_timeout=5000");
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
	createSystemTables(db);
	createSessionTables(db);
	createTelemetryTables(db);
	createAttachmentTables(db);
	migrateAttachmentsDropFk(db);
	applyMigrations(db);
	ensureTranscriptPagingIndexes(db);
}

/**
 * Cursor indexes are ensured after migrations because plan/question tables are
 * migration-owned and the legacy attachment migration can rebuild its table.
 */
function ensureTranscriptPagingIndexes(db: Db): void {
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_messages_session_seq_id ON messages(session_id, seq, id)`,
	);
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_tool_events_session_seq_id ON tool_events(session_id, assistant_seq, id)`,
	);
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_tool_events_session_tool_seq ON tool_events(session_id, tool_id, assistant_seq)`,
	);
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_permission_events_session_ts_id ON permission_events(session_id, timestamp, id)`,
	);
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_plan_proposals_session_seq_id ON plan_proposals(session_id, seq, id)`,
	);
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_ask_user_questions_session_seq_id ON ask_user_questions(session_id, seq, id)`,
	);
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_attachments_session_seq ON attachments(session_id, message_seq)`,
	);
}

function createSystemTables(db: Db): void {
	db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);
	db.run(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      device_label TEXT
    )
  `);
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at)`,
	);
	db.run(`
    CREATE TABLE IF NOT EXISTS env_vars (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);
}

function createSessionTables(db: Db): void {
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
}

function createTelemetryTables(db: Db): void {
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
}

function createAttachmentTables(db: Db): void {
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
}

/** One-off rebuild dropping the old sessions FK from attachments. */
function migrateAttachmentsDropFk(db: Db): void {
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
}

/** Append-only migration ledger; each entry runs once, in order. */
function applyMigrations(db: Db): void {
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

	runMigration(db, "_migrated_attachments_library_metadata", (db) => {
		db.run(`ALTER TABLE attachments ADD COLUMN storage_key TEXT`);
		db.run(
			`ALTER TABLE attachments ADD COLUMN category TEXT NOT NULL DEFAULT 'other'`,
		);
		db.run(
			`ALTER TABLE attachments ADD COLUMN retention TEXT NOT NULL DEFAULT 'session'`,
		);
		db.run(
			`ALTER TABLE attachments ADD COLUMN origin TEXT NOT NULL DEFAULT 'legacy'`,
		);
		db.run(`ALTER TABLE attachments ADD COLUMN agent_cwd TEXT`);
		db.run(
			`CREATE INDEX IF NOT EXISTS idx_attachments_category ON attachments(category)`,
		);
		db.run(
			`CREATE INDEX IF NOT EXISTS idx_attachments_retention ON attachments(retention)`,
		);
	});

	// claude_session_id: the SDK's internal session UUID for `resume`. Captured
	// from the `system/init` event on the first turn of each chat and reused
	// thereafter so the CLI manages conversation history natively (no manual
	// transcript replay). Existing chats migrate with NULL — their next message
	// starts a fresh CLI session, losing model-side context for that one turn.
	runMigration(db, "_migrated_sessions_claude_session_id", (db) => {
		db.run(`ALTER TABLE sessions ADD COLUMN claude_session_id TEXT`);
	});

	runMigration(db, "_migrated_sessions_provider_session", (db) => {
		db.run(
			`ALTER TABLE sessions ADD COLUMN provider_id TEXT NOT NULL DEFAULT 'claude'`,
		);
		db.run(`ALTER TABLE sessions ADD COLUMN provider_session_id TEXT`);
		db.run(
			`UPDATE sessions SET provider_session_id = claude_session_id WHERE claude_session_id IS NOT NULL`,
		);
	});

	// actual_model: the model the CLI actually used (may differ from `model`
	// when an agent's CLAUDE.md frontmatter overrides the vault default).
	runMigration(db, "_migrated_sessions_actual_model", (db) => {
		db.run(`ALTER TABLE sessions ADD COLUMN actual_model TEXT`);
	});

	// selected_model distinguishes model choices persisted by current Hlid from
	// legacy sessions whose `model` column only captured the configured default.
	// Legacy rows remain NULL so restoration can fall back to actual_model.
	runMigration(db, "_migrated_sessions_selected_model", (db) => {
		db.run(`ALTER TABLE sessions ADD COLUMN selected_model TEXT`);
	});

	// Session-scoped Raven controls must survive refreshes and process restarts
	// just like selected_model. NULL keeps legacy rows on configured defaults.
	runMigration(db, "_migrated_sessions_selected_controls", (db) => {
		db.run(`ALTER TABLE sessions ADD COLUMN selected_effort TEXT`);
		db.run(`ALTER TABLE sessions ADD COLUMN selected_permission_mode TEXT`);
	});

	runMigration(db, "_migrated_queries_tokens_in_context", (db) => {
		db.run(`ALTER TABLE queries ADD COLUMN tokens_in_context INTEGER`);
	});

	runMigration(db, "_migrated_messages_recap", (db) => {
		db.run(`ALTER TABLE messages ADD COLUMN recap TEXT`);
	});

	// Correlates a promoted Raven queue entry with its persisted user message.
	// Older transcripts remain NULL and continue using their database row id.
	runMigration(db, "_migrated_messages_turn_id", (db) => {
		db.run(`ALTER TABLE messages ADD COLUMN turn_id TEXT`);
	});

	// Claude's native transcript UUID for the last raw SDK message that fed
	// this row. Lets forkSession() branch precisely at this turn via
	// upToMessageId. NULL for rows written before this column existed, and
	// for user rows (see ForkSessionParams.upToMessageId — assistant only).
	runMigration(db, "_migrated_messages_sdk_uuid", (db) => {
		db.run(`ALTER TABLE messages ADD COLUMN sdk_uuid TEXT`);
	});

	// Codex branches at native turn boundaries rather than raw assistant
	// message UUIDs. Keep the identifiers separate so provider adapters cannot
	// accidentally send one provider's cutoff shape to another.
	runMigration(db, "_migrated_messages_provider_turn_id", (db) => {
		db.run(`ALTER TABLE messages ADD COLUMN provider_turn_id TEXT`);
	});

	// Durable provenance lets Raven and Ledger link an exact fork back to its
	// source even after both provider processes and Hlid itself restart.
	runMigration(db, "_migrated_sessions_fork_provenance", (db) => {
		db.run(`ALTER TABLE sessions ADD COLUMN fork_parent_session_id TEXT`);
		db.run(`ALTER TABLE sessions ADD COLUMN fork_parent_message_id INTEGER`);
		db.run(`ALTER TABLE sessions ADD COLUMN fork_kind TEXT`);
	});

	runMigration(db, "_migrated_tool_events_result", (db) => {
		db.run(`ALTER TABLE tool_events ADD COLUMN result_text TEXT`);
		db.run(`ALTER TABLE tool_events ADD COLUMN is_error INTEGER`);
	});

	runMigration(db, "_migrated_tool_events_subagent", (db) => {
		db.run(`ALTER TABLE tool_events ADD COLUMN subagent_json TEXT`);
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

	// ask_user_questions: persist interactive question prompts so the card
	// survives reload and is visible/answerable from any device that loads the
	// session. answers_json + notes_json stay NULL until the user responds.
	// Mirrors plan_proposals structure (request_id UNIQUE for upsert on retry).
	runMigration(db, "_migrated_ask_user_questions_table", (db) => {
		db.run(`
      CREATE TABLE IF NOT EXISTS ask_user_questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        request_id TEXT NOT NULL UNIQUE,
        seq INTEGER NOT NULL,
        questions_json TEXT NOT NULL,
        answers_json TEXT,
        notes_json TEXT,
        timestamp INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
		db.run(
			`CREATE INDEX IF NOT EXISTS idx_ask_user_questions_session ON ask_user_questions(session_id)`,
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

	// Canonical usage stores uncached input, cache reads, and cache writes as
	// disjoint buckets. OpenAI reports cache reads/writes inside inputTokens,
	// while Claude already reports disjoint values. Normalize existing Codex
	// rows and backfill API-equivalent cost estimates from the session model.
	runMigration(db, "_migrated_canonical_usage_and_estimated_cost", (db) => {
		db.run(
			`ALTER TABLE sessions ADD COLUMN total_estimated_cost REAL DEFAULT 0`,
		);
		db.run(
			`ALTER TABLE sessions ADD COLUMN unpriced_query_count INTEGER DEFAULT 0`,
		);
		db.run(`ALTER TABLE queries ADD COLUMN estimated_cost REAL`);
		db.run(`ALTER TABLE usage_daily ADD COLUMN estimated_cost REAL DEFAULT 0`);
		db.run(
			`ALTER TABLE usage_daily ADD COLUMN unpriced_queries INTEGER DEFAULT 0`,
		);
		db.run(`ALTER TABLE usage_queries ADD COLUMN estimated_cost REAL`);
		db.run(`ALTER TABLE usage_queries ADD COLUMN unpriced INTEGER DEFAULT 0`);

		db.run(`
			UPDATE usage_queries
			SET input_tokens = MAX(0, input_tokens - cache_read_tokens - cache_creation_tokens)
			WHERE provider_id = 'codex'
		`);
		db.run(`
			UPDATE queries
			SET input_tokens = MAX(0, input_tokens - cache_read_tokens - cache_creation_tokens)
			WHERE session_id IN (SELECT id FROM sessions WHERE provider_id = 'codex')
		`);
		db.run(`
			UPDATE queries
			SET tokens_in_context = input_tokens + cache_read_tokens + cache_creation_tokens
			WHERE session_id IN (SELECT id FROM sessions WHERE provider_id = 'codex')
		`);

		type UsageRow = {
			id: number;
			timestamp: number;
			model: string | null;
			input_tokens: number;
			output_tokens: number;
			cache_read_tokens: number;
			cache_creation_tokens: number;
		};
		const rows = db
			.query<UsageRow, []>(`
				SELECT uq.id, uq.timestamp, COALESCE(s.actual_model, s.model) AS model,
				       uq.input_tokens, uq.output_tokens,
				       uq.cache_read_tokens, uq.cache_creation_tokens
				FROM usage_queries uq
				LEFT JOIN sessions s ON s.id = uq.session_id
				WHERE uq.provider_id = 'codex'
			`)
			.all();
		const updateUsage = db.prepare(
			`UPDATE usage_queries SET estimated_cost = ?, unpriced = ? WHERE id = ?`,
		);
		for (const row of rows) {
			const estimate = estimateCodexCost(
				row.model,
				{
					inputTokens: row.input_tokens,
					outputTokens: row.output_tokens,
					cacheReadTokens: row.cache_read_tokens,
					cacheCreationTokens: row.cache_creation_tokens,
				},
				{ webSearchCalls: 0 },
				row.timestamp * 1_000,
			);
			updateUsage.run(estimate, estimate == null ? 1 : 0, row.id);
		}

		const queryRows = db
			.query<UsageRow, []>(`
				SELECT q.id, q.timestamp, COALESCE(s.actual_model, s.model) AS model,
				       q.input_tokens, q.output_tokens,
				       q.cache_read_tokens, q.cache_creation_tokens
				FROM queries q
				JOIN sessions s ON s.id = q.session_id
				WHERE s.provider_id = 'codex'
			`)
			.all();
		const updateQuery = db.prepare(
			`UPDATE queries SET estimated_cost = ? WHERE id = ?`,
		);
		for (const row of queryRows) {
			const estimate = estimateCodexCost(
				row.model,
				{
					inputTokens: row.input_tokens,
					outputTokens: row.output_tokens,
					cacheReadTokens: row.cache_read_tokens,
					cacheCreationTokens: row.cache_creation_tokens,
				},
				{ webSearchCalls: 0 },
				row.timestamp * 1_000,
			);
			updateQuery.run(estimate, row.id);
		}

		db.run(`
			UPDATE sessions SET
				total_input_tokens = COALESCE((SELECT SUM(input_tokens) FROM queries WHERE session_id = sessions.id), 0),
				total_output_tokens = COALESCE((SELECT SUM(output_tokens) FROM queries WHERE session_id = sessions.id), 0),
				total_cache_read_tokens = COALESCE((SELECT SUM(cache_read_tokens) FROM queries WHERE session_id = sessions.id), 0),
				total_cache_creation_tokens = COALESCE((SELECT SUM(cache_creation_tokens) FROM queries WHERE session_id = sessions.id), 0),
				total_estimated_cost = COALESCE((SELECT SUM(estimated_cost) FROM queries WHERE session_id = sessions.id), 0),
				unpriced_query_count = CASE WHEN provider_id = 'codex' THEN
					COALESCE((SELECT SUM(CASE WHEN estimated_cost IS NULL THEN 1 ELSE 0 END) FROM queries WHERE session_id = sessions.id), 0)
				ELSE 0 END
		`);

		// usage_queries is the immutable cross-session ledger, so rebuild daily
		// aggregates from it rather than from deletable session/query rows.
		db.run(`DELETE FROM usage_daily`);
		db.run(`
			INSERT INTO usage_daily
				(date, cost, estimated_cost, unpriced_queries, queries, input_tokens,
				 output_tokens, cache_read_tokens, cache_creation_tokens, turns)
			SELECT DATE(timestamp, 'unixepoch', 'localtime'),
			       COALESCE(SUM(cost), 0), COALESCE(SUM(estimated_cost), 0),
			       COALESCE(SUM(unpriced), 0), COUNT(*),
			       COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
			       COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_creation_tokens), 0),
			       COALESCE(SUM(turns), 0)
			FROM usage_queries
			GROUP BY DATE(timestamp, 'unixepoch', 'localtime')
		`);
	});

	// Claude Code's total_cost_usd is a CLI-reported API-equivalent value. It
	// is not authoritative billing: subscription usage has no per-turn charge,
	// while API gateways can apply pricing the CLI cannot observe. Older HLID
	// versions stored that value as exact cost, so move every historical Claude
	// ledger/query value into the estimated bucket. Exact cost remains reserved
	// for a future provider or gateway billing integration.
	runMigration(db, "_migrated_claude_costs_to_estimates", (db) => {
		db.run(`
			UPDATE usage_queries
			SET estimated_cost = COALESCE(estimated_cost, 0) + cost,
			    cost = 0
			WHERE provider_id = 'claude' AND cost != 0
		`);
		db.run(`
			UPDATE queries
			SET estimated_cost = COALESCE(estimated_cost, 0) + cost,
			    cost = 0
			WHERE session_id IN (SELECT id FROM sessions WHERE provider_id = 'claude')
			  AND cost != 0
		`);
		db.run(`
			UPDATE sessions SET
				total_cost = COALESCE((SELECT SUM(cost) FROM queries WHERE session_id = sessions.id), 0),
				total_estimated_cost = COALESCE((SELECT SUM(estimated_cost) FROM queries WHERE session_id = sessions.id), 0)
			WHERE provider_id = 'claude'
		`);

		// usage_queries survives session deletion and is the authoritative ledger.
		db.run(`DELETE FROM usage_daily`);
		db.run(`
			INSERT INTO usage_daily
				(date, cost, estimated_cost, unpriced_queries, queries, input_tokens,
				 output_tokens, cache_read_tokens, cache_creation_tokens, turns)
			SELECT DATE(timestamp, 'unixepoch', 'localtime'),
			       COALESCE(SUM(cost), 0), COALESCE(SUM(estimated_cost), 0),
			       COALESCE(SUM(unpriced), 0), COUNT(*),
			       COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
			       COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_creation_tokens), 0),
			       COALESCE(SUM(turns), 0)
			FROM usage_queries
			GROUP BY DATE(timestamp, 'unixepoch', 'localtime')
		`);
	});

	// A numeric zero is not enough to prove that a provider reported a free
	// query: it is also the legacy fallback when a provider exposes no pricing.
	// Persist that distinction so every provider (including ACP and imported
	// histories) participates in the same unpriced accounting semantics.
	runMigration(db, "_migrated_query_cost_known_columns", (db) => {
		db.run(
			`ALTER TABLE queries ADD COLUMN cost_known INTEGER NOT NULL DEFAULT 0`,
		);
		db.run(
			`ALTER TABLE usage_queries ADD COLUMN cost_known INTEGER NOT NULL DEFAULT 0`,
		);
	});

	runMigration(db, "_migrated_provider_agnostic_unpriced", (db) => {
		db.run(`
			UPDATE queries
			SET cost_known = CASE
				WHEN estimated_cost IS NOT NULL OR cost != 0 THEN 1 ELSE 0 END
		`);
		db.run(`
			UPDATE usage_queries
			SET cost_known = CASE
				WHEN estimated_cost IS NOT NULL OR cost != 0 THEN 1 ELSE 0 END,
				unpriced = CASE
					WHEN estimated_cost IS NULL AND cost = 0 THEN 1 ELSE 0 END
		`);
		db.run(`
			UPDATE sessions SET
				total_cost = COALESCE((SELECT SUM(cost) FROM queries WHERE session_id = sessions.id), 0),
				total_estimated_cost = COALESCE((SELECT SUM(estimated_cost) FROM queries WHERE session_id = sessions.id), 0),
				unpriced_query_count = COALESCE((
					SELECT SUM(CASE
						WHEN estimated_cost IS NULL AND cost_known = 0 THEN 1 ELSE 0 END)
					FROM queries WHERE session_id = sessions.id
				), 0)
		`);

		// usage_queries is the immutable source for provider/date aggregates.
		db.run(`DELETE FROM usage_daily`);
		db.run(`
			INSERT INTO usage_daily
				(date, cost, estimated_cost, unpriced_queries, queries, input_tokens,
				 output_tokens, cache_read_tokens, cache_creation_tokens, turns)
			SELECT DATE(timestamp, 'unixepoch', 'localtime'),
			       COALESCE(SUM(cost), 0), COALESCE(SUM(estimated_cost), 0),
			       COALESCE(SUM(unpriced), 0), COUNT(*),
			       COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
			       COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_creation_tokens), 0),
			       COALESCE(SUM(turns), 0)
			FROM usage_queries
			GROUP BY DATE(timestamp, 'unixepoch', 'localtime')
		`);
	});

	// Session metadata is mutable: users can switch provider, model, or agent
	// between turns. Snapshot those dimensions on each analytics fact so an old
	// query/tool call is never reassigned to the session's latest configuration.
	runMigration(db, "_migrated_query_analytics_dimensions", (db) => {
		db.run(`ALTER TABLE queries ADD COLUMN provider_id TEXT`);
		db.run(`ALTER TABLE queries ADD COLUMN model TEXT`);
		db.run(`ALTER TABLE queries ADD COLUMN agent_cwd TEXT`);
		db.run(`ALTER TABLE usage_queries ADD COLUMN model TEXT`);
		db.run(`ALTER TABLE usage_queries ADD COLUMN agent_cwd TEXT`);
		db.run(`ALTER TABLE tool_events ADD COLUMN timestamp INTEGER`);
		db.run(`ALTER TABLE tool_events ADD COLUMN provider_id TEXT`);
		db.run(`ALTER TABLE tool_events ADD COLUMN model TEXT`);
		db.run(`ALTER TABLE tool_events ADD COLUMN agent_cwd TEXT`);

		db.run(`
			UPDATE queries
			SET provider_id = COALESCE(
				(SELECT uq.provider_id
				 FROM usage_queries uq
				 WHERE uq.session_id = queries.session_id
				 ORDER BY CASE WHEN uq.timestamp = queries.timestamp THEN 0 ELSE 1 END,
				          ABS(uq.timestamp - queries.timestamp), uq.id
				 LIMIT 1),
				(SELECT s.provider_id FROM sessions s WHERE s.id = queries.session_id),
				'claude'
			),
			model = (SELECT COALESCE(NULLIF(s.actual_model, ''),
			                             NULLIF(s.selected_model, ''),
			                             NULLIF(s.model, ''))
			         FROM sessions s WHERE s.id = queries.session_id),
			agent_cwd = (SELECT s.agent_cwd FROM sessions s WHERE s.id = queries.session_id)
		`);
		db.run(`
			UPDATE usage_queries
			SET model = (SELECT COALESCE(NULLIF(s.actual_model, ''),
			                             NULLIF(s.selected_model, ''),
			                             NULLIF(s.model, ''))
			             FROM sessions s WHERE s.id = usage_queries.session_id),
			    agent_cwd = (SELECT s.agent_cwd FROM sessions s WHERE s.id = usage_queries.session_id)
		`);
		db.run(`
			UPDATE tool_events
			SET timestamp = COALESCE(
				(SELECT MIN(m.timestamp) FROM messages m
				 WHERE m.session_id = tool_events.session_id
				   AND m.seq = tool_events.assistant_seq
				   AND m.role = 'assistant'),
				(SELECT s.started_at FROM sessions s WHERE s.id = tool_events.session_id)
			),
			provider_id = COALESCE(
				(SELECT s.provider_id FROM sessions s WHERE s.id = tool_events.session_id),
				'claude'
			),
			model = (SELECT COALESCE(NULLIF(s.actual_model, ''),
			                             NULLIF(s.selected_model, ''),
			                             NULLIF(s.model, ''))
			         FROM sessions s WHERE s.id = tool_events.session_id),
			agent_cwd = (SELECT s.agent_cwd FROM sessions s WHERE s.id = tool_events.session_id)
		`);

		db.run(`CREATE INDEX idx_queries_analytics_dimensions
		        ON queries(timestamp, provider_id, model, agent_cwd)`);
		db.run(`CREATE INDEX idx_usage_queries_analytics_dimensions
		        ON usage_queries(timestamp, provider_id, model, agent_cwd)`);
		db.run(`CREATE INDEX idx_tool_events_analytics_dimensions
		        ON tool_events(timestamp, provider_id, model, agent_cwd)`);
	});

	// Provider history started as usage-only Ledger data. Newer imports retain
	// this marker while explicit resume metadata distinguishes resumable rows.
	runMigration(db, "_migrated_sessions_history_imported", (db) => {
		db.run(
			`ALTER TABLE sessions ADD COLUMN history_imported INTEGER NOT NULL DEFAULT 0`,
		);
	});
	runMigration(db, "_migrated_history_import_provenance", (db) => {
		db.run(`
			CREATE TABLE IF NOT EXISTS history_import_items (
				provider_id TEXT NOT NULL,
				source_kind TEXT NOT NULL,
				source_id TEXT NOT NULL,
				source_hash TEXT NOT NULL,
				imported_session_id TEXT NOT NULL,
				imported_query_id INTEGER,
				imported_usage_query_id INTEGER,
				imported_at INTEGER NOT NULL DEFAULT (unixepoch()),
				PRIMARY KEY (provider_id, source_kind, source_id)
			)
		`);
		db.run(
			`CREATE INDEX IF NOT EXISTS idx_history_import_session
			 ON history_import_items(imported_session_id)`,
		);
	});
	runMigration(db, "_migrated_sessions_history_source", (db) => {
		db.run(`ALTER TABLE sessions ADD COLUMN history_source TEXT`);
	});
	runMigration(db, "_migrated_sessions_history_source_backfill", (db) => {
		db.run(`
			UPDATE sessions
			SET history_source = CASE provider_id
				WHEN 'claude' THEN 'claude-cli'
				WHEN 'codex' THEN 'codex-cli'
				ELSE history_source
			END
			WHERE history_imported = 1 AND history_source IS NULL
		`);
	});
	runMigration(db, "_migrated_provider_history_resume", (db) => {
		db.run(
			`ALTER TABLE sessions ADD COLUMN history_resume_mode TEXT NOT NULL DEFAULT 'none'`,
		);
		db.run(`ALTER TABLE sessions ADD COLUMN history_resume_path TEXT`);
		db.run(`
			CREATE TABLE IF NOT EXISTS provider_history_transcripts (
				provider_id TEXT NOT NULL,
				native_session_id TEXT NOT NULL,
				subpath TEXT NOT NULL DEFAULT '',
				source_path TEXT NOT NULL,
				source_hash TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				entry_count INTEGER NOT NULL,
				updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
				PRIMARY KEY (provider_id, native_session_id, subpath)
			)
		`);
		db.run(
			`CREATE INDEX IF NOT EXISTS idx_provider_history_transcript_session
			 ON provider_history_transcripts(provider_id, native_session_id)`,
		);
	});
	runMigration(db, "_migrated_codex_history_source_classification", (db) => {
		db.run(`
			UPDATE sessions
			SET history_source = CASE
				WHEN label LIKE 'Imported Codex Codex Desktop %' THEN 'codex-desktop'
				WHEN label LIKE 'Imported Codex codex_vscode %' THEN 'codex-desktop'
				WHEN label LIKE 'Imported Codex t3code_desktop %' THEN 'codex-desktop'
				WHEN label LIKE 'Imported Codex codex-tui %' THEN 'codex-cli'
				WHEN label LIKE 'Imported Codex codex_cli_rs %' THEN 'codex-cli'
				ELSE history_source
			END
			WHERE history_imported = 1 AND provider_id = 'codex'
		`);
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

	// html_attachment_id: links a plan proposal to the ingested HTML plan relic
	// (attachments row) so the modal viewer survives reload. NULL for markdown-only
	// proposals.
	runMigration(db, "_migrated_plan_proposals_html_attachment", (db) => {
		db.run(`ALTER TABLE plan_proposals ADD COLUMN html_attachment_id TEXT`);
	});

	// SQLite's built-in NOCASE/LIKE only folds ASCII. Keep internal normalized
	// indexes so paginated searches match labels and filenames with diacritics.
	runMigration(db, "_migrated_normalized_search_indexes", (db) => {
		db.run(`
			CREATE TABLE session_search (
				session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
				text TEXT NOT NULL
			)
		`);
		db.run(`
			CREATE TABLE attachment_search (
				attachment_id TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
				text TEXT NOT NULL
			)
		`);

		const insertSession = db.prepare(
			`INSERT INTO session_search (session_id, text) VALUES (?, ?)`,
		);
		for (const row of db
			.query<{ id: string; label: string | null }, []>(
				`SELECT id, label FROM sessions`,
			)
			.all()) {
			insertSession.run(row.id, normalizeSearchText(row.label ?? ""));
		}

		const insertAttachment = db.prepare(
			`INSERT INTO attachment_search (attachment_id, text) VALUES (?, ?)`,
		);
		for (const row of db
			.query<{ id: string; filename: string }, []>(
				`SELECT id, filename FROM attachments`,
			)
			.all()) {
			insertAttachment.run(row.id, normalizeSearchText(row.filename));
		}
	});

	// Providers do not always emit a per-query cost (notably imported history),
	// but their public token rates are still enough for an API-equivalent
	// estimate. Reprice the immutable ledger and the deletable session mirror.
	// Synthetic model markers are repaired only when the owning session retains
	// a concrete configured model; orphaned/ambiguous rows remain unpriced.
	runMigration(db, "_migrated_provider_pricing_fallback_v1", (db) => {
		type PricingRow = {
			id: number;
			provider_id: string;
			model: string | null;
			selected_model: string | null;
			actual_model: string | null;
			session_model: string | null;
			timestamp: number;
			cost: number;
			cost_known: number;
			estimated_cost: number | null;
			input_tokens: number;
			output_tokens: number;
			cache_read_tokens: number;
			cache_creation_tokens: number;
		};

		const concreteModel = (model: string | null): string | null => {
			const value = model?.trim();
			return value && !isSyntheticModel(value) ? value : null;
		};
		const resolveModel = (row: PricingRow): string | null => {
			const recorded = concreteModel(row.model);
			if (recorded) return recorded;
			const sessionModel =
				concreteModel(row.selected_model) ??
				concreteModel(row.actual_model) ??
				concreteModel(row.session_model);
			return hasProviderPricing(
				row.provider_id,
				sessionModel,
				row.timestamp * 1_000,
			)
				? sessionModel
				: null;
		};

		for (const session of db
			.query<
				{
					id: string;
					provider_id: string;
					actual_model: string | null;
					selected_model: string | null;
					model: string | null;
				},
				[]
			>(
				`SELECT id, provider_id, actual_model, selected_model, model
				 FROM sessions WHERE LOWER(TRIM(COALESCE(actual_model, ''))) = '<synthetic>'`,
			)
			.all()) {
			const replacement =
				concreteModel(session.selected_model) ?? concreteModel(session.model);
			if (hasProviderPricing(session.provider_id, replacement)) {
				db.run(`UPDATE sessions SET actual_model = ? WHERE id = ?`, [
					replacement,
					session.id,
				]);
			}
		}

		const repairTable = (table: "queries" | "usage_queries"): void => {
			const providerExpression =
				table === "queries"
					? "COALESCE(t.provider_id, s.provider_id, 'claude')"
					: "t.provider_id";
			const rows = db
				.query<PricingRow, []>(`
					SELECT t.id, ${providerExpression} AS provider_id, t.model,
					       s.selected_model, s.actual_model, s.model AS session_model,
					       t.timestamp, t.cost, t.cost_known, t.estimated_cost,
					       t.input_tokens, t.output_tokens,
					       t.cache_read_tokens, t.cache_creation_tokens
					FROM ${table} t
					LEFT JOIN sessions s ON s.id = t.session_id
					WHERE LOWER(TRIM(COALESCE(t.model, ''))) = '<synthetic>'
					   OR (t.estimated_cost IS NULL AND t.cost = 0 AND t.cost_known = 0)
				`)
				.all();
			for (const row of rows) {
				const model = resolveModel(row);
				if (!model) continue;
				const shouldEstimate =
					row.estimated_cost == null && row.cost === 0 && row.cost_known === 0;
				const estimate = shouldEstimate
					? estimateProviderCost(
							row.provider_id,
							model,
							{
								inputTokens: row.input_tokens,
								outputTokens: row.output_tokens,
								cacheReadTokens: row.cache_read_tokens,
								cacheCreationTokens: row.cache_creation_tokens,
							},
							row.timestamp * 1_000,
						)
					: row.estimated_cost;
				if (estimate == null) {
					if (model !== row.model) {
						db.run(`UPDATE ${table} SET model = ? WHERE id = ?`, [
							model,
							row.id,
						]);
					}
					continue;
				}
				if (table === "usage_queries") {
					db.run(
						`UPDATE usage_queries
						 SET model = ?, estimated_cost = ?, cost_known = 1, unpriced = 0
						 WHERE id = ?`,
						[model, estimate, row.id],
					);
				} else {
					db.run(
						`UPDATE queries
						 SET model = ?, estimated_cost = ?, cost_known = 1
						 WHERE id = ?`,
						[model, estimate, row.id],
					);
				}
			}
		};

		repairTable("queries");
		repairTable("usage_queries");

		db.run(`
			UPDATE sessions SET
				total_estimated_cost = COALESCE((
					SELECT SUM(estimated_cost) FROM queries WHERE session_id = sessions.id
				), 0),
				unpriced_query_count = COALESCE((
					SELECT SUM(CASE
						WHEN estimated_cost IS NULL AND cost_known = 0 THEN 1 ELSE 0 END)
					FROM queries WHERE session_id = sessions.id
				), 0)
		`);

		db.run(`DELETE FROM usage_daily`);
		db.run(`
			INSERT INTO usage_daily
				(date, cost, estimated_cost, unpriced_queries, queries, input_tokens,
				 output_tokens, cache_read_tokens, cache_creation_tokens, turns)
			SELECT DATE(timestamp, 'unixepoch', 'localtime'),
			       COALESCE(SUM(cost), 0), COALESCE(SUM(estimated_cost), 0),
			       COALESCE(SUM(unpriced), 0), COUNT(*),
			       COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
			       COALESCE(SUM(cache_read_tokens), 0),
			       COALESCE(SUM(cache_creation_tokens), 0), COALESCE(SUM(turns), 0)
			FROM usage_queries
			GROUP BY DATE(timestamp, 'unixepoch', 'localtime')
		`);
	});

	runMigration(db, "_migrated_sessions_pinned", (db) => {
		db.run(`ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
		db.run(
			`CREATE INDEX idx_sessions_pinned_recent
			 ON sessions(pinned DESC, ended_at DESC, started_at DESC)`,
		);
	});

	runMigration(db, "_migrated_sessions_archived_at", (db) => {
		db.run(`ALTER TABLE sessions ADD COLUMN archived_at INTEGER`);
		db.run(
			`CREATE INDEX idx_sessions_archived_recent
			 ON sessions(archived_at, pinned DESC, ended_at DESC, started_at DESC)`,
		);
	});

	runMigration(db, "_migrated_routines_v1", (db) => {
		db.run(`
			CREATE TABLE routines (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				prompt TEXT NOT NULL,
				enabled INTEGER NOT NULL DEFAULT 0,
				archived INTEGER NOT NULL DEFAULT 0,
				revision INTEGER NOT NULL DEFAULT 1,
				schedule_json TEXT NOT NULL,
				timezone TEXT NOT NULL,
				next_run_at INTEGER,
				provider_id TEXT NOT NULL,
				model TEXT NOT NULL DEFAULT '',
				effort TEXT NOT NULL DEFAULT '',
				agent_cwd TEXT NOT NULL,
				agent_name TEXT NOT NULL,
				skill_contexts_json TEXT NOT NULL DEFAULT '[]',
				vault_references_json TEXT NOT NULL DEFAULT '[]',
				relic_ids_json TEXT NOT NULL DEFAULT '[]',
				permission_mode TEXT NOT NULL DEFAULT 'preapproved',
				deliveries_json TEXT NOT NULL DEFAULT '[]',
				catch_up_window_minutes INTEGER NOT NULL DEFAULT 360,
				no_overlap INTEGER NOT NULL DEFAULT 1,
				paused_reason TEXT,
				authorization_fingerprint TEXT NOT NULL,
				created_at INTEGER NOT NULL DEFAULT (unixepoch()),
				updated_at INTEGER NOT NULL DEFAULT (unixepoch())
			)
		`);
		db.run(
			`CREATE INDEX idx_routines_due ON routines(enabled, archived, next_run_at)`,
		);
		db.run(`
			CREATE TABLE routine_permission_profiles (
				id TEXT PRIMARY KEY,
				routine_id TEXT NOT NULL REFERENCES routines(id),
				revision INTEGER NOT NULL,
				authorization_fingerprint TEXT NOT NULL,
				mode TEXT NOT NULL,
				reviewed_at INTEGER NOT NULL DEFAULT (unixepoch()),
				expires_at INTEGER,
				revoked_at INTEGER,
				UNIQUE(routine_id, revision)
			)
		`);
		db.run(`
			CREATE TABLE routine_permission_grants (
				id TEXT PRIMARY KEY,
				profile_id TEXT NOT NULL REFERENCES routine_permission_profiles(id),
				capability TEXT NOT NULL,
				tool TEXT,
				constraints_json TEXT NOT NULL DEFAULT '{}',
				matcher_version INTEGER NOT NULL DEFAULT 1,
				max_uses_per_run INTEGER,
				expires_at INTEGER,
				revoked_at INTEGER,
				created_at INTEGER NOT NULL DEFAULT (unixepoch())
			)
		`);
		db.run(
			`CREATE INDEX idx_routine_grants_profile ON routine_permission_grants(profile_id)`,
		);
		db.run(`
			CREATE TABLE routine_runs (
				id TEXT PRIMARY KEY,
				routine_id TEXT NOT NULL REFERENCES routines(id),
				routine_revision INTEGER NOT NULL,
				profile_id TEXT,
				authorization_fingerprint TEXT NOT NULL,
				trigger TEXT NOT NULL,
				scheduled_for INTEGER NOT NULL,
				claimed_at INTEGER,
				lease_owner TEXT,
				lease_expires_at INTEGER,
				started_at INTEGER,
				finished_at INTEGER,
				status TEXT NOT NULL,
				session_id TEXT,
				provider_used TEXT,
				error TEXT,
				action_required TEXT,
				delivery_json TEXT,
				created_at INTEGER NOT NULL DEFAULT (unixepoch()),
				UNIQUE(routine_id, scheduled_for, trigger)
			)
		`);
		db.run(
			`CREATE INDEX idx_routine_runs_status_lease ON routine_runs(status, lease_expires_at)`,
		);
		db.run(
			`CREATE INDEX idx_routine_runs_history ON routine_runs(routine_id, scheduled_for DESC)`,
		);
		db.run(`
			CREATE TABLE routine_grant_uses (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				run_id TEXT NOT NULL REFERENCES routine_runs(id),
				grant_id TEXT NOT NULL,
				tool_use_id TEXT NOT NULL,
				capability TEXT NOT NULL,
				request_json TEXT NOT NULL,
				input_digest TEXT NOT NULL,
				umbod_decision TEXT,
				decision TEXT NOT NULL,
				timestamp INTEGER NOT NULL DEFAULT (unixepoch())
			)
		`);
		db.run(
			`CREATE INDEX idx_routine_grant_uses_run ON routine_grant_uses(run_id, timestamp)`,
		);
	});

	runMigration(db, "_migrated_routines_provider_commands", (db) => {
		db.run(
			`ALTER TABLE routines ADD COLUMN provider_commands_json TEXT NOT NULL DEFAULT '[]'`,
		);
	});

	// Ledger analytics should read the immutable usage ledger for every split,
	// but stop_reason previously lived only on queries — which cascade-delete
	// with their session — so the stop-reason chart silently dropped deleted
	// sessions while the cost tiles kept them. Copy stop_reason onto
	// usage_queries, pairing rows by per-session insert order (both tables are
	// written in the same recordQuery transaction, so ranks always align).
	runMigration(db, "_migrated_usage_queries_stop_reason", (db) => {
		db.run(`ALTER TABLE usage_queries ADD COLUMN stop_reason TEXT`);
		db.run(`
			WITH ranked_q AS (
				SELECT session_id, stop_reason,
				       ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY id) AS rn
				FROM queries
			), ranked_uq AS (
				SELECT id, session_id,
				       ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY id) AS rn
				FROM usage_queries
			)
			UPDATE usage_queries
			SET stop_reason = (
				SELECT ranked_q.stop_reason
				FROM ranked_uq JOIN ranked_q
					ON ranked_q.session_id = ranked_uq.session_id
					AND ranked_q.rn = ranked_uq.rn
				WHERE ranked_uq.id = usage_queries.id
			)
		`);
	});
}
