import {
	createFileRoute,
	useNavigate,
	useRouterState,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { Bar, Row, StatCell, UtilBar } from "#/components/ledger/LedgerStats";
import { SessionsLedger } from "#/components/ledger/SessionsLedger";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { AggStats, SessionRow } from "#/db";
import { useWs } from "#/hooks/useWs";
import { useWsLiveStats } from "#/hooks/useWsSelectors";
import { dbFetch, dbJson } from "#/lib/dbClient";
import { fmt, fmtModel, fmtMs, fmtResetTime } from "#/lib/formatters";
import { EMPTY_AGG } from "#/lib/serverFns";
import { uid } from "#/lib/utils";
import type { RateLimitMessage, ServerMessage } from "#/server/protocol";

// ─── constants ───────────────────────────────────────────────────────────────

const BUILD_SKILL_PROMPT = `Create a vault skill for the hlid session management API.

Read \`hlid.config.toml\` to find \`server.port\`. The data API runs on that port + 1.

Endpoints:
  GET  /db/sessions?page=N&size=N
  GET  /db/session-messages?session_id=ID
  GET  /db/recent-sessions?limit=N
  GET  /db/stats
  GET  /db/current-session
  GET  /db/weekly-stats
  GET  /db/thirty-day-stats
  GET  /db/usage-windows
  DELETE /db/session?id=ID
  POST /db/sessions/cleanup  { older_than_days: N }

Create a skill file in the vault's skills folder (\`vault.skillsFolder\` in config, default \`.claude/skills\`). Add YAML frontmatter with \`name\` and \`description\` fields.

Register the skill in the vault's skills/index.md under an appropriate section using the pipe table format:
## Section Name
| \`skill-name\` | one-line description |`;

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
	validateSearch: (search: Record<string, unknown>) => ({
		page:
			typeof search.page === "number"
				? Math.max(1, Math.floor(search.page))
				: 1,
	}),
	loaderDeps: ({ search: { page } }) => ({ page }),
	loader: async ({ deps: { page } }) => {
		const [statsData, initialSessions] = await Promise.all([
			getStatsDataFn(),
			getSessionsPageFn({ data: { page, size: PAGE_SIZE } }),
		]);
		return { statsData, initialSessions, page };
	},
	component: StatsPage,
});

// ─── page ─────────────────────────────────────────────────────────────────────

