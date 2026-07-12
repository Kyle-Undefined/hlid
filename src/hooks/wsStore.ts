import type {
	ChatAttachment,
	ClientMessage,
	ServerMessage,
	SessionStatusEntry,
} from "../server/protocol";
import type { SessionState } from "../server/session";

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

export type QueuedChatMessage = {
	id: string;
	text: string;
	session_id: string;
	skill_context?: string;
	agent_cwd?: string;
	attachments?: ChatAttachment[];
	plan_mode?: boolean;
	plan_html?: boolean;
	/**
	 * Internal flag set after the message has been delivered to the server.
	 * Items remain in the queue (for UI display of in-flight turns) until
	 * their `done` event arrives, so we use this flag to avoid re-sending
	 * on reconnect.
	 */
	_sent?: boolean;
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

export type LiveStats = {
	turns: number;
	cost: number;
	duration_ms: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
	context_window: number | null;
	max_output_tokens: number | null;
	last_context_used: number | null;
	last_output_tokens: number | null;
	queries: number;
};

export const EMPTY_STATS: LiveStats = {
	turns: 0,
	cost: 0,
	duration_ms: 0,
	input_tokens: 0,
	output_tokens: 0,
	cache_read_tokens: 0,
	cache_creation_tokens: 0,
	context_window: null,
	max_output_tokens: null,
	last_context_used: null,
	last_output_tokens: null,
	queries: 0,
};

// ─── Stats persistence helpers ───────────────────────────────────────────────

const STATS_KEY = "hlid:live_stats";

function persistStats(stats: LiveStats): void {
	try {
		sessionStorage.setItem(STATS_KEY, JSON.stringify(stats));
	} catch {}
}

function loadPersistedStats(): LiveStats | null {
	try {
		const raw = sessionStorage.getItem(STATS_KEY);
		return raw ? (JSON.parse(raw) as LiveStats) : null;
	} catch {
		return null;
	}
}

function clearPersistedStats(): void {
	try {
		sessionStorage.removeItem(STATS_KEY);
	} catch {}
}

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
	hasPendingPermissions: false,
	runningTurnId: null,
	sleepState: null,
};

let _snap: Snapshot = { ...INITIAL_SNAPSHOT };
let _ws: WebSocket | null = null;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _reconnectAttempts = 0;
let _liveStats: LiveStats = loadPersistedStats() ?? { ...EMPTY_STATS };
// Buffers in-flight chunks/tool_events for the current run so they survive SPA navigation.
// Always written (even when subscribers exist), cleared on run end or new run start.
let _messageBuffer: ServerMessage[] = [];
let _bufferingEnabled = true;
let _pendingPermCount = 0;
let _pendingSessionToday = false;
let _pendingPrompt: string | null = null;
let _chatQueue: QueuedChatMessage[] = [];

// ── Multi-session state ───────────────────────────────────────────────────────
/** Pool-wide list of all live sessions (updated by sessions_status messages). */
let _sessionsStatus: SessionStatusEntry[] = [];
/** UUID of the WS pool session this client is currently subscribed to.
 *  Empty string = not yet subscribed (no filtering applied — backward compat). */
let _subscribedSessionId = "";
const PENDING_NEW_SESSION_ID = "__hlid_pending_new_session__";

// Subscriber sets — five concerns, each notified independently.
const statusSubs = new Set<() => void>();
const messageSubs = new Set<(msg: ServerMessage) => void>();
const statsSubs = new Set<() => void>();
const queueSubs = new Set<() => void>();
const sessionsStatusSubs = new Set<() => void>();

// ─── Queue helpers ───────────────────────────────────────────────────────────

function notifyQueue(): void {
	for (const fn of queueSubs) fn();
}

/**
 * Slice A: server-side queueing. Enqueued messages are sent to the server
 * IMMEDIATELY (not batched on idle). The server accepts mid-run and queues
 * FIFO at the SessionManager level. The client queue mirrors what's still in
 * flight: items remain visible until their `done` event arrives.
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
	};
	for (const fn of messageSubs) fn(userEvent);
	_pendingSessionToday = true;
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
	if (msg.attachments && msg.attachments.length > 0) {
		payload.attachments = msg.attachments;
	}
	if (msg.plan_mode) payload.plan_mode = true;
	if (msg.plan_html) payload.plan_html = true;
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
	for (const item of _chatQueue) {
		if (item._sent) continue;
		if (sendChatToServer(item)) item._sent = true;
		else break;
	}
}

/**
 * Remove the queued item matching the given turn_id. Called on each `done`
 * from server. Matches by id rather than head position because promote can
 * reorder the server-side queue, leaving client's insertion-order queue out
 * of sync with the actual processing order.
 */
