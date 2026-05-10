import type { ServerWebSocket } from "bun";
import * as db from "../db";
import type { ServerMessage } from "./protocol";

export const wsState = {
	clients: new Set<ServerWebSocket<unknown>>(),
	sessionOwnerWs: null as ServerWebSocket<unknown> | null,
	lastSessionError: null as string | null,
	// Per-ws in-flight chat count. Ownership only releases when a ws's count
	// hits zero, so concurrent typed-while-running chats from the same ws
	// don't release ownership prematurely.
	inFlightChatCount: new Map<ServerWebSocket<unknown>, number>(),
};

let _runBuffer: ServerMessage[] = [];
// Cap replay buffer at 500 messages. On overflow drop oldest so reconnecting
// clients always see the most recent stream rather than stale early chunks.
const RUN_BUFFER_MAX = 500;

export function getRunBuffer(): readonly ServerMessage[] {
	return _runBuffer;
}

export function broadcast(msg: ServerMessage): void {
	if (msg.type === "error") wsState.lastSessionError = msg.message;
	else if (msg.type === "status" && msg.state === "running") {
		wsState.lastSessionError = null;
		_runBuffer = [];
	} else if (msg.type === "mcp_status")
		void db
			.saveSetting("mcp_status_cache", JSON.stringify(msg.servers))
			.catch((e) =>
				console.error("[runState] saveSetting mcp_status_cache failed:", e),
			);

	if (
		msg.type === "chunk" ||
		msg.type === "tool_event" ||
		msg.type === "permission_request" ||
		msg.type === "permission_resolved"
	) {
		_runBuffer.push(msg);
		if (_runBuffer.length > RUN_BUFFER_MAX) _runBuffer.shift();
	} else if (msg.type === "done" || msg.type === "error") {
		_runBuffer = [];
	}

	const data = JSON.stringify(msg);
	for (const ws of wsState.clients) {
		try {
			ws.send(data);
		} catch {
			// Dead socket — skip; close event will remove it from the client set.
		}
	}
}

export function send(ws: ServerWebSocket<unknown>, msg: ServerMessage): void {
	try {
		ws.send(JSON.stringify(msg));
	} catch {
		// Dead socket — caller should handle removal from client set if needed.
	}
}
