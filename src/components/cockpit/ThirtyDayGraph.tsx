import {
	type PointerEvent as ReactPointerEvent,
	useId,
	useMemo,
	useState,
} from "react";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { ThirtyDayStats } from "#/db";
import { useIsDesktop } from "#/hooks/useIsDesktop";

const CHART_WIDTH = 1_000;
const PLOT_HEIGHT = 40;
const PLOT_TOP = 2;
const PLOT_BOTTOM = 38;
const DESKTOP_TICK_COUNT = 4;
const MOBILE_TICK_COUNT = 3;

type GraphPoint = {
	date: string;
	value: number;
	x: number;
	y: number;
};

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

function buildTickIndexes(dayCount: number, maxTickCount: number): number[] {
	const tickCount = Math.min(maxTickCount, dayCount);
	if (tickCount <= 0) return [];
	if (tickCount === 1) return [0];

	const lastIndex = dayCount - 1;
	return Array.from({ length: tickCount }, (_, tickIndex) =>
		Math.floor((tickIndex * lastIndex) / (tickCount - 1)),
	);
}

function buildGraphPoints(days: ThirtyDayStats["days"]): GraphPoint[] {
	let running = 0;
	const cumulative = days.map((day) => {
		running += day.count;
		return { date: day.date, value: running };
	});
	const maxValue = Math.max(1, ...cumulative.map((point) => point.value));
	const xDivisor = Math.max(1, cumulative.length - 1);
	const plotHeight = PLOT_BOTTOM - PLOT_TOP;

	return cumulative.map((point, index) => ({
		...point,
		x: (index / xDivisor) * CHART_WIDTH,
		y: PLOT_BOTTOM - (point.value / maxValue) * plotHeight,
	}));
}

function linePath(points: GraphPoint[]): string {
	return points
		.map(
			(point, index) =>
				`${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`,
		)
		.join(" ");
}

function areaPath(points: GraphPoint[]): string {
	if (points.length === 0) return "";
	const first = points[0];
	const last = points.at(-1) as GraphPoint;
	return `${linePath(points)} L ${last.x.toFixed(2)} ${PLOT_BOTTOM} L ${first.x.toFixed(2)} ${PLOT_BOTTOM} Z`;
}

function pointerIndex(
	event: ReactPointerEvent<SVGSVGElement>,
	pointCount: number,
): number | null {
	if (pointCount === 0) return null;
	const bounds = event.currentTarget.getBoundingClientRect();
	if (bounds.width <= 0) return null;
	const ratio = Math.max(
		0,
		Math.min(1, (event.clientX - bounds.left) / bounds.width),
	);
	return Math.round(ratio * (pointCount - 1));
}

export function ThirtyDayGraph({
	data,
	label = "30D activity",
}: {
	data: ThirtyDayStats;
	label?: string;
}) {
	const gradientId = `thirty-day-fill-${useId().replaceAll(":", "")}`;
	const isDesktop = useIsDesktop();
	const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
	const points = useMemo(() => buildGraphPoints(data.days), [data.days]);
	const seriesPath = useMemo(() => linePath(points), [points]);
	const fillPath = useMemo(() => areaPath(points), [points]);
	const tickIndexes = useMemo(
		() =>
			buildTickIndexes(
				data.days.length,
				isDesktop ? DESKTOP_TICK_COUNT : MOBILE_TICK_COUNT,
			),
		[data.days.length, isDesktop],
	);
	const hoveredPoint = hoveredIndex === null ? undefined : points[hoveredIndex];
	const chartLabel = `${label}: cumulative queries`;

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
			<div className="relative h-14 w-full">
				<svg
					role="img"
					aria-label={chartLabel}
					className="absolute inset-x-0 top-0 h-10 w-full touch-pan-y overflow-visible"
					viewBox={`0 0 ${CHART_WIDTH} ${PLOT_HEIGHT}`}
					preserveAspectRatio="none"
					onPointerMove={(event) =>
						setHoveredIndex(pointerIndex(event, points.length))
					}
					onPointerLeave={() => setHoveredIndex(null)}
				>
					<title>{chartLabel}</title>
					<defs>
						<linearGradient
							id={gradientId}
							x1="0"
							y1="0"
							x2="0"
							y2={PLOT_HEIGHT}
							gradientUnits="userSpaceOnUse"
						>
							<stop offset="0%" stopColor="var(--data)" stopOpacity={0.2} />
							<stop offset="100%" stopColor="var(--data)" stopOpacity={0} />
						</linearGradient>
					</defs>
					{fillPath && (
						<path
							data-series="running-total-area"
							d={fillPath}
							fill={`url(#${gradientId})`}
						/>
					)}
					{seriesPath && (
						<path
							data-series="running-total"
							d={seriesPath}
							fill="none"
							stroke="var(--data)"
							strokeWidth={1.5}
							strokeLinejoin="round"
							strokeLinecap="round"
							vectorEffect="non-scaling-stroke"
						/>
					)}
					{hoveredPoint && (
						<line
							x1={hoveredPoint.x}
							x2={hoveredPoint.x}
							y1={PLOT_TOP}
							y2={PLOT_BOTTOM}
							stroke="var(--data)"
							strokeWidth={1}
							strokeOpacity={0.3}
							vectorEffect="non-scaling-stroke"
						/>
					)}
				</svg>
				{hoveredPoint && (
					<>
						<span
							aria-hidden
							className="pointer-events-none absolute h-1.5 w-1.5 rounded-full bg-[var(--data)]"
							style={{
								left: `${(hoveredPoint.x / CHART_WIDTH) * 100}%`,
								top: `${(hoveredPoint.y / PLOT_HEIGHT) * 40}px`,
								transform: "translate(-50%, -50%)",
							}}
						/>
						<span
							role="tooltip"
							className="pointer-events-none absolute rounded border border-border bg-background/90 px-1.5 py-0.5 text-[9px] tabular-nums text-foreground/70 shadow-sm"
							style={{
								left: `${Math.max(3, Math.min(97, (hoveredPoint.x / CHART_WIDTH) * 100))}%`,
								top: `${(hoveredPoint.y / PLOT_HEIGHT) * 40}px`,
								transform: "translate(-50%, -120%)",
							}}
						>
							{hoveredPoint.value}
						</span>
					</>
				)}
				{tickIndexes.map((index) => {
					const position =
						data.days.length <= 1 ? 0 : (index / (data.days.length - 1)) * 100;
					const transform =
						index === 0
							? "none"
							: index === data.days.length - 1
								? "translateX(-100%)"
								: "translateX(-50%)";
					return (
						<span
							key={`${index}-${data.days[index].date}`}
							className="absolute bottom-0 whitespace-nowrap text-[8px] text-muted-foreground/45"
							style={{ left: `${position}%`, transform }}
						>
							{fmtTickDate(data.days[index].date)}
						</span>
					);
				})}
			</div>
		</div>
	);
}
