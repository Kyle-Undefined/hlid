import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	applyProviderHistoryImport,
	historyTokenTotal,
	planProviderHistoryImport,
} from "./providerHistoryImport";
import { setDbForTest } from "./schema";

type JsonRecord = Record<string, unknown>;

let db: Database;
let scratch: string;

function writeJsonl(path: string, records: JsonRecord[]): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
	);
}

function codexMeta(args: {
	id: string;
	timestamp: string;
	originator?: string;
	parentThreadId?: string;
}): JsonRecord {
	return {
		type: "session_meta",
		timestamp: args.timestamp,
		payload: {
			id: args.id,
			timestamp: args.timestamp,
			originator: args.originator ?? "codex-tui",
			cwd: "/work/project",
			...(args.parentThreadId ? { parent_thread_id: args.parentThreadId } : {}),
		},
	};
}

function codexTaskStarted(
	turnId: string,
	seconds: number,
	timestamp: string,
): JsonRecord {
	return {
		type: "event_msg",
		timestamp,
		payload: { type: "task_started", turn_id: turnId, started_at: seconds },
	};
}

function codexToken(args: {
	timestamp: string;
	input: number;
	output: number;
	lastInput: number;
	lastOutput: number;
	created?: number;
	lastCreated?: number;
}): JsonRecord {
	return {
		type: "event_msg",
		timestamp: args.timestamp,
		payload: {
			type: "token_count",
			info: {
				total: {
					input_tokens: args.input,
					output_tokens: args.output,
					cached_input_tokens: 0,
					...(args.created == null
						? {}
						: { cache_write_input_tokens: args.created }),
				},
				last: {
					input_tokens: args.lastInput,
					output_tokens: args.lastOutput,
					cached_input_tokens: 0,
					...(args.lastCreated == null && args.created == null
						? {}
						: {
								cache_write_input_tokens: args.lastCreated ?? args.created ?? 0,
							}),
				},
				model_context_window: 200_000,
			},
		},
	};
}

function codexTerminal(
	type: "task_complete" | "turn_aborted",
	timestamp: string,
): JsonRecord {
	return { type: "event_msg", timestamp, payload: { type } };
}

function claudeUser(args: {
	sessionId: string;
	uuid: string;
	promptId: string;
	timestamp: string;
	entrypoint?: string;
}): JsonRecord {
	return {
		type: "user",
		sessionId: args.sessionId,
		uuid: args.uuid,
		parentUuid: null,
		promptId: args.promptId,
		timestamp: args.timestamp,
		entrypoint: args.entrypoint ?? "cli",
		cwd: "/work/claude",
		message: { role: "user", content: "fixture prompt" },
	};
}

function claudeAssistant(args: {
	sessionId: string;
	uuid: string;
	parentUuid: string;
	messageId: string;
	timestamp: string;
	input: number;
	output: number;
	read?: number;
	create?: number;
	model?: string;
	sourceToolAssistantUUID?: string;
	isSidechain?: boolean;
}): JsonRecord {
	return {
		type: "assistant",
		sessionId: args.sessionId,
		uuid: args.uuid,
		parentUuid: args.parentUuid,
		timestamp: args.timestamp,
		entrypoint: "cli",
		cwd: "/work/claude",
		...(args.sourceToolAssistantUUID
			? { sourceToolAssistantUUID: args.sourceToolAssistantUUID }
			: {}),
		...(args.isSidechain ? { isSidechain: true } : {}),
		message: {
			id: args.messageId,
			role: "assistant",
			model: args.model ?? "claude-sonnet-4-6",
			stop_reason: "end_turn",
			content: [],
			usage: {
				input_tokens: args.input,
				output_tokens: args.output,
				cache_read_input_tokens: args.read ?? 0,
				cache_creation_input_tokens: args.create ?? 0,
			},
		},
	};
}

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "hlid-provider-history-"));
	db = new Database(":memory:");
	setDbForTest(db);
});

