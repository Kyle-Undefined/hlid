import type { ClientMessage, ServerMessage } from "../server/protocol";
import type { SessionState } from "../server/session";

export type WsStatus = "connecting" | "connected" | "disconnected";

type Snapshot = {
	wsStatus: WsStatus;
	sessionState: SessionState;
	model: string;
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
	queries: number;
};

const EMPTY_STATS: LiveStats = {
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
	queries: 0,
};

let _snap: Snapshot = {
	wsStatus: "connecting",
	sessionState: "idle",
	model: "",
};
let _ws: WebSocket | null = null;
let _pendingPrompt: string | null = null;
let _liveStats: LiveStats = { ...EMPTY_STATS };
let _activeSessionId: string | null = null;

const statusSubs = new Set<() => void>();
const messageSubs = new Set<(msg: ServerMessage) => void>();
const statsSubs = new Set<() => void>();

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
			setSnap({ sessionState: msg.state, model: msg.model });
		}
		if (msg.type === "done") {
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
					msg.input_tokens + msg.cache_read_tokens + msg.cache_creation_tokens,
				queries: _liveStats.queries + 1,
			};
			for (const fn of statsSubs) fn();
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
	if (_ws?.readyState === WebSocket.OPEN) {
		_ws.send(JSON.stringify(msg));
	}
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

export function getActiveSessionId(): string | null {
	return _activeSessionId;
}

export function setActiveSessionId(id: string): void {
	_activeSessionId = id;
}
