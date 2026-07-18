import type { ClientMessage, ServerMessage } from "../server/protocol";
import type { SessionState } from "../server/session";
import { forgetRavenTerminal } from "./ravenTerminalStore";
import {
	clearChatQueue,
	enqueueLocalChat,
	findQueuedChat,
	getQueue,
	markQueuedChatPromoting,
	markQueuedChatSent,
	type QueuedChatMessage,
	reconcileLocalQueue,
	removeLocalChat,
	resetChatQueueForTesting,
} from "./wsChatQueueStore";
import {
	replaceDataRevisions,
	resetDataRevisionsForTesting,
} from "./wsDataRevisionStore";
import {
	applyContextUpdate,
	applyDone,
	applyUsageUpdate,
	resetLiveStatsForTesting,
	setPendingSessionToday,
	switchStatsContext,
} from "./wsLiveStatsStore";
import {
	canonicalSessionId,
	focusPendingNewSession,
	focusSession,
	getSessionsStatus,
	getSubscribedSessionId,
	reconcileSessionStatus,
	removeSessionStatus,
	replaceSessionsStatus,
	resetSessionStatusForTesting,
} from "./wsSessionStatusStore";

// WebSocket readyState constants — avoid referencing WebSocket global directly
// so tests running in Node.js (where WebSocket may be undefined) don't throw.
const WS_CONNECTING = 0;
const WS_OPEN = 1;
const RECONNECT_BASE_MS = 3_000;
const RECONNECT_MAX_MS = 30_000;

// ─── Types ───────────────────────────────────────────────────────────────────

export type WsStatus = "connecting" | "connected" | "disconnected";

/** Auto-sleep banner state from the latest agent_sleep message. */
export type SleepBanner = {
	providerId: string;
	/** Epoch seconds the sleep is expected to end, when known. */
	until: number | null;
	reason: "threshold" | "limit_reached" | null;
	/** five_hour utilization 0–1 behind a threshold sleep. */
	utilization: number | null;
};

type Snapshot = {
	wsStatus: WsStatus;
	sessionState: SessionState;
	model: string;
	// The model the CLI actually used on the most recent inference for the
	// current chat. May differ from `model` (configured vault model) when an
	// agent's CLAUDE.md frontmatter, slash command, or subagent overrode it.
	// Reset to null only when a new run starts (state === "running") so the
	// mismatch badge persists after the run completes.
	actualModel: string | null;
	/**
	 * Chunk 6: current permission mode for the subscribed session. Session-
	 * scoped (never persisted to hlid.config.toml) — reflects config defaults
	 * until a `set_permission_mode` message overrides it. Null until the
	 * first status message arrives.
	 */
	permissionMode: string | null;
	/**
	 * Current effort/thinking level for the subscribed session. Same
	 * session-scoped semantics as permissionMode — null until the first
	 * status message arrives.
	 */
	effort: string | null;
	hasPendingPermissions: boolean;
	/**
	 * Slice C: turn_id of the turn the server is currently processing
	 * (when sessionState === "running"). Used by MessageList to mark the
	 * matching chatQueue entry as "RUN" (no cancel/promote buttons) and
	 * leave the rest as cancellable / promotable.
	 */
	runningTurnId: string | null;
	/**
	 * Non-null while the session is auto-sleeping on a usage limit. Transient —
	 * derived from agent_sleep messages (replayed on sync), never buffered
	 * into the transcript.
	 */
	sleepState: SleepBanner | null;
};

// ─── Module state ────────────────────────────────────────────────────────────
// All mutable state lives here as module-level variables. These are private;
// consumers interact through the exported functions below.

/** SSR/server-rendered snapshot default. Exported so consumers
 *  (useWs, StatusDot, Sidebar) can pass it as the SSR fallback to
 *  useSyncExternalStore. */
export const INITIAL_SNAPSHOT: Snapshot = {
	wsStatus: "connecting",
	sessionState: "idle",
	model: "",
	actualModel: null,
	permissionMode: null,
	effort: null,
	hasPendingPermissions: false,
	runningTurnId: null,
	sleepState: null,
};

let _snap: Snapshot = { ...INITIAL_SNAPSHOT };
let _ws: WebSocket | null = null;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _reconnectAttempts = 0;
// Buffers in-flight chunks/tool_events for the current run so they survive SPA navigation.
// Always written (even when subscribers exist), cleared on run end or new run start.
let _messageBuffer: ServerMessage[] = [];
let _bufferingEnabled = true;
let _pendingPermCount = 0;

