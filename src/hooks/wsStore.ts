import type {
	ChatAttachment,
	ClientMessage,
	ServerMessage,
} from "../server/protocol";
import type { SessionState } from "../server/session";

// ─── Types ───────────────────────────────────────────────────────────────────

export type WsStatus = "connecting" | "connected" | "disconnected";

export type QueuedChatMessage = {
	id: string;
	text: string;
	session_id: string;
	skill_context?: string;
	agent_cwd?: string;
	attachments?: ChatAttachment[];
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
	hasPendingPermissions: boolean;
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
	hasPendingPermissions: false,
};

let _snap: Snapshot = { ...INITIAL_SNAPSHOT };
let _ws: WebSocket | null = null;
let _liveStats: LiveStats = loadPersistedStats() ?? { ...EMPTY_STATS };
let _activeSessionId: string | null = null;
// Buffers in-flight chunks/tool_events for the current run so they survive SPA navigation.
// Always written (even when subscribers exist), cleared on run end or new run start.
let _messageBuffer: ServerMessage[] = [];
let _bufferingEnabled = true;
let _pendingPermCount = 0;
let _pendingSessionToday = false;
let _pendingPrompt: string | null = null;
let _chatQueue: QueuedChatMessage[] = [];

// Subscriber sets — four concerns, each notified independently.
const statusSubs = new Set<() => void>();
const messageSubs = new Set<(msg: ServerMessage) => void>();
const statsSubs = new Set<() => void>();
const queueSubs = new Set<() => void>();

// ─── Queue helpers ───────────────────────────────────────────────────────────

function notifyQueue(): void {
	for (const fn of queueSubs) fn();
}

/** Drain the chat queue when the session becomes idle. Batches all queued messages into one send. */
function drainQueue(): void {
	if (_chatQueue.length === 0) return;
	if (_ws?.readyState !== WebSocket.OPEN) return;
	const batch = _chatQueue;
	const first = batch[0];
	const text = batch
		.map((m) => m.text)
		.filter(Boolean)
		.join("\n\n");
	const attachments = batch.flatMap((m) => m.attachments ?? []);
	const userEvent: ServerMessage = {
		type: "user_message",
		text,
		session_id: first.session_id,
	};
	for (const fn of messageSubs) fn(userEvent);
	_pendingSessionToday = true;
	_activeSessionId = first.session_id;
	_messageBuffer = [];
	const payload: Record<string, unknown> = {
		type: "chat",
		text,
		session_id: first.session_id,
	};
	if (first.agent_cwd) payload.agent_cwd = first.agent_cwd;
	// skill_context taken from first queued message only. Batching multiple
	// skill invocations into one send is not supported; concurrent skill queues
	// are rare and the first-wins rule matches the single-message fast path.
	if (first.skill_context) payload.skill_context = first.skill_context;
	if (attachments.length > 0) payload.attachments = attachments;
	try {
		_ws.send(JSON.stringify(payload));
		_chatQueue = [];
		notifyQueue();
	} catch {
		// Connection closed unexpectedly; items remain in queue for retry on reconnect
	}
}

// ─── WebSocket connection ─────────────────────────────────────────────────────

function getHlidToken(): string {
	return (
		document
			.querySelector('meta[name="hlid-token"]')
			?.getAttribute("content") ?? ""
	);
}

