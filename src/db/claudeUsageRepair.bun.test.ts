import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyClaudeUsageRepair,
	planClaudeUsageRepair,
} from "./claudeUsageRepair";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirs
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function tempDir(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "hlid-claude-repair-test-"));
	tempDirs.push(path);
	return path;
}

function makeDb(): Database {
	const db = new Database(":memory:");
	db.run(`
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			provider_session_id TEXT,
			provider_id TEXT NOT NULL,
			started_at INTEGER NOT NULL,
			total_input_tokens INTEGER DEFAULT 0,
			total_output_tokens INTEGER DEFAULT 0,
			total_cache_read_tokens INTEGER DEFAULT 0,
			total_cache_creation_tokens INTEGER DEFAULT 0,
			history_imported INTEGER NOT NULL DEFAULT 0
		)
	`);
	db.run(`
		CREATE TABLE queries (
			id INTEGER PRIMARY KEY,
			session_id TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			cost REAL NOT NULL,
			estimated_cost REAL,
			cost_known INTEGER NOT NULL,
			input_tokens INTEGER NOT NULL,
			output_tokens INTEGER NOT NULL,
			cache_read_tokens INTEGER NOT NULL,
			cache_creation_tokens INTEGER NOT NULL,
			turns INTEGER NOT NULL,
			context_window INTEGER,
			tokens_in_context INTEGER
		)
	`);
	db.run(`
		CREATE TABLE usage_queries (
			id INTEGER PRIMARY KEY,
			session_id TEXT,
			timestamp INTEGER NOT NULL,
			cost REAL NOT NULL,
			estimated_cost REAL,
			cost_known INTEGER NOT NULL,
			unpriced INTEGER NOT NULL,
			input_tokens INTEGER NOT NULL,
			output_tokens INTEGER NOT NULL,
			cache_read_tokens INTEGER NOT NULL,
			cache_creation_tokens INTEGER NOT NULL,
			turns INTEGER NOT NULL,
			provider_id TEXT NOT NULL
		)
	`);
	db.run(`
		CREATE TABLE usage_daily (
			date TEXT PRIMARY KEY,
			cost REAL DEFAULT 0,
			estimated_cost REAL DEFAULT 0,
			unpriced_queries INTEGER DEFAULT 0,
			queries INTEGER DEFAULT 0,
			input_tokens INTEGER DEFAULT 0,
			output_tokens INTEGER DEFAULT 0,
			cache_read_tokens INTEGER DEFAULT 0,
			cache_creation_tokens INTEGER DEFAULT 0,
			turns INTEGER DEFAULT 0
		)
	`);
	return db;
}

function line(value: unknown): string {
	return JSON.stringify(value);
}

function assistant(args: {
	sessionId: string;
	timestamp: string;
	id: string;
	input: number;
	output: number;
	cacheRead?: number;
	cacheCreation?: number;
	isSidechain?: boolean;
}): string {
	return line({
		type: "assistant",
		isSidechain: args.isSidechain ?? false,
		message: {
			id: args.id,
			role: "assistant",
			content: [],
			usage: {
				input_tokens: args.input,
				output_tokens: args.output,
				cache_read_input_tokens: args.cacheRead ?? 0,
				cache_creation_input_tokens: args.cacheCreation ?? 0,
			},
		},
		timestamp: args.timestamp,
		sessionId: args.sessionId,
	});
}

async function writeTranscripts(args: {
	root: string;
	sessionId?: string;
	promptId?: string;
}): Promise<void> {
	const sessionId = args.sessionId ?? "claude-root";
	const promptId = args.promptId ?? "prompt-1";
	await Bun.write(
		join(args.root, `${sessionId}.jsonl`),
		[
			line({
				type: "user",
				isSidechain: false,
				promptId,
				message: { role: "user", content: "Build the feature" },
				timestamp: "2026-01-01T00:00:01.000Z",
				sessionId,
			}),
			assistant({
				sessionId,
				timestamp: "2026-01-01T00:00:02.000Z",
				id: "msg-root",
				input: 10,
				output: 1,
				cacheRead: 4,
				cacheCreation: 3,
			}),
			// The transcript repeats an API id as its content grows. Only the latest
			// authoritative usage snapshot may be counted.
			assistant({
				sessionId,
				timestamp: "2026-01-01T00:00:03.000Z",
				id: "msg-root",
				input: 10,
				output: 5,
				cacheRead: 4,
				cacheCreation: 3,
			}),
		].join("\n"),
	);
	const childDir = join(args.root, sessionId, "subagents");
	await mkdir(childDir, { recursive: true });
	await Bun.write(
		join(childDir, "agent-1.jsonl"),
		[
			line({
				type: "user",
				isSidechain: true,
				promptId,
				message: { role: "user", content: "Inspect it" },
				timestamp: "2026-01-01T00:00:02.100Z",
				sessionId,
			}),
			// Copied root history is ignored by API message id.
			assistant({
				sessionId,
				timestamp: "2026-01-01T00:00:03.100Z",
				id: "msg-root",
				input: 10,
				output: 5,
				cacheRead: 4,
				cacheCreation: 3,
				isSidechain: true,
			}),
			assistant({
				sessionId,
				timestamp: "2026-01-01T00:00:04.000Z",
				id: "msg-child",
				input: 2,
				output: 6,
				cacheRead: 20,
				cacheCreation: 7,
				isSidechain: true,
			}),
		].join("\n"),
	);
}