// Subscriber sets — connection and message concerns stay with the transport.
const statusSubs = new Set<() => void>();
const messageSubs = new Set<(msg: ServerMessage) => void>();

/**
 * Slice A: server-side queueing. Enqueued messages are sent to the server
 * IMMEDIATELY (not batched on idle). The server accepts mid-run and queues
 * FIFO at the SessionManager level. The client queue mirrors work that has not
 * started yet: items remain visible until the server reports them as running.
 *
 * Items added while the WS is closed remain in the queue and drain on the
 * next ws.onopen.
 */
function sendChatToServer(msg: QueuedChatMessage): boolean {
	if (_ws?.readyState !== WS_OPEN) return false;
	const userEvent: ServerMessage = {
		type: "user_message",
		text: msg.text,
		session_id: msg.session_id,
		id: msg.id,
		...(msg.attachments ? { attachments: msg.attachments } : {}),
	};
	for (const fn of messageSubs) fn(userEvent);
	setPendingSessionToday(true);
	_messageBuffer = [];
	const payload: Record<string, unknown> = {
		type: "chat",
		text: msg.text,
		session_id: msg.session_id,
		// Slice C: pass the client-generated id as turn_id so the server
		// echoes it back in `done` for FIFO correlation, and so the client
		// can reference it in cancel_queued.
		turn_id: msg.id,
	};
	if (msg.agent_cwd) payload.agent_cwd = msg.agent_cwd;
	if (msg.skill_context) payload.skill_context = msg.skill_context;
	if (msg.skill_contexts?.length) payload.skill_contexts = msg.skill_contexts;
	if (msg.attachments && msg.attachments.length > 0) {
		payload.attachments = msg.attachments;
	}
	if (msg.plan_mode) payload.plan_mode = true;
	if (msg.plan_html) payload.plan_html = true;
	if (msg.provider) payload.provider = msg.provider;
	if (msg.model) payload.model = msg.model;
	if (msg.effort) payload.effort = msg.effort;
	if (msg.permission_mode) payload.permission_mode = msg.permission_mode;
	try {
		_ws.send(JSON.stringify(payload));
		return true;
	} catch {
		return false;
	}
}

/**
 * Send any queued items that haven't yet been delivered to the server. Used
 * by ws.onopen to flush the backlog accumulated while the connection was
 * down. Items are tagged with `_sent` once delivered so we don't re-send them
 * on subsequent reconnects (the server won't have erased them).
 */
function drainPendingToServer(): void {
	if (_ws?.readyState !== WS_OPEN) return;
	for (const item of getQueue()) {
		if (item._sent) continue;
		if (sendChatToServer(item)) markQueuedChatSent(item.id);
		else break;
	}
}

/**
 * Re-promote a locally queued prompt when the server starts that turn.
 *
 * The first synthetic user_message is delivered when the prompt is enqueued,
 * but the chat reducer is component-local and is lost across SPA navigation.
 * The queue survives that navigation, so a server running status gives us a
 * reliable second chance to restore the prompt before its queue card changes
 * to the running state. ADD_USER is idempotent by turn id, making this harmless
 * for clients that never unmounted.
 */
function consumeRunningQueuedUser(turnId: string | undefined): void {
	if (!turnId) return;
	const queued = findQueuedChat(turnId);
	if (!queued) return;
	const userEvent: ServerMessage = {
		type: "user_message",
		text: queued.text,
		session_id: queued.session_id,
		id: queued.id,
		...(queued.attachments ? { attachments: queued.attachments } : {}),
	};
	for (const subscriber of messageSubs) subscriber(userEvent);
	// A running turn is no longer queued. Remove it only after re-emitting its
	// prompt so a Raven reducer that remounted during navigation can restore the
	// user row before the durable queue copy disappears. `done` retains the same
	// removal as an idempotent fallback for missed status frames.
	removeLocalChat(turnId);
}

/**
 * Slice C polish: reconcile chatQueue against the server's authoritative
 * queue state. Sent items not in the server's pending list (and not the
 * currently running one) are orphans — e.g. server restarted, lost the
 * QueuedTurn — and get pruned. Not-yet-sent items (still in the local
 * outbox awaiting ws connect) are preserved.
 */
// ─── WebSocket connection ─────────────────────────────────────────────────────

