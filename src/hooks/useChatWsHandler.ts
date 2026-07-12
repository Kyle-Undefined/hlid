import { useCallback } from "react";
import type { Action } from "#/components/chat/chatReducer";
import { uid } from "#/lib/utils";
import type { RateLimitMessage, ServerMessage } from "#/server/protocol";

type ChatWsHandlerContext = {
	dispatch: React.Dispatch<Action>;
	pendingIdRef: React.MutableRefObject<string | null>;
	lastAssistantIdRef: React.MutableRefObject<string | null>;
	setRateLimit: (rateLimit: RateLimitMessage | null) => void;
};

function planText(input: unknown): string {
	const plan = (input as { plan?: unknown }).plan;
	if (plan == null) return "";
	return typeof plan === "string" ? plan : JSON.stringify(plan);
}

function dispatchImmediateMessage(
	msg: ServerMessage,
	context: ChatWsHandlerContext,
): boolean {
	const { dispatch, setRateLimit } = context;
	switch (msg.type) {
		case "rate_limit":
			setRateLimit(msg);
			return true;
		case "user_message":
			dispatch({
				type: "ADD_USER",
				id: msg.id ?? uid(),
				text: msg.text,
				...(msg.attachments ? { attachments: msg.attachments } : {}),
			});
			return true;
		case "permission_request":
			dispatch({ type: "ADD_PERMISSION", msg });
			return true;
		case "permission_resolved":
			dispatch({
				type: "RESOLVE_OR_ADD_PERMISSION",
				id: msg.id,
				toolName: msg.toolName,
				displayName: msg.displayName,
				decision: msg.decision,
			});
			return true;
		case "ask_user_question":
			dispatch({
				type: "ADD_ASK_USER_QUESTION",
				id: msg.id,
				questions: msg.questions,
			});
			return true;
		case "ask_user_question_resolved":
			dispatch({
				type: "RESOLVE_ASK_USER_QUESTION",
				id: msg.id,
				answers: msg.answers,
				notes: msg.notes,
			});
			return true;
		case "plan_mode_exit":
			dispatch({
				type: "ADD_PLAN_PROPOSAL",
				id: msg.id,
				plan: planText(msg.input),
				...(msg.html_relic_id ? { htmlRelicId: msg.html_relic_id } : {}),
			});
			return true;
		case "plan_mode_exit_resolved":
			dispatch({
				type: "RESOLVE_PLAN_PROPOSAL",
				id: msg.id,
				decision: msg.decision,
			});
			return true;
		case "local_command_output":
			dispatch({
				type: "ADD_LOCAL_COMMAND_OUTPUT",
				id: uid(),
				content: msg.content,
			});
			return true;
		case "tool_result":
			dispatch({
				type: "ADD_TOOL_RESULT",
				toolUseId: msg.id,
				content: msg.content,
				...(msg.isError !== undefined ? { isError: msg.isError } : {}),
			});
			return true;
		case "tool_update":
			dispatch({
				type: "UPDATE_TOOL_EVENT",
				toolUseId: msg.id,
				subagent: msg.subagent,
			});
			return true;
		default:
			return false;
	}
}

function ensurePendingAssistant(
	msg: ServerMessage,
	context: ChatWsHandlerContext,
): void {
	if (context.pendingIdRef.current) return;
	if (msg.type !== "chunk" && msg.type !== "tool_event" && msg.type !== "error")
		return;
	const id = uid();
	context.pendingIdRef.current = id;
	context.dispatch({ type: "ADD_ASSISTANT", id });
}

function dispatchActiveMessage(
	msg: ServerMessage,
	activeId: string,
	context: ChatWsHandlerContext,
): void {
	const { dispatch, pendingIdRef, lastAssistantIdRef } = context;
	switch (msg.type) {
		case "chunk":
			dispatch({ type: "APPEND_CHUNK", id: activeId, text: msg.text });
			break;
		case "tool_event":
			dispatch({ type: "ADD_TOOL_EVENT", id: activeId, event: msg });
			break;
		case "done":
			dispatch({
				type: "DONE",
				id: activeId,
				cost: msg.estimated_cost ?? msg.cost,
				...(msg.estimated_cost != null ? { costEstimated: true } : {}),
			});
			lastAssistantIdRef.current = activeId;
			pendingIdRef.current = null;
			break;
		case "error":
			dispatch({
				type: "APPEND_CHUNK",
				id: activeId,
				text: `\n\n[ERROR: ${msg.message}]`,
			});
			dispatch({ type: "DONE", id: activeId, cost: null });
			pendingIdRef.current = null;
			break;
	}
}

function handleChatWsMessage(
	msg: ServerMessage,
	context: ChatWsHandlerContext,
): void {
	const { dispatch, pendingIdRef, lastAssistantIdRef } = context;
	if (
		msg.type === "status" &&
		msg.state === "running" &&
		!pendingIdRef.current
	) {
		const id = uid();
		pendingIdRef.current = id;
		dispatch({
			type: "ADD_ASSISTANT",
			id,
			...(msg.turn_id !== undefined ? { afterUserId: msg.turn_id } : {}),
		});
		return;
	}
	if (dispatchImmediateMessage(msg, context)) return;
	ensurePendingAssistant(msg, context);
	if (msg.type === "tool_use_summary") {
		const targetId = pendingIdRef.current ?? lastAssistantIdRef.current;
		if (targetId)
			dispatch({ type: "SET_RECAP", id: targetId, recap: msg.summary });
		return;
	}
	const activeId = pendingIdRef.current;
	if (activeId) dispatchActiveMessage(msg, activeId, context);
}

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

		handleChatWsMessage(msg, {
			dispatch,
			pendingIdRef,
			lastAssistantIdRef,
			setRateLimit,
		});
	}, []);
}
