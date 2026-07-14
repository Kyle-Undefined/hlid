import type { SessionStatusEntry } from "../server/protocol";

const PENDING_NEW_SESSION_ID = "__hlid_pending_new_session__";

let sessionsStatus: SessionStatusEntry[] = [];
let subscribedSessionId = "";
const subscribers = new Set<() => void>();

export type AggregateNavStatus = {
	state: "idle" | "running" | "error";
	runningCount: number;
	pendingPermissions: boolean;
};

let aggregateNavStatus: AggregateNavStatus = {
	state: "idle",
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
	if (
		state !== aggregateNavStatus.state ||
		runningCount !== aggregateNavStatus.runningCount ||
		pendingPermissions !== aggregateNavStatus.pendingPermissions
	) {
		aggregateNavStatus = { state, runningCount, pendingPermissions };
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
		runningCount: 0,
		pendingPermissions: false,
	};
	subscribers.clear();
}
