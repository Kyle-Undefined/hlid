import { isTranscriptPagingSpecialToolName } from "../lib/toolEventPaging";
import type { SubagentSnapshot, TaskActivity } from "../server/agentProvider";
import { TOOL_RESULT_PREVIEW_CHARS } from "../server/protocol";
import { markAnalyticsChanged } from "./analyticsRevision";
import { getDb } from "./schema";
import type {
	MessageRow,
	ToolEventDetailRow,
	ToolEventSummaryPage,
	ToolEventSummaryRow,
	ToolEventTranscriptWindow,
} from "./types";

export type ToolEventDimensions = {
	providerId?: string;
	model?: string | null;
	agentCwd?: string | null;
};

/** @returns the new row's messages.id primary key. */
export async function appendMessage(
	sessionId: string,
	seq: number,
	role: string,
	text: string,
	turnId?: string,
	steerTargetSeq?: number,
	contextManifestJson?: string,
	steerToolEventIndex?: number,
): Promise<number> {
	const db = await getDb();
	const result = db.run(
		`INSERT INTO messages
		 (session_id, seq, role, text, timestamp, turn_id, steer_target_seq,
		  context_manifest_json, steer_tool_event_index)
		 VALUES (?, ?, ?, ?, unixepoch(), ?, ?, ?, ?)`,
		[
			sessionId,
			seq,
			role,
			text,
			turnId ?? null,
			steerTargetSeq ?? null,
			contextManifestJson ?? null,
			steerToolEventIndex ?? null,
		],
	);
	return Number(result.lastInsertRowid);
}

export type RealtimeTranscriptMessageInput = {
	sessionId: string;
	seq: number;
	role: "user" | "assistant";
	text: string;
	utteranceId: string;
	realtimeSessionId: string;
	providerRealtimeSessionId?: string;
};

/**
 * Persist one authoritative provider realtime transcript part. The unique
 * session/utterance key makes retries idempotent and returns the original row.
 */
export async function appendRealtimeTranscriptMessage(
	input: RealtimeTranscriptMessageInput,
): Promise<{ id: number; seq: number; inserted: boolean }> {
	const db = await getDb();
	const result = db.run(
		`INSERT OR IGNORE INTO messages
		 (session_id, seq, role, text, timestamp, source, utterance_id,
		  realtime_session_id, provider_realtime_session_id, fork_supported)
		 VALUES (?, ?, ?, ?, unixepoch(), 'codex_realtime', ?, ?, ?, 0)`,
		[
			input.sessionId,
			input.seq,
			input.role,
			input.text,
			input.utteranceId,
			input.realtimeSessionId,
			input.providerRealtimeSessionId ?? null,
		],
	);
	const row = db
		.query<
			{
				id: number;
				seq: number;
				role: string;
				text: string;
				source: string | null;
				realtime_session_id: string | null;
				provider_realtime_session_id: string | null;
				fork_supported: number | null;
			},
			[string, string]
		>(
			`SELECT id, seq, role, text, source, realtime_session_id,
			        provider_realtime_session_id, fork_supported
			 FROM messages
			 WHERE session_id = ? AND utterance_id = ?`,
		)
		.get(input.sessionId, input.utteranceId);
	if (!row) {
		throw new Error(
			`appendRealtimeTranscriptMessage: row missing for session=${input.sessionId} utterance=${input.utteranceId}`,
		);
	}
	if (
		row.seq !== input.seq ||
		row.role !== input.role ||
		row.text !== input.text ||
		row.source !== "codex_realtime" ||
		row.realtime_session_id !== input.realtimeSessionId ||
		row.provider_realtime_session_id !==
			(input.providerRealtimeSessionId ?? null) ||
		row.fork_supported !== 0
	) {
		throw new Error(
			`appendRealtimeTranscriptMessage: utterance collision for session=${input.sessionId} utterance=${input.utteranceId}`,
		);
	}
	return { id: row.id, seq: row.seq, inserted: result.changes > 0 };
}

/** Find a Raven user row already persisted for an idempotent client turn. */
export async function getUserMessageSeqByTurnId(
	sessionId: string,
	turnId: string,
): Promise<number | null> {
	const db = await getDb();
	return (
		db
			.query<{ seq: number }, [string, string]>(
				`SELECT seq FROM messages
				 WHERE session_id = ? AND turn_id = ? AND role = 'user'
				 ORDER BY seq LIMIT 1`,
			)
			.get(sessionId, turnId)?.seq ?? null
	);
}

export async function setMessageCheckpointUuid(
	sessionId: string,
	seq: number,
	checkpointUuid: string,
	providerSessionId: string,
): Promise<void> {
	const db = await getDb();
	const { changes } = db.run(
		`UPDATE messages
		 SET checkpoint_uuid = ?, checkpoint_provider_session_id = ?
		 WHERE session_id = ? AND seq = ? AND role = 'user'`,
		[checkpointUuid, providerSessionId, sessionId, seq],
	);
	if (changes === 0) {
		throw new Error(
			`setMessageCheckpointUuid: no user row found for session=${sessionId} seq=${seq}`,
		);
	}
}

/** Resolve a client-visible Hlid turn to its exact same-session checkpoint. */
export async function getUserMessageCheckpoint(
	sessionId: string,
	turnId: string,
): Promise<{
	seq: number;
	checkpointUuid: string;
	providerSessionId: string;
} | null> {
	const db = await getDb();
	const row = db
		.query<
			{
				seq: number;
				checkpoint_uuid: string;
				checkpoint_provider_session_id: string;
			},
			[string, string]
		>(
			`SELECT seq, checkpoint_uuid, checkpoint_provider_session_id FROM messages
			 WHERE session_id = ? AND turn_id = ? AND role = 'user'
			   AND checkpoint_uuid IS NOT NULL
			   AND checkpoint_provider_session_id IS NOT NULL
			 ORDER BY seq LIMIT 1`,
		)
		.get(sessionId, turnId);
	return row
		? {
				seq: row.seq,
				checkpointUuid: row.checkpoint_uuid,
				providerSessionId: row.checkpoint_provider_session_id,
			}
		: null;
}

/**
 * Backfill a steering row that was accepted before the active response had
 * allocated its assistant transcript sequence.
 */
export async function setMessageSteerTargetSeq(
	sessionId: string,
	seq: number,
	steerTargetSeq: number,
): Promise<void> {
	const db = await getDb();
	const { changes } = db.run(
		`UPDATE messages
		 SET steer_target_seq = ?
		 WHERE session_id = ? AND seq = ? AND role = 'user'`,
		[steerTargetSeq, sessionId, seq],
	);
	if (changes === 0) {
		throw new Error(
			`setMessageSteerTargetSeq: no user row found for session=${sessionId} seq=${seq}`,
		);
	}
}

export async function setMessageText(
	sessionId: string,
	seq: number,
	text: string,
): Promise<void> {
	const db = await getDb();
	const { changes } = db.run(
		`UPDATE messages SET text = ? WHERE session_id = ? AND seq = ?`,
		[text, sessionId, seq],
	);
	if (changes === 0) {
		throw new Error(
			`setMessageText: no row found for session=${sessionId} seq=${seq}`,
		);
	}
}

export async function setMessageQueryId(
	sessionId: string,
	seq: number,
	queryId: number,
): Promise<void> {
	const db = await getDb();
	const { changes } = db.run(
		`UPDATE messages
		 SET query_id = ?
		 WHERE session_id = ? AND seq = ? AND role = 'assistant'
		   AND EXISTS (
			   SELECT 1 FROM queries WHERE id = ? AND session_id = ?
		   )`,
		[queryId, sessionId, seq, queryId, sessionId],
	);
	if (changes === 0) {
		throw new Error(
			`setMessageQueryId: no matching assistant/query found for session=${sessionId} seq=${seq} query=${queryId}`,
		);
	}
}

export async function setMessageRecap(
	sessionId: string,
	seq: number,
	recap: string,
): Promise<void> {
	const db = await getDb();
	const { changes } = db.run(
		`UPDATE messages SET recap = ? WHERE session_id = ? AND seq = ?`,
		[recap, sessionId, seq],
	);
	if (changes === 0) {
		throw new Error(
			`setMessageRecap: no row found for session=${sessionId} seq=${seq}`,
		);
	}
}

/**
 * Records the native Claude transcript UUID of the latest SDK message that
 * fed this row. A turn can span several raw SDK messages (text → tool_use →
 * more text), each with its own UUID — called once per incoming SDK message,
 * so the row always ends up holding the *last* one, which is exactly the
 * "branch up to and including this displayed turn" cutoff forkSession()
 * needs.
 */
export async function setMessageSdkUuid(
	sessionId: string,
	seq: number,
	sdkUuid: string,
): Promise<void> {
	const db = await getDb();
	const { changes } = db.run(
		`UPDATE messages SET sdk_uuid = ? WHERE session_id = ? AND seq = ?`,
		[sdkUuid, sessionId, seq],
	);
	if (changes === 0) {
		throw new Error(
			`setMessageSdkUuid: no row found for session=${sessionId} seq=${seq}`,
		);
	}
}

