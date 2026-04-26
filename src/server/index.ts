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

// Last error from a session — re-sent to clients that reconnect after the error fired
let lastSessionError: string | null = null;

function broadcast(msg: ServerMessage): void {
	if (msg.type === "error") lastSessionError = msg.message;
	else if (msg.type === "status" && msg.state === "running")
		lastSessionError = null;
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
			const [messages, toolEvents] = await Promise.all([
				db.getSessionMessages(sessionId),
				db.getSessionToolEvents(sessionId),
			]);
			// Group tool events by assistant_seq for O(1) lookup
			const toolsBySeq = new Map<number, (typeof toolEvents)[number][]>();
			for (const te of toolEvents) {
				const list = toolsBySeq.get(te.assistant_seq) ?? [];
				list.push(te);
				toolsBySeq.set(te.assistant_seq, list);
			}
			const enriched = messages.map((m) => ({
				...m,
				toolEvents:
					m.role === "assistant" ? (toolsBySeq.get(m.seq) ?? []) : undefined,
			}));
			return Response.json(enriched);
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

		if (url.pathname === "/db/weekly-stats") {
			const stats = await db.getWeeklyStats();
			return Response.json(stats);
		}

		if (url.pathname === "/db/usage-windows") {
			const windows = await db.getUsageWindows();
			return Response.json(windows);
		}

		return new Response("Not found", { status: 404 });
	},

	websocket: {
		open(ws) {
			clients.add(ws);
			const status = session.getStatus();
			send(ws, { type: "status", ...status });
			// Re-send last error only when session is still in error state
			if (lastSessionError !== null && session.getStatus().state === "error") {
				send(ws, { type: "error", message: lastSessionError });
			}
			// If session is running and has no owner (e.g. page refresh), claim ownership
			// and re-send any pending permission requests so they aren't lost.
			if (session.isRunning() && sessionOwnerWs === null) {
				sessionOwnerWs = ws;
				for (const req of session.getPendingPermissionRequests()) {
					send(ws, req);
				}
			}
		},

		close(ws) {
			clients.delete(ws);
			if (ws === sessionOwnerWs) sessionOwnerWs = null;
			// Session persists — no abort on disconnect
		},

		async message(ws, raw) {
			let msg: ClientMessage;
			try {
				msg = JSON.parse(raw.toString()) as ClientMessage;
			} catch {
				send(ws, { type: "error", message: "Invalid JSON" });
				return;
			}

			if (msg.type === "sync") {
				send(ws, { type: "status", ...session.getStatus() });
				if (session.isRunning()) {
					if (sessionOwnerWs === null) sessionOwnerWs = ws;
					if (ws === sessionOwnerWs) {
						for (const req of session.getPendingPermissionRequests()) {
							send(ws, req);
						}
					}
				}
				return;
			}

			if (msg.type === "abort") {
				session.abort();
				return;
			}

			if (msg.type === "clear") {
				session.clearHistory();
				lastSessionError = null;
				return;
			}

			if (msg.type === "reload_session") {
				const fresh = loadConfig();
				session.reinitialize(fresh);
				lastSessionError = null;
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
						msg.skill_context,
					);
				} catch (err) {
					const message = err instanceof Error ? err.message : "Unknown error";
					send(ws, { type: "error", message });
				} finally {
					// Only clear ownership if this ws still owns it — a sync from a
					// reconnecting client may have claimed ownership mid-run.
					if (sessionOwnerWs === ws) sessionOwnerWs = null;
				}
			}
		},
	},
});

console.log(`Hlid server on :${PORT}`);
