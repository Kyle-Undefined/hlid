import { useCallback } from "react";
import type { Action } from "#/components/chat/chatReducer";
import { uid } from "#/lib/utils";
import type { RateLimitMessage, ServerMessage } from "#/server/protocol";

/**
 * Returns a stable useCallback-wrapped WS message handler for the chat page.
 * All inputs are refs or stable setters so the dep array is empty — no stale
 * closure risk.
 */
export function useChatWsHandler({
	dispatch,
	pendingIdRef,
	lastAssistantIdRef,
	historyReadyRef,
	setRateLimit,
}: {
	dispatch: React.Dispatch<Action>;
	pendingIdRef: React.MutableRefObject<string | null>;
	lastAssistantIdRef: React.MutableRefObject<string | null>;
	historyReadyRef: React.MutableRefObject<boolean>;
	setRateLimit: (r: RateLimitMessage | null) => void;
}): (msg: ServerMessage) => void {
	// biome-ignore lint/correctness/useExhaustiveDependencies: dispatch from useReducer is stable; all other deps are refs or stable setters
	return useCallback((msg: ServerMessage) => {
		// Gate all messages until history has loaded. Events that arrive before
		// history is ready are buffered and replayed via drainMessageBuffer() after
		// LOAD_HISTORY, so returning early here doesn't lose them.
		if (!historyReadyRef.current) return;

		if (msg.type === "rate_limit") {
			setRateLimit(msg);
			return;
		}

		if (msg.type === "user_message") {
			// Session filtering is handled centrally in wsStore using the pool
			// session id. This hook's sessionIdRef is the DB chat id, so filtering
			// here would compare different id domains and drop/misroute messages.
			dispatch({ type: "ADD_USER", id: msg.id ?? uid(), text: msg.text });
			return;
		}

		const id = pendingIdRef.current;

		if (msg.type === "status" && msg.state === "running" && !id) {
			const newId = uid();
			pendingIdRef.current = newId;
			// Slice C: pass turn_id as afterUserId so the assistant placeholder
			// inserts immediately after its matching user msg, preserving
			// user/assistant/user/assistant ordering when queued msgs run
			// out of insertion order (e.g. after promote).
			dispatch({
				type: "ADD_ASSISTANT",
				id: newId,
				...(msg.turn_id !== undefined ? { afterUserId: msg.turn_id } : {}),
			});
			return;
		}

		if (msg.type === "permission_request") {
			dispatch({ type: "ADD_PERMISSION", msg });
			return;
		}

		if (msg.type === "permission_resolved") {
			dispatch({
				type: "RESOLVE_OR_ADD_PERMISSION",
				id: msg.id,
				toolName: msg.toolName,
				displayName: msg.displayName,
				decision: msg.decision,
			});
			return;
		}

		if (msg.type === "ask_user_question") {
			dispatch({
				type: "ADD_ASK_USER_QUESTION",
				id: msg.id,
				questions: msg.questions,
			});
			return;
		}

		if (msg.type === "ask_user_question_resolved") {
			dispatch({
				type: "RESOLVE_ASK_USER_QUESTION",
				id: msg.id,
				answers: msg.answers,
				notes: msg.notes,
			});
			return;
		}

		if (msg.type === "plan_mode_exit") {
			const planRaw = (msg.input as { plan?: unknown }).plan;
			const plan =
				planRaw == null
					? ""
					: typeof planRaw === "string"
						? planRaw
						: JSON.stringify(planRaw);
			dispatch({ type: "ADD_PLAN_PROPOSAL", id: msg.id, plan });
			return;
		}

		if (msg.type === "plan_mode_exit_resolved") {
			dispatch({
				type: "RESOLVE_PLAN_PROPOSAL",
				id: msg.id,
				decision: msg.decision,
			});
			return;
		}

		if (msg.type === "local_command_output") {
			dispatch({
				type: "ADD_LOCAL_COMMAND_OUTPUT",
				id: uid(),
				content: msg.content,
			});
			return;
		}

		if (msg.type === "tool_result") {
			dispatch({
				type: "ADD_TOOL_RESULT",
				toolUseId: msg.id,
				content: msg.content,
				...(msg.isError !== undefined ? { isError: msg.isError } : {}),
			});
			return;
		}

		if (
			!id &&
			(msg.type === "chunk" ||
				msg.type === "tool_event" ||
				msg.type === "error")
		) {
			const newId = uid();
			pendingIdRef.current = newId;
			dispatch({ type: "ADD_ASSISTANT", id: newId });
		}

		if (msg.type === "tool_use_summary") {
			const targetId = pendingIdRef.current ?? lastAssistantIdRef.current;
			if (targetId)
				dispatch({ type: "SET_RECAP", id: targetId, recap: msg.summary });
			return;
		}

		const activeId = pendingIdRef.current;
		if (!activeId) return;

		if (msg.type === "chunk") {
			dispatch({ type: "APPEND_CHUNK", id: activeId, text: msg.text });
		} else if (msg.type === "tool_event") {
			dispatch({ type: "ADD_TOOL_EVENT", id: activeId, event: msg });
		} else if (msg.type === "done") {
			dispatch({ type: "DONE", id: activeId, cost: msg.cost });
			lastAssistantIdRef.current = activeId;
			pendingIdRef.current = null;
		} else if (msg.type === "error") {
			const errorId =
				activeId ??
				(() => {
					const newId = uid();
					dispatch({ type: "ADD_ASSISTANT", id: newId });
					return newId;
				})();
			dispatch({
				type: "APPEND_CHUNK",
				id: errorId,
				text: `\n\n[ERROR: ${msg.message}]`,
			});
			dispatch({ type: "DONE", id: errorId, cost: null });
			pendingIdRef.current = null;
		}
	}, []);
}