function getWsUrl(): string {
	const token = getHlidToken();
	const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";

	const wsPort =
		typeof import.meta !== "undefined"
			? (import.meta as { env?: { VITE_WS_PORT?: string } }).env?.VITE_WS_PORT
			: undefined;

	if (wsPort) {
		const proto = window.location.protocol === "https:" ? "wss" : "ws";
		return `${proto}://${window.location.hostname}:${wsPort}/ws${tokenParam}`;
	}

	// HTTPS (e.g. Tailscale serve): same-origin, proxy routes /ws
	if (window.location.protocol === "https:") {
		return `wss://${window.location.host}/ws${tokenParam}`;
	}

	// HTTP: WS server runs on app port + 1
	const appPort = Number(window.location.port) || 80;
	return `ws://${window.location.hostname}:${appPort + 1}/ws${tokenParam}`;
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
	// Only reset the pending permission count when the session reaches a
	// terminal state. Resetting on every status message (including "running")
	// would drop permission requests that arrived mid-run.
	if (msg.state === "idle" || msg.state === "error") {
		_pendingPermCount = 0;
	}
	setSnap({
		sessionState: msg.state,
		model: msg.model,
		hasPendingPermissions: _pendingPermCount > 0,
	});
	if (msg.state === "idle") drainQueue();
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
		...(msg.context_window != null
			? { context_window: msg.context_window }
			: {}),
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
	// Ignore done from a stale session (e.g. in-flight query from before clear)
	if (_activeSessionId !== null && msg.session_id !== _activeSessionId)
		return false;
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

function connect() {
	if (typeof window === "undefined") return;
	if (
		_ws &&
		(_ws.readyState === WebSocket.CONNECTING ||
			_ws.readyState === WebSocket.OPEN)
	) {
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

	_ws.onopen = () => setSnap({ wsStatus: "connected" });
	_ws.onerror = () => setSnap({ wsStatus: "disconnected" });
	_ws.onclose = () => {
		setSnap({ wsStatus: "disconnected" });
		setTimeout(connect, 3000);
	};
	_ws.onmessage = (e: MessageEvent) => {
		let msg: ServerMessage;
		try {
			msg = JSON.parse(e.data as string) as ServerMessage;
		} catch {
			return;
		}
		if (msg.type === "status") onStatus(msg);
		if (msg.type === "permission_request") onPermissionRequest();
		if (msg.type === "permission_resolved") onPermissionResolved();
		if (msg.type === "usage_update") onUsageUpdate(msg);
		if (msg.type === "done" && !onDone(msg)) return;
		// Buffer in-flight events while buffering is enabled (before history loads,
		// or during SPA nav with component unmounted). Disabled after history drains
		// so the buffer doesn't grow during a live session.
		if (
			msg.type === "chunk" ||
			msg.type === "tool_event" ||
			msg.type === "permission_request" ||
			msg.type === "permission_resolved" ||
			msg.type === "ask_user_question" ||
			msg.type === "ask_user_question_resolved"
		) {
			if (_bufferingEnabled) _messageBuffer.push(msg);
		} else if (msg.type === "done" || msg.type === "error") {
			// Only clear the buffer in live mode. When buffering is enabled (history
			// still loading), preserve the buffer so a fast-completing query doesn't
			// lose its streamed chunks before history finishes loading. The component
			// will clear or drain the buffer once LOAD_HISTORY completes.
			if (!_bufferingEnabled) _messageBuffer = [];
			if (msg.type === "error") _pendingSessionToday = false;
		}
		for (const fn of messageSubs) fn(msg);
	};
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
	if (document.visibilityState !== "visible") return;
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
		_chatQueue = [];
		notifyQueue();
	}
	// Do NOT pre-decrement _pendingPermCount here. The server broadcasts
	// `permission_resolved` back to all clients (including the sender), and
	// onPermissionResolved() handles the decrement then. Pre-decrementing here
	// causes a double-decrement that under-counts concurrent permissions.
	if (_ws?.readyState === WebSocket.OPEN) {
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
	_activeSessionId = null;
	clearPersistedStats();
	for (const fn of statsSubs) fn();
}

export function setActiveSessionId(id: string): void {
	_activeSessionId = id;
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
 * Live usage_update/done events override it naturally once a query starts.
 */
export function seedContextStats(
	contextWindow: number,
	lastContextUsed: number,
): void {
	_liveStats = {
		..._liveStats,
		context_window: contextWindow,
		last_context_used: lastContextUsed,
	};
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
	_chatQueue = [..._chatQueue, msg];
	notifyQueue();
}

export function removeFromQueue(id: string): QueuedChatMessage | undefined {
	const item = _chatQueue.find((m) => m.id === id);
	if (!item) return undefined;
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

/** @internal — resets all module state to initial values; for testing only. */
export function __resetForTesting(): void {
	_snap = { ...INITIAL_SNAPSHOT };
	_ws = null;
	_liveStats = { ...EMPTY_STATS };
	_activeSessionId = null;
	_messageBuffer = [];
	_bufferingEnabled = true;
	_pendingPermCount = 0;
	_pendingSessionToday = false;
	_pendingPrompt = null;
	_chatQueue = [];
	statusSubs.clear();
	messageSubs.clear();
	statsSubs.clear();
	queueSubs.clear();
}
