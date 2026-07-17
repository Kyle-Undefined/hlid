import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyCodexUsageRepair,
	loadCodexRollouts,
	planCodexUsageRepair,
	tokenBucketTotal,
} from "./codexUsageRepair";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirs
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("Codex rollout duplicate selection", () => {
	it("recovers snake-case cache-write input tokens from rollout snapshots", async () => {
		const root = await tempDir();
		const start = Date.parse("2026-04-01T00:00:00Z") / 1000;
		await writeRollout(root, "rollout-cache-write.jsonl", [
			event("2026-04-01T00:00:00.000Z", "session_meta", {
				id: "cache-write-thread",
				timestamp: "2026-04-01T00:00:00.000Z",
			}),
			event("2026-04-01T00:00:00.100Z", "event_msg", {
				type: "task_started",
				turn_id: "turn-1",
				started_at: start,
			}),
			tokenCount({
				timestamp: "2026-04-01T00:00:01.000Z",
				totalInput: 120,
				totalCached: 40,
				totalCreated: 5,
				totalOutput: 10,
				lastInput: 120,
				lastCached: 40,
				lastCreated: 5,
				lastOutput: 10,
			}),
			event("2026-04-01T00:00:02.000Z", "event_msg", {
				type: "task_complete",
				turn_id: "turn-1",
				completed_at: start + 2,
			}),
		]);

		const rollout = (await loadCodexRollouts([root])).get("cache-write-thread");
		expect(rollout?.turns[0]?.increments[0]?.usage).toEqual({
			inputTokens: 75,
			outputTokens: 10,
			cacheReadTokens: 40,
			cacheCreationTokens: 5,
		});
	});

	it("chooses the richer terminal/evidence copy independent of root order", async () => {
		const root = await tempDir();
		const staleRoot = join(root, "stale");
		const richRoot = join(root, "rich");
		await mkdir(staleRoot, { recursive: true });
		await mkdir(richRoot, { recursive: true });
		const start = Date.parse("2026-04-01T00:00:00Z") / 1000;
		const prefix = [
			event("2026-04-01T00:00:00.000Z", "session_meta", {
				id: "duplicate-thread",
				session_id: "duplicate-thread",
				timestamp: "2026-04-01T00:00:00.000Z",
			}),
			event("2026-04-01T00:00:00.100Z", "event_msg", {
				type: "task_started",
				turn_id: "turn-1",
				started_at: start,
			}),
		];
		const firstUsage = tokenCount({
			timestamp: "2026-04-01T00:00:01.000Z",
			totalInput: 100,
			totalCached: 40,
			totalOutput: 10,
			lastInput: 100,
			lastCached: 40,
			lastOutput: 10,
		});
		const terminal = event("2026-04-01T00:00:10.000Z", "event_msg", {
			type: "task_complete",
			turn_id: "turn-1",
			completed_at: start + 10,
		});
		await writeRollout(staleRoot, "rollout-stale.jsonl", [
			...prefix,
			firstUsage,
			terminal,
		]);
		await writeRollout(richRoot, "rollout-rich.jsonl", [
			...prefix,
			firstUsage,
			tokenCount({
				timestamp: "2026-04-01T00:00:05.000Z",
				totalInput: 180,
				totalCached: 70,
				totalOutput: 25,
				lastInput: 80,
				lastCached: 30,
				lastOutput: 15,
			}),
			terminal,
		]);

		for (const roots of [
			[staleRoot, richRoot],
			[richRoot, staleRoot],
		]) {
			const selected = (await loadCodexRollouts(roots)).get("duplicate-thread");
			expect(selected?.path).toBe(join(richRoot, "rollout-rich.jsonl"));
			expect(selected?.turns[0]?.increments).toHaveLength(2);
		}
	});
});

