import { useNavigate } from "@tanstack/react-router";
import { GitFork, Pin } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { AggStats, SessionRow, WeeklyStats } from "#/db";
import type { LiveStats } from "#/hooks/wsLiveStatsStore";
import {
	getSessionsStatus,
	subscribeSessionsStatus,
} from "#/hooks/wsSessionStatusStore";
import { formatDisplayCost } from "#/lib/costDisplay";
import { fmt, fmtRunTime } from "#/lib/formatters";
import {
	attentionReasonLabel,
	deriveLiveSessionSwitcherRows,
	derivePersistedRecentSessionRows,
	liveSessionContext,
	liveSessionReasonLabel,
	type PersistedRecentSessionRow,
} from "#/lib/liveSessionSwitcher";
import type { RoutineSummary } from "#/lib/routines";

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
	rows,
	onRunClick,
}: {
	rows: PersistedRecentSessionRow[];
	onRunClick: (sessionId: string) => void;
}) {
	if (rows.length === 0) {
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
			{rows.map(({ session: run, workspaceLabel, forkLabel }) => (
				<button
					key={run.id}
					type="button"
					onClick={() => onRunClick(run.id)}
					aria-label={`Open ${run.label ?? "untitled"} recent session`}
					className="group flex min-h-11 w-full items-center gap-2 border-b border-border/20 px-4 py-2 text-left transition-colors last:border-0 hover:bg-accent/30"
				>
					<span className="text-[9px] tabular-nums text-primary/50 shrink-0 font-mono w-9">
						{fmtRunTime(run.started_at)}
					</span>
					<span className="min-w-0 flex-1">
						<PrivacyMask className="truncate text-[10px] tracking-wider text-muted-foreground/65">
							{run.label ?? "untitled"}
						</PrivacyMask>
						{(workspaceLabel || forkLabel) && (
							<span className="mt-0.5 flex min-w-0 items-center gap-1 truncate font-mono text-[7px] text-muted-foreground/40">
								{forkLabel && (
									<GitFork
										aria-hidden="true"
										className="h-2.5 w-2.5 shrink-0"
									/>
								)}
								<PrivacyMask className="truncate">
									{[workspaceLabel, forkLabel].filter(Boolean).join(" · ")}
								</PrivacyMask>
							</span>
						)}
					</span>
					{run.pinned === 1 && (
						<span title="Pinned" className="shrink-0 text-primary/60">
							<Pin aria-hidden="true" className="h-3 w-3" />
							<span className="sr-only">Pinned</span>
						</span>
					)}
					<span className="shrink-0 text-[7px] tracking-widest text-muted-foreground/30 uppercase">
						Recent
					</span>
				</button>
			))}
		</>
	);
}

function usePersistedRecentRows(
	runs: SessionRow[],
): PersistedRecentSessionRow[] {
	const sessions = useSyncExternalStore(
		subscribeSessionsStatus,
		getSessionsStatus,
		() => [],
	);
	return derivePersistedRecentSessionRows(runs, sessions);
}

type AttentionRow = {
	id: string;
	label: string;
	state: "needs_attention" | "working" | "queued";
	reason?: Parameters<typeof attentionReasonLabel>[0];
	sessionId: string | null;
	pinned: boolean;
	context: string;
	forkLabel: string | null;
	session?: ReturnType<typeof getSessionsStatus>[number];
};

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