function seedQuery(args: {
	db: Database;
	sessionId?: string;
	providerSessionId?: string;
	queryId?: number;
	usageQueryId?: number;
	input?: number;
}): void {
	const sessionId = args.sessionId ?? "hlid-session";
	const providerSessionId = args.providerSessionId ?? "claude-root";
	const queryId = args.queryId ?? 1;
	const usageQueryId = args.usageQueryId ?? 11;
	const timestamp = Date.parse("2026-01-01T00:00:10.000Z") / 1000;
	const input = args.input ?? 10;
	args.db.run(
		`INSERT INTO sessions
		 (id, provider_session_id, provider_id, started_at,
		  total_input_tokens, total_output_tokens, total_cache_read_tokens,
		  total_cache_creation_tokens)
		 VALUES (?, ?, 'claude', ?, ?, 5, 4, 3)`,
		[sessionId, providerSessionId, timestamp - 10, input],
	);
	args.db.run(
		`INSERT INTO queries
		 (id, session_id, timestamp, cost, estimated_cost, cost_known,
		  input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
		  turns, context_window, tokens_in_context)
		 VALUES (?, ?, ?, 0, 0.1, 1, ?, 5, 4, 3, 1, 200000, 17)`,
		[queryId, sessionId, timestamp, input],
	);
	args.db.run(
		`INSERT INTO usage_queries
		 (id, session_id, timestamp, cost, estimated_cost, cost_known, unpriced,
		  input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
		  turns, provider_id)
		 VALUES (?, ?, ?, 0, 0.1, 1, 0, ?, 5, 4, 3, 1, 'claude')`,
		[usageQueryId, sessionId, timestamp, input],
	);
	args.db.run(
		`INSERT OR REPLACE INTO usage_daily
		 (date, estimated_cost, queries, input_tokens, output_tokens,
		  cache_read_tokens, cache_creation_tokens, turns)
		 VALUES (DATE(?, 'unixepoch', 'localtime'), 0.1, 1, ?, 5, 4, 3, 1)`,
		[timestamp, input],
	);
}

describe("Claude usage repair", () => {
	it("does not re-audit exact provider-history rows", async () => {
		const db = makeDb();
		seedQuery({ db });
		db.run("UPDATE sessions SET history_imported = 1");

		const manifest = await planClaudeUsageRepair({
			db,
			transcriptRoots: [],
		});
		expect(manifest.rows).toEqual([]);
		expect(manifest.unresolved).toEqual([]);
	});

	it("repairs only exact root fingerprints and deduplicates child message ids", async () => {
		const root = await tempDir();
		await writeTranscripts({ root });
		const db = makeDb();
		seedQuery({ db });

		const manifest = await planClaudeUsageRepair({
			db,
			transcriptRoots: [root],
		});
		expect(manifest.unresolved).toEqual([]);
		expect(manifest.rows).toHaveLength(1);
		expect(manifest.rows[0]).toMatchObject({
			evidence: {
				promptId: "prompt-1",
				rootMessageIds: ["msg-root"],
				childMessageIds: ["msg-child"],
			},
			corrected: {
				inputTokens: 12,
				outputTokens: 11,
				cacheReadTokens: 24,
				cacheCreationTokens: 10,
			},
		});

		expect(applyClaudeUsageRepair(db, manifest)).toEqual({
			appliedRows: 1,
			alreadyCorrectRows: 0,
			affectedSessions: 1,
			affectedDates: 1,
		});
		expect(
			db
				.query(
					`SELECT input_tokens, output_tokens, cache_read_tokens,
				        cache_creation_tokens FROM queries WHERE id = 1`,
				)
				.get(),
		).toEqual({
			input_tokens: 12,
			output_tokens: 11,
			cache_read_tokens: 24,
			cache_creation_tokens: 10,
		});
		expect(
			db
				.query(
					`SELECT input_tokens, output_tokens, cache_read_tokens,
				        cache_creation_tokens FROM usage_queries WHERE id = 11`,
				)
				.get(),
		).toEqual({
			input_tokens: 12,
			output_tokens: 11,
			cache_read_tokens: 24,
			cache_creation_tokens: 10,
		});
		const replanned = await planClaudeUsageRepair({
			db,
			transcriptRoots: [root],
		});
		expect(replanned.rows).toEqual([]);
		expect(replanned.unresolved).toEqual([]);
		expect(applyClaudeUsageRepair(db, manifest)).toMatchObject({
			appliedRows: 0,
			alreadyCorrectRows: 1,
		});
	});

	it("leaves a row untouched when its stored buckets are not the root total", async () => {
		const root = await tempDir();
		await writeTranscripts({ root });
		const db = makeDb();
		seedQuery({ db, input: 9 });

		const manifest = await planClaudeUsageRepair({
			db,
			transcriptRoots: [root],
		});
		expect(manifest.rows).toEqual([]);
		expect(manifest.unresolved).toEqual([
			expect.objectContaining({ reason: "root-fingerprint-mismatch" }),
		]);
	});

	it("leaves every duplicate provider-session owner untouched", async () => {
		const root = await tempDir();
		await writeTranscripts({ root });
		const db = makeDb();
		seedQuery({ db });
		seedQuery({
			db,
			sessionId: "hlid-session-2",
			queryId: 2,
			usageQueryId: 12,
		});

		const manifest = await planClaudeUsageRepair({
			db,
			transcriptRoots: [root],
		});
		expect(manifest.rows).toEqual([]);
		expect(
			manifest.unresolved.filter(
				(item) => item.reason === "duplicate-provider-session",
			),
		).toHaveLength(2);
	});
});