describe("legacy Codex rollout parsing", () => {
	it("recovers completed user/agent turns that predate task lifecycle events", async () => {
		const root = await tempDir();
		await writeRollout(root, "rollout-legacy.jsonl", [
			event("2026-02-03T12:00:00.000Z", "session_meta", {
				id: "legacy-thread",
				timestamp: "2026-02-03T12:00:00.000Z",
				originator: "codex_vscode",
			}),
			event("2026-02-03T12:00:01.000Z", "event_msg", {
				type: "user_message",
			}),
			tokenCount({
				timestamp: "2026-02-03T12:00:02.000Z",
				totalInput: 100,
				totalCached: 40,
				totalOutput: 10,
				lastInput: 100,
				lastCached: 40,
				lastOutput: 10,
			}),
			event("2026-02-03T12:00:03.000Z", "event_msg", {
				type: "agent_message",
			}),
			tokenCount({
				timestamp: "2026-02-03T12:00:04.000Z",
				totalInput: 150,
				totalCached: 60,
				totalOutput: 20,
				lastInput: 50,
				lastCached: 20,
				lastOutput: 10,
			}),
			event("2026-02-03T12:00:59.000Z", "event_msg", {
				type: "thread_name_updated",
			}),
			event("2026-02-03T12:01:00.000Z", "event_msg", {
				type: "user_message",
			}),
			tokenCount({
				timestamp: "2026-02-03T12:01:01.000Z",
				totalInput: 180,
				totalCached: 70,
				totalOutput: 30,
				lastInput: 30,
				lastCached: 10,
				lastOutput: 10,
			}),
			event("2026-02-03T12:01:02.000Z", "event_msg", {
				type: "agent_message",
			}),
		]);

		const rollout = (await loadCodexRollouts([root])).get("legacy-thread");
		expect(rollout?.turns).toHaveLength(2);
		expect(rollout?.turns.map((turn) => turn.terminal)).toEqual([
			"completed",
			"completed",
		]);
		expect(
			rollout?.turns.map((turn) =>
				turn.increments.reduce(
					(total, increment) => total + tokenBucketTotal(increment.usage),
					0,
				),
			),
		).toEqual([170, 40]);
		expect(rollout?.turns[0].endedAtMs).toBe(
			Date.parse("2026-02-03T12:00:04.000Z"),
		);
	});
});

async function tempDir(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "hlid-codex-repair-test-"));
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
			model TEXT,
			selected_model TEXT,
			actual_model TEXT,
			total_input_tokens INTEGER DEFAULT 0,
			total_output_tokens INTEGER DEFAULT 0,
			total_cache_read_tokens INTEGER DEFAULT 0,
			total_cache_creation_tokens INTEGER DEFAULT 0,
			total_estimated_cost REAL DEFAULT 0,
			unpriced_query_count INTEGER DEFAULT 0,
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
			cost_known INTEGER NOT NULL DEFAULT 0,
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
			cost_known INTEGER NOT NULL DEFAULT 0,
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
	db.run(`
		CREATE TABLE tool_events (
			id INTEGER PRIMARY KEY,
			session_id TEXT NOT NULL,
			name TEXT NOT NULL,
			subagent_json TEXT
		)
	`);
	return db;
}

function event(timestamp: string, type: string, payload: unknown): string {
	return JSON.stringify({ timestamp, type, payload });
}

function tokenCount(args: {
	timestamp: string;
	totalInput: number;
	totalCached: number;
	totalOutput: number;
	lastInput: number;
	lastCached: number;
	lastOutput: number;
	totalCreated?: number;
	lastCreated?: number;
}): string {
	return event(args.timestamp, "event_msg", {
		type: "token_count",
		info: {
			total_token_usage: {
				input_tokens: args.totalInput,
				cached_input_tokens: args.totalCached,
				...(args.totalCreated == null
					? {}
					: { cache_write_input_tokens: args.totalCreated }),
				output_tokens: args.totalOutput,
			},
			last_token_usage: {
				input_tokens: args.lastInput,
				cached_input_tokens: args.lastCached,
				...(args.lastCreated == null
					? {}
					: { cache_write_input_tokens: args.lastCreated }),
				output_tokens: args.lastOutput,
			},
			model_context_window: 258_400,
		},
	});
}

