import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { AggStats, SessionRow, WeeklyStats } from "#/db";
import type * as wsStore from "#/hooks/wsStore";
import { fmt, fmtRunTime } from "#/lib/formatters";

// ─── UtilBar ─────────────────────────────────────────────────────────────────

export function UtilBar({ value, max }: { value: number; max: number }) {
	const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
	const color =
		pct > 80 ? "bg-destructive" : pct > 60 ? "bg-yellow-600" : "bg-primary";
	return (
		<div className="h-1 bg-secondary overflow-hidden mt-1">
			<div
				className={`h-full transition-all ${color}`}
				style={{ width: `${pct}%` }}
			/>
		</div>
	);
}

// ─── WeekBarGraph ─────────────────────────────────────────────────────────────

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"] as const;
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function WeekBarGraph({ days }: { days: number[] }) {
	if (days.length !== 7) {
		console.error(`WeekBarGraph expects 7 days, got ${days.length}`);
		return null;
	}
	const max = Math.max(...days, 1);
	const today = new Date().getDay();
	return (
		<div className="flex items-end gap-0.5">
			{days.map((count, i) => (
				<div
					key={DAY_KEYS[i]}
					className="flex flex-col items-center gap-0.5 flex-1 min-w-0"
				>
					<span className="text-[7px] tabular-nums text-muted-foreground/25 leading-none h-2 flex items-end">
						{count > 0 ? count : ""}
					</span>
					<div
						className="w-full flex items-end"
						style={{ height: "20px" }}
						aria-hidden
					>
						<div
							className={`w-full transition-all ${i === today ? "bg-primary/60" : "bg-primary/20"}`}
							style={{
								height: `${count > 0 ? Math.max((count / max) * 20, 2) : 0}px`,
							}}
						/>
					</div>
					<span
						className={`text-[8px] tracking-wider ${i === today ? "text-primary/50" : "text-muted-foreground/25"}`}
					>
						{DAY_LABELS[i]}
					</span>
				</div>
			))}
		</div>
	);
}

// ─── RunList ──────────────────────────────────────────────────────────────────

function RunList({
	runs,
	onRunClick,
}: {
	runs: SessionRow[];
	onRunClick: (sessionId: string) => void;
}) {
	if (runs.length === 0) {
		return (
			<div className="flex items-center justify-center py-4">
				<span className="text-[9px] tracking-widest text-muted-foreground/50">
					no runs yet
				</span>
			</div>
		);
	}
	return (
		<>
			{runs.map((run) => (
				<button
					key={run.id}
					type="button"
					onClick={() => onRunClick(run.id)}
					className="flex items-center gap-2 w-full px-4 py-2 border-b border-border/20 last:border-0 hover:bg-accent/30 transition-colors text-left group"
				>
					<span className="text-[9px] tabular-nums text-primary/50 shrink-0 font-mono w-9">
						{fmtRunTime(run.started_at)}
					</span>
					<PrivacyMask
						inline
						className="text-[10px] tracking-wider text-muted-foreground/60 truncate flex-1"
					>
						{run.label ?? "untitled"}
					</PrivacyMask>
					<span className="text-[8px] tracking-widest text-muted-foreground/20 uppercase shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
						↗
					</span>
				</button>
			))}
		</>
	);
}

// ─── ViewAllLink ──────────────────────────────────────────────────────────────

function ViewAllLink() {
	const navigate = useNavigate();
	return (
		<div className="px-4 py-2 border-t border-border/30">
			<button
				type="button"
				onClick={() =>
					navigate({
						to: "/ledger",
						search: { tab: "sessions", page: 1, size: 20 },
					})
				}
				className="text-[8px] tracking-widest text-muted-foreground/50 hover:text-muted-foreground/80 uppercase transition-colors w-full text-left"
			>
				view all →
			</button>
		</div>
	);
}

// ─── RecentRunsSidebar ────────────────────────────────────────────────────────

