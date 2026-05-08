/**
 * Pure helper for resolving which session ID to use when submitting a chat.
 *
 * Rules:
 *   sameSession = false  →  always new session (attachedId takes priority when
 *                            an attachment pre-selected a session, otherwise newId)
 *   sameSession = true   →  prefer the currently active session, then the most
 *                            recent session in DB, then fall back to newId only
 *                            if no existing sessions are available at all
 */
export function resolveSessionId({
	sameSession,
	currentId,
	mostRecentId,
	attachedId,
	newId,
}: {
	/** Whether the "same session" toggle is on */
	sameSession: boolean;
	/** ID of the currently active/in-progress session, or null */
	currentId: string | null;
	/** ID of the most recently completed session, or undefined if none */
	mostRecentId: string | undefined;
	/** Session ID pre-attached via an attachment flow, or null */
	attachedId: string | null;
	/** Pre-generated uid() to use when creating a brand-new session */
	newId: string;
}): string {
	if (sameSession) {
		return currentId ?? mostRecentId ?? newId;
	}
	return attachedId ?? newId;
}
