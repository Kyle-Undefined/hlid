import {
	createFileRoute,
	useNavigate,
	useRouterState,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useEffect, useState, useSyncExternalStore } from "react";
import { getConfig } from "#/config";
import type { AggStats, SessionRow } from "#/db";
import { useWs } from "#/hooks/useWs";
import * as wsStore from "#/hooks/wsStore";
import { uid } from "#/lib/utils";
import type { RateLimitMessage, ServerMessage } from "#/server/protocol";

// ─── server fns ──────────────────────────────────────────────────────────────

const getStatsDataFn = createServerFn({ method: "GET" }).handler(async () => {
	const { server } = await getConfig();
	const res = await fetch(`http://localhost:${server.port + 1}/db/stats`);
	if (!res.ok) {
		return {
			agg: {
				allTime: {
					cost: 0,
					queries: 0,
					input_tokens: 0,
					output_tokens: 0,
					cache_read_tokens: 0,
					cache_creation_tokens: 0,
					turns: 0,
				},
				today: { cost: 0, queries: 0, tokens: 0 },
				thisMonth: { cost: 0, queries: 0, tokens: 0 },
			},
		} as { agg: AggStats };
	}
	const data = (await res.json()) as { agg: AggStats };
	return { agg: data.agg };
});

const getSessionsPageFn = createServerFn({ method: "POST" })
	.inputValidator((data: { page: number; size: number }) => data)
	.handler(async ({ data }) => {
		const { server } = await getConfig();
		const res = await fetch(
			`http://localhost:${server.port + 1}/db/sessions?page=${data.page}&size=${data.size}`,
		);
		if (!res.ok) return { sessions: [] as SessionRow[], total: 0 };
		return res.json() as Promise<{ sessions: SessionRow[]; total: number }>;
	});

const deleteSessionFn = createServerFn({ method: "POST" })
	.inputValidator((data: { id: string }) => data)
	.handler(async ({ data }) => {
		const { server } = await getConfig();
		const res = await fetch(
			`http://localhost:${server.port + 1}/db/session?id=${data.id}`,
			{ method: "DELETE" },
		);
		return { ok: res.ok };
	});

const cleanupSessionsFn = createServerFn({ method: "POST" })
	.inputValidator((data: { days: number }) => data)
	.handler(async ({ data }) => {
		const { server } = await getConfig();
		const res = await fetch(
			`http://localhost:${server.port + 1}/db/sessions/cleanup?older_than_days=${data.days}`,
			{ method: "POST" },
		);
		if (!res.ok) return { deleted: 0 };
		return res.json() as Promise<{ deleted: number }>;
	});

// ─── route ───────────────────────────────────────────────────────────────────

const PAGE_SIZE = 20;

