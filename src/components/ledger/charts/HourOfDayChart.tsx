import { Bar, BarChart, Tooltip, XAxis, YAxis } from "recharts";
import type { HourOfDayBucket } from "#/db";
import { ChartCard } from "../ChartCard";

const AXIS_TICK = {
	fontSize: 9,
	fill: "color-mix(in oklch, var(--muted-foreground) 60%, transparent)",
	fontFamily: "inherit",
};

const TICKS = [0, 6, 12, 18];

function fmtHour(h: number): string {
	if (h === 0) return "12a";
	if (h < 12) return `${h}a`;
	if (h === 12) return "12p";
	return `${h - 12}p`;
}

export function HourOfDayChart({ data }: { data: HourOfDayBucket[] }) {
	const total = data.reduce((a, d) => a + d.count, 0);
	const empty = total === 0;
	return (
		<ChartCard
			title="Time of day"
			subtitle={empty ? undefined : `${total} queries`}
			height={160}
			empty={empty ? "No query history yet" : undefined}
		>
			<BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
				<XAxis
					dataKey="hour"
					ticks={TICKS}
					tickFormatter={fmtHour}
					tick={AXIS_TICK}
					axisLine={false}
					tickLine={false}
					interval={0}
				/>
				<YAxis hide />
				<Tooltip
					cursor={{ fill: "color-mix(in oklch, var(--data) 8%, transparent)" }}
					content={({ active, payload }) => {
						if (!active || !payload?.length) return null;
						const r = payload[0].payload as HourOfDayBucket;
						return (
							<div className="text-[9px] tabular-nums bg-background/95 border border-border px-2 py-1 rounded shadow-sm text-foreground/80">
								{fmtHour(r.hour)} · {r.count}
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
