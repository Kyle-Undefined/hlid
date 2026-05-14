import { sliceOpacity } from "./donutPalette";

/**
 * Two-column legend list for donut charts. Replaces inline pie labels which
 * clip outside the chart bounds on narrow viewports (the main mobile failure
 * mode). Slice index drives the same opacity ramp used for the donut fill so
 * the swatch and slice match visually.
 */
export function DonutLegend({
	rows,
	total,
}: {
	rows: { key: string; label: string; value: number }[];
	total: number;
}) {
	return (
		<ul className="grid grid-cols-1 gap-y-1.5">
			{rows.map((r, i) => {
				const pct = total > 0 ? ((r.value / total) * 100).toFixed(1) : "0";
				return (
					<li
						key={r.key}
						className="flex items-center gap-2 text-[10px] tabular-nums"
					>
						<span
							aria-hidden="true"
							className="inline-block w-2 h-2 shrink-0"
							style={{
								background: "var(--data)",
								opacity: sliceOpacity(i),
							}}
						/>
						<span className="text-foreground/80 truncate flex-1">
							{r.label}
						</span>
						<span className="text-muted-foreground">
							{r.value} · {pct}%
						</span>
					</li>
				);
			})}
		</ul>
	);
}
