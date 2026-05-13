import {
	createFileRoute,
	useNavigate,
	useRouterState,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ThirtyDayGraph } from "#/components/cockpit/ThirtyDayGraph";
import { Row, StatCell, UtilBar } from "#/components/ledger/LedgerStats";
import { SessionsLedger } from "#/components/ledger/SessionsLedger";
import { statusDotClass } from "#/components/nav/SystemStatusDot";
import {
	ContextWindowSection,
	ProviderUsageStrip,
} from "#/components/UsageWindowsPanel";
import type {
	AggStats,
	AggWindow,
	ProviderUsageSnapshot,
	SessionRow,
	ThirtyDayStats,
} from "#/db";
import { useWs } from "#/hooks/useWs";
import { useWsLiveStats } from "#/hooks/useWsSelectors";
import type { LiveStats } from "#/hooks/wsStore";
import { dbFetch, dbJson } from "#/lib/dbClient";
import { fmt, fmtModel } from "#/lib/formatters";
import {
	EMPTY_AGG,
	getActiveSessionRowFn,
	getProvidersFn,
	getProviderUsagesFn,
	getThirtyDayStatsFn,
} from "#/lib/serverFns";
import type { RateLimitMessage, ServerMessage } from "#/server/protocol";

// ─── search param helper (exported for tests) ────────────────────────────────

export function parseLedgerSearch(search: Record<string, unknown>): {
	tab: "stats" | "sessions";
	page: number;
} {
	const tab = search.tab === "stats" ? "stats" : "sessions";
	const page =
		typeof search.page === "number" ? Math.max(1, Math.floor(search.page)) : 1;
	return { tab, page };
}

// ─── optimistic-state filter helpers (exported for tests) ────────────────────

/**
 * Retain only IDs that are still present in the server response.
 * - ID still in `freshIds` → delete not yet confirmed, keep hiding it
 * - ID gone from `freshIds` → server processed the delete, safe to drop
 * Returns `prev` unchanged (same reference) when nothing was evicted.
 */
export function filterOptimisticIds(
	prev: Set<string>,
	freshIds: Set<string>,
): Set<string> {
	if (prev.size === 0) return prev;
	const next = new Set([...prev].filter((id) => freshIds.has(id)));
	return next.size === prev.size ? prev : next;
}

/**
 * Retain only label overrides for IDs still present in the server response.
 * Returns `prev` unchanged (same reference) when nothing was evicted.
 */
export function filterOptimisticLabels(
	prev: Map<string, string>,
	freshIds: Set<string>,
): Map<string, string> {
	if (prev.size === 0) return prev;
	const next = new Map([...prev].filter(([id]) => freshIds.has(id)));
	return next.size === prev.size ? prev : next;
}

/**
 * Compute cache hit rate as a percentage string (one decimal).
 * Returns "0" when total input is zero to avoid division by zero.
 */
export function cacheHitPct(
	input: number,
	cacheRead: number,
	cacheCreate: number,
): string {
	const total = input + cacheRead + cacheCreate;
	return total > 0 ? ((cacheRead / total) * 100).toFixed(1) : "0";
}

// ─── server fns ──────────────────────────────────────────────────────────────

const getStatsDataFn = createServerFn({ method: "GET" }).handler(async () => {
	const data = await dbJson<{ agg: AggStats } | null>("/db/stats", null);
	return { agg: data?.agg ?? EMPTY_AGG };
});

const getSessionsPageFn = createServerFn({ method: "POST" })
	.inputValidator((data: { page: number; size: number }) => data)
	.handler(({ data }) =>
		dbJson<{ sessions: SessionRow[]; total: number }>(
			`/db/sessions?page=${data.page}&size=${data.size}`,
			{ sessions: [], total: 0 },
		),
	);

const deleteSessionFn = createServerFn({ method: "POST" })
	.inputValidator((data: { id: string }) => data)
	.handler(async ({ data }) => {
		const res = await dbFetch(`/db/session?id=${data.id}`, {
			method: "DELETE",
		});
		return { ok: res.ok };
	});