async function writeRollout(
	root: string,
	name: string,
	lines: string[],
): Promise<void> {
	await Bun.write(join(root, name), `${lines.join("\n")}\n`);
}

function seedQuery(args: {
	db: Database;
	sessionId?: string;
	threadId?: string;
	timestamp: number;
	input: number;
	cached: number;
	output: number;
}): void {
	const sessionId = args.sessionId ?? "session-1";
	const threadId = args.threadId ?? "thread-root";
	args.db.run(
		`INSERT OR IGNORE INTO sessions
		 (id, provider_session_id, provider_id, started_at, model,
		  total_input_tokens, total_output_tokens, total_cache_read_tokens,
		  total_cache_creation_tokens, total_estimated_cost, unpriced_query_count)
		 VALUES (?, ?, 'codex', ?, 'gpt-5.6-sol', ?, ?, ?, 0, 0.1, 0)`,
		[
			sessionId,
			threadId,
			args.timestamp - 20,
			args.input,
			args.output,
			args.cached,
		],
	);
	args.db.run(
		`INSERT INTO queries
		 (id, session_id, timestamp, cost, estimated_cost, input_tokens,
		  output_tokens, cache_read_tokens, cache_creation_tokens, turns,
		  context_window, tokens_in_context)
		 VALUES (1, ?, ?, 0, 0.1, ?, ?, ?, 0, 1, 258400, 80)`,
		[sessionId, args.timestamp, args.input, args.output, args.cached],
	);
	args.db.run(
		`INSERT INTO usage_queries
		 (id, session_id, timestamp, cost, estimated_cost, unpriced,
		  input_tokens, output_tokens, cache_read_tokens,
		  cache_creation_tokens, turns, provider_id)
		 VALUES (1, ?, ?, 0, 0.1, 0, ?, ?, ?, 0, 1, 'codex')`,
		[sessionId, args.timestamp, args.input, args.output, args.cached],
	);
	args.db.run(
		`INSERT OR REPLACE INTO usage_daily
		 (date, estimated_cost, queries, input_tokens, output_tokens,
		  cache_read_tokens, turns)
		 VALUES (DATE(?, 'unixepoch', 'localtime'), 0.1, 1, ?, ?, ?, 1)`,
		[args.timestamp, args.input, args.output, args.cached],
	);
}

