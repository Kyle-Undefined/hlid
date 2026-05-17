import type { ServerWebSocket } from "bun";
import * as db from "../db";
import type { ServerMessage } from "./protocol";

// ── SessionRunState ───────────────────────────────────────────────────────────

const SESSION_RUN_BUFFER_MAX = 500;

type WsType = ServerWebSocket<unknown>;

/**
 * Per-session WS state: subscriber set, replay buffer, error tracking,
 * ownership, and in-flight chat count.
 *
 * Each SessionPool entry owns one SessionRunState so sessions are fully
 * isolated — a broadcast on session A never reaches subscribers of session B.
 */
export class SessionRunState {
	readonly sessionId: string;
	private subscribers: Set<WsType> = new Set();
	private _replayBuffer: ServerMessage[] = [];
	lastError: string | null = null;
	ownerWs: WsType | null = null;
	inFlightChatCount: Map<WsType, number> = new Map();

	constructor(sessionId: string) {
		this.sessionId = sessionId;
	}

	addSubscriber(ws: WsType): void {
		this.subscribers.add(ws);
	}

	removeSubscriber(ws: WsType): void {
		this.subscribers.delete(ws);
		this.inFlightChatCount.delete(ws);
		if (this.ownerWs === ws) this.ownerWs = null;
	}

	getSubscriberCount(): number {
		return this.subscribers.size;
	}

	/**
	 * Broadcast a message to all subscribers, tagging it with this session's id.
	 * Also manages the replay buffer and error state.
	 */
	broadcast(msg: ServerMessage): void {
		// Buffer management (mirrors module-level _runBuffer logic)
		if (msg.type === "error") {
			this.lastError = msg.message;
			this._replayBuffer = [];
		} else if (msg.type === "status" && msg.state === "running") {
			this.lastError = null;
			this._replayBuffer = [];
		} else if (msg.type === "done") {
			this._replayBuffer = [];
		} else if (
			msg.type === "chunk" ||
			msg.type === "tool_event" ||
			msg.type === "permission_request" ||
			msg.type === "permission_resolved"
		) {
			this._replayBuffer.push(msg);
			if (this._replayBuffer.length > SESSION_RUN_BUFFER_MAX) {
				this._replayBuffer.shift();
			}
		}

		// Tag with session_id so clients can route to the right conversation
		const tagged = { ...msg, session_id: this.sessionId };
		const data = JSON.stringify(tagged);
		for (const ws of this.subscribers) {
			try {
				ws.send(data);
			} catch {
				// Dead socket — skip; close event handles removal
			}
		}
	}

	/** Unicast a message to a specific ws (with session_id tag). */
	send(ws: WsType, msg: ServerMessage): void {
		try {
			ws.send(JSON.stringify({ ...msg, session_id: this.sessionId }));
		} catch {
			// Dead socket
		}
	}

	getReplayBuffer(): readonly ServerMessage[] {
		return this._replayBuffer;
	}

	clearError(): void {
		this.lastError = null;
	}
}

export const wsState = {
	clients: new Set<ServerWebSocket<unknown>>(),
	lastSessionError: null as string | null,
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