function getWsUrl(): string {
	const wsPort =
		typeof import.meta !== "undefined"
			? (import.meta as { env?: { VITE_WS_PORT?: string } }).env?.VITE_WS_PORT
			: undefined;

	if (wsPort) {
		const proto = window.location.protocol === "https:" ? "wss" : "ws";
		return `${proto}://${window.location.hostname}:${wsPort}/ws`;
	}

	// HTTPS (e.g. Tailscale serve): same-origin, proxy routes /ws
	if (window.location.protocol === "https:") {
		return `wss://${window.location.host}/ws`;
	}

	// HTTP: WS server runs on app port + 1
	const appPort = Number(window.location.port) || 80;
	return `ws://${window.location.hostname}:${appPort + 1}/ws`;
}

function setSnap(next: Partial<Snapshot>) {
	_snap = { ..._snap, ...next };
	for (const fn of statusSubs) fn();
}

// ─── Message handlers ────────────────────────────────────────────────────────

function onStatus(msg: Extract<ServerMessage, { type: "status" }>): void {
	// Do not clear actualModel on run start — let usage_update update it
	// naturally. This preserves the mismatch badge across submits so it only
	// changes when the actual model actually changes. handleClear calls
	// seedActualModel(null) explicitly for true new-session resets.
	//
	// Pending interactions own their lifecycle through their resolved events.
	// An idle status can race with plan artifact preparation or modal delivery;
	// clearing here would incorrectly flash the status green. Errors terminate
	// the interaction and can safely clear it.
	if (msg.state === "error") {
		_pendingPermCount = 0;
	}
	// Slice C: track the running turn_id so MessageList can render the
	// correct queue chip on chatQueue entries. When state is not running,
	// clear it.
	const runningTurnId = msg.state === "running" ? (msg.turn_id ?? null) : null;
	setSnap({
		sessionState: msg.state,
		model: msg.model,
		permissionMode: msg.permission_mode ?? _snap.permissionMode,
		effort: msg.effort ?? _snap.effort,
		hasPendingPermissions: _pendingPermCount > 0,
		runningTurnId,
		// Sleeping only happens while running; a non-running status means any
		// banner is stale (e.g. the resumed event raced a disconnect).
		...(msg.state !== "running" ? { sleepState: null } : {}),
	});
	// Slice A: server-side queue manages drain order. Client no longer batches
	// or sends on state=idle — items are dispatched immediately on enqueue and
	// consumed from the local queue when their turn starts running.
}

function onAgentSleep(
	msg: Extract<ServerMessage, { type: "agent_sleep" }>,
): void {
	setSnap({
		sleepState:
			msg.state === "sleeping"
				? {
						providerId: msg.providerId,
						until: msg.until ?? null,
						reason: msg.reason ?? null,
						utilization: msg.utilization ?? null,
					}
				: null,
	});
}

function onPermissionRequest(): void {
	_pendingPermCount++;
	setSnap({ hasPendingPermissions: true });
}

function onPermissionResolved(): void {
	_pendingPermCount = Math.max(0, _pendingPermCount - 1);
	setSnap({ hasPendingPermissions: _pendingPermCount > 0 });
}

function onUsageUpdate(
	msg: Extract<ServerMessage, { type: "usage_update" }>,
): void {
	applyUsageUpdate(msg);
	// actualModel rides on usage_update because it's reported per inference.
	// Surface via the status snapshot so the model badge can compare against
	// the configured vault model.
	if (msg.actualModel && msg.actualModel !== _snap.actualModel) {
		setSnap({ actualModel: msg.actualModel });
	}
}

function onContextUpdate(
	msg: Extract<ServerMessage, { type: "context_update" }>,
): void {
	applyContextUpdate(msg);
	if (msg.actualModel && msg.actualModel !== _snap.actualModel) {
		setSnap({ actualModel: msg.actualModel });
	}
}

/** Returns false if the message is from a stale session and should be dropped. */
function onDone(msg: Extract<ServerMessage, { type: "done" }>): boolean {
	// Note: stale-session filtering is handled by the per-session filter in
	// onmessage (focused-session gate).
	// here — that's a DB session ID and doesn't match the pool UUID carried by
	// done events broadcast from entry.runState.broadcast().
	// Slice C: pop the queue item matching this done's turn_id. Match by
	// id (not head position) because promote can reorder the server queue,
	// so the just-finished turn might not be at the head of the client's
	// insertion-order queue. Done events for turns NOT in the local queue
	// (e.g. the first idle-path submission from raven, sent via direct
	// ws.send instead of enqueueChat) leave the queue alone.
	if (msg.turn_id) {
		removeLocalChat(msg.turn_id);
	}
	applyDone(msg);
	return true;
}