export async function setMessageProviderTurnId(
	sessionId: string,
	seq: number,
	providerTurnId: string,
): Promise<void> {
	const db = await getDb();
	const { changes } = db.run(
		`UPDATE messages SET provider_turn_id = ? WHERE session_id = ? AND seq = ?`,
		[providerTurnId, sessionId, seq],
	);
	if (changes === 0) {
		throw new Error(
			`setMessageProviderTurnId: no row found for session=${sessionId} seq=${seq}`,
		);
	}
}

/** Ownership + branch-point lookup for POST /db/session/fork's messageId. */
export async function getMessageForFork(id: number): Promise<{
	sessionId: string;
	seq: number;
	role: string;
	sdkUuid: string | null;
	providerTurnId: string | null;
	forkSupported: boolean | null;
} | null> {
	const db = await getDb();
	const row = db
		.query<
			{
				session_id: string;
				seq: number;
				role: string;
				sdk_uuid: string | null;
				provider_turn_id: string | null;
				fork_supported: number | null;
			},
			[number]
		>(
			`SELECT session_id, seq, role, sdk_uuid, provider_turn_id, fork_supported
			 FROM messages WHERE id = ?`,
		)
		.get(id);
	return row
		? {
				sessionId: row.session_id,
				seq: row.seq,
				role: row.role,
				sdkUuid: row.sdk_uuid,
				providerTurnId: row.provider_turn_id,
				forkSupported:
					row.fork_supported === null ? null : row.fork_supported === 1,
			}
		: null;
}

/**
 * Clone Hlid's visible transcript into a native provider fork. Usage queries,
 * permission decisions, and pending interactions intentionally remain owned by
 * the source session. Retained Relics remain globally addressable; attachment
 * rows are not duplicated because session-retained files have single-owner
 * cleanup semantics.
 */
export async function copyForkedSessionTranscript(
	sourceSessionId: string,
	targetSessionId: string,
	throughSeq?: number,
): Promise<number> {
	const db = await getDb();
	let copied = 0;
	db.transaction(() => {
		// query_id is intentionally omitted. A fork copies visible transcript
		// history, not the source session's accounting ownership.
		const messageFilter =
			throughSeq === undefined
				? ""
				: " AND (seq <= ? OR steer_target_seq <= ?)";
		const messageParams =
			throughSeq === undefined
				? [targetSessionId, sourceSessionId]
				: [targetSessionId, sourceSessionId, throughSeq, throughSeq];
		const result = db.run(
			`INSERT INTO messages
				 (session_id, seq, role, text, timestamp, recap, turn_id, sdk_uuid,
				  provider_turn_id, steer_target_seq, context_manifest_json,
				  steer_tool_event_index, source, utterance_id,
				  realtime_session_id, provider_realtime_session_id, fork_supported)
				 SELECT ?, seq, role, text, timestamp, recap, turn_id, sdk_uuid,
				        provider_turn_id, steer_target_seq, context_manifest_json,
				        steer_tool_event_index, source, utterance_id,
				        realtime_session_id, provider_realtime_session_id, fork_supported
				 FROM messages WHERE session_id = ?${messageFilter}
			 ORDER BY seq ASC, id ASC`,
			messageParams,
		);
		copied = result.changes;
		const toolFilter =
			throughSeq === undefined ? "" : " AND assistant_seq <= ?";
		const toolParams =
			throughSeq === undefined
				? [targetSessionId, sourceSessionId]
				: [targetSessionId, sourceSessionId, throughSeq];
		db.run(
			`INSERT INTO tool_events
			 (session_id, assistant_seq, tool_id, name, input_json, result_text,
			  is_error, subagent_json, activity_json, timestamp, provider_id, model, agent_cwd)
			 SELECT ?, assistant_seq, tool_id, name, input_json, result_text,
			        is_error, subagent_json, activity_json, timestamp, provider_id, model, agent_cwd
			 FROM tool_events WHERE session_id = ?${toolFilter}
			 ORDER BY assistant_seq ASC, id ASC`,
			toolParams,
		);
	})();
	return copied;
}

/** Resolve persisted assistant prose for authenticated host-side read aloud. */
export async function getAssistantMessageText(
	id: number,
): Promise<string | null> {
	const db = await getDb();
	const row = db
		.query<{ text: string }, [number]>(
			`SELECT text FROM messages WHERE id = ? AND role = 'assistant'`,
		)
		.get(id);
	return row?.text ?? null;
}

/**
 * Bulk-inserts a forked session's hydrated transcript (see
 * ClaudeProvider.forkSession's `messages` result field) so Raven can render
 * it immediately instead of showing a blank transcript until a live turn or
 * a manual history reload backfills it. Timestamps are synthetic — evenly
 * spaced, ending "now" — since getSessionMessages() doesn't expose per-
 * message timestamps and display ordering only depends on `seq`.
 */
