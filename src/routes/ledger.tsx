import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { ChevronDown, X } from "lucide-react";
import type { ReactNode } from "react";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { z } from "zod";
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
import type { LedgerAnalytics, LedgerAnalyticsFilter, SessionRow } from "#/db";
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
import { fmt } from "#/lib/formatters";
import { isLedgerOpenSession } from "#/lib/ledgerSessions";
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
import {
	forkSessionFn,
	getActiveSessionRowFn,
	getSessionRowsByIdsFn,
} from "#/lib/serverFns/sessions";
import { buildSessionExport, downloadContent } from "#/lib/sessionExport";
import type { ServerMessage } from "#/server/protocol";

// ─── server fns ──────────────────────────────────────────────────────────────

const ledgerSessionPageSchema = sessionPageSchema.extend({
	range: z.enum(["today", "7d", "30d", "90d", "all", "custom"]).optional(),
	from: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional(),
	to: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional(),
});

const EMPTY_SESSION_PAGE = {
	sessions: [] as SessionRow[],
	total: 0,
	oldest_started_at: null as number | null,
	agent_cwds: [] as string[],
	models: [] as string[],
};

const getSessionsPageFn = createServerFn({ method: "GET" })
	.validator((raw) => ledgerSessionPageSchema.parse(raw))
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
		if (data.range) params.set("range", data.range);
		if (data.from) params.set("from", data.from);
		if (data.to) params.set("to", data.to);
		if (data.sort && data.sort !== "recent") params.set("sort", data.sort);
		return dbJson<{
			sessions: SessionRow[];
			total: number;
			oldest_started_at: number | null;
			agent_cwds: string[];
			models: string[];
		}>(`/db/sessions?${params.toString()}`, EMPTY_SESSION_PAGE);
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

type ProviderHistoryImportResult = {
	plannedSessions: number;
	plannedQueries: number;
	createdSessions: number;
	insertedQueries: number;
	transcriptSessions: number;
	insertedMessages: number;
};

type ProviderHistoryImportJob =
	| { state: "idle"; jobId: null }
	| { state: "running"; jobId: string; startedAt: number }
	| {
			state: "completed";
			jobId: string;
			startedAt: number;
			completedAt: number;
			result: ProviderHistoryImportResult;
	  }
	| {
			state: "failed";
			jobId: string;
			startedAt: number;
			completedAt: number;
			error: string;
	  };

const importProviderHistoryFn = createServerFn({ method: "POST" }).handler(
	async () => {
		const res = await requireDbOk(
			await dbFetch("/db/provider-history/import", {
				method: "POST",
			}),
			"import provider history",
		);
		return res.json() as Promise<ProviderHistoryImportJob>;
	},
);

const getProviderHistoryImportStatusFn = createServerFn({ method: "GET" })
	.validator((raw) => z.string().uuid().parse(raw))
	.handler(async ({ data }) => {
		const res = await requireDbOk(
			await dbFetch(
				`/db/provider-history/import/status?job_id=${encodeURIComponent(data)}`,
			),
			"check provider history import",
		);
		return res.json() as Promise<ProviderHistoryImportJob>;
	});

const PROVIDER_IMPORT_POLL_MS = 500;
const PROVIDER_IMPORT_TIMEOUT_MS = 15 * 60_000;

