import type { ReactElement, ReactNode } from "react";
import { ResponsiveContainer } from "recharts";

/**
 * Bordered card + uppercase header strip + fixed-height Recharts body.
 * Single extraction point so the chart components don't each redeclare the
 * container/header/ResponsiveContainer scaffolding.
 *
 * `footer` renders below the chart (legend, summary stats, etc.).
 * `aside` renders side-by-side with the chart on `lg+` viewports and stacks
 * below it on smaller ones — used by donut charts so the legend fills the
 * wide-screen whitespace instead of pushing it below the (already small) pie.
 * `caption` renders a small help line below the header on its own row — used
 * for axis-unit hints that don't fit in the right-aligned subtitle.
 */
export function ChartCard({
	title,
	subtitle,
	caption,
	height = 180,
	children,
	empty,
	footer,
	aside,
}: {
	title: string;
	subtitle?: string;
	caption?: string;
	height?: number;
	children: ReactElement;
	/** Optional empty-state node shown in place of the chart when there's no data. */
	empty?: ReactNode;
	footer?: ReactNode;
	aside?: ReactNode;
}) {
	// Compose an accessible label from title + subtitle so screen readers get a
	// meaningful chart description without each chart having to opt in.
	const ariaLabel = subtitle ? `${title}. ${subtitle}` : title;

	// `lg:flex-1 lg:min-w-0` only — applying flex-1 unconditionally collapses
	// the chart body to 0 height on mobile (flex-col with no parent height,
	// flex-basis: 0% wins over `style.height`). On lg+ the parent is flex-row
	// so flex-1 lets the chart fill the remaining horizontal space next to
	// the aside.
	const chartBody = empty ? (
		<div className="p-3 lg:flex-1 lg:min-w-0" style={{ height }}>
			<div className="h-full flex items-center justify-center text-[10px] tracking-widest text-muted-foreground/40 uppercase">
				{empty}
			</div>
		</div>
	) : (
		// role="img" + aria-label keeps screen readers from drilling into the
		// SVG and announces a useful summary instead.
		<div
			className="p-3 lg:flex-1 lg:min-w-0"
			style={{ height }}
			role="img"
			aria-label={ariaLabel}
		>
			<ResponsiveContainer width="100%" height="100%">
				{children}
			</ResponsiveContainer>
		</div>
	);

	return (
		<div className="border border-border bg-card">
			<div className="px-4 py-3 border-b border-border">
				<div className="flex items-baseline justify-between gap-2">
					<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
						{title}
					</div>
					{subtitle && (
						<div className="text-[9px] tabular-nums text-muted-foreground/60 truncate">
							{subtitle}
						</div>
					)}
				</div>
				{caption && (
					<div className="text-[9px] text-muted-foreground/50 mt-1 leading-snug">
						{caption}
					</div>
				)}
			</div>
			{aside && !empty ? (
				<div className="flex flex-col lg:flex-row">
					{chartBody}
					<div className="lg:w-72 lg:shrink-0 lg:border-l lg:border-t-0 border-t border-border/40 px-4 py-3 lg:flex lg:items-center">
						<div className="w-full">{aside}</div>
					</div>
				</div>
			) : (
				chartBody
			)}
			{footer && !empty && (
				<div className="px-3 pb-3 pt-0 border-t border-border/40">{footer}</div>
			)}
		</div>
	);
}
