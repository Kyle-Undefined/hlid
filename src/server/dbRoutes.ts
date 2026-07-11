import * as db from "../db";
import { clampInt } from "../lib/utils";
import { unlinkPaths } from "./attachments";
import { getLiveSessionsStatus, hasLiveTerminalSession } from "./liveSessions";
import { getWindowMark } from "./proxy";
import { broadcast } from "./runState";
import type { SessionPool } from "./sessionPool";
import type { TerminalSessionPool } from "./terminalSessionPool";

/**
 * Handles all /db/* routes. Returns null if the path doesn't match,
 * allowing the caller to fall through to the next handler.
 */
export async function handleDbRoute(
	url: URL,
	req: Request,
	pool?: SessionPool,
	terminalPool?: TerminalSessionPool,
): Promise<Response | null> {
	const context = { url, req, pool, terminalPool };
	switch (req.method) {
		case "GET":
			return handleGetRoute(context);
		case "PATCH":
			return handlePatchRoute(context);
		case "DELETE":
			return handleDeleteRoute(context);
		case "POST":
			return handlePostRoute(context);
		default:
			return null;
	}
}

interface DbRouteContext {
	url: URL;
	req: Request;
	pool?: SessionPool;
	terminalPool?: TerminalSessionPool;
}

type DbGetHandler = (context: DbRouteContext) => Response | Promise<Response>;

const DB_GET_HANDLERS: Record<string, DbGetHandler> = {
	"/db/sessions": ({ url }) => getSessions(url),
	"/db/recent-sessions": ({ url }) => getRecentSessions(url),
	"/db/session-messages": ({ url }) => getSessionMessages(url),
	"/db/stats": () => getStats(),
	"/db/activity": () => getActivity(),
	"/db/current-session": async () =>
		Response.json({ session_id: await db.getCurrentSessionId() }),
	"/db/session-row": ({ url }) => getSessionRow(url),
	"/db/active-session": () => getActiveSession(),
	"/db/session-context": ({ url }) => getSessionContext(url),
	"/db/session-permissions": ({ url }) =>
		getSessionScopedRows(url, db.getSessionPermissionEvents),
	"/db/session-plan-proposals": ({ url }) =>
		getSessionScopedRows(url, db.getSessionPlanProposals),
	"/db/session-ask-user-questions": ({ url }) =>
		getSessionScopedRows(url, db.getSessionAskUserQuestions),
	"/db/weekly-stats": async () => Response.json(await db.getWeeklyStats()),
	"/db/thirty-day-stats": async () =>
		Response.json(await db.getThirtyDayStats()),
	"/db/usage-windows": () => getUsageWindows(),
	"/db/provider-usage": ({ url }) => getProviderUsage(url),
	"/db/attachments": ({ url }) => getAttachments(url),
	"/db/logs": ({ url }) => getLogs(url),
	"/db/live-sessions": ({ pool, terminalPool }) =>
		Response.json(getLiveSessionsStatus(pool, terminalPool)),
};

function handleGetRoute(
	context: DbRouteContext,
): Promise<Response> | Response | null {
	const handler = DB_GET_HANDLERS[context.url.pathname];
	return handler ? handler(context) : null;
}

async function getSessions(url: URL): Promise<Response> {
	const page = clampInt(url.searchParams.get("page"), 1, 1);
	const size = clampInt(url.searchParams.get("size"), 20, 1, 100);
	const result = await db.getSessionsPaginated(page, size);
	return Response.json(result);
}

async function handlePatchRoute({
	url,
	req,
	pool,
	terminalPool,
}: DbRouteContext): Promise<Response | null> {
	if (url.pathname !== "/db/session") return null;
	const id = url.searchParams.get("id");
	if (!id) return new Response("Missing id", { status: 400 });
	const body = await req.json().catch(() => null);
	if (!body || typeof body.label !== "string")
		return new Response("Missing label", { status: 400 });
	await db.renameSession(id, body.label);
	terminalPool?.setSessionLabel(id, body.label);
	// Live pool entries cache the label in-memory — sync + rebroadcast so
	// the ledger ACTIVE tab reflects the rename without a restart.
	if (pool) {
		for (const entry of pool.getAllEntries()) {
			if (entry.manager.getCurrentSessionId() === id) {
				entry.manager.setSessionLabel(body.label);
			}
		}
	}
	broadcast({
		type: "sessions_status",
		sessions: getLiveSessionsStatus(pool, terminalPool),
	});
	return Response.json({ ok: true });
}

