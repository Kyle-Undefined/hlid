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
			},
			[number]
		>(
			`SELECT session_id, seq, role, sdk_uuid, provider_turn_id FROM messages WHERE id = ?`,
		)
		.get(id);
	return row
		? {
				sessionId: row.session_id,
				seq: row.seq,
				role: row.role,
				sdkUuid: row.sdk_uuid,
				providerTurnId: row.provider_turn_id,
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
				  steer_tool_event_index)
				 SELECT ?, seq, role, text, timestamp, recap, turn_id, sdk_uuid,
				        provider_turn_id, steer_target_seq, context_manifest_json,
				        steer_tool_event_index
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

export async function appendToolEvent(
	sessionId: string,
	assistantSeq: number,
	toolId: string,
	name: string,
	input: unknown,
	subagent?: SubagentSnapshot,
	dimensions?: ToolEventDimensions,
	taskActivity?: TaskActivity,
): Promise<void> {
	const db = await getDb();
	const hasModelSnapshot = dimensions?.model !== undefined;
	const hasAgentSnapshot = dimensions?.agentCwd !== undefined;
	const { changes } = db.run(
		`INSERT INTO tool_events
			(session_id, assistant_seq, tool_id, name, input_json, subagent_json, activity_json,
			 timestamp, provider_id, model, agent_cwd)
		 SELECT s.id, ?, ?, ?, ?, ?, ?, unixepoch(),
		        COALESCE(?, s.provider_id, 'claude'),
		        CASE WHEN ? = 1 THEN ?
		             ELSE COALESCE(NULLIF(s.selected_model, ''),
		                           NULLIF(s.actual_model, ''), NULLIF(s.model, '')) END,
		        CASE WHEN ? = 1 THEN ? ELSE s.agent_cwd END
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
			sessionId,
		],
	);
	if (changes === 0) {
		throw new Error(
			`appendToolEvent: no session found for session=${sessionId}`,
		);
	}
	markAnalyticsChanged(["activity"], "tool_event_recorded");
}

export async function setToolEventSubagent(
	sessionId: string,
	toolId: string,
	subagent: SubagentSnapshot,
): Promise<void> {
	const db = await getDb();
	const { changes } = db.run(
		`UPDATE tool_events SET subagent_json = ? WHERE session_id = ? AND tool_id = ?`,
		[JSON.stringify(subagent), sessionId, toolId],
	);
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
): Promise<void> {
	const db = await getDb();
	const { changes } = db.run(
		`UPDATE tool_events SET activity_json = ? WHERE session_id = ? AND tool_id = ?`,
		[JSON.stringify(taskActivity), sessionId, toolId],
	);
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
): Promise<void> {
	const db = await getDb();
	const { changes } = db.run(
		`UPDATE tool_events
		 SET result_text = ?, result_length = ?, result_preview = ?, is_error = ?
		 WHERE session_id = ? AND tool_id = ?`,
		[
			resultText,
			resultText.length,
			resultText.slice(0, TOOL_RESULT_PREVIEW_CHARS),
			isError ? 1 : 0,
			sessionId,
			toolId,
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
     ON CONFLICT(request_id) DO UPDATE SET questions_json = excluded.questions_json, provenance_json = excluded.provenance_json`,
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
