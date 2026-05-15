import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Bar, BarChart, Cell, Tooltip, XAxis, YAxis } from "recharts";
import type { ToolErrorEntry, TopToolCall } from "#/db";
import { getToolErrorsFn } from "#/lib/serverFns";
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

/**
 * Strip `<tool_use_error>...</tool_use_error>` wrapper if present, then trim.
 */
function cleanErrorText(raw: string): string {
	return raw
		.replace(/^<tool_use_error>\s*/i, "")
		.replace(/\s*<\/tool_use_error>$/i, "")
		.trim();
}

// ─── ErrorModal ───────────────────────────────────────────────────────────────

function ErrorModal({
	toolName,
	onClose,
}: {
	toolName: string;
	onClose: () => void;
}) {
	const [errors, setErrors] = useState<ToolErrorEntry[] | null>(null);
	const dialogRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		dialogRef.current?.focus();
		getToolErrorsFn({ data: toolName })
			.then(setErrors)
			.catch(() => setErrors([]));
	}, [toolName]);

	const displayName = shortToolName(toolName);

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: Escape handled by inner div
		// biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop pattern
		<div
			className="fixed inset-0 z-50 bg-background/70 backdrop-blur-sm flex items-center justify-center p-4"
			onClick={onClose}
		>
			<div
				ref={dialogRef}
				tabIndex={-1}
				role="dialog"
				aria-modal="true"
				aria-label={`Errors for ${displayName}`}
				className="relative bg-card border border-border shadow-lg w-full max-w-md max-h-[70vh] flex flex-col focus:outline-none"
				onClick={(e) => e.stopPropagation()}
				onKeyDown={(e) => {
					if (e.key === "Escape") onClose();
				}}
			>
				{/* Header */}
				<div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
					<div>
						<div className="text-xs font-medium text-foreground font-mono">
							{displayName}
						</div>
						{toolName !== displayName && (
							<div className="text-[9px] text-muted-foreground font-mono truncate max-w-[300px]">
								{toolName}
							</div>
						)}
					</div>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close"
						className="text-muted-foreground hover:text-foreground transition-colors p-1 -mr-1"
					>
						<X className="w-3.5 h-3.5" />
					</button>
				</div>

				{/* Body */}
				<div className="overflow-y-auto flex-1 p-4">
					{errors === null ? (
						<div className="text-[10px] text-muted-foreground animate-pulse">
							Loading…
						</div>
					) : errors.length === 0 ? (
						<div className="text-[10px] text-muted-foreground">
							No error details found.
						</div>
					) : (
						<div className="space-y-2">
							{errors.map((e, i) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: stable order from DB, no reorder
								<div key={i} className="flex gap-3 items-start">
									<span className="shrink-0 text-[9px] tabular-nums text-muted-foreground pt-0.5 min-w-[24px] text-right">
										{e.count}×
									</span>
									<span className="text-[10px] font-mono text-foreground/80 leading-relaxed break-all">
										{cleanErrorText(e.text)}
									</span>
								</div>
							))}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

// ─── TopToolsChart ────────────────────────────────────────────────────────────

export function TopToolsChart({ data }: { data: TopToolCall[] }) {
	const [selectedTool, setSelectedTool] = useState<string | null>(null);
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
		<>
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
						cursor={{
							fill: "color-mix(in oklch, var(--data) 8%, transparent)",
						}}
						content={({ active, payload }) => {
							if (!active || !payload?.length) return null;
							const r = payload[0].payload as (typeof rows)[number];
							return (
								<div className="text-[9px] tabular-nums bg-background/95 border border-border px-2 py-1 rounded shadow-sm text-foreground/80 space-y-0.5">
									<div className="text-foreground">{r.fullName}</div>
									<div>{r.count} calls</div>
									<div className="text-muted-foreground">
										{(r.errorRate * 100).toFixed(1)}% errors
										{r.errorRate > 0 && (
											<span className="ml-1 opacity-60">
												— click for details
											</span>
										)}
									</div>
								</div>
							);
						}}
					/>
					<Bar
						dataKey="count"
						radius={[0, 2, 2, 0]}
						isAnimationActive={false}
						onClick={(barData) => {
							const r = barData as unknown as (typeof rows)[number];
							if (r.errorRate > 0) setSelectedTool(r.fullName);
						}}
						style={{ cursor: "pointer" }}
					>
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

			{selectedTool && (
				<ErrorModal
					toolName={selectedTool}
					onClose={() => setSelectedTool(null)}
				/>
			)}
		</>
	);
}
