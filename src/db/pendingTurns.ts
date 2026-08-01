import { getDb } from "./schema";

type PendingTurnState = "queued" | "sleeping" | "dispatching";

export type PendingSessionTurnRow = {
	turn_id: string;
	session_id: string;
	position: number;
	payload_json: string;
	state: PendingTurnState;
	provider_id: string | null;
	window_id: string | null;
	sleep_reason: "threshold" | "limit_reached" | null;
	sleep_until: number | null;
	sleep_target: number | null;
	sleep_utilization: number | null;
	cap_deadline: number | null;
	created_at: number;
	updated_at: number;
};

export async function enqueuePendingSessionTurn(input: {
	turnId: string;
	sessionId: string;
	payloadJson: string;
}): Promise<boolean> {
	const db = await getDb();
	let inserted = false;
	db.transaction(() => {
		const alreadyPersisted = db
			.query<{ found: number }, [string, string]>(
				`SELECT 1 AS found FROM messages
				 WHERE session_id = ? AND turn_id = ? AND role = 'user' LIMIT 1`,
			)
			.get(input.sessionId, input.turnId);
		if (alreadyPersisted) return;
		const position =
			db
				.query<{ next_position: number }, [string]>(
					`SELECT COALESCE(MAX(position), 0) + 1 AS next_position
					 FROM session_pending_turns WHERE session_id = ?`,
				)
				.get(input.sessionId)?.next_position ?? 1;
		const result = db.run(
			`INSERT OR IGNORE INTO session_pending_turns
			 (turn_id, session_id, position, payload_json, state)
			 VALUES (?, ?, ?, ?, 'queued')`,
			[input.turnId, input.sessionId, position, input.payloadJson],
		);
		inserted = result.changes > 0;
	})();
	return inserted;
}

export async function markPendingSessionTurnSleeping(input: {
	turnId: string;
	providerId: string;
	windowId: string;
	reason: "threshold" | "limit_reached";
	until: number;
	target: number | null;
	utilization: number | null;
	capDeadline: number | null;
}): Promise<void> {
	const db = await getDb();
	db.run(
		`UPDATE session_pending_turns
		 SET state = 'sleeping', provider_id = ?, window_id = ?, sleep_reason = ?,
		     sleep_until = ?, sleep_target = ?, sleep_utilization = ?,
		     cap_deadline = ?, updated_at = unixepoch()
		 WHERE turn_id = ? AND state IN ('queued', 'sleeping')`,
		[
			input.providerId,
			input.windowId,
			input.reason,
			input.until,
			input.target,
			input.utilization,
			input.capDeadline,
			input.turnId,
		],
	);
}

export async function markPendingSessionTurnDispatching(
	turnId: string,
): Promise<void> {
	const db = await getDb();
	const result = db.run(
		`UPDATE session_pending_turns
		 SET state = 'dispatching', updated_at = unixepoch()
		 WHERE turn_id = ? AND state IN ('queued', 'sleeping')`,
		[turnId],
	);
	if (result.changes === 0) {
		throw new Error(`Pending turn ${turnId} is no longer dispatchable.`);
	}
}

export async function deletePendingSessionTurn(turnId: string): Promise<void> {
	const db = await getDb();
	db.run(`DELETE FROM session_pending_turns WHERE turn_id = ?`, [turnId]);
}

export async function deletePendingSessionTurns(
	turnIds: readonly string[],
): Promise<void> {
	if (turnIds.length === 0) return;
	const db = await getDb();
	const remove = db.prepare(
		`DELETE FROM session_pending_turns WHERE turn_id = ?`,
	);
	db.transaction(() => {
		for (const turnId of turnIds) remove.run(turnId);
	})();
}

export async function promotePendingSessionTurn(input: {
	sessionId: string;
	turnId: string;
}): Promise<void> {
	const db = await getDb();
	db.transaction(() => {
		const row = db
			.query<{ position: number }, [string, string]>(
				`SELECT position FROM session_pending_turns
				 WHERE turn_id = ? AND session_id = ? AND state = 'queued'`,
			)
			.get(input.turnId, input.sessionId);
		if (!row) return;
		db.run(
			`UPDATE session_pending_turns SET position = position + 1
			 WHERE session_id = ? AND state = 'queued' AND position < ?`,
			[input.sessionId, row.position],
		);
		db.run(
			`UPDATE session_pending_turns
			 SET position = 1, updated_at = unixepoch() WHERE turn_id = ?`,
			[input.turnId],
		);
	})();
}

export async function listRecoverablePendingSessionTurns(): Promise<
	PendingSessionTurnRow[]
> {
	const db = await getDb();
	return db
		.query<PendingSessionTurnRow, []>(
			`SELECT pending.*
			 FROM session_pending_turns pending
			 JOIN sessions session ON session.id = pending.session_id
			 WHERE pending.state IN ('queued', 'sleeping')
			   AND session.archived_at IS NULL
			 ORDER BY pending.session_id, pending.position, pending.created_at`,
		)
		.all();
}

/** Dispatched turns are never replayed because provider acceptance is unclear. */
export async function discardDispatchingSessionTurnsAfterRestart(): Promise<number> {
	const db = await getDb();
	return db.run(`DELETE FROM session_pending_turns WHERE state = 'dispatching'`)
		.changes;
}
