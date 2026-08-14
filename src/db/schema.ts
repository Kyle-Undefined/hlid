import { resolve } from "node:path";
import { estimateCodexCost } from "../lib/codexPricing";
import {
	HLID_DELEGATION_MAX_ERROR_CHARS,
	HLID_DELEGATION_MAX_RESULT_CHARS,
} from "../lib/hlidDelegation";
import { APP_DIR } from "../lib/paths";
import {
	estimateProviderCost,
	hasProviderPricing,
	isSyntheticModel,
} from "../lib/providerPricing";
import { normalizeSearchText } from "../lib/search";
import { repairClaudeCumulativeCosts } from "./claudeCumulativeCostRepair";
import {
	CODEX_TERRA_LUNA_PRICING_MIGRATION,
	repairCodexPricingCutover,
} from "./codexPricingCutoverRepair";

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

function normalizedMigratedPushDeviceName(value: string): string {
	const cleaned = Array.from(value, (character) => {
		const code = character.charCodeAt(0);
		return code <= 31 || code === 127 ? " " : character;
	})
		.join("")
		.replace(/\s+/g, " ")
		.trim();
	return (cleaned || "Subscribed device").slice(0, 80);
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
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_permission_events_session_tool ON permission_events(session_id, tool_id)`,
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

	// Provider-native continuity is valid only for the exact executable/config
	// identity that created or imported it. Store only the provider's opaque
	// digest, never its raw executable, arguments, or environment. Legacy rows
	// remain NULL and callers can conservatively start a fresh native session.
	runMigration(db, "_migrated_sessions_provider_runtime_identity_v1", (db) => {
		db.run(`ALTER TABLE sessions ADD COLUMN provider_runtime_identity TEXT`);
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

	// Codex's native approval reviewer is another session-scoped Raven control.
	// Keep it in a separate migration so existing databases that already applied
	// selected_controls still gain the column without rewriting migration state.
	runMigration(db, "_migrated_sessions_approvals_reviewer", (db) => {
		db.run(`ALTER TABLE sessions ADD COLUMN selected_approvals_reviewer TEXT`);
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

	// Claude's file checkpoint for a root user turn. This is an opaque,
	// same-native-session identifier and is intentionally not copied to forks.
	runMigration(db, "_migrated_messages_checkpoint_uuid", (db) => {
		db.run(`ALTER TABLE messages ADD COLUMN checkpoint_uuid TEXT`);
		db.run(
			`ALTER TABLE messages ADD COLUMN checkpoint_provider_session_id TEXT`,
		);
	});

	// A queued Raven prompt can be folded into an assistant response that
	// already has a transcript row. Retain that relationship so reloads and
	// provider handoffs keep the steering prompt before the response it changed.
	runMigration(db, "_migrated_messages_steer_target_seq", (db) => {
		db.run(`ALTER TABLE messages ADD COLUMN steer_target_seq INTEGER`);
	});

	// Raw assistant tool-event count when a queued prompt was accepted into the
	// active provider turn. Raven uses this durable boundary to keep tool calls
	// emitted before and after the steer on their original sides after reload.
	runMigration(db, "_migrated_messages_steer_tool_event_index", (db) => {
		db.run(`ALTER TABLE messages ADD COLUMN steer_tool_event_index INTEGER`);
	});

	// Hlid-owned provenance for the prompt context assembled around a user turn.
	// This stays outside the visible transcript and provider token accounting.
	runMigration(db, "_migrated_messages_context_manifest", (db) => {
		db.run(`ALTER TABLE messages ADD COLUMN context_manifest_json TEXT`);
	});

	// Associate a completed assistant transcript row with the query that owns
	// its durable usage. History can then render the same cost as the live done
	// event while keeping Ledger repricing and repair authoritative. Legacy rows
	// stay unlinked because recap, import, fork, and cancellation paths make an
	// ordinal message-to-query backfill unsafe.
	runMigration(db, "_migrated_messages_query_id", (db) => {
		db.run(`ALTER TABLE messages ADD COLUMN query_id INTEGER`);
	});

	// Provider-native realtime turns are mirrored into Raven without replaying
	// them to the provider. Keep their transport provenance and unsupported
	// fork boundary on the visible row so hydration stays honest. A NULL query_id
	// remains the accounting truth for these provider speech-to-speech turns.
	runMigration(db, "_migrated_messages_realtime_provenance_v1", (db) => {
		db.run(`ALTER TABLE messages ADD COLUMN source TEXT`);
		db.run(`ALTER TABLE messages ADD COLUMN utterance_id TEXT`);
		db.run(`ALTER TABLE messages ADD COLUMN realtime_session_id TEXT`);
		db.run(`ALTER TABLE messages ADD COLUMN provider_realtime_session_id TEXT`);
		db.run(`ALTER TABLE messages ADD COLUMN fork_supported INTEGER`);
		db.run(
			`CREATE UNIQUE INDEX idx_messages_session_utterance_id
			 ON messages(session_id, utterance_id)
			 WHERE utterance_id IS NOT NULL`,
		);
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

	runMigration(db, "_migrated_tool_events_activity", (db) => {
		db.run(`ALTER TABLE tool_events ADD COLUMN activity_json TEXT`);
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
	runMigration(db, "_migrated_ask_user_question_provenance", (db) => {
		const columns = db
			.query<{ name: string }, []>("PRAGMA table_info(ask_user_questions)")
			.all();
		if (!columns.some((column) => column.name === "provenance_json")) {
			db.run("ALTER TABLE ask_user_questions ADD COLUMN provenance_json TEXT");
		}
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
	runMigration(db, "_migrated_provider_history_transcript_deltas_v1", (db) => {
		db.run(`
			CREATE TABLE IF NOT EXISTS provider_history_transcript_deltas (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider_id TEXT NOT NULL,
				native_session_id TEXT NOT NULL,
				subpath TEXT NOT NULL DEFAULT '',
				uuid TEXT,
				payload_json TEXT NOT NULL,
				appended_at INTEGER NOT NULL DEFAULT (unixepoch()),
				FOREIGN KEY (provider_id, native_session_id, subpath)
					REFERENCES provider_history_transcripts(
						provider_id, native_session_id, subpath
					)
					ON DELETE CASCADE
			)
		`);
		db.run(`
			CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_history_delta_uuid
			ON provider_history_transcript_deltas(
				provider_id, native_session_id, subpath, uuid
			)
			WHERE uuid IS NOT NULL
		`);
		db.run(`
			CREATE INDEX IF NOT EXISTS idx_provider_history_delta_order
			ON provider_history_transcript_deltas(
				provider_id, native_session_id, subpath, id
			)
		`);
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

	// Notification choices do not widen a Routine's unattended authority. Keep
	// them on the mutable definition row, outside immutable permission profiles,
	// with an explicit legacy-safe default that follows each target device.
	runMigration(db, "_migrated_routines_notification_policy_v1", (db) => {
		db.run(`
			ALTER TABLE routines ADD COLUMN notification_policy_json TEXT NOT NULL
			DEFAULT '{"success":"default","actionRequired":"default","failure":"default","targets":{"kind":"all"}}'
		`);
	});

	// A completed run must retain the notification policy that was active when
	// it was claimed; recovery must not consult a later mutable Routine edit.
	runMigration(db, "_migrated_routine_run_notification_policy_v1", (db) => {
		db.run(`
			ALTER TABLE routine_runs ADD COLUMN notification_policy_json TEXT NOT NULL
			DEFAULT '{"success":"default","actionRequired":"default","failure":"default","targets":{"kind":"all"}}'
		`);
	});

	// Finishing a Routine run and recording its durable push intent are separate
	// commits. Keep a compact acknowledgement keyed by run ID so startup can
	// recover terminal outcomes after a crash without changing the run row.
	runMigration(db, "_migrated_routine_run_notification_records_v1", (db) => {
		db.run(`
			CREATE TABLE IF NOT EXISTS routine_run_notification_records (
				run_id TEXT PRIMARY KEY
					REFERENCES routine_runs(id) ON DELETE CASCADE,
				event_id TEXT
					CHECK(event_id IS NULL OR length(event_id) BETWEEN 1 AND 64),
				recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0)
			)
		`);
		db.run(`
			CREATE INDEX IF NOT EXISTS idx_routine_runs_notification_recovery
			ON routine_runs(finished_at, created_at, id)
			WHERE finished_at IS NOT NULL AND status IN (
				'succeeded', 'action_required', 'failed',
				'delivery_error', 'provider_unavailable'
			)
		`);
	});

	// Restart interruption is also a terminal failure outcome. Rebuild the
	// partial recovery index for databases that already applied the v1 ledger.
	runMigration(
		db,
		"_migrated_routine_run_notification_interrupted_v2",
		(db) => {
			db.run(`DROP INDEX IF EXISTS idx_routine_runs_notification_recovery`);
			db.run(`
				CREATE INDEX idx_routine_runs_notification_recovery
				ON routine_runs(finished_at, created_at, id)
				WHERE finished_at IS NOT NULL AND status IN (
					'succeeded', 'action_required', 'failed',
					'delivery_error', 'provider_unavailable', 'interrupted'
				)
			`);
		},
	);

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

	runMigration(db, "_migrated_project_previews_v1", (db) => {
		db.run(`
			CREATE TABLE project_previews (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				label TEXT NOT NULL,
				command TEXT NOT NULL,
				cwd TEXT NOT NULL,
				port INTEGER NOT NULL,
				path TEXT NOT NULL,
				url TEXT NOT NULL,
				relay_url TEXT NOT NULL,
				state TEXT NOT NULL,
				present INTEGER NOT NULL DEFAULT 1,
				started_at TEXT NOT NULL,
				expires_at TEXT NOT NULL,
				ended_at TEXT,
				exit_code INTEGER,
				error TEXT,
				stop_reason TEXT,
				logs_json TEXT NOT NULL DEFAULT '[]',
				updated_at INTEGER NOT NULL DEFAULT (unixepoch())
			)
		`);
		db.run(
			`CREATE INDEX idx_project_previews_session_started
			 ON project_previews(session_id, started_at DESC)`,
		);
		db.run(
			`CREATE INDEX idx_project_previews_state_expiry
			 ON project_previews(state, expires_at)`,
		);
	});

	runMigration(db, "_migrated_project_preview_feedback_v1", (db) => {
		db.run(`
			CREATE TABLE project_preview_feedback (
				attachment_id TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
				preview_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				source_frame_id TEXT NOT NULL,
				path TEXT NOT NULL,
				viewport TEXT NOT NULL CHECK(viewport IN ('desktop', 'tablet', 'mobile')),
				width INTEGER NOT NULL,
				height INTEGER NOT NULL,
				source_sha256 TEXT NOT NULL,
				captured_at INTEGER NOT NULL,
				comment TEXT,
				created_at INTEGER NOT NULL DEFAULT (unixepoch())
			)
		`);
		db.run(
			`CREATE INDEX idx_project_preview_feedback_session_created
			 ON project_preview_feedback(session_id, created_at DESC)`,
		);
	});

	// Hlid-owned cross-harness delegation creates an ordinary child Raven
	// session while retaining lifecycle and bounded-result provenance outside
	// either provider transcript. Parent IDs intentionally have no foreign key:
	// deleting a parent must not erase the child's origin record.
	runMigration(db, "_migrated_session_delegations_v1", (db) => {
		db.run(`
			CREATE TABLE session_delegations (
				id TEXT PRIMARY KEY,
				parent_session_id TEXT NOT NULL,
				parent_turn_id TEXT,
				parent_label TEXT,
				child_session_id TEXT NOT NULL UNIQUE,
				depth INTEGER NOT NULL CHECK(depth >= 1),
				task TEXT NOT NULL,
				target_provider_id TEXT NOT NULL,
				selected_model TEXT,
				selected_effort TEXT,
				selected_permission_mode TEXT NOT NULL,
				timeout_seconds INTEGER NOT NULL,
				status TEXT NOT NULL CHECK(status IN (
					'pending', 'running', 'completed', 'failed',
					'timed_out', 'interrupted'
				)),
				started_at INTEGER NOT NULL DEFAULT (unixepoch()),
				ended_at INTEGER,
				result_text TEXT,
				error TEXT
			)
		`);
		db.run(
			`CREATE INDEX idx_session_delegations_parent_started
			 ON session_delegations(parent_session_id, started_at DESC)`,
		);
		db.run(
			`CREATE INDEX idx_session_delegations_status
			 ON session_delegations(status)`,
		);
	});

	// Complete the durable orchestration lifecycle without changing the v1
	// migration that may already exist in user databases. SQLite cannot widen
	// a CHECK constraint in place, so rebuild the bounded table and preserve
	// every first-slice row with conservative defaults.
	runMigration(db, "_migrated_session_delegations_v2", (db) => {
		db.run(
			`ALTER TABLE session_delegations
			 RENAME TO session_delegations_v1`,
		);
		db.run(`
			CREATE TABLE session_delegations (
				id TEXT PRIMARY KEY,
				parent_session_id TEXT NOT NULL,
				parent_turn_id TEXT,
				parent_label TEXT,
				parent_delegation_id TEXT,
				child_session_id TEXT NOT NULL UNIQUE,
				depth INTEGER NOT NULL CHECK(depth BETWEEN 1 AND 3),
				task TEXT NOT NULL,
				target_provider_id TEXT NOT NULL,
				selected_model TEXT,
				selected_effort TEXT,
				selected_permission_mode TEXT NOT NULL,
				timeout_seconds INTEGER NOT NULL,
				token_budget INTEGER CHECK(token_budget IS NULL OR token_budget > 0),
				tokens_used INTEGER NOT NULL DEFAULT 0 CHECK(tokens_used >= 0),
				attempt_count INTEGER NOT NULL DEFAULT 1 CHECK(attempt_count BETWEEN 1 AND 3),
				continuation_mode TEXT NOT NULL DEFAULT 'initial' CHECK(
					continuation_mode IN ('initial', 'explicit_new_turn')
				),
				handoff_json TEXT NOT NULL DEFAULT '{}',
				status TEXT NOT NULL CHECK(status IN (
					'pending', 'running', 'completed', 'failed',
					'timed_out', 'interrupted', 'cancelled',
					'budget_exhausted'
				)),
				started_at INTEGER NOT NULL DEFAULT (unixepoch()),
				updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
				ended_at INTEGER,
				result_text TEXT,
				error TEXT
			)
		`);
		db.run(`
			INSERT INTO session_delegations (
				id, parent_session_id, parent_turn_id, parent_label,
				parent_delegation_id, child_session_id, depth, task,
				target_provider_id, selected_model, selected_effort,
				selected_permission_mode, timeout_seconds, token_budget,
				tokens_used, attempt_count, continuation_mode, handoff_json,
				status, started_at, updated_at, ended_at, result_text, error
			)
			SELECT
				id, parent_session_id, parent_turn_id, parent_label,
				NULL, child_session_id, MIN(depth, 3), task,
				target_provider_id, selected_model, selected_effort,
				selected_permission_mode, timeout_seconds, NULL,
				0, 1, 'initial', '{}',
				status, started_at, COALESCE(ended_at, started_at),
				ended_at,
				CASE
					WHEN result_text IS NULL OR result_text = '' THEN NULL
					WHEN length(result_text) <= ${HLID_DELEGATION_MAX_RESULT_CHARS}
						THEN result_text
					ELSE substr(result_text, 1, ${HLID_DELEGATION_MAX_RESULT_CHARS - 1}) || '…'
				END,
				CASE
					WHEN error IS NULL OR error = '' THEN NULL
					WHEN length(error) <= ${HLID_DELEGATION_MAX_ERROR_CHARS}
						THEN error
					ELSE substr(error, 1, ${HLID_DELEGATION_MAX_ERROR_CHARS - 1}) || '…'
				END
			FROM session_delegations_v1
		`);
		db.run(`DROP TABLE session_delegations_v1`);
		db.run(
			`CREATE INDEX idx_session_delegations_parent_started
			 ON session_delegations(parent_session_id, started_at DESC)`,
		);
		db.run(
			`CREATE INDEX idx_session_delegations_status
			 ON session_delegations(status)`,
		);
		db.run(
			`CREATE INDEX idx_session_delegations_parent_delegation
			 ON session_delegations(parent_delegation_id, started_at)`,
		);
	});

	// Retain one bounded current-step summary for the parent progress card.
	// Detailed provider activity remains in the ordinary child Raven session.
	runMigration(db, "_migrated_session_delegations_v3", (db) => {
		db.run(
			`ALTER TABLE session_delegations
			 ADD COLUMN progress_text TEXT`,
		);
	});

	// Persist the full validated execution selection and both bounded usage
	// dimensions. Existing rows inherit their ordinary child session workspace.
	runMigration(db, "_migrated_session_delegations_v4", (db) => {
		db.run(
			`ALTER TABLE session_delegations
			 ADD COLUMN selected_service_tier TEXT`,
		);
		db.run(
			`ALTER TABLE session_delegations
			 ADD COLUMN selected_workspace TEXT NOT NULL DEFAULT ''`,
		);
		db.run(
			`UPDATE session_delegations
			 SET selected_workspace = COALESCE((
			   SELECT child.agent_cwd
			   FROM sessions child
			   WHERE child.id = session_delegations.child_session_id
			 ), '')`,
		);
		db.run(
			`ALTER TABLE session_delegations
			 ADD COLUMN cost_budget REAL CHECK(
			   cost_budget IS NULL OR cost_budget > 0
			 )`,
		);
		db.run(
			`ALTER TABLE session_delegations
			 ADD COLUMN cost_used REAL NOT NULL DEFAULT 0 CHECK(cost_used >= 0)`,
		);
	});

	// A detached Routine child remains owned by the immutable Routine run after
	// the parent provider turn ends. The run id is also the fail-closed boundary
	// that prevents an interrupted child from being resumed without its grants.
	runMigration(db, "_migrated_session_delegations_v5", (db) => {
		db.run(
			`ALTER TABLE session_delegations
			 ADD COLUMN routine_run_id TEXT`,
		);
		db.run(
			`CREATE INDEX idx_session_delegations_routine_run
			 ON session_delegations(routine_run_id, status)`,
		);
	});

	// Raven turns that have not crossed the provider-dispatch boundary remain
	// Hlid-owned work. Keep their exact payload and sleep decision in SQLite so
	// a process restart can rebuild the FIFO queue without one browser's state.
	runMigration(db, "_migrated_session_pending_turns_v1", (db) => {
		db.run(`
			CREATE TABLE session_pending_turns (
				turn_id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				position INTEGER NOT NULL,
				payload_json TEXT NOT NULL,
				state TEXT NOT NULL CHECK(state IN (
					'queued', 'sleeping', 'dispatching'
				)),
				provider_id TEXT,
				window_id TEXT,
				sleep_reason TEXT CHECK(
					sleep_reason IS NULL OR sleep_reason IN ('threshold', 'limit_reached')
				),
				sleep_until INTEGER,
				sleep_target INTEGER,
				sleep_utilization REAL,
				cap_deadline INTEGER,
				created_at INTEGER NOT NULL DEFAULT (unixepoch()),
				updated_at INTEGER NOT NULL DEFAULT (unixepoch())
			)
		`);
		db.run(
			`CREATE INDEX idx_session_pending_turns_session_position
			 ON session_pending_turns(session_id, position)`,
		);
		db.run(
			`CREATE INDEX idx_session_pending_turns_state
			 ON session_pending_turns(state)`,
		);
	});
	runMigration(db, "_migrated_messages_session_turn_id_index", (db) => {
		db.run(
			`CREATE INDEX idx_messages_session_turn_id
			 ON messages(session_id, turn_id) WHERE turn_id IS NOT NULL`,
		);
	});

	// Session cleanup removes bulky transcripts while Ledger remains historical.
	// Keep a bounded immutable tool-event projection so tool/error totals do not
	// change when the owning Raven session is intentionally deleted.
	runMigration(db, "_migrated_historical_tool_events_v1", (db) => {
		db.run(`
			CREATE TABLE historical_tool_events (
				source_event_id INTEGER PRIMARY KEY,
				session_id TEXT NOT NULL,
				timestamp INTEGER NOT NULL,
				name TEXT NOT NULL,
				is_error INTEGER NOT NULL DEFAULT 0,
				result_text TEXT,
				provider_id TEXT,
				model TEXT,
				agent_cwd TEXT
			)
		`);
		db.run(
			`CREATE INDEX idx_historical_tool_events_timestamp
			 ON historical_tool_events(timestamp)`,
		);
		db.run(
			`CREATE INDEX idx_historical_tool_events_dimensions
			 ON historical_tool_events(provider_id, model, agent_cwd, timestamp)`,
		);
		db.run(
			`CREATE INDEX idx_historical_tool_events_name_error
			 ON historical_tool_events(name, is_error, timestamp)`,
		);
	});
	runMigration(db, "_migrated_historical_sessions_v1", (db) => {
		db.run(`
			CREATE TABLE historical_sessions (
				session_id TEXT PRIMARY KEY,
				started_at INTEGER NOT NULL,
				ended_at INTEGER,
				provider_id TEXT,
				model TEXT,
				agent_cwd TEXT,
				deleted_at INTEGER NOT NULL DEFAULT (unixepoch())
			)
		`);
	});

	// Filesystem deletion cannot be atomic with SQLite. Queue Hlid-owned files in
	// the same transaction as their attachment/session rows so failed unlinks can
	// be retried by later maintenance instead of becoming invisible orphans.
	runMigration(db, "_migrated_pending_file_deletions_v1", (db) => {
		db.run(`
			CREATE TABLE pending_file_deletions (
				path TEXT PRIMARY KEY,
				created_at INTEGER NOT NULL DEFAULT (unixepoch()),
				attempts INTEGER NOT NULL DEFAULT 0,
				last_error TEXT
			)
		`);
	});

	// Session history reads should not ask SQLite to materialize every large tool
	// result merely to calculate its length and first visible characters.
	runMigration(db, "_migrated_tool_event_result_summary_v1", (db) => {
		db.run(`ALTER TABLE tool_events ADD COLUMN result_length INTEGER`);
		db.run(`ALTER TABLE tool_events ADD COLUMN result_preview TEXT`);
	});

	// Managed images are optimized at most once per stored version. Recording the
	// original size keeps the savings auditable and makes the upgrade pass safely
	// restartable without repeatedly re-encoding an attachment.
	runMigration(db, "_migrated_attachment_image_optimization_v1", (db) => {
		db.run(`ALTER TABLE attachments ADD COLUMN image_optimized_at INTEGER`);
		db.run(`ALTER TABLE attachments ADD COLUMN original_size_bytes INTEGER`);
	});

	// Claude's long-lived streaming query reports total_cost_usd cumulatively.
	// v0.0.128 and later stored those snapshots as per-query estimates. Repair
	// completed live Raven turns while leaving imported and interrupted rows
	// untouched; the migration is transactional and runs once per installation.
	runMigration(db, "_migrated_claude_cumulative_cost_deltas_v2", (db) => {
		repairClaudeCumulativeCosts(db);
	});

	// OpenAI reduced GPT-5.6 Terra by 20% and Luna by 80% on July 30, 2026.
	// Reprice only estimates recorded under Hlid's built-in pre-cutover rates;
	// local effective-dated overrides remain authoritative.
	runMigration(db, CODEX_TERRA_LUNA_PRICING_MIGRATION, (db) => {
		repairCodexPricingCutover(db);
	});

	// Provider work can outlive the visible assistant turn. Keep a bounded
	// session-owned projection so Raven can restore settled/unknown activity
	// without pretending a restarted process is still live or controllable.
	runMigration(db, "_migrated_provider_background_activities_v1", (db) => {
		db.run(`
			CREATE TABLE provider_background_activities (
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				provider_id TEXT NOT NULL,
				provider_session_id TEXT NOT NULL,
				activity_id TEXT NOT NULL,
				process_id TEXT,
				kind TEXT NOT NULL CHECK(kind IN (
					'terminal', 'shell', 'monitor', 'agent', 'workflow', 'task'
				)),
				status TEXT NOT NULL CHECK(status IN (
					'running', 'completed', 'failed', 'stopped', 'unknown'
				)),
				command TEXT,
				description TEXT,
				cwd TEXT,
				recent_output TEXT,
				os_pid INTEGER,
				cpu_percent REAL,
				rss_kb INTEGER,
				started_at_ms INTEGER NOT NULL,
				updated_at_ms INTEGER NOT NULL,
				ended_at_ms INTEGER,
				can_stop INTEGER NOT NULL DEFAULT 0,
				can_terminate INTEGER NOT NULL DEFAULT 0,
				can_clean INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (
					session_id, provider_id, provider_session_id, activity_id
				)
			)
		`);
		db.run(
			`CREATE INDEX idx_provider_background_activities_session_updated
			 ON provider_background_activities(session_id, updated_at_ms DESC)`,
		);
	});

	// Claude refusal fallback can retract any previously delivered normalized
	// provider frame, including non-tail prose and user/tool_result tombstones.
	// Keep the provider UUID ledger separate from messages.sdk_uuid: sdk_uuid is
	// still the latest native fork cutoff, while this table owns exact content
	// contribution identity and idempotent retraction state.
	runMigration(db, "_migrated_provider_message_frames_v1", (db) => {
		db.run(`
			CREATE TABLE provider_message_frames (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				assistant_seq INTEGER NOT NULL,
				provider_id TEXT NOT NULL,
				provider_session_id TEXT NOT NULL,
				provider_uuid TEXT NOT NULL,
				frame_order INTEGER NOT NULL,
				kind TEXT NOT NULL CHECK(kind IN ('assistant', 'result_text', 'tool_result')),
				text_fragment TEXT,
				raw_tool_start_ids_json TEXT,
				tool_start_ids_json TEXT,
				tool_result_ids_json TEXT,
				retracted INTEGER NOT NULL DEFAULT 0,
				UNIQUE(session_id, provider_id, provider_session_id, provider_uuid)
			)
		`);
		db.run(
			`CREATE INDEX idx_provider_message_frames_row_order
			 ON provider_message_frames(session_id, assistant_seq, frame_order, id)`,
		);
		db.run(`
			CREATE TABLE provider_message_retractions (
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				provider_id TEXT NOT NULL,
				provider_session_id TEXT NOT NULL,
				provider_uuid TEXT NOT NULL,
				source TEXT NOT NULL CHECK(source IN (
					'assistant_supersedes', 'model_refusal_fallback'
				)),
				timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
				PRIMARY KEY (
					session_id, provider_id, provider_session_id, provider_uuid
				)
			)
		`);
		db.run(`ALTER TABLE tool_events ADD COLUMN provider_start_frame_uuid TEXT`);
		db.run(`ALTER TABLE tool_events ADD COLUMN provider_start_session_id TEXT`);
		db.run(
			`ALTER TABLE tool_events ADD COLUMN provider_result_frame_uuid TEXT`,
		);
		db.run(
			`ALTER TABLE tool_events ADD COLUMN provider_result_session_id TEXT`,
		);
		db.run(`
			CREATE TABLE provider_tool_metadata_contributions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				tool_event_id INTEGER NOT NULL REFERENCES tool_events(id) ON DELETE CASCADE,
				provider_id TEXT NOT NULL,
				provider_session_id TEXT,
				provider_uuid TEXT,
				subagent_json TEXT,
				activity_json TEXT,
				timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
				CHECK ((provider_session_id IS NULL) = (provider_uuid IS NULL)),
				CHECK (subagent_json IS NOT NULL OR activity_json IS NOT NULL)
			)
		`);
		db.run(
			`CREATE INDEX idx_provider_tool_metadata_contributions_tool_order
			 ON provider_tool_metadata_contributions(tool_event_id, id)`,
		);
		db.run(
			`CREATE INDEX idx_provider_tool_metadata_contributions_frame
			 ON provider_tool_metadata_contributions(
				session_id, provider_id, provider_session_id, provider_uuid, tool_event_id
			 )`,
		);
		db.run(`
			CREATE TABLE provider_tool_start_lineage (
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				tool_event_id INTEGER NOT NULL REFERENCES tool_events(id) ON DELETE CASCADE,
				provider_id TEXT NOT NULL,
				provider_session_id TEXT NOT NULL,
				provider_uuid TEXT NOT NULL,
				PRIMARY KEY (
					tool_event_id, provider_id, provider_session_id, provider_uuid
				)
			)
		`);
		db.run(
			`CREATE INDEX idx_provider_tool_start_lineage_frame
			 ON provider_tool_start_lineage(
				session_id, provider_id, provider_session_id, provider_uuid, tool_event_id
			 )`,
		);
	});

	// A provider may report that it blocked a tool after Hlid already recorded a
	// human approval decision. Keep those facts independent: provider evidence
	// must never rewrite what the person chose, and repeated SDK result frames
	// must converge on one row for the same session-scoped tool call.
	runMigration(db, "_migrated_permission_provider_outcomes_v1", (db) => {
		db.run(`
			CREATE TABLE permission_events_v2 (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL REFERENCES sessions(id),
				tool_id TEXT NOT NULL,
				tool_name TEXT NOT NULL,
				display_name TEXT,
				decision TEXT NOT NULL,
				human_decision TEXT,
				human_timestamp INTEGER,
				provider_outcome TEXT,
				provider_id TEXT,
				provider_session_id TEXT,
				provider_reason_type TEXT,
				provider_reason TEXT,
				provider_message TEXT,
				provider_timestamp INTEGER,
				timestamp INTEGER NOT NULL,
				-- Legacy databases did not constrain decision. Preserve an unknown
				-- historical value instead of making startup fail during migration.
				CHECK(human_decision IS NULL OR human_decision IN (
					'approved', 'approved_session', 'approved_always', 'denied'
				)),
				CHECK(human_decision IS NULL OR human_timestamp IS NOT NULL),
				CHECK(provider_outcome IS NULL OR provider_outcome = 'blocked'),
				CHECK(provider_outcome IS NULL OR (
					provider_id IS NOT NULL AND provider_session_id IS NOT NULL
					AND provider_timestamp IS NOT NULL
				)),
				UNIQUE(session_id, tool_id)
			)
		`);
		db.run(`
			INSERT INTO permission_events_v2
				(session_id, tool_id, tool_name, display_name, decision,
				 human_decision, human_timestamp, timestamp)
			SELECT legacy.session_id,
			       legacy.tool_id,
			       COALESCE((
			         SELECT latest.tool_name FROM permission_events latest
			         WHERE latest.session_id = legacy.session_id
			           AND latest.tool_id = legacy.tool_id
			         ORDER BY latest.id DESC LIMIT 1
			       ), ''),
			       (
			         SELECT latest.display_name FROM permission_events latest
			         WHERE latest.session_id = legacy.session_id
			           AND latest.tool_id = legacy.tool_id
			           AND latest.display_name IS NOT NULL
			         ORDER BY latest.id DESC LIMIT 1
			       ),
			       (
			         SELECT latest.decision FROM permission_events latest
			         WHERE latest.session_id = legacy.session_id
			           AND latest.tool_id = legacy.tool_id
			         ORDER BY latest.id DESC LIMIT 1
			       ),
			       CASE WHEN (
			         SELECT latest.decision FROM permission_events latest
			         WHERE latest.session_id = legacy.session_id
			           AND latest.tool_id = legacy.tool_id
			         ORDER BY latest.id DESC LIMIT 1
			       ) IN ('approved', 'approved_session', 'approved_always', 'denied')
			       THEN (
			         SELECT latest.decision FROM permission_events latest
			         WHERE latest.session_id = legacy.session_id
			           AND latest.tool_id = legacy.tool_id
			         ORDER BY latest.id DESC LIMIT 1
			       ) ELSE NULL END,
			       CASE WHEN (
			         SELECT latest.decision FROM permission_events latest
			         WHERE latest.session_id = legacy.session_id
			           AND latest.tool_id = legacy.tool_id
			         ORDER BY latest.id DESC LIMIT 1
			       ) IN ('approved', 'approved_session', 'approved_always', 'denied')
			       THEN MAX(legacy.timestamp) ELSE NULL END,
			       MAX(legacy.timestamp)
			FROM permission_events legacy
			GROUP BY legacy.session_id, legacy.tool_id
		`);
		db.run(`DROP TABLE permission_events`);
		db.run(`ALTER TABLE permission_events_v2 RENAME TO permission_events`);
		db.run(
			`CREATE INDEX idx_permission_events_session ON permission_events(session_id)`,
		);
	});

	// Web Push subscriptions are device capabilities, not application config.
	// Keep their endpoint and encryption material in Hlid's private database while
	// the VAPID signing key remains a host-owned sidecar file. Session overrides
	// are installation-wide so a single Raven choice applies consistently to all
	// devices; selecting "default" is represented by removing the override row.
	runMigration(db, "_migrated_web_push_notifications_v1", (db) => {
		db.run(`
			CREATE TABLE push_subscriptions (
				id TEXT PRIMARY KEY,
				endpoint TEXT NOT NULL UNIQUE,
				p256dh TEXT NOT NULL,
				auth TEXT NOT NULL,
				expiration_time_ms INTEGER,
				needs_attention INTEGER NOT NULL DEFAULT 1
					CHECK(needs_attention IN (0, 1)),
				work_finished INTEGER NOT NULL DEFAULT 0
					CHECK(work_finished IN (0, 1)),
				privacy TEXT NOT NULL DEFAULT 'generic'
					CHECK(privacy IN ('generic', 'detailed')),
				enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
				created_at INTEGER NOT NULL DEFAULT (unixepoch()),
				updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
				last_success_at INTEGER,
				last_failure_at INTEGER,
				failure_count INTEGER NOT NULL DEFAULT 0
					CHECK(failure_count >= 0)
			)
		`);
		db.run(
			`CREATE INDEX idx_push_subscriptions_delivery
			 ON push_subscriptions(enabled, expiration_time_ms)`,
		);
		db.run(`
			CREATE TABLE push_session_overrides (
				session_id TEXT PRIMARY KEY
					REFERENCES sessions(id) ON DELETE CASCADE,
				mode TEXT NOT NULL CHECK(mode IN ('notify', 'mute')),
				updated_at INTEGER NOT NULL DEFAULT (unixepoch())
			)
		`);
	});

	// Bind newly registered browser endpoints to the durable authenticated
	// browser session that registered them. The nullable column preserves Web
	// Push rows created by the v1 prerelease schema; the next successful browser
	// reconciliation claims those rows for its current trusted-device session.
	runMigration(db, "_migrated_web_push_auth_session_v2", (db) => {
		db.run(`
			ALTER TABLE push_subscriptions
			ADD COLUMN auth_session_hash TEXT
				REFERENCES auth_sessions(token_hash) ON DELETE CASCADE
		`);
		db.run(
			`CREATE INDEX idx_push_subscriptions_auth_session
			 ON push_subscriptions(auth_session_hash)`,
		);
	});

	// Split actionable requests from operational problems without changing an
	// existing device's opt-in. The old needs_attention value is copied to both
	// categories so an explicit prerelease opt-out remains off. Device names,
	// completion thresholds, pauses, and one-shot completion overrides are all
	// device/session metadata; endpoint capabilities remain private.
	runMigration(db, "_migrated_web_push_preferences_v3", (db) => {
		db.run(`
			ALTER TABLE push_subscriptions
			ADD COLUMN requests INTEGER NOT NULL DEFAULT 1
				CHECK(requests IN (0, 1))
		`);
		db.run(`
			ALTER TABLE push_subscriptions
			ADD COLUMN problems INTEGER NOT NULL DEFAULT 1
				CHECK(problems IN (0, 1))
		`);
		db.run(`
			ALTER TABLE push_subscriptions
			ADD COLUMN completion_min_runtime_minutes INTEGER NOT NULL DEFAULT 0
				CHECK(completion_min_runtime_minutes IN (0, 1, 5, 10))
		`);
		db.run(`
			ALTER TABLE push_subscriptions
			ADD COLUMN paused_until INTEGER CHECK(paused_until IS NULL OR paused_until >= 0)
		`);
		db.run(`
			ALTER TABLE push_subscriptions
			ADD COLUMN device_name TEXT NOT NULL DEFAULT 'Subscribed device'
		`);
		db.run(`
			UPDATE push_subscriptions
			SET requests = needs_attention,
			    problems = needs_attention,
			    device_name = SUBSTR(COALESCE(NULLIF(TRIM((
			      SELECT owner.device_label FROM auth_sessions owner
			      WHERE owner.token_hash = push_subscriptions.auth_session_hash
			    )), ''), 'Subscribed device'), 1, 80)
		`);
		for (const row of db
			.query<{ id: string; device_name: string }, []>(
				`SELECT id, device_name FROM push_subscriptions`,
			)
			.all()) {
			const normalized = normalizedMigratedPushDeviceName(row.device_name);
			if (normalized !== row.device_name) {
				db.run(`UPDATE push_subscriptions SET device_name = ? WHERE id = ?`, [
					normalized,
					row.id,
				]);
			}
		}
		db.run(`
			CREATE TABLE push_session_overrides_v3 (
				session_id TEXT PRIMARY KEY
					REFERENCES sessions(id) ON DELETE CASCADE,
				mode TEXT NOT NULL
					CHECK(mode IN ('notify', 'notify_once', 'mute')),
				updated_at INTEGER NOT NULL DEFAULT (unixepoch())
			)
		`);
		db.run(`
			INSERT INTO push_session_overrides_v3 (session_id, mode, updated_at)
			SELECT session_id, mode, updated_at FROM push_session_overrides
		`);
		db.run(`DROP TABLE push_session_overrides`);
		db.run(
			`ALTER TABLE push_session_overrides_v3 RENAME TO push_session_overrides`,
		);
	});

	// Timed pauses and manual-resume pauses are different user intent. Keep an
	// explicit flag rather than encoding "until I resume" as a fake future date.
	runMigration(db, "_migrated_web_push_manual_pause_v4", (db) => {
		db.run(`
			ALTER TABLE push_subscriptions
			ADD COLUMN paused_indefinitely INTEGER NOT NULL DEFAULT 0
				CHECK(paused_indefinitely IN (0, 1))
		`);
	});

	// Keep scheduled quiet-time behavior and prerelease notification policies
	// with the device that owns the browser capability. Rebuild the compact
	// override table so new one-shot completion and delegation-tree policies can
	// coexist with every v3 row.
	runMigration(db, "_migrated_web_push_policy_v5", (db) => {
		db.run(`
			ALTER TABLE push_subscriptions
			ADD COLUMN quiet_hours_json TEXT
				CHECK(quiet_hours_json IS NULL OR length(quiet_hours_json) <= 2048)
		`);
		db.run(`
			ALTER TABLE push_subscriptions
			ADD COLUMN catch_up_after_pause INTEGER NOT NULL DEFAULT 0
				CHECK(catch_up_after_pause IN (0, 1))
		`);
		db.run(`
			ALTER TABLE push_subscriptions
			ADD COLUMN reminder_minutes INTEGER NOT NULL DEFAULT 0
				CHECK(reminder_minutes IN (0, 5, 15, 30, 60))
		`);
		db.run(`
			CREATE TABLE push_session_overrides_v5 (
				session_id TEXT PRIMARY KEY
					REFERENCES sessions(id) ON DELETE CASCADE,
				mode TEXT NOT NULL CHECK(mode IN (
					'notify', 'notify_once', 'notify_completion_once', 'mute'
				)),
				scope TEXT NOT NULL DEFAULT 'session'
					CHECK(scope IN ('session', 'delegation_tree')),
				target_device_ids_json TEXT
					CHECK(target_device_ids_json IS NULL OR length(target_device_ids_json) <= 1408),
				updated_at INTEGER NOT NULL DEFAULT (unixepoch())
			)
		`);
		db.run(`
			INSERT INTO push_session_overrides_v5
				(session_id, mode, scope, target_device_ids_json, updated_at)
			SELECT session_id, mode, 'session', NULL, updated_at
			FROM push_session_overrides
		`);
		db.run(`DROP TABLE push_session_overrides`);
		db.run(
			`ALTER TABLE push_session_overrides_v5 RENAME TO push_session_overrides`,
		);
		db.run(
			`CREATE INDEX idx_push_session_overrides_tree
			 ON push_session_overrides(scope, updated_at DESC)`,
		);
	});

	// Notification intents and delivery decisions survive process restarts. The
	// coordinator prunes terminal history to a bounded window; pending/deferred
	// work is retained until it is delivered, expires, or is explicitly closed.
	runMigration(db, "_migrated_web_push_outbox_v6", (db) => {
		db.run(`
			CREATE TABLE push_notification_batches (
				id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 64),
				category TEXT NOT NULL
					CHECK(category IN ('request', 'problem', 'completion')),
				group_key TEXT CHECK(group_key IS NULL OR length(group_key) <= 256),
				status TEXT NOT NULL DEFAULT 'open'
					CHECK(status IN ('open', 'ready', 'sent', 'read', 'expired')),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				sent_at INTEGER,
				read_at INTEGER
			)
		`);
		db.run(`
			CREATE TABLE push_notification_events (
				id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 64),
				source_kind TEXT NOT NULL
					CHECK(source_kind IN ('session', 'routine', 'system')),
				source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 256),
				category TEXT NOT NULL
					CHECK(category IN ('request', 'problem', 'completion')),
				reason TEXT CHECK(reason IS NULL OR length(reason) <= 64),
				label TEXT CHECK(label IS NULL OR length(label) <= 160),
				url TEXT CHECK(url IS NULL OR length(url) <= 2048),
				runtime_ms INTEGER CHECK(runtime_ms IS NULL OR runtime_ms >= 0),
				pending_count INTEGER NOT NULL DEFAULT 0 CHECK(pending_count >= 0),
				occurred_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL CHECK(expires_at > occurred_at),
				group_key TEXT CHECK(group_key IS NULL OR length(group_key) <= 256),
				batch_id TEXT REFERENCES push_notification_batches(id) ON DELETE SET NULL,
				status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
					'pending', 'deferred', 'batched', 'processed', 'expired', 'cancelled'
				)),
				status_reason TEXT CHECK(status_reason IS NULL OR length(status_reason) <= 128),
				next_attempt_at INTEGER,
				metadata_json TEXT NOT NULL DEFAULT '{}'
					CHECK(length(metadata_json) <= 8192),
				dedupe_key TEXT UNIQUE
					CHECK(dedupe_key IS NULL OR length(dedupe_key) <= 256),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
		db.run(
			`CREATE INDEX idx_push_notification_events_ready
			 ON push_notification_events(status, next_attempt_at, occurred_at, id)`,
		);
		db.run(
			`CREATE INDEX idx_push_notification_events_history
			 ON push_notification_events(occurred_at DESC, id DESC)`,
		);
		db.run(`
			CREATE TABLE push_notification_deliveries (
				id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 64),
				event_id TEXT NOT NULL
					REFERENCES push_notification_events(id) ON DELETE CASCADE,
				device_id TEXT NOT NULL CHECK(length(device_id) BETWEEN 1 AND 64),
				device_snapshot_json TEXT NOT NULL
					CHECK(length(device_snapshot_json) <= 2048),
				status TEXT NOT NULL CHECK(status IN (
					'pending', 'suppressed', 'queued', 'sent', 'failed', 'gone', 'expired'
				)),
				reason TEXT CHECK(reason IS NULL OR length(reason) <= 128),
				next_attempt_at INTEGER,
				attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
				provider_status INTEGER,
				receipt_at INTEGER,
				displayed_at INTEGER,
				opened_at INTEGER,
				dismissed_at INTEGER,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				UNIQUE(event_id, device_id)
			)
		`);
		db.run(
			`CREATE INDEX idx_push_notification_deliveries_ready
			 ON push_notification_deliveries(status, next_attempt_at, event_id)`,
		);
		db.run(`
			CREATE TABLE push_notification_batch_members (
				batch_id TEXT NOT NULL
					REFERENCES push_notification_batches(id) ON DELETE CASCADE,
				event_id TEXT NOT NULL
					REFERENCES push_notification_events(id) ON DELETE CASCADE,
				session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
				position INTEGER NOT NULL CHECK(position >= 0),
				added_at INTEGER NOT NULL,
				read_at INTEGER,
				PRIMARY KEY(batch_id, event_id),
				UNIQUE(batch_id, session_id)
			)
		`);
		db.run(
			`CREATE INDEX idx_push_notification_batch_members_read
			 ON push_notification_batch_members(batch_id, read_at, position)`,
		);
	});

	// Keep a privacy-safe record of each provider attempt beneath the durable
	// per-device delivery. Event pruning deletes the delivery and cascades its
	// attempt history without retaining endpoint, key, or notification content.
	runMigration(db, "_migrated_web_push_delivery_attempts_v7", (db) => {
		db.run(`
			CREATE TABLE push_notification_delivery_attempts (
				id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 64),
				delivery_id TEXT NOT NULL
					REFERENCES push_notification_deliveries(id) ON DELETE CASCADE,
				attempted_at INTEGER NOT NULL CHECK(attempted_at >= 0),
				outcome TEXT NOT NULL
					CHECK(outcome IN ('delivered', 'failed', 'gone')),
				provider_status INTEGER CHECK(
					provider_status IS NULL OR provider_status BETWEEN 100 AND 599
				),
				retry_after_ms INTEGER CHECK(
					retry_after_ms IS NULL OR retry_after_ms >= 0
				),
				reason_code TEXT CHECK(
					reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 64
				)
			)
		`);
		db.run(
			`CREATE INDEX idx_push_notification_delivery_attempts_delivery
			 ON push_notification_delivery_attempts(delivery_id, attempted_at, id)`,
		);
	});

	// A provider-accepted one-shot must survive a crash between its receipt and
	// the fan-out-wide policy clear. The receipt transaction records this marker.
	runMigration(db, "_migrated_web_push_one_shot_consumptions_v8", (db) => {
		db.run(`
			CREATE TABLE push_notification_one_shot_consumptions (
				event_id TEXT NOT NULL
					REFERENCES push_notification_events(id) ON DELETE CASCADE,
				source_session_id TEXT NOT NULL
					CHECK(length(source_session_id) BETWEEN 1 AND 256),
				mode TEXT NOT NULL
					CHECK(mode IN ('notify_once', 'notify_completion_once')),
				created_at INTEGER NOT NULL,
				PRIMARY KEY(event_id, source_session_id, mode)
			)
		`);
	});

	// Bind provider acceptance to the exact one-shot revision that authorized
	// it, so a slow old fan-out cannot clear a newer user re-arm (ABA).
	runMigration(db, "_migrated_web_push_one_shot_policy_revision_v9", (db) => {
		db.run(`
			ALTER TABLE push_notification_one_shot_consumptions
			ADD COLUMN policy_updated_at INTEGER NOT NULL DEFAULT 0
				CHECK(policy_updated_at >= 0)
		`);
	});

	// The same durable event may span a one-shot re-arm while another device is
	// still queued. Keep acceptance markers distinct per observed policy revision.
	runMigration(db, "_migrated_web_push_one_shot_revision_key_v10", (db) => {
		db.run(`
			CREATE TABLE push_notification_one_shot_consumptions_v10 (
				event_id TEXT NOT NULL
					REFERENCES push_notification_events(id) ON DELETE CASCADE,
				source_session_id TEXT NOT NULL
					CHECK(length(source_session_id) BETWEEN 1 AND 256),
				mode TEXT NOT NULL
					CHECK(mode IN ('notify_once', 'notify_completion_once')),
				policy_updated_at INTEGER NOT NULL DEFAULT 0
					CHECK(policy_updated_at >= 0),
				created_at INTEGER NOT NULL,
				PRIMARY KEY(event_id, source_session_id, mode, policy_updated_at)
			)
		`);
		db.run(`
			INSERT INTO push_notification_one_shot_consumptions_v10 (
				event_id, source_session_id, mode, policy_updated_at, created_at
			)
			SELECT event_id, source_session_id, mode, policy_updated_at, created_at
			FROM push_notification_one_shot_consumptions
		`);
		db.run(`DROP TABLE push_notification_one_shot_consumptions`);
		db.run(`
			ALTER TABLE push_notification_one_shot_consumptions_v10
			RENAME TO push_notification_one_shot_consumptions
		`);
	});

	// Reminder intervals were removed after their prerelease trial. Preserve the
	// accepted delivery history while cancelling only repeat work, then recompute
	// each affected event from any unrelated per-device retry or scheduled rows.
	runMigration(db, "_migrated_web_push_remove_reminders_v11", (db) => {
		db.run(`
			CREATE TEMP TABLE push_notification_removed_reminder_events_v11 (
				id TEXT PRIMARY KEY
			)
		`);
		db.run(`
			INSERT OR IGNORE INTO push_notification_removed_reminder_events_v11 (id)
			SELECT DISTINCT event_id
			FROM push_notification_deliveries
			WHERE (status = 'sent' AND next_attempt_at IS NOT NULL)
			   OR reason = 'reminder'
			   OR reason GLOB 'reminder_*'
			   OR reason GLOB 'reminder:*'
		`);
		db.run(`
			UPDATE push_notification_deliveries
			SET status = 'sent', reason = 'accepted', next_attempt_at = NULL
			WHERE event_id IN (
				SELECT id FROM push_notification_removed_reminder_events_v11
			)
			  AND (
				(status = 'sent' AND next_attempt_at IS NOT NULL)
				OR reason = 'reminder'
				OR reason GLOB 'reminder_*'
				OR reason GLOB 'reminder:*'
			  )
		`);
		db.run(`
			UPDATE push_notification_events AS event
			SET status = 'deferred',
				status_reason = CASE WHEN EXISTS (
					SELECT 1 FROM push_notification_deliveries dormant
					WHERE dormant.event_id = event.id
					  AND dormant.status = 'queued'
					  AND dormant.next_attempt_at IS NULL
				) THEN 'pause' ELSE 'device_retry' END,
				next_attempt_at = (
					SELECT MIN(CASE
						WHEN pending.status = 'pending'
						THEN COALESCE(pending.next_attempt_at, pending.created_at)
						ELSE pending.next_attempt_at
					END)
					FROM push_notification_deliveries pending
					WHERE pending.event_id = event.id
					  AND (
						pending.status = 'pending'
						OR pending.status = 'queued'
						OR (pending.status = 'failed'
							AND pending.next_attempt_at IS NOT NULL)
					  )
				)
			WHERE event.id IN (
				SELECT id FROM push_notification_removed_reminder_events_v11
			)
			  AND event.status IN ('pending', 'deferred', 'batched')
			  AND EXISTS (
				SELECT 1 FROM push_notification_deliveries pending
				WHERE pending.event_id = event.id
				  AND (
					pending.status = 'pending'
					OR pending.status = 'queued'
					OR (pending.status = 'failed'
						AND pending.next_attempt_at IS NOT NULL)
				  )
			  )
		`);
		db.run(`
			UPDATE push_notification_events AS event
			SET status = 'processed', status_reason = 'delivery_complete',
				next_attempt_at = NULL
			WHERE event.id IN (
				SELECT id FROM push_notification_removed_reminder_events_v11
			)
			  AND event.status IN ('pending', 'deferred', 'batched')
			  AND NOT EXISTS (
				SELECT 1 FROM push_notification_deliveries pending
				WHERE pending.event_id = event.id
				  AND (
					pending.status = 'pending'
					OR pending.status = 'queued'
					OR (pending.status = 'failed'
						AND pending.next_attempt_at IS NOT NULL)
				  )
			  )
		`);
		db.run(`
			UPDATE push_notification_events
			SET status_reason = CASE status
					WHEN 'cancelled' THEN 'state_resolved'
					WHEN 'expired' THEN 'expired'
					ELSE 'delivery_complete'
				END,
				next_attempt_at = NULL
			WHERE id IN (
				SELECT id FROM push_notification_removed_reminder_events_v11
			)
			  AND status IN ('processed', 'cancelled', 'expired')
			  AND (
				status_reason = 'reminder'
				OR status_reason GLOB 'reminder_*'
				OR status_reason GLOB 'reminder:*'
			  )
		`);
		db.run(`DROP TABLE push_notification_removed_reminder_events_v11`);

		const hasReminderColumn = db
			.query<{ name: string }, []>(`PRAGMA table_info(push_subscriptions)`)
			.all()
			.some((column) => column.name === "reminder_minutes");
		if (hasReminderColumn) {
			db.run(`ALTER TABLE push_subscriptions DROP COLUMN reminder_minutes`);
		}
	});

	// Pause and quiet-hours catch-up were removed after their prerelease trial.
	// Existing delayed rows become terminal suppressions, while every affected
	// event is recomputed from its other devices so provider retries and unrelated
	// scheduled work remain intact.
	runMigration(db, "_migrated_web_push_remove_catch_up_v12", (db) => {
		db.run(`
			CREATE TEMP TABLE push_notification_removed_catch_up_events_v12 (
				id TEXT PRIMARY KEY
			)
		`);
		db.run(`
			INSERT OR IGNORE INTO push_notification_removed_catch_up_events_v12 (id)
			SELECT DISTINCT event_id
			FROM push_notification_deliveries
			WHERE status = 'queued' AND reason IN ('pause', 'quiet_hours')
		`);
		db.run(`
			INSERT OR IGNORE INTO push_notification_removed_catch_up_events_v12 (id)
			SELECT id
			FROM push_notification_events
			WHERE status = 'deferred' AND status_reason IN ('pause', 'quiet_hours')
		`);
		db.run(`
			UPDATE push_notification_deliveries
			SET status = 'suppressed', next_attempt_at = NULL
			WHERE status = 'queued' AND reason IN ('pause', 'quiet_hours')
		`);
		db.run(`
			UPDATE push_notification_events AS event
			SET status = 'deferred',
				status_reason = COALESCE((
					SELECT CASE
						WHEN pending.status = 'failed' THEN 'device_retry'
						ELSE pending.reason
					END
					FROM push_notification_deliveries pending
					WHERE pending.event_id = event.id
					  AND (
						pending.status = 'pending'
						OR pending.status = 'queued'
						OR (pending.status = 'failed'
							AND pending.next_attempt_at IS NOT NULL)
					  )
					ORDER BY CASE WHEN pending.next_attempt_at IS NULL THEN 0 ELSE 1 END,
						COALESCE(pending.next_attempt_at, pending.created_at), pending.id
					LIMIT 1
				), 'device_retry'),
				next_attempt_at = (
					SELECT MIN(CASE
						WHEN pending.status = 'pending'
						THEN COALESCE(pending.next_attempt_at, pending.created_at)
						ELSE pending.next_attempt_at
					END)
					FROM push_notification_deliveries pending
					WHERE pending.event_id = event.id
					  AND (
						pending.status = 'pending'
						OR pending.status = 'queued'
						OR (pending.status = 'failed'
							AND pending.next_attempt_at IS NOT NULL)
					  )
				)
			WHERE event.id IN (
				SELECT id FROM push_notification_removed_catch_up_events_v12
			)
			  AND event.status IN ('pending', 'deferred', 'batched')
			  AND EXISTS (
				SELECT 1 FROM push_notification_deliveries pending
				WHERE pending.event_id = event.id
				  AND (
					pending.status = 'pending'
					OR pending.status = 'queued'
					OR (pending.status = 'failed'
						AND pending.next_attempt_at IS NOT NULL)
				  )
			  )
		`);
		db.run(`
			UPDATE push_notification_events AS event
			SET status = 'processed', status_reason = 'delivery_complete',
				next_attempt_at = NULL
			WHERE event.id IN (
				SELECT id FROM push_notification_removed_catch_up_events_v12
			)
			  AND event.status IN ('pending', 'deferred', 'batched')
			  AND NOT EXISTS (
				SELECT 1 FROM push_notification_deliveries pending
				WHERE pending.event_id = event.id
				  AND (
					pending.status = 'pending'
					OR pending.status = 'queued'
					OR (pending.status = 'failed'
						AND pending.next_attempt_at IS NOT NULL)
				  )
			  )
		`);
		db.run(`DROP TABLE push_notification_removed_catch_up_events_v12`);

		for (const row of db
			.query<{ id: string; quiet_hours_json: string }, []>(
				`SELECT id, quiet_hours_json FROM push_subscriptions
				 WHERE quiet_hours_json IS NOT NULL`,
			)
			.all()) {
			try {
				const profile = JSON.parse(row.quiet_hours_json) as unknown;
				if (
					typeof profile !== "object" ||
					profile === null ||
					Array.isArray(profile) ||
					!Object.hasOwn(profile, "catch_up")
				) {
					continue;
				}
				delete (profile as Record<string, unknown>).catch_up;
				db.run(
					`UPDATE push_subscriptions SET quiet_hours_json = ? WHERE id = ?`,
					[JSON.stringify(profile), row.id],
				);
			} catch {
				// Preserve malformed legacy input; runtime parsing continues to fail closed.
			}
		}

		const hasCatchUpColumn = db
			.query<{ name: string }, []>(`PRAGMA table_info(push_subscriptions)`)
			.all()
			.some((column) => column.name === "catch_up_after_pause");
		if (hasCatchUpColumn) {
			db.run(`ALTER TABLE push_subscriptions DROP COLUMN catch_up_after_pause`);
		}
	});
}
