import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import type { ServerWebSocket } from "bun";
import * as db from "../db";
import { isAllowedOrigin } from "../lib/allowedOrigin";
import { clampInt } from "../lib/utils";
import {
	handleUpload,
	removeAttachment,
	serveAttachment,
	unlinkPaths,
} from "./attachments";
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
	else if (msg.type === "mcp_status")
		void db.saveSetting("mcp_status_cache", JSON.stringify(msg.servers));
	const data = JSON.stringify(msg);
	for (const ws of clients) {
		// Permission requests only go to the session owner
		if (msg.type === "permission_request" && ws !== sessionOwnerWs) continue;
		ws.send(data);
	}
}

// Restore cached MCP status from previous run so cockpit shows servers before first query
void db.getSetting("mcp_status_cache").then((cached) => {
	if (!cached) return;
	try {
		session.restoreMcpStatus(JSON.parse(cached) as McpServerStatus[]);
	} catch {}
});

function send(ws: ServerWebSocket<unknown>, msg: ServerMessage): void {
	ws.send(JSON.stringify(msg));
}

type WindowMark = { utilization: number; resetsAt: number | null };
const windowHighMark = new Map<string, WindowMark>();

// Seed from DB so cold-start page loads show usage windows without waiting for an API call
void (async () => {
	const entries: [string, string][] = [
		["rl_5hr", "five_hour"],
		["rl_weekly", "weekly"],
		["rl_weekly_sonnet", "weekly_sonnet"],
	];
	for (const [dbKey, type] of entries) {
		const raw = await db.getSetting(dbKey);
		if (!raw) continue;
		try {
			const parsed = JSON.parse(raw) as {
				utilization: number | null;
				resetsAt: number | null;
			};
			if (parsed.utilization == null) continue;
			if (parsed.resetsAt != null && parsed.resetsAt < Date.now() / 1000)
				continue;
			windowHighMark.set(type, {
				utilization: parsed.utilization,
				resetsAt: parsed.resetsAt ?? null,
			});
		} catch {}
	}
})();

