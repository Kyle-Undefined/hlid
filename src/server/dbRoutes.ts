import * as db from "../db";
import type { AttachmentListFilter } from "../db/types";
import { clampInt, uid } from "../lib/utils";
import {
	msUntilNextLocalDay,
	readAnalyticsSnapshot,
} from "./analyticsSnapshots";
import { unlinkPaths } from "./attachments";
import { bumpDataRevision } from "./dataRevision";
import { getLiveSessionsStatus, hasLiveTerminalSession } from "./liveSessions";
import {
	getProviderHistorySyncStatus,
	startProviderHistorySync,
	syncClaudeProviderHistory,
} from "./providerHistorySync";
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
	"/db/sessions/export": async () => Response.json(await db.getAllSessions()),
	"/db/recent-sessions": ({ url }) => getRecentSessions(url),
	"/db/session-messages": ({ url }) => getSessionMessages(url),
	"/db/session-tool-event": ({ url }) => getSessionToolEvent(url),
	"/db/stats": () => getStats(),
	"/db/activity": () => getActivity(),
	"/db/ledger-analytics": ({ url }) => getLedgerAnalytics(url),
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
	"/db/weekly-stats": () => getWeeklyStats(),
	"/db/thirty-day-stats": () => getThirtyDayStats(),
	"/db/usage-windows": () => getUsageWindows(),
	"/db/provider-usage": ({ url }) => getProviderUsage(url),
	"/db/attachments": ({ url }) => getAttachments(url),
	"/db/logs": ({ url }) => getLogs(url),
	"/db/storage": async () => Response.json(await db.getStorageStats()),
	"/db/live-sessions": ({ pool, terminalPool }) =>
		Response.json(getLiveSessionsStatus(pool, terminalPool)),
	"/db/provider-history/import/status": ({ url }) =>
		Response.json(
			getProviderHistorySyncStatus(url.searchParams.get("job_id") ?? undefined),
		),
};

function handleGetRoute(
	context: DbRouteContext,
): Promise<Response> | Response | null {
	const handler = DB_GET_HANDLERS[context.url.pathname];
	return handler ? handler(context) : null;
}

function parseLedgerRange(
	value: string | null,
): db.LedgerStatsRange | undefined {
	return value === "today" ||
		value === "7d" ||
		value === "30d" ||
		value === "90d" ||
		value === "all" ||
		value === "custom"
		? value
		: undefined;
}

