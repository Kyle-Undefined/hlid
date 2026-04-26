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

type WindowMark = { utilization: number; resetsAt: number | null };
const windowHighMark = new Map<string, WindowMark>();

function captureUtilizationHeaders(headers: Headers): void {
	const h5 = headers.get("anthropic-ratelimit-unified-5h-utilization");
	const h7 = headers.get("anthropic-ratelimit-unified-7d-utilization");
	const hSonnet = headers.get(
		"anthropic-ratelimit-unified-7d_sonnet-utilization",
	);
	const r5 = headers.get("anthropic-ratelimit-unified-5h-reset");
	const r7 = headers.get("anthropic-ratelimit-unified-7d-reset");
	const rSonnet = headers.get("anthropic-ratelimit-unified-7d_sonnet-reset");

	function toUnix(s: string | null): number | null {
		if (!s) return null;
		const t = parseInt(s, 10);
		return Number.isFinite(t) ? t : null;
	}

	function maybeUpdate(
		dbKey: string,
		rateLimitType: string,
		utilization: number,
		resetsAt: number | null,
	): void {
		const current = windowHighMark.get(rateLimitType);
		const newWindow =
			!current || (resetsAt !== null && current.resetsAt !== resetsAt);
		if (!newWindow && utilization <= (current?.utilization ?? 0)) return;
		windowHighMark.set(rateLimitType, { utilization, resetsAt });
		void db.saveSetting(
			dbKey,
			JSON.stringify({ utilization, resetsAt, rateLimitType }),
		);
		broadcast({
			type: "rate_limit",
			status: "allowed",
			rateLimitType,
			utilization,
			resetsAt: resetsAt ?? undefined,
		});
	}

	if (h5 !== null) {
		const raw = parseFloat(h5);
		if (Number.isFinite(raw))
			maybeUpdate("rl_5hr", "five_hour", raw > 1 ? raw / 100 : raw, toUnix(r5));
	}
	if (h7 !== null) {
		const raw = parseFloat(h7);
		if (Number.isFinite(raw))
			maybeUpdate("rl_weekly", "weekly", raw > 1 ? raw / 100 : raw, toUnix(r7));
	}
	if (hSonnet !== null) {
		const raw = parseFloat(hSonnet);
		if (Number.isFinite(raw))
			maybeUpdate(
				"rl_weekly_sonnet",
				"weekly_sonnet",
				raw > 1 ? raw / 100 : raw,
				toUnix(rSonnet),
			);
	}
}

const PORT = config.server.port + 1; // 3001 when TanStack Start is on 3000
const PROXY_PORT = config.server.port + 2; // 3002

// Transparent proxy — captures unified utilization headers from every API response.
// Set ANTHROPIC_BASE_URL before any subprocess is spawned so claude CLI routes through it.
const upstreamBase = (
	process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"
).replace(/\/$/, "");

try {
	Bun.serve({
		hostname: "127.0.0.1",
		port: PROXY_PORT,
		async fetch(req) {
			const reqUrl = new URL(req.url);
			const targetUrl = `${upstreamBase}${reqUrl.pathname}${reqUrl.search}`;
			const forwardHeaders = new Headers(req.headers);
			forwardHeaders.delete("host");
			let upstream: Response;
			try {
				upstream = await fetch(targetUrl, {
					method: req.method,
					headers: forwardHeaders,
					body:
						req.method !== "GET" && req.method !== "HEAD"
							? req.body
							: undefined,
				});
			} catch {
				return new Response("upstream error", { status: 502 });
			}
			captureUtilizationHeaders(upstream.headers);
			const responseHeaders = new Headers(upstream.headers);
			responseHeaders.delete("content-encoding");
			responseHeaders.delete("content-length");
			responseHeaders.delete("transfer-encoding");
			return new Response(upstream.body, {
				status: upstream.status,
				headers: responseHeaders,
			});
		},
	});
	process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${PROXY_PORT}`;
	console.log(`Anthropic proxy on :${PROXY_PORT} → ${upstreamBase}`);
} catch (e) {
	console.warn("[proxy] failed to start, utilization tracking disabled:", e);
}

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
			// Overlay in-memory high-water marks — DB writes are async/void so the mark
			// is always more current during a session; DB is the cold-start fallback only.
			const m5 = windowHighMark.get("five_hour");
			const mW = windowHighMark.get("weekly");
			const mS = windowHighMark.get("weekly_sonnet");
			if (m5)
				windows.fiveHour = {
					...windows.fiveHour,
					utilization: m5.utilization,
					resetsAt: m5.resetsAt,
				};
			if (mW)
				windows.weekly = {
					...windows.weekly,
					utilization: mW.utilization,
					resetsAt: mW.resetsAt,
				};
			if (mS)
				windows.weeklySonnet = {
					utilization: mS.utilization,
					resetsAt: mS.resetsAt,
				};
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