function popQueueById(turnId: string): void {
	const idx = _chatQueue.findIndex((q) => q.id === turnId);
	if (idx === -1) return;
	_chatQueue = _chatQueue.filter((_, i) => i !== idx);
	notifyQueue();
}

/**
 * Slice C polish: reconcile chatQueue against the server's authoritative
 * queue state. Sent items not in the server's pending list (and not the
 * currently running one) are orphans — e.g. server restarted, lost the
 * QueuedTurn — and get pruned. Not-yet-sent items (still in the local
 * outbox awaiting ws connect) are preserved.
 */
function reconcileQueueState(
	pendingIds: string[],
	runningId: string | null,
): void {
	const known = new Set([...pendingIds, ...(runningId ? [runningId] : [])]);
	const before = _chatQueue.length;
	_chatQueue = _chatQueue.filter((q) => !q._sent || known.has(q.id));
	if (_chatQueue.length !== before) notifyQueue();
}

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
		hasPendingPermissions: _pendingPermCount > 0,
		runningTurnId,
		// Sleeping only happens while running; a non-running status means any
		// banner is stale (e.g. the resumed event raced a disconnect).
		...(msg.state !== "running" ? { sleepState: null } : {}),
	});
	// Slice A: server-side queue manages drain order. Client no longer batches
	// or sends on state=idle — items are dispatched immediately on enqueue and
	// removed from the local queue when their `done` event arrives.
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
	// Live per-turn snapshot. Update only the "current turn" fields —
	// cumulative tokens/cost/turns/duration/queries are still summed at `done`
	// from the result's authoritative totals.
	// context_window is carried forward from the most recent result so the
	// gauge can render on sessions that haven't completed a query yet.
	_liveStats = {
		..._liveStats,
		last_context_used: msg.tokens_in_context,
		last_output_tokens: msg.output_tokens,
		context_window: msg.context_window ?? _liveStats.context_window,
	};
	persistStats(_liveStats);
	for (const fn of statsSubs) fn();
	// actualModel rides on usage_update because it's reported per inference.
	// Surface via the status snapshot so the model badge can compare against
	// the configured vault model.
	if (msg.actualModel && msg.actualModel !== _snap.actualModel) {
		setSnap({ actualModel: msg.actualModel });
	}
}

/** Returns false if the message is from a stale session and should be dropped. */
function onDone(msg: Extract<ServerMessage, { type: "done" }>): boolean {
	_pendingSessionToday = false;
	// Note: stale-session filtering is handled by the per-session filter in
	// onmessage (_subscribedSessionId gate).
	// here — that's a DB session ID and doesn't match the pool UUID carried by
	// done events broadcast from entry.runState.broadcast().
	// Slice C: pop the queue item matching this done's turn_id. Match by
	// id (not head position) because promote can reorder the server queue,
	// so the just-finished turn might not be at the head of the client's
	// insertion-order queue. Done events for turns NOT in the local queue
	// (e.g. the first idle-path submission from raven, sent via direct
	// ws.send instead of enqueueChat) leave the queue alone.
	if (msg.turn_id) {
		popQueueById(msg.turn_id);
	}
	_liveStats = {
		turns: _liveStats.turns + msg.turns,
		cost: _liveStats.cost + (msg.cost ?? 0),
		duration_ms: _liveStats.duration_ms + msg.duration_ms,
		input_tokens: _liveStats.input_tokens + msg.input_tokens,
		output_tokens: _liveStats.output_tokens + msg.output_tokens,
		cache_read_tokens: _liveStats.cache_read_tokens + msg.cache_read_tokens,
		cache_creation_tokens:
			_liveStats.cache_creation_tokens + msg.cache_creation_tokens,
		context_window: msg.context_window ?? _liveStats.context_window,
		max_output_tokens: msg.max_output_tokens ?? _liveStats.max_output_tokens,
		last_context_used:
			msg.tokens_in_context ??
			msg.input_tokens + msg.cache_read_tokens + msg.cache_creation_tokens,
		last_output_tokens: msg.output_tokens,
		queries: _liveStats.queries + 1,
	};
	persistStats(_liveStats);
	for (const fn of statsSubs) fn();
	return true;
}

