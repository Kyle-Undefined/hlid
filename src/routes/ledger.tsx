import {
	createFileRoute,
	useNavigate,
	useRouterState,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ThirtyDayGraph } from "#/components/cockpit/ThirtyDayGraph";
import { HourOfDayChart } from "#/components/ledger/charts/HourOfDayChart";
import { ModelSplitDonut } from "#/components/ledger/charts/ModelSplitDonut";
import { StopReasonDonut } from "#/components/ledger/charts/StopReasonDonut";
import { TopToolsChart } from "#/components/ledger/charts/TopToolsChart";
import type { StatBundle } from "#/components/ledger/LedgerStats";
import { StatCell, StatRows, UtilBar } from "#/components/ledger/LedgerStats";
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
import type { ActivityStats } from "#/lib/serverFns";
import {
	EMPTY_AGG,
	getActiveSessionRowFn,
	getActivityStatsFn,
	getProvidersFn,
	getProviderUsagesFn,
	getThirtyDayStatsFn,
} from "#/lib/serverFns";
import type { RateLimitMessage, ServerMessage } from "#/server/protocol";

// ─── search param helper (exported for tests) ────────────────────────────────

export const VALID_PAGE_SIZES = [10, 20, 50, 100] as const;
export type PageSize = (typeof VALID_PAGE_SIZES)[number];
const DEFAULT_PAGE_SIZE: PageSize = 20;

export function isValidSize(n: number): n is PageSize {
	return (VALID_PAGE_SIZES as readonly number[]).includes(n);
}

