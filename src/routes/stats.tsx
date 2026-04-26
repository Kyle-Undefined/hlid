import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState, useSyncExternalStore } from "react";
import { getConfig } from "#/config";
import type { AggStats, SessionRow } from "#/db";
import { useWs } from "#/hooks/useWs";
import * as wsStore from "#/hooks/wsStore";
import type { RateLimitMessage, ServerMessage } from "#/server/protocol";

// ─── server fn ───────────────────────────────────────────────────────────────

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
			sessions: [] as SessionRow[],
		};
	}
	return res.json() as Promise<{ agg: AggStats; sessions: SessionRow[] }>;
});

// ─── route ───────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/stats")({
	loader: async () => {
		const [config, statsData] = await Promise.all([
			getConfig(),
			getStatsDataFn(),
		]);
		return { config, statsData };
	},
	component: StatsPage,
});

// ─── types ───────────────────────────────────────────────────────────────────

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
				className={`text-xl font-bold tabular-nums ${dim ? "text-muted-foreground/20" : "text-[#38bdf8]"}`}
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

function SessionItem({ session }: { session: SessionRow }) {
	return (
		<div className="flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-0">
			<div className="flex-1 min-w-0">
				<div className="text-[11px] tracking-wider text-foreground/80 truncate">
					{session.label ?? "—"}
				</div>
				<div className="text-[9px] tracking-wider text-muted-foreground/40 mt-0.5">
					{fmtDate(session.started_at)}
				</div>
			</div>
			<div className="text-right shrink-0">
				<div className="text-[11px] tabular-nums text-[#38bdf8]/70">
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
		</div>
	);
}

// ─── page ─────────────────────────────────────────────────────────────────────

function StatsPage() {
	const { config, statsData } = Route.useLoaderData();
	const stats = useSyncExternalStore(
		wsStore.subscribeStats,
		wsStore.getLiveStats,
		() => EMPTY_STATS,
	);
	const [rateLimit, setRateLimit] = useState<RateLimitMessage | null>(null);
	const { wsStatus, model } = useWs((msg: ServerMessage) => {
		if (msg.type === "rate_limit") setRateLimit(msg);
	});

	const totalInput =
		stats.input_tokens + stats.cache_read_tokens + stats.cache_creation_tokens;
	const cacheHitPct =
		totalInput > 0
			? ((stats.cache_read_tokens / totalInput) * 100).toFixed(0)
			: "0";
	const avgCostPerQuery = stats.queries > 0 ? stats.cost / stats.queries : 0;
	const connected = wsStatus === "connected";
	const idle = stats.queries === 0;

	const { agg, sessions } = statsData;

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
								<div className="text-lg font-bold tabular-nums text-[#38bdf8]">
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
								<div className="text-lg font-bold tabular-nums text-[#38bdf8]">
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
									value={stats.max_output_tokens}
									max={64_000}
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

					{/* Recent sessions — from DB */}
					{sessions.length > 0 && (
						<div className="border border-border bg-card">
							<div className="px-4 py-3 border-b border-border">
								<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
									RECENT SESSIONS
								</div>
							</div>
							{sessions.map((s) => (
								<SessionItem key={s.id} session={s} />
							))}
						</div>
					)}

					{/* Config section */}
					<div className="border border-border bg-card">
						<div className="px-4 py-3 border-b border-border">
							<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
								SESSION
							</div>
						</div>
						<Row label="Vault" value={config.vault.name || "--"} />
						<Row
							label="Permissions"
							value={
								config.claude.permission_mode === "default"
									? "ASK"
									: config.claude.permission_mode === "acceptEdits"
										? "AUTO EDITS"
										: "AUTO ALL"
							}
						/>
						<Row
							label="Server"
							value={`${config.server.host}:${config.server.port}`}
						/>
					</div>
				</div>
			</div>
		</div>
	);
}
