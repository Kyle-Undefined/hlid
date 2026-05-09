import { useEffect, useRef } from "react";
import type { Action } from "#/components/chat/chatReducer";
import type { WsStatus } from "#/hooks/wsStore";
import * as wsStore from "#/hooks/wsStore";
import {
	getSessionContextFn,
	getSessionDataFn,
	getSessionPermissionsFn,
} from "#/lib/serverFns";
import { uid } from "#/lib/utils";
import type { ServerMessage } from "#/server/protocol";

// ─── shared row-mapping helpers ───────────────────────────────────────────────

type SessionDataRow = Awaited<ReturnType<typeof getSessionDataFn>>[number];
type PermRow = Awaited<ReturnType<typeof getSessionPermissionsFn>>[number];
type CtxRow = Awaited<ReturnType<typeof getSessionContextFn>>;

function mapSessionRows(rows: SessionDataRow[], permEvents: PermRow[]) {
	const messageItems = rows.map((r) => ({
		kind: "message" as const,
		timestamp: r.timestamp,
		id: uid(),
		role: r.role,
		text: r.text,
		toolEvents: r.toolEvents?.map((te) => ({
			type: "tool_event" as const,
			id: te.tool_id,
			name: te.name,
			input: (() => {
				try {
					return JSON.parse(te.input_json) as unknown;
				} catch {
					return {};
				}
			})(),
		})),
		attachments: r.attachments?.map((a) => ({
			id: a.id,
			path: a.path,
			filename: a.filename,
			mime: a.mime,
			kind: a.kind,
		})),
		recap: r.recap,
	}));
	const permissionItems = permEvents.map((p) => ({
		kind: "permission" as const,
		timestamp: p.timestamp,
		tool_id: p.tool_id,
		tool_name: p.tool_name,
		display_name: p.display_name,
		decision: p.decision,
	}));
	return [...messageItems, ...permissionItems].sort(
		(a, b) => a.timestamp - b.timestamp,
	);
}

function applyCtx(ctx: CtxRow): void {
	if (ctx?.context_window && ctx.last_context_used != null) {
		wsStore.seedContextStats(ctx.context_window, ctx.last_context_used);
	}
	if (ctx?.actual_model !== undefined) {
		wsStore.seedActualModel(ctx.actual_model);
	}
}

// ─── hook ─────────────────────────────────────────────────────────────────────

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

		let cancelled = false;
		Promise.all([
			getSessionDataFn({ data: existingSessionId }),
			getSessionContextFn({ data: existingSessionId }),
			getSessionPermissionsFn({ data: existingSessionId }),
		])
			.then(([rows, ctx, permEvents]) => {
				if (cancelled) return;
				// Seed context gauge from DB so it's visible immediately on session open,
				// before any new message is sent. Live usage_update/done events will
				// override this once the session is active.
				// Reset unconditionally on any session nav — avoids prior-session counters
				// (turns, cost, tokens) bleeding into the newly-opened session.
				// applyCtx re-seeds context_window/last_context_used/actual_model from DB;
				// cumulative counters (turns, cost, tokens) will update on next done event.
				wsStore.resetLiveStats();
				applyCtx(ctx);
				dispatch({
					type: "LOAD_HISTORY",
					items: mapSessionRows(rows, permEvents),
				});
				const p = wsStore.claimPendingPrompt();
				if (p) {
					const lastRow = rows[rows.length - 1];
					if (!lastRow || lastRow.role !== "user" || lastRow.text !== p) {
						dispatch({ type: "ADD_USER", id: uid(), text: p });
					}
				}
				historyReadyRef.current = true;
				// Reset any stale pending ID — LOAD_HISTORY wiped the bubble it referenced,
				// so we must start fresh before draining. Without this, chunks buffered
				// during the DB fetch get APPEND_CHUNK'd to a non-existent message ID and
				// silently vanish (the reducer map-over just skips the missing ID).
				pendingIdRef.current = null;
				// If session is running, add a fresh bubble before draining so buffered
				// chunks have a target to attach to. If the session already completed
				// while history was loading, skip drain (DB data is authoritative) and
				// clear the buffer to avoid replaying stale chunks into the wrong bubble.
				if (wsStore.getSnapshot().sessionState === "running") {
					const newId = uid();
					pendingIdRef.current = newId;
					dispatch({ type: "ADD_ASSISTANT", id: newId });
					// Replay events that arrived before history was ready (from open() buffer
					// replay or live events during the async DB fetch). Buffering is then
					// disabled so events flow directly for the rest of the session.
					for (const msg of wsStore.drainMessageBuffer()) {
						handleWsMessage(msg);
					}
				} else {
					// Session done before history loaded — DB has complete data, discard buffer.
					wsStore.clearMessageBuffer();
				}
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

		Promise.all([
			getSessionDataFn({ data: sid }),
			getSessionContextFn({ data: sid }),
			getSessionPermissionsFn({ data: sid }),
		])
			.then(([rows, ctx, permEvents]) => {
				if (cancelled) return;
				applyCtx(ctx);
				dispatch({
					type: "LOAD_HISTORY",
					items: mapSessionRows(rows, permEvents),
				});
				if (wsStore.getSnapshot().sessionState === "running") {
					const newId = uid();
					pendingIdRef.current = newId;
					dispatch({ type: "ADD_ASSISTANT", id: newId });
					for (const msg of wsStore.drainMessageBuffer()) {
						handleWsMessage(msg);
					}
				} else {
					wsStore.clearMessageBuffer();
				}
			})
			.catch(console.error)
			.finally(() => wsStore.setBufferingEnabled(false));

		return () => {
			cancelled = true;
		};
	}, [wsStatus]);
}
