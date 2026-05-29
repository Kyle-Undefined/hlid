import type { SessionStatusEntry } from "./protocol";
import type { SessionPool } from "./sessionPool";
import type { TerminalSessionPool } from "./terminalSessionPool";

/** Authoritative live-session snapshot shown by WS clients and /db/live-sessions. */
export function getLiveSessionsStatus(
	pool?: Pick<SessionPool, "getSessionsStatus">,
	terminalPool?: Pick<TerminalSessionPool, "getSessionsStatus">,
): SessionStatusEntry[] {
	return [
		...(pool?.getSessionsStatus() ?? []),
		...(terminalPool?.getSessionsStatus() ?? []),
	];
}

export function hasLiveTerminalSession(
	terminalPool: Pick<TerminalSessionPool, "getSessionsStatus"> | undefined,
	sessionId: string,
): boolean {
	return (
		terminalPool
			?.getSessionsStatus()
			.some((session) => session.session_id === sessionId) ?? false
	);
}
