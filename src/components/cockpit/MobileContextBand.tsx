import { UtilBar } from "#/components/cockpit/CockpitSidebar";
import type { LiveStats } from "#/hooks/wsStore";

export function MobileContextBand({ stats }: { stats: LiveStats }) {
	const hasContext =
		stats.last_context_used != null && stats.context_window != null;
	if (!hasContext) return null;
	const contextUsed = stats.last_context_used ?? 0;
	const contextWindow = stats.context_window ?? 0;
	const contextPct =
		contextWindow > 0
			? Math.min((contextUsed / contextWindow) * 100, 100).toFixed(0)
			: "0";
	return (
		<div className="md:hidden border-b border-border shrink-0 px-4 py-2 flex items-center gap-3">
			<span className="text-[9px] tracking-widest text-muted-foreground/40 uppercase shrink-0">
				Context
			</span>
			<div className="flex-1">
				<UtilBar value={contextUsed} max={contextWindow} />
			</div>
			<span className="text-[9px] tabular-nums text-muted-foreground/40 shrink-0">
				{contextPct}%
			</span>
		</div>
	);
}
