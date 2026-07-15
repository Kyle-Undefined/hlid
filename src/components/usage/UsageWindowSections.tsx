import { HydrationSafeText } from "#/components/HydrationSafeText";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { ProviderWindowEntry } from "#/db";
import type { LiveStats } from "#/hooks/wsLiveStatsStore";
import { fmtDateUtc, fmtResetTime } from "#/lib/formatters";
import { providerWindowUsage } from "#/lib/usageWindows";

export function ContextWindowSection({ stats }: { stats: LiveStats }) {
	const hasContext =
		stats.last_context_used != null && stats.context_window != null;
	const contextUsed = stats.last_context_used ?? 0;
	const contextWindow = stats.context_window ?? 0;
	const utilization =
		hasContext && contextWindow > 0
			? Math.min((contextUsed / contextWindow) * 100, 100)
			: null;
	const barColor =
		utilization != null && utilization > 80
			? "bg-destructive/60"
			: utilization != null && utilization > 60
				? "bg-yellow-600/60"
				: "bg-primary/60";
	return (
		<div className="flex-1 px-2 py-2 md:px-4 md:py-2.5 min-w-0 space-y-1">
			<div className="flex flex-col md:flex-row md:items-center md:justify-between gap-0.5 md:gap-2">
				<div className="flex items-center gap-1.5 md:gap-2 min-w-0">
					<span className="text-[8px] md:text-[9px] tracking-widest text-muted-foreground/40 uppercase truncate leading-none">
						CONTEXT
					</span>
					{utilization != null && (
						<span className="text-[9px] md:text-[10px] tabular-nums font-medium text-foreground/60 shrink-0 leading-none">
							{Math.floor(utilization)}%
						</span>
					)}
				</div>
				{hasContext && (
					<span className="text-[8px] tracking-widest text-muted-foreground/50 truncate">
						<HydrationSafeText
							serverText={`${contextUsed.toLocaleString("en-US")} / ${contextWindow.toLocaleString("en-US")}`}
							clientText={`${contextUsed.toLocaleString()} / ${contextWindow.toLocaleString()}`}
						/>
					</span>
				)}
			</div>
			<div className="h-1 bg-secondary/40 overflow-hidden">
				<div
					className={`h-full transition-all duration-500 ${barColor}`}
					style={{ width: utilization != null ? `${utilization}%` : "0%" }}
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

export function ProviderWindowCell({
	win,
	estimatedCost = false,
}: {
	win: ProviderWindowEntry;
	estimatedCost?: boolean;
}) {
	const usage = providerWindowUsage(win);
	return (
		<div className="flex-1 px-2 py-2 md:px-4 md:py-2.5 min-w-0 space-y-1">
			<div className="flex flex-col md:flex-row md:items-center md:justify-between gap-0.5 md:gap-2">
				<div className="flex items-center gap-1.5 md:gap-2 min-w-0">
					<span className="text-[8px] md:text-[9px] tracking-widest text-muted-foreground/40 uppercase truncate leading-none">
						{win.label}
					</span>
					{usage.label && (
						<span className="text-[9px] md:text-[10px] tabular-nums font-medium text-foreground/60 shrink-0 leading-none">
							{usage.label}
						</span>
					)}
				</div>
				{win.resetsAt != null && (
					<span className="text-[8px] tracking-widest text-muted-foreground/50 truncate">
						<HydrationSafeText
							serverText={fmtDateUtc(win.resetsAt)}
							clientText={fmtResetTime(win.resetsAt)}
						/>
					</span>
				)}
			</div>
			<div className="h-1 bg-secondary/40 overflow-hidden">
				<div
					className="h-full bg-primary/60 transition-all duration-500"
					style={{
						width: usage.percentage != null ? `${usage.percentage}%` : "0%",
					}}
				/>
			</div>
			<div className="flex items-center flex-wrap gap-x-1.5 gap-y-0">
				<PrivacyMask
					inline
					className="text-[9px] tabular-nums text-foreground/50"
				>
					{(win.unpricedQueries ?? 0) > 0 && win.cost === 0
						? "--"
						: `${estimatedCost ? "~" : ""}$${(win.cost ?? 0).toFixed(2)}`}
				</PrivacyMask>
				<span className="text-muted-foreground/25 hidden md:inline">·</span>
				<PrivacyMask
					inline
					className="text-[8px] tracking-widest text-muted-foreground/40"
				>
					<span className="md:hidden">{win.queries}q</span>
					<span className="hidden md:inline">{win.queries} queries</span>
					{(win.unpricedQueries ?? 0) > 0 && (
						<span> · {win.unpricedQueries} unpriced</span>
					)}
				</PrivacyMask>
			</div>
		</div>
	);
}
