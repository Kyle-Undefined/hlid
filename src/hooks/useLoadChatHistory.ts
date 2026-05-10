import { useEffect, useRef } from "react";
import type { Action } from "#/components/chat/chatReducer";
import type { WsStatus } from "#/hooks/wsStore";
import * as wsStore from "#/hooks/wsStore";
import {
	getSessionContextFn,
	getSessionDataFn,
	getSessionPermissionsFn,
	getSessionPlanProposalsFn,
} from "#/lib/serverFns";
import { uid } from "#/lib/utils";
import type { ServerMessage } from "#/server/protocol";

// ─── shared row-mapping helpers ───────────────────────────────────────────────

type SessionDataRow = Awaited<ReturnType<typeof getSessionDataFn>>[number];
type PermRow = Awaited<ReturnType<typeof getSessionPermissionsFn>>[number];
type PlanRow = Awaited<ReturnType<typeof getSessionPlanProposalsFn>>[number];
type CtxRow = Awaited<ReturnType<typeof getSessionContextFn>>;

function mapSessionRows(
	rows: SessionDataRow[],
	permEvents: PermRow[],
	planRows: PlanRow[],
) {
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
			...(te.result_text != null ? { result: te.result_text } : {}),
			...(te.is_error != null ? { isError: te.is_error === 1 } : {}),
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
	const planItems = planRows.map((p) => ({
		kind: "plan_proposal" as const,
		timestamp: p.timestamp,
		id: p.proposal_id,
		plan: p.plan,
		decision: p.decision,
	}));
	return [...messageItems, ...permissionItems, ...planItems].sort(
		(a, b) => a.timestamp - b.timestamp,
	);
}

/**
 * Find the in-flight assistant placeholder (last assistant row with empty
 * text). The server pre-inserts this on the first tool_start so a mid-turn
 * reload can show the tool calls. If found, returns the id used in the mapped
 * items (so callers can reuse it as pendingIdRef instead of dispatching a
 * fresh ADD_ASSISTANT).
 */
function findPlaceholderAssistant(
	items: ReturnType<typeof mapSessionRows>,
): { id: string; toolIds: Set<string> } | null {
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item.kind !== "message") continue;
		if (item.role === "user") return null;
		if (item.role === "assistant" && item.text === "") {
			const toolIds = new Set<string>();
			for (const te of item.toolEvents ?? []) toolIds.add(te.id);
			return { id: item.id, toolIds };
		}
		// Last assistant row already has text — not a placeholder.
		return null;
	}
	return null;
}

/**
 * Drain wsStore buffer into the chat handler when reusing a placeholder.
 *
 * The server is the source of truth: assistant text streams to DB on every
 * chunk, tool_event/tool_result rows persist live, plan proposals + permissions
 * are written immediately. So the buffer (events that arrived while the
 * component was unmounted) is mostly redundant on a placeholder reload —
 * everything's already in the LOAD_HISTORY snapshot.
 *
 * Skip:
 *   - chunk: assistant text already in DB row.text
 *   - tool_event/tool_result whose tool_use_id is on the placeholder.
 *
 * Pass through everything else (status, usage_update, ask_user_question, etc.)
 * because those aren't fully captured in the message row snapshot.
 */
function drainBufferDeduped(
	handle: (msg: import("#/server/protocol").ServerMessage) => void,
	knownToolIds: Set<string>,
): void {
	for (const msg of wsStore.drainMessageBuffer()) {
		if (msg.type === "chunk") continue;
		if (
			(msg.type === "tool_event" || msg.type === "tool_result") &&
			knownToolIds.has(msg.id)
		) {
			continue;
		}
		handle(msg);
	}
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
			getSessionPlanProposalsFn({ data: existingSessionId }),
		])
			.then(([rows, ctx, permEvents, planRows]) => {
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
				const items = mapSessionRows(rows, permEvents, planRows);
				dispatch({ type: "LOAD_HISTORY", items });
				const placeholder = findPlaceholderAssistant(items);
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
					if (placeholder) {
						// Reuse the in-flight assistant placeholder loaded from DB instead
						// of opening a fresh bubble — otherwise the user sees two
						// assistant blocks (placeholder with persisted tool_events + new
						// empty bubble for live chunks). Dedup the buffer so already
						// persisted tool_events don't reapply.
						pendingIdRef.current = placeholder.id;
						drainBufferDeduped(handleWsMessage, placeholder.toolIds);
					} else {
						const newId = uid();
						pendingIdRef.current = newId;
						dispatch({ type: "ADD_ASSISTANT", id: newId });
						// Replay events that arrived before history was ready (from open() buffer
						// replay or live events during the async DB fetch). Buffering is then
						// disabled so events flow directly for the rest of the session.
						for (const msg of wsStore.drainMessageBuffer()) {
							handleWsMessage(msg);
						}
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
			getSessionPlanProposalsFn({ data: sid }),
		])
			.then(([rows, ctx, permEvents, planRows]) => {
				if (cancelled) return;
				applyCtx(ctx);
				const items = mapSessionRows(rows, permEvents, planRows);
				dispatch({ type: "LOAD_HISTORY", items });
				const placeholder = findPlaceholderAssistant(items);
				if (wsStore.getSnapshot().sessionState === "running") {
					if (placeholder) {
						pendingIdRef.current = placeholder.id;
						drainBufferDeduped(handleWsMessage, placeholder.toolIds);
					} else {
						const newId = uid();
						pendingIdRef.current = newId;
						dispatch({ type: "ADD_ASSISTANT", id: newId });
						for (const msg of wsStore.drainMessageBuffer()) {
							handleWsMessage(msg);
						}
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
