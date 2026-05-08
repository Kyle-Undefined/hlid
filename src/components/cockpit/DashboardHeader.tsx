import { PrivacyMask } from "#/components/PrivacyMask";
import type { AggStats } from "#/db";
import type * as wsStore from "#/hooks/wsStore";
import { fmt, fmtMs } from "#/lib/formatters";

export function DashboardHeader({
	stats,
	agg,
	isConnected,
}: {
	stats: wsStore.LiveStats;
	agg: AggStats;
	isConnected: boolean;
}) {
	const idle = stats.queries === 0;

	return (
		<div className="border-b border-border shrink-0">
			{/* Row 1, primary windows */}
			<div className="grid grid-cols-3 divide-x divide-border border-b border-border">
				{/* SESSION */}
				<div className="px-3 md:px-5 py-3 md:py-4">
					<div className="text-[9px] tracking-widest text-muted-foreground/50 uppercase mb-1 md:mb-2">
						Session
					</div>
					<div
						className={`text-lg md:text-2xl font-bold tabular-nums leading-none ${idle && !isConnected ? "text-muted-foreground/20" : "text-[var(--data)]"}`}
					>
						{isConnected || stats.cost > 0 ? `$${stats.cost.toFixed(4)}` : "--"}
					</div>
					<div className="mt-1 md:mt-1.5 text-[9px] tracking-wider text-muted-foreground/40">
						{idle ? "idle" : `${stats.queries}q · ${fmtMs(stats.duration_ms)}`}
					</div>
				</div>

				{/* TODAY */}
				<div className="px-3 md:px-5 py-3 md:py-4">
					<div className="text-[9px] tracking-widest text-muted-foreground/50 uppercase mb-1 md:mb-2">
						Today
					</div>
					<PrivacyMask
						inline
						className="text-lg md:text-2xl font-bold tabular-nums leading-none text-[var(--data)]"
					>
						${agg.today.cost.toFixed(4)}
					</PrivacyMask>
					<PrivacyMask className="mt-1 md:mt-1.5 text-[9px] tracking-wider text-muted-foreground/40">
						{agg.today.queries}q · {fmt(agg.today.tokens)} tok
					</PrivacyMask>
				</div>

				{/* THIS MONTH */}
				<div className="px-3 md:px-5 py-3 md:py-4">
					<div className="text-[9px] tracking-widest text-muted-foreground/50 uppercase mb-1 md:mb-2">
						This Month
					</div>
					<PrivacyMask
						inline
						className="text-lg md:text-2xl font-bold tabular-nums leading-none text-[var(--data)]"
					>
						${agg.thisMonth.cost.toFixed(4)}
					</PrivacyMask>
					<PrivacyMask className="mt-1 md:mt-1.5 text-[9px] tracking-wider text-muted-foreground/40">
						{agg.thisMonth.queries}q · {fmt(agg.thisMonth.tokens)} tok
					</PrivacyMask>
				</div>
			</div>

			{/* Row 2, all-time */}
			<div className="px-5 py-3 flex items-center gap-6">
				<div>
					<div className="text-[9px] tracking-widest text-muted-foreground/40 uppercase mb-1">
						All Time
					</div>
					<PrivacyMask
						inline
						className="text-sm font-bold tabular-nums text-foreground/60"
					>
						${agg.allTime.cost.toFixed(2)}
					</PrivacyMask>
				</div>
				<PrivacyMask className="flex items-center gap-4 text-[9px] tracking-wider text-muted-foreground/40">
					<span>
						<span className="text-foreground/50 tabular-nums">
							{fmt(agg.allTime.queries)}
						</span>{" "}
						queries
					</span>
					<span>
						<span className="text-foreground/50 tabular-nums">
							{fmt(agg.allTime.turns)}
						</span>{" "}
						turns
					</span>
					<span>
						<span className="text-foreground/50 tabular-nums">
							{fmt(
								(agg.allTime.input_tokens ?? 0) +
									(agg.allTime.output_tokens ?? 0) +
									(agg.allTime.cache_read_tokens ?? 0) +
									(agg.allTime.cache_creation_tokens ?? 0),
							)}
						</span>{" "}
						tok
					</span>
				</PrivacyMask>
			</div>
		</div>
	);
}
