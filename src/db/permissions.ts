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
		`INSERT INTO permission_events
			(session_id, tool_id, tool_name, display_name, decision,
			 human_decision, human_timestamp, timestamp)
		 VALUES (?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
		 ON CONFLICT(session_id, tool_id) DO UPDATE SET
			 tool_name = excluded.tool_name,
			 display_name = COALESCE(excluded.display_name, permission_events.display_name),
			 decision = excluded.decision,
			 human_decision = excluded.human_decision,
			 human_timestamp = excluded.human_timestamp,
			 timestamp = MAX(permission_events.timestamp, excluded.timestamp)`,
		[sessionId, toolId, toolName, displayName ?? null, decision, decision],
	);
}

export type ProviderPermissionDeniedInput = {
	sessionId: string;
	toolId: string;
	toolName: string;
	displayName?: string;
	providerId: string;
	providerSessionId: string;
	reasonType?: string;
	reason?: string;
	message?: string;
};

/**
 * Persist provider-reported denial evidence without changing the independent
 * human decision. The unique session/tool key makes SDK result replay
 * idempotent, while COALESCE retains the first complete bounded advisory.
 */
export async function recordProviderPermissionDenied(
	input: ProviderPermissionDeniedInput,
): Promise<boolean> {
	const db = await getDb();
	const result = await db.run(
		`INSERT INTO permission_events
			(session_id, tool_id, tool_name, display_name, decision,
			 provider_outcome, provider_id, provider_session_id,
			 provider_reason_type, provider_reason, provider_message,
			 provider_timestamp, timestamp)
		 VALUES (?, ?, ?, ?, 'provider_blocked', 'blocked', ?, ?, ?, ?, ?,
		         unixepoch(), unixepoch())
		 ON CONFLICT(session_id, tool_id) DO UPDATE SET
			 tool_name = CASE
				 WHEN permission_events.tool_name = '' THEN excluded.tool_name
				 ELSE permission_events.tool_name
			 END,
			 display_name = COALESCE(permission_events.display_name, excluded.display_name),
			 provider_outcome = 'blocked',
			 provider_id = COALESCE(permission_events.provider_id, excluded.provider_id),
			 provider_session_id = COALESCE(
				 permission_events.provider_session_id,
				 excluded.provider_session_id
			 ),
			 provider_reason_type = COALESCE(
				 permission_events.provider_reason_type,
				 excluded.provider_reason_type
			 ),
			 provider_reason = COALESCE(
				 permission_events.provider_reason,
				 excluded.provider_reason
			 ),
			 provider_message = COALESCE(
				 permission_events.provider_message,
				 excluded.provider_message
			 ),
			 timestamp = CASE
				 WHEN permission_events.provider_outcome IS NULL
				 THEN MAX(permission_events.timestamp, excluded.timestamp)
				 ELSE permission_events.timestamp
			 END,
			 provider_timestamp = COALESCE(
				 permission_events.provider_timestamp,
				 excluded.provider_timestamp
			 )
		 WHERE (permission_events.provider_session_id IS NULL
		        OR permission_events.provider_session_id = excluded.provider_session_id)
		   AND (permission_events.provider_id IS NULL
		        OR permission_events.provider_id = excluded.provider_id)`,
		[
			input.sessionId,
			input.toolId,
			input.toolName,
			input.displayName ?? null,
			input.providerId,
			input.providerSessionId,
			input.reasonType ?? null,
			input.reason ?? null,
			input.message ?? null,
		],
	);
	return result.changes > 0;
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
		const sql = `SELECT pe.tool_id, pe.tool_name, pe.display_name, pe.decision,
				pe.human_decision, pe.provider_outcome, pe.provider_id,
				pe.provider_reason_type, pe.provider_reason, pe.provider_message,
				pe.timestamp
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
			`SELECT tool_id, tool_name, display_name, decision, human_decision,
			        provider_outcome, provider_id, provider_reason_type,
			        provider_reason, provider_message, timestamp
       FROM permission_events
       WHERE session_id = ?
       ORDER BY timestamp ASC, rowid ASC`,
		)
		.all(sessionId);
}
