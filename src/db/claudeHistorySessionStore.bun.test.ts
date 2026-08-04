import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type {
	SessionKey,
	SessionStore,
	SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { createClaudeHistorySessionStore } from "../server/claudeHistorySessionStore";
import { setDbForTest } from "./schema";

let db: Database;
let store: SessionStore;

const key: SessionKey = {
	projectKey: "/work/project",
	sessionId: "native-session",
};

beforeEach(() => {
	db = new Database(":memory:");
	setDbForTest(db);
	store = createClaudeHistorySessionStore();
});

afterEach(() => db.close());

describe("Claude history session store", () => {
	it("keeps the imported base immutable and deduplicates only UUID entries", async () => {
		const base: SessionStoreEntry[] = [
			{ type: "user", uuid: "base-1", message: "base" },
			{ type: "system", marker: "base-without-uuid" },
		];
		const basePayload = JSON.stringify(base);
		db.run(
			`INSERT INTO provider_history_transcripts
			 (provider_id, native_session_id, subpath, source_path, source_hash,
			  payload_json, entry_count)
			 VALUES ('claude', ?, '', 'source.jsonl', 'source-hash', ?, ?)`,
			[key.sessionId, basePayload, base.length],
		);

		await store.append(key, [
			{ type: "user", uuid: "base-1", message: "retry" },
			{ type: "assistant", uuid: "delta-1", message: "new" },
			{ type: "system", marker: "delta-without-uuid" },
		]);
		await store.append(key, [
			{ type: "assistant", uuid: "delta-1", message: "retry" },
			{ type: "system", marker: "delta-without-uuid" },
		]);

		expect(await store.load(key)).toEqual([
			...base,
			{ type: "assistant", uuid: "delta-1", message: "new" },
			{ type: "system", marker: "delta-without-uuid" },
			{ type: "system", marker: "delta-without-uuid" },
		]);
		expect(
			db
				.query<
					{
						payload_json: string;
						source_path: string;
						source_hash: string;
						entry_count: number;
					},
					[]
				>(`
					SELECT payload_json, source_path, source_hash, entry_count
					FROM provider_history_transcripts
					WHERE provider_id = 'claude'
					  AND native_session_id = 'native-session' AND subpath = ''
				`)
				.get(),
		).toEqual({
			payload_json: basePayload,
			source_path: "source.jsonl",
			source_hash: "source-hash",
			entry_count: 5,
		});
		expect(
			db
				.query<{ count: number }, []>(
					`SELECT COUNT(*) AS count FROM provider_history_transcript_deltas`,
				)
				.get()?.count,
		).toBe(3);
	});

	it("serializes concurrent appends without losing or duplicating entries", async () => {
		await Promise.all([
			store.append(key, [
				{ type: "user", uuid: "shared", message: "first" },
				{ type: "system", marker: "first" },
			]),
			store.append(key, [
				{ type: "user", uuid: "shared", message: "retry" },
				{ type: "assistant", uuid: "second", message: "second" },
			]),
		]);

		expect(await store.load(key)).toEqual([
			{ type: "user", uuid: "shared", message: "first" },
			{ type: "system", marker: "first" },
			{ type: "assistant", uuid: "second", message: "second" },
		]);
	});

	it("appends by insert outcome without scanning or recounting delta rows", async () => {
		db.run(
			`INSERT INTO provider_history_transcripts
			 (provider_id, native_session_id, subpath, source_path, source_hash,
			  payload_json, entry_count)
			 VALUES ('claude', ?, '', 'source.jsonl', 'source-hash', '[]', 1)`,
			[key.sessionId],
		);
		db.run(
			`INSERT INTO provider_history_transcript_deltas
			 (provider_id, native_session_id, subpath, uuid, payload_json)
			 VALUES ('claude', ?, '', 'existing',
			         '{"type":"user","uuid":"existing"}')`,
			[key.sessionId],
		);
		const originalQuery = db.query.bind(db);
		db.query = ((sql: string) => {
			if (sql.includes("provider_history_transcript_deltas")) {
				throw new Error("append queried delta rows");
			}
			return originalQuery(sql);
		}) as typeof db.query;

		try {
			await store.append(key, [
				{ type: "user", uuid: "existing", message: "retry" },
				{ type: "assistant", uuid: "new", message: "new" },
				{ type: "system", marker: "without-uuid" },
			]);
		} finally {
			db.query = originalQuery as typeof db.query;
		}

		expect(
			db
				.query<{ entry_count: number }, []>(`
					SELECT entry_count FROM provider_history_transcripts
					WHERE provider_id = 'claude'
					  AND native_session_id = 'native-session' AND subpath = ''
				`)
				.get()?.entry_count,
		).toBe(3);
		expect(await store.load(key)).toEqual([
			{ type: "user", uuid: "existing" },
			{ type: "assistant", uuid: "new", message: "new" },
			{ type: "system", marker: "without-uuid" },
		]);
	});

	it("stores and lists ordered subagent subkeys independently", async () => {
		await store.append(key, [{ type: "user", uuid: "main" }]);
		await store.append({ ...key, subpath: "subagents/agent-two" }, [
			{ type: "user", uuid: "child-two" },
		]);
		await store.append({ ...key, subpath: "subagents/agent-one" }, [
			{ type: "user", uuid: "child-one" },
		]);

		expect(await store.listSubkeys?.(key)).toEqual([
			"subagents/agent-one",
			"subagents/agent-two",
		]);
		expect(
			await store.load({ ...key, subpath: "subagents/agent-one" }),
		).toEqual([{ type: "user", uuid: "child-one" }]);
	});
});
