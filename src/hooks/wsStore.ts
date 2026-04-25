import type { ClientMessage, ServerMessage } from "../server/protocol";
import type { SessionState } from "../server/session";

export type WsStatus = "connecting" | "connected" | "disconnected";

type Snapshot = {
	wsStatus: WsStatus;
	sessionState: SessionState;
	model: string;
};

let _snap: Snapshot = {
	wsStatus: "connecting",
	sessionState: "idle",
	model: "",
};
let _ws: WebSocket | null = null;

const statusSubs = new Set<() => void>();
const messageSubs = new Set<(msg: ServerMessage) => void>();

function getWsUrl(): string {
	const proto = window.location.protocol === "https:" ? "wss" : "ws";
	const port =
		(typeof import.meta !== "undefined" &&
			(import.meta as { env?: { VITE_WS_PORT?: string } }).env?.VITE_WS_PORT) ||
		"3001";
	return `${proto}://${window.location.hostname}:${port}/ws`;
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
