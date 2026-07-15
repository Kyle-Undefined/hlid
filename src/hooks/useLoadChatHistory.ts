import { useCallback, useEffect, useRef, useState } from "react";
import type { Action } from "#/components/chat/chatReducer";
import {
	loadSessionHistoryPage,
	loadSessionSnapshot,
	SESSION_HISTORY_PAGE_SIZE,
} from "#/hooks/loadSessionSnapshot";
import { claimPendingPrompt } from "#/hooks/wsChatQueueStore";
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
}) {
	const oldestSeqRef = useRef<number | null>(null);
	const oldestIdRef = useRef<number | null>(null);
	const hasOlderRef = useRef(false);
	const loadingOlderRef = useRef(false);
	const olderRequestRef = useRef<Promise<number> | null>(null);
	const reconnectRequestRef = useRef<Promise<void> | null>(null);
	const loadGenerationRef = useRef(0);
	const [hasOlderHistory, setHasOlderHistory] = useState(false);
	const [isLoadingOlderHistory, setIsLoadingOlderHistory] = useState(false);

	const applyPageState = useCallback(
		(page: {
			rows: Array<{ id: number; seq: number }>;
			hasOlder: boolean;
			nextBeforeSeq: number | null;
			nextBeforeId: number | null;
		}) => {
			oldestSeqRef.current = page.nextBeforeSeq;
			oldestIdRef.current = page.nextBeforeId;
			hasOlderRef.current = page.hasOlder;
			setHasOlderHistory(page.hasOlder);
		},
		[],
	);
	// ── initial load ───────────────────────────────────────────────────────────

	// biome-ignore lint/correctness/useExhaustiveDependencies: dispatch/pendingIdRef/historyReadyRef are stable — refs and useReducer dispatch never change
	useEffect(() => {
		const generation = ++loadGenerationRef.current;
		oldestSeqRef.current = null;
		oldestIdRef.current = null;
		hasOlderRef.current = false;
		loadingOlderRef.current = false;
		setHasOlderHistory(false);
		setIsLoadingOlderHistory(false);
		// Enable buffering so events arriving before history loads are captured
		// and can be replayed via drainMessageBuffer() after LOAD_HISTORY.
		wsStore.setBufferingEnabled(true);

		if (!existingSessionId) {
			const p = claimPendingPrompt();
			if (p) dispatch({ type: "ADD_USER", id: uid(), text: p });
			historyReadyRef.current = true;
			wsStore.setBufferingEnabled(false);
			wsStore.send({ type: "sync" });
			return () => {
				if (loadGenerationRef.current === generation) {
					loadGenerationRef.current += 1;
				}
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
		// actualModel is session-specific. Do not let the previously viewed chat's
		// inference model leak into the restored session while its DB snapshot loads.
		wsStore.seedActualModel(null);
		loadSessionSnapshot({
			sessionId: existingSessionId,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage,
			isCancelled: () => cancelled,
		})
			.then((result) => {
				if (cancelled || !result) return;
				applyPageState(result);
				const { rows } = result;
				const p = claimPendingPrompt();
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
			if (loadGenerationRef.current === generation) {
				loadGenerationRef.current += 1;
			}
			// Re-enable buffering for SPA nav so events during unmount are captured
			wsStore.setBufferingEnabled(true);
		};
	}, [existingSessionId, handleWsMessage, isExplicitSession, applyPageState]);

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
		const priorReconnect = reconnectRequestRef.current;
		const reconnectRequest = (async () => {
			// Cursor prepends and reconnect snapshots both replace cursor state. Run
			// them in a single order so a late LOAD_HISTORY cannot erase a page that
			// finished while the reconnect request was in flight.
			if (priorReconnect) await priorReconnect;
			const olderRequest = olderRequestRef.current;
			if (olderRequest) await olderRequest.catch(() => 0);
			if (cancelled || sessionIdRef.current !== sid) return;

			pendingIdRef.current = null; // Discard any stale in-progress bubble
			wsStore.setBufferingEnabled(true); // Capture live events during re-fetch
			try {
				const result = await loadSessionSnapshot({
					sessionId: sid,
					dispatch,
					pendingIdRef,
					historyReadyRef,
					handleWsMessage,
					isCancelled: () => cancelled,
					pageSize: SESSION_HISTORY_PAGE_SIZE,
					...(oldestSeqRef.current !== null && oldestIdRef.current !== null
						? {
								preserveFromSeq: oldestSeqRef.current,
								preserveFromId: oldestIdRef.current,
								preserveHasOlder: hasOlderRef.current,
							}
						: {}),
				});
				if (!cancelled && result) applyPageState(result);
			} finally {
				if (!cancelled) wsStore.setBufferingEnabled(false);
			}
		})().catch(console.error);
		reconnectRequestRef.current = reconnectRequest;
		void reconnectRequest.finally(() => {
			if (reconnectRequestRef.current === reconnectRequest) {
				reconnectRequestRef.current = null;
			}
		});

		return () => {
			cancelled = true;
		};
	}, [wsStatus, applyPageState]);

	const loadOlderHistory = useCallback(async (): Promise<number> => {
		const sessionId = sessionIdRef.current;
		if (
			!sessionId ||
			oldestSeqRef.current === null ||
			oldestIdRef.current === null ||
			!hasOlderRef.current ||
			loadingOlderRef.current
		) {
			return 0;
		}
		const generation = loadGenerationRef.current;
		loadingOlderRef.current = true;
		setIsLoadingOlderHistory(true);
		const olderRequest = (async () => {
			const reconnectRequest = reconnectRequestRef.current;
			if (reconnectRequest) await reconnectRequest;
			const beforeSeq = oldestSeqRef.current;
			const beforeId = oldestIdRef.current;
			if (
				beforeSeq === null ||
				beforeId === null ||
				!hasOlderRef.current ||
				generation !== loadGenerationRef.current ||
				sessionIdRef.current !== sessionId
			) {
				return 0;
			}
			const page = await loadSessionHistoryPage({
				sessionId,
				beforeSeq,
				beforeId,
			});
			if (
				generation !== loadGenerationRef.current ||
				sessionIdRef.current !== sessionId
			) {
				return 0;
			}
			dispatch({ type: "PREPEND_HISTORY", items: page.items });
			oldestSeqRef.current = page.nextBeforeSeq;
			oldestIdRef.current = page.nextBeforeId;
			hasOlderRef.current = page.hasOlder;
			setHasOlderHistory(page.hasOlder);
			return page.items.length;
		})();
		olderRequestRef.current = olderRequest;
		try {
			return await olderRequest;
		} catch (error) {
			console.error(error);
			return 0;
		} finally {
			if (olderRequestRef.current === olderRequest) {
				olderRequestRef.current = null;
			}
			if (generation === loadGenerationRef.current) {
				loadingOlderRef.current = false;
				setIsLoadingOlderHistory(false);
			}
		}
	}, [dispatch, sessionIdRef]);

	return {
		hasOlderHistory,
		isLoadingOlderHistory,
		loadOlderHistory,
	};
}
