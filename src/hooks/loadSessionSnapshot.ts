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
import type { SubagentSnapshot, TaskActivity } from "#/server/agentProvider";
import type {
	AskQuestion,
	AskUserQuestionAnswers,
	AskUserQuestionNotes,
	AskUserQuestionProvenance,
	ServerMessage,
	ToolEventMessage,
} from "#/server/protocol";

// ─── shared row-mapping helpers ───────────────────────────────────────────────

type SessionDataRow = Awaited<ReturnType<typeof getSessionDataFn>>[number];
type PermRow = Awaited<ReturnType<typeof getSessionPermissionsFn>>[number];
type PlanRow = Awaited<ReturnType<typeof getSessionPlanProposalsFn>>[number];
type AukRow = Awaited<ReturnType<typeof getSessionAskUserQuestionsFn>>[number];
type CtxRow = Awaited<ReturnType<typeof getSessionContextFn>>;
type SessionToolEventSummaryRow = NonNullable<
	SessionDataRow["toolEvents"]
>[number];

export const SESSION_HISTORY_PAGE_SIZE = 100;

function safeParseJson<T>(raw: string, fallback: T): T {
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

/** Shared mapper for initial transcript pages and later per-response pages. */
export function mapSessionToolEventSummary(
	te: SessionToolEventSummaryRow,
	sessionId: string,
): ToolEventMessage {
	return {
		type: "tool_event",
		id: te.tool_id,
		name: te.name,
		input: safeParseJson<unknown>(te.input_json, {}),
		...(te.result_text != null ? { result: te.result_text } : {}),
		...(te.result_truncated === 1
			? {
					resultTruncated: true,
					...(te.result_length != null
						? { resultLength: te.result_length }
						: {}),
					detailSessionId: sessionId,
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
		...(te.activity_json
			? {
					taskActivity: safeParseJson<TaskActivity | undefined>(
						te.activity_json,
						undefined,
					),
				}
			: {}),
	};
}

function mapSessionRows(
	rows: SessionDataRow[],
	permEvents: PermRow[],
	planRows: PlanRow[],
	aukRows: AukRow[],
) {
	const messageItems = rows.map((r) => {
		const realtimeUtteranceId =
			r.source === "codex_realtime" && r.utterance_id
				? r.utterance_id
				: undefined;
		const realtimeSource = realtimeUtteranceId
			? ("codex_realtime" as const)
			: undefined;
		return {
			kind: "message" as const,
			timestamp: r.timestamp,
			// Realtime rows retain the same utterance identity from provisional delta
			// through history hydration. Ordinary user rows keep their queued turn id;
			// every other row uses the globally unique database id.
			id: realtimeUtteranceId
				? realtimeUtteranceId
				: r.role === "user" && r.turn_id
					? r.turn_id
					: `persisted-message:${r.id}`,
			// Real messages.id primary key, exposed separately from the synthetic
			// `id` above so callers don't have to parse it back out of a string.
			// Used by the "branch from here" fork action (assistant rows only).
			dbId: r.id,
			role: r.role,
			text: r.text,
			seq: r.seq,
			...(realtimeSource
				? {
						source: realtimeSource,
						utteranceId: realtimeUtteranceId,
						...(r.realtime_session_id
							? { realtimeSessionId: r.realtime_session_id }
							: {}),
						forkSupported: r.fork_supported === 1,
					}
				: {}),
			hasContextReceipt: Boolean(r.context_manifest_json),
			hasFileCheckpoint: Boolean(r.checkpoint_uuid),
			steerTargetSeq: r.steer_target_seq,
			steerToolEventIndex: r.steer_tool_event_index,
			cost:
				r.query_estimated_cost ??
				(r.query_cost_known === 1 ? (r.query_cost ?? 0) : null),
			costEstimated: r.query_estimated_cost != null,
			toolEvents: r.toolEvents?.map((te) =>
				mapSessionToolEventSummary(te, r.session_id),
			),
			...(r.toolEventPage ? { toolEventPage: r.toolEventPage } : {}),
			attachments: r.attachments?.map((a) => ({
				id: a.id,
				path: a.path,
				filename: a.filename,
				mime: a.mime,
				kind: a.kind,
			})),
			recap: r.recap,
		};
	});
	const permissionItems = permEvents.map((p) => ({
		kind: "permission" as const,
		timestamp: p.timestamp,
		tool_id: p.tool_id,
		tool_name: p.tool_name,
		display_name: p.display_name,
		decision: p.decision,
		provider_outcome: p.provider_outcome,
		provider_id: p.provider_id,
		provider_reason_type: p.provider_reason_type,
		provider_reason: p.provider_reason,
		provider_message: p.provider_message,
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
		provenance:
			a.provenance_json != null
				? safeParseJson<AskUserQuestionProvenance | undefined>(
						a.provenance_json,
						undefined,
					)
				: undefined,
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
	// The newest/reconnect window must include interaction cards emitted after
	// the last persisted message. Ask-user questions and plan proposals consume
	// their own sequence values, so bounding metadata to rows.at(-1).seq hides
	// the exact pending card that left the run waiting. Older cursor pages remain
	// bounded in hydrateSessionHistoryPage so they cannot duplicate newer cards.
	const scopedPage = { sessionId, minSeq };
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
	runningTurnId: string | null,
): { id: string; text: string } | null {
	let steeredAssistantSeq: number | null = null;
	let candidate: { id: string; text: string } | null = null;
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item.kind !== "message") continue;
		if (item.role === "user") {
			// A steering prompt is persisted after the assistant row it joined.
			// Skip it so a mid-turn remount reuses that row instead of opening a
			// duplicate assistant bubble below the steer.
			if (item.steerTargetSeq != null) {
				if (
					steeredAssistantSeq !== null &&
					steeredAssistantSeq !== item.steerTargetSeq
				) {
					return null;
				}
				steeredAssistantSeq = item.steerTargetSeq;
				continue;
			}
			if (candidate === null) return null;
			if (runningTurnId === null || item.id === runningTurnId) return candidate;
			// A steer accepted before the first assistant/tool event has no
			// assistant sequence to persist yet. The running turn ID remains the
			// authoritative opening prompt, so keep scanning through such rows.
			continue;
		}
		if (item.role === "assistant") {
			if (candidate !== null) return null;
			if (steeredAssistantSeq !== null && item.seq !== steeredAssistantSeq) {
				return null;
			}
			candidate = { id: item.id, text: item.text };
			if (runningTurnId === null) return candidate;
			continue;
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
function replayBufferDeduped(
	messages: ServerMessage[],
	handle: (msg: ServerMessage) => void,
	hasPersistedText: boolean,
): void {
	for (const msg of messages) {
		// Offset-aware chunks are safe to replay: APPEND_CHUNK trims the portion
		// already present in the DB snapshot. Legacy offset-less chunks cannot be
		// reconciled once text was persisted, so retain the previous drop behavior.
		if (msg.type === "chunk" && msg.offset === undefined && hasPersistedText) {
			continue;
		}
		handle(msg);
	}
}

function isLiveRealtimeFrame(message: ServerMessage): boolean {
	if (
		(message.type === "realtime_transcript" ||
			message.type === "realtime_state" ||
			message.type === "realtime_error") &&
		message.mode === "live"
	) {
		return true;
	}
	return (
		(message.type === "tool_event" ||
			message.type === "tool_result" ||
			message.type === "tool_update" ||
			message.type === "tool_activity_update") &&
		Boolean(message.realtime_utterance_id)
	);
}

function isPersistedWriteMarker(message: ServerMessage): boolean {
	return (
		message.type === "done" ||
		message.type === "error" ||
		message.type === "turn_steered" ||
		message.type === "assistant_revision" ||
		(message.type === "realtime_transcript" &&
			message.mode === "live" &&
			message.done &&
			message.db_id !== undefined)
	);
}

/**
 * When one turn completes while the history refresh is in flight, the queue
 * can already have started the next turn by the time the final page arrives.
 * The refreshed DB is authoritative through the completed turn, so do not
 * replay its assistant-bound chunks/tool starts/done onto the new in-flight
 * assistant. Preserve queued user broadcasts and ID-addressed updates from
 * that prefix because they are independently idempotent and may not have
 * finished persistence yet.
 */
function currentTurnBuffer(
	messages: ServerMessage[],
	runningTurnId: string | null,
): ServerMessage[] {
	let completedThrough = -1;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (
			runningTurnId !== null &&
			((message.type === "done" && message.turn_id !== runningTurnId) ||
				(message.type === "error" &&
					message.turn_id !== undefined &&
					message.turn_id !== runningTurnId))
		) {
			completedThrough = index;
		}
	}
	if (completedThrough === -1) return messages;
	return [
		...messages
			.slice(0, completedThrough + 1)
			.filter(
				(message) =>
					message.type !== "chunk" &&
					message.type !== "tool_event" &&
					message.type !== "done" &&
					message.type !== "error",
			),
		...messages.slice(completedThrough + 1),
	];
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
	preserveToolEventPages = false,
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
	/** Reconnects retain immutable per-response pages already revealed by the user. */
	preserveToolEventPages?: boolean;
	/** Checked right after the fetch resolves; skips all dispatches if true (effect was cleaned up or superseded). */
	isCancelled: () => boolean;
}): Promise<SessionHistoryPage | null> {
	// Context and persisted interaction cards are useful enrichment, but neither
	// should hold the base transcript blank. Start context in parallel and hydrate
	// cards after LOAD_HISTORY, preserving any newer live socket state in reducer.
	const ctxRead = getSessionContextFn({ data: sessionId });
	const readBasePage = () =>
		preserveFromSeq === undefined
			? loadNewestSessionRows({ sessionId, pageSize })
			: loadSessionWindowRows({
					sessionId,
					minSeq: preserveFromSeq,
					minId: preserveFromId ?? 0,
					hasOlder: preserveHasOlder,
				});
	let page = await readBasePage();
	if (isCancelled()) return null;
	let newlyBuffered = wsStore.drainMessageBuffer();
	let bufferedMessages = [...newlyBuffered];
	// Done and steer acknowledgements follow their transcript writes; an error
	// is followed by final persistence before the queue advances. Durable Live
	// finals likewise carry their messages.id only after the transcript write.
	// If one arrives while the DB read is in flight, that page may predate the
	// authoritative row. Refresh before opening the reducer gate.
	for (let retry = 0; retry < 2; retry++) {
		if (!newlyBuffered.some(isPersistedWriteMarker)) break;
		page = await readBasePage();
		if (isCancelled()) return null;
		newlyBuffered = wsStore.drainMessageBuffer();
		bufferedMessages = [...bufferedMessages, ...newlyBuffered];
	}
	// If both bounded refreshes raced another persisted completion, the last
	// marker still predates one final authoritative read.
	if (newlyBuffered.some(isPersistedWriteMarker)) {
		page = await readBasePage();
		if (isCancelled()) return null;
		bufferedMessages = [...bufferedMessages, ...wsStore.drainMessageBuffer()];
	}
	const { items } = page;
	dispatch({
		type: "LOAD_HISTORY",
		items,
		...(preserveToolEventPages ? { preserveToolEventPages: true } : {}),
	});
	// Dispatches are processed in order, so opening the gate here lets buffered
	// events enqueue immediately after LOAD_HISTORY without being discarded by
	// useChatWsHandler during an initial remount.
	historyReadyRef.current = true;
	const snapshot = wsStore.getSnapshot();
	const inFlightAssistant = findInFlightAssistant(
		items,
		snapshot.runningTurnId,
	);

	// Reset any stale pending ID — LOAD_HISTORY wiped the bubble it referenced,
	// so we must start fresh before draining. Without this, chunks buffered
	// during the DB fetch get APPEND_CHUNK'd to a non-existent message ID and
	// silently vanish (the reducer map-over just skips the missing ID).
	pendingIdRef.current = null;

	if (snapshot.sessionState === "running") {
		const replayableMessages = currentTurnBuffer(
			bufferedMessages,
			snapshot.runningTurnId,
		);
		if (inFlightAssistant) {
			// Reuse the in-flight assistant row loaded from DB instead of opening
			// a fresh bubble. History rows are non-streaming by default, so restore
			// the live marker before replaying chunks and tool events onto this row.
			// Offset-aware chunk replay and tool-id deduplication make repeated
			// subscribe/remount recovery idempotent.
			pendingIdRef.current = inFlightAssistant.id;
			dispatch({ type: "RESUME_ASSISTANT", id: inFlightAssistant.id });
			if (snapshot.runningTurnId !== null) {
				dispatch({
					type: "SET_ASSISTANT_TURN",
					id: inFlightAssistant.id,
					turnId: snapshot.runningTurnId,
				});
			}
			replayBufferDeduped(
				replayableMessages,
				handleWsMessage,
				inFlightAssistant.text.length > 0,
			);
		} else {
			const newId = uid();
			pendingIdRef.current = newId;
			dispatch({
				type: "ADD_ASSISTANT",
				id: newId,
				...(snapshot.runningTurnId !== null
					? { afterUserId: snapshot.runningTurnId }
					: {}),
			});
			// Replay events that arrived before history was ready (from open() buffer
			// replay or live events during the async DB fetch).
			for (const msg of replayableMessages) {
				handleWsMessage(msg);
			}
		}
	} else {
		// An idle ordinary turn has no live assistant to receive stale chunks or
		// interaction events. Raven Live is independent of that run state, though,
		// so replay only its frames after LOAD_HISTORY. Drain once more to include a
		// terminal/final frame that arrived after the last pre-load buffer read.
		const liveRealtimeFrames = [
			...bufferedMessages,
			...wsStore.drainMessageBuffer(),
		].filter(
			(message) =>
				message.type === "assistant_revision" || isLiveRealtimeFrame(message),
		);
		wsStore.clearMessageBuffer();
		for (const message of liveRealtimeFrames) handleWsMessage(message);
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
