import type { SessionStatusEntry } from "#/server/protocol";

/**
 * Vault placeholders exist in the live pool before they have opened a chat.
 * They are not Ledger sessions yet, but an idle entry with a DB chat is.
 */
export function isLedgerOpenSession(session: SessionStatusEntry): boolean {
	return (
		Boolean(session.hasDbSession || session.db_session_id) ||
		session.state !== "idle"
	);
}
