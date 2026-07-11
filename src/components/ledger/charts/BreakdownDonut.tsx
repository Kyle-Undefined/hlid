import { Cell, Pie, PieChart, Tooltip } from "recharts";
import { ChartCard } from "../ChartCard";
import { DonutLegend } from "./DonutLegend";
import { sliceOpacity } from "./donutPalette";

interface BreakdownRow {
	key: string;
	label: string;
	value: number;
}

interface BreakdownDonutProps {
	title: string;
	subtitle?: string;
	height: number;
	emptyMessage: string;
	innerRadius: string;
	rows: BreakdownRow[];
	formatTooltipValue?: (value: number) => string;
}

export function BreakdownDonut({
	title,
	subtitle,
	height,
	emptyMessage,
	innerRadius,
	rows,
	formatTooltipValue = String,
}: BreakdownDonutProps) {
	const total = rows.reduce((sum, row) => sum + row.value, 0);
	const empty = rows.length === 0 || total === 0;

	return (
		<ChartCard
			title={title}
			subtitle={empty ? undefined : subtitle}
			height={height}
			empty={empty ? emptyMessage : undefined}
			aside={!empty && <DonutLegend rows={rows} total={total} />}
		>
			<PieChart>
				<Pie
					data={rows}
					dataKey="value"
					nameKey="label"
					innerRadius={innerRadius}
					outerRadius="85%"
					stroke="var(--background)"
					strokeWidth={2}
					isAnimationActive={false}
				>
					{rows.map((row, index) => (
						<Cell
							key={row.key}
							fill="var(--data)"
							fillOpacity={sliceOpacity(index)}
						/>
					))}
				</Pie>
				<Tooltip
					content={({ active, payload }) => {
						if (!active || !payload?.length) return null;
						const row = payload[0].payload as BreakdownRow;
						const percentage =
							total > 0 ? ((row.value / total) * 100).toFixed(1) : "0";
						return (
							<div className="text-[9px] tabular-nums bg-background/95 border border-border px-2 py-1 rounded shadow-sm text-foreground/80 space-y-0.5">
								<div className="text-foreground">{row.label}</div>
								<div>
									{formatTooltipValue(row.value)} · {percentage}%
								</div>
							</div>
						);
					}}
				/>
			</PieChart>
		</ChartCard>
	);
}