function StatsPage() {
	const { statsData, initialSessions, page } = Route.useLoaderData();
	const navigate = useNavigate();
	const isRouterLoading = useRouterState({
		select: (s) => s.status === "pending",
	});
	const stats = useWsLiveStats();
	const [rateLimit, setRateLimit] = useState<RateLimitMessage | null>(null);
	const { wsStatus, model, send } = useWs((msg: ServerMessage) => {
		if (msg.type === "rate_limit") setRateLimit(msg);
	});

	const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on page nav
	useEffect(() => {
		setDeletedIds(new Set());
	}, [page]);

	const sessionsData = {
		sessions: initialSessions.sessions.filter((s) => !deletedIds.has(s.id)),
		total: initialSessions.total - deletedIds.size,
	};
	const totalPages = Math.ceil(sessionsData.total / PAGE_SIZE);

	function onPageChange(p: number) {
		navigate({ to: "/ledger", search: { page: p } });
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
			navigate({ to: "/ledger", search: { page: page - 1 } });
		}
	}

	async function handleCleanup(days: number) {
		await cleanupSessionsFn({ data: { days } });
		navigate({ to: "/ledger", search: { page: 1 } });
	}

	function handleBuildSkill() {
		send({
			type: "chat",
			text: BUILD_SKILL_PROMPT,
			session_id: uid(),
		});
	}

	const totalInput =
		stats.input_tokens + stats.cache_read_tokens + stats.cache_creation_tokens;
	const cacheHitPct =
		totalInput > 0
			? ((stats.cache_read_tokens / totalInput) * 100).toFixed(0)
			: "0";
	const avgCostPerQuery = stats.queries > 0 ? stats.cost / stats.queries : 0;
	const connected = wsStatus === "connected";
	const idle = stats.queries === 0;

	const { agg } = statsData;

	return (
		<div className="flex flex-col h-full">
			<div className="flex-1 overflow-auto">
				{/* Live session stat grid */}
				<div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-y divide-border border-b border-border">
					<StatCell
						label="COST"
						value={
							connected || stats.cost > 0 ? `$${stats.cost.toFixed(4)}` : "--"
						}
						sub={
							stats.queries > 0
								? `$${avgCostPerQuery.toFixed(4)}/query`
								: undefined
						}
						dim={!connected && stats.cost === 0}
					/>
					<StatCell
						label="QUERIES"
						value={idle ? "--" : String(stats.queries)}
						sub={stats.turns > 0 ? `${stats.turns} turns` : undefined}
						dim={idle}
					/>
					<StatCell
						label="DURATION"
						value={idle ? "--" : fmtMs(stats.duration_ms)}
						dim={idle}
					/>
					<StatCell
						label="MODEL"
						value={model ? fmtModel(model) : "--"}
						dim={!model}
					/>
				</div>

				<div className="p-5 space-y-5">
					{/* Usage windows, from DB */}
					<div className="border border-border bg-card">
						<div className="px-4 py-3 border-b border-border">
							<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
								USAGE WINDOWS
							</div>
						</div>
						<div className="grid grid-cols-2 divide-x divide-border">
							<div className="p-4 space-y-1">
								<div className="text-[9px] tracking-widest text-muted-foreground/50 uppercase">
									Today
								</div>
								<PrivacyMask
									inline
									className="text-lg font-bold tabular-nums text-[var(--data)]"
								>
									${agg.today.cost.toFixed(4)}
								</PrivacyMask>
								<PrivacyMask className="text-[10px] text-muted-foreground/50">
									{agg.today.queries} queries · {fmt(agg.today.tokens)} tok
								</PrivacyMask>
							</div>
							<div className="p-4 space-y-1">
								<div className="text-[9px] tracking-widest text-muted-foreground/50 uppercase">
									This Month
								</div>
								<PrivacyMask
									inline
									className="text-lg font-bold tabular-nums text-[var(--data)]"
								>
									${agg.thisMonth.cost.toFixed(4)}
								</PrivacyMask>
								<PrivacyMask className="text-[10px] text-muted-foreground/50">
									{agg.thisMonth.queries} queries · {fmt(agg.thisMonth.tokens)}{" "}
									tok
								</PrivacyMask>
							</div>
						</div>
					</div>

					{/* Rate limit, from WS, only shown when available */}
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
								{rateLimit.resetsAt != null && (
									<div className="flex items-center justify-between">
										<span className="text-[10px] tracking-widest text-muted-foreground uppercase">
											Resets In
										</span>
										<span className="text-[11px] tabular-nums text-foreground/70">
											{fmtResetTime(rateLimit.resetsAt)}
										</span>
									</div>
								)}
							</div>
						</div>
					)}

					{/* Context window, live */}
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

					{/* Token breakdown, live session */}
					<div className="border border-border bg-card">
						<div className="px-4 py-3 border-b border-border">
							<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
								TOKEN USAGE · THIS SESSION
							</div>
						</div>
						<Row label="Input" value={idle ? "--" : fmt(stats.input_tokens)} />
						<Row
							label="Output"
							value={idle ? "--" : fmt(stats.output_tokens)}
						/>
						<Row
							label="Cache read"
							value={idle ? "--" : fmt(stats.cache_read_tokens)}
						/>
						<Row
							label="Cache creation"
							value={idle ? "--" : fmt(stats.cache_creation_tokens)}
						/>
						<Row
							label="Cache hit rate"
							value={idle ? "--" : `${cacheHitPct}%`}
						/>
						<Row
							label="Total"
							value={
								idle ? "--" : fmt(stats.input_tokens + stats.output_tokens)
							}
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

					{/* All-time totals, from DB */}
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
						<Row
							label="Cache read"
							value={fmt(agg.allTime.cache_read_tokens)}
						/>
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

					{/* Paginated sessions ledger */}
					<SessionsLedger
						data={sessionsData}
						page={page}
						totalPages={totalPages}
						loading={isRouterLoading}
						onPageChange={onPageChange}
						onDelete={handleDeleteSession}
						onNavigate={(id) =>
							navigate({
								to: "/raven",
								search: { session: id, agent: undefined },
							})
						}
						onCleanup={handleCleanup}
						onBuildSkill={handleBuildSkill}
						connected={connected}
					/>
				</div>
			</div>
		</div>
	);
}
