import { useState } from "react";
import { DashboardHeader } from "#/components/cockpit/DashboardHeader";
import type { AggStats } from "#/db";
import type { LiveStats } from "#/hooks/wsLiveStatsStore";

export function MobileStatsPanel({
	stats,
	agg,
	isConnected,
}: {
	stats: LiveStats;
	agg: AggStats;
	isConnected: boolean;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div className="md:hidden shrink-0">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				className="w-full flex items-center justify-between px-4 py-2.5 border-b border-border hover:bg-accent/20 transition-colors"
			>
				<span className="text-[9px] tracking-widest text-muted-foreground/40 uppercase">
					Costs
				</span>
				<span
					aria-hidden="true"
					className="text-[9px] text-muted-foreground/30 transition-transform"
					style={{ transform: open ? "rotate(180deg)" : undefined }}
				>
					▾
				</span>
			</button>
			{open && (
				<DashboardHeader stats={stats} agg={agg} isConnected={isConnected} />
			)}
		</div>
	);
}