const renameSessionFn = createServerFn({ method: "POST" })
	.inputValidator((data: { id: string; label: string }) => data)
	.handler(async ({ data }) => {
		const res = await dbFetch(`/db/session?id=${data.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ label: data.label }),
		});
		return { ok: res.ok };
	});

const cleanupSessionsFn = createServerFn({ method: "POST" })
	.inputValidator((data: { days: number }) => data)
	.handler(async ({ data }) => {
		const res = await dbFetch(
			`/db/sessions/cleanup?older_than_days=${data.days}`,
			{ method: "POST" },
		);
		if (!res.ok) return { deleted: 0 };
		return res.json() as Promise<{ deleted: number }>;
	});

// ─── route ───────────────────────────────────────────────────────────────────

const PAGE_SIZE = 20;

export const Route = createFileRoute("/ledger")({
	validateSearch: parseLedgerSearch,
	loaderDeps: ({ search: { page } }) => ({ page }),
	loader: async ({ deps: { page } }) => {
		const [statsData, providers, thirtyDayStats, activeSession] =
			await Promise.all([
				getStatsDataFn(),
				getProvidersFn(),
				getThirtyDayStatsFn(),
				getActiveSessionRowFn(),
			]);

		const availableIds = providers.filter((p) => p.available).map((p) => p.id);
		const providerIds = availableIds.length > 0 ? availableIds : ["claude"];

		const [initialSessions, providerUsages] = await Promise.all([
			getSessionsPageFn({ data: { page, size: PAGE_SIZE } }),
			getProviderUsagesFn({ data: providerIds }),
		]);

		return {
			statsData,
			initialSessions,
			page,
			thirtyDayStats,
			providerUsages,
			providerIds,
			activeSession,
		};
	},
	component: StatsPage,
});

// ─── page ─────────────────────────────────────────────────────────────────────

function StatsPage() {
	const {
		statsData,
		initialSessions,
		page,
		thirtyDayStats,
		providerUsages,
		providerIds,
		activeSession,
	} = Route.useLoaderData();
	const { tab } = Route.useSearch();
	const navigate = useNavigate();
	const isRouterLoading = useRouterState({
		select: (s) => s.status === "pending",
	});
	const stats = useWsLiveStats();
	const [rateLimit, setRateLimit] = useState<RateLimitMessage | null>(null);

	const [activeSessionData, setActiveSessionData] = useState(activeSession);

	const [sessionPage, setSessionPage] = useState(initialSessions);
	// Mutate ref during render so it's always current before any event handler fires.
	// useEffect would lag by one render cycle, causing refreshSessions to fetch the
	// wrong page if a `done` event arrives between render and effect commit.
	const pageRef = useRef(page);
	pageRef.current = page;

	// Monotonic counter: whichever fetch (loader sync or WS-triggered refresh)
	// resolves last wins. Earlier results are silently discarded.
	const fetchVersionRef = useRef(0);

	// Sync when loader data changes (page navigation).
	useEffect(() => {
		const v = ++fetchVersionRef.current;
		// Guard: if refreshSessions already resolved with a newer version, discard
		// the loader snapshot so we don't stomp fresher WS-triggered data.
		setSessionPage((cur) =>
			fetchVersionRef.current === v ? initialSessions : cur,
		);
	}, [initialSessions]);

	const refreshSessions = useCallback(async () => {
		const v = ++fetchVersionRef.current;
		const fresh = await getSessionsPageFn({
			data: { page: pageRef.current, size: PAGE_SIZE },
		});
		// Discard if a newer fetch (loader sync or another WS done) already landed.
		if (fetchVersionRef.current !== v) return;
		setSessionPage(fresh);
		// Only evict optimistic state for entries confirmed gone by the server.
		// Blanket-clearing would re-show a session the user just deleted if a
		// background `done` event fires before the delete RPC resolves.
		const freshIds = new Set(fresh.sessions.map((s) => s.id));
		setDeletedIds((prev) => filterOptimisticIds(prev, freshIds));
		setRenamedLabels((prev) => filterOptimisticLabels(prev, freshIds));
	}, []);

	const { wsStatus, model, actualModel, sessionState, hasPendingPermissions } =
		useWs(
			useCallback(
				(msg: ServerMessage) => {
					if (msg.type === "rate_limit") setRateLimit(msg);
					if (msg.type === "done") {
						void refreshSessions();
						void getActiveSessionRowFn().then(setActiveSessionData);
					}
				},
				[refreshSessions],
			),
		);

	// Refresh active session on mount — loader data may be stale from router cache
	// when user navigates back to /ledger after a session completed elsewhere.
	useEffect(() => {
		let active = true;
		void getActiveSessionRowFn().then((s) => {
			if (active) setActiveSessionData(s);
		});
		return () => {
			active = false;
		};
	}, []);

	const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());
	const [renamedLabels, setRenamedLabels] = useState<Map<string, string>>(
		new Map(),
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on page nav
	useEffect(() => {
		setDeletedIds(new Set());
		setRenamedLabels(new Map());
	}, [page]);

	const sessionsData = useMemo(
		() => ({
			sessions: sessionPage.sessions
				.filter((s) => !deletedIds.has(s.id))
				.map((s) =>
					renamedLabels.has(s.id)
						? { ...s, label: renamedLabels.get(s.id) as string }
						: s,
				),
			total: sessionPage.total - deletedIds.size,
		}),
		[sessionPage, deletedIds, renamedLabels],
	);
	const totalPages = Math.ceil(sessionsData.total / PAGE_SIZE);

	function onPageChange(p: number) {
		navigate({ to: "/ledger", search: { tab: "sessions", page: p } });
	}

	async function handleDeleteSession(id: string) {
		const wasLastOnPage = sessionsData.sessions.length <= 1;
		setDeletedIds((prev) => new Set(prev).add(id));
		const result = await deleteSessionFn({ data: { id } });
		if (!result.ok) {
			setDeletedIds((prev) => {
				const next = new Set(prev);
				next.delete(id);
				return next;
			});
		} else if (wasLastOnPage && page > 1) {
			navigate({ to: "/ledger", search: { tab: "sessions", page: page - 1 } });
		}
	}

	async function handleRenameSession(id: string, label: string) {
		setRenamedLabels((prev) => new Map(prev).set(id, label));
		const result = await renameSessionFn({ data: { id, label } });
		if (!result.ok) {
			setRenamedLabels((prev) => {
				const next = new Map(prev);
				next.delete(id);
				return next;
			});
		}
	}

	async function handleCleanup(days: number) {
		await cleanupSessionsFn({ data: { days } });
		navigate({ to: "/ledger", search: { tab: "sessions", page: 1 } });
	}

	const { agg } = statsData;

	function switchTab(next: "stats" | "sessions") {
		if (next === "sessions") {
			navigate({ to: "/ledger", search: { tab: next, page: 1 } });
		} else {
			// stats tab has no pagination — preserve existing page value in URL
			navigate({ to: "/ledger", search: { tab: next, page } });
		}
	}

	return (
		<div className="flex flex-col h-full">
			{/* Tab bar */}
			<div className="flex flex-wrap border-b border-border shrink-0">
				{(["sessions", "stats"] as const).map((t) => (
					<button
						key={t}
						type="button"
						onClick={() => switchTab(t)}
						aria-pressed={tab === t}
						className={`px-5 py-2.5 text-[10px] tracking-widest uppercase transition-colors border-b-2 -mb-px ${
							tab === t
								? "border-primary text-primary"
								: "border-transparent text-muted-foreground hover:text-foreground"
						}`}
					>
						{t}
					</button>
				))}
			</div>

			<div className="flex-1 overflow-auto">
				{/* Active session callout strip */}
				<div className="flex items-center gap-2.5 px-4 py-2 border-b border-border">
					{activeSessionData ? (
						<>
							<span
								className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${statusDotClass(wsStatus, sessionState, hasPendingPermissions)}`}
							/>
							<span className="text-[9px] tracking-widest uppercase text-muted-foreground">
								Active Session
							</span>
							{activeSessionData.label && (
								<span className="text-[9px] tracking-widest uppercase text-foreground/60 truncate">
									· {activeSessionData.label}
								</span>
							)}
							{sessionState === "running" && (
								<span className="ml-auto text-[9px] tracking-widest uppercase text-primary/70">
									Running
								</span>
							)}
						</>
					) : (
						<>
							<span
								className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${statusDotClass(wsStatus, sessionState, hasPendingPermissions)}`}
							/>
							<span className="text-[9px] tracking-widest uppercase text-muted-foreground/40">
								No Active Session
							</span>
						</>
					)}
				</div>

				{/* Active session stat grid — scrolls with content */}
				<div className="grid grid-cols-2 sm:grid-cols-4 border-b border-border">
					<div className="border-r border-b sm:border-b-0 border-border">
						<StatCell
							label="COST"
							value={
								activeSessionData
									? `$${activeSessionData.total_cost.toFixed(4)}`
									: "--"
							}
							sub={
								activeSessionData && activeSessionData.query_count > 0
									? `$${(activeSessionData.total_cost / activeSessionData.query_count).toFixed(4)}/query`
									: undefined
							}
							dim={!activeSessionData}
						/>
					</div>
					<div className="border-b sm:border-b-0 sm:border-r border-border">
						<StatCell
							label="QUERIES"
							value={
								activeSessionData ? String(activeSessionData.query_count) : "--"
							}
							sub={
								activeSessionData && activeSessionData.total_turns > 0
									? `${activeSessionData.total_turns} turns`
									: undefined
							}
							dim={!activeSessionData}
						/>
					</div>
					<div className="border-r border-border">
						<StatCell
							label="TOKENS"
							value={
								stats.queries > 0
									? fmt(stats.input_tokens + stats.output_tokens)
									: activeSessionData
										? fmt(
												activeSessionData.total_input_tokens +
													activeSessionData.total_output_tokens,
											)
										: "--"
							}
							sub={
								stats.cache_read_tokens + stats.cache_creation_tokens > 0
									? `${fmt(stats.cache_read_tokens + stats.cache_creation_tokens)} cached`
									: activeSessionData &&
											activeSessionData.total_cache_read_tokens +
												activeSessionData.total_cache_creation_tokens >
												0
										? `${fmt(activeSessionData.total_cache_read_tokens + activeSessionData.total_cache_creation_tokens)} cached`
										: undefined
							}
							dim={stats.queries === 0 && !activeSessionData}
						/>
					</div>
					<div>
						<StatCell
							label="MODEL"
							value={
								(actualModel ?? model)
									? fmtModel((actualModel ?? model) as string)
									: activeSessionData?.model
										? fmtModel(activeSessionData.model)
										: "--"
							}
							dim={!actualModel && !model && !activeSessionData?.model}
						/>
					</div>
				</div>

				{tab === "stats" ? (
					<StatsTab
						agg={agg}
						stats={stats}
						rateLimit={rateLimit}
						providerUsages={providerUsages}
						providerIds={providerIds}
						thirtyDayStats={thirtyDayStats}
						activeSession={activeSessionData}
					/>
				) : (
					<div className="p-5">
						<SessionsLedger
							data={sessionsData}
							page={page}
							totalPages={totalPages}
							loading={isRouterLoading}
							onPageChange={onPageChange}
							onDelete={handleDeleteSession}
							onRename={handleRenameSession}
							onNavigate={(id) =>
								navigate({
									to: "/raven",
									search: { session: id, agent: undefined },
								})
							}
							onCleanup={handleCleanup}
						/>
					</div>
				)}
			</div>
		</div>
	);
}

// ─── Stats tab content ────────────────────────────────────────────────────────

/** Compact time-window breakdown card (TODAY / THIS MONTH). */
function WindowCard({ title, w }: { title: string; w: AggWindow }) {
	const hitPct = cacheHitPct(
		w.input_tokens,
		w.cache_read_tokens,
		w.cache_creation_tokens,
	);
	return (
		<div className="border border-border bg-card">
			<div className="px-4 py-3 border-b border-border">
				<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
					{title}
				</div>
			</div>
			<Row label="Cost" value={`$${w.cost.toFixed(4)}`} />
			<Row label="Queries" value={String(w.queries)} />
			<Row label="Turns" value={String(w.turns)} />
			<Row label="Input" value={fmt(w.input_tokens)} />
			<Row label="Output" value={fmt(w.output_tokens)} />
			<Row label="Cache read" value={fmt(w.cache_read_tokens)} />
			<Row label="Cache creation" value={fmt(w.cache_creation_tokens)} />
			<Row label="Cache hit rate" value={`${hitPct}%`} />
			<Row label="Total tokens" value={fmt(w.input_tokens + w.output_tokens)} />
		</div>
	);
}

function StatsTab({
	agg,
	stats,
	rateLimit,
	providerUsages,
	providerIds,
	thirtyDayStats,
	activeSession,
}: {
	agg: AggStats;
	stats: LiveStats;
	rateLimit: RateLimitMessage | null;
	providerUsages: ProviderUsageSnapshot[];
	providerIds: string[];
	thirtyDayStats: ThirtyDayStats;
	activeSession: SessionRow | null;
}) {
	const idle = stats.queries === 0;

	// Live session derived
	const liveCacheHitPct = cacheHitPct(
		stats.input_tokens,
		stats.cache_read_tokens,
		stats.cache_creation_tokens,
	);

	// All-time derived metrics
	const allTimeTotal =
		agg.allTime.input_tokens +
		agg.allTime.output_tokens +
		agg.allTime.cache_read_tokens +
		agg.allTime.cache_creation_tokens;
	const allTimeCacheHitPct = cacheHitPct(
		agg.allTime.input_tokens,
		agg.allTime.cache_read_tokens,
		agg.allTime.cache_creation_tokens,
	);
	const avgCostPerQuery =
		agg.allTime.queries > 0
			? `$${(agg.allTime.cost / agg.allTime.queries).toFixed(4)}`
			: "--";
	const avgTurnsPerQuery =
		agg.allTime.queries > 0
			? (agg.allTime.turns / agg.allTime.queries).toFixed(1)
			: "--";

	// Active session derived
	const activeAvgCost =
		activeSession && activeSession.query_count > 0
			? `$${(activeSession.total_cost / activeSession.query_count).toFixed(4)}`
			: "--";
	const activeCacheInput = activeSession
		? activeSession.total_cache_read_tokens +
			activeSession.total_cache_creation_tokens
		: 0;
	const activeCacheHitPct = activeSession
		? cacheHitPct(
				activeSession.total_input_tokens,
				activeSession.total_cache_read_tokens,
				activeSession.total_cache_creation_tokens,
			)
		: "0";

	return (
		<div>
			{/* Summary headline strip — 4 key metrics at a glance */}
			<div className="grid grid-cols-2 sm:grid-cols-4 border-b border-border shrink-0">
				<div className="border-r border-b sm:border-b-0 border-border">
					<StatCell
						label="TODAY"
						value={`$${agg.today.cost.toFixed(4)}`}
						sub={
							agg.today.queries > 0 ? `${agg.today.queries} queries` : undefined
						}
					/>
				</div>
				<div className="border-b sm:border-b-0 sm:border-r border-border">
					<StatCell
						label="THIS MONTH"
						value={`$${agg.thisMonth.cost.toFixed(4)}`}
						sub={
							agg.thisMonth.queries > 0
								? `${agg.thisMonth.queries} queries`
								: undefined
						}
					/>
				</div>
				<div className="border-r border-border">
					<StatCell
						label="ALL-TIME"
						value={`$${agg.allTime.cost.toFixed(4)}`}
						sub={`${agg.allTime.queries} queries`}
					/>
				</div>
				<div>
					<StatCell
						label="SESSIONS"
						value={String(agg.allTime.sessions)}
						sub={
							agg.allTime.queries > 0
								? `${agg.allTime.queries} queries`
								: undefined
						}
					/>
				</div>
			</div>

			{/* 30-day activity graph */}
			<ThirtyDayGraph data={thirtyDayStats} />

			{/* Provider usage windows */}
			<ProviderUsageStrip
				initial={providerUsages}
				liveQueryCount={stats.queries}
				rateLimit={rateLimit}
				tail={<ContextWindowSection stats={stats} />}
				fetchFn={() => getProviderUsagesFn({ data: providerIds })}
			/>

			<div className="p-5 space-y-5">
				{/* Rate limit — only shown when active */}
				{rateLimit && (
					<div className="border border-border bg-card">
						<div className="px-4 py-3 border-b border-border">
							<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
								RATE LIMIT
							</div>
						</div>
						<div className="p-4 space-y-3">
							<div className="flex items-center justify-between">
								<span className="text-[10px] tracking-widest text-muted-foreground uppercase">
									Status
								</span>
								<span
									className={`text-[11px] tracking-wider font-medium ${
										rateLimit.status === "allowed"
											? "text-green-500/70"
											: rateLimit.status === "allowed_warning"
												? "text-yellow-500/70"
												: "text-destructive/70"
									}`}
								>
									{rateLimit.status.replace("_", " ").toUpperCase()}
								</span>
							</div>
							{rateLimit.rateLimitType && (
								<div className="flex items-center justify-between">
									<span className="text-[10px] tracking-widest text-muted-foreground uppercase">
										Window
									</span>
									<span className="text-[11px] tracking-wider text-foreground/70">
										{rateLimit.rateLimitType.replace(/_/g, " ").toUpperCase()}
									</span>
								</div>
							)}
							{rateLimit.utilization != null && (
								<UtilBar utilization={rateLimit.utilization} />
							)}
						</div>
					</div>
				)}

				{/* Live + DB session — 2-col responsive grid */}
				{(!idle || activeSession) && (
					<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
						{/* Live: current session (from wsStore) */}
						{!idle && (
							<div className="border border-border bg-card">
								<div className="px-4 py-3 border-b border-border">
									<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
										LIVE · THIS SESSION
									</div>
								</div>
								<Row label="Cost" value={`$${stats.cost.toFixed(4)}`} />
								<Row label="Queries" value={String(stats.queries)} />
								<Row label="Turns" value={String(stats.turns)} />
								<Row label="Input" value={fmt(stats.input_tokens)} />
								<Row label="Output" value={fmt(stats.output_tokens)} />
								<Row label="Cache read" value={fmt(stats.cache_read_tokens)} />
								<Row
									label="Cache creation"
									value={fmt(stats.cache_creation_tokens)}
								/>
								<Row label="Cache hit rate" value={`${liveCacheHitPct}%`} />
								<Row
									label="Total tokens"
									value={fmt(stats.input_tokens + stats.output_tokens)}
								/>
							</div>
						)}

						{/* DB totals — persisted, accurate across reloads */}
						{activeSession && (
							<div className="border border-border bg-card">
								<div className="px-4 py-3 border-b border-border">
									<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
										SESSION
									</div>
								</div>
								<Row
									label="Cost"
									value={`$${activeSession.total_cost.toFixed(4)}`}
								/>
								<Row label="Avg cost/query" value={activeAvgCost} />
								<Row
									label="Queries"
									value={String(activeSession.query_count)}
								/>
								<Row label="Turns" value={String(activeSession.total_turns)} />
								<Row
									label="Input"
									value={fmt(activeSession.total_input_tokens)}
								/>
								<Row
									label="Output"
									value={fmt(activeSession.total_output_tokens)}
								/>
								<Row
									label="Cache read"
									value={fmt(activeSession.total_cache_read_tokens)}
								/>
								<Row
									label="Cache creation"
									value={fmt(activeSession.total_cache_creation_tokens)}
								/>
								<Row label="Cache hit rate" value={`${activeCacheHitPct}%`} />
								<Row label="Cache tokens" value={fmt(activeCacheInput)} />
								<Row
									label="Total tokens"
									value={fmt(
										activeSession.total_input_tokens +
											activeSession.total_output_tokens,
									)}
								/>
							</div>
						)}
					</div>
				)}

				{/* TODAY + THIS MONTH — 2-col responsive grid */}
				<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
					<WindowCard title="TODAY" w={agg.today} />
					<WindowCard title="THIS MONTH" w={agg.thisMonth} />
				</div>

				{/* All-time — full width */}
				<div className="border border-border bg-card">
					<div className="px-4 py-3 border-b border-border">
						<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
							ALL-TIME
						</div>
					</div>
					<Row label="Sessions" value={String(agg.allTime.sessions)} />
					<Row label="Cost" value={`$${agg.allTime.cost.toFixed(4)}`} />
					<Row label="Avg cost/query" value={avgCostPerQuery} />
					<Row label="Queries" value={String(agg.allTime.queries)} />
					<Row label="Turns" value={String(agg.allTime.turns)} />
					<Row label="Avg turns/query" value={avgTurnsPerQuery} />
					<Row label="Input" value={fmt(agg.allTime.input_tokens)} />
					<Row label="Output" value={fmt(agg.allTime.output_tokens)} />
					<Row label="Cache read" value={fmt(agg.allTime.cache_read_tokens)} />
					<Row
						label="Cache creation"
						value={fmt(agg.allTime.cache_creation_tokens)}
					/>
					<Row label="Cache hit rate" value={`${allTimeCacheHitPct}%`} />
					<Row
						label="Cache tokens"
						value={fmt(
							agg.allTime.cache_read_tokens + agg.allTime.cache_creation_tokens,
						)}
					/>
					<Row label="Total tokens" value={fmt(allTimeTotal)} />
				</div>
			</div>
		</div>
	);
}
