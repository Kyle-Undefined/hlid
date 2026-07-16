import type { SessionStatusEntry, StatusMessage } from "../server/protocol";

const PENDING_NEW_SESSION_ID = "__hlid_pending_new_session__";

let sessionsStatus: SessionStatusEntry[] = [];
let subscribedSessionId = "";
const subscribers = new Set<() => void>();

export type AggregateNavStatus = {
	state: "idle" | "running" | "error";
	sessionCount: number;
	runningCount: number;
	pendingPermissions: boolean;
};

let aggregateNavStatus: AggregateNavStatus = {
	state: "idle",
	sessionCount: 0,
	runningCount: 0,
	pendingPermissions: false,
};

function recomputeAggregateNavStatus(): void {
	let hasRunning = false;
	let hasError = false;
	let runningCount = 0;
	let pendingPermissions = false;
	for (const session of sessionsStatus) {
		if (session.state === "running") {
			hasRunning = true;
			runningCount++;
		}
		if (session.state === "error") hasError = true;
		if (session.hasPendingPermissions) pendingPermissions = true;
	}
	const state: AggregateNavStatus["state"] = hasRunning
		? "running"
		: hasError
			? "error"
			: "idle";
	const sessionCount = sessionsStatus.length;
	if (
		state !== aggregateNavStatus.state ||
		sessionCount !== aggregateNavStatus.sessionCount ||
		runningCount !== aggregateNavStatus.runningCount ||
		pendingPermissions !== aggregateNavStatus.pendingPermissions
	) {
		aggregateNavStatus = {
			state,
			sessionCount,
			runningCount,
			pendingPermissions,
		};
	}
}

function notifySubscribers(): void {
	for (const subscriber of subscribers) subscriber();
}

export function replaceSessionsStatus(sessions: SessionStatusEntry[]): void {
	sessionsStatus = sessions;
	recomputeAggregateNavStatus();
	notifySubscribers();
}

/**
 * Reconcile a session-scoped status heartbeat into the latest pool snapshot.
 *
 * The focused chat and the nav aggregate arrive over separate WS messages. If
 * the pool-wide snapshot is delayed or missed, keeping its old `running` value
 * makes the status dot pulse until the next reconnect. A scoped heartbeat is
 * authoritative for these fields, so apply it by either the pool UUID or the
 * current DB chat ID without disturbing other live sessions.
 */
export function reconcileSessionStatus(
	sessionId: string,
	status: Pick<StatusMessage, "state" | "model" | "effort" | "permission_mode">,
): void {
	let changed = false;
	sessionsStatus = sessionsStatus.map((session) => {
		if (
			session.session_id !== sessionId &&
			session.db_session_id !== sessionId
		) {
			return session;
		}
		if (
			session.state === status.state &&
			session.model === status.model &&
			(status.effort === undefined || session.effort === status.effort) &&
			(status.permission_mode === undefined ||
				session.permission_mode === status.permission_mode)
		) {
			return session;
		}
		changed = true;
		return {
			...session,
			state: status.state,
			model: status.model,
			...(status.effort !== undefined ? { effort: status.effort } : {}),
			...(status.permission_mode !== undefined
				? { permission_mode: status.permission_mode }
				: {}),
		};
	});
	if (!changed) return;
	recomputeAggregateNavStatus();
	notifySubscribers();
}

export function removeSessionStatus(sessionId: string): void {
	sessionsStatus = sessionsStatus.filter(
		(session) => session.session_id !== sessionId,
	);
	recomputeAggregateNavStatus();
	notifySubscribers();
}

export function getSessionsStatus(): SessionStatusEntry[] {
	return sessionsStatus;
}

export function subscribeSessionsStatus(fn: () => void): () => void {
	subscribers.add(fn);
	return () => subscribers.delete(fn);
}

export function getAggregateNavStatus(): AggregateNavStatus {
	return aggregateNavStatus;
}

export function canonicalSessionId(sessionId: string): string {
	const status = sessionsStatus.find(
		(session) =>
			session.session_id === sessionId || session.db_session_id === sessionId,
	);
	return status?.db_session_id ?? status?.session_id ?? sessionId;
}

export function focusSession(sessionId: string): void {
	subscribedSessionId = sessionId;
}

export function focusPendingNewSession(): void {
	focusSession(PENDING_NEW_SESSION_ID);
}

export function getSubscribedSessionId(): string {
	return subscribedSessionId;
}

export function resetSessionStatusForTesting(): void {
	sessionsStatus = [];
	subscribedSessionId = "";
	aggregateNavStatus = {
		state: "idle",
		sessionCount: 0,
		runningCount: 0,
		pendingPermissions: false,
	};
	subscribers.clear();
}
