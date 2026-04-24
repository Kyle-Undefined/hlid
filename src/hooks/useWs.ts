import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage, ServerMessage } from "../server/protocol";
import type { SessionState } from "../server/session";

// Uses same hostname as the page; works for localhost and Tailscale
function getWsUrl(): string {
	const host = window.location.hostname;
	const proto = window.location.protocol === "https:" ? "wss" : "ws";
	return `${proto}://${host}:3001/ws`;
}

export type WsStatus = "connecting" | "connected" | "disconnected";

export function useWs(onMessage?: (msg: ServerMessage) => void) {
	const [wsStatus, setWsStatus] = useState<WsStatus>("connecting");
	const [sessionState, setSessionState] = useState<SessionState>("idle");
	const [model, setModel] = useState<string>("");
	const wsRef = useRef<WebSocket | null>(null);
	const onMessageRef = useRef(onMessage);
	onMessageRef.current = onMessage;

	useEffect(() => {
		let ws: WebSocket;
		let dead = false;

		function connect() {
			if (dead) return;
			ws = new WebSocket(getWsUrl());
			wsRef.current = ws;
			setWsStatus("connecting");

			ws.onopen = () => setWsStatus("connected");

			ws.onclose = () => {
				setWsStatus("disconnected");
				// auto-reconnect
				setTimeout(connect, 3000);
			};

			ws.onerror = () => {
				setWsStatus("disconnected");
			};

			ws.onmessage = (e: MessageEvent) => {
				let msg: ServerMessage;
				try {
					msg = JSON.parse(e.data as string) as ServerMessage;
				} catch {
					return;
				}
				if (msg.type === "status") {
					setSessionState(msg.state);
					setModel(msg.model);
				}
				onMessageRef.current?.(msg);
			};
		}

		connect();

		return () => {
			dead = true;
			ws?.close();
		};
	}, []);

	const send = useCallback((msg: ClientMessage) => {
		if (wsRef.current?.readyState === WebSocket.OPEN) {
			wsRef.current.send(JSON.stringify(msg));
		}
	}, []);

	return { wsStatus, sessionState, model, send };
}