describe("Codex usage repair", () => {
	it("does not re-audit exact provider-history rows", async () => {
		const db = makeDb();
		seedQuery({
			db,
			threadId: "history-thread",
			timestamp: Date.parse("2026-01-01T00:00:10Z") / 1000,
			input: 10,
			cached: 4,
			output: 2,
		});
		db.run("UPDATE sessions SET history_imported = 1");

		const manifest = await planCodexUsageRepair({ db, rolloutRoots: [] });
		expect(manifest.rows).toEqual([]);
		expect(manifest.unresolved).toEqual([]);
	});

	it("replays cumulative calls and strips copied parent history from children", async () => {
		const root = await tempDir();
		const start = Date.parse("2026-01-01T00:00:00Z") / 1000;
		await writeRollout(root, "rollout-root.jsonl", [
			event("2026-01-01T00:00:00.000Z", "session_meta", {
				id: "thread-root",
				session_id: "thread-root",
				timestamp: "2026-01-01T00:00:00.000Z",
				originator: "hlid",
			}),
			event("2026-01-01T00:00:00.100Z", "event_msg", {
				type: "task_started",
				turn_id: "root-turn",
				started_at: start,
			}),
			event("2026-01-01T00:00:00.200Z", "turn_context", {
				turn_id: "root-turn",
				model: "gpt-5.6-sol",
			}),
			tokenCount({
				timestamp: "2026-01-01T00:00:01.000Z",
				totalInput: 100,
				totalCached: 40,
				totalOutput: 10,
				lastInput: 100,
				lastCached: 40,
				lastOutput: 10,
			}),
			event("2026-01-01T00:00:01.500Z", "event_msg", {
				type: "sub_agent_activity",
				kind: "started",
				agent_thread_id: "thread-child",
			}),
			tokenCount({
				timestamp: "2026-01-01T00:00:09.000Z",
				totalInput: 180,
				totalCached: 70,
				totalOutput: 25,
				lastInput: 80,
				lastCached: 30,
				lastOutput: 15,
			}),
			event("2026-01-01T00:00:10.000Z", "event_msg", {
				type: "task_complete",
				turn_id: "root-turn",
				completed_at: start + 10,
			}),
		]);
		await writeRollout(root, "rollout-child.jsonl", [
			event("2026-01-01T00:00:02.000Z", "session_meta", {
				id: "thread-child",
				session_id: "thread-root",
				parent_thread_id: "thread-root",
				forked_from_id: "thread-root",
				timestamp: "2026-01-01T00:00:02.000Z",
				originator: "hlid",
			}),
			// Copied parent history is deliberately huge and must not be counted.
			event("2026-01-01T00:00:00.100Z", "event_msg", {
				type: "task_started",
				turn_id: "root-turn",
				started_at: start,
			}),
			tokenCount({
				timestamp: "2026-01-01T00:00:01.000Z",
				totalInput: 50_000,
				totalCached: 40_000,
				totalOutput: 5_000,
				lastInput: 50_000,
				lastCached: 40_000,
				lastOutput: 5_000,
			}),
			event("2026-01-01T00:00:03.000Z", "event_msg", {
				type: "task_started",
				turn_id: "child-turn",
				started_at: start + 3,
			}),
			event("2026-01-01T00:00:03.100Z", "turn_context", {
				turn_id: "child-turn",
				model: "gpt-5.6-sol",
			}),
			tokenCount({
				timestamp: "2026-01-01T00:00:04.000Z",
				totalInput: 50,
				totalCached: 20,
				totalOutput: 5,
				lastInput: 50,
				lastCached: 20,
				lastOutput: 5,
			}),
			event("2026-01-01T00:00:08.000Z", "event_msg", {
				type: "task_complete",
				turn_id: "child-turn",
				completed_at: start + 8,
			}),
		]);

		const db = makeDb();
		seedQuery({
			db,
			timestamp: start + 12,
			// Legacy root final call + legacy child final call.
			input: 80,
			cached: 50,
			output: 20,
		});
		const manifest = await planCodexUsageRepair({ db, rolloutRoots: [root] });
		expect(manifest.rows).toHaveLength(1);
		expect(manifest.rows[0].corrected.usage).toEqual({
			inputTokens: 140,
			outputTokens: 30,
			cacheReadTokens: 90,
			cacheCreationTokens: 0,
		});
		expect(manifest.rows[0].evidence.childThreadIds).toEqual(["thread-child"]);
		expect(tokenBucketTotal(manifest.totals.after)).toBe(260);

		const applied = applyCodexUsageRepair(db, manifest);
		expect(applied.appliedRows).toBe(1);
		expect(
			db
				.query(
					`SELECT input_tokens, output_tokens, cache_read_tokens,
					        cache_creation_tokens, cost_known FROM queries WHERE id = 1`,
				)
				.get(),
		).toEqual({
			input_tokens: 140,
			output_tokens: 30,
			cache_read_tokens: 90,
			cache_creation_tokens: 0,
			cost_known: 1,
		});
		expect(
			db.query(`SELECT cost_known FROM usage_queries WHERE id = 1`).get(),
		).toEqual({ cost_known: 1 });
		expect(applyCodexUsageRepair(db, manifest)).toMatchObject({
			appliedRows: 0,
			alreadyCorrectRows: 1,
		});
		db.close();
	});

	it("rejects a stale manifest when its mirrored rows move sessions", async () => {
		const root = await tempDir();
		const start = Date.parse("2026-01-15T00:00:00Z") / 1000;
		await writeRollout(root, "rollout-root.jsonl", [
			event("2026-01-15T00:00:00.000Z", "session_meta", {
				id: "thread-root",
				session_id: "thread-root",
				timestamp: "2026-01-15T00:00:00.000Z",
				originator: "hlid",
			}),
			event("2026-01-15T00:00:00.100Z", "event_msg", {
				type: "task_started",
				turn_id: "root-turn",
				started_at: start,
			}),
			tokenCount({
				timestamp: "2026-01-15T00:00:01.000Z",
				totalInput: 100,
				totalCached: 40,
				totalOutput: 10,
				lastInput: 100,
				lastCached: 40,
				lastOutput: 10,
			}),
			event("2026-01-15T00:00:10.000Z", "event_msg", {
				type: "task_complete",
				turn_id: "root-turn",
				completed_at: start + 10,
			}),
		]);
		const db = makeDb();
		seedQuery({
			db,
			timestamp: start + 12,
			input: 60,
			cached: 40,
			output: 10,
		});
		const manifest = await planCodexUsageRepair({
			db,
			rolloutRoots: [root],
		});
		expect(manifest.rows).toHaveLength(1);
		expect(manifest.rows[0].corrected.usage).toEqual({
			inputTokens: 60,
			outputTokens: 10,
			cacheReadTokens: 40,
			cacheCreationTokens: 0,
		});

		db.run(
			`INSERT INTO sessions
			 (id, provider_session_id, provider_id, started_at, model)
			 VALUES ('session-2', 'thread-other', 'codex', ?, 'gpt-5.6-sol')`,
			[start],
		);
		db.run(`UPDATE queries SET session_id = 'session-2' WHERE id = 1`);
		db.run(`UPDATE usage_queries SET session_id = 'session-2' WHERE id = 1`);

		expect(() => applyCodexUsageRepair(db, manifest)).toThrow(
			"Repair fingerprint changed for query 1; no rows were updated",
		);
		expect(
			db.query(`SELECT session_id FROM queries WHERE id = 1`).get(),
		).toEqual({ session_id: "session-2" });
		db.close();
	});

	it("excludes queries whose ephemeral Windows worker rollout is unavailable", async () => {
		const root = await tempDir();
		const start = Date.parse("2026-02-01T00:00:00Z") / 1000;
		await writeRollout(root, "rollout-root.jsonl", [
			event("2026-02-01T00:00:00.000Z", "session_meta", {
				id: "thread-root",
				session_id: "thread-root",
				timestamp: "2026-02-01T00:00:00.000Z",
				originator: "hlid",
			}),
			event("2026-02-01T00:00:00.100Z", "event_msg", {
				type: "task_started",
				turn_id: "root-turn",
				started_at: start,
			}),
			tokenCount({
				timestamp: "2026-02-01T00:00:01.000Z",
				totalInput: 100,
				totalCached: 40,
				totalOutput: 10,
				lastInput: 100,
				lastCached: 40,
				lastOutput: 10,
			}),
			event("2026-02-01T00:00:10.000Z", "event_msg", {
				type: "task_complete",
				turn_id: "root-turn",
				completed_at: start + 10,
			}),
		]);
		const db = makeDb();
		seedQuery({
			db,
			timestamp: start + 12,
			input: 60,
			cached: 40,
			output: 10,
		});
		db.run(
			`INSERT INTO tool_events (id, session_id, name, subagent_json)
			 VALUES (1, 'session-1', 'windows_computer_use', ?)`,
			[
				JSON.stringify({
					agentId: "ephemeral-worker",
					startedAtMs: (start + 2) * 1000,
					endedAtMs: (start + 8) * 1000,
				}),
			],
		);
		const manifest = await planCodexUsageRepair({ db, rolloutRoots: [root] });
		expect(manifest.rows).toHaveLength(0);
		expect(manifest.unresolved).toContainEqual(
			expect.objectContaining({
				queryId: 1,
				reason: "unrecoverable-windows-worker",
			}),
		);
		db.run(`UPDATE usage_queries SET provider_id = 'claude' WHERE id = 1`);
		const providerManifest = await planCodexUsageRepair({
			db,
			rolloutRoots: [root],
		});
		expect(providerManifest.providerCorrections).toHaveLength(1);
		expect(applyCodexUsageRepair(db, providerManifest)).toMatchObject({
			appliedRows: 0,
			correctedProviderRows: 1,
		});
		expect(
			db.query("SELECT provider_id FROM usage_queries WHERE id = 1").get(),
		).toEqual({ provider_id: "codex" });
		expect(applyCodexUsageRepair(db, providerManifest)).toMatchObject({
			correctedProviderRows: 0,
			alreadyCorrectProviderRows: 1,
		});
		db.close();
	});

	it("ignores repeated totals, handles a cumulative reset, and marks unknown models unpriced", async () => {
		const root = await tempDir();
		const start = Date.parse("2026-03-01T00:00:00Z") / 1000;
		await writeRollout(root, "rollout-root.jsonl", [
			event("2026-03-01T00:00:00.000Z", "session_meta", {
				id: "thread-root",
				session_id: "thread-root",
				timestamp: "2026-03-01T00:00:00.000Z",
				originator: "hlid",
			}),
			event("2026-03-01T00:00:00.100Z", "event_msg", {
				type: "task_started",
				turn_id: "root-turn",
				started_at: start,
			}),
			event("2026-03-01T00:00:00.200Z", "turn_context", {
				turn_id: "root-turn",
				model: "unpriced-preview-model",
			}),
			tokenCount({
				timestamp: "2026-03-01T00:00:01.000Z",
				totalInput: 100,
				totalCached: 40,
				totalOutput: 10,
				lastInput: 100,
				lastCached: 40,
				lastOutput: 10,
			}),
			// Notification duplicate: no cumulative advance and therefore no call.
			tokenCount({
				timestamp: "2026-03-01T00:00:02.000Z",
				totalInput: 100,
				totalCached: 40,
				totalOutput: 10,
				lastInput: 100,
				lastCached: 40,
				lastOutput: 10,
			}),
			// A lower total uses the exact last-call payload as a reset baseline.
			tokenCount({
				timestamp: "2026-03-01T00:00:03.000Z",
				totalInput: 50,
				totalCached: 20,
				totalOutput: 5,
				lastInput: 50,
				lastCached: 20,
				lastOutput: 5,
			}),
			event("2026-03-01T00:00:10.000Z", "event_msg", {
				type: "task_complete",
				turn_id: "root-turn",
				completed_at: start + 10,
			}),
		]);
		const db = makeDb();
		seedQuery({
			db,
			timestamp: start + 12,
			input: 30,
			cached: 20,
			output: 5,
		});
		db.run(
			`UPDATE sessions SET model = 'unpriced-preview-model' WHERE id = 'session-1'`,
		);
		const manifest = await planCodexUsageRepair({ db, rolloutRoots: [root] });
		expect(manifest.rows).toHaveLength(1);
		expect(manifest.rows[0].corrected).toEqual({
			usage: {
				inputTokens: 90,
				outputTokens: 15,
				cacheReadTokens: 60,
				cacheCreationTokens: 0,
			},
			estimatedCost: null,
			unpriced: 1,
		});

		// A provider-reported zero is still a known actual cost. Repricing must
		// preserve that provenance even when the model has no published estimate.
		db.run(`UPDATE queries SET cost_known = 1 WHERE id = 1`);
		db.run(
			`UPDATE usage_queries SET cost_known = 1, unpriced = 0 WHERE id = 1`,
		);
		const knownZeroManifest = await planCodexUsageRepair({
			db,
			rolloutRoots: [root],
		});
		expect(knownZeroManifest.rows[0].corrected.unpriced).toBe(0);
		expect(applyCodexUsageRepair(db, knownZeroManifest).appliedRows).toBe(1);
		expect(
			db
				.query(`SELECT cost_known, estimated_cost FROM queries WHERE id = 1`)
				.get(),
		).toEqual({ cost_known: 1, estimated_cost: null });
		expect(
			db
				.query(
					`SELECT cost_known, estimated_cost, unpriced FROM usage_queries WHERE id = 1`,
				)
				.get(),
		).toEqual({ cost_known: 1, estimated_cost: null, unpriced: 0 });
		db.close();
	});
});