function handleGlobalMessage(msg: ServerMessage): boolean {
	switch (msg.type) {
		case "sessions_status":
			replaceSessionsStatus(msg.sessions);
			return true;
		case "session_closed":
			for (const session of getSessionsStatus()) {
				if (session.session_id !== msg.session_id) continue;
				if (session.db_session_id) forgetRavenTerminal(session.db_session_id);
				break;
			}
			forgetRavenTerminal(msg.session_id);
			removeSessionStatus(msg.session_id);
			return true;
		case "session_created":
			switchStatsContext(msg.session_id);
			focusSession(msg.session_id);
			_messageBuffer = [];
			for (const subscriber of statusSubs) subscriber();
			return true;
		case "data_revisions":
			replaceDataRevisions(msg.revisions);
			return true;
		default:
			return false;
	}
}

function isMessageFromAnotherSession(msg: ServerMessage): boolean {
	const messageSessionId = (msg as { session_id?: string }).session_id;
	const subscribedSessionId = getSubscribedSessionId();
	return (
		subscribedSessionId !== "" &&
		messageSessionId !== undefined &&
		canonicalSessionId(messageSessionId) !==
			canonicalSessionId(subscribedSessionId)
	);
}

function applySessionMessage(msg: ServerMessage): boolean {
	switch (msg.type) {
		case "status":
			onStatus(msg);
			break;
		case "permission_request":
		case "ask_user_question":
		case "plan_mode_exit":
			onPermissionRequest();
			break;
		case "permission_resolved":
		case "ask_user_question_resolved":
		case "plan_mode_exit_resolved":
			onPermissionResolved();
			break;
		case "usage_update":
			onUsageUpdate(msg);
			break;
		case "context_update":
			onContextUpdate(msg);
			break;
		case "agent_sleep":
			onAgentSleep(msg);
			break;
		case "done":
			return onDone(msg);
		case "queue_state":
			// Queue snapshots are session-scoped. Without that scope, the empty
			// snapshot for a newly selected chat (or the vault snapshot sent before
			// reconnect re-subscription) prunes durable queued prompts belonging to
			// every other chat.
			{
				const rawSessionId = msg.session_id ?? getSubscribedSessionId();
				const sessionId = rawSessionId ? canonicalSessionId(rawSessionId) : "";
				if (sessionId) {
					reconcileLocalQueue(
						sessionId,
						msg.pending_turn_ids,
						msg.running_turn_id,
						(msg.pending_turns ?? []).map((turn) => ({
							...turn,
							session_id: canonicalSessionId(turn.session_id),
							_sent: true,
						})),
					);
				}
			}
			break;
	}
	return true;
}

const BUFFERED_MESSAGE_TYPES: ReadonlySet<ServerMessage["type"]> = new Set([
	"chunk",
	"tool_event",
	"tool_update",
	"tool_result",
	"permission_request",
	"permission_resolved",
	"ask_user_question",
	"ask_user_question_resolved",
	"plan_mode_exit",
	"plan_mode_exit_resolved",
]);

function updateMessageBuffer(msg: ServerMessage): void {
	if (BUFFERED_MESSAGE_TYPES.has(msg.type)) {
		if (_bufferingEnabled) _messageBuffer.push(msg);
		return;
	}
	if (msg.type !== "done" && msg.type !== "error") return;
	if (!_bufferingEnabled) _messageBuffer = [];
	if (msg.type === "error") setPendingSessionToday(false);
}

function handleSocketMessage(event: MessageEvent): void {
	let msg: ServerMessage;
	try {
		msg = JSON.parse(event.data as string) as ServerMessage;
	} catch {
		return;
	}
	if (msg.type === "status") {
		const sessionId =
			(msg as typeof msg & { session_id?: string }).session_id ??
			getSubscribedSessionId();
		if (sessionId) reconcileSessionStatus(sessionId, msg);
	}
	if (handleGlobalMessage(msg) || isMessageFromAnotherSession(msg)) return;
	if (!applySessionMessage(msg)) return;
	updateMessageBuffer(msg);
	if (msg.type === "status" && msg.state === "running") {
		consumeRunningQueuedUser(msg.turn_id);
	} else if (msg.type === "queue_state") {
		consumeRunningQueuedUser(msg.running_turn_id ?? undefined);
	}
	for (const subscriber of messageSubs) subscriber(msg);
}