function ledgerDateParam(url: URL, name: "from" | "to"): string | undefined {
	const value = url.searchParams.get(name);
	return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

async function getSessions(url: URL): Promise<Response> {
	const page = clampInt(url.searchParams.get("page"), 1, 1);
	const size = clampInt(url.searchParams.get("size"), 20, 1, 100);
	const q = url.searchParams.get("q")?.trim() || undefined;
	const agent = url.searchParams.get("agent")?.trim() || undefined;
	const model = url.searchParams.get("model")?.trim() || undefined;
	const provider = url.searchParams.get("provider")?.trim() || undefined;
	const stop = url.searchParams.get("stop")?.trim() || undefined;
	const range = parseLedgerRange(url.searchParams.get("range"));
	const sortParam = url.searchParams.get("sort");
	const sort =
		sortParam === "cost" || sortParam === "tokens" || sortParam === "recent"
			? sortParam
			: undefined;
	const result = await db.getSessionsPaginated(page, size, {
		search: q,
		agent,
		model,
		provider,
		stop,
		range,
		from: ledgerDateParam(url, "from"),
		to: ledgerDateParam(url, "to"),
		sort,
	});
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
	bumpDataRevision("sessions");
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
	const limitParam = url.searchParams.get("limit");
	const limit = limitParam ? clampInt(limitParam, 201, 1, 5_001) : undefined;
	const beforeSeqParam = url.searchParams.get("before_seq");
	const beforeSeq = beforeSeqParam
		? clampInt(beforeSeqParam, 0, 0, Number.MAX_SAFE_INTEGER)
		: undefined;
	const beforeIdParam = url.searchParams.get("before_id");
	const beforeId =
		beforeSeq !== undefined && beforeIdParam
			? clampInt(beforeIdParam, 0, 0, Number.MAX_SAFE_INTEGER)
			: undefined;
	const minSeqParam = url.searchParams.get("min_seq");
	const requestedMinSeq = minSeqParam
		? clampInt(minSeqParam, 0, 0, Number.MAX_SAFE_INTEGER)
		: undefined;
	const minIdParam = url.searchParams.get("min_id");
	const requestedMinId =
		requestedMinSeq !== undefined && minIdParam
			? clampInt(minIdParam, 0, 0, Number.MAX_SAFE_INTEGER)
			: undefined;
	const pageMessages = await db.getSessionMessages(
		sessionId,
		beforeSeq,
		limit,
		requestedMinSeq,
		beforeId,
		requestedMinId,
	);
	const minSeq = pageMessages[0]?.seq;
	if (minSeq === undefined) return Response.json([]);
	const maxSeq = pageMessages.at(-1)?.seq ?? minSeq;
	const [messages, toolEvents, attachments] = await Promise.all([
		Promise.resolve(pageMessages),
		db.getSessionToolEventSummaries(sessionId, minSeq, undefined, maxSeq),
		db.getAttachmentsForSession(sessionId, minSeq, undefined, maxSeq),
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

async function getSessionToolEvent(url: URL): Promise<Response> {
	const sessionId = url.searchParams.get("session_id")?.trim();
	const toolId = url.searchParams.get("tool_id")?.trim();
	if (!sessionId) return new Response("Missing session_id", { status: 400 });
	if (!toolId) return new Response("Missing tool_id", { status: 400 });
	const detail = await db.getSessionToolEventDetail(sessionId, toolId);
	return detail ? Response.json(detail) : Response.json(null, { status: 404 });
}

async function getStats(): Promise<Response> {
	const snapshot = await readAnalyticsSnapshot(
		"stats",
		"cockpit",
		async () => {
			const [agg, sessions] = await Promise.all([
				db.getAggregatedStats(),
				db.getRecentSessions(10),
			]);
			return { agg, sessions };
		},
		{ maxAgeMs: msUntilNextLocalDay() },
	);
	return Response.json(snapshot);
}

async function getActivity(): Promise<Response> {
	const snapshot = await readAnalyticsSnapshot(
		"activity",
		"ledger",
		async () => {
			const [topTools, hourOfDay, latency, modelSplit, stopReasonSplit] =
				await Promise.all([
					db.getTopToolCalls(10),
					db.getHourOfDayActivity(),
					db.getLatencyDistribution(),
					db.getModelSplit(),
					db.getStopReasonSplit(),
				]);
			return {
				topTools,
				hourOfDay,
				latency,
				modelSplit,
				stopReasonSplit,
			};
		},
	);
	return Response.json(snapshot);
}

async function getLedgerAnalytics(url: URL): Promise<Response> {
	const range = parseLedgerRange(url.searchParams.get("range")) ?? "30d";
	const filter = {
		range,
		agent: url.searchParams.get("agent")?.trim() || undefined,
		provider: url.searchParams.get("provider")?.trim() || undefined,
		model: url.searchParams.get("model")?.trim() || undefined,
		from: ledgerDateParam(url, "from"),
		to: ledgerDateParam(url, "to"),
	};
	const key = JSON.stringify(filter);
	const snapshot = await readAnalyticsSnapshot(
		"activity",
		`ledger:${key}`,
		() => db.getLedgerAnalytics(filter),
		{ maxAgeMs: msUntilNextLocalDay() },
	);
	return Response.json(snapshot);
}

async function getWeeklyStats(): Promise<Response> {
	const snapshot = await readAnalyticsSnapshot(
		"weekly",
		"weekly",
		() => db.getWeeklyStats(),
		{ maxAgeMs: msUntilNextLocalDay() },
	);
	return Response.json(snapshot);
}

async function getThirtyDayStats(): Promise<Response> {
	const snapshot = await readAnalyticsSnapshot(
		"thirtyDay",
		"thirty-day",
		() => db.getThirtyDayStats(),
		{ maxAgeMs: msUntilNextLocalDay() },
	);
	return Response.json(snapshot);
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
	query: (
		sessionId: string,
		minSeq?: number,
		beforeSeq?: number,
		maxSeq?: number,
	) => Promise<T>,
): Promise<Response> {
	const sessionId = url.searchParams.get("session_id");
	if (!sessionId) return new Response("Missing session_id", { status: 400 });
	const minSeqParam = url.searchParams.get("min_seq");
	const minSeq = minSeqParam
		? clampInt(minSeqParam, 0, 0, Number.MAX_SAFE_INTEGER)
		: undefined;
	const beforeSeqParam = url.searchParams.get("before_seq");
	const beforeSeq = beforeSeqParam
		? clampInt(beforeSeqParam, 0, 0, Number.MAX_SAFE_INTEGER)
		: undefined;
	const maxSeqParam = url.searchParams.get("max_seq");
	const maxSeq = maxSeqParam
		? clampInt(maxSeqParam, 0, 0, Number.MAX_SAFE_INTEGER)
		: undefined;
	return Response.json(await query(sessionId, minSeq, beforeSeq, maxSeq));
}

async function getUsageWindows(): Promise<Response> {
	const cached = await readAnalyticsSnapshot(
		"providerUsage",
		"legacy-usage-windows",
		() => db.getUsageWindows(),
		{ maxAgeMs: 15_000 },
	);
	const windows = {
		...cached,
		fiveHour: { ...cached.fiveHour },
		weekly: { ...cached.weekly },
		weeklySonnet: cached.weeklySonnet ? { ...cached.weeklySonnet } : null,
	};
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
	const cached = await readAnalyticsSnapshot(
		"providerUsage",
		providerIds.join(","),
		() => Promise.all(providerIds.map((id) => db.getProviderUsage(id))),
		{ maxAgeMs: 15_000 },
	);
	// Live overlays must not mutate the retained DB snapshot.
	const snapshots = cached.map((snapshot) => ({
		...snapshot,
		windows: snapshot.windows.map((window) => ({ ...window })),
	}));
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

export function parseAttachmentListFilter(url: URL): AttachmentListFilter {
	const kindParam = url.searchParams.get("kind");
	const kind =
		kindParam === "ephemeral" || kindParam === "vault" ? kindParam : undefined;
	const categoryParam = url.searchParams.get("category");
	const category =
		categoryParam === "upload" ||
		categoryParam === "plan" ||
		categoryParam === "report" ||
		categoryParam === "other"
			? categoryParam
			: undefined;
	const retentionParam = url.searchParams.get("retention");
	const retention =
		retentionParam === "session" ||
		retentionParam === "retained" ||
		retentionParam === "linked"
			? retentionParam
			: undefined;
	const sessionId = url.searchParams.get("session_id") ?? undefined;
	const search = url.searchParams.get("search") ?? undefined;
	const typeParam = url.searchParams.get("type");
	const type =
		typeParam === "image" ||
		typeParam === "pdf" ||
		typeParam === "text" ||
		typeParam === "other"
			? typeParam
			: undefined;
	const sortParam = url.searchParams.get("sort");
	const sort =
		sortParam === "size_bytes" || sortParam === "created_at"
			? sortParam
			: undefined;
	const dirParam = url.searchParams.get("dir");
	const dir = dirParam === "asc" || dirParam === "desc" ? dirParam : undefined;
	const sinceParam = url.searchParams.get("since");
	const untilParam = url.searchParams.get("until");
	const since = sinceParam !== null ? Number(sinceParam) : undefined;
	const until = untilParam !== null ? Number(untilParam) : undefined;
	const limit = clampInt(url.searchParams.get("limit"), 100, 1, 500);
	const offset = clampInt(url.searchParams.get("offset"), 0, 0);
	return {
		kind,
		category,
		retention,
		sessionId,
		search,
		type,
		since: since !== undefined && !Number.isNaN(since) ? since : undefined,
		until: until !== undefined && !Number.isNaN(until) ? until : undefined,
		sort,
		dir,
		limit,
		offset,
	};
}

async function getAttachments(url: URL): Promise<Response> {
	const result = await db.listAttachments(parseAttachmentListFilter(url));
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
			bumpDataRevision("stats", "sessions", "relics", "storage");
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
		case "/db/storage/optimize": {
			const result = await db.optimizeStorage();
			bumpDataRevision("storage");
			return Response.json(result);
		}
		case "/db/sessions/cleanup":
			return cleanupSessions(context);
		case "/db/provider-history/claude/import": {
			const result = await syncClaudeProviderHistory();
			return Response.json(result);
		}
		case "/db/provider-history/import": {
			return Response.json(startProviderHistorySync(), { status: 202 });
		}
		case "/db/live-sessions/stop":
			return stopLiveSession(context);
		case "/db/live-sessions/close":
			return closeLiveSession(context);
		case "/db/session/fork":
			return forkSession(context);
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
	if (count > 0) {
		bumpDataRevision("stats", "sessions", "relics", "storage");
	}
	return Response.json({ deleted: count });
}

async function readLiveSessionId(req: Request): Promise<string | Response> {
	const body = await req.json().catch(() => null);
	return (
		body?.session_id ?? new Response("Missing session_id", { status: 400 })
	);
}

async function stopLiveSession({
	req,
	pool,
	terminalPool,
}: DbRouteContext): Promise<Response> {
	const id = await readLiveSessionId(req);
	if (id instanceof Response) return id;
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
	const id = await readLiveSessionId(req);
	if (id instanceof Response) return id;
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

/**
 * Fork a (necessarily idle) session's transcript into a brand-new session
 * via the owning provider's forkSession() capability, then create a new
 * hlid session row pointing at the resulting native id. Whole-session only
 * — no branch-from-message-N support yet.
 */
async function forkSession({
	req,
	pool,
	terminalPool,
}: DbRouteContext): Promise<Response> {
	const body = await req.json().catch(() => null);
	const sourceId = body?.id;
	if (!sourceId || typeof sourceId !== "string") {
		return new Response("Missing id", { status: 400 });
	}

	if (pool?.get(sourceId) || hasLiveTerminalSession(terminalPool, sourceId)) {
		return new Response("Cannot fork a live session — stop it first", {
			status: 409,
		});
	}

	const source = await db.getSessionById(sourceId);
	if (!source) return new Response("Session not found", { status: 404 });

	const providerId = source.provider_id ?? "claude";
	const provider = pool?.getProvider(providerId);
	const nativeId = await db.getSessionProviderSession(sourceId, providerId);
	if (!provider?.forkSession || !nativeId || !source.agent_cwd) {
		return new Response("Forking is not supported for this session", {
			status: 422,
		});
	}

	const { sessionId: newNativeId } = await provider.forkSession({
		sessionId: nativeId,
		cwd: source.agent_cwd,
		historyResumeMode: source.history_resume_mode,
	});
	const newId = uid();
	await db.createForkedSessionRow(sourceId, newId, newNativeId);
	bumpDataRevision("sessions");
	return Response.json({ ok: true, id: newId });
}
