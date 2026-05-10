import { getDb } from "./schema";
import type { MessageRow, ToolEventRow } from "./types";

export async function appendMessage(
	sessionId: string,
	seq: number,
	role: string,
	text: string,
): Promise<void> {
	const db = await getDb();
	db.run(
		`INSERT INTO messages (session_id, seq, role, text, timestamp) VALUES (?, ?, ?, ?, unixepoch())`,
		[sessionId, seq, role, text],
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
): Promise<void> {
	const db = await getDb();
	db.run(
		`INSERT INTO tool_events (session_id, assistant_seq, tool_id, name, input_json) VALUES (?, ?, ?, ?, ?)`,
		[
			sessionId,
			assistantSeq,
			toolId,
			name,
			input !== undefined ? JSON.stringify(input) : null,
		],
	);
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
}

export async function appendPlanProposal(
	sessionId: string,
	proposalId: string,
	seq: number,
	plan: string,
	decision: string,
): Promise<void> {
	const db = await getDb();
	db.run(
		`INSERT INTO plan_proposals (session_id, proposal_id, seq, plan, decision, timestamp) VALUES (?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(proposal_id) DO UPDATE SET decision = excluded.decision`,
		[sessionId, proposalId, seq, plan, decision],
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
	timestamp: number;
};

export async function getSessionPlanProposals(
	sessionId: string,
): Promise<PlanProposalRow[]> {
	const db = await getDb();
	return db
		.query<PlanProposalRow, [string]>(
			`SELECT proposal_id, seq, plan, decision, timestamp FROM plan_proposals WHERE session_id = ? ORDER BY seq ASC`,
		)
		.all(sessionId);
}

export async function getSessionMessages(
	sessionId: string,
): Promise<MessageRow[]> {
	const db = await getDb();
	return db
		.query<MessageRow, [string]>(
			`SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC`,
		)
		.all(sessionId);
}

export async function getSessionToolEvents(
	sessionId: string,
): Promise<ToolEventRow[]> {
	const db = await getDb();
	return db
		.query<ToolEventRow, [string]>(
			`SELECT * FROM tool_events WHERE session_id = ? ORDER BY id ASC`,
		)
		.all(sessionId);
}