export function RecentRunsSidebar({
	runs,
	weeklyStats,
	onRunClick,
	stats,
	agg,
	activeSession,
	className = "",
}: {
	runs: SessionRow[];
	weeklyStats: WeeklyStats;
	onRunClick: (sessionId: string) => void;
	stats: wsStore.LiveStats;
	agg: AggStats;
	activeSession: SessionRow | null;
	className?: string;
}) {
	const session = activeSession ?? runs[0] ?? null;
	const hasContext =
		stats.last_context_used != null && stats.context_window != null;
	const contextUsed = stats.last_context_used ?? 0;
	const contextWindow = stats.context_window ?? 0;
	const contextPct =
		hasContext && contextWindow > 0
			? Math.min((contextUsed / contextWindow) * 100, 100).toFixed(0)
			: "0";

	return (
		<div
			className={`w-72 border-l border-border flex flex-col shrink-0 overflow-hidden ${className}`}
		>
			{/* Stats block */}
			<div className="border-b border-border shrink-0">
				<div className="grid grid-cols-2 divide-x divide-border border-b border-border">
					<div className="px-3 py-3">
						<div className="text-[8px] tracking-widest text-muted-foreground/50 uppercase mb-1">
							This Session
						</div>
						<PrivacyMask
							inline
							className={`text-sm font-bold tabular-nums leading-none ${session ? "text-[var(--data)]" : "text-muted-foreground/20"}`}
						>
							{session ? `$${session.total_cost.toFixed(4)}` : "--"}
						</PrivacyMask>
						<PrivacyMask className="mt-1 text-[8px] tracking-wider text-muted-foreground/40">
							{session
								? `${session.query_count}q · ${session.total_turns} turns`
								: "no sessions"}
						</PrivacyMask>
					</div>
					<div className="px-3 py-3">
						<div className="text-[8px] tracking-widest text-muted-foreground/50 uppercase mb-1">
							Today
						</div>
						<PrivacyMask
							inline
							className="text-sm font-bold tabular-nums leading-none text-[var(--data)]"
						>
							${agg.today.cost.toFixed(4)}
						</PrivacyMask>
						<PrivacyMask className="mt-1 text-[8px] tracking-wider text-muted-foreground/40">
							{agg.today.queries}q · {fmt(agg.today.tokens)} tok
						</PrivacyMask>
					</div>
				</div>
				<div className="grid grid-cols-2 divide-x divide-border border-b border-border">
					<div className="px-3 py-2.5">
						<div className="text-[8px] tracking-widest text-muted-foreground/50 uppercase mb-1">
							Month
						</div>
						<PrivacyMask
							inline
							className="text-sm font-bold tabular-nums leading-none text-[var(--data)]"
						>
							${agg.thisMonth.cost.toFixed(4)}
						</PrivacyMask>
						<PrivacyMask className="mt-1 text-[8px] tracking-wider text-muted-foreground/40">
							{agg.thisMonth.queries}q · {fmt(agg.thisMonth.tokens)} tok
						</PrivacyMask>
					</div>
					<div className="px-3 py-2.5">
						<div className="text-[8px] tracking-widest text-muted-foreground/40 uppercase mb-1">
							All Time
						</div>
						<PrivacyMask
							inline
							className="text-sm font-bold tabular-nums text-foreground/60"
						>
							${agg.allTime.cost.toFixed(2)}
						</PrivacyMask>
					</div>
				</div>
				{hasContext && (
					<div className="px-3 py-2 border-t border-border flex items-center gap-2">
						<span className="text-[8px] tracking-widest text-muted-foreground/40 uppercase shrink-0">
							Ctx
						</span>
						<div className="flex-1">
							<UtilBar value={contextUsed} max={contextWindow} />
						</div>
						<span className="text-[8px] tabular-nums text-muted-foreground/40 shrink-0">
							{contextPct}%
						</span>
					</div>
				)}
			</div>

			<div className="px-4 py-2.5 border-b border-border shrink-0 flex items-center justify-between">
				<span className="text-[9px] tracking-widest text-muted-foreground/40 uppercase">
					Recent Runs
				</span>
				{runs.length > 0 && (
					<span className="text-[9px] tabular-nums text-muted-foreground/50">
						{runs.length}
					</span>
				)}
			</div>
			<div className="overflow-auto">
				<RunList runs={runs} onRunClick={onRunClick} />
				<ViewAllLink />
			</div>
			<div className="border-t border-border">
				<div className="px-4 py-2.5 border-b border-border/40 flex items-center justify-between">
					<span className="text-[9px] tracking-widest text-muted-foreground/40 uppercase">
						This Week
					</span>
					<span className="text-[9px] tabular-nums text-muted-foreground/30">
						{weeklyStats.total} runs
					</span>
				</div>
				<div className="px-4 py-3">
					<WeekBarGraph days={weeklyStats.days} />
				</div>
			</div>
		</div>
	);
}

// ─── MobileRunsPanel ──────────────────────────────────────────────────────────

export function MobileRunsPanel({
	runs,
	weeklyStats,
	onRunClick,
}: {
	runs: SessionRow[];
	weeklyStats: WeeklyStats;
	onRunClick: (sessionId: string) => void;
}) {
	const [runsOpen, setRunsOpen] = useState(false);
	const [weekOpen, setWeekOpen] = useState(true);

	return (
		<div className="md:hidden border-b border-border shrink-0">
			{/* Recent runs, collapsed by default */}
			<button
				type="button"
				onClick={() => setRunsOpen((v) => !v)}
				className="w-full flex items-center justify-between px-4 py-2.5 border-b border-border/60 hover:bg-accent/20 transition-colors"
			>
				<div className="flex items-center gap-2">
					<span className="text-[9px] tracking-widest text-muted-foreground/40 uppercase">
						Recent Runs
					</span>
					{runs.length > 0 && (
						<span className="text-[9px] tabular-nums text-muted-foreground/25">
							{runs.length}
						</span>
					)}
				</div>
				<span
					className="text-[9px] text-muted-foreground/30 transition-transform"
					style={{ transform: runsOpen ? "rotate(180deg)" : undefined }}
				>
					▾
				</span>
			</button>
			{runsOpen && (
				<div className="border-b border-border/40">
					<RunList runs={runs} onRunClick={onRunClick} />
					<ViewAllLink />
				</div>
			)}

			{/* This week, open by default */}
			<button
				type="button"
				onClick={() => setWeekOpen((v) => !v)}
				className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-accent/20 transition-colors"
			>
				<div className="flex items-center gap-2">
					<span className="text-[9px] tracking-widest text-muted-foreground/40 uppercase">
						This Week
					</span>
					<span className="text-[9px] tabular-nums text-muted-foreground/30">
						{weeklyStats.total} runs
					</span>
				</div>
				<span
					className="text-[9px] text-muted-foreground/30 transition-transform"
					style={{ transform: weekOpen ? "rotate(180deg)" : undefined }}
				>
					▾
				</span>
			</button>
			{weekOpen && (
				<div className="px-4 pb-3 pt-1">
					<WeekBarGraph days={weeklyStats.days} />
				</div>
			)}
		</div>
	);
}