async function getRecentSessions(url: URL): Promise<Response> {
	const limit = clampInt(url.searchParams.get("limit"), 14, 1, 100);
	const rows = await db.getRecentSessions(limit);
	return Response.json(rows);
}

async function getSessionMessages(url: URL): Promise<Response> {
	const sessionId = url.searchParams.get("session_id");
	if (!sessionId) return new Response("Missing session_id", { status: 400 });
	const [messages, toolEvents, attachments] = await Promise.all([
		db.getSessionMessages(sessionId),
		db.getSessionToolEvents(sessionId),
		db.getAttachmentsForSession(sessionId),
	]);
	const toolsBySeq = new Map<number, (typeof toolEvents)[number][]>();
	for (const te of toolEvents) {
		if (te.assistant_seq == null) continue;
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
		attachments: m.role === "user" ? (attachBySeq.get(m.seq) ?? []) : undefined,
	}));
	return Response.json(enriched);
}

async function getStats(): Promise<Response> {
	const [agg, sessions] = await Promise.all([
		db.getAggregatedStats(),
		db.getRecentSessions(10),
	]);
	return Response.json({ agg, sessions });
}

async function getActivity(): Promise<Response> {
	const [topTools, hourOfDay, latency, modelSplit, stopReasonSplit] =
		await Promise.all([
			db.getTopToolCalls(10),
			db.getHourOfDayActivity(),
			db.getLatencyDistribution(),
			db.getModelSplit(),
			db.getStopReasonSplit(),
		]);
	return Response.json({
		topTools,
		hourOfDay,
		latency,
		modelSplit,
		stopReasonSplit,
	});
}

async function getSessionRow(url: URL): Promise<Response> {
	const id = url.searchParams.get("id");
	if (!id) return new Response("Missing id", { status: 400 });
	const row = await db.getSessionById(id);
	return Response.json(row);
}

// Combines current-session + session-row + recent-sessions fallback in one
// round-trip. Used by getActiveSessionRowFn to avoid 3 sequential HTTP calls.
async function getActiveSession(): Promise<Response> {
	const currentId = await db.getCurrentSessionId();
	if (currentId) {
		const row = await db.getSessionById(currentId);
		return Response.json(row); // null when stale ID — do not fall back
	}
	const recent = await db.getRecentSessions(1);
	return Response.json(recent[0] ?? null);
}

async function getSessionContext(url: URL): Promise<Response> {
	const sessionId = url.searchParams.get("session_id");
	if (!sessionId) return new Response("Missing session_id", { status: 400 });
	const [result, actualModel] = await Promise.all([
		db.getSessionLastQueryContext(sessionId),
		db.getSessionActualModel(sessionId),
	]);
	return Response.json({ ...result, actual_model: actualModel });
}

async function getSessionScopedRows<T>(
	url: URL,
	query: (sessionId: string) => Promise<T>,
): Promise<Response> {
	const sessionId = url.searchParams.get("session_id");
	if (!sessionId) return new Response("Missing session_id", { status: 400 });
	return Response.json(await query(sessionId));
}

