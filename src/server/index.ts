import type { ServerWebSocket } from "bun";
import * as db from "../db";
import { loadConfig } from "./config";
import type { ClientMessage, ServerMessage } from "./protocol";
import { SessionManager } from "./session";

const config = loadConfig();
const session = new SessionManager(config);

const clients = new Set<ServerWebSocket<unknown>>();

// Tracks which client initiated the current running session (for permission scoping)
let sessionOwnerWs: ServerWebSocket<unknown> | null = null;

function broadcast(msg: ServerMessage): void {
	const data = JSON.stringify(msg);
	for (const ws of clients) {
		// Permission requests only go to the session owner
		if (msg.type === "permission_request" && ws !== sessionOwnerWs) continue;
		ws.send(data);
	}
}

function send(ws: ServerWebSocket<unknown>, msg: ServerMessage): void {
	ws.send(JSON.stringify(msg));
}

const PORT = config.server.port + 1; // 3001 when TanStack Start is on 3000

Bun.serve({
	port: PORT,
	hostname: config.server.host,

	async fetch(req, server) {
		const url = new URL(req.url);

		if (url.pathname === "/ws") {
			if (server.upgrade(req)) return undefined;
			return new Response("WebSocket upgrade required", { status: 426 });
		}

		if (url.pathname === "/status") {
			return Response.json(session.getStatus());
		}

		if (url.pathname === "/db/recent-sessions") {
			const limitParam = parseInt(url.searchParams.get("limit") ?? "14", 10);
			const limit =
				Number.isNaN(limitParam) || limitParam <= 0 ? 14 : limitParam;
			const rows = await db.getRecentSessions(limit);
			return Response.json(rows);
		}

		if (url.pathname === "/db/session-messages") {
			const sessionId = url.searchParams.get("session_id");
			if (!sessionId)
				return new Response("Missing session_id", { status: 400 });
			const rows = await db.getSessionMessages(sessionId);
			return Response.json(rows);
		}

		if (url.pathname === "/db/stats") {
			const [agg, sessions] = await Promise.all([
				db.getAggregatedStats(),
				db.getRecentSessions(10),
			]);
			return Response.json({ agg, sessions });
		}

		if (url.pathname === "/db/current-session") {
			const sessionId = await db.getCurrentSessionId();
			return Response.json({ session_id: sessionId });
		}

		return new Response("Not found", { status: 404 });
	},

	websocket: {
		open(ws) {
			clients.add(ws);
			const status = session.getStatus();
			send(ws, { type: "status", ...status });
		},

		close(ws) {
			clients.delete(ws);
			if (ws === sessionOwnerWs) sessionOwnerWs = null;
			// if this was the last client, deny any hanging permission prompts
			if (clients.size === 0) session.abort();
		},

		async message(ws, raw) {
			let msg: ClientMessage;
			try {
				msg = JSON.parse(raw.toString()) as ClientMessage;
			} catch {
				send(ws, { type: "error", message: "Invalid JSON" });
				return;
			}

			if (msg.type === "abort") {
				session.abort();
				return;
			}

			if (msg.type === "clear") {
				session.clearHistory();
				return;
			}

			if (msg.type === "reload_session") {
				const fresh = loadConfig();
				session.reinitialize(fresh);
				broadcast({ type: "status", ...session.getStatus() });
				return;
			}

			if (msg.type === "permission_response") {
				// Only the client that started the session can respond to permissions
				if (ws !== sessionOwnerWs) return;
				session.handlePermissionResponse(msg.id, msg.approved);
				return;
			}

			if (msg.type === "chat") {
				if (typeof msg.text !== "string" || !msg.text.trim()) {
					send(ws, { type: "error", message: "Invalid message" });
					return;
				}

				if (session.isRunning()) {
					send(ws, { type: "error", message: "Session already running" });
					return;
				}

				// Broadcast user prompt to all OTHER clients for cross-device sync
				const userEventData = JSON.stringify({
					type: "user_message",
					text: msg.text,
					session_id: msg.session_id,
				});
				for (const client of clients) {
					if (client !== ws) client.send(userEventData);
				}

				sessionOwnerWs = ws;
				try {
					await session.runQuery(
						msg.text,
						(event) => broadcast(event),
						msg.session_id,
					);
				} catch (err) {
					const message = err instanceof Error ? err.message : "Unknown error";
					send(ws, { type: "error", message });
				} finally {
					sessionOwnerWs = null;
				}
			}
		},
	},
});

console.log(`Hlid server on :${PORT}`);
