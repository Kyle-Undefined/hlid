import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "./db.test-utils";
import {
	appendMessage,
	appendToolEvent,
	getMessageForFork,
	getProviderMessageFrameDisposition,
	getProviderToolAssistantSeq,
	linkProviderFrameToolStart,
	recordProviderMessageFrame,
	retractProviderMessageFrames,
	setMessageSdkUuid,
	setToolEventActivity,
	setToolEventResult,
	setToolEventSubagent,
} from "./messages";
import { getDb, setDbForTest } from "./schema";
import { createSession } from "./sessions";

const SESSION = "refusal-session";
const PROVIDER_SESSION = "claude-native-a";

async function recordAssistant(
	providerUuid: string,
	frameOrder: number,
	text: string,
	toolStartIds?: string[],
) {
	return recordProviderMessageFrame({
		sessionId: SESSION,
		assistantSeq: 0,
		providerId: "claude",
		providerSessionId: PROVIDER_SESSION,
		providerUuid,
		frameOrder,
		kind: "assistant",
		text,
		...(toolStartIds ? { toolStartIds } : {}),
	});
}

describe("provider message frame retractions", () => {
	beforeEach(async () => {
		freshDb();
		await createSession(SESSION, "Refusal", "claude-sonnet", {
			providerId: "claude",
		});
		await appendMessage(SESSION, 0, "assistant", "First\n\nMiddle\n\nLast");
	});

	it("rebuilds non-tail and multi-frame text without text matching", async () => {
		await recordAssistant("frame-first", 0, "First");
		await recordAssistant("frame-middle", 1, "Middle");
		await recordAssistant("frame-last", 2, "Last");
		await setMessageSdkUuid(SESSION, 0, "frame-last");

		const revision = await retractProviderMessageFrames(
			SESSION,
			"claude",
			PROVIDER_SESSION,
			["frame-middle"],
			"assistant_supersedes",
		);

		expect(revision).toEqual([
			expect.objectContaining({
				assistantSeq: 0,
				text: "First\n\nLast",
				removedToolIds: [],
				clearedToolResultIds: [],
			}),
		]);
		const db = await getDb();
		expect(
			db
				.query<{ text: string }, [string]>(
					"SELECT text FROM messages WHERE session_id = ? AND seq = 0",
				)
				.get(SESSION)?.text,
		).toBe("First\n\nLast");
	});

	it("preserves framed result fallback text across a later final retraction", async () => {
		await recordAssistant("refused-frame", 0, "Refused partial");
		await recordProviderMessageFrame({
			sessionId: SESSION,
			assistantSeq: 0,
			providerId: "claude",
			providerSessionId: PROVIDER_SESSION,
			providerUuid: "result-fallback-frame",
			frameOrder: 1,
			kind: "result_text",
			text: "Authoritative result fallback",
		});

		const revision = await retractProviderMessageFrames(
			SESSION,
			"claude",
			PROVIDER_SESSION,
			["refused-frame"],
			"model_refusal_fallback",
		);

		expect(revision).toEqual([
			expect.objectContaining({
				assistantSeq: 0,
				text: "Authoritative result fallback",
			}),
		]);
		const db = await getDb();
		expect(
			db
				.query<{ text: string }, [string]>(
					"SELECT text FROM messages WHERE session_id = ? AND seq = 0",
				)
				.get(SESSION)?.text,
		).toBe("Authoritative result fallback");
	});

	it("makes duplicate, unknown, and pre-frame retractions durable no-ops", async () => {
		await recordAssistant("known", 0, "First");
		expect(
			await retractProviderMessageFrames(
				SESSION,
				"claude",
				PROVIDER_SESSION,
				["unknown", "known", "known"],
				"model_refusal_fallback",
			),
		).toHaveLength(1);
		expect(
			await retractProviderMessageFrames(
				SESSION,
				"claude",
				PROVIDER_SESSION,
				["unknown", "known"],
				"model_refusal_fallback",
			),
		).toEqual([]);
		expect(
			await getProviderMessageFrameDisposition({
				sessionId: SESSION,
				providerId: "claude",
				providerSessionId: PROVIDER_SESSION,
				providerUuid: "unknown",
				kind: "assistant",
				text: "late",
			}),
		).toBe("retracted");
	});

	it("keeps a pre-frame tombstone after reopening the database", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hlid-refusal-reload-"));
		const databasePath = join(directory, "hlid.db");
		let database: Database | null = null;
		try {
			database = new Database(databasePath);
			setDbForTest(database);
			await createSession("reload-session", "Reload", "claude-sonnet", {
				providerId: "claude",
			});
			await appendMessage("reload-session", 0, "assistant", "");
			expect(
				await retractProviderMessageFrames(
					"reload-session",
					"claude",
					"native-reload",
					["late-after-reload"],
					"model_refusal_fallback",
				),
			).toEqual([]);
			database.close();
			database = null;

			database = new Database(databasePath);
			setDbForTest(database);
			expect(
				await getProviderMessageFrameDisposition({
					sessionId: "reload-session",
					providerId: "claude",
					providerSessionId: "native-reload",
					providerUuid: "late-after-reload",
					kind: "assistant",
					text: "must stay hidden",
				}),
			).toBe("retracted");
		} finally {
			database?.close();
			freshDb();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("repairs canonical text when a reopened frame replay finds a stale row", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hlid-frame-replay-"));
		const databasePath = join(directory, "hlid.db");
		let database: Database | null = null;
		try {
			database = new Database(databasePath);
			setDbForTest(database);
			await createSession("replay-session", "Replay", "claude-sonnet", {
				providerId: "claude",
			});
			await appendMessage("replay-session", 0, "assistant", "");
			await recordProviderMessageFrame({
				sessionId: "replay-session",
				assistantSeq: 0,
				providerId: "claude",
				providerSessionId: "native-replay",
				providerUuid: "replayed-text-frame",
				frameOrder: 0,
				kind: "assistant",
				text: "durable canonical text",
			});
			// Simulate a database produced before frame/text reconciliation was atomic.
			database.run(
				"UPDATE messages SET text = '' WHERE session_id = 'replay-session' AND seq = 0",
			);
			database.close();
			database = null;

			database = new Database(databasePath);
			setDbForTest(database);
			expect(
				await getProviderMessageFrameDisposition({
					sessionId: "replay-session",
					providerId: "claude",
					providerSessionId: "native-replay",
					providerUuid: "replayed-text-frame",
					kind: "assistant",
					text: "durable canonical text",
				}),
			).toBe("duplicate");
			expect(
				database
					.query<{ text: string }, []>(
						"SELECT text FROM messages WHERE session_id = 'replay-session' AND seq = 0",
					)
					.get()?.text,
			).toBe("durable canonical text");
		} finally {
			database?.close();
			freshDb();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("revises live tool IDs even when their database row never persisted", async () => {
		await recordAssistant("failed-start", 0, "", ["live-only-tool"]);
		await recordProviderMessageFrame({
			sessionId: SESSION,
			assistantSeq: 0,
			providerId: "claude",
			providerSessionId: PROVIDER_SESSION,
			providerUuid: "failed-result",
			frameOrder: 1,
			kind: "tool_result",
			toolResultIds: ["live-only-result"],
		});
		expect(
			await retractProviderMessageFrames(
				SESSION,
				"claude",
				PROVIDER_SESSION,
				["failed-start", "failed-result"],
				"model_refusal_fallback",
			),
		).toEqual([
			expect.objectContaining({
				removedToolIds: ["live-only-tool"],
				clearedToolResultIds: ["live-only-result"],
			}),
		]);
	});

	it("keeps raw replay identity immutable after linking a workflow child", async () => {
		await recordAssistant("workflow-frame", 0, "", ["workflow-root"]);
		expect(
			await linkProviderFrameToolStart(
				SESSION,
				"claude",
				PROVIDER_SESSION,
				"workflow-frame",
				"workflow-child",
			),
		).toBe(true);
		expect(
			await getProviderMessageFrameDisposition({
				sessionId: SESSION,
				providerId: "claude",
				providerSessionId: PROVIDER_SESSION,
				providerUuid: "workflow-frame",
				kind: "assistant",
				text: "",
				toolStartIds: ["workflow-root"],
			}),
		).toBe("duplicate");
		expect(
			await recordProviderMessageFrame({
				sessionId: SESSION,
				assistantSeq: 0,
				providerId: "claude",
				providerSessionId: PROVIDER_SESSION,
				providerUuid: "workflow-frame",
				frameOrder: 99,
				kind: "assistant",
				text: "",
				toolStartIds: ["workflow-root"],
			}),
		).toBe("duplicate");
		expect(
			await retractProviderMessageFrames(
				SESSION,
				"claude",
				PROVIDER_SESSION,
				["workflow-frame"],
				"model_refusal_fallback",
			),
		).toEqual([
			expect.objectContaining({
				removedToolIds: ["workflow-root", "workflow-child"],
			}),
		]);
	});

	it("suppresses a replayed frame across a different local row and order", async () => {
		await recordAssistant("replayed", 0, "First");
		await appendMessage(SESSION, 1, "assistant", "");
		expect(
			await getProviderMessageFrameDisposition({
				sessionId: SESSION,
				providerId: "claude",
				providerSessionId: PROVIDER_SESSION,
				providerUuid: "replayed",
				kind: "assistant",
				text: "First",
			}),
		).toBe("duplicate");
		expect(
			await recordProviderMessageFrame({
				sessionId: SESSION,
				assistantSeq: 1,
				providerId: "claude",
				providerSessionId: PROVIDER_SESSION,
				providerUuid: "replayed",
				frameOrder: 99,
				kind: "assistant",
				text: "First",
			}),
		).toBe("duplicate");
	});

	it("keeps native sessions isolated even when opaque UUIDs collide", async () => {
		await recordAssistant("same-uuid", 0, "First");
		await recordProviderMessageFrame({
			sessionId: SESSION,
			assistantSeq: 0,
			providerId: "claude",
			providerSessionId: "claude-native-b",
			providerUuid: "same-uuid",
			frameOrder: 1,
			kind: "assistant",
			text: "Other context",
		});
		await retractProviderMessageFrames(
			SESSION,
			"claude",
			PROVIDER_SESSION,
			["same-uuid"],
			"assistant_supersedes",
		);
		const db = await getDb();
		expect(
			db
				.query<{ text: string }, [string]>(
					"SELECT text FROM messages WHERE session_id = ? AND seq = 0",
				)
				.get(SESSION)?.text,
		).toBe("Other context");
	});

	it("repairs a cutoff only from the retracted frame's native session", async () => {
		await recordAssistant("old-native-before", 0, "First");
		await recordAssistant("old-native-cutoff", 1, "Middle");
		await recordProviderMessageFrame({
			sessionId: SESSION,
			assistantSeq: 0,
			providerId: "claude",
			providerSessionId: "claude-native-b",
			providerUuid: "new-native-frame",
			frameOrder: 2,
			kind: "assistant",
			text: "Last",
		});
		await setMessageSdkUuid(SESSION, 0, "old-native-cutoff");

		await retractProviderMessageFrames(
			SESSION,
			"claude",
			PROVIDER_SESSION,
			["old-native-cutoff"],
			"assistant_supersedes",
		);

		const db = await getDb();
		const assistantDbId = db
			.query<{ id: number }, [string]>(
				"SELECT id FROM messages WHERE session_id = ? AND seq = 0",
			)
			.get(SESSION)?.id;
		expect(await getMessageForFork(assistantDbId as number)).toMatchObject({
			sdkUuid: "old-native-before",
		});
	});

	it("scopes tool ownership and deletion by provider and native session", async () => {
		await recordAssistant("shared-frame", 0, "First", ["shared-tool"]);
		await appendToolEvent(
			SESSION,
			0,
			"shared-tool",
			"Read",
			{},
			undefined,
			{ providerId: "claude" },
			undefined,
			{
				providerSessionId: PROVIDER_SESSION,
				providerUuid: "shared-frame",
			},
		);
		await appendMessage(SESSION, 1, "assistant", "Other provider");
		await recordProviderMessageFrame({
			sessionId: SESSION,
			assistantSeq: 1,
			providerId: "codex",
			providerSessionId: "codex-native",
			providerUuid: "shared-frame",
			frameOrder: 0,
			kind: "assistant",
			text: "Other provider",
			toolStartIds: ["shared-tool"],
		});
		await appendToolEvent(
			SESSION,
			1,
			"shared-tool",
			"Read",
			{},
			undefined,
			{ providerId: "codex" },
			undefined,
			{
				providerSessionId: "codex-native",
				providerUuid: "shared-frame",
			},
		);

		expect(
			await getProviderToolAssistantSeq(SESSION, "claude", PROVIDER_SESSION, [
				"shared-tool",
			]),
		).toBe(0);
		expect(
			await getProviderToolAssistantSeq(SESSION, "codex", "codex-native", [
				"shared-tool",
			]),
		).toBe(1);

		await retractProviderMessageFrames(
			SESSION,
			"claude",
			PROVIDER_SESSION,
			["shared-frame"],
			"model_refusal_fallback",
		);
		const db = await getDb();
		expect(
			db
				.query<
					{ provider_id: string; assistant_seq: number },
					[string, string]
				>(
					`SELECT provider_id, assistant_seq FROM tool_events
					 WHERE session_id = ? AND tool_id = ?`,
				)
				.all(SESSION, "shared-tool"),
		).toEqual([{ provider_id: "codex", assistant_seq: 1 }]);
	});

	it("removes tool starts, clears tool-result detail, and repairs fork cutoff", async () => {
		await recordAssistant("frame-before", 0, "First");
		await recordAssistant("frame-tool", 1, "", ["tool-a"]);
		await appendToolEvent(
			SESSION,
			0,
			"tool-a",
			"Read",
			{ path: "/tmp/a" },
			undefined,
			{ providerId: "claude" },
			undefined,
			{
				providerSessionId: PROVIDER_SESSION,
				providerUuid: "frame-tool",
			},
		);
		await recordProviderMessageFrame({
			sessionId: SESSION,
			assistantSeq: 0,
			providerId: "claude",
			providerSessionId: PROVIDER_SESSION,
			providerUuid: "frame-result",
			frameOrder: 2,
			kind: "tool_result",
			toolResultIds: ["tool-a"],
		});
		await setToolEventResult(
			SESSION,
			"tool-a",
			"secret result",
			true,
			{
				providerSessionId: PROVIDER_SESSION,
				providerUuid: "frame-result",
			},
			0,
		);
		const messageId = await appendMessage(SESSION, 2, "user", "branch marker");
		void messageId;
		await setMessageSdkUuid(SESSION, 0, "frame-tool");

		const resultRevision = await retractProviderMessageFrames(
			SESSION,
			"claude",
			PROVIDER_SESSION,
			["frame-result"],
			"assistant_supersedes",
		);
		expect(resultRevision[0]).toMatchObject({
			clearedToolResultIds: ["tool-a"],
			remainingToolCount: 1,
			remainingToolErrorCount: 0,
		});
		const db = await getDb();
		expect(
			db
				.query<
					{
						result_text: string | null;
						result_length: number | null;
						result_preview: string | null;
						is_error: number | null;
					},
					[string]
				>(
					`SELECT result_text, result_length, result_preview, is_error
					 FROM tool_events WHERE session_id = ? AND tool_id = 'tool-a'`,
				)
				.get(SESSION),
		).toEqual({
			result_text: null,
			result_length: null,
			result_preview: null,
			is_error: null,
		});

		const startRevision = await retractProviderMessageFrames(
			SESSION,
			"claude",
			PROVIDER_SESSION,
			["frame-tool"],
			"model_refusal_fallback",
		);
		expect(startRevision[0]).toMatchObject({
			removedToolIds: ["tool-a"],
			remainingToolCount: 0,
			remainingToolErrorCount: 0,
		});
		expect(
			db
				.query<{ count: number }, [string]>(
					"SELECT COUNT(*) AS count FROM tool_events WHERE session_id = ?",
				)
				.get(SESSION)?.count,
		).toBe(0);
		const assistantDbId = db
			.query<{ id: number }, [string]>(
				"SELECT id FROM messages WHERE session_id = ? AND seq = 0",
			)
			.get(SESSION)?.id;
		expect(assistantDbId).toBeDefined();
		expect(await getMessageForFork(assistantDbId as number)).toMatchObject({
			sdkUuid: "frame-before",
		});
	});

	it("restores start metadata when only its accepted result frame retracts", async () => {
		const startSubagent = {
			provider: "claude" as const,
			agentId: "workflow-task",
			kind: "workflow" as const,
			status: "running" as const,
			startedAtMs: 1,
		};
		const startActivity = {
			kind: "tasks" as const,
			source: "claude-task-store" as const,
			operation: "create" as const,
			items: [{ subject: "Start work", status: "pending" as const }],
		};
		await recordAssistant("metadata-start-frame", 0, "", ["metadata-tool"]);
		await appendToolEvent(
			SESSION,
			0,
			"metadata-tool",
			"Workflow",
			{},
			startSubagent,
			{ providerId: "claude" },
			startActivity,
			{
				providerSessionId: PROVIDER_SESSION,
				providerUuid: "metadata-start-frame",
			},
		);
		await recordProviderMessageFrame({
			sessionId: SESSION,
			assistantSeq: 0,
			providerId: "claude",
			providerSessionId: PROVIDER_SESSION,
			providerUuid: "metadata-result-frame",
			frameOrder: 1,
			kind: "tool_result",
			toolResultIds: ["metadata-tool"],
		});
		const resultFrame = {
			providerSessionId: PROVIDER_SESSION,
			providerUuid: "metadata-result-frame",
		};
		await setToolEventResult(
			SESSION,
			"metadata-tool",
			"accepted result",
			false,
			resultFrame,
			0,
		);
		await setToolEventSubagent(
			SESSION,
			"metadata-tool",
			{
				...startSubagent,
				status: "completed",
				workflowRunId: "refused-run",
				endedAtMs: 2,
			},
			resultFrame,
		);
		await setToolEventActivity(
			SESSION,
			"metadata-tool",
			{
				...startActivity,
				operation: "update",
				items: [{ subject: "Start work", status: "completed" }],
			},
			resultFrame,
		);

		const [revision] = await retractProviderMessageFrames(
			SESSION,
			"claude",
			PROVIDER_SESSION,
			["metadata-result-frame"],
			"assistant_supersedes",
		);
		expect(revision).toMatchObject({
			removedToolIds: [],
			clearedToolResultIds: ["metadata-tool"],
			restoredToolMetadata: [
				{
					toolId: "metadata-tool",
					subagent: startSubagent,
					taskActivity: startActivity,
				},
			],
		});
		const db = await getDb();
		const restored = db
			.query<
				{
					result_text: string | null;
					subagent_json: string | null;
					activity_json: string | null;
				},
				[string, string]
			>(
				`SELECT result_text, subagent_json, activity_json FROM tool_events
				 WHERE session_id = ? AND tool_id = ?`,
			)
			.get(SESSION, "metadata-tool");
		expect(restored?.result_text).toBeNull();
		expect(JSON.parse(restored?.subagent_json ?? "null")).toEqual(
			startSubagent,
		);
		expect(JSON.parse(restored?.activity_json ?? "null")).toEqual(
			startActivity,
		);
	});

	it.each([
		{
			name: "older contribution first",
			order: ["metadata-update-a", "metadata-update-b"],
			firstSurvivor: "b" as const,
		},
		{
			name: "newer contribution first",
			order: ["metadata-update-b", "metadata-update-a"],
			firstSurvivor: "a" as const,
		},
	])("reconstructs metadata after retracting $name", async ({
		order,
		firstSurvivor,
	}) => {
		const baseSubagent = {
			provider: "claude" as const,
			agentId: "ledger-agent",
			status: "running" as const,
			startedAtMs: 1,
		};
		const baseActivity = {
			kind: "tasks" as const,
			source: "claude-task-store" as const,
			operation: "create" as const,
			items: [{ subject: "Base", status: "pending" as const }],
		};
		const snapshots = {
			a: {
				subagent: { ...baseSubagent, status: "completed" as const },
				activity: {
					...baseActivity,
					operation: "update" as const,
					items: [{ subject: "Update A", status: "completed" as const }],
				},
			},
			b: {
				subagent: { ...baseSubagent, status: "failed" as const },
				activity: {
					...baseActivity,
					operation: "update" as const,
					items: [{ subject: "Update B", status: "in_progress" as const }],
				},
			},
		};
		await recordAssistant("metadata-ledger-start", 0, "", [
			"metadata-ledger-tool",
		]);
		await appendToolEvent(
			SESSION,
			0,
			"metadata-ledger-tool",
			"Workflow",
			{},
			baseSubagent,
			{ providerId: "claude" },
			baseActivity,
			{
				providerSessionId: PROVIDER_SESSION,
				providerUuid: "metadata-ledger-start",
			},
		);
		for (const [index, key] of (["a", "b"] as const).entries()) {
			const providerUuid = `metadata-update-${key}`;
			await recordProviderMessageFrame({
				sessionId: SESSION,
				assistantSeq: 0,
				providerId: "claude",
				providerSessionId: PROVIDER_SESSION,
				providerUuid,
				frameOrder: index + 1,
				kind: "tool_result",
				toolResultIds: ["metadata-ledger-tool"],
			});
			const providerFrame = {
				providerSessionId: PROVIDER_SESSION,
				providerUuid,
			};
			await setToolEventSubagent(
				SESSION,
				"metadata-ledger-tool",
				snapshots[key].subagent,
				providerFrame,
			);
			await setToolEventActivity(
				SESSION,
				"metadata-ledger-tool",
				snapshots[key].activity,
				providerFrame,
			);
		}

		const firstRevision = await retractProviderMessageFrames(
			SESSION,
			"claude",
			PROVIDER_SESSION,
			[order[0] ?? ""],
			"assistant_supersedes",
		);
		const db = await getDb();
		const readMetadata = () => {
			const row = db
				.query<
					{ subagent_json: string | null; activity_json: string | null },
					[string, string]
				>(
					`SELECT subagent_json, activity_json FROM tool_events
						 WHERE session_id = ? AND tool_id = ?`,
				)
				.get(SESSION, "metadata-ledger-tool");
			return {
				subagent: JSON.parse(row?.subagent_json ?? "null"),
				activity: JSON.parse(row?.activity_json ?? "null"),
			};
		};
		expect(readMetadata()).toEqual(snapshots[firstSurvivor]);
		if (order[0] === "metadata-update-b") {
			expect(firstRevision[0]).toMatchObject({
				restoredToolMetadata: [
					{
						toolId: "metadata-ledger-tool",
						subagent: snapshots.a.subagent,
						taskActivity: snapshots.a.activity,
					},
				],
			});
		} else {
			expect(firstRevision[0]?.restoredToolMetadata).toEqual([]);
		}

		const secondRevision = await retractProviderMessageFrames(
			SESSION,
			"claude",
			PROVIDER_SESSION,
			[order[1] ?? ""],
			"assistant_supersedes",
		);
		expect(readMetadata()).toEqual({
			subagent: baseSubagent,
			activity: baseActivity,
		});
		expect(secondRevision[0]).toMatchObject({
			restoredToolMetadata: [
				{
					toolId: "metadata-ledger-tool",
					subagent: baseSubagent,
					taskActivity: baseActivity,
				},
			],
		});
		expect(
			db
				.query<{ count: number }, []>(
					"SELECT COUNT(*) AS count FROM provider_tool_metadata_contributions",
				)
				.get()?.count,
		).toBe(5);
	});

	it("scopes framed subagent and activity metadata to the owning assistant row", async () => {
		const baseSubagent = {
			provider: "claude" as const,
			agentId: "shared-metadata-agent",
			status: "running" as const,
			startedAtMs: 1,
		};
		const baseActivity = {
			kind: "tasks" as const,
			source: "claude-task-store" as const,
			operation: "create" as const,
			items: [{ subject: "Base", status: "pending" as const }],
		};
		await recordAssistant("metadata-owner-a", 0, "", ["shared-metadata"]);
		await appendMessage(SESSION, 2, "assistant", "");
		await recordProviderMessageFrame({
			sessionId: SESSION,
			assistantSeq: 2,
			providerId: "claude",
			providerSessionId: PROVIDER_SESSION,
			providerUuid: "metadata-owner-b",
			frameOrder: 1,
			kind: "assistant",
			text: "",
			toolStartIds: ["shared-metadata"],
		});
		for (const [assistantSeq, providerUuid, suffix] of [
			[0, "metadata-owner-a", "A"],
			[2, "metadata-owner-b", "B"],
		] as const) {
			await appendToolEvent(
				SESSION,
				assistantSeq,
				"shared-metadata",
				"Workflow",
				{},
				{ ...baseSubagent, agentId: `shared-metadata-${suffix}` },
				{ providerId: "claude" },
				{
					...baseActivity,
					items: [{ subject: `Base ${suffix}`, status: "pending" }],
				},
				{ providerSessionId: PROVIDER_SESSION, providerUuid },
			);
		}
		const ownerFrame = {
			providerSessionId: PROVIDER_SESSION,
			providerUuid: "metadata-owner-a",
		};
		const updatedSubagent = {
			...baseSubagent,
			agentId: "shared-metadata-A",
			status: "completed" as const,
		};
		const updatedActivity = {
			...baseActivity,
			operation: "update" as const,
			items: [{ subject: "Updated A", status: "completed" as const }],
		};
		await setToolEventSubagent(
			SESSION,
			"shared-metadata",
			updatedSubagent,
			ownerFrame,
		);
		await setToolEventActivity(
			SESSION,
			"shared-metadata",
			updatedActivity,
			ownerFrame,
		);

		const db = await getDb();
		const rows = db
			.query<
				{
					assistant_seq: number;
					subagent_json: string;
					activity_json: string;
				},
				[string, string]
			>(
				`SELECT assistant_seq, subagent_json, activity_json FROM tool_events
				 WHERE session_id = ? AND tool_id = ? ORDER BY assistant_seq`,
			)
			.all(SESSION, "shared-metadata");
		expect(rows.map((row) => JSON.parse(row.subagent_json))).toEqual([
			updatedSubagent,
			{ ...baseSubagent, agentId: "shared-metadata-B" },
		]);
		expect(rows.map((row) => JSON.parse(row.activity_json))).toEqual([
			updatedActivity,
			{
				...baseActivity,
				items: [{ subject: "Base B", status: "pending" }],
			},
		]);
		expect(
			db
				.query<{ count: number }, [string]>(
					`SELECT COUNT(*) AS count FROM provider_tool_metadata_contributions
					 WHERE provider_uuid = ?`,
				)
				.get("metadata-owner-a")?.count,
		).toBe(3);
	});

	it.each([
		"lineage-root",
		"lineage-result",
	] as const)("deletes only the exact derived row when %s retracts", async (retractedFrame) => {
		await recordAssistant("lineage-root", 0, "", ["lineage-parent"]);
		await recordProviderMessageFrame({
			sessionId: SESSION,
			assistantSeq: 0,
			providerId: "claude",
			providerSessionId: PROVIDER_SESSION,
			providerUuid: "lineage-result",
			frameOrder: 1,
			kind: "tool_result",
			toolResultIds: ["lineage-parent"],
		});
		await recordAssistant("lineage-unrelated", 2, "", ["shared-child"]);
		await appendToolEvent(
			SESSION,
			0,
			"shared-child",
			"Subagent",
			{},
			undefined,
			{ providerId: "claude" },
			undefined,
			{
				providerSessionId: PROVIDER_SESSION,
				providerUuid: "lineage-result",
				lineageFrames: [
					{
						providerSessionId: PROVIDER_SESSION,
						providerUuid: "lineage-root",
					},
				],
			},
		);
		await appendToolEvent(
			SESSION,
			0,
			"shared-child",
			"Read",
			{},
			undefined,
			{ providerId: "claude" },
			undefined,
			{
				providerSessionId: PROVIDER_SESSION,
				providerUuid: "lineage-unrelated",
			},
		);

		const db = await getDb();
		expect(
			db
				.query<{ count: number }, []>(
					"SELECT COUNT(*) AS count FROM provider_tool_start_lineage",
				)
				.get()?.count,
		).toBe(3);
		const [revision] = await retractProviderMessageFrames(
			SESSION,
			"claude",
			PROVIDER_SESSION,
			[retractedFrame],
			"assistant_supersedes",
		);
		expect(revision?.removedToolIds).toContain("shared-child");
		expect(
			db
				.query<{ provider_start_frame_uuid: string }, [string, string]>(
					`SELECT provider_start_frame_uuid FROM tool_events
						 WHERE session_id = ? AND tool_id = ?`,
				)
				.all(SESSION, "shared-child"),
		).toEqual([{ provider_start_frame_uuid: "lineage-unrelated" }]);
	});

	it("reindexes a persisted steer boundary before later replacement tools", async () => {
		await recordAssistant("tool-before-steer", 0, "", ["tool-before"]);
		await appendToolEvent(
			SESSION,
			0,
			"tool-before",
			"Read",
			{},
			undefined,
			{ providerId: "claude" },
			undefined,
			{
				providerSessionId: PROVIDER_SESSION,
				providerUuid: "tool-before-steer",
			},
		);
		await appendMessage(
			SESSION,
			1,
			"user",
			"steer",
			"steer-turn",
			0,
			undefined,
			1,
		);

		const [revision] = await retractProviderMessageFrames(
			SESSION,
			"claude",
			PROVIDER_SESSION,
			["tool-before-steer"],
			"assistant_supersedes",
		);
		expect(revision?.steerToolEventIndexes).toEqual([
			{ userSeq: 1, toolEventIndex: 0 },
		]);

		await recordAssistant("tool-after-steer", 1, "", ["tool-after"]);
		await appendToolEvent(
			SESSION,
			0,
			"tool-after",
			"Read",
			{},
			undefined,
			{ providerId: "claude" },
			undefined,
			{
				providerSessionId: PROVIDER_SESSION,
				providerUuid: "tool-after-steer",
			},
		);
		const db = await getDb();
		expect(
			db
				.query<{ steer_tool_event_index: number }, [string]>(
					`SELECT steer_tool_event_index FROM messages
					 WHERE session_id = ? AND seq = 1`,
				)
				.get(SESSION)?.steer_tool_event_index,
		).toBe(0);
		expect(
			db
				.query<{ tool_id: string }, [string]>(
					`SELECT tool_id FROM tool_events
					 WHERE session_id = ? AND assistant_seq = 0 ORDER BY id`,
				)
				.all(SESSION),
		).toEqual([{ tool_id: "tool-after" }]);
	});
});