async function getUsageWindows(): Promise<Response> {
	const windows = await db.getUsageWindows();
	// Overlay in-memory high-water marks. DB writes are async/void so the mark
	// is always more current during a session; DB is the cold-start fallback only.
	const m5 = getWindowMark("claude", "five_hour");
	const mW = getWindowMark("claude", "weekly");
	const mS = getWindowMark("claude", "weekly_sonnet");
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

async function getProviderUsage(url: URL): Promise<Response> {
	const providerIds = (url.searchParams.get("providers") ?? "claude")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const snapshots = await Promise.all(
		providerIds.map((id) => db.getProviderUsage(id)),
	);
	// Overlay in-memory high-water marks so live-session values are always current.
	for (const snapshot of snapshots) {
		for (const win of snapshot.windows) {
			const mark = getWindowMark(snapshot.providerId, win.windowId);
			if (!mark) continue;
			win.utilization = mark.utilization;
			win.remaining = mark.remaining;
			win.resetsAt = mark.resetsAt;
		}
	}
	return Response.json(snapshots);
}

async function getAttachments(url: URL): Promise<Response> {
	const kindParam = url.searchParams.get("kind");
	const kind =
		kindParam === "ephemeral" || kindParam === "vault" ? kindParam : undefined;
	const sessionId = url.searchParams.get("session_id") ?? undefined;
	const search = url.searchParams.get("search") ?? undefined;
	const sinceParam = url.searchParams.get("since");
	const untilParam = url.searchParams.get("until");
	const since = sinceParam !== null ? Number(sinceParam) : undefined;
	const until = untilParam !== null ? Number(untilParam) : undefined;
	const limit = clampInt(url.searchParams.get("limit"), 100, 1, 500);
	const offset = clampInt(url.searchParams.get("offset"), 0, 0);
	const result = await db.listAttachments({
		kind,
		sessionId,
		search,
		since: since !== undefined && !Number.isNaN(since) ? since : undefined,
		until: until !== undefined && !Number.isNaN(until) ? until : undefined,
		limit,
		offset,
	});
	return Response.json(result);
}

async function getLogs(url: URL): Promise<Response> {
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

async function handleDeleteRoute({
	url,
}: DbRouteContext): Promise<Response | null> {
	switch (url.pathname) {
		case "/db/session": {
			const id = url.searchParams.get("id");
			if (!id) return new Response("Missing id", { status: 400 });
			const { ephemeralPaths } = await db.deleteSession(id);
			await unlinkPaths(ephemeralPaths);
			return Response.json({ ok: true });
		}
		case "/db/logs":
			await db.clearLogs();
			return Response.json({ ok: true });
		default:
			return null;
	}
}

async function handlePostRoute(
	context: DbRouteContext,
): Promise<Response | null> {
	switch (context.url.pathname) {
		case "/db/sessions/cleanup":
			return cleanupSessions(context);
		case "/db/live-sessions/stop":
			return stopLiveSession(context);
		case "/db/live-sessions/close":
			return closeLiveSession(context);
		default:
			return null;
	}
}

async function cleanupSessions({
	url,
	req,
}: DbRouteContext): Promise<Response> {
	const body = await req.json().catch(() => null);
	const fromBody = body?.older_than_days;
	const fromQuery = url.searchParams.get("older_than_days");
	const days = clampInt(fromBody != null ? String(fromBody) : fromQuery, 30, 1);
	const { count, ephemeralPaths } = await db.deleteSessionsOlderThan(days);
	await unlinkPaths(ephemeralPaths);
	return Response.json({ deleted: count });
}

async function stopLiveSession({
	req,
	pool,
	terminalPool,
}: DbRouteContext): Promise<Response> {
	const body = await req.json().catch(() => null);
	const id = body?.session_id;
	if (!id) return new Response("Missing session_id", { status: 400 });
	const entry = pool?.get(id);
	if (entry) {
		entry.manager.abort();
	} else if (terminalPool && hasLiveTerminalSession(terminalPool, id)) {
		terminalPool.write(id, "\x03");
	} else {
		return new Response("Session not found", { status: 404 });
	}
	return Response.json({ ok: true });
}

async function closeLiveSession({
	req,
	pool,
	terminalPool,
}: DbRouteContext): Promise<Response> {
	const body = await req.json().catch(() => null);
	const id = body?.session_id;
	if (!id) return new Response("Missing session_id", { status: 400 });
	const entry = pool?.get(id);
	const terminalExists = hasLiveTerminalSession(terminalPool, id);
	if (!entry && !terminalExists)
		return new Response("Session not found", { status: 404 });
	if (entry && pool?.isVaultSession(id)) {
		return new Response("Cannot close vault session", { status: 403 });
	}
	if (entry) pool?.close(id);
	else terminalPool?.close(id);
	return Response.json({ ok: true });
}