export async function insertForkedMessages(
	sessionId: string,
	messages: { role: "user" | "assistant"; text: string; uuid?: string }[],
): Promise<void> {
	if (messages.length === 0) return;
	const db = await getDb();
	const now = Math.floor(Date.now() / 1000);
	db.transaction(() => {
		messages.forEach((message, seq) => {
			db.run(
				`INSERT INTO messages (session_id, seq, role, text, timestamp, sdk_uuid) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					sessionId,
					seq,
					message.role,
					message.text,
					now - (messages.length - seq),
					message.uuid ?? null,
				],
			);
		});
	})();
}

export type ProviderMessageFrameInput = {
	sessionId: string;
	assistantSeq: number;
	providerId: string;
	providerSessionId: string;
	providerUuid: string;
	frameOrder: number;
	kind: "assistant" | "result_text" | "tool_result";
	text?: string;
	toolStartIds?: string[];
	toolResultIds?: string[];
};

export type ProviderMessageRevision = {
	assistantSeq: number;
	text: string;
	removedToolIds: string[];
	clearedToolResultIds: string[];
	remainingToolCount: number;
	remainingToolErrorCount: number;
	steerToolEventIndexes: Array<{ userSeq: number; toolEventIndex: number }>;
	restoredToolMetadata?: Array<{
		toolId: string;
		subagent: SubagentSnapshot | null;
		taskActivity: TaskActivity | null;
	}>;
};

type ProviderToolMetadataFrame = {
	providerSessionId: string;
	providerUuid: string;
};

type ProviderToolStartFrame = ProviderToolMetadataFrame & {
	lineageFrames?: ProviderToolMetadataFrame[];
};

type ProviderToolMetadataContribution = {
	subagentJson?: string;
	activityJson?: string;
};

function assertActiveProviderFrame(
	db: Awaited<ReturnType<typeof getDb>>,
	tool: { sessionId: string; providerId: string },
	providerFrame: ProviderToolMetadataFrame,
): void {
	const activeFrame = db
		.query<{ active: number }, [string, string, string, string]>(
			`SELECT 1 AS active FROM provider_message_frames
			 WHERE session_id = ? AND provider_id = ?
			   AND provider_session_id = ? AND provider_uuid = ?
			   AND retracted = 0`,
		)
		.get(
			tool.sessionId,
			tool.providerId,
			providerFrame.providerSessionId,
			providerFrame.providerUuid,
		);
	if (!activeFrame) {
		throw new Error(
			`provider frame is unavailable for session=${tool.sessionId}`,
		);
	}
}

function appendProviderToolStartLineage(
	db: Awaited<ReturnType<typeof getDb>>,
	tool: { id: number; sessionId: string; providerId: string },
	providerStartFrame: ProviderToolStartFrame,
): void {
	const frames = [
		providerStartFrame,
		...(providerStartFrame.lineageFrames ?? []),
	].filter(
		(frame, index, all) =>
			all.findIndex(
				(candidate) =>
					candidate.providerSessionId === frame.providerSessionId &&
					candidate.providerUuid === frame.providerUuid,
			) === index,
	);
	for (const frame of frames) {
		assertActiveProviderFrame(db, tool, frame);
		db.run(
			`INSERT OR IGNORE INTO provider_tool_start_lineage
			 (session_id, tool_event_id, provider_id, provider_session_id, provider_uuid)
			 VALUES (?, ?, ?, ?, ?)`,
			[
				tool.sessionId,
				tool.id,
				tool.providerId,
				frame.providerSessionId,
				frame.providerUuid,
			],
		);
	}
}

function appendProviderToolMetadataContribution(
	db: Awaited<ReturnType<typeof getDb>>,
	tool: { id: number; sessionId: string; providerId: string },
	contribution: ProviderToolMetadataContribution,
	providerFrame?: ProviderToolMetadataFrame,
): void {
	if (!contribution.subagentJson && !contribution.activityJson) return;
	if (providerFrame) {
		assertActiveProviderFrame(db, tool, providerFrame);
	}
	db.run(
		`INSERT INTO provider_tool_metadata_contributions
		 (session_id, tool_event_id, provider_id, provider_session_id,
		  provider_uuid, subagent_json, activity_json)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[
			tool.sessionId,
			tool.id,
			tool.providerId,
			providerFrame?.providerSessionId ?? null,
			providerFrame?.providerUuid ?? null,
			contribution.subagentJson ?? null,
			contribution.activityJson ?? null,
		],
	);
}

function latestSurvivingToolMetadata(
	db: Awaited<ReturnType<typeof getDb>>,
	toolEventId: number,
	column: "subagent_json" | "activity_json",
): string | null {
	return (
		db
			.query<{ value: string }, [number]>(
				`SELECT contribution.${column} AS value
				 FROM provider_tool_metadata_contributions contribution
				 LEFT JOIN provider_message_frames frame
				   ON frame.session_id = contribution.session_id
				  AND frame.provider_id = contribution.provider_id
				  AND frame.provider_session_id = contribution.provider_session_id
				  AND frame.provider_uuid = contribution.provider_uuid
				 WHERE contribution.tool_event_id = ?
				   AND contribution.${column} IS NOT NULL
				   AND (contribution.provider_uuid IS NULL OR frame.retracted = 0)
				 ORDER BY contribution.id DESC LIMIT 1`,
			)
			.get(toolEventId)?.value ?? null
	);
}

function joinProviderFrameText(previous: string, next: string): string {
	if (!previous || !next) return previous || next;
	const trailingNewlines = previous.match(/\n*$/)?.[0].length ?? 0;
	const leadingNewlines = next.match(/^\n*/)?.[0].length ?? 0;
	const missingNewlines = Math.max(0, 2 - trailingNewlines - leadingNewlines);
	return [previous, "\n".repeat(missingNewlines), next].join("");
}

function reconcileProviderAssistantText(
	db: Awaited<ReturnType<typeof getDb>>,
	sessionId: string,
	assistantSeq: number,
	providerId: string,
): string {
	const text = db
		.query<{ text_fragment: string | null }, [string, number, string]>(
			`SELECT text_fragment FROM provider_message_frames
			 WHERE session_id = ? AND assistant_seq = ? AND provider_id = ?
			   AND kind IN ('assistant', 'result_text') AND retracted = 0
			 ORDER BY frame_order ASC, id ASC`,
		)
		.all(sessionId, assistantSeq, providerId)
		.reduce(
			(canonical, frame) =>
				frame.text_fragment
					? joinProviderFrameText(canonical, frame.text_fragment)
					: canonical,
			"",
		);
	db.run(
		`UPDATE messages SET text = ?
		 WHERE session_id = ? AND seq = ? AND role = 'assistant'`,
		[text, sessionId, assistantSeq],
	);
	return text;
}

function parseProviderFrameIds(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const value = JSON.parse(raw) as unknown;
		return Array.isArray(value)
			? value.filter(
					(id): id is string => typeof id === "string" && id.length > 0,
				)
			: [];
	} catch {
		return [];
	}
}

type StoredProviderMessageFrame = {
	assistant_seq: number;
	kind: string;
	text_fragment: string | null;
	raw_tool_start_ids_json: string | null;
	tool_result_ids_json: string | null;
};

type ProviderMessageFrameIdentity = Pick<
	ProviderMessageFrameInput,
	"sessionId" | "providerId" | "providerSessionId" | "providerUuid"
>;

type ProviderMessageFrameContent = Omit<
	ProviderMessageFrameInput,
	"assistantSeq" | "frameOrder"
>;

function hasProviderMessageRetraction(
	db: Awaited<ReturnType<typeof getDb>>,
	input: ProviderMessageFrameIdentity,
): boolean {
	return Boolean(
		db
			.query<{ found: number }, [string, string, string, string]>(
				`SELECT 1 AS found FROM provider_message_retractions
				 WHERE session_id = ? AND provider_id = ?
				   AND provider_session_id = ? AND provider_uuid = ?`,
			)
			.get(
				input.sessionId,
				input.providerId,
				input.providerSessionId,
				input.providerUuid,
			),
	);
}

function getStoredProviderMessageFrame(
	db: Awaited<ReturnType<typeof getDb>>,
	input: ProviderMessageFrameIdentity,
): StoredProviderMessageFrame | null {
	return (
		db
			.query<StoredProviderMessageFrame, [string, string, string, string]>(
				`SELECT assistant_seq, kind, text_fragment, raw_tool_start_ids_json,
				        tool_result_ids_json
				 FROM provider_message_frames
				 WHERE session_id = ? AND provider_id = ?
				   AND provider_session_id = ? AND provider_uuid = ?`,
			)
			.get(
				input.sessionId,
				input.providerId,
				input.providerSessionId,
				input.providerUuid,
			) ?? null
	);
}

function assertProviderMessageFrameReplay(
	existing: StoredProviderMessageFrame,
	input: ProviderMessageFrameContent,
	operation: string,
): void {
	const toolStartIdsJson = input.toolStartIds?.length
		? JSON.stringify(input.toolStartIds)
		: null;
	const toolResultIdsJson = input.toolResultIds?.length
		? JSON.stringify(input.toolResultIds)
		: null;
	if (
		existing.kind === input.kind &&
		existing.text_fragment === (input.text ?? null) &&
		existing.raw_tool_start_ids_json === toolStartIdsJson &&
		existing.tool_result_ids_json === toolResultIdsJson
	) {
		return;
	}
	throw new Error(
		`${operation}: content collision for session=${input.sessionId} provider=${input.providerId} uuid=${input.providerUuid}`,
	);
}

export async function getProviderMessageFrameDisposition(
	input: Omit<ProviderMessageFrameInput, "assistantSeq" | "frameOrder">,
): Promise<"new" | "duplicate" | "retracted"> {
	const db = await getDb();
	if (hasProviderMessageRetraction(db, input)) return "retracted";
	const existing = getStoredProviderMessageFrame(db, input);
	if (!existing) return "new";
	assertProviderMessageFrameReplay(
		existing,
		input,
		"getProviderMessageFrameDisposition",
	);
	reconcileProviderAssistantText(
		db,
		input.sessionId,
		existing.assistant_seq,
		input.providerId,
	);
	return "duplicate";
}

/** Resolve a normalized tool_result frame to the assistant row owning its tool. */
export async function getProviderToolAssistantSeq(
	sessionId: string,
	providerId: string,
	providerSessionId: string,
	toolIds: string[],
): Promise<number | null> {
	const ids = [...new Set(toolIds.filter(Boolean))];
	if (ids.length === 0) return null;
	const db = await getDb();
	const placeholders = ids.map(() => "?").join(",");
	const rows = db
		.query<{ assistant_seq: number }, string[]>(
			`SELECT DISTINCT assistant_seq FROM tool_events
			 WHERE session_id = ? AND provider_id = ?
			   AND provider_start_session_id = ?
			   AND tool_id IN (${placeholders})`,
		)
		.all(sessionId, providerId, providerSessionId, ...ids);
	if (rows.length === 0) return null;
	if (rows.length > 1) {
		throw new Error(
			`getProviderToolAssistantSeq: tool-result frame spans assistant rows for session=${sessionId}`,
		);
	}
	return rows[0]?.assistant_seq ?? null;
}

/** Persist one normalized provider frame before exposing its contributions. */
export async function recordProviderMessageFrame(
	input: ProviderMessageFrameInput,
): Promise<"recorded" | "duplicate" | "retracted"> {
	const db = await getDb();
	return db.transaction(() => {
		if (hasProviderMessageRetraction(db, input)) return "retracted";
		const existing = getStoredProviderMessageFrame(db, input);
		const toolStartIdsJson = input.toolStartIds?.length
			? JSON.stringify(input.toolStartIds)
			: null;
		const toolResultIdsJson = input.toolResultIds?.length
			? JSON.stringify(input.toolResultIds)
			: null;
		if (existing) {
			assertProviderMessageFrameReplay(
				existing,
				input,
				"recordProviderMessageFrame",
			);
			reconcileProviderAssistantText(
				db,
				input.sessionId,
				existing.assistant_seq,
				input.providerId,
			);
			return "duplicate";
		}
		const { changes } = db.run(
			`INSERT INTO provider_message_frames
			 (session_id, assistant_seq, provider_id, provider_session_id,
			  provider_uuid, frame_order,
			  kind, text_fragment, raw_tool_start_ids_json, tool_start_ids_json,
			  tool_result_ids_json)
			 SELECT s.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			 FROM sessions s
			 JOIN messages m ON m.session_id = s.id AND m.seq = ?
			 WHERE s.id = ? AND m.role = 'assistant'`,
			[
				input.assistantSeq,
				input.providerId,
				input.providerSessionId,
				input.providerUuid,
				input.frameOrder,
				input.kind,
				input.text ?? null,
				toolStartIdsJson,
				toolStartIdsJson,
				toolResultIdsJson,
				input.assistantSeq,
				input.sessionId,
			],
		);
		if (changes === 0) {
			throw new Error(
				`recordProviderMessageFrame: no assistant row found for session=${input.sessionId} seq=${input.assistantSeq}`,
			);
		}
		reconcileProviderAssistantText(
			db,
			input.sessionId,
			input.assistantSeq,
			input.providerId,
		);
		return "recorded";
	})();
}

/** Durably attach a late/synthetic tool start to its originating provider frame. */
export async function linkProviderFrameToolStart(
	sessionId: string,
	providerId: string,
	providerSessionId: string,
	providerUuid: string,
	toolId: string,
): Promise<boolean> {
	const db = await getDb();
	return db.transaction(() => {
		const row = db
			.query<
				{ tool_start_ids_json: string | null },
				[string, string, string, string]
			>(
				`SELECT tool_start_ids_json FROM provider_message_frames
				 WHERE session_id = ? AND provider_id = ?
				   AND provider_session_id = ? AND provider_uuid = ?
				   AND retracted = 0`,
			)
			.get(sessionId, providerId, providerSessionId, providerUuid);
		if (!row) return false;
		const toolIds = parseProviderFrameIds(row.tool_start_ids_json);
		if (toolIds.includes(toolId)) return true;
		toolIds.push(toolId);
		db.run(
			`UPDATE provider_message_frames SET tool_start_ids_json = ?
			 WHERE session_id = ? AND provider_id = ?
			   AND provider_session_id = ? AND provider_uuid = ?
			   AND retracted = 0`,
			[
				JSON.stringify(toolIds),
				sessionId,
				providerId,
				providerSessionId,
				providerUuid,
			],
		);
		return true;
	})();
}

/**
 * Retract exactly the named provider frames wherever they belong in this
 * session. Unknown and already-retracted UUIDs are no-ops. Every returned
 * revision has already been committed, so Raven can safely replace prose and
 * independently remove tool starts or clear tool results.
 */
export async function retractProviderMessageFrames(
	sessionId: string,
	providerId: string,
	providerSessionId: string,
	providerUuids: string[],
	source: "assistant_supersedes" | "model_refusal_fallback",
): Promise<ProviderMessageRevision[]> {
	const ids = [...new Set(providerUuids.filter(Boolean))];
	if (ids.length === 0) return [];
	const db = await getDb();
	return db.transaction(() => {
		const placeholders = ids.map(() => "?").join(",");
		for (const providerUuid of ids) {
			db.run(
				`INSERT OR IGNORE INTO provider_message_retractions
				 (session_id, provider_id, provider_session_id, provider_uuid, source)
				 SELECT id, ?, ?, ?, ? FROM sessions WHERE id = ?`,
				[providerId, providerSessionId, providerUuid, source, sessionId],
			);
		}
		const changedFrames = db
			.query<
				{
					assistant_seq: number;
					provider_uuid: string;
					tool_start_ids_json: string | null;
					tool_result_ids_json: string | null;
				},
				string[]
			>(
				`SELECT assistant_seq, provider_uuid, tool_start_ids_json,
				        tool_result_ids_json
				 FROM provider_message_frames
				 WHERE session_id = ? AND provider_id = ?
				   AND provider_session_id = ? AND retracted = 0
				   AND provider_uuid IN (${placeholders})`,
			)
			.all(sessionId, providerId, providerSessionId, ...ids);
		if (changedFrames.length === 0) return [];
		const changedIds = [
			...new Set(changedFrames.map((row) => row.provider_uuid)),
		];
		const changedPlaceholders = changedIds.map(() => "?").join(",");
		db.run(
			`UPDATE provider_message_frames SET retracted = 1
			 WHERE session_id = ? AND provider_id = ?
			   AND provider_session_id = ? AND retracted = 0
			   AND provider_uuid IN (${changedPlaceholders})`,
			[sessionId, providerId, providerSessionId, ...changedIds],
		);

		type RetractionToolRow = {
			id: number;
			assistant_seq: number;
			tool_id: string;
			provider_start_session_id: string | null;
			provider_start_frame_uuid: string | null;
			provider_result_session_id: string | null;
			provider_result_frame_uuid: string | null;
			subagent_json: string | null;
			activity_json: string | null;
			affects_subagent: number;
			affects_activity: number;
		};
		const directToolRows = db
			.query<RetractionToolRow, string[]>(
				`SELECT id, assistant_seq, tool_id, provider_start_session_id,
				        provider_start_frame_uuid, provider_result_session_id,
				        provider_result_frame_uuid, subagent_json, activity_json,
				        0 AS affects_subagent, 0 AS affects_activity
				 FROM tool_events
				 WHERE session_id = ? AND provider_id = ?
				   AND ((provider_start_session_id = ?
				         AND provider_start_frame_uuid IN (${changedPlaceholders}))
				        OR (provider_result_session_id = ?
				         AND provider_result_frame_uuid IN (${changedPlaceholders})))`,
			)
			.all(
				sessionId,
				providerId,
				providerSessionId,
				...changedIds,
				providerSessionId,
				...changedIds,
			);
		const lineageToolRows = db
			.query<RetractionToolRow, string[]>(
				`SELECT event.id, event.assistant_seq, event.tool_id,
				        event.provider_start_session_id, event.provider_start_frame_uuid,
				        event.provider_result_session_id, event.provider_result_frame_uuid,
				        event.subagent_json, event.activity_json,
				        0 AS affects_subagent, 0 AS affects_activity
				 FROM provider_tool_start_lineage lineage
				 JOIN tool_events event ON event.id = lineage.tool_event_id
				 WHERE lineage.session_id = ? AND lineage.provider_id = ?
				   AND lineage.provider_session_id = ?
				   AND lineage.provider_uuid IN (${changedPlaceholders})`,
			)
			.all(sessionId, providerId, providerSessionId, ...changedIds);
		const metadataToolRows = db
			.query<RetractionToolRow, string[]>(
				`SELECT event.id, event.assistant_seq, event.tool_id,
				        event.provider_start_session_id, event.provider_start_frame_uuid,
				        event.provider_result_session_id, event.provider_result_frame_uuid,
				        event.subagent_json, event.activity_json,
				        MAX(CASE WHEN contribution.subagent_json IS NOT NULL THEN 1 ELSE 0 END)
				          AS affects_subagent,
				        MAX(CASE WHEN contribution.activity_json IS NOT NULL THEN 1 ELSE 0 END)
				          AS affects_activity
				 FROM provider_tool_metadata_contributions contribution
				 JOIN tool_events event ON event.id = contribution.tool_event_id
				 WHERE contribution.session_id = ? AND contribution.provider_id = ?
				   AND contribution.provider_session_id = ?
				   AND contribution.provider_uuid IN (${changedPlaceholders})
				 GROUP BY event.id`,
			)
			.all(sessionId, providerId, providerSessionId, ...changedIds);
		const toolRowsById = new Map<number, RetractionToolRow>();
		for (const row of [
			...directToolRows,
			...lineageToolRows,
			...metadataToolRows,
		]) {
			const previous = toolRowsById.get(row.id);
			toolRowsById.set(
				row.id,
				previous
					? {
							...previous,
							affects_subagent: Math.max(
								previous.affects_subagent,
								row.affects_subagent,
							),
							affects_activity: Math.max(
								previous.affects_activity,
								row.affects_activity,
							),
						}
					: row,
			);
		}
		const toolRows = [...toolRowsById.values()];
		const removedToolEventIds = new Set([
			...directToolRows
				.filter(
					(row) =>
						row.provider_start_session_id === providerSessionId &&
						row.provider_start_frame_uuid !== null &&
						changedIds.includes(row.provider_start_frame_uuid),
				)
				.map((row) => row.id),
			...lineageToolRows.map((row) => row.id),
		]);
		const affectedSeqs = [
			...new Set([
				...changedFrames.map((row) => row.assistant_seq),
				...toolRows.map((row) => row.assistant_seq),
			]),
		].sort((a, b) => a - b);
		const removedToolPositions = new Map<number, number[]>();
		for (const assistantSeq of affectedSeqs) {
			const orderedToolRows = db
				.query<{ id: number }, [string, number]>(
					`SELECT id FROM tool_events
					 WHERE session_id = ? AND assistant_seq = ? ORDER BY id ASC`,
				)
				.all(sessionId, assistantSeq);
			const removedIds = new Set(
				toolRows
					.filter(
						(row) =>
							row.assistant_seq === assistantSeq &&
							removedToolEventIds.has(row.id),
					)
					.map((row) => row.id),
			);
			removedToolPositions.set(
				assistantSeq,
				orderedToolRows.flatMap((row, index) =>
					removedIds.has(row.id) ? [index] : [],
				),
			);
		}
		if (removedToolEventIds.size > 0) {
			const removedPlaceholders = [...removedToolEventIds]
				.map(() => "?")
				.join(",");
			db.run(
				`DELETE FROM tool_events WHERE session_id = ? AND provider_id = ?
				   AND id IN (${removedPlaceholders})`,
				[sessionId, providerId, ...removedToolEventIds],
			);
		}
		db.run(
			`UPDATE tool_events
			 SET result_text = NULL, result_length = NULL, result_preview = NULL,
			     is_error = NULL, provider_result_frame_uuid = NULL,
			     provider_result_session_id = NULL
			 WHERE session_id = ? AND provider_id = ?
			   AND provider_result_session_id = ?
			   AND provider_result_frame_uuid IN (${changedPlaceholders})`,
			[sessionId, providerId, providerSessionId, ...changedIds],
		);
		const restoredMetadataByToolEventId = new Map<
			number,
			{
				assistantSeq: number;
				toolId: string;
				subagent: SubagentSnapshot | null;
				taskActivity: TaskActivity | null;
			}
		>();
		for (const row of toolRows) {
			if (row.affects_subagent === 0 && row.affects_activity === 0) continue;
			if (removedToolEventIds.has(row.id)) continue;
			const subagentJson =
				row.affects_subagent === 1
					? latestSurvivingToolMetadata(db, row.id, "subagent_json")
					: row.subagent_json;
			const activityJson =
				row.affects_activity === 1
					? latestSurvivingToolMetadata(db, row.id, "activity_json")
					: row.activity_json;
			if (
				subagentJson === row.subagent_json &&
				activityJson === row.activity_json
			) {
				continue;
			}
			const { changes } = db.run(
				`UPDATE tool_events SET subagent_json = ?, activity_json = ?
				 WHERE id = ? AND session_id = ?`,
				[subagentJson, activityJson, row.id, sessionId],
			);
			if (changes === 0) continue;
			restoredMetadataByToolEventId.set(row.id, {
				assistantSeq: row.assistant_seq,
				toolId: row.tool_id,
				subagent: subagentJson
					? (JSON.parse(subagentJson) as SubagentSnapshot)
					: null,
				taskActivity: activityJson
					? (JSON.parse(activityJson) as TaskActivity)
					: null,
			});
		}

		return affectedSeqs.map((assistantSeq) => {
			const text = reconcileProviderAssistantText(
				db,
				sessionId,
				assistantSeq,
				providerId,
			);
			const latestSurvivingAssistantUuid = db
				.query<{ provider_uuid: string }, [string, number, string, string]>(
					`SELECT provider_uuid FROM provider_message_frames
					 WHERE session_id = ? AND assistant_seq = ? AND provider_id = ?
					   AND provider_session_id = ? AND kind = 'assistant'
					   AND retracted = 0
					 ORDER BY frame_order DESC, id DESC LIMIT 1`,
				)
				.get(
					sessionId,
					assistantSeq,
					providerId,
					providerSessionId,
				)?.provider_uuid;
			db.run(
				`UPDATE messages SET sdk_uuid = ?
				 WHERE session_id = ? AND seq = ? AND role = 'assistant'
				   AND sdk_uuid IN (${changedPlaceholders})`,
				[
					latestSurvivingAssistantUuid ?? null,
					sessionId,
					assistantSeq,
					...changedIds,
				],
			);
			const rowTools = toolRows.filter(
				(row) => row.assistant_seq === assistantSeq,
			);
			const changedRowFrames = changedFrames.filter(
				(frame) => frame.assistant_seq === assistantSeq,
			);
			const restoredToolMetadata = [...restoredMetadataByToolEventId.values()]
				.filter((metadata) => metadata.assistantSeq === assistantSeq)
				.map(({ assistantSeq: _assistantSeq, ...metadata }) => metadata);
			const removedPositions = removedToolPositions.get(assistantSeq) ?? [];
			const steerRows = db
				.query<
					{ seq: number; steer_tool_event_index: number },
					[string, number]
				>(
					`SELECT seq, steer_tool_event_index FROM messages
					 WHERE session_id = ? AND role = 'user' AND steer_target_seq = ?
					   AND steer_tool_event_index IS NOT NULL`,
				)
				.all(sessionId, assistantSeq)
				.map((row) => ({
					userSeq: row.seq,
					toolEventIndex: Math.max(
						0,
						row.steer_tool_event_index -
							removedPositions.filter(
								(position) => position < row.steer_tool_event_index,
							).length,
					),
				}));
			for (const steer of steerRows) {
				db.run(
					`UPDATE messages SET steer_tool_event_index = ?
					 WHERE session_id = ? AND seq = ? AND role = 'user'`,
					[steer.toolEventIndex, sessionId, steer.userSeq],
				);
			}
			return {
				assistantSeq,
				text,
				removedToolIds: [
					...new Set([
						...changedRowFrames.flatMap((frame) =>
							parseProviderFrameIds(frame.tool_start_ids_json),
						),
						...rowTools
							.filter((row) => removedToolEventIds.has(row.id))
							.map((row) => row.tool_id),
					]),
				],
				clearedToolResultIds: [
					...new Set([
						...changedRowFrames.flatMap((frame) =>
							parseProviderFrameIds(frame.tool_result_ids_json),
						),
						...rowTools
							.filter(
								(row) =>
									row.provider_result_session_id === providerSessionId &&
									row.provider_result_frame_uuid !== null &&
									changedIds.includes(row.provider_result_frame_uuid),
							)
							.map((row) => row.tool_id),
					]),
				],
				remainingToolCount:
					db
						.query<{ count: number }, [string, number]>(
							`SELECT COUNT(*) AS count FROM tool_events
							 WHERE session_id = ? AND assistant_seq = ?`,
						)
						.get(sessionId, assistantSeq)?.count ?? 0,
				remainingToolErrorCount:
					db
						.query<{ count: number }, [string, number]>(
							`SELECT COUNT(*) AS count FROM tool_events
							 WHERE session_id = ? AND assistant_seq = ? AND is_error = 1`,
						)
						.get(sessionId, assistantSeq)?.count ?? 0,
				steerToolEventIndexes: steerRows,
				restoredToolMetadata,
			};
		});
	})();
}

export async function appendToolEvent(
	sessionId: string,
	assistantSeq: number,
	toolId: string,
	name: string,
	input: unknown,
	subagent?: SubagentSnapshot,
	dimensions?: ToolEventDimensions,
	taskActivity?: TaskActivity,
	providerStartFrame?: ProviderToolStartFrame,
): Promise<void> {
	const db = await getDb();
	const hasModelSnapshot = dimensions?.model !== undefined;
	const hasAgentSnapshot = dimensions?.agentCwd !== undefined;
	db.transaction(() => {
		const result = db.run(
			`INSERT INTO tool_events
				(session_id, assistant_seq, tool_id, name, input_json, subagent_json, activity_json,
				 timestamp, provider_id, model, agent_cwd, provider_start_frame_uuid,
				 provider_start_session_id)
			 SELECT s.id, ?, ?, ?, ?, ?, ?, unixepoch(),
			        COALESCE(?, s.provider_id, 'claude'),
			        CASE WHEN ? = 1 THEN ?
			             ELSE COALESCE(NULLIF(s.selected_model, ''),
			                           NULLIF(s.actual_model, ''), NULLIF(s.model, '')) END,
			        CASE WHEN ? = 1 THEN ? ELSE s.agent_cwd END,
			        ?, ?
			 FROM sessions s WHERE s.id = ?`,
			[
				assistantSeq,
				toolId,
				name,
				input !== undefined ? JSON.stringify(input) : null,
				subagent ? JSON.stringify(subagent) : null,
				taskActivity ? JSON.stringify(taskActivity) : null,
				dimensions?.providerId ?? null,
				hasModelSnapshot ? 1 : 0,
				dimensions?.model ?? null,
				hasAgentSnapshot ? 1 : 0,
				dimensions?.agentCwd ?? null,
				providerStartFrame?.providerUuid ?? null,
				providerStartFrame?.providerSessionId ?? null,
				sessionId,
			],
		);
		if (result.changes === 0) {
			throw new Error(
				`appendToolEvent: no session found for session=${sessionId}`,
			);
		}
		if (!subagent && !taskActivity && !providerStartFrame) return;
		const event = db
			.query<{ id: number; provider_id: string }, [number]>(
				`SELECT id, provider_id FROM tool_events WHERE id = ?`,
			)
			.get(Number(result.lastInsertRowid));
		if (!event) {
			throw new Error(
				`appendToolEvent: inserted row unavailable for session=${sessionId}`,
			);
		}
		if (providerStartFrame) {
			appendProviderToolStartLineage(
				db,
				{ id: event.id, sessionId, providerId: event.provider_id },
				providerStartFrame,
			);
		}
		appendProviderToolMetadataContribution(
			db,
			{ id: event.id, sessionId, providerId: event.provider_id },
			{
				...(subagent ? { subagentJson: JSON.stringify(subagent) } : {}),
				...(taskActivity ? { activityJson: JSON.stringify(taskActivity) } : {}),
			},
			providerStartFrame,
		);
	})();
	markAnalyticsChanged(["activity"], "tool_event_recorded");
}

function setToolEventMetadata(
	db: Awaited<ReturnType<typeof getDb>>,
	sessionId: string,
	toolId: string,
	column: "subagent_json" | "activity_json",
	json: string,
	providerFrame?: ProviderToolMetadataFrame,
): number {
	const rows = db
		.query<
			{ id: number; provider_id: string },
			[string | null, string | null, string, string, string | null]
		>(
			`SELECT event.id, event.provider_id
			 FROM tool_events event
			 LEFT JOIN provider_message_frames frame
			   ON frame.session_id = event.session_id
			  AND frame.provider_id = event.provider_id
			  AND frame.provider_session_id = ?
			  AND frame.provider_uuid = ?
			  AND frame.assistant_seq = event.assistant_seq
			  AND frame.retracted = 0
			 WHERE event.session_id = ? AND event.tool_id = ?
			   AND (? IS NULL OR frame.id IS NOT NULL)`,
		)
		.all(
			providerFrame?.providerSessionId ?? null,
			providerFrame?.providerUuid ?? null,
			sessionId,
			toolId,
			providerFrame?.providerSessionId ?? null,
		);
	for (const row of rows) {
		appendProviderToolMetadataContribution(
			db,
			{ id: row.id, sessionId, providerId: row.provider_id },
			column === "subagent_json"
				? { subagentJson: json }
				: { activityJson: json },
			providerFrame,
		);
		db.run(`UPDATE tool_events SET ${column} = ? WHERE id = ?`, [json, row.id]);
	}
	return rows.length;
}

export async function setToolEventSubagent(
	sessionId: string,
	toolId: string,
	subagent: SubagentSnapshot,
	providerFrame?: ProviderToolMetadataFrame,
): Promise<void> {
	const db = await getDb();
	const changes = db.transaction(() =>
		setToolEventMetadata(
			db,
			sessionId,
			toolId,
			"subagent_json",
			JSON.stringify(subagent),
			providerFrame,
		),
	)();
	if (changes === 0) {
		throw new Error(
			`setToolEventSubagent: no row found for session=${sessionId} tool_id=${toolId}`,
		);
	}
}

export async function setToolEventActivity(
	sessionId: string,
	toolId: string,
	taskActivity: TaskActivity,
	providerFrame?: ProviderToolMetadataFrame,
): Promise<void> {
	const db = await getDb();
	const changes = db.transaction(() =>
		setToolEventMetadata(
			db,
			sessionId,
			toolId,
			"activity_json",
			JSON.stringify(taskActivity),
			providerFrame,
		),
	)();
	if (changes === 0) {
		throw new Error(
			`setToolEventActivity: no row found for session=${sessionId} tool_id=${toolId}`,
		);
	}
}

export async function setToolEventResult(
	sessionId: string,
	toolId: string,
	resultText: string,
	isError: boolean,
	providerResultFrame?: { providerSessionId: string; providerUuid: string },
	assistantSeq?: number,
): Promise<void> {
	const db = await getDb();
	const { changes } = db.run(
		`UPDATE tool_events
		 SET result_text = ?, result_length = ?, result_preview = ?, is_error = ?,
		     provider_result_frame_uuid = ?, provider_result_session_id = ?
		 WHERE session_id = ? AND tool_id = ?
		   AND (? IS NULL OR assistant_seq = ?)`,
		[
			resultText,
			resultText.length,
			resultText.slice(0, TOOL_RESULT_PREVIEW_CHARS),
			isError ? 1 : 0,
			providerResultFrame?.providerUuid ?? null,
			providerResultFrame?.providerSessionId ?? null,
			sessionId,
			toolId,
			assistantSeq ?? null,
			assistantSeq ?? null,
		],
	);
	if (changes === 0) {
		throw new Error(
			`setToolEventResult: no row found for session=${sessionId} tool_id=${toolId}`,
		);
	}
	markAnalyticsChanged(["activity"], "tool_event_result");
}

export async function appendPlanProposal(
	sessionId: string,
	proposalId: string,
	seq: number,
	plan: string,
	decision: string,
	htmlAttachmentId?: string | null,
): Promise<void> {
	const db = await getDb();
	db.run(
		`INSERT INTO plan_proposals (session_id, proposal_id, seq, plan, decision, html_attachment_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(proposal_id) DO UPDATE SET decision = excluded.decision`,
		[sessionId, proposalId, seq, plan, decision, htmlAttachmentId ?? null],
	);
}

export async function setPlanProposalDecision(
	sessionId: string,
	proposalId: string,
	decision: string,
): Promise<void> {
	const db = await getDb();
	const { changes } = db.run(
		`UPDATE plan_proposals SET decision = ? WHERE session_id = ? AND proposal_id = ?`,
		[decision, sessionId, proposalId],
	);
	if (changes === 0) {
		throw new Error(
			`setPlanProposalDecision: no row found for session=${sessionId} proposal_id=${proposalId}`,
		);
	}
}

export type PlanProposalRow = {
	proposal_id: string;
	seq: number;
	plan: string;
	decision: string;
	html_attachment_id: string | null;
	timestamp: number;
};

type SessionSequenceQuery = {
	sessionId: string;
	select: string;
	table: string;
	sequenceColumn: string;
	minSequence?: number;
	beforeSequence?: number;
	maxSequence?: number;
	unboundedOrderBy?: string;
};

/**
 * Read a session-owned child table over the sequence window used by transcript
 * hydration. Table, column, and select values are internal constants supplied
 * by the typed wrappers below; user values remain bound query parameters.
 */
async function getSessionSequenceRows<Row>({
	sessionId,
	select,
	table,
	sequenceColumn,
	minSequence,
	beforeSequence,
	maxSequence,
	unboundedOrderBy = `${sequenceColumn} ASC, id ASC`,
}: SessionSequenceQuery): Promise<Row[]> {
	const db = await getDb();
	const queryBase = `SELECT ${select} FROM ${table} WHERE session_id = ?`;
	const sequenceOrder = `${sequenceColumn} ASC, id ASC`;
	if (minSequence !== undefined) {
		if (maxSequence !== undefined) {
			return db
				.query<Row, [string, number, number]>(
					`${queryBase} AND ${sequenceColumn} >= ? AND ${sequenceColumn} <= ? ORDER BY ${sequenceOrder}`,
				)
				.all(sessionId, minSequence, maxSequence);
		}
		if (beforeSequence !== undefined) {
			return db
				.query<Row, [string, number, number]>(
					`${queryBase} AND ${sequenceColumn} >= ? AND ${sequenceColumn} < ? ORDER BY ${sequenceOrder}`,
				)
				.all(sessionId, minSequence, beforeSequence);
		}
		return db
			.query<Row, [string, number]>(
				`${queryBase} AND ${sequenceColumn} >= ? ORDER BY ${sequenceOrder}`,
			)
			.all(sessionId, minSequence);
	}
	return db
		.query<Row, [string]>(`${queryBase} ORDER BY ${unboundedOrderBy}`)
		.all(sessionId);
}

export async function getSessionPlanProposals(
	sessionId: string,
	minSeq?: number,
	beforeSeq?: number,
	maxSeq?: number,
): Promise<PlanProposalRow[]> {
	return getSessionSequenceRows<PlanProposalRow>({
		sessionId,
		select: "proposal_id, seq, plan, decision, html_attachment_id, timestamp",
		table: "plan_proposals",
		sequenceColumn: "seq",
		minSequence: minSeq,
		beforeSequence: beforeSeq,
		maxSequence: maxSeq,
	});
}

// ─── ask_user_questions ──────────────────────────────────────────────────────
// Persist the interactive question card so it survives reload and is visible
// from any device that loads the session. Mirrors plan_proposals — insert
// on emit with answers_json NULL, update with the response when resolved.

export type AskUserQuestionRow = {
	request_id: string;
	seq: number;
	questions_json: string;
	provenance_json: string | null;
	answers_json: string | null;
	notes_json: string | null;
	timestamp: number;
};

export async function appendAskUserQuestion(
	sessionId: string,
	requestId: string,
	seq: number,
	questionsJson: string,
	provenanceJson?: string | null,
): Promise<void> {
	const db = await getDb();
	db.run(
		`INSERT INTO ask_user_questions (session_id, request_id, seq, questions_json, provenance_json, timestamp) VALUES (?, ?, ?, ?, ?, unixepoch())
		 ON CONFLICT(request_id) DO UPDATE SET session_id = excluded.session_id, seq = excluded.seq, questions_json = excluded.questions_json, provenance_json = excluded.provenance_json, answers_json = NULL, notes_json = NULL, timestamp = excluded.timestamp`,
		[sessionId, requestId, seq, questionsJson, provenanceJson ?? null],
	);
}

export async function setAskUserQuestionResolution(
	sessionId: string,
	requestId: string,
	answersJson: string,
	notesJson: string | null,
): Promise<void> {
	const db = await getDb();
	const { changes } = db.run(
		`UPDATE ask_user_questions SET answers_json = ?, notes_json = ? WHERE session_id = ? AND request_id = ?`,
		[answersJson, notesJson, sessionId, requestId],
	);
	if (changes === 0) {
		throw new Error(
			`setAskUserQuestionResolution: no row found for session=${sessionId} request_id=${requestId}`,
		);
	}
}

export async function setAskUserQuestionProvenance(
	sessionId: string,
	requestId: string,
	provenanceJson: string,
): Promise<void> {
	const db = await getDb();
	const { changes } = db.run(
		`UPDATE ask_user_questions SET provenance_json = ? WHERE session_id = ? AND request_id = ?`,
		[provenanceJson, sessionId, requestId],
	);
	if (changes === 0) {
		throw new Error(
			`setAskUserQuestionProvenance: no row found for session=${sessionId} request_id=${requestId}`,
		);
	}
}

export async function getSessionAskUserQuestions(
	sessionId: string,
	minSeq?: number,
	beforeSeq?: number,
	maxSeq?: number,
): Promise<AskUserQuestionRow[]> {
	return getSessionSequenceRows<AskUserQuestionRow>({
		sessionId,
		select:
			"request_id, seq, questions_json, provenance_json, answers_json, notes_json, timestamp",
		table: "ask_user_questions",
		sequenceColumn: "seq",
		minSequence: minSeq,
		beforeSequence: beforeSeq,
		maxSequence: maxSeq,
	});
}

export async function getSessionMessages(
	sessionId: string,
	beforeSeq?: number,
	limit?: number,
	minSeq?: number,
	beforeId?: number,
	minId?: number,
): Promise<MessageRow[]> {
	const db = await getDb();
	const selectMessages = `SELECT m.*,
		q.cost AS query_cost,
		q.cost_known AS query_cost_known,
		q.estimated_cost AS query_estimated_cost
		FROM messages AS m
		LEFT JOIN queries AS q
			ON q.id = m.query_id AND q.session_id = m.session_id`;
	if (minSeq !== undefined) {
		if (minId !== undefined) {
			return db
				.query<MessageRow, [string, number, number]>(
					`${selectMessages}
					 WHERE m.session_id = ?
					   AND (m.seq, m.id) >= (?, ?)
					 ORDER BY m.seq ASC, m.id ASC`,
				)
				.all(sessionId, minSeq, minId);
		}
		return db
			.query<MessageRow, [string, number]>(
				`${selectMessages}
				 WHERE m.session_id = ? AND m.seq >= ?
				 ORDER BY m.seq ASC, m.id ASC`,
			)
			.all(sessionId, minSeq);
	}
	if (limit !== undefined) {
		if (beforeSeq !== undefined) {
			if (beforeId !== undefined) {
				return db
					.query<MessageRow, [string, number, number, number]>(
						`SELECT * FROM (
							${selectMessages}
							WHERE m.session_id = ?
							  AND (m.seq, m.id) < (?, ?)
							ORDER BY m.seq DESC, m.id DESC LIMIT ?
						) ORDER BY seq ASC, id ASC`,
					)
					.all(sessionId, beforeSeq, beforeId, limit);
			}
			return db
				.query<MessageRow, [string, number, number]>(
					`SELECT * FROM (
						${selectMessages}
						WHERE m.session_id = ? AND m.seq < ?
						ORDER BY m.seq DESC, m.id DESC LIMIT ?
					) ORDER BY seq ASC, id ASC`,
				)
				.all(sessionId, beforeSeq, limit);
		}
		return db
			.query<MessageRow, [string, number]>(
				`SELECT * FROM (
					${selectMessages}
					WHERE m.session_id = ?
					ORDER BY m.seq DESC, m.id DESC LIMIT ?
				) ORDER BY seq ASC, id ASC`,
			)
			.all(sessionId, limit);
	}
	return db
		.query<MessageRow, [string]>(
			`${selectMessages}
			 WHERE m.session_id = ?
			 ORDER BY m.seq ASC, m.id ASC`,
		)
		.all(sessionId);
}

export async function getSessionContextManifests(
	sessionId: string,
	limit = 20,
	beforeSeq?: number,
): Promise<{
	rows: Array<{
		seq: number;
		timestamp: number;
		turn_number: number;
		turn_id: string | null;
		message_preview: string;
		context_manifest_json: string;
	}>;
	hasMore: boolean;
}> {
	const db = await getDb();
	const boundedLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
	const boundary = beforeSeq ?? null;
	const rows = db
		.query<
			{
				seq: number;
				timestamp: number;
				turn_number: number;
				turn_id: string | null;
				message_preview: string;
				context_manifest_json: string;
			},
			[string, number | null, number | null, number]
		>(
			`WITH context_receipts AS (
				SELECT id,
				       seq,
				       timestamp,
				       turn_id,
				       substr(text, 1, 160) AS message_preview,
				       context_manifest_json,
				       row_number() OVER (ORDER BY seq ASC, id ASC) AS turn_number
				FROM messages
				WHERE session_id = ?
				  AND role = 'user'
				  AND context_manifest_json IS NOT NULL
			)
			SELECT seq,
			       timestamp,
			       turn_number,
			       turn_id,
			       message_preview,
			       context_manifest_json
			FROM context_receipts
			WHERE (? IS NULL OR seq < ?)
			ORDER BY seq DESC, id DESC
			LIMIT ?`,
		)
		.all(sessionId, boundary, boundary, boundedLimit + 1);
	return {
		rows: rows.slice(0, boundedLimit),
		hasMore: rows.length > boundedLimit,
	};
}

/**
 * Returns the first unused transcript sequence for a resumed session.
 * Interactive cards consume sequence values without adding message rows, so
 * messages.length is not a safe resume cursor.
 */
export async function getSessionNextMessageSeq(
	sessionId: string,
): Promise<number> {
	const db = await getDb();
	const row = db
		.query<{ next_seq: number }, [string, string, string, string, string]>(
			`SELECT MAX(
				COALESCE((SELECT MAX(seq) FROM messages WHERE session_id = ?), -1),
				COALESCE((SELECT MAX(assistant_seq) FROM tool_events WHERE session_id = ?), -1),
				COALESCE((SELECT MAX(seq) FROM plan_proposals WHERE session_id = ?), -1),
				COALESCE((SELECT MAX(seq) FROM ask_user_questions WHERE session_id = ?), -1),
				COALESCE((SELECT MAX(message_seq) FROM attachments WHERE session_id = ?), -1)
			) + 1 AS next_seq`,
		)
		.get(sessionId, sessionId, sessionId, sessionId, sessionId);
	return row?.next_seq ?? 0;
}

/**
 * Transcript-friendly tool rows. Tool results dominate large session payloads,
 * so history carries a short preview and hydrates the full result on demand.
 */
const TOOL_EVENT_SUMMARY_SELECT = `id, session_id, assistant_seq, tool_id, name, input_json,
	CASE WHEN result_text IS NULL THEN NULL ELSE COALESCE(result_preview, substr(result_text, 1, ${TOOL_RESULT_PREVIEW_CHARS})) END AS result_text,
	COALESCE(result_length, length(result_text)) AS result_length,
	CASE WHEN COALESCE(result_length, length(COALESCE(result_text, ''))) > ${TOOL_RESULT_PREVIEW_CHARS} THEN 1 ELSE 0 END AS result_truncated,
	is_error, subagent_json, activity_json`;

const QUALIFIED_TOOL_EVENT_SUMMARY_SELECT = `event.id, event.session_id, event.assistant_seq, event.tool_id, event.name, event.input_json,
	CASE WHEN event.result_text IS NULL THEN NULL ELSE COALESCE(event.result_preview, substr(event.result_text, 1, ${TOOL_RESULT_PREVIEW_CHARS})) END AS result_text,
	COALESCE(event.result_length, length(event.result_text)) AS result_length,
	CASE WHEN COALESCE(event.result_length, length(COALESCE(event.result_text, ''))) > ${TOOL_RESULT_PREVIEW_CHARS} THEN 1 ELSE 0 END AS result_truncated,
	event.is_error, event.subagent_json, event.activity_json`;

type ToolEventTranscriptProbeRow = {
	id: number;
	assistant_seq: number;
	name: string;
	result_unresolved: number;
	has_subagent: number;
	has_activity: number;
	is_error: number | null;
};

type ToolEventTranscriptCountRow = {
	assistant_seq: number;
	total: number;
};

type ToolEventPageCutoff = {
	assistantSeq: number;
	cutoffId: number;
};

export async function getSessionToolEventSummaries(
	sessionId: string,
	minAssistantSeq?: number,
	beforeAssistantSeq?: number,
	maxAssistantSeq?: number,
): Promise<ToolEventSummaryRow[]> {
	return getSessionSequenceRows<ToolEventSummaryRow>({
		sessionId,
		select: TOOL_EVENT_SUMMARY_SELECT,
		table: "tool_events",
		sequenceColumn: "assistant_seq",
		minSequence: minAssistantSeq,
		beforeSequence: beforeAssistantSeq,
		maxSequence: maxAssistantSeq,
		unboundedOrderBy: "id ASC",
	});
}

/**
 * Initial transcript read that pages only fully settled, query-owned responses.
 *
 * A covering count pass first identifies only responses large enough to page.
 * The eligibility probe then reads payload-free headers for those candidates,
 * and a final bulk query joins the cutoff map before projecting input/result
 * columns, so discarded historical rows are never materialized in JS.
 */
export async function getSessionToolEventTranscriptWindow(
	sessionId: string,
	minAssistantSeq: number,
	maxAssistantSeq: number,
	pageSize = 20,
): Promise<ToolEventTranscriptWindow> {
	const db = await getDb();
	const boundedPageSize = Math.min(100, Math.max(1, Math.trunc(pageSize)));

	return db.transaction(() => {
		const responseCounts = db
			.query<
				ToolEventTranscriptCountRow,
				[string, number, number, string, number, number, string, number, number]
			>(
				`WITH response_state AS (
					SELECT assistant.seq AS assistant_seq,
					       MIN(CASE WHEN assistant.query_id IS NULL THEN 0 ELSE 1 END) AS settled
					FROM messages assistant
					WHERE assistant.session_id = ?
					  AND assistant.role = 'assistant'
					  AND assistant.seq BETWEEN ? AND ?
					GROUP BY assistant.seq
				), steered AS (
					SELECT DISTINCT message.steer_target_seq AS assistant_seq
					FROM messages message
					WHERE message.session_id = ?
					  AND message.steer_target_seq BETWEEN ? AND ?
				)
				SELECT event.assistant_seq,
				       COUNT(*) AS total
				FROM tool_events event
				JOIN response_state response
				  ON response.assistant_seq = event.assistant_seq
				LEFT JOIN steered
				  ON steered.assistant_seq = event.assistant_seq
				WHERE event.session_id = ?
				  AND event.assistant_seq BETWEEN ? AND ?
				  AND response.settled = 1
				  AND steered.assistant_seq IS NULL
				GROUP BY event.assistant_seq
				ORDER BY event.assistant_seq ASC`,
			)
			.all(
				sessionId,
				minAssistantSeq,
				maxAssistantSeq,
				sessionId,
				minAssistantSeq,
				maxAssistantSeq,
				sessionId,
				minAssistantSeq,
				maxAssistantSeq,
			);
		const candidateAssistantSeqs = responseCounts
			.filter((row) => row.total > boundedPageSize)
			.map((row) => row.assistant_seq);
		const probeRows =
			candidateAssistantSeqs.length === 0
				? []
				: db
						.query<ToolEventTranscriptProbeRow, [string, string]>(
							`WITH candidate_sequences AS MATERIALIZED (
								SELECT CAST(value AS INTEGER) AS assistant_seq
								FROM json_each(?)
							)
							SELECT event.id,
							       event.assistant_seq,
							       event.name,
							       CASE WHEN event.result_text IS NULL THEN 1 ELSE 0 END AS result_unresolved,
							       CASE WHEN event.subagent_json IS NULL THEN 0 ELSE 1 END AS has_subagent,
							       CASE WHEN event.activity_json IS NULL THEN 0 ELSE 1 END AS has_activity,
							       event.is_error
							FROM candidate_sequences candidate
							CROSS JOIN tool_events event
							WHERE event.session_id = ?
							  AND event.assistant_seq = candidate.assistant_seq
							ORDER BY event.assistant_seq ASC, event.id ASC`,
						)
						.all(JSON.stringify(candidateAssistantSeqs), sessionId);

		const candidates = new Map<number, ToolEventTranscriptProbeRow[]>();
		for (const row of probeRows) {
			const rows = candidates.get(row.assistant_seq) ?? [];
			rows.push(row);
			candidates.set(row.assistant_seq, rows);
		}

		const cutoffs: ToolEventPageCutoff[] = [];
		const pages: ToolEventTranscriptWindow["pages"] = [];
		for (const [assistantSeq, rows] of candidates) {
			const mayPage = rows.every(
				(row) =>
					row.result_unresolved === 0 &&
					row.has_subagent === 0 &&
					row.has_activity === 0 &&
					!isTranscriptPagingSpecialToolName(row.name),
			);
			if (!mayPage || rows.length <= boundedPageSize) continue;
			const cutoffId = rows.at(-boundedPageSize)?.id;
			if (cutoffId === undefined) continue;
			cutoffs.push({ assistantSeq, cutoffId });
			pages.push({
				assistantSeq,
				total: rows.length,
				errorCount: rows.filter((row) => row.is_error === 1).length,
				hasEarlier: true,
				nextBeforeId: cutoffId,
			});
		}

		const items = db
			.query<ToolEventSummaryRow, [string, string, number, number, string]>(
				`WITH page_cutoffs AS MATERIALIZED (
					SELECT CAST(json_extract(value, '$.assistantSeq') AS INTEGER) AS assistant_seq,
					       CAST(json_extract(value, '$.cutoffId') AS INTEGER) AS cutoff_id
					FROM json_each(?)
				), selected_events AS (
					SELECT ${QUALIFIED_TOOL_EVENT_SUMMARY_SELECT}
					FROM tool_events event
					WHERE event.session_id = ?
					  AND event.assistant_seq BETWEEN ? AND ?
					  AND NOT EXISTS (
						  SELECT 1 FROM page_cutoffs cutoff
						  WHERE cutoff.assistant_seq = event.assistant_seq
					  )
					UNION ALL
					SELECT ${QUALIFIED_TOOL_EVENT_SUMMARY_SELECT}
					FROM page_cutoffs cutoff
					CROSS JOIN tool_events event
					WHERE event.session_id = ?
					  AND event.assistant_seq = cutoff.assistant_seq
					  AND event.id >= cutoff.cutoff_id
				)
				SELECT * FROM selected_events
				ORDER BY assistant_seq ASC, id ASC`,
			)
			.all(
				JSON.stringify(cutoffs),
				sessionId,
				minAssistantSeq,
				maxAssistantSeq,
				sessionId,
			);
		return { items, pages };
	})();
}

/** Returns an exclusive backwards page while preserving ascending transcript order. */
export async function getSessionToolEventPage(
	sessionId: string,
	assistantSeq: number,
	beforeId?: number,
	limit = 20,
): Promise<ToolEventSummaryPage> {
	const db = await getDb();
	const boundedLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
	const counts = db
		.query<{ total: number; error_count: number }, [string, number]>(
			`SELECT COUNT(*) AS total,
				COALESCE(SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END), 0) AS error_count
			 FROM tool_events
			 WHERE session_id = ? AND assistant_seq = ?`,
		)
		.get(sessionId, assistantSeq) ?? { total: 0, error_count: 0 };
	const cursorClause = beforeId === undefined ? "" : " AND id < ?";
	const params =
		beforeId === undefined
			? ([sessionId, assistantSeq, boundedLimit + 1] as [
					string,
					number,
					number,
				])
			: ([sessionId, assistantSeq, beforeId, boundedLimit + 1] as [
					string,
					number,
					number,
					number,
				]);
	const rows = db
		.query<ToolEventSummaryRow, typeof params>(
			`SELECT * FROM (
				SELECT ${TOOL_EVENT_SUMMARY_SELECT}
				FROM tool_events
				WHERE session_id = ? AND assistant_seq = ?${cursorClause}
				ORDER BY id DESC
				LIMIT ?
			) ORDER BY id ASC`,
		)
		.all(...params);
	const hasEarlier = rows.length > boundedLimit;
	const items = hasEarlier ? rows.slice(1) : rows;
	return {
		items,
		total: Number(counts.total),
		errorCount: Number(counts.error_count),
		hasEarlier,
		nextBeforeId: hasEarlier ? (items[0]?.id ?? null) : null,
	};
}

/** Full result for one session-scoped historical tool event. */
export async function getSessionToolEventDetail(
	sessionId: string,
	toolId: string,
): Promise<ToolEventDetailRow | null> {
	const db = await getDb();
	return (
		db
			.query<ToolEventDetailRow, [string, string]>(
				`SELECT tool_id, result_text, is_error
				 FROM tool_events
				 WHERE session_id = ? AND tool_id = ?
				 ORDER BY id DESC
				 LIMIT 1`,
			)
			.get(sessionId, toolId) ?? null
	);
}
