import type { ServerWebSocket } from "bun";
import { loadConfig } from "./config";
import type { ClientMessage, ServerMessage } from "./protocol";
import { SessionManager } from "./session";

const config = loadConfig();
const session = new SessionManager(config);

const clients = new Set<ServerWebSocket<unknown>>();

function broadcast(msg: ServerMessage): void {
	const data = JSON.stringify(msg);
	for (const ws of clients) {
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

	fetch(req, server) {
		const url = new URL(req.url);

		if (url.pathname === "/ws") {
			if (server.upgrade(req)) return undefined;
			return new Response("WebSocket upgrade required", { status: 426 });
		}

		if (url.pathname === "/status") {
			return Response.json(session.getStatus());
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
				session.handlePermissionResponse(msg.id, msg.approved);
				return;
			}

			if (msg.type === "chat") {
				try {
					await session.runQuery(msg.text, (event) => broadcast(event));
				} catch (err) {
					const message = err instanceof Error ? err.message : "Unknown error";
					send(ws, { type: "error", message });
				}
			}
		},
	},
});

console.log(`Hlid server on :${PORT}`);
