import { Bar, BarChart, Tooltip, XAxis, YAxis } from "recharts";
import type { LatencyDistribution } from "#/db";
import { fmtMs } from "#/lib/formatters";
import { ChartCard } from "../ChartCard";

const AXIS_TICK = {
	fontSize: 9,
	fill: "color-mix(in oklch, var(--muted-foreground) 60%, transparent)",
	fontFamily: "inherit",
};

/**
 * Bucket labels are millisecond ranges (`<100`, `100-500`, …, `60k+`).
 * Each bar's height is the number of completed queries whose `duration_ms`
 * fell into that range. p50/p95 in the subtitle are the median and 95th-
 * percentile response time across all completed queries.
 */
export function LatencyChart({ data }: { data: LatencyDistribution }) {
	const empty = data.total === 0;
	return (
		<ChartCard
			title="Query latency"
			subtitle={
				empty
					? undefined
					: `p50 ${fmtMs(data.p50)} · p95 ${fmtMs(data.p95)} · ${data.total} queries`
			}
			caption={
				empty
					? undefined
					: "Queries grouped by response time (ms). Taller bar = more queries in that range."
			}
			height={160}
			empty={empty ? "No completed queries yet" : undefined}
		>
			<BarChart
				data={data.buckets}
				margin={{ top: 4, right: 8, bottom: 14, left: 0 }}
			>
				<XAxis
					dataKey="label"
					tick={AXIS_TICK}
					axisLine={false}
					tickLine={false}
					interval={0}
					label={{
						value: "duration (ms)",
						position: "insideBottom",
						offset: -6,
						style: {
							fontSize: 8,
							fill: "color-mix(in oklch, var(--muted-foreground) 50%, transparent)",
							fontFamily: "inherit",
							textTransform: "uppercase",
							letterSpacing: "0.1em",
						},
					}}
				/>
				<YAxis hide />
				<Tooltip
					cursor={{ fill: "color-mix(in oklch, var(--data) 8%, transparent)" }}
					content={({ active, payload }) => {
						if (!active || !payload?.length) return null;
						const r = payload[0].payload as { label: string; count: number };
						return (
							<div className="text-[9px] tabular-nums bg-background/95 border border-border px-2 py-1 rounded shadow-sm text-foreground/80">
								{r.label} ms · {r.count} {r.count === 1 ? "query" : "queries"}
							</div>
						);
					}}
				/>
				<Bar
					dataKey="count"
					fill="var(--data)"
					radius={[2, 2, 0, 0]}
					isAnimationActive={false}
				/>
			</BarChart>
		</ChartCard>
	);
}