export function parseLedgerSearch(search: Record<string, unknown>): {
	tab: "stats" | "sessions";
	page: number;
	size: PageSize;
} {
	const tab = search.tab === "stats" ? "stats" : "sessions";
	const page =
		typeof search.page === "number" ? Math.max(1, Math.floor(search.page)) : 1;
	const sizeRaw =
		typeof search.size === "number"
			? Math.floor(search.size)
			: DEFAULT_PAGE_SIZE;
	const size: PageSize = isValidSize(sizeRaw) ? sizeRaw : DEFAULT_PAGE_SIZE;
	return { tab, page, size };
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

// Re-exported from LedgerStats so existing tests (and any external imports)
// continue to resolve cacheHitPct via this module path.
export { cacheHitPct } from "#/components/ledger/LedgerStats";

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

export const Route = createFileRoute("/ledger")({
	validateSearch: parseLedgerSearch,
	loaderDeps: ({ search: { page, size } }) => ({ page, size }),
	loader: async ({ deps: { page, size } }) => {
		const [statsData, providers, thirtyDayStats, activeSession, activity] =
			await Promise.all([
				getStatsDataFn(),
				getProvidersFn(),
				getThirtyDayStatsFn(),
				getActiveSessionRowFn(),
				getActivityStatsFn(),
			]);

		const availableIds = providers.filter((p) => p.available).map((p) => p.id);
		const providerIds = availableIds.length > 0 ? availableIds : ["claude"];

		const [initialSessions, providerUsages] = await Promise.all([
			getSessionsPageFn({ data: { page, size } }),
			getProviderUsagesFn({ data: providerIds }),
		]);

		return {
			statsData,
			initialSessions,
			page,
			size,
			thirtyDayStats,
			providerUsages,
			providerIds,
			activeSession,
			activity,
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
		size,
		thirtyDayStats,
		providerUsages,
		providerIds,
		activeSession,
		activity,
	} = Route.useLoaderData();
	const { tab } = Route.useSearch();
	const navigate = useNavigate();
	const isRouterLoading = useRouterState({
		select: (s) => s.status === "pending",
	});
	const stats = useWsLiveStats();
	const [rateLimit, setRateLimit] = useState<RateLimitMessage | null>(null);

	const [activeSessionData, setActiveSessionData] = useState(activeSession);
	const [statsDataState, setStatsDataState] = useState(statsData);

	const [sessionPage, setSessionPage] = useState(initialSessions);
	// Mutate refs during render so they're always current before any event
	// handler fires. useEffect would lag by one render cycle, causing
	// refreshSessions to fetch with stale page/size if a `done` event arrives
	// between render and effect commit.
	const pageRef = useRef(page);
	pageRef.current = page;
	const sizeRef = useRef(size);
	sizeRef.current = size;

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
			data: { page: pageRef.current, size: sizeRef.current },
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
						void getStatsDataFn().then(setStatsDataState);
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
	const totalPages = Math.max(1, Math.ceil(sessionsData.total / size));

	function onPageChange(p: number) {
		const clamped = Math.max(1, Math.min(totalPages, p));
		navigate({
			to: "/ledger",
			search: { tab: "sessions", page: clamped, size },
		});
	}

	function onPageSizeChange(nextSize: number) {
		// Guard: the <select> only emits values from VALID_PAGE_SIZES at runtime,
		// but TS can't narrow that — validate at the boundary so the URL search
		// state stays well-typed.
		if (!isValidSize(nextSize)) return;
		// Reset to page 1 — current page may not exist at the new size.
		navigate({
			to: "/ledger",
			search: { tab: "sessions", page: 1, size: nextSize },
		});
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
			navigate({
				to: "/ledger",
				search: { tab: "sessions", page: page - 1, size },
			});
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
		navigate({ to: "/ledger", search: { tab: "sessions", page: 1, size } });
	}

	const { agg } = statsDataState;

	function switchTab(next: "stats" | "sessions") {
		if (next === "sessions") {
			navigate({ to: "/ledger", search: { tab: next, page: 1, size } });
		} else {
			// stats tab has no pagination — preserve existing page/size in URL
			navigate({ to: "/ledger", search: { tab: next, page, size } });
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
							{activeSessionData.label && (
								<span className="text-[9px] tracking-widest uppercase text-foreground/60 truncate">
									{activeSessionData.label}
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
						activity={activity}
					/>
				) : (
					<div className="p-5">
						<SessionsLedger
							data={sessionsData}
							page={page}
							pageSize={size}
							pageSizeOptions={VALID_PAGE_SIZES}
							totalPages={totalPages}
							loading={isRouterLoading}
							onPageChange={onPageChange}
							onPageSizeChange={onPageSizeChange}
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
	return (
		<div className="border border-border bg-card">
			<div className="px-4 py-3 border-b border-border">
				<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
					{title}
				</div>
			</div>
			<StatRows s={w} />
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
	activity,
}: {
	agg: AggStats;
	stats: LiveStats;
	rateLimit: RateLimitMessage | null;
	providerUsages: ProviderUsageSnapshot[];
	providerIds: string[];
	thirtyDayStats: ThirtyDayStats;
	activeSession: SessionRow | null;
	activity: ActivityStats;
}) {
	const sessionBundle: StatBundle | null = activeSession
		? {
				cost: activeSession.total_cost,
				queries: activeSession.query_count,
				turns: activeSession.total_turns,
				input_tokens: activeSession.total_input_tokens,
				output_tokens: activeSession.total_output_tokens,
				cache_read_tokens: activeSession.total_cache_read_tokens,
				cache_creation_tokens: activeSession.total_cache_creation_tokens,
			}
		: null;

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
				{/* System activity — charts */}
				<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
					{/* Donuts paired side-by-side on lg so the wide-screen space goes
					    toward the inline legend instead of empty whitespace. */}
					<ModelSplitDonut data={activity.modelSplit} />
					<StopReasonDonut data={activity.stopReasonSplit} />
					{/* TopTools is dense (10 horizontal bars) — give it the full row. */}
					<div className="lg:col-span-2">
						<TopToolsChart data={activity.topTools} />
					</div>
					<div className="lg:col-span-2">
						<HourOfDayChart data={activity.hourOfDay} />
					</div>
				</div>

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

				{/* SESSION (DB) + TODAY + THIS MONTH + ALL-TIME — same-size row.
				    Falls back to 3 cols when there's no active session so the
				    remaining cards still fill the row without a trailing gap. */}
				<div
					className={`grid grid-cols-1 sm:grid-cols-2 gap-4 ${
						activeSession ? "lg:grid-cols-4" : "lg:grid-cols-3"
					}`}
				>
					{sessionBundle && (
						<div className="border border-border bg-card">
							<div className="px-4 py-3 border-b border-border">
								<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
									SESSION
								</div>
							</div>
							<StatRows s={sessionBundle} />
						</div>
					)}
					<WindowCard title="TODAY" w={agg.today} />
					<WindowCard title="THIS MONTH" w={agg.thisMonth} />
					<div className="border border-border bg-card">
						<div className="px-4 py-3 border-b border-border">
							<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
								ALL-TIME
							</div>
						</div>
						<StatRows s={agg.allTime} />
					</div>
				</div>
			</div>
		</div>
	);
}
