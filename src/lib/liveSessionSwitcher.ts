import type { SessionStatusEntry } from "#/server/protocol";

export type LiveSessionState = "waiting" | "working" | "ready";

export type LiveSessionSwitcherRow = {
	session: SessionStatusEntry;
	dbSessionId: string;
	state: LiveSessionState;
};

const STATE_PRIORITY: Record<LiveSessionState, number> = {
	waiting: 0,
	working: 1,
	ready: 2,
};

export function liveSessionState(
	session: SessionStatusEntry,
): LiveSessionState {
	if (session.hasPendingPermissions || session.state === "error") {
		return "waiting";
	}
	if (session.state === "running") return "working";
	return "ready";
}

/**
 * A Raven switch target must be both process-backed and attached to a real
 * database chat. Fresh pool placeholders are intentionally excluded.
 */
export function deriveLiveSessionSwitcherRows(
	sessions: SessionStatusEntry[],
): LiveSessionSwitcherRow[] {
	return sessions
		.map((session, sourceIndex) => ({ session, sourceIndex }))
		.filter(
			(
				entry,
			): entry is {
				session: SessionStatusEntry & { db_session_id: string };
				sourceIndex: number;
			} => entry.session.hasDbSession && Boolean(entry.session.db_session_id),
		)
		.map(({ session, sourceIndex }) => ({
			session,
			sourceIndex,
			dbSessionId: session.db_session_id,
			state: liveSessionState(session),
		}))
		.sort(
			(left, right) =>
				STATE_PRIORITY[left.state] - STATE_PRIORITY[right.state] ||
				left.sourceIndex - right.sourceIndex,
		)
		.map(({ sourceIndex: _sourceIndex, ...row }) => row);
}

export type LiveSessionToggleTone = "empty" | LiveSessionState;

export function liveSessionToggleTone(
	rows: LiveSessionSwitcherRow[],
): LiveSessionToggleTone {
	if (rows.length === 0) return "empty";
	if (rows.some((row) => row.state === "waiting")) return "waiting";
	if (rows.some((row) => row.state === "working")) return "working";
	return "ready";
}

export function liveSessionContext(session: SessionStatusEntry): string {
	return [
		session.provider_id,
		session.model,
		session.mode === "terminal" ? "terminal" : undefined,
	]
		.filter((part): part is string => Boolean(part))
		.join(" · ");
}
