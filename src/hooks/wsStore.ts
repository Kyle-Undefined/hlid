import type { ClientMessage, ServerMessage } from "../server/protocol";
import type { SessionState } from "../server/session";

export type WsStatus = "connecting" | "connected" | "disconnected";

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

let _snap: Snapshot = {
	wsStatus: "connecting",
	sessionState: "idle",
	model: "",
	actualModel: null,
	hasPendingPermissions: false,
};
let _ws: WebSocket | null = null;
let _pendingPrompt: string | null = null;
let _liveStats: LiveStats = loadPersistedStats() ?? { ...EMPTY_STATS };
let _activeSessionId: string | null = null;
// Buffers in-flight chunks/tool_events for the current run so they survive SPA navigation.
// Always written (even when subscribers exist), cleared on run end or new run start.
let _messageBuffer: ServerMessage[] = [];
let _bufferingEnabled = true;
let _pendingPermCount = 0;
let _pendingSessionToday = false;

const statusSubs = new Set<() => void>();
const messageSubs = new Set<(msg: ServerMessage) => void>();
const statsSubs = new Set<() => void>();

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
		if (msg.type === "status") {
			// When a run starts, clear actualModel so the badge shows "unknown"
			// until the first usage_update confirms what the CLI actually used.
			// On idle/error (run ended), preserve actualModel so the mismatch
			// badge persists after the run completes.
			_pendingPermCount = 0;
			setSnap({
				sessionState: msg.state,
				model: msg.model,
				...(msg.state === "running" ? { actualModel: null } : {}),
				hasPendingPermissions: false,
			});
		}
		if (msg.type === "permission_request") {
			_pendingPermCount++;
			setSnap({ hasPendingPermissions: true });
		}
		if (msg.type === "permission_resolved") {
			_pendingPermCount = Math.max(0, _pendingPermCount - 1);
			setSnap({ hasPendingPermissions: _pendingPermCount > 0 });
		}
		if (msg.type === "usage_update") {
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
			// actualModel rides on usage_update because it's reported per
			// inference. Surface via the status snapshot so the model badge
			// can compare against the configured vault model.
			if (msg.actualModel && msg.actualModel !== _snap.actualModel) {
				setSnap({ actualModel: msg.actualModel });
			}
		}
		if (msg.type === "done") {
			_pendingSessionToday = false;
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
				max_output_tokens:
					msg.max_output_tokens ?? _liveStats.max_output_tokens,
				last_context_used:
					msg.tokens_in_context ??
					msg.input_tokens + msg.cache_read_tokens + msg.cache_creation_tokens,
				last_output_tokens: msg.output_tokens,
				queries: _liveStats.queries + 1,
			};
			persistStats(_liveStats);
			for (const fn of statsSubs) fn();
		}
		// Buffer in-flight events while buffering is enabled (before history loads,
		// or during SPA nav with component unmounted). Disabled after history drains
		// so the buffer doesn't grow during a live session.
		if (
			msg.type === "chunk" ||
			msg.type === "tool_event" ||
			msg.type === "permission_request" ||
			msg.type === "permission_resolved"
		) {
			if (_bufferingEnabled) _messageBuffer.push(msg);
		} else if (msg.type === "done" || msg.type === "error") {
			_messageBuffer = [];
			if (msg.type === "error") _pendingSessionToday = false;
		}
		for (const fn of messageSubs) fn(msg);
	};
}

if (typeof window !== "undefined") connect();

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
	if (msg.type === "permission_response") {
		_pendingPermCount = Math.max(0, _pendingPermCount - 1);
		setSnap({ hasPendingPermissions: _pendingPermCount > 0 });
	}
	if (_ws?.readyState === WebSocket.OPEN) {
		_ws.send(JSON.stringify(msg));
	}
}

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

export function resetLiveStats(): void {
	_liveStats = { ...EMPTY_STATS };
	clearPersistedStats();
	for (const fn of statsSubs) fn();
}

// Seed the actual model from the DB when loading an existing session so the
// model badge reflects what was previously used without waiting for a new query.
export function seedActualModel(actualModel: string | null): void {
	if (actualModel === _snap.actualModel) return;
	setSnap({ actualModel });
}

// Seed context window info from the DB when loading an existing session so
// the gauge shows the last known value immediately, before any new query runs.
// Always applied on session load — live usage_update/done events override it
// naturally within seconds of any new activity.
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

export function setPendingPrompt(text: string): void {
	_pendingPrompt = text;
}

export function claimPendingPrompt(): string | null {
	const p = _pendingPrompt;
	_pendingPrompt = null;
	return p;
}

export function getLiveStats(): LiveStats {
	return _liveStats;
}

export function subscribeStats(fn: () => void): () => void {
	statsSubs.add(fn);
	return () => statsSubs.delete(fn);
}

export function getPendingSessionToday(): boolean {
	return _pendingSessionToday;
}

export function getActiveSessionId(): string | null {
	return _activeSessionId;
}

export function setActiveSessionId(id: string): void {
	_activeSessionId = id;
}
