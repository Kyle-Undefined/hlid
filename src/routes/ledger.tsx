import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
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
import { cacheHitPct, StatCell } from "#/components/ledger/LedgerStats";
import { SessionsLedger } from "#/components/ledger/SessionsLedger";
import { StatsFilterBar } from "#/components/ledger/StatsFilterBar";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { LedgerAnalytics, SessionRow } from "#/db";
import { useLedgerSessionMutations } from "#/hooks/useLedgerSessionMutations";
import {
	type LedgerStatsSourceStatus,
	useLedgerStatsData,
} from "#/hooks/useLedgerStatsData";
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
	buildLedgerAgentOptions,
	isValidSize,
	type LedgerStatsRange,
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
import { getAgentListFn } from "#/lib/serverFns/agents";
import { getActiveSessionRowFn } from "#/lib/serverFns/sessions";
import { buildSessionExport, downloadContent } from "#/lib/sessionExport";
import type { ServerMessage } from "#/server/protocol";

// ─── server fns ──────────────────────────────────────────────────────────────

const getSessionsPageFn = createServerFn({ method: "POST" })
	.validator((raw) => sessionPageSchema.parse(raw))
	.handler(({ data }) => {
		const params = new URLSearchParams({
			page: String(data.page),
			size: String(data.size),
		});
		if (data.q) params.set("q", data.q);
		if (data.agent) params.set("agent", data.agent);
		if (data.model) params.set("model", data.model);
		if (data.provider) params.set("provider", data.provider);
		if (data.stop) params.set("stop", data.stop);
		if (data.sort && data.sort !== "recent") params.set("sort", data.sort);
		return dbJson<{
			sessions: SessionRow[];
			total: number;
			oldest_started_at: number | null;
			agent_cwds: string[];
			models: string[];
		}>(`/db/sessions?${params.toString()}`, {
			sessions: [],
			total: 0,
			oldest_started_at: null,
			agent_cwds: [],
			models: [],
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
	// Search state is synchronized by the mounted page. Including it in
	// loaderDeps changes the TanStack match ID, which forces a new pending match
	// before shouldReload can keep a sort/filter interaction on-screen.
	loaderDeps: () => ({}),
	staleTime: 0,
	// Search controls are client-synchronized below. Re-entering the route still
	// gets a fresh loader seed, while changing a dropdown keeps the current page
	// mounted instead of replacing it with a pending route.
	shouldReload: ({ cause }) => cause !== "stay",
	loader: async ({ location }) => {
		const {
			page,
			size,
			q,
			agent,
			model,
			provider,
			stop,
			range,
			from,
			to,
			sort,
		} = parseLedgerSearch(location.search);
		const renderedAt = Math.floor(Date.now() / 1000);
		const [initialSessions, activeSession, configuredAgents] =
			await Promise.all([
				getSessionsPageFn({
					data: {
						page,
						size,
						q: q || undefined,
						agent: agent || undefined,
						model: model || undefined,
						provider: provider || undefined,
						stop: stop || undefined,
						sort,
					},
				}),
				getActiveSessionRowFn(),
				getAgentListFn(),
			]);

		return {
			initialSessions,
			page,
			size,
			q,
			agent,
			model,
			provider,
			stop,
			range,
			from,
			to,
			sort,
			activeSession,
			configuredAgents,
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
	agent: string;
	model: string;
	provider: string;
	stop: string;
	range: LedgerStatsRange;
	from: string;
	to: string;
	sort: SessionSortKey;
};

function useLedgerMutations(
	listState: ListState,
	sessionPage: Awaited<ReturnType<typeof getSessionsPageFn>>,
	navigate: LedgerNavigate,
) {
	const { page, size, q, agent, model, provider, stop, range, from, to, sort } =
		listState;
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
					search: {
						tab: "sessions" as const,
						page: nextPage,
						size,
						q,
						agent,
						model,
						provider,
						stop,
						range,
						from,
						to,
						sort,
					},
				});
			},
		}),
		[navigate, size, q, agent, model, provider, stop, range, from, to, sort],
	);
	return useLedgerSessionMutations({ page, sessionPage, dependencies });
}