function clearReconnectTimer(): void {
	if (_reconnectTimer === null) return;
	clearTimeout(_reconnectTimer);
	_reconnectTimer = null;
}

function scheduleReconnect(): void {
	if (_reconnectTimer !== null || document.visibilityState !== "visible")
		return;
	const delay = Math.min(
		RECONNECT_BASE_MS * 2 ** _reconnectAttempts,
		RECONNECT_MAX_MS,
	);
	_reconnectAttempts++;
	_reconnectTimer = setTimeout(() => {
		_reconnectTimer = null;
		connect();
	}, delay);
}

function connect() {
	if (typeof window === "undefined") return;
	if (_ws && (_ws.readyState === WS_CONNECTING || _ws.readyState === WS_OPEN)) {
		return;
	}
	if (_ws) {
		_ws.onopen = null;
		_ws.onerror = null;
		_ws.onclose = null;
		_ws.onmessage = null;
	}

	_ws = new WebSocket(getWsUrl());
	setSnap({ wsStatus: "connecting" });

	_ws.onopen = () => {
		clearReconnectTimer();
		_reconnectAttempts = 0;
		setSnap({ wsStatus: "connected" });
		const subscribedSessionId = getSubscribedSessionId();
		if (subscribedSessionId) {
			_ws?.send(
				JSON.stringify({
					type: "subscribe_session",
					session_id: subscribedSessionId,
				}),
			);
		}
		// Flush any items enqueued while the connection was down. Already-sent
		// items are skipped via the _sent flag.
		drainPendingToServer();
	};
	_ws.onerror = () => setSnap({ wsStatus: "disconnected" });
	_ws.onclose = () => {
		setSnap({ wsStatus: "disconnected" });
		scheduleReconnect();
	};
	_ws.onmessage = handleSocketMessage;
}

/**
 * On mobile browsers (iOS Safari) the WS onclose event may never fire when
 * the OS backgrounds or suspends the tab (screen lock). This leaves wsStatus
 * as "connected" while the socket is actually dead, so the reconnect effect
 * in useLoadChatHistory never runs and history never reloads after unlock.
 *
 * Proactively call connect() whenever the page becomes visible. connect()
 * already guards against creating a duplicate socket when one is OPEN or
 * CONNECTING, so this is safe to call unconditionally.
 */
function handleVisibilityChange(): void {
	if (typeof document === "undefined") return;
	if (document.visibilityState !== "visible") {
		clearReconnectTimer();
		return;
	}
	clearReconnectTimer();
	// Mobile browsers can retain an OPEN readyState for a socket that the OS
	// discarded while the app was backgrounded. Recreate it on resume so the
	// transcript can catch up, then onopen restores the focused session.
	if (_ws?.readyState === WS_OPEN) {
		_ws.onclose = null;
		_ws.close();
		_ws = null;
	}
	connect();
}

if (typeof window !== "undefined") {
	connect();
	document.addEventListener("visibilitychange", handleVisibilityChange);
}

// ─── Public API — Connection & snapshot ──────────────────────────────────────

export function getSnapshot(): Snapshot {
	return _snap;
}

export function subscribeStatus(fn: () => void): () => void {
	statusSubs.add(fn);
	return () => statusSubs.delete(fn);
}

export function subscribeMessage(fn: (msg: ServerMessage) => void): () => void {
	messageSubs.add(fn);
	return () => messageSubs.delete(fn);
}

export function send(msg: ClientMessage): void {
	if (msg.type === "chat") setPendingSessionToday(true);
	if (msg.type === "chat" || msg.type === "clear") _messageBuffer = [];
	if (msg.type === "clear") {
		focusPendingNewSession();
		setPendingSessionToday(false);
		_pendingPermCount = 0;
		setSnap({
			sessionState: "idle",
			hasPendingPermissions: false,
			runningTurnId: null,
		});
		clearChatQueue();
	}
	// Do NOT pre-decrement _pendingPermCount here. The server broadcasts
	// `permission_resolved` back to all clients (including the sender), and
	// onPermissionResolved() handles the decrement then. Pre-decrementing here
	// causes a double-decrement that under-counts concurrent permissions.
	if (_ws?.readyState === WS_OPEN) {
		_ws.send(JSON.stringify(msg));
	}
}

