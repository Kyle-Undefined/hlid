import { useEffect, useRef } from "react";
import type { Action } from "#/components/chat/chatReducer";
import { loadSessionSnapshot } from "#/hooks/loadSessionSnapshot";
import type { WsStatus } from "#/hooks/wsStore";
import * as wsStore from "#/hooks/wsStore";
import { uid } from "#/lib/utils";
import type { ServerMessage } from "#/server/protocol";

/**
 * Loads session history from the DB on mount and seeds the chat reducer.
 * Handles buffering, drain, and ordering of messages vs. permission events.
 *
 * Also recovers on WS reconnect: if the WS went down while a query was running,
 * the done event may have been missed. On every reconnect (after the initial
 * load) we re-fetch from DB — which has the complete response before done fires
 * — clear any stale pending bubble, and dispatch LOAD_HISTORY.
 */
export function useLoadChatHistory({
	existingSessionId,
	isExplicitSession,
	dispatch,
	pendingIdRef,
	historyReadyRef,
	handleWsMessage,
	wsStatus,
	sessionIdRef,
}: {
	existingSessionId: string | null;
	isExplicitSession: boolean;
	dispatch: React.Dispatch<Action>;
	pendingIdRef: React.MutableRefObject<string | null>;
	historyReadyRef: React.MutableRefObject<boolean>;
	handleWsMessage: (msg: ServerMessage) => void;
	wsStatus: WsStatus;
	sessionIdRef: React.MutableRefObject<string>;
}): void {
	// ── initial load ───────────────────────────────────────────────────────────

	// biome-ignore lint/correctness/useExhaustiveDependencies: dispatch/pendingIdRef/historyReadyRef are stable — refs and useReducer dispatch never change
	useEffect(() => {
		// Enable buffering so events arriving before history loads are captured
		// and can be replayed via drainMessageBuffer() after LOAD_HISTORY.
		wsStore.setBufferingEnabled(true);

		if (!existingSessionId) {
			const p = wsStore.claimPendingPrompt();
			if (p) dispatch({ type: "ADD_USER", id: uid(), text: p });
			historyReadyRef.current = true;
			wsStore.setBufferingEnabled(false);
			wsStore.send({ type: "sync" });
			return () => {
				wsStore.setBufferingEnabled(true);
			};
		}

		// Do NOT reset live stats here. Stats represent the active/running session
		// and should persist across SPA navigations (viewing other sessions, ledger,
		// home) until a new run is explicitly started. Resetting here caused stats to
		// disappear whenever the user navigated back to the raven page. The reset
		// responsibility lives in index.tsx (new non-same-session run) and
		// raven.tsx (explicit clear action).
		let cancelled = false;
		loadSessionSnapshot({
			sessionId: existingSessionId,
			dispatch,
			pendingIdRef,
			handleWsMessage,
			isCancelled: () => cancelled,
		})
			.then((result) => {
				if (cancelled || !result) return;
				const { rows } = result;
				const p = wsStore.claimPendingPrompt();
				if (p) {
					const lastRow = rows[rows.length - 1];
					if (!lastRow || lastRow.role !== "user" || lastRow.text !== p) {
						dispatch({ type: "ADD_USER", id: uid(), text: p });
					}
				}
				// Mark the reducer ready before requesting sync. A fast status/queue_state
				// reply can otherwise be gated out by useChatWsHandler, which loses the
				// queued-turn promotion until a manual refresh.
				historyReadyRef.current = true;
				wsStore.setBufferingEnabled(false);
				// Sync with server to claim session ownership if not yet set
				wsStore.send({ type: "sync" });
			})
			.catch(console.error)
			.finally(() => {
				if (!cancelled) historyReadyRef.current = true;
			});

		return () => {
			cancelled = true;
			// Re-enable buffering for SPA nav so events during unmount are captured
			wsStore.setBufferingEnabled(true);
		};
	}, [existingSessionId, handleWsMessage, isExplicitSession]);

	// ── reconnect recovery ─────────────────────────────────────────────────────
	// When the WS reconnects after a disconnect, the "done" event for any
	// in-flight query was likely lost. The DB has the full response (it's
	// written before done is broadcast), so we re-fetch on every reconnect.
	// This is a no-op when the session is genuinely empty (rows === []).

	const wsConnectedOnceRef = useRef(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: pendingIdRef/historyReadyRef/sessionIdRef/dispatch/handleWsMessage are all stable
	useEffect(() => {
		if (wsStatus !== "connected") return;

		if (!wsConnectedOnceRef.current) {
			// First connect — initial load effect handles history for existing sessions.
			wsConnectedOnceRef.current = true;
			return;
		}

		// Reconnect — skip if initial history load isn't done yet
		if (!historyReadyRef.current) return;

		const sid = sessionIdRef.current;
		if (!sid) return;

		let cancelled = false;
		pendingIdRef.current = null; // Discard any stale in-progress bubble
		wsStore.setBufferingEnabled(true); // Capture live events during re-fetch

		loadSessionSnapshot({
			sessionId: sid,
			dispatch,
			pendingIdRef,
			handleWsMessage,
			isCancelled: () => cancelled,
		})
			.catch(console.error)
			.finally(() => wsStore.setBufferingEnabled(false));

		return () => {
			cancelled = true;
		};
	}, [wsStatus]);
}