function AttentionSummary({
	onRunClick,
	onOpenRoutines,
	routines,
}: {
	onRunClick: (sessionId: string) => void;
	onOpenRoutines: () => void;
	routines: RoutineSummary[];
}) {
	const sessions = useSyncExternalStore(
		subscribeSessionsStatus,
		getSessionsStatus,
		() => [],
	);
	const liveRows = deriveLiveSessionSwitcherRows(sessions);
	const routineRows: AttentionRow[] = routines.flatMap((routine) => {
		const attention = routine.attention;
		const lastRun = routine.lastRun;
		if (!attention || attention.bucket === "recent" || !lastRun) return [];
		return [
			{
				id: `routine:${routine.id}:${lastRun.id}`,
				label: routine.name,
				state: attention.bucket,
				reason: attention.reason,
				sessionId: lastRun.sessionId,
				pinned: false,
				context: "",
				forkLabel: null,
			},
		];
	});
	const routineSessionIds = new Set(
		routineRows
			.map((row) => row.sessionId)
			.filter((id): id is string => Boolean(id)),
	);
	const actionable = [
		...liveRows
			.filter(
				(row) =>
					row.state !== "recent" &&
					!routineSessionIds.has(row.dbSessionId) &&
					!routineSessionIds.has(row.session.session_id),
			)
			.map((row) => ({
				id: row.session.session_id,
				label: row.session.lastLabel?.trim() || row.session.agent_name,
				state: row.state,
				reason: row.session.attention?.reason,
				sessionId: row.dbSessionId,
				pinned: row.pinned,
				context: liveSessionContext(row.session, row.workspaceLabel),
				forkLabel: row.forkLabel,
				session: row.session,
			})),
		...routineRows,
	].sort((left, right) => {
		const priority = {
			needs_attention: 0,
			working: 1,
			queued: 2,
			recent: 3,
		};
		return (
			priority[left.state] - priority[right.state] ||
			Number(right.pinned) - Number(left.pinned)
		);
	});
	const attentionCount = actionable.filter(
		(row) => row.state === "needs_attention",
	).length;
	const workingCount = actionable.filter(
		(row) => row.state === "working",
	).length;
	const queuedCount = actionable.filter((row) => row.state === "queued").length;

	return (
		<div className="border-b border-border">
			<div className="flex items-center justify-between border-b border-border/40 px-4 py-2.5">
				<span className="text-[9px] tracking-widest text-muted-foreground/40 uppercase">
					Attention
				</span>
				<span className="font-mono text-[8px] text-muted-foreground/45">
					{liveRows.length} live
					{routineRows.length > 0 ? ` · ${routineRows.length} routines` : ""}
				</span>
			</div>
			<div className="grid grid-cols-3 divide-x divide-border/40 border-b border-border/40">
				<div className="px-2 py-2 text-center">
					<div className="font-mono text-xs text-amber-400">
						{attentionCount}
					</div>
					<div className="mt-0.5 text-[7px] tracking-wider text-muted-foreground/45 uppercase">
						Needs you
					</div>
				</div>
				<div className="px-2 py-2 text-center">
					<div className="font-mono text-xs text-primary">{workingCount}</div>
					<div className="mt-0.5 text-[7px] tracking-wider text-muted-foreground/45 uppercase">
						Working
					</div>
				</div>
				<div className="px-2 py-2 text-center">
					<div className="font-mono text-xs text-sky-400">{queuedCount}</div>
					<div className="mt-0.5 text-[7px] tracking-wider text-muted-foreground/45 uppercase">
						Queued
					</div>
				</div>
			</div>
			{actionable.length > 0 ? (
				<div>
					{actionable.slice(0, 4).map((row) => {
						return (
							<button
								key={row.id}
								type="button"
								onClick={() =>
									row.sessionId ? onRunClick(row.sessionId) : onOpenRoutines()
								}
								aria-label={`Open ${row.label} from attention summary`}
								className="flex min-h-10 w-full items-center gap-2 border-b border-border/20 px-4 py-2 text-left last:border-0 hover:bg-accent/30"
							>
								<span
									className={`h-1.5 w-1.5 shrink-0 rounded-full ${
										row.state === "needs_attention"
											? "bg-amber-400"
											: row.state === "working"
												? "bg-primary"
												: "bg-sky-400"
									}`}
								/>
								{row.pinned && (
									<Pin
										aria-label="Pinned"
										className="h-3 w-3 shrink-0 text-primary/60"
									/>
								)}
								<span className="min-w-0 flex-1">
									<PrivacyMask className="truncate text-[9px] tracking-wider text-muted-foreground/70">
										{row.label}
									</PrivacyMask>
									{(row.context || row.forkLabel) && (
										<span className="mt-0.5 flex min-w-0 items-center gap-1 truncate font-mono text-[7px] text-muted-foreground/35">
											{row.forkLabel && (
												<GitFork
													aria-hidden="true"
													className="h-2.5 w-2.5 shrink-0"
												/>
											)}
											<PrivacyMask className="truncate">
												{[row.context, row.forkLabel]
													.filter(Boolean)
													.join(" · ")}
											</PrivacyMask>
										</span>
									)}
								</span>
								<span className="shrink-0 font-mono text-[7px] tracking-wider text-muted-foreground/45 uppercase">
									{row.reason
										? attentionReasonLabel(row.reason)
										: row.session
											? liveSessionReasonLabel(row.session)
											: ""}
								</span>
							</button>
						);
					})}
				</div>
			) : (
				<div className="px-4 py-2.5 text-center text-[8px] tracking-wider text-muted-foreground/40 uppercase">
					{liveRows.length > 0
						? "All live sessions ready"
						: "No active attention"}
				</div>
			)}
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
	routines,
	onOpenRoutines,
	className = "",
}: {
	runs: SessionRow[];
	weeklyStats: WeeklyStats;
	onRunClick: (sessionId: string) => void;
	stats: LiveStats;
	agg: AggStats;
	activeSession: SessionRow | null;
	routines: RoutineSummary[];
	onOpenRoutines: () => void;
	className?: string;
}) {
	const recentRows = usePersistedRecentRows(runs);
	const latestRun =
		runs.length > 0
			? runs.reduce((latest, run) =>
					(run.ended_at ?? run.started_at) >
					(latest.ended_at ?? latest.started_at)
						? run
						: latest,
				)
			: null;
	const session = activeSession ?? latestRun;
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
							{session
								? formatDisplayCost({
										cost: session.total_cost,
										estimated_cost: session.total_estimated_cost,
										unpriced_queries: session.unpriced_query_count,
									})
								: "--"}
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
							{formatDisplayCost(agg.today)}
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
							{formatDisplayCost(agg.thisMonth)}
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
							{formatDisplayCost(agg.allTime, 2)}
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

			<AttentionSummary
				onRunClick={onRunClick}
				onOpenRoutines={onOpenRoutines}
				routines={routines}
			/>

			<div className="px-4 py-2.5 border-b border-border shrink-0 flex items-center justify-between">
				<span className="text-[9px] tracking-widest text-muted-foreground/40 uppercase">
					Recent Runs
				</span>
				{recentRows.length > 0 && (
					<span className="text-[9px] tabular-nums text-muted-foreground/50">
						{recentRows.length}
					</span>
				)}
			</div>
			<div className="overflow-auto">
				<RunList rows={recentRows} onRunClick={onRunClick} />
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
	routines,
	onOpenRoutines,
}: {
	runs: SessionRow[];
	weeklyStats: WeeklyStats;
	onRunClick: (sessionId: string) => void;
	routines: RoutineSummary[];
	onOpenRoutines: () => void;
}) {
	const [runsOpen, setRunsOpen] = useState(false);
	const [weekOpen, setWeekOpen] = useState(true);
	const recentRows = usePersistedRecentRows(runs);

	return (
		<div className="md:hidden border-b border-border shrink-0">
			<AttentionSummary
				onRunClick={onRunClick}
				onOpenRoutines={onOpenRoutines}
				routines={routines}
			/>

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
					{recentRows.length > 0 && (
						<span className="text-[9px] tabular-nums text-muted-foreground/25">
							{recentRows.length}
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
					<RunList rows={recentRows} onRunClick={onRunClick} />
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