async function waitForProviderHistoryImport(
	initial: ProviderHistoryImportJob,
): Promise<ProviderHistoryImportResult> {
	let status = initial;
	let lastPollError: unknown;
	const deadline = Date.now() + PROVIDER_IMPORT_TIMEOUT_MS;
	while (status.state === "running" && Date.now() < deadline) {
		await new Promise((resolve) =>
			setTimeout(resolve, PROVIDER_IMPORT_POLL_MS),
		);
		try {
			status = await getProviderHistoryImportStatusFn({ data: status.jobId });
			lastPollError = undefined;
		} catch (error) {
			// A dropped poll must not cancel the import running in the data server.
			lastPollError = error;
		}
	}
	if (status.state === "completed") return status.result;
	if (status.state === "failed") throw new Error(status.error);
	if (status.state === "idle") {
		throw new Error("Provider history import status was lost");
	}
	if (lastPollError instanceof Error) throw lastPollError;
	throw new Error("Provider history import is still running");
}

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
			tab,
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
		const configuredAgentsPromise = getAgentListFn();
		const [initialSessions, activeSession, configuredAgents] =
			tab === "stats"
				? [EMPTY_SESSION_PAGE, null, await configuredAgentsPromise]
				: await Promise.all([
						getSessionsPageFn({
							data: {
								page,
								size,
								q: q || undefined,
								agent: agent || undefined,
								model: model || undefined,
								provider: provider || undefined,
								stop: stop || undefined,
								range,
								from: range === "custom" ? from : undefined,
								to: range === "custom" ? to : undefined,
								sort,
							},
						}),
						getActiveSessionRowFn(),
						configuredAgentsPromise,
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

type OpenSessionTotals = {
	cost: number;
	estimatedCost: number;
	unpricedQueries: number;
	queries: number;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
};

function sumOpenSessionRows(rows: SessionRow[]): OpenSessionTotals {
	return rows.reduce<OpenSessionTotals>(
		(totals, row) => ({
			cost: totals.cost + row.total_cost,
			estimatedCost: totals.estimatedCost + (row.total_estimated_cost ?? 0),
			unpricedQueries: totals.unpricedQueries + (row.unpriced_query_count ?? 0),
			queries: totals.queries + row.query_count,
			turns: totals.turns + row.total_turns,
			inputTokens: totals.inputTokens + row.total_input_tokens,
			outputTokens: totals.outputTokens + row.total_output_tokens,
			cacheReadTokens: totals.cacheReadTokens + row.total_cache_read_tokens,
			cacheCreationTokens:
				totals.cacheCreationTokens + row.total_cache_creation_tokens,
		}),
		{
			cost: 0,
			estimatedCost: 0,
			unpricedQueries: 0,
			queries: 0,
			turns: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
		},
	);
}

function unavailableStat(): ActiveStat {
	return { value: "--", dim: true };
}

function openCostStat(totals: OpenSessionTotals, ready: boolean): ActiveStat {
	if (!ready) return unavailableStat();
	const pricedQueries = Math.max(0, totals.queries - totals.unpricedQueries);
	const cost = {
		cost: totals.cost,
		estimated_cost: totals.estimatedCost,
		unpriced_queries: totals.unpricedQueries,
	};
	return {
		value: formatDisplayCost(cost),
		sub:
			costDisplayNote(cost) ??
			(pricedQueries > 0
				? `$${(totalDisplayCost(cost) / pricedQueries).toFixed(4)}/query`
				: undefined),
	};
}

function openQueryStat(totals: OpenSessionTotals, ready: boolean): ActiveStat {
	if (!ready) return unavailableStat();
	return {
		value: String(totals.queries),
		sub: totals.turns > 0 ? `${totals.turns} turns` : undefined,
	};
}

function openTokenStat(totals: OpenSessionTotals, ready: boolean): ActiveStat {
	if (!ready) return unavailableStat();
	const cached = totals.cacheReadTokens + totals.cacheCreationTokens;
	return {
		value: fmt(
			totals.inputTokens +
				totals.outputTokens +
				totals.cacheReadTokens +
				totals.cacheCreationTokens,
		),
		sub: cached > 0 ? `${fmt(cached)} cached` : undefined,
	};
}

function openSessionsStat(
	sessions: ReturnType<typeof getSessionsStatus>,
): ActiveStat {
	const running = sessions.filter(
		(session) => session.state === "running",
	).length;
	const errors = sessions.filter((session) => session.state === "error").length;
	const waiting = sessions.filter(
		(session) => session.hasPendingPermissions,
	).length;
	const detail = [
		running > 0 ? `${running} running` : undefined,
		waiting > 0 ? `${waiting} waiting` : undefined,
		errors > 0 ? `${errors} error${errors === 1 ? "" : "s"}` : undefined,
	]
		.filter((part): part is string => Boolean(part))
		.join(" · ");
	return {
		value: String(sessions.length),
		sub: detail || "all idle",
	};
}

function OpenSessionsStatGrid({
	rows,
	ready,
	sessions,
}: {
	rows: SessionRow[];
	ready: boolean;
	sessions: ReturnType<typeof getSessionsStatus>;
}) {
	const openSessionStatuses = sessions.filter(isLedgerOpenSession);
	const totals = sumOpenSessionRows(rows);
	const cost = openCostStat(totals, ready);
	const queries = openQueryStat(totals, ready);
	const tokens = openTokenStat(totals, ready);
	const openSessions = openSessionsStat(openSessionStatuses);
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
				<StatCell label="SESSIONS" {...openSessions} />
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
	rangeActive: boolean,
	reloadCurrentPage: () => Promise<void>,
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
			forkSession: async (id: string) => {
				await forkSessionFn({ data: { id } });
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
						range: rangeActive ? range : undefined,
						from: rangeActive && range === "custom" ? from : undefined,
						to: rangeActive && range === "custom" ? to : undefined,
						sort,
					},
				});
			},
			reloadCurrentPage,
		}),
		[
			navigate,
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
			rangeActive,
			reloadCurrentPage,
		],
	);
	return useLedgerSessionMutations({ page, sessionPage, dependencies });
}