afterEach(() => {
	db.close();
	rmSync(scratch, { recursive: true, force: true });
});

describe("provider history import", () => {
	it("folds Codex child usage, imports aborted turns, and is idempotent", async () => {
		const codexRoot = join(scratch, "codex");
		const rootPath = join(
			codexRoot,
			"2026/07/01/rollout-2026-07-01T00-00-00-root-thread.jsonl",
		);
		const childPath = join(
			codexRoot,
			"2026/07/01/rollout-2026-07-01T00-00-02-child-thread.jsonl",
		);
		writeJsonl(rootPath, [
			codexMeta({
				id: "root-thread",
				timestamp: "2026-07-01T00:00:00.000Z",
			}),
			{
				type: "turn_context",
				timestamp: "2026-07-01T00:00:00.500Z",
				payload: { model: "gpt-5.4" },
			},
			codexTaskStarted("turn-1", 1_782_864_001, "2026-07-01T00:00:01.000Z"),
			codexToken({
				timestamp: "2026-07-01T00:00:02.000Z",
				input: 100,
				output: 10,
				lastInput: 100,
				lastOutput: 10,
				created: 5,
				lastCreated: 5,
			}),
			codexTerminal("task_complete", "2026-07-01T00:00:05.000Z"),
			codexTaskStarted("turn-2", 1_782_864_006, "2026-07-01T00:00:06.000Z"),
			codexToken({
				timestamp: "2026-07-01T00:00:07.000Z",
				input: 130,
				output: 15,
				lastInput: 30,
				lastOutput: 5,
				created: 5,
				lastCreated: 0,
			}),
			codexTerminal("turn_aborted", "2026-07-01T00:00:08.000Z"),
		]);
		writeJsonl(childPath, [
			codexMeta({
				id: "child-thread",
				parentThreadId: "root-thread",
				timestamp: "2026-07-01T00:00:02.100Z",
			}),
			{
				type: "turn_context",
				timestamp: "2026-07-01T00:00:02.200Z",
				payload: { model: "gpt-5.4" },
			},
			codexTaskStarted("child-turn", 1_782_864_002, "2026-07-01T00:00:02.300Z"),
			codexToken({
				timestamp: "2026-07-01T00:00:03.000Z",
				input: 50,
				output: 5,
				lastInput: 50,
				lastOutput: 5,
			}),
			codexTerminal("task_complete", "2026-07-01T00:00:04.000Z"),
			codexTaskStarted(
				"child-late-turn",
				1_782_864_009,
				"2026-07-01T00:00:09.000Z",
			),
			codexToken({
				timestamp: "2026-07-01T00:00:10.000Z",
				input: 70,
				output: 8,
				lastInput: 20,
				lastOutput: 3,
			}),
			codexTerminal("task_complete", "2026-07-01T00:00:11.000Z"),
		]);
		const hlidPath = join(
			codexRoot,
			"2026/07/01/rollout-2026-07-01T00-10-00-hlid-thread.jsonl",
		);
		writeJsonl(hlidPath, [
			codexMeta({
				id: "hlid-thread",
				originator: "hlid",
				timestamp: "2026-07-01T00:10:00.000Z",
			}),
			codexTaskStarted("hlid-turn", 1_782_864_601, "2026-07-01T00:10:01.000Z"),
			codexToken({
				timestamp: "2026-07-01T00:10:02.000Z",
				input: 999,
				output: 9,
				lastInput: 999,
				lastOutput: 9,
			}),
			codexTerminal("task_complete", "2026-07-01T00:10:03.000Z"),
		]);

		const manifest = await planProviderHistoryImport({
			db,
			codexRoots: [codexRoot],
		});
		expect(manifest.sessions).toHaveLength(1);
		expect(manifest.sessions[0].queries).toHaveLength(3);
		expect(manifest.sessions[0].queries[0].usage).toEqual({
			inputTokens: 145,
			outputTokens: 15,
			cacheReadTokens: 0,
			cacheCreationTokens: 5,
		});
		expect(manifest.sessions[0].queries[0].turns).toBe(2);
		expect(manifest.sessions[0].queries[1].stopReason).toBe("aborted");
		expect(manifest.sessions[0].queries[1].usage.inputTokens).toBe(30);
		expect(manifest.sessions[0].queries[2].usage).toEqual({
			inputTokens: 20,
			outputTokens: 3,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
		});
		expect(
			manifest.skipped.some(
				(row) =>
					row.nativeSessionId === "hlid-thread" &&
					row.reason === "originated-in-hlid",
			),
		).toBe(true);

		const applied = await applyProviderHistoryImport(db, manifest);
		expect(applied).toMatchObject({ createdSessions: 1, insertedQueries: 3 });
		expect(
			db
				.query<{ started_at: number; ended_at: number }, []>(
					`SELECT started_at, ended_at FROM sessions WHERE id = 'history:codex:root-thread'`,
				)
				.get(),
		).toEqual({ started_at: 1_782_864_001, ended_at: 1_782_864_011 });
		expect(
			db
				.query<{ tokens: number }, []>(`
					SELECT SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens
					FROM usage_queries WHERE provider_id = 'codex'
				`)
				.get()?.tokens,
		).toBe(223);
		const secondApply = await applyProviderHistoryImport(db, manifest);
		expect(secondApply.insertedQueries).toBe(0);
		expect(secondApply.alreadyImportedQueries).toBe(3);

		const secondPlan = await planProviderHistoryImport({
			db,
			codexRoots: [codexRoot],
		});
		expect(secondPlan.sessions).toHaveLength(0);
		expect(secondPlan.alreadyImported.queries).toBe(3);
	});

	it("imports a child that becomes terminal after its parent was imported", async () => {
		const codexRoot = join(scratch, "codex-incremental");
		const rootPath = join(codexRoot, "rollout-root.jsonl");
		const childPath = join(codexRoot, "rollout-child.jsonl");
		writeJsonl(rootPath, [
			codexMeta({ id: "incremental-root", timestamp: "2026-07-03T00:00:00Z" }),
			codexTaskStarted("root-turn", 1_783_036_801, "2026-07-03T00:00:01Z"),
			codexToken({
				timestamp: "2026-07-03T00:00:02Z",
				input: 100,
				output: 10,
				lastInput: 100,
				lastOutput: 10,
			}),
			codexTerminal("task_complete", "2026-07-03T00:00:05Z"),
		]);
		const childRecords = [
			codexMeta({
				id: "incremental-child",
				parentThreadId: "incremental-root",
				timestamp: "2026-07-03T00:00:02.100Z",
			}),
			codexTaskStarted("child-turn", 1_783_036_802, "2026-07-03T00:00:02.200Z"),
			codexToken({
				timestamp: "2026-07-03T00:00:04Z",
				input: 50,
				output: 5,
				lastInput: 50,
				lastOutput: 5,
			}),
		];
		writeJsonl(childPath, childRecords);

		const first = await planProviderHistoryImport({
			db,
			codexRoots: [codexRoot],
		});
		expect(first.sessions).toHaveLength(1);
		expect(first.sessions[0].queries).toHaveLength(1);
		expect(historyTokenTotal(first.sessions[0].queries[0].usage)).toBe(110);
		await applyProviderHistoryImport(db, first);

		writeJsonl(childPath, [
			...childRecords,
			codexTerminal("task_complete", "2026-07-03T00:00:06Z"),
		]);
		const second = await planProviderHistoryImport({
			db,
			codexRoots: [codexRoot],
		});
		expect(second.sessions).toHaveLength(1);
		expect(second.sessions[0].queries).toHaveLength(1);
		expect(historyTokenTotal(second.sessions[0].queries[0].usage)).toBe(55);
		expect(
			second.skipped.some((row) => row.reason === "provenance-conflict"),
		).toBe(false);
		await applyProviderHistoryImport(db, second);

		const third = await planProviderHistoryImport({
			db,
			codexRoots: [codexRoot],
		});
		expect(third.sessions).toHaveLength(0);
		expect(third.alreadyImported.queries).toBe(2);
		expect(
			db
				.query<{ tokens: number }, []>(`
					SELECT SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens
					FROM usage_queries WHERE provider_id = 'codex'
				`)
				.get()?.tokens,
		).toBe(165);
	});

	it("time-attributes a child completed after its parent as a standalone query", async () => {
		const codexRoot = join(scratch, "codex-late-child");
		writeJsonl(join(codexRoot, "rollout-root.jsonl"), [
			codexMeta({ id: "late-root", timestamp: "2026-07-04T00:00:00Z" }),
			codexTaskStarted("root-turn", 1_783_123_201, "2026-07-04T00:00:01Z"),
			codexToken({
				timestamp: "2026-07-04T00:00:02Z",
				input: 100,
				output: 10,
				lastInput: 100,
				lastOutput: 10,
			}),
			codexTerminal("task_complete", "2026-07-04T00:00:05Z"),
		]);
		writeJsonl(join(codexRoot, "rollout-child.jsonl"), [
			codexMeta({
				id: "late-child",
				parentThreadId: "late-root",
				timestamp: "2026-07-04T00:00:02.100Z",
			}),
			codexTaskStarted("child-turn", 1_783_123_202, "2026-07-04T00:00:02.200Z"),
			codexToken({
				timestamp: "2026-07-04T00:00:04Z",
				input: 50,
				output: 5,
				lastInput: 50,
				lastOutput: 5,
			}),
			codexTerminal("task_complete", "2026-07-04T00:00:06Z"),
		]);

		const manifest = await planProviderHistoryImport({
			db,
			codexRoots: [codexRoot],
		});
		expect(manifest.sessions).toHaveLength(1);
		expect(manifest.sessions[0].queries).toHaveLength(2);
		expect(manifest.sessions[0].queries.map((query) => query.turns)).toEqual([
			1, 1,
		]);
		expect(
			manifest.sessions[0].queries.map((query) => query.timestamp),
		).toEqual([1_783_123_205, 1_783_123_206]);
		expect(manifest.sessions[0].endedAt).toBe(1_783_123_206);
	});

	it("deduplicates Claude snapshots and causally folds subagent usage", async () => {
		const projectsRoot = join(scratch, "claude-projects");
		const sessionId = "claude-external";
		const rootPath = join(projectsRoot, "-work-claude", `${sessionId}.jsonl`);
		writeJsonl(rootPath, [
			claudeUser({
				sessionId,
				uuid: "user-1",
				promptId: "prompt-1",
				timestamp: "2026-07-02T00:00:00.000Z",
			}),
			claudeAssistant({
				sessionId,
				uuid: "assistant-1a",
				parentUuid: "user-1",
				messageId: "message-1",
				timestamp: "2026-07-02T00:00:01.000Z",
				input: 10,
				output: 2,
				read: 20,
			}),
			claudeAssistant({
				sessionId,
				uuid: "assistant-1b",
				parentUuid: "user-1",
				messageId: "message-1",
				timestamp: "2026-07-02T00:00:02.000Z",
				input: 10,
				output: 5,
				read: 20,
			}),
			{
				type: "system",
				subtype: "turn_duration",
				sessionId,
				uuid: "duration-1",
				parentUuid: "assistant-1b",
				timestamp: "2026-07-02T00:00:04.000Z",
				durationMs: 4_000,
			},
		]);
		const childPath = join(
			projectsRoot,
			"-work-claude",
			sessionId,
			"subagents",
			"agent-child.jsonl",
		);
		writeJsonl(childPath, [
			{
				type: "user",
				sessionId,
				uuid: "child-user",
				parentUuid: null,
				timestamp: "2026-07-02T00:00:02.100Z",
				entrypoint: "cli",
				isSidechain: true,
				sourceToolAssistantUUID: "assistant-1b",
				message: { role: "user", content: "child" },
			},
			claudeAssistant({
				sessionId,
				uuid: "child-assistant",
				parentUuid: "child-user",
				messageId: "child-message",
				timestamp: "2026-07-02T00:00:03.000Z",
				input: 7,
				output: 3,
				read: 11,
				sourceToolAssistantUUID: "assistant-1b",
				isSidechain: true,
			}),
		]);
		const sdkPath = join(projectsRoot, "-work-claude", "sdk-session.jsonl");
		writeJsonl(sdkPath, [
			claudeUser({
				sessionId: "sdk-session",
				uuid: "sdk-user",
				promptId: "sdk-prompt",
				timestamp: "2026-07-02T01:00:00.000Z",
				entrypoint: "sdk-cli",
			}),
		]);

		const manifest = await planProviderHistoryImport({
			db,
			claudeRoots: [projectsRoot],
		});
		expect(manifest.sessions).toHaveLength(1);
		const query = manifest.sessions[0].queries[0];
		expect(query.turns).toBe(2);
		expect(query.durationMs).toBe(4_000);
		expect(query.usage).toEqual({
			inputTokens: 17,
			outputTokens: 8,
			cacheReadTokens: 31,
			cacheCreationTokens: 0,
		});
		expect(historyTokenTotal(query.usage)).toBe(56);
		expect(query.estimatedCost).toBeCloseTo(0.0001803);
		expect(query.unpriced).toBe(0);
		expect(query.evidence.childIds).toEqual(["agent-child"]);
		expect(
			manifest.skipped.some(
				(row) =>
					row.nativeSessionId === "sdk-session" &&
					row.reason === "unsupported-entrypoint",
			),
		).toBe(true);

		await applyProviderHistoryImport(db, manifest);
		const row = db
			.query<
				{
					input_tokens: number;
					output_tokens: number;
					cache_read_tokens: number;
					unpriced: number;
				},
				[]
			>(`
				SELECT input_tokens, output_tokens, cache_read_tokens, unpriced
				FROM usage_queries WHERE provider_id = 'claude'
			`)
			.get();
		expect(row).toEqual({
			input_tokens: 17,
			output_tokens: 8,
			cache_read_tokens: 31,
			unpriced: 0,
		});
		const dimensions = db
			.query<
				{
					query_provider: string;
					ledger_provider: string;
					query_model: string;
					ledger_model: string;
					query_cwd: string;
					ledger_cwd: string;
					query_cost_known: number;
					ledger_cost_known: number;
					provider_session_id: string | null;
				},
				[]
			>(`
				SELECT q.provider_id AS query_provider,
				       uq.provider_id AS ledger_provider,
				       q.model AS query_model, uq.model AS ledger_model,
				       q.agent_cwd AS query_cwd, uq.agent_cwd AS ledger_cwd,
				       q.cost_known AS query_cost_known,
				       uq.cost_known AS ledger_cost_known,
				       s.provider_session_id
				FROM queries q
				JOIN usage_queries uq ON uq.session_id = q.session_id
				JOIN sessions s ON s.id = q.session_id
			`)
			.get();
		expect(dimensions).toEqual({
			query_provider: "claude",
			ledger_provider: "claude",
			query_model: "claude-sonnet-4-6",
			ledger_model: "claude-sonnet-4-6",
			query_cwd: "/work/claude",
			ledger_cwd: "/work/claude",
			query_cost_known: 1,
			ledger_cost_known: 1,
			provider_session_id: null,
		});
	});

	it("globally assigns overlapping Claude calls to the original query", async () => {
		const projectsRoot = join(scratch, "claude-overlap");
		const projectDir = join(projectsRoot, "-work-claude");
		const prompt = {
			uuid: "shared-user-uuid",
			promptId: "shared-prompt-uuid",
			timestamp: "2026-07-10T00:00:00.000Z",
		};
		const originalId = "z-short-original";
		const continuationId = "a-long-continuation";
		writeJsonl(join(projectDir, `${originalId}.jsonl`), [
			claudeUser({ sessionId: originalId, ...prompt }),
			claudeAssistant({
				sessionId: originalId,
				uuid: "original-shared-1",
				parentUuid: prompt.uuid,
				messageId: "shared-message-1",
				timestamp: "2026-07-10T00:00:01.000Z",
				input: 10,
				output: 1,
			}),
			claudeAssistant({
				sessionId: originalId,
				uuid: "original-shared-2",
				parentUuid: prompt.uuid,
				messageId: "shared-message-2",
				timestamp: "2026-07-10T00:00:02.000Z",
				input: 20,
				output: 2,
			}),
		]);
		writeJsonl(join(projectDir, `${continuationId}.jsonl`), [
			claudeUser({ sessionId: continuationId, ...prompt }),
			claudeAssistant({
				sessionId: continuationId,
				uuid: "continuation-shared-1",
				parentUuid: prompt.uuid,
				messageId: "shared-message-1",
				timestamp: "2026-07-10T00:00:01.000Z",
				input: 10,
				output: 1,
			}),
			claudeAssistant({
				sessionId: continuationId,
				uuid: "continuation-shared-2",
				parentUuid: prompt.uuid,
				messageId: "shared-message-2",
				timestamp: "2026-07-10T00:00:02.000Z",
				input: 20,
				output: 2,
			}),
			claudeAssistant({
				sessionId: continuationId,
				uuid: "continuation-unique-1",
				parentUuid: prompt.uuid,
				messageId: "continuation-message-1",
				timestamp: "2026-07-10T00:00:03.000Z",
				input: 30,
				output: 3,
			}),
			claudeAssistant({
				sessionId: continuationId,
				uuid: "continuation-unique-2",
				parentUuid: prompt.uuid,
				messageId: "continuation-message-2",
				timestamp: "2026-07-10T00:00:04.000Z",
				input: 40,
				output: 4,
			}),
		]);

		const manifest = await planProviderHistoryImport({
			db,
			claudeRoots: [projectsRoot],
		});
		expect(manifest.sessions).toHaveLength(2);
		const original = manifest.sessions.find(
			(session) => session.nativeSessionId === originalId,
		)?.queries[0];
		const continuation = manifest.sessions.find(
			(session) => session.nativeSessionId === continuationId,
		)?.queries[0];
		expect(original?.evidence.callIds).toEqual([
			"shared-message-1",
			"shared-message-2",
		]);
		expect(continuation?.evidence.callIds).toEqual([
			"continuation-message-1",
			"continuation-message-2",
		]);
		expect(original?.usage).toEqual({
			inputTokens: 30,
			outputTokens: 3,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
		});
		expect(continuation?.usage).toEqual({
			inputTokens: 70,
			outputTokens: 7,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
		});
		expect(historyTokenTotal(manifest.totals)).toBe(110);

		await applyProviderHistoryImport(db, manifest);
		expect(
			db
				.query<{ n: number }, []>(
					"SELECT COUNT(*) AS n FROM history_import_items WHERE provider_id = 'claude' AND source_kind = 'call'",
				)
				.get()?.n,
		).toBe(4);
		const second = await planProviderHistoryImport({
			db,
			claudeRoots: [projectsRoot],
		});
		expect(second.sessions).toHaveLength(0);
		expect(second.alreadyImported).toEqual({ sessions: 2, queries: 2 });
		const secondApply = await applyProviderHistoryImport(db, second);
		expect(secondApply.insertedQueries).toBe(0);
	});

	it("excludes every native Claude id before entrypoint filtering", async () => {
		const projectsRoot = join(scratch, "claude-native-ids");
		const projectDir = join(projectsRoot, "-work-claude");
		db.run(
			`INSERT INTO sessions
			 (id, label, started_at, provider_id, provider_session_id, claude_session_id)
			 VALUES ('switched-session', 'switched', 1, 'codex', 'codex-native', 'switched-claude')`,
		);
		db.run(
			`INSERT INTO sessions
			 (id, label, started_at, provider_id, provider_session_id)
			 VALUES ('direct-session', 'direct', 1, 'claude', 'direct-claude')`,
		);
		writeJsonl(join(projectDir, "switched-claude.jsonl"), [
			claudeUser({
				sessionId: "switched-claude",
				uuid: "switched-user",
				promptId: "switched-prompt",
				timestamp: "2026-07-11T00:00:00.000Z",
				entrypoint: "sdk-cli",
			}),
		]);
		writeJsonl(join(projectDir, "direct-claude.jsonl"), [
			claudeUser({
				sessionId: "direct-claude",
				uuid: "direct-user",
				promptId: "direct-prompt",
				timestamp: "2026-07-11T00:00:00.000Z",
			}),
		]);

		const manifest = await planProviderHistoryImport({
			db,
			claudeRoots: [projectsRoot],
		});
		expect(manifest.sessions).toHaveLength(0);
		for (const nativeSessionId of ["switched-claude", "direct-claude"]) {
			expect(
				manifest.skipped.some(
					(row) =>
						row.nativeSessionId === nativeSessionId &&
						row.reason === "existing-native-session",
				),
			).toBe(true);
		}
		expect(
			manifest.skipped.some(
				(row) =>
					row.nativeSessionId === "switched-claude" &&
					row.reason === "unsupported-entrypoint",
			),
		).toBe(false);
	});

	it("rejects source drift atomically and preserves deletion tombstones", async () => {
		const projectsRoot = join(scratch, "claude-drift");
		const sessionId = "claude-drift-session";
		const rootPath = join(projectsRoot, "-work", `${sessionId}.jsonl`);
		writeJsonl(rootPath, [
			claudeUser({
				sessionId,
				uuid: "drift-user",
				promptId: "drift-prompt",
				timestamp: "2026-07-03T00:00:00.000Z",
			}),
			claudeAssistant({
				sessionId,
				uuid: "drift-assistant",
				parentUuid: "drift-user",
				messageId: "drift-message",
				timestamp: "2026-07-03T00:00:01.000Z",
				input: 5,
				output: 1,
			}),
		]);
		const manifest = await planProviderHistoryImport({
			db,
			claudeRoots: [projectsRoot],
		});
		writeFileSync(rootPath, `${readFileSync(rootPath, "utf8")}\n`);
		await expect(applyProviderHistoryImport(db, manifest)).rejects.toThrow(
			"History source changed after planning",
		);
		expect(
			db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions").get()
				?.n,
		).toBe(0);
		expect(
			db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM queries").get()?.n,
		).toBe(0);

		const fresh = await planProviderHistoryImport({
			db,
			claudeRoots: [projectsRoot],
		});
		await applyProviderHistoryImport(db, fresh);
		const importedId = fresh.sessions[0].importedSessionId;
		db.run("DELETE FROM queries WHERE session_id = ?", [importedId]);
		db.run("DELETE FROM sessions WHERE id = ?", [importedId]);
		const afterDeletion = await planProviderHistoryImport({
			db,
			claudeRoots: [projectsRoot],
		});
		expect(afterDeletion.sessions).toHaveLength(0);
		expect(
			afterDeletion.skipped.some(
				(row) =>
					row.nativeSessionId === sessionId &&
					row.reason === "import-tombstone",
			),
		).toBe(true);
	});
});
