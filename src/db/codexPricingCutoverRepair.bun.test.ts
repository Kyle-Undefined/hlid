import { Database } from "bun:sqlite";
import { describe, expect, it } from "vitest";
import {
	OPENAI_GPT_56_TERRA_LUNA_PRICE_CUTOVER_SECONDS,
	repairCodexPricingCutover,
} from "./codexPricingCutoverRepair";

function testDatabase(): Database {
	const db = new Database(":memory:");
	db.run(`
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			provider_id TEXT NOT NULL,
			model TEXT,
			selected_model TEXT,
			actual_model TEXT,
			total_estimated_cost REAL NOT NULL DEFAULT 0
		)
	`);
	db.run(`
		CREATE TABLE queries (
			id INTEGER PRIMARY KEY,
			session_id TEXT,
			timestamp INTEGER NOT NULL,
			provider_id TEXT,
			model TEXT,
			estimated_cost REAL
		)
	`);
	db.run(`
		CREATE TABLE usage_queries (
			id INTEGER PRIMARY KEY,
			session_id TEXT,
			timestamp INTEGER NOT NULL,
			provider_id TEXT NOT NULL,
			model TEXT,
			cost REAL NOT NULL DEFAULT 0,
			estimated_cost REAL,
			unpriced INTEGER NOT NULL DEFAULT 0,
			input_tokens INTEGER NOT NULL DEFAULT 0,
			output_tokens INTEGER NOT NULL DEFAULT 0,
			cache_read_tokens INTEGER NOT NULL DEFAULT 0,
			cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
			turns INTEGER NOT NULL DEFAULT 0
		)
	`);
	db.run(`
		CREATE TABLE usage_daily (
			date TEXT PRIMARY KEY,
			cost REAL NOT NULL DEFAULT 0,
			estimated_cost REAL NOT NULL DEFAULT 0,
			unpriced_queries INTEGER NOT NULL DEFAULT 0,
			queries INTEGER NOT NULL DEFAULT 0,
			input_tokens INTEGER NOT NULL DEFAULT 0,
			output_tokens INTEGER NOT NULL DEFAULT 0,
			cache_read_tokens INTEGER NOT NULL DEFAULT 0,
			cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
			turns INTEGER NOT NULL DEFAULT 0
		)
	`);
	return db;
}

describe("Codex Terra/Luna pricing cutover repair", () => {
	it("reprices post-cutover built-in estimates and rebuilds their aggregates", () => {
		const db = testDatabase();
		const before = OPENAI_GPT_56_TERRA_LUNA_PRICE_CUTOVER_SECONDS - 43_200;
		const after = OPENAI_GPT_56_TERRA_LUNA_PRICE_CUTOVER_SECONDS + 43_200;
		const sessions = [
			["before", "codex", "gpt-5.6-terra", 10],
			["terra", "codex", "gpt-5.6-terra", 10],
			["luna", "codex", "gpt-5.6-luna", 10],
			["sol", "codex", "gpt-5.6-sol", 10],
			["proxy", "cliproxy:codex", "openai/gpt-5.6-luna(high)", 5],
		] as const;
		for (const [id, provider, model, total] of sessions) {
			db.run(
				`INSERT INTO sessions
				 (id, provider_id, model, total_estimated_cost)
				 VALUES (?, ?, ?, ?)`,
				[id, provider, model, total],
			);
		}
		const rows = [
			[1, "before", before, "codex", "gpt-5.6-terra", 10],
			[2, "terra", after, "codex", "gpt-5.6-terra", 10],
			[3, "luna", after, "codex", "gpt-5.6-luna", 10],
			[4, "sol", after, "codex", "gpt-5.6-sol", 10],
			[5, "proxy", after, "cliproxy:codex", "openai/gpt-5.6-luna(high)", 5],
		] as const;
		for (const row of rows) {
			db.run(
				`INSERT INTO queries
					 (id, session_id, timestamp, provider_id, model, estimated_cost)
					 VALUES (?, ?, ?, ?, ?, ?)`,
				[...row],
			);
			db.run(
				`INSERT INTO usage_queries
					 (id, session_id, timestamp, provider_id, model, estimated_cost, turns)
					 VALUES (?, ?, ?, ?, ?, ?, 1)`,
				[...row],
			);
		}
		db.run(
			`INSERT INTO usage_queries
			 (id, session_id, timestamp, provider_id, model, estimated_cost, turns)
			 VALUES (6, NULL, ?, 'codex', 'gpt-5.6-luna', 4, 1)`,
			[after],
		);
		db.run(
			`INSERT INTO usage_daily (date, estimated_cost, queries)
			 VALUES (DATE(?, 'unixepoch', 'localtime'), 999, 99)`,
			[after],
		);

		expect(repairCodexPricingCutover(db)).toEqual({
			queryRows: 3,
			usageQueryRows: 4,
		});
		expect(
			db
				.query<{ id: string; total_estimated_cost: number }, []>(
					`SELECT id, total_estimated_cost FROM sessions ORDER BY id`,
				)
				.all(),
		).toEqual([
			{ id: "before", total_estimated_cost: 10 },
			{ id: "luna", total_estimated_cost: 2 },
			{ id: "proxy", total_estimated_cost: 1 },
			{ id: "sol", total_estimated_cost: 10 },
			{ id: "terra", total_estimated_cost: 8 },
		]);
		expect(
			db
				.query<{ id: number; estimated_cost: number }, []>(
					`SELECT id, estimated_cost FROM usage_queries ORDER BY id`,
				)
				.all(),
		).toEqual([
			{ id: 1, estimated_cost: 10 },
			{ id: 2, estimated_cost: 8 },
			{ id: 3, estimated_cost: 2 },
			{ id: 4, estimated_cost: 10 },
			{ id: 5, estimated_cost: 1 },
			{ id: 6, estimated_cost: 0.8 },
		]);
		const repairedDate = db
			.query<{ estimated_cost: number; queries: number }, [number]>(
				`SELECT estimated_cost, queries FROM usage_daily
				 WHERE date = DATE(?, 'unixepoch', 'localtime')`,
			)
			.get(after);
		expect(repairedDate).toEqual({ estimated_cost: 21.8, queries: 5 });
		db.close();
	});
});