function captureUtilizationHeaders(headers: Headers): void {
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

	const windows = [
		[
			"anthropic-ratelimit-unified-5h-utilization",
			"anthropic-ratelimit-unified-5h-reset",
			"rl_5hr",
			"five_hour",
		],
		[
			"anthropic-ratelimit-unified-7d-utilization",
			"anthropic-ratelimit-unified-7d-reset",
			"rl_weekly",
			"weekly",
		],
		[
			"anthropic-ratelimit-unified-7d_sonnet-utilization",
			"anthropic-ratelimit-unified-7d_sonnet-reset",
			"rl_weekly_sonnet",
			"weekly_sonnet",
		],
	] as const;
	for (const [utilHeader, resetHeader, dbKey, rateLimitType] of windows) {
		const h = headers.get(utilHeader);
		if (h === null) continue;
		const raw = parseFloat(h);
		if (Number.isFinite(raw))
			maybeUpdate(
				dbKey,
				rateLimitType,
				raw > 1 ? raw / 100 : raw,
				toUnix(headers.get(resetHeader)),
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
		// Long SSE streams from Anthropic can idle past 10s during tool calls.
		// 255s is Bun.serve's max — prevents premature socket close.
		idleTimeout: 255,
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
	void db.appendLog(
		"warn",
		"proxy",
		"failed to start, utilization tracking disabled",
		{ error: String(e) },
	);
}

const tlsConfig =
	process.env.HLID_TLS &&
	config.server.tls_cert_path &&
	config.server.tls_key_path
		? {
				tls: {
					cert: Bun.file(config.server.tls_cert_path),
					key: Bun.file(config.server.tls_key_path),
				},
			}
		: {};

Bun.serve({
	port: PORT,
	hostname: config.server.host,
	...tlsConfig,

	async fetch(req, server) {
		const url = new URL(req.url);

		if (!isAllowedOrigin(server.requestIP(req)?.address)) {
			return new Response("Forbidden", { status: 403 });
		}

		if (url.pathname === "/ws") {
			if (server.upgrade(req)) return undefined;
			return new Response("WebSocket upgrade required", { status: 426 });
		}

		if (url.pathname === "/status") {
			return Response.json(session.getStatus());
		}

		if (url.pathname === "/db/sessions" && req.method === "GET") {
			const page = clampInt(url.searchParams.get("page"), 1, 1);
			const size = clampInt(url.searchParams.get("size"), 20, 1, 100);
			const result = await db.getSessionsPaginated(page, size);
			return Response.json(result);
		}

		if (url.pathname === "/db/session" && req.method === "DELETE") {
			const id = url.searchParams.get("id");
			if (!id) return new Response("Missing id", { status: 400 });
			const { ephemeralPaths } = await db.deleteSession(id);
			await unlinkPaths(ephemeralPaths);
			return Response.json({ ok: true });
		}

		if (url.pathname === "/db/sessions/cleanup" && req.method === "POST") {
			const days = clampInt(url.searchParams.get("older_than_days"), 30, 1);
			const { count, ephemeralPaths } = await db.deleteSessionsOlderThan(days);
			await unlinkPaths(ephemeralPaths);
			return Response.json({ deleted: count });
		}

		if (url.pathname === "/db/recent-sessions") {
			const limit = clampInt(url.searchParams.get("limit"), 14, 1);
			const rows = await db.getRecentSessions(limit);
			return Response.json(rows);
		}

		if (url.pathname === "/db/session-messages") {
			const sessionId = url.searchParams.get("session_id");
			if (!sessionId)
				return new Response("Missing session_id", { status: 400 });
			const [messages, toolEvents, attachments] = await Promise.all([
				db.getSessionMessages(sessionId),
				db.getSessionToolEvents(sessionId),
				db.getAttachmentsForSession(sessionId),
			]);
			const toolsBySeq = new Map<number, (typeof toolEvents)[number][]>();
			for (const te of toolEvents) {
				const list = toolsBySeq.get(te.assistant_seq) ?? [];
				list.push(te);
				toolsBySeq.set(te.assistant_seq, list);
			}
			const attachBySeq = new Map<number, (typeof attachments)[number][]>();
			for (const a of attachments) {
				if (a.message_seq == null) continue;
				const list = attachBySeq.get(a.message_seq) ?? [];
				list.push(a);
				attachBySeq.set(a.message_seq, list);
			}
			const enriched = messages.map((m) => ({
				...m,
				toolEvents:
					m.role === "assistant" ? (toolsBySeq.get(m.seq) ?? []) : undefined,
				attachments:
					m.role === "user" ? (attachBySeq.get(m.seq) ?? []) : undefined,
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

		if (url.pathname === "/db/thirty-day-stats") {
			const stats = await db.getThirtyDayStats();
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

		if (url.pathname === "/mcp-status" && req.method === "GET") {
			return Response.json(session.getLastMcpStatus() ?? []);
		}

		if (url.pathname === "/db/logs" && req.method === "GET") {
			const page = clampInt(url.searchParams.get("page"), 1, 1);
			const size = clampInt(url.searchParams.get("size"), 50, 1, 200);
			const levelParam = url.searchParams.get("level") ?? "all";
			const level =
				levelParam === "error" || levelParam === "warn" || levelParam === "info"
					? (levelParam as import("../db").LogLevel)
					: undefined;
			const result = await db.getLogs(page, size, level);
			return Response.json(result);
		}

		if (url.pathname === "/db/logs" && req.method === "DELETE") {
			await db.clearLogs();
			return Response.json({ ok: true });
		}

		if (url.pathname === "/api/attachments/upload" && req.method === "POST") {
			return handleUpload(req, config, (id, kind) =>
				broadcast({ type: "attachment_created", id, kind }),
			);
		}

		const rawMatch = url.pathname.match(
			/^\/api\/attachments\/([a-zA-Z0-9-]+)\/raw$/,
		);
		if (rawMatch && req.method === "GET") {
			return serveAttachment(rawMatch[1]);
		}

		const idMatch = url.pathname.match(/^\/api\/attachments\/([a-zA-Z0-9-]+)$/);
		if (idMatch && req.method === "DELETE") {
			const confirmVault = url.searchParams.get("confirm_vault") === "1";
			return removeAttachment(idMatch[1], { confirmVault });
		}

		if (url.pathname === "/db/attachments" && req.method === "GET") {
			const kindParam = url.searchParams.get("kind");
			const kind =
				kindParam === "ephemeral" || kindParam === "vault"
					? kindParam
					: undefined;
			const sessionId = url.searchParams.get("session_id") ?? undefined;
			const search = url.searchParams.get("search") ?? undefined;
			const sinceParam = url.searchParams.get("since");
			const untilParam = url.searchParams.get("until");
			const since = sinceParam ? Number(sinceParam) : undefined;
			const until = untilParam ? Number(untilParam) : undefined;
			const limit = clampInt(url.searchParams.get("limit"), 100, 1, 500);
			const offset = clampInt(url.searchParams.get("offset"), 0, 0);
			const result = await db.listAttachments({
				kind,
				sessionId,
				search,
				since: since && !Number.isNaN(since) ? since : undefined,
				until: until && !Number.isNaN(until) ? until : undefined,
				limit,
				offset,
			});
			return Response.json(result);
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
			// Send cached MCP status so clients see server list immediately on connect
			const cachedMcp = session.getLastMcpStatus();
			if (cachedMcp) {
				send(ws, {
					type: "mcp_status",
					servers: cachedMcp.map((s) => ({
						name: s.name,
						status: s.status,
						scope: s.scope,
						error: s.error,
					})),
				});
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

			if (msg.type === "probe_mcp") {
				void session.probeMcpStatus(broadcast);
				return;
			}

			if (msg.type === "sync_mcp_list") {
				const cfg = loadConfig();
				if (!cfg.vault.path) return;
				let vaultNames = new Set<string>();
				try {
					vaultNames = new Set(
						Object.keys(
							(
								JSON.parse(
									readFileSync(join(cfg.vault.path, ".mcp.json"), "utf8"),
								) as { mcpServers?: Record<string, unknown> }
							).mcpServers ?? {},
						),
					);
				} catch {}
				let disabled: string[] = [];
				try {
					disabled =
						(
							JSON.parse(
								readFileSync(
									join(cfg.vault.path, ".claude", "settings.local.json"),
									"utf8",
								),
							) as { disabledMcpjsonServers?: string[] }
						).disabledMcpjsonServers ?? [];
				} catch {}
				const cachedList = session.getLastMcpStatus() ?? [];
				const cachedMap = new Map(cachedList.map((s) => [s.name, s]));
				// Preserve cloud/global entries from cache unchanged
				const preserved = cachedList
					.filter((s) => s.scope !== "project")
					.map((s) => ({
						name: s.name,
						status: s.status,
						scope: s.scope,
						error: s.error,
					}));
				// Vault entries: current .mcp.json + cached status
				const vault = [...vaultNames].map((name) => {
					if (disabled.includes(name))
						return { name, status: "disabled" as const };
					const c = cachedMap.get(name);
					return {
						name,
						status: c?.status ?? ("pending" as const),
						scope: "project" as const,
						error: c?.error,
					};
				});
				broadcast({ type: "mcp_status", servers: [...preserved, ...vault] });
				return;
			}

			if (msg.type === "permission_response") {
				// Only the client that started the session can respond to permissions
				if (ws !== sessionOwnerWs) return;
				session.handlePermissionResponse(
					msg.id,
					msg.approved,
					msg.sessionAllow,
				);
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
						msg.attachments,
						msg.agent_cwd,
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

console.log(`Hlid server on :${PORT}${process.env.HLID_TLS ? " (TLS)" : ""}`);
