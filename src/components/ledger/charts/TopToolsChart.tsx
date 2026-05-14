import { Bar, BarChart, Cell, Tooltip, XAxis, YAxis } from "recharts";
import type { TopToolCall } from "#/db";
import { ChartCard } from "../ChartCard";

const AXIS_TICK = {
	fontSize: 9,
	fill: "color-mix(in oklch, var(--muted-foreground) 60%, transparent)",
	fontFamily: "inherit",
};

/**
 * Strip MCP prefix for display so `mcp__server__tool` reads as `tool`.
 * Falls back to the raw name if no double-underscore prefix is present.
 */
function shortToolName(name: string): string {
	const parts = name.split("__");
	return parts.length > 1 ? parts[parts.length - 1] : name;
}

export function TopToolsChart({ data }: { data: TopToolCall[] }) {
	const empty = data.length === 0;
	const rows = data.map((d) => ({
		name: shortToolName(d.name),
		fullName: d.name,
		count: d.count,
		errorRate: d.errorRate,
	}));
	// Dynamic height: 26px per row + 20px padding, floor of 140 so the smallest
	// charts still have visual air.
	const height = empty ? 140 : Math.max(140, 26 * rows.length + 20);

	return (
		<ChartCard
			title="Top tool calls"
			subtitle={empty ? undefined : `Top ${data.length} by count`}
			height={height}
			empty={empty ? "No tool events yet" : undefined}
		>
			<BarChart
				data={rows}
				layout="vertical"
				margin={{ top: 4, right: 12, bottom: 0, left: 8 }}
			>
				<XAxis
					type="number"
					tick={AXIS_TICK}
					axisLine={false}
					tickLine={false}
				/>
				<YAxis
					type="category"
					dataKey="name"
					tick={AXIS_TICK}
					axisLine={false}
					tickLine={false}
					width={84}
				/>
				<Tooltip
					cursor={{ fill: "color-mix(in oklch, var(--data) 8%, transparent)" }}
					content={({ active, payload }) => {
						if (!active || !payload?.length) return null;
						const r = payload[0].payload as (typeof rows)[number];
						return (
							<div className="text-[9px] tabular-nums bg-background/95 border border-border px-2 py-1 rounded shadow-sm text-foreground/80 space-y-0.5">
								<div className="text-foreground">{r.fullName}</div>
								<div>{r.count} calls</div>
								<div className="text-muted-foreground">
									{(r.errorRate * 100).toFixed(1)}% errors
								</div>
							</div>
						);
					}}
				/>
				{/* Single bar per tool. Cell fill ramps from --data (no errors)
				    toward --destructive as errorRate rises so high-error tools
				    visually pop instead of fading away. */}
				<Bar dataKey="count" radius={[0, 2, 2, 0]} isAnimationActive={false}>
					{rows.map((r) => {
						// Defensive clamp: errorRate is contract-bounded to [0,1] but
						// guard against bad upstream data so opacity stays valid.
						const er = Math.max(0, Math.min(1, r.errorRate));
						// Min opacity 0.7 keeps low-error bars readable on the dark
						// theme background (--destructive is too muddy at <0.7).
						return (
							<Cell
								key={r.fullName}
								fill={er > 0 ? "var(--chart-error)" : "var(--data)"}
								fillOpacity={er > 0 ? 0.7 + er * 0.3 : 0.85}
							/>
						);
					})}
				</Bar>
			</BarChart>
		</ChartCard>
	);
}