function handleGlobalMessage(msg: ServerMessage): boolean {
	switch (msg.type) {
		case "sessions_status":
			_sessionsStatus = msg.sessions;
			recomputeAggregateNavStatus();
			for (const subscriber of sessionsStatusSubs) subscriber();
			return true;
		case "session_closed":
			_sessionsStatus = _sessionsStatus.filter(
				(session) => session.session_id !== msg.session_id,
			);
			recomputeAggregateNavStatus();
			for (const subscriber of sessionsStatusSubs) subscriber();
			return true;
		case "session_created":
			_subscribedSessionId = msg.session_id;
			_messageBuffer = [];
			for (const subscriber of statusSubs) subscriber();
			return true;
		default:
			return false;
	}
}

function isMessageFromAnotherSession(msg: ServerMessage): boolean {
	const messageSessionId = (msg as { session_id?: string }).session_id;
	return (
		_subscribedSessionId !== "" &&
		messageSessionId !== undefined &&
		messageSessionId !== _subscribedSessionId
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
		case "agent_sleep":
			onAgentSleep(msg);
			break;
		case "done":
			return onDone(msg);
		case "queue_state":
			reconcileQueueState(msg.pending_turn_ids, msg.running_turn_id);
			break;
	}
	return true;
}

const BUFFERED_MESSAGE_TYPES: ReadonlySet<ServerMessage["type"]> = new Set([
	"chunk",
	"tool_event",
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
	if (msg.type === "error") _pendingSessionToday = false;
}

function handleSocketMessage(event: MessageEvent): void {
	let msg: ServerMessage;
	try {
		msg = JSON.parse(event.data as string) as ServerMessage;
	} catch {
		return;
	}
	if (handleGlobalMessage(msg) || isMessageFromAnotherSession(msg)) return;
	if (!applySessionMessage(msg)) return;
	updateMessageBuffer(msg);
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
		if (_subscribedSessionId) {
			_ws?.send(
				JSON.stringify({
					type: "subscribe_session",
					session_id: _subscribedSessionId,
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
	if (msg.type === "chat") _pendingSessionToday = true;
	if (msg.type === "chat" || msg.type === "clear") _messageBuffer = [];
	if (msg.type === "clear") {
		_subscribedSessionId = PENDING_NEW_SESSION_ID;
		_pendingSessionToday = false;
		_pendingPermCount = 0;
		setSnap({
			sessionState: "idle",
			hasPendingPermissions: false,
			runningTurnId: null,
		});
		_chatQueue = [];
		notifyQueue();
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

// ─── Public API — Live stats ──────────────────────────────────────────────────

export function getLiveStats(): LiveStats {
	return _liveStats;
}

export function subscribeStats(fn: () => void): () => void {
	statsSubs.add(fn);
	return () => statsSubs.delete(fn);
}

export function resetLiveStats(): void {
	_liveStats = { ...EMPTY_STATS };
	clearPersistedStats();
	for (const fn of statsSubs) fn();
}

export function getPendingSessionToday(): boolean {
	return _pendingSessionToday;
}

/** Seed the actual model from DB so the model badge is correct before any new query. */
export function seedActualModel(actualModel: string | null): void {
	if (actualModel === _snap.actualModel) return;
	setSnap({ actualModel });
}

/**
 * Seed context window info from DB when loading an existing session so the
 * gauge shows the last known value immediately, before any new query runs.
 * Only fills null fields — live usage_update/done events that arrived after
 * resetLiveStats() already set these values and must not be overwritten.
 */
export function seedContextStats(
	contextWindow: number,
	lastContextUsed: number,
): void {
	const cw = _liveStats.context_window ?? contextWindow;
	const lcu = _liveStats.last_context_used ?? lastContextUsed;
	if (cw === _liveStats.context_window && lcu === _liveStats.last_context_used)
		return;
	_liveStats = { ..._liveStats, context_window: cw, last_context_used: lcu };
	persistStats(_liveStats);
	for (const fn of statsSubs) fn();
}

// ─── Public API — Pending prompt ─────────────────────────────────────────────

export function setPendingPrompt(text: string): void {
	_pendingPrompt = text;
}

export function claimPendingPrompt(): string | null {
	const p = _pendingPrompt;
	_pendingPrompt = null;
	return p;
}

// ─── Public API — Chat queue ──────────────────────────────────────────────────

export function enqueueChat(msg: QueuedChatMessage): void {
	const item: QueuedChatMessage = { ...msg };
	_chatQueue = [..._chatQueue, item];
	notifyQueue();
	if (sendChatToServer(item)) item._sent = true;
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
	} catch {
		// Connection lost — best-effort; UI stays consistent next refresh.
	}
}

export function removeFromQueue(id: string): QueuedChatMessage | undefined {
	const item = _chatQueue.find((m) => m.id === id);
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
	_chatQueue = _chatQueue.filter((m) => m.id !== id);
	notifyQueue();
	return item;
}

export function getQueue(): QueuedChatMessage[] {
	return _chatQueue;
}

export function subscribeQueue(fn: () => void): () => void {
	queueSubs.add(fn);
	return () => queueSubs.delete(fn);
}

export function clearChatQueue(): void {
	if (_chatQueue.length === 0) return;
	_chatQueue = [];
	notifyQueue();
}

// ─── Public API — Multi-session ──────────────────────────────────────────────

/** Pool-wide list of all live sessions, updated by sessions_status messages. */
export function getSessionsStatus(): SessionStatusEntry[] {
	return _sessionsStatus;
}

/** Subscribe to pool-wide session list changes. Returns unsubscribe fn. */
export function subscribeSessionsStatus(fn: () => void): () => void {
	sessionsStatusSubs.add(fn);
	return () => sessionsStatusSubs.delete(fn);
}

/**
 * Switch the client's focused session.
 * Updates the local subscription ID, sends `subscribe_session` to the server,
 * and notifies status subscribers so the UI can re-render.
 */
export function subscribeToSession(sessionId: string): void {
	_subscribedSessionId = sessionId;
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

/** UUID of the WS pool session this client is subscribed to (empty = not yet set). */
export function getSubscribedSessionId(): string {
	return _subscribedSessionId;
}

/**
 * Aggregate nav status across all live sessions.
 * Driving rule:
 *   running > error > idle
 * runningCount = number of sessions in "running" state.
 * pendingPermissions = true if any session has hasPendingPermissions.
 */
export type AggregateNavStatus = {
	state: "idle" | "running" | "error";
	runningCount: number;
	pendingPermissions: boolean;
};

// Cached aggregate so useSyncExternalStore gets a stable reference between
// store updates. React requires getSnapshot() to return the same object if the
// store hasn't changed; returning a new object every call causes infinite loops.
let _aggregateNavStatus: AggregateNavStatus = {
	state: "idle",
	runningCount: 0,
	pendingPermissions: false,
};

function recomputeAggregateNavStatus(): void {
	let hasRunning = false;
	let hasError = false;
	let runningCount = 0;
	let pendingPermissions = false;
	for (const s of _sessionsStatus) {
		if (s.state === "running") {
			hasRunning = true;
			runningCount++;
		}
		if (s.state === "error") hasError = true;
		if (s.hasPendingPermissions) pendingPermissions = true;
	}
	const state: "idle" | "running" | "error" = hasRunning
		? "running"
		: hasError
			? "error"
			: "idle";
	// Only replace when values actually changed (keeps reference stable).
	if (
		state !== _aggregateNavStatus.state ||
		runningCount !== _aggregateNavStatus.runningCount ||
		pendingPermissions !== _aggregateNavStatus.pendingPermissions
	) {
		_aggregateNavStatus = { state, runningCount, pendingPermissions };
	}
}

export function getAggregateNavStatus(): AggregateNavStatus {
	return _aggregateNavStatus;
}

/** @internal — resets all module state to initial values; for testing only. */
export function __resetForTesting(): void {
	clearReconnectTimer();
	_snap = { ...INITIAL_SNAPSHOT };
	_ws = null;
	_reconnectAttempts = 0;
	_liveStats = { ...EMPTY_STATS };
	_messageBuffer = [];
	_bufferingEnabled = true;
	_pendingPermCount = 0;
	_pendingSessionToday = false;
	_pendingPrompt = null;
	_chatQueue = [];
	_sessionsStatus = [];
	_aggregateNavStatus = {
		state: "idle",
		runningCount: 0,
		pendingPermissions: false,
	};
	_subscribedSessionId = "";
	statusSubs.clear();
	messageSubs.clear();
	statsSubs.clear();
	queueSubs.clear();
	sessionsStatusSubs.clear();
}
