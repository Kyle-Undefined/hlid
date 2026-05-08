import { useEffect, useRef, useState } from "react";
import type { UsageWindows } from "#/db";
import type { LiveStats } from "#/hooks/wsStore";
import { fmtResetTime } from "#/lib/formatters";
import type { RateLimitMessage } from "#/server/protocol";
import { PrivacyMask } from "./PrivacyMask";

// ─── Merge logic ─────────────────────────────────────────────────────────────

export function mergeUsageWindows(
	fresh: UsageWindows,
	prev: UsageWindows | null,
): UsageWindows {
	if (!prev) return fresh;
	const now = Date.now() / 1000;
	const keep = (
		freshWin: UsageWindows["fiveHour"],
		prevWin: UsageWindows["fiveHour"],
	) => {
		const prevValid =
			prevWin.utilization != null &&
			prevWin.resetsAt != null &&
			prevWin.resetsAt > now;
		return {
			...freshWin,
			utilization: prevValid ? prevWin.utilization : freshWin.utilization,
			resetsAt: prevValid ? prevWin.resetsAt : freshWin.resetsAt,
		};
	};
	const prevSonnetValid =
		prev.weeklySonnet?.utilization != null &&
		prev.weeklySonnet?.resetsAt != null &&
		prev.weeklySonnet.resetsAt > now;
	return {
		...fresh,
		fiveHour: keep(fresh.fiveHour, prev.fiveHour),
		weekly: keep(fresh.weekly, prev.weekly),
		weeklySonnet:
			fresh.weeklySonnet != null
				? prevSonnetValid
					? {
							...fresh.weeklySonnet,
							utilization: prev.weeklySonnet?.utilization ?? null,
							resetsAt: prev.weeklySonnet?.resetsAt ?? null,
						}
					: fresh.weeklySonnet
				: null,
	};
}

// ─── Shared section cells ─────────────────────────────────────────────────────

export function UsageWindowSection({
	label,
	win,
	hideStats,
}: {
	label: string;
	win: {
		queries: number;
		sessions: number;
		cost: number;
		utilization: number | null;
		resetsAt: number | null;
	} | null;
	hideStats?: boolean;
}) {
	const utilPct =
		win?.utilization != null ? Math.min(win.utilization * 100, 100) : null;
	return (
		<div className="flex-1 px-2 py-2 md:px-4 md:py-2.5 min-w-0 space-y-1">
			<div className="flex flex-col md:flex-row md:items-center md:justify-between gap-0.5 md:gap-2">
				<div className="flex items-center gap-1.5 md:gap-2 min-w-0">
					<span className="text-[8px] md:text-[9px] tracking-widest text-muted-foreground/40 uppercase truncate leading-none">
						{label}
					</span>
					{utilPct != null && (
						<span className="text-[9px] md:text-[10px] tabular-nums font-medium text-foreground/60 shrink-0 leading-none">
							{Math.floor(utilPct)}%
						</span>
					)}
				</div>
				{win?.resetsAt != null && (
					<span className="text-[8px] tracking-widest text-muted-foreground/50 truncate">
						{fmtResetTime(win.resetsAt)}
					</span>
				)}
			</div>
			<div className="h-1 bg-secondary/40 overflow-hidden">
				<div
					className="h-full bg-primary/60 transition-all duration-500"
					style={{ width: utilPct != null ? `${utilPct}%` : "0%" }}
				/>
			</div>
			{!hideStats && (
				<div className="flex items-center flex-wrap gap-x-1.5 gap-y-0">
					<PrivacyMask
						inline
						className="text-[9px] tabular-nums text-foreground/50"
					>
						${(win?.cost ?? 0).toFixed(2)}
					</PrivacyMask>
					<span className="text-muted-foreground/25 hidden md:inline">·</span>
					<PrivacyMask
						inline
						className="text-[8px] tracking-widest text-muted-foreground/40"
					>
						<span className="md:hidden">{win?.queries ?? 0}q</span>
						<span className="hidden md:inline">
							{win?.queries ?? 0} queries
						</span>
					</PrivacyMask>
					<span className="text-muted-foreground/25 hidden md:inline">·</span>
					<PrivacyMask
						inline
						className="text-[8px] tracking-widest text-muted-foreground/40"
					>
						<span className="md:hidden">{win?.sessions ?? 0}s</span>
						<span className="hidden md:inline">
							{win?.sessions ?? 0} sessions
						</span>
					</PrivacyMask>
				</div>
			)}
		</div>
	);
}

