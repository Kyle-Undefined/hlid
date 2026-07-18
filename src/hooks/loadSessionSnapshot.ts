import type { Action } from "#/components/chat/chatReducer";
import { seedContextStats } from "#/hooks/wsLiveStatsStore";
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

export const SESSION_HISTORY_PAGE_SIZE = 200;

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
		// DB row ids are globally unique and stable across reconnect/page fetches.
		// A user row with turn_id retains its live queue identity so history and
		// the running-turn event cannot render the same prompt twice.
		id:
			r.role === "user" && r.turn_id ? r.turn_id : `persisted-message:${r.id}`,
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
			...(te.result_truncated === 1
				? {
						resultTruncated: true,
						...(te.result_length != null
							? { resultLength: te.result_length }
							: {}),
						detailSessionId: r.session_id,
					}
				: {}),
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

export type SessionHistoryPage = {
	rows: SessionDataRow[];
	items: SessionItems;
	hasOlder: boolean;
	nextBeforeSeq: number | null;
	nextBeforeId: number | null;
};

async function hydrateSessionHistoryPage({
	rows,
	hasOlder,
	sessionId,
	beforeSeq,
}: {
	rows: SessionDataRow[];
	hasOlder: boolean;
	sessionId: string;
	beforeSeq?: number;
}): Promise<SessionHistoryPage> {
	const minSeq = rows[0]?.seq;
	if (minSeq === undefined) {
		return {
			rows,
			items: [],
			hasOlder: false,
			nextBeforeSeq: null,
			nextBeforeId: null,
		};
	}
	const maxSeq = rows.at(-1)?.seq ?? minSeq;
	const scopedPage = {
		sessionId,
		minSeq,
		maxSeq,
		// Older pages exclude unscoped permission events so they are not repeated.
		...(beforeSeq !== undefined ? { beforeSeq } : {}),
	};
	const [permEvents, planRows, aukRows] = await Promise.all([
		getSessionPermissionsFn({ data: scopedPage }),
		getSessionPlanProposalsFn({ data: scopedPage }),
		getSessionAskUserQuestionsFn({ data: scopedPage }),
	]);
	return {
		rows,
		items: mapSessionRows(rows, permEvents, planRows, aukRows),
		hasOlder,
		nextBeforeSeq: rows[0]?.seq ?? null,
		nextBeforeId: rows[0]?.id ?? null,
	};
}

function sessionHistoryPageFromRows({
	rows,
	hasOlder,
}: {
	rows: SessionDataRow[];
	hasOlder: boolean;
}): SessionHistoryPage {
	return {
		rows,
		items: mapSessionRows(rows, [], [], []),
		hasOlder,
		nextBeforeSeq: rows[0]?.seq ?? null,
		nextBeforeId: rows[0]?.id ?? null,
	};
}

async function loadNewestSessionRows({
	sessionId,
	pageSize,
}: {
	sessionId: string;
	pageSize: number;
}): Promise<SessionHistoryPage> {
	const boundedPageSize = Math.max(1, Math.min(5_000, Math.trunc(pageSize)));
	const pageRows = await getSessionDataFn({
		data: { sessionId, limit: boundedPageSize + 1 },
	});
	const hasOlder = pageRows.length > boundedPageSize;
	return sessionHistoryPageFromRows({
		rows: hasOlder ? pageRows.slice(1) : pageRows,
		hasOlder,
	});
}

async function loadSessionWindowRows({
	sessionId,
	minSeq,
	minId,
	hasOlder,
}: {
	sessionId: string;
	minSeq: number;
	minId: number;
	hasOlder: boolean;
}): Promise<SessionHistoryPage> {
	const rows = await getSessionDataFn({ data: { sessionId, minSeq, minId } });
	return sessionHistoryPageFromRows({ rows, hasOlder });
}

async function loadSessionMetadata(
	sessionId: string,
	rows: SessionDataRow[],
): Promise<SessionItems> {
	const minSeq = rows[0]?.seq;
	if (minSeq === undefined) return [];
	const maxSeq = rows.at(-1)?.seq ?? minSeq;
	const scopedPage = { sessionId, minSeq, maxSeq };
	const [permEvents, planRows, aukRows] = await Promise.all([
		getSessionPermissionsFn({ data: scopedPage }),
		getSessionPlanProposalsFn({ data: scopedPage }),
		getSessionAskUserQuestionsFn({ data: scopedPage }),
	]);
	return mapSessionRows(rows, permEvents, planRows, aukRows);
}

/**
 * Reads one backwards cursor page and maps every persisted transcript card
 * belonging to that message-sequence window. The extra message is lookahead:
 * it tells the client whether another page exists without a COUNT query.
 */
export async function loadSessionHistoryPage({
	sessionId,
	beforeSeq,
	beforeId,
	pageSize = SESSION_HISTORY_PAGE_SIZE,
}: {
	sessionId: string;
	beforeSeq?: number;
	beforeId?: number;
	pageSize?: number;
}): Promise<SessionHistoryPage> {
	const boundedPageSize = Math.max(1, Math.min(5_000, Math.trunc(pageSize)));
	const pageRows = await getSessionDataFn({
		data: {
			sessionId,
			...(beforeSeq !== undefined
				? { beforeSeq, ...(beforeId !== undefined ? { beforeId } : {}) }
				: {}),
			limit: boundedPageSize + 1,
		},
	});
	const hasOlder = pageRows.length > boundedPageSize;
	const rows = hasOlder ? pageRows.slice(1) : pageRows;
	return hydrateSessionHistoryPage({
		rows,
		hasOlder,
		sessionId,
		// Marks an older page so standalone permission events are not repeated.
		...(beforeSeq !== undefined ? { beforeSeq } : {}),
	});
}

