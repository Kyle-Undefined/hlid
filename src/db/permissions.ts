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
): Promise<PermissionEventRow[]> {
	const db = await getDb();
	return db
		.query<PermissionEventRow, [string]>(
			`SELECT tool_id, tool_name, display_name, decision, timestamp
       FROM permission_events
       WHERE session_id = ?
       ORDER BY timestamp ASC, rowid ASC`,
		)
		.all(sessionId);
}