export function ContextWindowSection({ stats }: { stats: LiveStats }) {
	const hasContext =
		stats.last_context_used != null && stats.context_window != null;
	const contextUsed = stats.last_context_used ?? 0;
	const contextWindow = stats.context_window ?? 0;
	const utilPct =
		hasContext && contextWindow > 0
			? Math.min((contextUsed / contextWindow) * 100, 100)
			: null;
	return (
		<div className="flex-1 px-2 py-2 md:px-4 md:py-2.5 min-w-0 space-y-1">
			<div className="flex flex-col md:flex-row md:items-center md:justify-between gap-0.5 md:gap-2">
				<div className="flex items-center gap-1.5 md:gap-2 min-w-0">
					<span className="text-[8px] md:text-[9px] tracking-widest text-muted-foreground/40 uppercase truncate leading-none">
						CONTEXT
					</span>
					{utilPct != null && (
						<span className="text-[9px] md:text-[10px] tabular-nums font-medium text-foreground/60 shrink-0 leading-none">
							{Math.floor(utilPct)}%
						</span>
					)}
				</div>
				{hasContext && (
					<span className="text-[8px] tracking-widest text-muted-foreground/50 truncate">
						{contextUsed.toLocaleString()} / {contextWindow.toLocaleString()}
					</span>
				)}
			</div>
			<div className="h-1 bg-secondary/40 overflow-hidden">
				<div
					className={`h-full transition-all duration-500 ${utilPct != null && utilPct > 80 ? "bg-destructive/60" : utilPct != null && utilPct > 60 ? "bg-yellow-600/60" : "bg-primary/60"}`}
					style={{ width: utilPct != null ? `${utilPct}%` : "0%" }}
				/>
			</div>
			{!hasContext && (
				<span className="text-[8px] tracking-widest text-muted-foreground/20">
					no active context
				</span>
			)}
		</div>
	);
}

export function RoutinesWindowSection() {
	return (
		<div className="flex-1 px-4 py-2.5 min-w-0">
			<div className="text-[9px] tracking-widest text-muted-foreground/40 uppercase mb-1.5">
				ROUTINES
			</div>
			<span className="text-[10px] tracking-widest text-muted-foreground/50">
				no routines configured
			</span>
		</div>
	);
}

// ─── Stateful panel ───────────────────────────────────────────────────────────

export function UsageWindowsPanel({
	initial,
	liveQueryCount,
	rateLimit,
	tail,
	fetchFn,
}: {
	initial: UsageWindows | null;
	liveQueryCount: number;
	rateLimit: RateLimitMessage | null;
	/** Extra section appended after the standard windows (e.g. ContextWindowSection or RoutinesWindowSection). */
	tail?: React.ReactNode;
	/** Called to refresh usage data; should resolve to the latest UsageWindows. */
	fetchFn: () => Promise<UsageWindows | null>;
}) {
	const [data, setData] = useState<UsageWindows | null>(initial);
	const fetchFnRef = useRef(fetchFn);
	fetchFnRef.current = fetchFn;

	useEffect(() => {
		if (liveQueryCount === 0) return;
		void fetchFnRef
			.current()
			.then((d) => {
				if (d) setData((prev) => mergeUsageWindows(d, prev));
			})
			.catch(() => {});
	}, [liveQueryCount]);

	useEffect(() => {
		const id = setInterval(
			() =>
				void fetchFnRef
					.current()
					.then((d) => {
						if (d) setData((prev) => mergeUsageWindows(d, prev));
					})
					.catch(() => {}),
			60_000,
		);
		return () => clearInterval(id);
	}, []);

	useEffect(() => {
		if (!rateLimit || rateLimit.utilization == null) return;
		setData((prev) => {
			if (!prev) return prev;
			const update = {
				utilization: rateLimit.utilization ?? null,
				resetsAt: rateLimit.resetsAt ?? null,
			};
			if (rateLimit.rateLimitType === "five_hour")
				return { ...prev, fiveHour: { ...prev.fiveHour, ...update } };
			if (rateLimit.rateLimitType === "weekly_sonnet")
				return {
					...prev,
					weeklySonnet: {
						utilization: update.utilization,
						resetsAt: update.resetsAt,
					},
				};
			return { ...prev, weekly: { ...prev.weekly, ...update } };
		});
	}, [rateLimit]);

	return (
		<div className="border-b border-border shrink-0 flex divide-x divide-border/40">
			<UsageWindowSection label="5-HOUR" win={data?.fiveHour ?? null} />
			<UsageWindowSection label="7-DAY" win={data?.weekly ?? null} />
			{data?.weeklySonnet != null && (
				<UsageWindowSection
					label="SONNET"
					win={{ queries: 0, sessions: 0, cost: 0, ...data.weeklySonnet }}
					hideStats
				/>
			)}
			{tail}
		</div>
	);
}
