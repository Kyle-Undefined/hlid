import * as db from "../db";
import { clampInt } from "../lib/utils";
import { unlinkPaths } from "./attachments";
import { getWindowMark } from "./proxy";

/**
 * Handles all /db/* routes. Returns null if the path doesn't match,
 * allowing the caller to fall through to the next handler.
 */
export async function handleDbRoute(
	url: URL,
	req: Request,
): Promise<Response | null> {
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

	if (url.pathname === "/db/recent-sessions" && req.method === "GET") {
		const limit = clampInt(url.searchParams.get("limit"), 14, 1, 100);
		const rows = await db.getRecentSessions(limit);
		return Response.json(rows);
	}

	if (url.pathname === "/db/session-messages" && req.method === "GET") {
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
			attachments:
				m.role === "user" ? (attachBySeq.get(m.seq) ?? []) : undefined,
		}));
		return Response.json(enriched);
	}

	if (url.pathname === "/db/stats" && req.method === "GET") {
		const [agg, sessions] = await Promise.all([
			db.getAggregatedStats(),
			db.getRecentSessions(10),
		]);
		return Response.json({ agg, sessions });
	}

	if (url.pathname === "/db/current-session" && req.method === "GET") {
		const sessionId = await db.getCurrentSessionId();
		return Response.json({ session_id: sessionId });
	}

	if (url.pathname === "/db/session-context" && req.method === "GET") {
		const sessionId = url.searchParams.get("session_id");
		if (!sessionId) return new Response("Missing session_id", { status: 400 });
		const [result, actualModel] = await Promise.all([
			db.getSessionLastQueryContext(sessionId),
			db.getSessionActualModel(sessionId),
		]);
		return Response.json({ ...result, actual_model: actualModel });
	}

	if (url.pathname === "/db/session-permissions" && req.method === "GET") {
		const sessionId = url.searchParams.get("session_id");
		if (!sessionId) return new Response("Missing session_id", { status: 400 });
		const events = await db.getSessionPermissionEvents(sessionId);
		return Response.json(events);
	}

	if (url.pathname === "/db/session-plan-proposals" && req.method === "GET") {
		const sessionId = url.searchParams.get("session_id");
		if (!sessionId) return new Response("Missing session_id", { status: 400 });
		const rows = await db.getSessionPlanProposals(sessionId);
		return Response.json(rows);
	}

	if (url.pathname === "/db/weekly-stats" && req.method === "GET") {
		const stats = await db.getWeeklyStats();
		return Response.json(stats);
	}

	if (url.pathname === "/db/thirty-day-stats" && req.method === "GET") {
		const stats = await db.getThirtyDayStats();
		return Response.json(stats);
	}

	if (url.pathname === "/db/usage-windows" && req.method === "GET") {
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

	if (url.pathname === "/db/provider-usage" && req.method === "GET") {
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

	return null;
}
