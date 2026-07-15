import { getDb } from "./schema";
import type { PermissionEventRow } from "./types";

export async function recordPermissionEvent(
	sessionId: string,
	toolId: string,
	toolName: string,
	displayName: string | undefined,
	decision: string,
): Promise<void> {
	const db = await getDb();
	await db.run(
		`INSERT INTO permission_events (session_id, tool_id, tool_name, display_name, decision, timestamp)
     VALUES (?, ?, ?, ?, ?, unixepoch())`,
		[sessionId, toolId, toolName, displayName ?? null, decision],
	);
}

export async function getSessionPermissionEvents(
	sessionId: string,
	minAssistantSeq?: number,
	beforeAssistantSeq?: number,
	maxAssistantSeq?: number,
): Promise<PermissionEventRow[]> {
	const db = await getDb();
	if (minAssistantSeq !== undefined) {
		const upperBound =
			maxAssistantSeq !== undefined
				? "AND te.assistant_seq <= ?"
				: beforeAssistantSeq !== undefined
					? "AND te.assistant_seq < ?"
					: "";
		const upperValue = maxAssistantSeq ?? beforeAssistantSeq;
		// A few Hlid-owned approvals (notably Windows Computer Use) are persisted
		// without a corresponding provider tool_event. Include those standalone
		// decisions in the newest/reconnect window; older pages omit them so they
		// are not returned repeatedly.
		const standalone =
			beforeAssistantSeq === undefined
				? `OR NOT EXISTS (
					SELECT 1 FROM tool_events all_te
					WHERE all_te.session_id = pe.session_id
						AND all_te.tool_id = pe.tool_id
				)`
				: "";
		const sql = `SELECT pe.tool_id, pe.tool_name, pe.display_name, pe.decision, pe.timestamp
			FROM permission_events pe
			WHERE pe.session_id = ?
				AND (
					EXISTS (
						SELECT 1 FROM tool_events te
						WHERE te.session_id = pe.session_id
							AND te.tool_id = pe.tool_id
							AND te.assistant_seq >= ?
							${upperBound}
					)
					${standalone}
				)
			ORDER BY pe.timestamp ASC, pe.id ASC`;
		return upperValue === undefined
			? db
					.query<PermissionEventRow, [string, number]>(sql)
					.all(sessionId, minAssistantSeq)
			: db
					.query<PermissionEventRow, [string, number, number]>(sql)
					.all(sessionId, minAssistantSeq, upperValue);
	}
	return db
		.query<PermissionEventRow, [string]>(
			`SELECT tool_id, tool_name, display_name, decision, timestamp
       FROM permission_events
       WHERE session_id = ?
       ORDER BY timestamp ASC, rowid ASC`,
		)
		.all(sessionId);
}