// ─── Public API — Message buffer ─────────────────────────────────────────────

export function drainMessageBuffer(): ServerMessage[] {
	const msgs = _messageBuffer;
	_messageBuffer = [];
	return msgs;
}

export function clearMessageBuffer(): void {
	_messageBuffer = [];
}

export function setBufferingEnabled(enabled: boolean): void {
	_bufferingEnabled = enabled;
	if (!enabled) _messageBuffer = [];
}

/** Seed the actual model from DB so the model badge is correct before any new query. */
export function seedActualModel(actualModel: string | null): void {
	if (actualModel === _snap.actualModel) return;
	setSnap({ actualModel });
}

// ─── Public API — Chat queue ──────────────────────────────────────────────────

export function enqueueChat(msg: QueuedChatMessage): void {
	const item = enqueueLocalChat(msg);
	if (sendChatToServer(item)) markQueuedChatSent(item.id);
}

/**
 * Slice C: ask the server to promote a queued msg — interrupts the current
 * running turn so this msg runs next. The server may decline (returns false)
 * if the id is unknown or refers to the running turn; the client doesn't
 * need to track that distinction since the UI only shows the button on
 * non-running queue items.
 */
export function promoteQueued(id: string): void {
	if (_ws?.readyState !== WS_OPEN) return;
	try {
		_ws.send(JSON.stringify({ type: "promote_queued", turn_id: id }));
		markQueuedChatPromoting(id);
	} catch {
		// Connection lost — best-effort; UI stays consistent next refresh.
	}
}

export function removeFromQueue(id: string): QueuedChatMessage | undefined {
	const item = findQueuedChat(id);
	if (!item) return undefined;
	// Slice C: if the item was already sent to the server, ask the server
	// to cancel it. The server only cancels pending (not-yet-running) turns;
	// the running turn is unaffected and produces its done as usual. Local
	// removal happens regardless so the UI updates instantly.
	if (item._sent && _ws?.readyState === WS_OPEN) {
		try {
			_ws.send(JSON.stringify({ type: "cancel_queued", turn_id: id }));
		} catch {
			// Connection lost — local removal still proceeds.
		}
	}
	return removeLocalChat(id);
}

/**
 * Switch the client's focused session.
 * Updates the local subscription ID, sends `subscribe_session` to the server,
 * and notifies status subscribers so the UI can re-render.
 */
export function subscribeToSession(sessionId: string): void {
	const sessionChanged = getSubscribedSessionId() !== sessionId;
	switchStatsContext(sessionId);
	focusSession(sessionId);
	if (sessionChanged) {
		// The replay buffer belongs to the previously focused session. Keep replay
		// during snapshot/reconnect reads, but never carry those events across a
		// chat switch. Events from the newly subscribed session can refill it while
		// that session's history is loading.
		_messageBuffer = [];
		// Session controls and run state are scoped to the focused chat. Do not
		// display the previous chat's model/effort/permissions while waiting for
		// the subscribed session's status response.
		_snap = {
			..._snap,
			sessionState: "idle",
			model: "",
			actualModel: null,
			permissionMode: null,
			effort: null,
			hasPendingPermissions: false,
			runningTurnId: null,
			sleepState: null,
		};
		_pendingPermCount = 0;
	}
	if (_ws?.readyState === WS_OPEN) {
		try {
			_ws.send(
				JSON.stringify({ type: "subscribe_session", session_id: sessionId }),
			);
		} catch {
			// Best-effort; reconnect logic will re-subscribe.
		}
	}
	// Notify so snapshot consumers know the active session changed.
	for (const fn of statusSubs) fn();
}

/** @internal — resets all module state to initial values; for testing only. */
export function __resetForTesting(): void {
	clearReconnectTimer();
	_snap = { ...INITIAL_SNAPSHOT };
	_ws = null;
	_reconnectAttempts = 0;
	_messageBuffer = [];
	_bufferingEnabled = true;
	_pendingPermCount = 0;
	resetChatQueueForTesting();
	resetLiveStatsForTesting();
	resetSessionStatusForTesting();
	resetDataRevisionsForTesting();
	statusSubs.clear();
	messageSubs.clear();
}