/**
 * Find the in-flight assistant row. The server pre-inserts it on the first
 * text/tool event and continuously persists partial text, so it may already
 * be non-empty when a remount snapshot is read. If the last message is an
 * assistant while the session is running, reuse its mapped id for live deltas.
 */
function findInFlightAssistant(
	items: SessionItems,
): { id: string; text: string } | null {
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item.kind !== "message") continue;
		if (item.role === "user") return null;
		if (item.role === "assistant") {
			return { id: item.id, text: item.text };
		}
		return null;
	}
	return null;
}

/**
 * Drain wsStore buffer into the chat handler when reusing an in-flight row.
 *
 * Offset-aware chunks and ID-bearing interaction/tool events are idempotent in
 * the reducer, so replay them after LOAD_HISTORY. Only offset-less legacy chunks
 * are unsafe once the DB snapshot already contains assistant text.
 */
function drainBufferDeduped(
	handle: (msg: ServerMessage) => void,
	hasPersistedText: boolean,
): void {
	for (const msg of wsStore.drainMessageBuffer()) {
		// Offset-aware chunks are safe to replay: APPEND_CHUNK trims the portion
		// already present in the DB snapshot. Legacy offset-less chunks cannot be
		// reconciled once text was persisted, so retain the previous drop behavior.
		if (msg.type === "chunk" && msg.offset === undefined && hasPersistedText) {
			continue;
		}
		handle(msg);
	}
}

function applyCtx(ctx: CtxRow, sessionId: string): void {
	if (ctx?.context_window && ctx.last_context_used != null) {
		seedContextStats(ctx.context_window, ctx.last_context_used, sessionId);
	}
	if (ctx?.actual_model !== undefined) {
		wsStore.seedActualModel(ctx.actual_model);
	}
}

/**
 * Fetches the newest page of a session's base transcript, applies it to the
 * reducer via LOAD_HISTORY, then hydrates context and interaction cards without
 * holding the transcript pending. Also seeds
 * a pending assistant bubble (reusing an in-flight assistant row if one was
 * persisted) when the session is still running — draining any buffered
 * events onto it. Shared by the initial load and reconnect-recovery effects
 * in useLoadChatHistory, which differ only in what happens around this call.
 */
export async function loadSessionSnapshot({
	sessionId,
	dispatch,
	pendingIdRef,
	historyReadyRef,
	handleWsMessage,
	isCancelled,
	pageSize = SESSION_HISTORY_PAGE_SIZE,
	preserveFromSeq,
	preserveFromId,
	preserveHasOlder = false,
}: {
	sessionId: string;
	dispatch: React.Dispatch<Action>;
	pendingIdRef: React.MutableRefObject<string | null>;
	historyReadyRef: React.MutableRefObject<boolean>;
	handleWsMessage: (msg: ServerMessage) => void;
	/** Initial page size; reconnects use preserveFromSeq for an exact window. */
	pageSize?: number;
	/** Inclusive oldest message cursor used to preserve the exact revealed window on reconnect. */
	preserveFromSeq?: number;
	/** Database-row tie-breaker paired with preserveFromSeq. */
	preserveFromId?: number;
	preserveHasOlder?: boolean;
	/** Checked right after the fetch resolves; skips all dispatches if true (effect was cleaned up or superseded). */
	isCancelled: () => boolean;
}): Promise<SessionHistoryPage | null> {
	// Context and persisted interaction cards are useful enrichment, but neither
	// should hold the base transcript blank. Start context in parallel and hydrate
	// cards after LOAD_HISTORY, preserving any newer live socket state in reducer.
	const ctxRead = getSessionContextFn({ data: sessionId });
	const page =
		preserveFromSeq === undefined
			? await loadNewestSessionRows({ sessionId, pageSize })
			: await loadSessionWindowRows({
					sessionId,
					minSeq: preserveFromSeq,
					minId: preserveFromId ?? 0,
					hasOlder: preserveHasOlder,
				});
	if (isCancelled()) return null;
	const { items } = page;
	dispatch({ type: "LOAD_HISTORY", items });
	// Dispatches are processed in order, so opening the gate here lets buffered
	// events enqueue immediately after LOAD_HISTORY without being discarded by
	// useChatWsHandler during an initial remount.
	historyReadyRef.current = true;
	const inFlightAssistant = findInFlightAssistant(items);

	// Reset any stale pending ID — LOAD_HISTORY wiped the bubble it referenced,
	// so we must start fresh before draining. Without this, chunks buffered
	// during the DB fetch get APPEND_CHUNK'd to a non-existent message ID and
	// silently vanish (the reducer map-over just skips the missing ID).
	pendingIdRef.current = null;

	if (wsStore.getSnapshot().sessionState === "running") {
		if (inFlightAssistant) {
			// Reuse the in-flight assistant row loaded from DB instead of opening
			// a fresh bubble. Offset-aware chunk replay and tool-id deduplication
			// make repeated subscribe/remount recovery idempotent.
			pendingIdRef.current = inFlightAssistant.id;
			drainBufferDeduped(handleWsMessage, inFlightAssistant.text.length > 0);
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

	void ctxRead.then(
		(ctx) => {
			if (!isCancelled()) applyCtx(ctx, sessionId);
		},
		(error) => console.error(error),
	);
	void loadSessionMetadata(sessionId, page.rows).then(
		(hydratedItems) => {
			if (!isCancelled() && hydratedItems.length > 0) {
				dispatch({ type: "HYDRATE_HISTORY", items: hydratedItems });
			}
		},
		(error) => console.error(error),
	);

	return page;
}
