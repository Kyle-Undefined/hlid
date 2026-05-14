import { Cell, Pie, PieChart, Tooltip } from "recharts";
import type { ModelSplitEntry } from "#/db";
import { fmtModel } from "#/lib/formatters";
import { ChartCard } from "../ChartCard";
import { DonutLegend } from "./DonutLegend";
import { sliceOpacity } from "./donutPalette";

export function ModelSplitDonut({ data }: { data: ModelSplitEntry[] }) {
	const total = data.reduce((a, d) => a + d.count, 0);
	// Treat all-zero counts as empty too — the donut renders nothing in that
	// case and the legend would just be a row of zeros.
	const empty = data.length === 0 || total === 0;
	const rows = data.map((d) => ({
		name: fmtModel(d.model),
		raw: d.model,
		value: d.count,
	}));

	return (
		<ChartCard
			title="Model split"
			subtitle={empty ? undefined : `${total} sessions · ${data.length} models`}
			height={220}
			empty={empty ? "No sessions yet" : undefined}
			aside={
				!empty && (
					<DonutLegend
						rows={rows.map((r) => ({
							key: r.raw,
							label: r.name,
							value: r.value,
						}))}
						total={total}
					/>
				)
			}
		>
			<PieChart>
				<Pie
					data={rows}
					dataKey="value"
					nameKey="name"
					innerRadius="55%"
					outerRadius="85%"
					stroke="var(--background)"
					strokeWidth={2}
					isAnimationActive={false}
				>
					{rows.map((r, i) => (
						<Cell
							key={r.raw}
							fill="var(--data)"
							fillOpacity={sliceOpacity(i)}
						/>
					))}
				</Pie>
				<Tooltip
					content={({ active, payload }) => {
						if (!active || !payload?.length) return null;
						const r = payload[0].payload as (typeof rows)[number];
						const pct = total > 0 ? ((r.value / total) * 100).toFixed(1) : "0";
						return (
							<div className="text-[9px] tabular-nums bg-background/95 border border-border px-2 py-1 rounded shadow-sm text-foreground/80 space-y-0.5">
								<div className="text-foreground">{r.name}</div>
								<div>
									{r.value} sessions · {pct}%
								</div>
							</div>
						);
					}}
				/>
			</PieChart>
		</ChartCard>
	);
}
