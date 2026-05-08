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
