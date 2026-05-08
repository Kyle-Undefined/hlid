import { useEffect } from "react";
import type { Action } from "#/components/chat/chatReducer";
import * as wsStore from "#/hooks/wsStore";
import {
	getSessionContextFn,
	getSessionDataFn,
	getSessionPermissionsFn,
} from "#/lib/serverFns";
import { uid } from "#/lib/utils";
import type { ServerMessage } from "#/server/protocol";

/**
 * Loads session history from the DB on mount and seeds the chat reducer.
 * Handles buffering, drain, and ordering of messages vs. permission events.
 * Pure side-effect — no return value.
 */
export function useLoadChatHistory({
	existingSessionId,
	isExplicitSession,
	dispatch,
	pendingIdRef,
	historyReadyRef,
	handleWsMessage,
}: {
	existingSessionId: string | null;
	isExplicitSession: boolean;
	dispatch: React.Dispatch<Action>;
	pendingIdRef: React.MutableRefObject<string | null>;
	historyReadyRef: React.MutableRefObject<boolean>;
	handleWsMessage: (msg: ServerMessage) => void;
}): void {
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
				// For implicit resumes (fresh nav, no session param), reset live stats
				// first so we don't carry over context from the previous session.
				if (!isExplicitSession) wsStore.resetLiveStats();
				if (ctx?.context_window && ctx.last_context_used != null) {
					wsStore.seedContextStats(ctx.context_window, ctx.last_context_used);
				}
				if (ctx?.actual_model !== undefined) {
					wsStore.seedActualModel(ctx.actual_model);
				}
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
				const sortedItems = [...messageItems, ...permissionItems].sort(
					(a, b) => a.timestamp - b.timestamp,
				);
				dispatch({
					type: "LOAD_HISTORY",
					items: sortedItems,
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
}