export const Route = createFileRoute("/stats")({
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

// ─── constants ───────────────────────────────────────────────────────────────

const EMPTY_STATS: wsStore.LiveStats = {
	turns: 0,
	cost: 0,
	duration_ms: 0,
	input_tokens: 0,
	output_tokens: 0,
	cache_read_tokens: 0,
	cache_creation_tokens: 0,
	context_window: null,
	max_output_tokens: null,
	last_context_used: null,
	last_output_tokens: null,
	queries: 0,
};

// ─── format helpers ───────────────────────────────────────────────────────────

function fmt(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function fmtMs(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function fmtDate(unixSecs: number): string {
	return new Date(unixSecs * 1000).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function fmtResetTime(unixSecs: number): string {
	const diff = unixSecs - Date.now() / 1000;
	if (diff <= 0) return "now";
	const h = Math.floor(diff / 3600);
	const m = Math.floor((diff % 3600) / 60);
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

// ─── components ──────────────────────────────────────────────────────────────

function StatCell({
	label,
	value,
	sub,
	dim,
}: {
	label: string;
	value: string;
	sub?: string;
	dim?: boolean;
}) {
	return (
		<div className="p-4 flex flex-col gap-1">
			<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
				{label}
			</div>
			<div
				className={`text-xl font-bold tabular-nums ${dim ? "text-muted-foreground/20" : "text-[var(--data)]"}`}
			>
				{value}
			</div>
			{sub && (
				<div className="text-[10px] text-muted-foreground tracking-wider">
					{sub}
				</div>
			)}
		</div>
	);
}

function Bar({
	value,
	max,
	label,
}: {
	value: number;
	max: number;
	label: string;
}) {
	const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
	const color =
		pct > 80 ? "bg-destructive" : pct > 60 ? "bg-yellow-600" : "bg-primary";
	return (
		<div className="space-y-1.5">
			<div className="flex justify-between text-[10px] tracking-wider">
				<span className="text-muted-foreground uppercase">{label}</span>
				<span className="text-foreground tabular-nums">
					{fmt(value)} / {fmt(max)} ({pct.toFixed(0)}%)
				</span>
			</div>
			<div className="h-1.5 bg-secondary overflow-hidden">
				<div
					className={`h-full transition-all ${color}`}
					style={{ width: `${pct}%` }}
				/>
			</div>
		</div>
	);
}

function UtilBar({ utilization }: { utilization: number }) {
	const pct = Math.min(utilization * 100, 100);
	const color =
		pct > 80 ? "bg-destructive" : pct > 60 ? "bg-yellow-600" : "bg-primary";
	return (
		<div className="space-y-1.5">
			<div className="flex justify-between text-[10px] tracking-wider">
				<span className="text-muted-foreground uppercase">Utilization</span>
				<span className="text-foreground tabular-nums">{pct.toFixed(0)}%</span>
			</div>
			<div className="h-1.5 bg-secondary overflow-hidden">
				<div
					className={`h-full transition-all ${color}`}
					style={{ width: `${pct}%` }}
				/>
			</div>
		</div>
	);
}

function Row({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-center justify-between px-4 py-2.5 border-b border-border last:border-0">
			<span className="text-[10px] tracking-widest text-muted-foreground uppercase">
				{label}
			</span>
			<span className="text-sm font-medium text-foreground tabular-nums">
				{value}
			</span>
		</div>
	);
}

function SessionItem({
	session,
	onDelete,
	onNavigate,
}: {
	session: SessionRow;
	onDelete: (id: string) => void;
	onNavigate: (id: string) => void;
}) {
	const [confirming, setConfirming] = useState(false);

	return (
		<div className="flex items-center gap-2 border-b border-border last:border-0 group hover:bg-accent/20 transition-colors">
			<button
				type="button"
				onClick={() => onNavigate(session.id)}
				className="flex items-center gap-3 flex-1 min-w-0 px-4 py-2.5 text-left"
			>
				<div className="flex-1 min-w-0">
					<div className="text-[11px] tracking-wider text-foreground/80 truncate">
						{session.label ?? "—"}
					</div>
					<div className="text-[9px] tracking-wider text-muted-foreground/40 mt-0.5">
						{fmtDate(session.started_at)} · {session.query_count}q
					</div>
				</div>
				<div className="text-right shrink-0">
					<div className="text-[11px] tabular-nums text-[var(--data)]/70">
						${(session.total_cost ?? 0).toFixed(4)}
					</div>
					<div className="text-[9px] tabular-nums text-muted-foreground/40">
						{fmt(
							(session.total_input_tokens ?? 0) +
								(session.total_output_tokens ?? 0),
						)}{" "}
						tok
					</div>
				</div>
			</button>
			{confirming ? (
				<div className="flex items-center gap-2 pr-2 shrink-0">
					<button
						type="button"
						onClick={() => onDelete(session.id)}
						className="text-[9px] tracking-widest text-destructive/60 hover:text-destructive uppercase transition-colors"
					>
						delete
					</button>
					<button
						type="button"
						onClick={() => setConfirming(false)}
						className="text-[9px] tracking-widest text-muted-foreground/50 hover:text-muted-foreground/80 uppercase transition-colors"
					>
						cancel
					</button>
				</div>
			) : (
				<div className="flex items-center shrink-0">
					<a
						href={`/chat?session=${session.id}`}
						target="_blank"
						rel="noreferrer"
						className="w-7 h-full flex items-center justify-center text-[11px] text-muted-foreground/25 hover:text-primary/60 md:opacity-0 md:group-hover:opacity-100 transition-all"
						title="Open in new tab"
					>
						↗
					</a>
					<button
						type="button"
						onClick={() => setConfirming(true)}
						className="w-7 h-full flex items-center justify-center text-muted-foreground/20 hover:text-destructive/60 md:opacity-0 md:group-hover:opacity-100 transition-all pr-2"
						title="Delete session"
					>
						×
					</button>
				</div>
			)}
		</div>
	);
}

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

function SessionsLedger({
	data,
	page,
	totalPages,
	loading,
	onPageChange,
	onDelete,
	onNavigate,
	onCleanup,
	onBuildSkill,
	connected,
}: {
	data: { sessions: SessionRow[]; total: number };
	page: number;
	totalPages: number;
	loading: boolean;
	onPageChange: (p: number) => void;
	onDelete: (id: string) => void;
	onNavigate: (id: string) => void;
	onCleanup: (days: number) => void;
	onBuildSkill: () => void;
	connected: boolean;
}) {
	const [headerAction, setHeaderAction] = useState<"cleanup" | "build" | null>(
		null,
	);

	return (
		<div className="border border-border bg-card">
			<div className="px-4 py-3 border-b border-border flex items-center justify-between">
				<div className="flex items-center gap-3">
					<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
						SESSIONS
					</div>
					<span className="text-[9px] tabular-nums text-muted-foreground/40">
						{data.total}
					</span>
				</div>
				{headerAction === null ? (
					<div className="flex items-center gap-3">
						{connected && (
							<button
								type="button"
								onClick={() => setHeaderAction("build")}
								className="text-[8px] tracking-widest text-muted-foreground/50 hover:text-muted-foreground/80 uppercase transition-colors"
							>
								build skill
							</button>
						)}
						{data.total > 0 && (
							<button
								type="button"
								onClick={() => setHeaderAction("cleanup")}
								className="text-[8px] tracking-widest text-muted-foreground/50 hover:text-muted-foreground/80 uppercase transition-colors"
							>
								clean up
							</button>
						)}
					</div>
				) : headerAction === "cleanup" ? (
					<div className="flex items-center gap-2">
						<span className="text-[9px] text-muted-foreground/50">
							delete older than 30d?
						</span>
						<button
							type="button"
							onClick={() => {
								onCleanup(30);
								setHeaderAction(null);
							}}
							className="text-[9px] tracking-widest text-destructive/60 hover:text-destructive uppercase transition-colors"
						>
							confirm
						</button>
						<button
							type="button"
							onClick={() => setHeaderAction(null)}
							className="text-[9px] tracking-widest text-muted-foreground/50 hover:text-muted-foreground/80 uppercase transition-colors"
						>
							cancel
						</button>
					</div>
				) : (
					<div className="flex items-center gap-2">
						<span className="text-[9px] text-muted-foreground/50">
							send to Claude?
						</span>
						<button
							type="button"
							onClick={() => {
								onBuildSkill();
								setHeaderAction(null);
							}}
							className="text-[9px] tracking-widest text-primary/60 hover:text-primary uppercase transition-colors"
						>
							confirm
						</button>
						<button
							type="button"
							onClick={() => setHeaderAction(null)}
							className="text-[9px] tracking-widest text-muted-foreground/50 hover:text-muted-foreground/80 uppercase transition-colors"
						>
							cancel
						</button>
					</div>
				)}
			</div>

			{loading ? (
				<div className="px-4 py-6 text-center text-[9px] tracking-widest text-muted-foreground/50">
					loading…
				</div>
			) : data.sessions.length === 0 ? (
				<div className="px-4 py-6 text-center text-[9px] tracking-widest text-muted-foreground/50">
					no sessions
				</div>
			) : (
				data.sessions.map((s) => (
					<SessionItem
						key={s.id}
						session={s}
						onDelete={onDelete}
						onNavigate={onNavigate}
					/>
				))
			)}

			{totalPages > 1 && (
				<div className="px-4 py-2.5 border-t border-border flex items-center justify-between">
					<button
						type="button"
						disabled={page <= 1 || loading}
						onClick={() => onPageChange(page - 1)}
						className="text-[9px] tracking-widest text-muted-foreground/40 hover:text-foreground disabled:opacity-20 uppercase transition-colors"
					>
						← prev
					</button>
					<span className="text-[9px] tabular-nums text-muted-foreground/30">
						{page} / {totalPages}
					</span>
					<button
						type="button"
						disabled={page >= totalPages || loading}
						onClick={() => onPageChange(page + 1)}
						className="text-[9px] tracking-widest text-muted-foreground/40 hover:text-foreground disabled:opacity-20 uppercase transition-colors"
					>
						next →
					</button>
				</div>
			)}
		</div>
	);
}

// ─── page ─────────────────────────────────────────────────────────────────────

function StatsPage() {
	const { statsData, initialSessions, page } = Route.useLoaderData();
	const navigate = useNavigate();
	const isRouterLoading = useRouterState({
		select: (s) => s.status === "pending",
	});
	const stats = useSyncExternalStore(
		wsStore.subscribeStats,
		wsStore.getLiveStats,
		() => EMPTY_STATS,
	);
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
		navigate({ to: "/stats", search: { page: p } });
	}

	async function handleDeleteSession(id: string) {
		setDeletedIds((prev) => new Set(prev).add(id));
		const result = await deleteSessionFn({ data: { id } });
		if (!result.ok) {
			setDeletedIds((prev) => {
				const next = new Set(prev);
				next.delete(id);
				return next;
			});
		} else if (sessionsData.sessions.length <= 1 && page > 1) {
			navigate({ to: "/stats", search: { page: page - 1 } });
		}
	}

	async function handleCleanup(days: number) {
		await cleanupSessionsFn({ data: { days } });
		navigate({ to: "/stats", search: { page: 1 } });
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
						value={
							model
								? ({
										"claude-opus-4-7": "Opus 4.7",
										"claude-sonnet-4-6": "Sonnet 4.6",
										"claude-haiku-4-5-20251001": "Haiku 4.5",
									}[model] ??
									model.replace("claude-", "").replace(/-\d{8}$/, ""))
								: "--"
						}
						dim={!model}
					/>
				</div>

				<div className="p-5 space-y-5">
					{/* Usage windows — from DB */}
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
								<div className="text-lg font-bold tabular-nums text-[var(--data)]">
									${agg.today.cost.toFixed(4)}
								</div>
								<div className="text-[10px] text-muted-foreground/50">
									{agg.today.queries} queries · {fmt(agg.today.tokens)} tok
								</div>
							</div>
							<div className="p-4 space-y-1">
								<div className="text-[9px] tracking-widest text-muted-foreground/50 uppercase">
									This Month
								</div>
								<div className="text-lg font-bold tabular-nums text-[var(--data)]">
									${agg.thisMonth.cost.toFixed(4)}
								</div>
								<div className="text-[10px] text-muted-foreground/50">
									{agg.thisMonth.queries} queries · {fmt(agg.thisMonth.tokens)}{" "}
									tok
								</div>
							</div>
						</div>
					</div>

					{/* Rate limit — from WS, only shown when available */}
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

					{/* Context window — live */}
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

					{/* All-time totals — from DB */}
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
								to: "/chat",
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