function useSessionListSync({
	listState,
	initialSessions,
	reconcile,
	enabled,
}: {
	listState: ListState;
	initialSessions: Awaited<ReturnType<typeof getSessionsPageFn>>;
	reconcile: (fresh: Awaited<ReturnType<typeof getSessionsPageFn>>) => void;
	enabled: boolean;
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
	const requestKey = [
		listState.page,
		listState.size,
		listState.q,
		listState.agent,
		listState.model,
		listState.provider,
		listState.stop,
		listState.sort,
	].join("\u0000");
	const lastFetchedKeyRef = useRef(requestKey);

	// Sync when a route entry or explicit invalidation supplies a new loader seed.
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
		const { page, size, q, agent, model, provider, stop, sort } =
			listStateRef.current;
		const fresh = await getSessionsPageFn({
			data: {
				page,
				size,
				q: q || undefined,
				agent: agent || undefined,
				model: model || undefined,
				provider: provider || undefined,
				stop: stop || undefined,
				sort,
			},
		});
		// Discard if a newer fetch (loader sync or another WS done) already landed.
		if (fetchVersionRef.current !== v) return;
		setSessionPage(fresh);
		// Only evict optimistic state for entries confirmed gone by the server.
		// Blanket-clearing would re-show a session the user just deleted if a
		// background `done` event fires before the delete RPC resolves.
		reconcile(fresh);
	}, [reconcile]);

	// Route search changes no longer rerun the loader. Keep the previous rows on
	// screen while fetching the next page/filter result, then swap atomically.
	useEffect(() => {
		if (!enabled || lastFetchedKeyRef.current === requestKey) return;
		lastFetchedKeyRef.current = requestKey;
		void refreshSessions();
	}, [enabled, refreshSessions, requestKey]);

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
	const initializedRef = useRef(false);
	useEffect(() => {
		const prev = prevSessionStatesRef.current;
		if (!initializedRef.current) {
			initializedRef.current = true;
			prevSessionStatesRef.current = new Map(
				sessionsStatus.map((session) => [session.session_id, session.state]),
			);
			seenDbSessionIdsRef.current = new Set(
				sessionsStatus.flatMap((session) =>
					session.db_session_id ? [session.db_session_id] : [],
				),
			);
			return;
		}
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

/** Live data driven by WS events: rate limits and the active session row. */
function useLedgerLiveData(
	initialActiveSession: SessionRow | null,
	onDone?: () => void,
) {
	const [activeSessionData, setActiveSessionData] =
		useState(initialActiveSession);
	useEffect(
		() => setActiveSessionData(initialActiveSession),
		[initialActiveSession],
	);

	const {
		model,
		actualModel,
		send: sendWs,
	} = useWs(
		useCallback(
			(msg: ServerMessage) => {
				if (msg.type === "done") {
					void getActiveSessionRowFn().then(setActiveSessionData);
					onDone?.();
				}
			},
			[onDone],
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
		activeSessionData,
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
	const { page, size, q, agent, model, provider, stop, range, from, to, sort } =
		listState;
	function switchTab(next: "stats" | "sessions") {
		if (next === "sessions") {
			navigate({
				to: "/ledger",
				search: {
					tab: next,
					page: 1,
					size,
					q,
					agent,
					model,
					provider,
					stop,
					range,
					from,
					to,
					sort,
				},
			});
		} else {
			navigate({
				to: "/ledger",
				search: {
					tab: next,
					page,
					size,
					q,
					agent,
					model,
					provider,
					stop,
					range,
					from,
					to,
					sort,
				},
			});
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
	liveStats,
	oldestStartedAt,
	cleanupReferenceTime,
	configuredAgents,
}: {
	sessionsStatus: ReturnType<typeof getSessionsStatus>;
	live: ReturnType<typeof useLedgerLiveData>;
	mutations: ReturnType<typeof useLedgerMutations>;
	listState: ListState;
	navigate: LedgerNavigate;
	liveStats: LiveStats;
	oldestStartedAt: number | null;
	cleanupReferenceTime: number;
	configuredAgents: Awaited<ReturnType<typeof getAgentListFn>>;
}) {
	const { page, size, q, agent, model, provider, stop, range, from, to, sort } =
		listState;
	const totalPages = Math.max(
		1,
		Math.ceil(mutations.sessionsData.total / size),
	);

	function navigateList(
		next: Partial<ListState>,
		replace = false,
		resetScroll = false,
	) {
		navigate({
			to: "/ledger",
			search: {
				tab: "sessions",
				page,
				size,
				q,
				agent,
				model,
				provider,
				stop,
				range,
				from,
				to,
				sort,
				...next,
			},
			replace,
			resetScroll,
		});
	}

	function onPageChange(p: number) {
		navigateList({ page: Math.max(1, Math.min(totalPages, p)) }, false, true);
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

	const agentOptions = buildLedgerAgentOptions(
		configuredAgents,
		mutations.sessionsData.agent_cwds ?? [],
	);

	return (
		<div>
			{/* Always rendered — shows the "all quiet" empty state when idle. */}
			<div
				className={
					sessionsStatus.some((session) => session.state === "running")
						? "sticky top-0 z-20 border-b border-border"
						: "border-b border-border"
				}
			>
				<ActiveSessionsPanel
					sessions={sessionsStatus}
					onStop={live.handleStopSession}
					onClose={live.handleCloseSession}
					onNavigate={(id) =>
						navigate({
							to: "/raven",
							search: { session: id, agent: undefined },
						})
					}
				/>
			</div>
			<div className="p-5">
				<SessionsLedger
					data={mutations.sessionsData}
					page={page}
					pageSize={size}
					pageSizeOptions={VALID_PAGE_SIZES}
					totalPages={totalPages}
					loading={false}
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
					agentFilter={agent}
					agentOptions={agentOptions}
					onAgentFilterChange={(nextAgent) =>
						// Model facets depend on the owner; clear a stale model atomically.
						navigateList({ page: 1, agent: nextAgent, model: "" })
					}
					modelFilter={model}
					modelOptions={mutations.sessionsData.models ?? []}
					onModelFilterChange={(nextModel) =>
						navigateList({ page: 1, model: nextModel })
					}
					onClearFilters={() =>
						navigateList({ page: 1, q: "", agent: "", model: "" })
					}
					oldestStartedAt={oldestStartedAt}
					cleanupReferenceTime={cleanupReferenceTime}
					onExport={(format) => void onExport(format)}
				/>
			</div>
		</div>
	);
}

function StatsPage() {
	const { initialSessions, activeSession, configuredAgents, renderedAt } =
		Route.useLoaderData();
	const search = Route.useSearch();
	const { tab } = search;
	const listState: ListState = {
		page: search.page ?? 1,
		size: search.size ?? 20,
		q: search.q ?? "",
		agent: search.agent ?? "",
		model: search.model ?? "",
		provider: search.provider ?? "",
		stop: search.stop ?? "",
		range: search.range ?? "30d",
		from: search.from ?? "",
		to: search.to ?? "",
		sort: search.sort ?? "recent",
	};
	const navigate = useNavigate();
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
		enabled: tab === "sessions",
	});
	const mutations = useLedgerMutations(listState, sessionPage, navigate);
	mutationsRef.current = mutations;
	const refreshVisibleSessions = useCallback(
		() => (tab === "sessions" ? refreshSessions() : Promise.resolve()),
		[tab, refreshSessions],
	);
	useSessionStatusRefresh(sessionsStatus, refreshVisibleSessions);
	const statsFilter = useMemo(
		() => ({
			range: listState.range,
			agent: listState.agent || undefined,
			provider: listState.provider || undefined,
			model: listState.model || undefined,
			from:
				listState.range === "custom" ? listState.from || undefined : undefined,
			to: listState.range === "custom" ? listState.to || undefined : undefined,
		}),
		[
			listState.range,
			listState.agent,
			listState.provider,
			listState.model,
			listState.from,
			listState.to,
		],
	);
	const ledgerStats = useLedgerStatsData(
		tab === "stats",
		renderedAt,
		statsFilter,
	);
	const live = useLedgerLiveData(
		activeSession,
		tab === "stats" ? ledgerStats.refresh : undefined,
	);

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
				{tab === "stats" ? (
					<StatsTab
						analytics={ledgerStats.analytics}
						analyticsStatus={ledgerStats.analyticsStatus}
						listState={listState}
						navigate={navigate}
						configuredAgents={configuredAgents ?? []}
					/>
				) : (
					<>
						<ActiveSessionStatGrid
							stats={stats}
							activeSession={live.activeSessionData}
							model={live.model}
							actualModel={live.actualModel}
						/>
						<SessionsTab
							sessionsStatus={sessionsStatus}
							live={live}
							mutations={mutations}
							listState={listState}
							navigate={navigate}
							liveStats={stats}
							oldestStartedAt={sessionPage.oldest_started_at ?? null}
							cleanupReferenceTime={renderedAt}
							configuredAgents={configuredAgents ?? []}
						/>
					</>
				)}
			</div>
		</div>
	);
}

// ─── Stats tab content ────────────────────────────────────────────────────────

function StatsDataState({
	status,
	label,
}: {
	status: Exclude<LedgerStatsSourceStatus, "ready">;
	label: string;
}) {
	return (
		<div className="grid min-h-36 place-items-center border border-border bg-card px-4 text-center text-[10px] tracking-widest text-muted-foreground/60 uppercase">
			{status === "loading" ? `Loading ${label}…` : `${label} unavailable`}
		</div>
	);
}

function StatsTab({
	analytics,
	analyticsStatus,
	listState,
	navigate,
	configuredAgents,
}: {
	analytics: LedgerAnalytics | null;
	analyticsStatus: LedgerStatsSourceStatus;
	listState: ListState;
	navigate: LedgerNavigate;
	configuredAgents: Awaited<ReturnType<typeof getAgentListFn>>;
}) {
	const agentOptions = buildLedgerAgentOptions(
		configuredAgents,
		analytics?.facets.agents ?? [],
	);
	const selected = analytics?.selected;
	const pricedQueries = selected
		? Math.max(0, selected.queries - (selected.unpriced_queries ?? 0))
		: 0;
	const avgCost =
		selected && pricedQueries > 0
			? `$${(totalDisplayCost(selected) / pricedQueries).toFixed(4)}`
			: "--";
	const pricedCoverage =
		selected && selected.queries > 0
			? `${((pricedQueries / selected.queries) * 100).toFixed(1)}%`
			: "--";
	const hitRate = selected
		? `${cacheHitPct(selected.input_tokens, selected.cache_read_tokens, selected.cache_creation_tokens)}%`
		: "--";
	const nonCacheTokens = selected
		? selected.input_tokens + selected.output_tokens
		: 0;
	const totalTokens = selected
		? nonCacheTokens +
			selected.cache_read_tokens +
			selected.cache_creation_tokens
		: 0;
	const rangeLabel =
		listState.range === "all"
			? "All-time"
			: listState.range === "today"
				? "Today"
				: listState.range === "custom"
					? listState.from && listState.to
						? `${listState.from} – ${listState.to}`
						: "Custom range"
					: listState.range.toUpperCase();

	function setFilter(patch: Partial<ListState>) {
		navigate({
			to: "/ledger",
			search: { ...listState, ...patch, tab: "stats", page: 1 },
			replace: true,
			resetScroll: false,
		});
	}

	function drillDown(patch: Partial<ListState>) {
		navigate({
			to: "/ledger",
			search: {
				...listState,
				...patch,
				tab: "sessions",
				page: 1,
				q: "",
				sort: "recent",
			},
		});
	}

	return (
		<div>
			<StatsFilterBar
				filters={listState}
				agentOptions={agentOptions}
				providers={analytics?.facets.providers ?? []}
				models={analytics?.facets.models ?? []}
				onChange={setFilter}
			/>
			{analyticsStatus !== "ready" || !analytics || !selected ? (
				<div className="p-5">
					<StatsDataState
						status={
							analyticsStatus === "ready" ? "unavailable" : analyticsStatus
						}
						label="filtered analytics"
					/>
				</div>
			) : (
				<div className="space-y-3 p-3 sm:p-5">
					<StatsSection
						title="Overview"
						summary={`${rangeLabel} · ${selected.queries} queries`}
						open
						privacySensitive
					>
						<div className="grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-3 lg:grid-cols-6">
							<MetricTile
								label="Cost"
								value={formatDisplayCost(selected)}
								sub={costDisplayNote(selected)}
							/>
							<MetricTile label="Avg cost / priced query" value={avgCost} />
							<MetricTile label="Cache hit rate" value={hitRate} />
							<MetricTile
								label="Priced coverage"
								value={pricedCoverage}
								sub={`${pricedQueries}/${selected.queries} queries`}
							/>
							<MetricTile
								label="Queries"
								value={String(selected.queries)}
								sub="completed query records"
							/>
							<MetricTile
								label="Sessions"
								value={String(selected.sessions)}
								sub="distinct sessions with queries"
							/>
						</div>
						<div className="border border-border bg-card">
							<div className="border-b border-border px-3 py-2 text-[8px] tracking-widest text-muted-foreground uppercase">
								Token counts
							</div>
							<div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-3 lg:grid-cols-6">
								<TokenCountTile
									label="Input"
									value={fmt(selected.input_tokens)}
								/>
								<TokenCountTile
									label="Output"
									value={fmt(selected.output_tokens)}
								/>
								<TokenCountTile
									label="Non-cache total"
									value={fmt(nonCacheTokens)}
									sub="input + output"
								/>
								<TokenCountTile
									label="Cache read"
									value={fmt(selected.cache_read_tokens)}
								/>
								<TokenCountTile
									label="Cache write"
									value={fmt(selected.cache_creation_tokens)}
								/>
								<TokenCountTile
									label="Total tokens"
									value={fmt(totalTokens)}
									sub="including cache"
								/>
							</div>
						</div>
						<ThirtyDayGraph
							data={analytics.trend}
							label={`${rangeLabel} query activity`}
						/>
					</StatsSection>

					<StatsSection title="Cost" summary="Token mix, cache, and efficiency">
						<CostBreakdown s={selected} />
					</StatsSection>

					<StatsSection
						title="Models"
						summary={`${analytics.modelSplit.length} used`}
						privacySensitive
					>
						<ModelSplitDonut
							data={analytics.modelSplit}
							onSelect={(model) => drillDown({ model, stop: "" })}
						/>
					</StatsSection>

					<StatsSection
						title="Tools"
						summary={`${analytics.topTools.length} ranked`}
						privacySensitive
					>
						<TopToolsChart data={analytics.topTools} />
					</StatsSection>

					<StatsSection
						title="Reliability"
						summary="Stop reasons and activity timing"
					>
						<div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
							<StopReasonDonut
								data={analytics.stopReasonSplit}
								onSelect={(stop) => drillDown({ stop })}
							/>
							<HourOfDayChart data={analytics.weekdayHour} />
						</div>
					</StatsSection>
				</div>
			)}
		</div>
	);
}

function StatsSection({
	title,
	summary,
	open = false,
	privacySensitive = false,
	children,
}: {
	title: string;
	summary: string;
	open?: boolean;
	privacySensitive?: boolean;
	children: ReactNode;
}) {
	const [expanded, setExpanded] = useState(open);
	return (
		<details
			className="group"
			open={expanded}
			onToggle={(event) => setExpanded(event.currentTarget.open)}
		>
			<summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 border border-border/60 bg-muted/5 px-3 sm:px-4">
				<span className="text-[10px] tracking-widest text-foreground/80 uppercase">
					{title}
				</span>
				<span className="flex items-center gap-2 text-[9px] text-muted-foreground">
					{privacySensitive ? (
						<PrivacyMask inline>{summary}</PrivacyMask>
					) : (
						<span>{summary}</span>
					)}
					<ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
				</span>
			</summary>
			{privacySensitive ? (
				<PrivacyMask className="space-y-3 pt-3">{children}</PrivacyMask>
			) : (
				<div className="space-y-3 pt-3">{children}</div>
			)}
		</details>
	);
}

function MetricTile({
	label,
	value,
	sub,
}: {
	label: string;
	value: string;
	sub?: string;
}) {
	return (
		<div className="min-h-24 bg-card p-3">
			<div className="text-[8px] tracking-widest text-muted-foreground uppercase">
				{label}
			</div>
			<div className="mt-1 text-lg font-semibold tabular-nums text-[var(--data)]">
				{value}
			</div>
			{sub && (
				<div className="mt-1 text-[9px] text-muted-foreground">{sub}</div>
			)}
		</div>
	);
}

function TokenCountTile({
	label,
	value,
	sub,
}: {
	label: string;
	value: string;
	sub?: string;
}) {
	return (
		<div className="min-h-16 bg-card px-3 py-2.5">
			<div className="text-[8px] tracking-widest text-muted-foreground uppercase">
				{label}
			</div>
			<div className="mt-1 text-sm font-medium tabular-nums text-foreground">
				{value}
			</div>
			{sub && <div className="text-[8px] text-muted-foreground">{sub}</div>}
		</div>
	);
}