function useSessionListSync({
	listState,
	initialSessions,
	reconcile,
	enabled,
	rangeActive,
}: {
	listState: ListState;
	initialSessions: Awaited<ReturnType<typeof getSessionsPageFn>>;
	reconcile: (fresh: Awaited<ReturnType<typeof getSessionsPageFn>>) => void;
	enabled: boolean;
	rangeActive: boolean;
}) {
	const [sessionPage, setSessionPage] = useState(initialSessions);
	// Mutate refs during render so they're always current before any event
	// handler fires. useEffect would lag by one render cycle, causing
	// refreshSessions to fetch with stale page/size if a `done` event arrives
	// between render and effect commit.
	const requestStateRef = useRef({ listState, rangeActive });
	requestStateRef.current = { listState, rangeActive };

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
		rangeActive ? listState.range : "",
		rangeActive && listState.range === "custom" ? listState.from : "",
		rangeActive && listState.range === "custom" ? listState.to : "",
		listState.sort,
	].join("\u0000");
	const lastFetchedKeyRef = useRef(requestKey);
	const wasEnabledRef = useRef(enabled);

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
		const { listState: current, rangeActive: currentRangeActive } =
			requestStateRef.current;
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
		} = current;
		const fresh = await getSessionsPageFn({
			data: {
				page,
				size,
				q: q || undefined,
				agent: agent || undefined,
				model: model || undefined,
				provider: provider || undefined,
				stop: stop || undefined,
				range: currentRangeActive ? range : undefined,
				from:
					currentRangeActive && range === "custom"
						? from || undefined
						: undefined,
				to:
					currentRangeActive && range === "custom"
						? to || undefined
						: undefined,
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
		const becameEnabled = enabled && !wasEnabledRef.current;
		wasEnabledRef.current = enabled;
		if (
			!enabled ||
			(!becameEnabled && lastFetchedKeyRef.current === requestKey)
		)
			return;
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

function useOpenSessionRows(
	sessionsStatus: ReturnType<typeof getSessionsStatus>,
) {
	const dbSessionIds = useMemo(
		() =>
			[
				...new Set(
					sessionsStatus
						.filter(isLedgerOpenSession)
						.flatMap((session) =>
							session.db_session_id ? [session.db_session_id] : [],
						),
				),
			].sort(),
		[sessionsStatus],
	);
	const sessionKey = dbSessionIds.join("\u0000");
	const [snapshot, setSnapshot] = useState<{
		key: string;
		rows: SessionRow[];
	}>({ key: "", rows: [] });
	const requestVersionRef = useRef(0);

	const refresh = useCallback(async () => {
		const version = ++requestVersionRef.current;
		if (dbSessionIds.length === 0) {
			setSnapshot({ key: sessionKey, rows: [] });
			return;
		}
		try {
			const rows = await getSessionRowsByIdsFn({ data: dbSessionIds });
			if (requestVersionRef.current === version) {
				setSnapshot({ key: sessionKey, rows });
			}
		} catch {
			// Keep the last matching snapshot during a transient DB/API failure.
		}
	}, [dbSessionIds, sessionKey]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	return {
		rows: snapshot.key === sessionKey ? snapshot.rows : [],
		ready: snapshot.key === sessionKey,
		refresh,
	};
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

	const { send: sendWs } = useWs(
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
		handleStopSession,
		handleCloseSession,
	};
}

function LedgerTabBar({
	tab,
	listState,
	navigate,
	rangeActive,
}: {
	tab: "stats" | "sessions";
	listState: ListState;
	navigate: LedgerNavigate;
	rangeActive: boolean;
}) {
	const { page, size, q, agent, model, provider, stop, range, from, to, sort } =
		listState;
	function switchTab(next: "stats" | "sessions") {
		if (next === "sessions") {
			const preserveStatsRange = tab === "stats" || rangeActive;
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
					range: preserveStatsRange ? range : undefined,
					from: preserveStatsRange && range === "custom" ? from : undefined,
					to: preserveStatsRange && range === "custom" ? to : undefined,
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
					// Stop reason is a Sessions drill-down, not a visible Stats
					// filter. Do not carry a hidden, ignored constraint back.
					stop: "",
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
	rangeActive,
	refreshSessions,
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
	rangeActive: boolean;
	refreshSessions: () => Promise<void>;
}) {
	const [claudeImportBusy, setClaudeImportBusy] = useState(false);
	const [claudeImportStatus, setClaudeImportStatus] = useState<string | null>(
		null,
	);
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
				range: rangeActive ? range : undefined,
				from: rangeActive && range === "custom" ? from : undefined,
				to: rangeActive && range === "custom" ? to : undefined,
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

	async function onImportClaude() {
		setClaudeImportBusy(true);
		setClaudeImportStatus(null);
		try {
			const job = await importProviderHistoryFn();
			const result = await waitForProviderHistoryImport(job);
			await refreshSessions();
			const changed = result.insertedQueries + result.insertedMessages;
			setClaudeImportStatus(
				changed > 0
					? `Imported/upgraded ${result.transcriptSessions} resumable sessions (${result.insertedMessages} messages, ${result.insertedQueries} queries).`
					: "Provider history is already up to date.",
			);
		} catch (error) {
			setClaudeImportStatus(
				error instanceof Error
					? error.message
					: "Provider history import failed",
			);
		} finally {
			setClaudeImportBusy(false);
		}
	}

	const agentOptions = buildLedgerAgentOptions(
		configuredAgents,
		mutations.sessionsData.agent_cwds ?? [],
	);
	const rangeLabel =
		range === "all"
			? "All time"
			: range === "today"
				? "Today"
				: range === "custom"
					? from && to
						? `${from} – ${to}`
						: "Custom range"
					: `Last ${range.slice(0, -1)} days`;
	const hasDrilldownFilters = Boolean(provider || stop || rangeActive);
	const clearAllFilters = () =>
		navigateList({
			page: 1,
			q: "",
			agent: "",
			model: "",
			provider: "",
			stop: "",
			range: undefined,
			from: undefined,
			to: undefined,
		});

	return (
		<div>
			{/* Always rendered — shows the "all quiet" empty state when idle. */}
			<div
				className={
					sessionsStatus.some((session) => session.state === "running")
						? "sticky top-0 z-30 border-b border-border bg-background"
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
				{hasDrilldownFilters && (
					<fieldset
						className="mb-3 flex flex-wrap items-center gap-2 border border-border bg-muted/10 px-3 py-2"
						aria-label="Active session drill-down filters"
					>
						<span className="text-[8px] tracking-widest text-muted-foreground uppercase">
							Stats drill-down
						</span>
						{rangeActive && (
							<button
								type="button"
								onClick={() =>
									navigateList({
										page: 1,
										range: undefined,
										from: undefined,
										to: undefined,
									})
								}
								className="border border-border px-2 py-1 text-[9px] text-foreground/70 hover:border-primary/40"
								aria-label="Clear session date filter"
							>
								Date: {rangeLabel} ×
							</button>
						)}
						{provider && (
							<button
								type="button"
								onClick={() => navigateList({ page: 1, provider: "" })}
								className="border border-border px-2 py-1 text-[9px] text-foreground/70 hover:border-primary/40"
								aria-label="Clear session provider filter"
							>
								Provider: {provider} ×
							</button>
						)}
						{stop && (
							<button
								type="button"
								onClick={() => navigateList({ page: 1, stop: "" })}
								className="border border-border px-2 py-1 text-[9px] text-foreground/70 hover:border-primary/40"
								aria-label="Clear session stop reason filter"
							>
								Stop: {stop.replace(/_/g, " ")} ×
							</button>
						)}
						<button
							type="button"
							onClick={clearAllFilters}
							className="ml-auto text-[8px] tracking-widest text-muted-foreground uppercase hover:text-foreground"
						>
							Clear all
						</button>
					</fieldset>
				)}
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
					onFork={mutations.forkSession}
					forkingIds={mutations.forkingIds}
					onNavigate={(id) =>
						navigate({
							to: "/raven",
							search: { session: id, agent: undefined },
						})
					}
					onCleanup={mutations.cleanupSessions}
					activeSessionId={live.activeSessionData?.id}
					activeSession={live.activeSessionData}
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
					onClearFilters={clearAllFilters}
					oldestStartedAt={oldestStartedAt}
					cleanupReferenceTime={cleanupReferenceTime}
					onExport={(format) => void onExport(format)}
					onImportClaude={() => void onImportClaude()}
					claudeImportStatus={claudeImportStatus}
					claudeImportBusy={claudeImportBusy}
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
	const sessionRangeActive = search.range !== undefined;
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
		rangeActive: sessionRangeActive,
	});
	// Same forward-reference problem as mutationsRef above: mutations needs a
	// stable reloadCurrentPage callback before refreshVisibleSessions (which
	// depends on refreshSessions/tab) is computed below.
	const refreshVisibleSessionsRef = useRef<() => Promise<void>>(() =>
		Promise.resolve(),
	);
	const reloadCurrentPage = useCallback(
		() => refreshVisibleSessionsRef.current(),
		[],
	);
	const mutations = useLedgerMutations(
		listState,
		sessionPage,
		navigate,
		sessionRangeActive,
		reloadCurrentPage,
	);
	mutationsRef.current = mutations;
	const refreshVisibleSessions = useCallback(
		() => (tab === "sessions" ? refreshSessions() : Promise.resolve()),
		[tab, refreshSessions],
	);
	refreshVisibleSessionsRef.current = refreshVisibleSessions;
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
	const openSessionRows = useOpenSessionRows(sessionsStatus);
	const refreshAfterDone = useCallback(() => {
		void openSessionRows.refresh();
		if (tab === "stats") void ledgerStats.refresh();
	}, [ledgerStats.refresh, openSessionRows.refresh, tab]);
	const live = useLedgerLiveData(activeSession, refreshAfterDone);

	return (
		<div className="flex flex-col h-full">
			<LedgerTabBar
				tab={tab}
				listState={listState}
				navigate={navigate}
				rangeActive={sessionRangeActive}
			/>
			{mutations.mutationError && (
				<div
					className="border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive"
					role="alert"
				>
					{mutations.mutationError}
				</div>
			)}
			{!mutations.mutationError && mutations.forkStatus && (
				<output className="flex items-center justify-between gap-3 border-b border-primary/30 bg-primary/5 px-4 py-2 text-xs text-primary">
					{mutations.forkStatus}
					<button
						type="button"
						onClick={mutations.dismissForkStatus}
						aria-label="Dismiss"
						className="shrink-0 text-primary/60 hover:text-primary"
					>
						<X className="h-3 w-3" />
					</button>
				</output>
			)}

			<div
				data-scroll-restoration-id={ROUTE_SCROLL_RESTORATION_IDS.ledgerList}
				data-scroll-to-top="route"
				className="flex-1 overflow-auto"
			>
				{tab === "stats" ? (
					<StatsTab
						analytics={ledgerStats.analytics ?? ledgerStats.staleAnalytics}
						analyticsStatus={ledgerStats.analyticsStatus}
						analyticsRefreshing={Boolean(
							!ledgerStats.analytics && ledgerStats.staleAnalytics,
						)}
						analyticsFilter={statsFilter}
						listState={listState}
						navigate={navigate}
						configuredAgents={configuredAgents ?? []}
					/>
				) : (
					<>
						<OpenSessionsStatGrid
							rows={openSessionRows.rows}
							ready={openSessionRows.ready}
							sessions={sessionsStatus}
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
							rangeActive={sessionRangeActive}
							refreshSessions={refreshSessions}
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
	analyticsRefreshing,
	analyticsFilter,
	listState,
	navigate,
	configuredAgents,
}: {
	analytics: LedgerAnalytics | null;
	analyticsStatus: LedgerStatsSourceStatus;
	analyticsRefreshing: boolean;
	analyticsFilter: LedgerAnalyticsFilter;
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
			{(!analyticsRefreshing && analyticsStatus !== "ready") ||
			!analytics ||
			!selected ? (
				<div className="p-5">
					<StatsDataState
						status={
							analyticsStatus === "ready" ? "unavailable" : analyticsStatus
						}
						label="filtered analytics"
					/>
				</div>
			) : (
				<div className="relative">
					{analyticsRefreshing && (
						<output className="pointer-events-none absolute right-3 top-3 z-10 border border-border bg-background/95 px-2 py-1 text-[8px] tracking-widest text-muted-foreground uppercase shadow-sm sm:right-5 sm:top-5">
							Updating filtered analytics…
						</output>
					)}
					<div
						className={`space-y-3 p-3 sm:p-5 ${analyticsRefreshing ? "pointer-events-none" : ""}`}
						aria-busy={analyticsRefreshing}
					>
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

						<StatsSection
							title="Cost"
							summary="Token mix, cache, and efficiency"
						>
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
							<TopToolsChart
								data={analytics.topTools}
								filter={analyticsFilter}
							/>
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
