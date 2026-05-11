import {
	createFileRoute,
	useNavigate,
	useRouterState,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { ThirtyDayGraph } from "#/components/cockpit/ThirtyDayGraph";
import { Bar, Row, StatCell, UtilBar } from "#/components/ledger/LedgerStats";
import { SessionsLedger } from "#/components/ledger/SessionsLedger";
import {
	ContextWindowSection,
	ProviderUsageStrip,
} from "#/components/UsageWindowsPanel";
import type {
	AggStats,
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
	const tab = search.tab === "sessions" ? "sessions" : "stats";
	const page =
		typeof search.page === "number" ? Math.max(1, Math.floor(search.page)) : 1;
	return { tab, page };
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
	useWs((msg: ServerMessage) => {
		if (msg.type === "rate_limit") setRateLimit(msg);
	});

	const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());
	const [renamedLabels, setRenamedLabels] = useState<Map<string, string>>(
		new Map(),
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on page nav
	useEffect(() => {
		setDeletedIds(new Set());
		setRenamedLabels(new Map());
	}, [page]);

	const sessionsData = {
		sessions: initialSessions.sessions
			.filter((s) => !deletedIds.has(s.id))
			.map((s) =>
				renamedLabels.has(s.id)
					? { ...s, label: renamedLabels.get(s.id) as string }
					: s,
			),
		total: initialSessions.total - deletedIds.size,
	};
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
		navigate({ to: "/ledger", search: { tab: next, page: 1 } });
	}

	return (
		<div className="flex flex-col h-full">
			{/* Tab bar */}
			<div className="flex flex-wrap border-b border-border shrink-0">
				{(["stats", "sessions"] as const).map((t) => (
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

			{/* Active session stat grid */}
			<div className="grid grid-cols-2 sm:grid-cols-4 border-b border-border shrink-0">
				<div className="border-r border-b sm:border-b-0 border-border">
					<StatCell
						label="COST"
						value={
							activeSession ? `$${activeSession.total_cost.toFixed(4)}` : "--"
						}
						sub={
							activeSession && activeSession.query_count > 0
								? `$${(activeSession.total_cost / activeSession.query_count).toFixed(4)}/query`
								: undefined
						}
						dim={!activeSession}
					/>
				</div>
				<div className="border-b sm:border-b-0 sm:border-r border-border">
					<StatCell
						label="QUERIES"
						value={activeSession ? String(activeSession.query_count) : "--"}
						sub={
							activeSession && activeSession.total_turns > 0
								? `${activeSession.total_turns} turns`
								: undefined
						}
						dim={!activeSession}
					/>
				</div>
				<div className="border-r border-border">
					<StatCell
						label="TOKENS"
						value={
							activeSession
								? fmt(
										activeSession.total_input_tokens +
											activeSession.total_output_tokens,
									)
								: "--"
						}
						sub={
							activeSession &&
							activeSession.total_cache_read_tokens +
								activeSession.total_cache_creation_tokens >
								0
								? `${fmt(activeSession.total_cache_read_tokens + activeSession.total_cache_creation_tokens)} cached`
								: undefined
						}
						dim={!activeSession}
					/>
				</div>
				<div>
					<StatCell
						label="MODEL"
						value={activeSession?.model ? fmtModel(activeSession.model) : "--"}
						dim={!activeSession?.model}
					/>
				</div>
			</div>

			<div className="flex-1 overflow-auto">
				{tab === "stats" ? (
					<StatsTab
						agg={agg}
						stats={stats}
						rateLimit={rateLimit}
						providerUsages={providerUsages}
						providerIds={providerIds}
						thirtyDayStats={thirtyDayStats}
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

function StatsTab({
	agg,
	stats,
	rateLimit,
	providerUsages,
	providerIds,
	thirtyDayStats,
}: {
	agg: AggStats;
	stats: LiveStats;
	rateLimit: RateLimitMessage | null;
	providerUsages: ProviderUsageSnapshot[];
	providerIds: string[];
	thirtyDayStats: ThirtyDayStats;
}) {
	const idle = stats.queries === 0;
	const totalInput =
		stats.input_tokens + stats.cache_read_tokens + stats.cache_creation_tokens;
	const cacheHitPct =
		totalInput > 0
			? ((stats.cache_read_tokens / totalInput) * 100).toFixed(0)
			: "0";

	return (
		<div>
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
				{/* Rate limit */}
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

				{/* Context window — last query */}
				{stats.last_context_used != null &&
					stats.context_window != null &&
					stats.max_output_tokens != null && (
						<div className="border border-border bg-card p-4 space-y-4">
							<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
								CONTEXT · LAST QUERY
							</div>
							<Bar
								label="Context used"
								value={stats.last_context_used}
								max={stats.context_window}
							/>
							<Bar
								label="Output cap"
								value={stats.last_output_tokens ?? 0}
								max={stats.max_output_tokens}
							/>
						</div>
					)}

				{/* Token breakdown — live session */}
				<div className="border border-border bg-card">
					<div className="px-4 py-3 border-b border-border">
						<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
							TOKEN USAGE · THIS SESSION
						</div>
					</div>
					<Row label="Input" value={idle ? "--" : fmt(stats.input_tokens)} />
					<Row label="Output" value={idle ? "--" : fmt(stats.output_tokens)} />
					<Row
						label="Cache read"
						value={idle ? "--" : fmt(stats.cache_read_tokens)}
					/>
					<Row
						label="Cache creation"
						value={idle ? "--" : fmt(stats.cache_creation_tokens)}
					/>
					<Row label="Cache hit rate" value={idle ? "--" : `${cacheHitPct}%`} />
					<Row
						label="Total"
						value={idle ? "--" : fmt(stats.input_tokens + stats.output_tokens)}
					/>
					<Row
						label="Total w/ cache"
						value={
							idle
								? "--"
								: fmt(
										stats.input_tokens +
											stats.output_tokens +
											stats.cache_read_tokens +
											stats.cache_creation_tokens,
									)
						}
					/>
				</div>

				{/* All-time totals */}
				<div className="border border-border bg-card">
					<div className="px-4 py-3 border-b border-border">
						<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
							ALL-TIME
						</div>
					</div>
					<Row label="Total Cost" value={`$${agg.allTime.cost.toFixed(4)}`} />
					<Row label="Queries" value={String(agg.allTime.queries)} />
					<Row label="Turns" value={String(agg.allTime.turns)} />
					<Row label="Input" value={fmt(agg.allTime.input_tokens)} />
					<Row label="Output" value={fmt(agg.allTime.output_tokens)} />
					<Row label="Cache read" value={fmt(agg.allTime.cache_read_tokens)} />
					<Row
						label="Cache creation"
						value={fmt(agg.allTime.cache_creation_tokens)}
					/>
					<Row
						label="Total"
						value={fmt(
							agg.allTime.input_tokens +
								agg.allTime.output_tokens +
								agg.allTime.cache_read_tokens +
								agg.allTime.cache_creation_tokens,
						)}
					/>
				</div>
			</div>
		</div>
	);
}
