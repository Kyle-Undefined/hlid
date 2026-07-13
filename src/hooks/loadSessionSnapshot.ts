import type { Action } from "#/components/chat/chatReducer";
import * as wsStore from "#/hooks/wsStore";
import {
	getSessionAskUserQuestionsFn,
	getSessionContextFn,
	getSessionDataFn,
	getSessionPermissionsFn,
	getSessionPlanProposalsFn,
} from "#/lib/serverFns/sessions";
import { uid } from "#/lib/utils";
import type { SubagentSnapshot } from "#/server/agentProvider";
import type {
	AskQuestion,
	AskUserQuestionAnswers,
	AskUserQuestionNotes,
	ServerMessage,
} from "#/server/protocol";

// ─── shared row-mapping helpers ───────────────────────────────────────────────

type SessionDataRow = Awaited<ReturnType<typeof getSessionDataFn>>[number];
type PermRow = Awaited<ReturnType<typeof getSessionPermissionsFn>>[number];
type PlanRow = Awaited<ReturnType<typeof getSessionPlanProposalsFn>>[number];
type AukRow = Awaited<ReturnType<typeof getSessionAskUserQuestionsFn>>[number];
type CtxRow = Awaited<ReturnType<typeof getSessionContextFn>>;

function safeParseJson<T>(raw: string, fallback: T): T {
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

function mapSessionRows(
	rows: SessionDataRow[],
	permEvents: PermRow[],
	planRows: PlanRow[],
	aukRows: AukRow[],
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
			...(te.subagent_json
				? {
						subagent: safeParseJson<SubagentSnapshot | undefined>(
							te.subagent_json,
							undefined,
						),
					}
				: {}),
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
		html_attachment_id: p.html_attachment_id,
	}));
	const askItems = aukRows.map((a) => ({
		kind: "ask_user_question" as const,
		timestamp: a.timestamp,
		id: a.request_id,
		questions: safeParseJson<AskQuestion[]>(a.questions_json, []),
		answers:
			a.answers_json != null
				? safeParseJson<AskUserQuestionAnswers | null>(a.answers_json, null)
				: null,
		notes:
			a.notes_json != null
				? safeParseJson<AskUserQuestionNotes | undefined>(
						a.notes_json,
						undefined,
					)
				: undefined,
	}));
	return [...messageItems, ...permissionItems, ...planItems, ...askItems].sort(
		(a, b) => a.timestamp - b.timestamp,
	);
}

type SessionItems = ReturnType<typeof mapSessionRows>;

/**
 * Find the in-flight assistant placeholder (last assistant row with empty
 * text). The server pre-inserts this on the first tool_start so a mid-turn
 * reload can show the tool calls. If found, returns the id used in the mapped
 * items (so callers can reuse it as pendingIdRef instead of dispatching a
 * fresh ADD_ASSISTANT).
 */
function findPlaceholderAssistant(
	items: SessionItems,
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
	handle: (msg: ServerMessage) => void,
	knownToolIds: Set<string>,
): void {
	for (const msg of wsStore.drainMessageBuffer()) {
		if (msg.type === "chunk") continue;
		if (
			(msg.type === "tool_event" ||
				msg.type === "tool_update" ||
				msg.type === "tool_result") &&
			knownToolIds.has(msg.id)
		) {
			continue;
		}
		handle(msg);
	}
}

function applyCtx(ctx: CtxRow, sessionId: string): void {
	if (ctx?.context_window && ctx.last_context_used != null) {
		wsStore.seedContextStats(
			ctx.context_window,
			ctx.last_context_used,
			sessionId,
		);
	}
	if (ctx?.actual_model !== undefined) {
		wsStore.seedActualModel(ctx.actual_model);
	}
}

/**
 * Fetches a session's full history (messages, permissions, plans, ask-user
 * questions, context), applies it to the reducer via LOAD_HISTORY, and seeds
 * a pending assistant bubble (reusing an in-flight placeholder if one was
 * persisted) when the session is still running — draining any buffered
 * events onto it. Shared by the initial load and reconnect-recovery effects
 * in useLoadChatHistory, which differ only in what happens around this call.
 */
export async function loadSessionSnapshot({
	sessionId,
	dispatch,
	pendingIdRef,
	handleWsMessage,
	isCancelled,
}: {
	sessionId: string;
	dispatch: React.Dispatch<Action>;
	pendingIdRef: React.MutableRefObject<string | null>;
	handleWsMessage: (msg: ServerMessage) => void;
	/** Checked right after the fetch resolves; skips all dispatches if true (effect was cleaned up or superseded). */
	isCancelled: () => boolean;
}): Promise<{ rows: SessionDataRow[] } | null> {
	const [rows, ctx, permEvents, planRows, aukRows] = await Promise.all([
		getSessionDataFn({ data: sessionId }),
		getSessionContextFn({ data: sessionId }),
		getSessionPermissionsFn({ data: sessionId }),
		getSessionPlanProposalsFn({ data: sessionId }),
		getSessionAskUserQuestionsFn({ data: sessionId }),
	]);
	if (isCancelled()) return null;
	applyCtx(ctx, sessionId);
	const items = mapSessionRows(rows, permEvents, planRows, aukRows);
	dispatch({ type: "LOAD_HISTORY", items });
	const placeholder = findPlaceholderAssistant(items);

	// Reset any stale pending ID — LOAD_HISTORY wiped the bubble it referenced,
	// so we must start fresh before draining. Without this, chunks buffered
	// during the DB fetch get APPEND_CHUNK'd to a non-existent message ID and
	// silently vanish (the reducer map-over just skips the missing ID).
	pendingIdRef.current = null;

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
			// replay or live events during the async DB fetch).
			for (const msg of wsStore.drainMessageBuffer()) {
				handleWsMessage(msg);
			}
		}
	} else {
		// Session done before history loaded — DB has complete data, discard buffer.
		wsStore.clearMessageBuffer();
	}

	return { rows };
}
