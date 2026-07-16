import type { SubagentSnapshot } from "../server/agentProvider";
import { markAnalyticsChanged } from "./analyticsRevision";
import { getDb } from "./schema";
import type { MessageRow, ToolEventRow } from "./types";

export async function appendMessage(
	sessionId: string,
	seq: number,
	role: string,
	text: string,
	turnId?: string,
): Promise<void> {
	const db = await getDb();
	db.run(
		`INSERT INTO messages (session_id, seq, role, text, timestamp, turn_id) VALUES (?, ?, ?, ?, unixepoch(), ?)`,
		[sessionId, seq, role, text, turnId ?? null],
	);
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

export async function appendToolEvent(
	sessionId: string,
	assistantSeq: number,
	toolId: string,
	name: string,
	input: unknown,
	subagent?: SubagentSnapshot,
): Promise<void> {
	const db = await getDb();
	db.run(
		`INSERT INTO tool_events (session_id, assistant_seq, tool_id, name, input_json, subagent_json) VALUES (?, ?, ?, ?, ?, ?)`,
		[
			sessionId,
			assistantSeq,
			toolId,
			name,
			input !== undefined ? JSON.stringify(input) : null,
			subagent ? JSON.stringify(subagent) : null,
		],
	);
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

export async function setToolEventResult(
	sessionId: string,
	toolId: string,
	resultText: string,
	isError: boolean,
): Promise<void> {
	const db = await getDb();
	const { changes } = db.run(
		`UPDATE tool_events SET result_text = ?, is_error = ? WHERE session_id = ? AND tool_id = ?`,
		[resultText, isError ? 1 : 0, sessionId, toolId],
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
	answers_json: string | null;
	notes_json: string | null;
	timestamp: number;
};

export async function appendAskUserQuestion(
	sessionId: string,
	requestId: string,
	seq: number,
	questionsJson: string,
): Promise<void> {
	const db = await getDb();
	db.run(
		`INSERT INTO ask_user_questions (session_id, request_id, seq, questions_json, timestamp) VALUES (?, ?, ?, ?, unixepoch())
     ON CONFLICT(request_id) DO UPDATE SET questions_json = excluded.questions_json`,
		[sessionId, requestId, seq, questionsJson],
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
			"request_id, seq, questions_json, answers_json, notes_json, timestamp",
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
	if (minSeq !== undefined) {
		if (minId !== undefined) {
			return db
				.query<MessageRow, [string, number, number]>(
					`SELECT * FROM messages
					 WHERE session_id = ?
					   AND (seq, id) >= (?, ?)
					 ORDER BY seq ASC, id ASC`,
				)
				.all(sessionId, minSeq, minId);
		}
		return db
			.query<MessageRow, [string, number]>(
				`SELECT * FROM messages WHERE session_id = ? AND seq >= ? ORDER BY seq ASC, id ASC`,
			)
			.all(sessionId, minSeq);
	}
	if (limit !== undefined) {
		if (beforeSeq !== undefined) {
			if (beforeId !== undefined) {
				return db
					.query<MessageRow, [string, number, number, number]>(
						`SELECT * FROM (
							SELECT * FROM messages
							WHERE session_id = ?
							  AND (seq, id) < (?, ?)
							ORDER BY seq DESC, id DESC LIMIT ?
						) ORDER BY seq ASC, id ASC`,
					)
					.all(sessionId, beforeSeq, beforeId, limit);
			}
			return db
				.query<MessageRow, [string, number, number]>(
					`SELECT * FROM (
						SELECT * FROM messages
						WHERE session_id = ? AND seq < ?
						ORDER BY seq DESC, id DESC LIMIT ?
					) ORDER BY seq ASC, id ASC`,
				)
				.all(sessionId, beforeSeq, limit);
		}
		return db
			.query<MessageRow, [string, number]>(
				`SELECT * FROM (
					SELECT * FROM messages
					WHERE session_id = ?
					ORDER BY seq DESC, id DESC LIMIT ?
				) ORDER BY seq ASC, id ASC`,
			)
			.all(sessionId, limit);
	}
	return db
		.query<MessageRow, [string]>(
			`SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC, id ASC`,
		)
		.all(sessionId);
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

export async function getSessionToolEvents(
	sessionId: string,
	minAssistantSeq?: number,
	beforeAssistantSeq?: number,
	maxAssistantSeq?: number,
): Promise<ToolEventRow[]> {
	return getSessionSequenceRows<ToolEventRow>({
		sessionId,
		select: "*",
		table: "tool_events",
		sequenceColumn: "assistant_seq",
		minSequence: minAssistantSeq,
		beforeSequence: beforeAssistantSeq,
		maxSequence: maxAssistantSeq,
		unboundedOrderBy: "id ASC",
	});
}
