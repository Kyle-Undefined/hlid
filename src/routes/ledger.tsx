import {
	createFileRoute,
	useNavigate,
	useRouterState,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { ThirtyDayGraph } from "#/components/cockpit/ThirtyDayGraph";
import { ActiveSessionsPanel } from "#/components/ledger/ActiveSessionsPanel";
import { CostBreakdown } from "#/components/ledger/CostBreakdown";
import { HourOfDayChart } from "#/components/ledger/charts/HourOfDayChart";
import { ModelSplitDonut } from "#/components/ledger/charts/ModelSplitDonut";
import { StopReasonDonut } from "#/components/ledger/charts/StopReasonDonut";
import { TopToolsChart } from "#/components/ledger/charts/TopToolsChart";
import type { StatBundle } from "#/components/ledger/LedgerStats";
import { StatCell, StatRows } from "#/components/ledger/LedgerStats";
import { SessionsLedger } from "#/components/ledger/SessionsLedger";
import { ProviderUsageStrip } from "#/components/usage/ProviderUsageStrip";
import { ContextWindowSection } from "#/components/usage/UsageWindowSections";
import type {
	AggStats,
	AggWindow,
	ProviderUsageSnapshot,
	SessionRow,
	ThirtyDayStats,
} from "#/db";
import { useLedgerSessionMutations } from "#/hooks/useLedgerSessionMutations";
import { useWs } from "#/hooks/useWs";
import { useWsLiveStats } from "#/hooks/useWsSelectors";
import type { LiveStats } from "#/hooks/wsLiveStatsStore";
import {
	getSessionsStatus,
	subscribeSessionsStatus,
} from "#/hooks/wsSessionStatusStore";
import {
	costDisplayNote,
	formatDisplayCost,
	totalDisplayCost,
} from "#/lib/costDisplay";
import { dbFetch, dbJson, requireDbOk } from "#/lib/dbClient";
import { fmt, fmtModel } from "#/lib/formatters";
import {
	isValidSize,
	parseLedgerSearch,
	type SessionSortKey,
	VALID_PAGE_SIZES,
} from "#/lib/ledgerState";
import { ROUTE_SCROLL_RESTORATION_IDS } from "#/lib/scrollContainers";
import {
	sessionCleanupSchema,
	sessionDeleteSchema,
	sessionPageSchema,
	sessionRenameSchema,
} from "#/lib/serverFnSchemas";
import { getProvidersFn, getProviderUsagesFn } from "#/lib/serverFns/providers";
import { getActiveSessionRowFn } from "#/lib/serverFns/sessions";
import type { ActivityStats } from "#/lib/serverFns/stats";
import {
	EMPTY_AGG,
	getActivityStatsFn,
	getThirtyDayStatsFn,
} from "#/lib/serverFns/stats";
import { buildSessionExport, downloadContent } from "#/lib/sessionExport";
import type { RateLimitMessage, ServerMessage } from "#/server/protocol";

// ─── server fns ──────────────────────────────────────────────────────────────

const getStatsDataFn = createServerFn({ method: "GET" }).handler(async () => {
	const data = await dbJson<{ agg: AggStats } | null>("/db/stats", null);
	return { agg: data?.agg ?? EMPTY_AGG };
});

const getSessionsPageFn = createServerFn({ method: "POST" })
	.validator((raw) => sessionPageSchema.parse(raw))
	.handler(({ data }) => {
		const params = new URLSearchParams({
			page: String(data.page),
			size: String(data.size),
		});
		if (data.q) params.set("q", data.q);
		if (data.sort && data.sort !== "recent") params.set("sort", data.sort);
		return dbJson<{
			sessions: SessionRow[];
			total: number;
			oldest_started_at: number | null;
		}>(`/db/sessions?${params.toString()}`, {
			sessions: [],
			total: 0,
			oldest_started_at: null,
		});
	});

const exportSessionsFn = createServerFn({ method: "GET" }).handler(() =>
	dbJson<SessionRow[]>("/db/sessions/export", []),
);

const deleteSessionFn = createServerFn({ method: "POST" })
	.validator((raw) => sessionDeleteSchema.parse(raw))
	.handler(async ({ data }) => {
		await requireDbOk(
			await dbFetch(`/db/session?id=${encodeURIComponent(data.id)}`, {
				method: "DELETE",
			}),
			"delete session",
		);
		return { ok: true };
	});

const renameSessionFn = createServerFn({ method: "POST" })
	.validator((raw) => sessionRenameSchema.parse(raw))
	.handler(async ({ data }) => {
		await requireDbOk(
			await dbFetch(`/db/session?id=${encodeURIComponent(data.id)}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ label: data.label }),
			}),
			"rename session",
		);
		return { ok: true };
	});

const cleanupSessionsFn = createServerFn({ method: "POST" })
	.validator((raw) => sessionCleanupSchema.parse(raw))
	.handler(async ({ data }) => {
		const res = await requireDbOk(
			await dbFetch(`/db/sessions/cleanup?older_than_days=${data.days}`, {
				method: "POST",
			}),
			"clean up sessions",
		);
		return res.json() as Promise<{ deleted: number }>;
	});

// ─── route ───────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/ledger")({
	validateSearch: parseLedgerSearch,
	loaderDeps: ({ search: { page, size, q, sort } }) => ({
		page,
		size,
		q,
		sort,
	}),
	staleTime: 0,
	loader: async ({ deps: { page, size, q, sort } }) => {
		const renderedAt = Math.floor(Date.now() / 1000);
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
			getSessionsPageFn({ data: { page, size, q: q || undefined, sort } }),
			getProviderUsagesFn({ data: providerIds }),
		]);

		return {
			statsData,
			initialSessions,
			page,
			size,
			q,
			sort,
			thirtyDayStats,
			providerUsages,
			providerIds,
			activeSession,
			activity,
			renderedAt,
		};
	},
	component: StatsPage,
});

// ─── page ─────────────────────────────────────────────────────────────────────

type ActiveStat = { value: string; sub?: string; dim?: boolean };

function activeCostStat(
	stats: LiveStats,
	activeSession: SessionRow | null,
): ActiveStat {
	if (stats.queries > 0) {
		const pricedQueries = Math.max(
			0,
			stats.queries - (stats.unpriced_queries ?? 0),
		);
		return {
			value: formatDisplayCost(stats),
			sub:
				costDisplayNote(stats) ??
				(pricedQueries > 0
					? `$${(totalDisplayCost(stats) / pricedQueries).toFixed(4)}/query`
					: undefined),
		};
	}
	if (activeSession) {
		const pricedQueries = Math.max(
			0,
			activeSession.query_count - (activeSession.unpriced_query_count ?? 0),
		);
		return {
			value: formatDisplayCost({
				cost: activeSession.total_cost,
				estimated_cost: activeSession.total_estimated_cost,
				unpriced_queries: activeSession.unpriced_query_count ?? 0,
			}),
			sub:
				(activeSession.total_estimated_cost ?? 0) > 0
					? "API-equivalent estimate"
					: pricedQueries > 0
						? `$${(activeSession.total_cost / pricedQueries).toFixed(4)}/query`
						: undefined,
		};
	}
	return { value: "--", dim: true };
}

function activeQueryStat(
	stats: LiveStats,
	activeSession: SessionRow | null,
): ActiveStat {
	if (stats.queries > 0) {
		return { value: String(stats.queries), sub: `${stats.turns} turns` };
	}
	if (activeSession) {
		return {
			value: String(activeSession.query_count),
			sub:
				activeSession.total_turns > 0
					? `${activeSession.total_turns} turns`
					: undefined,
		};
	}
	return { value: "--", dim: true };
}

function activeTokenStat(
	stats: LiveStats,
	activeSession: SessionRow | null,
): ActiveStat {
	if (stats.queries > 0) {
		const cached = stats.cache_read_tokens + stats.cache_creation_tokens;
		return {
			value: fmt(
				stats.input_tokens +
					stats.output_tokens +
					stats.cache_read_tokens +
					stats.cache_creation_tokens,
			),
			sub: cached > 0 ? `${fmt(cached)} cached` : undefined,
		};
	}
	if (activeSession) {
		const cached =
			activeSession.total_cache_read_tokens +
			activeSession.total_cache_creation_tokens;
		return {
			value: fmt(
				activeSession.total_input_tokens +
					activeSession.total_output_tokens +
					activeSession.total_cache_read_tokens +
					activeSession.total_cache_creation_tokens,
			),
			sub: cached > 0 ? `${fmt(cached)} cached` : undefined,
		};
	}
	return { value: "--", dim: true };
}

function activeModelStat(
	model: string,
	actualModel: string | null,
	activeSession: SessionRow | null,
): ActiveStat {
	const liveModel = actualModel || model;
	if (liveModel) return { value: fmtModel(liveModel) };
	if (activeSession?.model) return { value: fmtModel(activeSession.model) };
	return { value: "--", dim: true };
}

function ActiveSessionStatGrid({
	stats,
	activeSession,
	model,
	actualModel,
}: {
	stats: LiveStats;
	activeSession: SessionRow | null;
	model: string;
	actualModel: string | null;
}) {
	const cost = activeCostStat(stats, activeSession);
	const queries = activeQueryStat(stats, activeSession);
	const tokens = activeTokenStat(stats, activeSession);
	const activeModel = activeModelStat(model, actualModel, activeSession);
	return (
		<div className="grid grid-cols-2 sm:grid-cols-4 border-b border-border">
			<div className="border-r border-b sm:border-b-0 border-border">
				<StatCell label="COST" {...cost} />
			</div>
			<div className="border-b sm:border-b-0 sm:border-r border-border">
				<StatCell label="QUERIES" {...queries} />
			</div>
			<div className="border-r border-border">
				<StatCell label="TOKENS" {...tokens} />
			</div>
			<div>
				<StatCell label="MODEL" {...activeModel} />
			</div>
		</div>
	);
}

type LedgerNavigate = ReturnType<typeof useNavigate>;
type PageSize = (typeof VALID_PAGE_SIZES)[number];

/** Session-list URL state threaded through navigation and refreshes. */
type ListState = {
	page: number;
	size: PageSize;
	q: string;
	sort: SessionSortKey;
};

function useLedgerMutations(
	listState: ListState,
	sessionPage: Awaited<ReturnType<typeof getSessionsPageFn>>,
	navigate: LedgerNavigate,
) {
	const { page, size, q, sort } = listState;
	const dependencies = useMemo(
		() => ({
			deleteSession: async (id: string) => {
				await deleteSessionFn({ data: { id } });
			},
			renameSession: async (id: string, label: string) => {
				await renameSessionFn({ data: { id, label } });
			},
			cleanupSessions: async (days: number) => {
				await cleanupSessionsFn({ data: { days } });
			},
			navigateToPage: (nextPage: number) => {
				navigate({
					to: "/ledger",
					search: { tab: "sessions" as const, page: nextPage, size, q, sort },
				});
			},
		}),
		[navigate, size, q, sort],
	);
	return useLedgerSessionMutations({ page, sessionPage, dependencies });
}

function useSessionListSync({
	listState,
	initialSessions,
	reconcile,
}: {
	listState: ListState;
	initialSessions: Awaited<ReturnType<typeof getSessionsPageFn>>;
	reconcile: (fresh: Awaited<ReturnType<typeof getSessionsPageFn>>) => void;
}) {
	const [sessionPage, setSessionPage] = useState(initialSessions);
	// Mutate refs during render so they're always current before any event
	// handler fires. useEffect would lag by one render cycle, causing
	// refreshSessions to fetch with stale page/size if a `done` event arrives
	// between render and effect commit.
	const listStateRef = useRef(listState);
	listStateRef.current = listState;

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
		const { page, size, q, sort } = listStateRef.current;
		const fresh = await getSessionsPageFn({
			data: { page, size, q: q || undefined, sort },
		});
		// Discard if a newer fetch (loader sync or another WS done) already landed.
		if (fetchVersionRef.current !== v) return;
		setSessionPage(fresh);
		// Only evict optimistic state for entries confirmed gone by the server.
		// Blanket-clearing would re-show a session the user just deleted if a
		// background `done` event fires before the delete RPC resolves.
		reconcile(fresh);
	}, [reconcile]);

	return { sessionPage, refreshSessions };
}

// Refresh DB session list when:
//   (a) any pool session completes a turn (running→idle/error), or
//   (b) a brand-new db_session_id appears that wasn't seen before
//       (new chat just wrote its first DB row via initSessionContext).
function useSessionStatusRefresh(
	sessionsStatus: ReturnType<typeof getSessionsStatus>,
	refreshSessions: () => Promise<void>,
) {
	const prevSessionStatesRef = useRef<
		Map<string, "idle" | "running" | "error">
	>(new Map());
	const seenDbSessionIdsRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		const prev = prevSessionStatesRef.current;
		let shouldRefresh = false;

		for (const s of sessionsStatus) {
			const prevState = prev.get(s.session_id);
			// running→idle/error = turn just completed
			if (prevState === "running" && s.state !== "running") {
				shouldRefresh = true;
			}
			// new db_session_id we haven't seen yet = session row just created in DB
			if (
				s.db_session_id &&
				!seenDbSessionIdsRef.current.has(s.db_session_id)
			) {
				seenDbSessionIdsRef.current.add(s.db_session_id);
				shouldRefresh = true;
			}
		}

		prevSessionStatesRef.current = new Map(
			sessionsStatus.map((s) => [s.session_id, s.state]),
		);
		if (shouldRefresh) void refreshSessions();
	}, [sessionsStatus, refreshSessions]);
}

/** Live data driven by WS events: rate limit, active session row, agg stats. */
function useLedgerLiveData(
	refreshSessions: () => Promise<void>,
	initialActiveSession: SessionRow | null,
	initialStatsData: { agg: AggStats },
) {
	const [rateLimit, setRateLimit] = useState<RateLimitMessage | null>(null);
	const [activeSessionData, setActiveSessionData] =
		useState(initialActiveSession);
	const [statsDataState, setStatsDataState] = useState(initialStatsData);

	const {
		model,
		actualModel,
		send: sendWs,
	} = useWs(
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

	const handleStopSession = useCallback(
		(poolSessionId: string) => {
			sendWs({ type: "stop_session", session_id: poolSessionId });
		},
		[sendWs],
	);

	const handleCloseSession = useCallback(
		(poolSessionId: string) => {
			sendWs({ type: "close_session", session_id: poolSessionId });
		},
		[sendWs],
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

	return {
		rateLimit,
		activeSessionData,
		statsDataState,
		model,
		actualModel,
		handleStopSession,
		handleCloseSession,
	};
}

function LedgerTabBar({
	tab,
	listState,
	navigate,
}: {
	tab: "stats" | "sessions";
	listState: ListState;
	navigate: LedgerNavigate;
}) {
	const { page, size, q, sort } = listState;
	function switchTab(next: "stats" | "sessions") {
		if (next === "sessions") {
			navigate({
				to: "/ledger",
				search: { tab: next, page: 1, size, q, sort },
			});
		} else {
			navigate({ to: "/ledger", search: { tab: next, page, size, q, sort } });
		}
	}
	return (
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
	);
}

function SessionsTab({
	sessionsStatus,
	live,
	mutations,
	listState,
	navigate,
	loading,
	liveStats,
	oldestStartedAt,
	cleanupReferenceTime,
}: {
	sessionsStatus: ReturnType<typeof getSessionsStatus>;
	live: ReturnType<typeof useLedgerLiveData>;
	mutations: ReturnType<typeof useLedgerMutations>;
	listState: ListState;
	navigate: LedgerNavigate;
	loading: boolean;
	liveStats: LiveStats;
	oldestStartedAt: number | null;
	cleanupReferenceTime: number;
}) {
	const { page, size, q, sort } = listState;
	const totalPages = Math.max(
		1,
		Math.ceil(mutations.sessionsData.total / size),
	);

	function navigateList(next: Partial<ListState>, replace = false) {
		navigate({
			to: "/ledger",
			search: { tab: "sessions", page, size, q, sort, ...next },
			replace,
		});
	}

	function onPageChange(p: number) {
		navigateList({ page: Math.max(1, Math.min(totalPages, p)) });
	}

	function onPageSizeChange(nextSize: number) {
		// Guard: the <select> only emits values from VALID_PAGE_SIZES at runtime,
		// but TS can't narrow that — validate at the boundary so the URL search
		// state stays well-typed.
		if (!isValidSize(nextSize)) return;
		// Reset to page 1 — current page may not exist at the new size.
		navigateList({ page: 1, size: nextSize });
	}

	async function onExport(format: "csv" | "json") {
		const rows = await exportSessionsFn();
		const { content, mime, filename } = buildSessionExport(rows, format);
		downloadContent(content, mime, filename);
	}

	return (
		<div>
			{/* Always rendered — shows the "all quiet" empty state when idle. */}
			<div className="border-b border-border">
				<ActiveSessionsPanel
					sessions={sessionsStatus}
					onStop={live.handleStopSession}
					onClose={live.handleCloseSession}
				/>
			</div>
			<div className="p-5">
				<SessionsLedger
					data={mutations.sessionsData}
					page={page}
					pageSize={size}
					pageSizeOptions={VALID_PAGE_SIZES}
					totalPages={totalPages}
					loading={loading}
					onPageChange={onPageChange}
					onPageSizeChange={onPageSizeChange}
					onDelete={mutations.deleteSession}
					onRename={mutations.renameSession}
					onNavigate={(id) =>
						navigate({
							to: "/raven",
							search: { session: id, agent: undefined },
						})
					}
					onCleanup={mutations.cleanupSessions}
					activeSessionId={live.activeSessionData?.id}
					sessionsStatus={sessionsStatus}
					liveStats={liveStats}
					search={q}
					onSearchChange={(nextQ) =>
						// replace: live search fires per typing pause — one history
						// entry per keystroke burst would bury the back button.
						navigateList({ page: 1, q: nextQ }, true)
					}
					sort={sort}
					onSortChange={(nextSort) => navigateList({ page: 1, sort: nextSort })}
					oldestStartedAt={oldestStartedAt}
					cleanupReferenceTime={cleanupReferenceTime}
					onExport={(format) => void onExport(format)}
				/>
			</div>
		</div>
	);
}

function StatsPage() {
	const {
		statsData,
		initialSessions,
		page,
		size,
		q,
		sort,
		thirtyDayStats,
		providerUsages,
		providerIds,
		activeSession,
		activity,
		renderedAt,
	} = Route.useLoaderData();
	const { tab } = Route.useSearch();
	const listState: ListState = {
		page,
		size,
		q: q ?? "",
		sort: sort ?? "recent",
	};
	const navigate = useNavigate();
	const isRouterLoading = useRouterState({
		select: (s) => s.status === "pending",
	});
	const stats = useWsLiveStats();
	// ── Active sessions (multi-session pool status) ───────────────────────────
	const sessionsStatus = useSyncExternalStore(
		subscribeSessionsStatus,
		getSessionsStatus,
		() => [],
	);

	// sessionPage state lives in useSessionListSync; the mutations hook layers
	// optimistic edits over it. refreshSessions must reconcile those edits after
	// each fetch, but mutations needs sessionPage from the sync hook — the ref
	// breaks that cycle without re-creating refreshSessions every render.
	const mutationsRef = useRef<ReturnType<typeof useLedgerMutations> | null>(
		null,
	);
	const reconcile = useCallback(
		(fresh: Awaited<ReturnType<typeof getSessionsPageFn>>) =>
			mutationsRef.current?.reconcile(fresh),
		[],
	);
	const { sessionPage, refreshSessions } = useSessionListSync({
		listState,
		initialSessions,
		reconcile,
	});
	const mutations = useLedgerMutations(listState, sessionPage, navigate);
	mutationsRef.current = mutations;
	useSessionStatusRefresh(sessionsStatus, refreshSessions);
	const live = useLedgerLiveData(refreshSessions, activeSession, statsData);

	return (
		<div className="flex flex-col h-full">
			<LedgerTabBar tab={tab} listState={listState} navigate={navigate} />
			{mutations.mutationError && (
				<div
					className="border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive"
					role="alert"
				>
					{mutations.mutationError}
				</div>
			)}

			<div
				data-scroll-restoration-id={ROUTE_SCROLL_RESTORATION_IDS.ledgerList}
				data-scroll-to-top="route"
				className="flex-1 overflow-auto"
			>
				<ActiveSessionStatGrid
					stats={stats}
					activeSession={live.activeSessionData}
					model={live.model}
					actualModel={live.actualModel}
				/>

				{tab === "stats" ? (
					<StatsTab
						agg={live.statsDataState.agg}
						stats={stats}
						rateLimit={live.rateLimit}
						providerUsages={providerUsages}
						providerIds={providerIds}
						thirtyDayStats={thirtyDayStats}
						activeSession={live.activeSessionData}
						activity={activity}
					/>
				) : (
					<SessionsTab
						sessionsStatus={sessionsStatus}
						live={live}
						mutations={mutations}
						listState={listState}
						navigate={navigate}
						loading={isRouterLoading}
						liveStats={stats}
						oldestStartedAt={sessionPage.oldest_started_at ?? null}
						cleanupReferenceTime={renderedAt}
					/>
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
				estimated_cost: activeSession.total_estimated_cost ?? 0,
				unpriced_queries: activeSession.unpriced_query_count ?? 0,
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
						value={formatDisplayCost(agg.today)}
						sub={
							costDisplayNote(agg.today) ??
							(agg.today.queries > 0
								? `${agg.today.queries} queries`
								: undefined)
						}
					/>
				</div>
				<div className="border-b sm:border-b-0 sm:border-r border-border">
					<StatCell
						label="THIS MONTH"
						value={formatDisplayCost(agg.thisMonth)}
						sub={
							costDisplayNote(agg.thisMonth) ??
							(agg.thisMonth.queries > 0
								? `${agg.thisMonth.queries} queries`
								: undefined)
						}
					/>
				</div>
				<div className="border-r border-border">
					<StatCell
						label="ALL-TIME"
						value={formatDisplayCost(agg.allTime)}
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

				{/* Cost breakdown — all-time window for maximum analytical richness */}
				<CostBreakdown s={agg.allTime} />

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
