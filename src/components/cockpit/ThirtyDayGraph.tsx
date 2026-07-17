import { useMemo } from "react";
import {
	Area,
	AreaChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { ThirtyDayStats } from "#/db";

function fmtTickDate(iso: string): string {
	const [, m, d] = iso.split("-");
	const month = [
		"Jan",
		"Feb",
		"Mar",
		"Apr",
		"May",
		"Jun",
		"Jul",
		"Aug",
		"Sep",
		"Oct",
		"Nov",
		"Dec",
	][parseInt(m, 10) - 1];
	return `${month} ${parseInt(d, 10)}`;
}

export function ThirtyDayGraph({
	data,
	label = "30D activity",
}: {
	data: ThirtyDayStats;
	label?: string;
}) {
	const points = useMemo(() => {
		let running = 0;
		return data.days.map((d) => {
			running += d.count;
			return { date: d.date, value: running };
		});
	}, [data.days]);

	const isEmpty = data.total === 0;

	const tickDates = useMemo(() => {
		if (data.days.length === 0) return [];
		// show ~4 ticks: day 0, ~10, ~20, last
		return [0, 9, 19, 29]
			.filter((i) => i < data.days.length)
			.map((i) => data.days[i].date);
	}, [data.days]);

	return (
		<div className="border-b border-border shrink-0 px-4 pt-2.5 pb-0">
			<div className="flex items-center justify-between mb-1">
				<span className="text-[9px] tracking-widest text-muted-foreground/40 uppercase">
					{label}
				</span>
				<PrivacyMask
					inline
					className="text-[9px] tabular-nums text-muted-foreground/50"
				>
					{data.total} queries
				</PrivacyMask>
			</div>
			<ResponsiveContainer width="100%" height={56}>
				<AreaChart
					data={points}
					margin={{ top: 2, right: 0, bottom: 0, left: 0 }}
				>
					<defs>
						<linearGradient id="thirtyDayFill" x1="0" y1="0" x2="0" y2="1">
							<stop
								offset="0%"
								style={{ stopColor: "var(--data)" }}
								stopOpacity={0.2}
							/>
							<stop
								offset="100%"
								style={{ stopColor: "var(--data)" }}
								stopOpacity={0}
							/>
						</linearGradient>
					</defs>
					<XAxis
						dataKey="date"
						ticks={tickDates}
						tickFormatter={fmtTickDate}
						tickLine={false}
						axisLine={false}
						tick={{
							fontSize: 8,
							fill: "color-mix(in oklch, var(--muted-foreground) 45%, transparent)",
							fontFamily: "inherit",
						}}
						interval="preserveStartEnd"
						height={16}
					/>
					<YAxis hide domain={isEmpty ? [0, 1] : ["auto", "auto"]} />
					<Tooltip
						content={({ active, payload }) => {
							if (!active || !payload?.length) return null;
							const val = payload[0]?.value;
							if (val == null) return null;
							return (
								<div className="text-[9px] tabular-nums bg-background/90 border border-border px-1.5 py-0.5 rounded shadow-sm text-foreground/70">
									{val}
								</div>
							);
						}}
						cursor={{
							stroke: "var(--data)",
							strokeWidth: 1,
							strokeOpacity: 0.3,
						}}
					/>
					<Area
						type="monotone"
						dataKey="value"
						stroke="var(--data)"
						strokeWidth={1.5}
						fill="url(#thirtyDayFill)"
						dot={false}
						activeDot={{ r: 3, fill: "var(--data)", strokeWidth: 0 }}
						isAnimationActive={false}
					/>
				</AreaChart>
			</ResponsiveContainer>
		</div>
	);
}
