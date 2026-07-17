import { X } from "lucide-react";
import { useEffect, useState } from "react";
import type {
	LedgerAnalyticsFilter,
	LedgerToolErrorBreakdown,
	TopToolCall,
} from "#/db";
import { useDialogFocus } from "#/hooks/useDialogFocus";
import { getToolErrorsFn } from "#/lib/serverFns/stats";

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
	const cleaned = raw
		.replace(/^<tool_use_error>\s*/i, "")
		.replace(/\s*<\/tool_use_error>$/i, "")
		.trim();
	return cleaned || "No error details recorded.";
}

// ─── ErrorModal ───────────────────────────────────────────────────────────────

function ErrorModal({
	toolName,
	filter,
	expectedErrorCount,
	onClose,
}: {
	toolName: string;
	filter: LedgerAnalyticsFilter;
	expectedErrorCount: number;
	onClose: () => void;
}) {
	const [errors, setErrors] = useState<LedgerToolErrorBreakdown | null>(null);
	const { dialogRef, onDialogKeyDown } =
		useDialogFocus<HTMLDivElement>(onClose);

	useEffect(() => {
		let cancelled = false;
		getToolErrorsFn({ data: { toolName, filter } })
			.then((data) => {
				if (!cancelled) setErrors(data);
			})
			.catch(() => {
				if (!cancelled) {
					setErrors({ total: 0, distinct: 0, groups: [] });
				}
			});
		return () => {
			cancelled = true;
		};
	}, [filter, toolName]);

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
				onKeyDown={onDialogKeyDown}
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
						<div className="mt-1 text-[9px] tabular-nums text-muted-foreground">
							{errors === null
								? `${expectedErrorCount} errors in selected view`
								: `${errors.total} errors · ${errors.distinct} distinct ${errors.distinct === 1 ? "message" : "messages"}`}
						</div>
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
					) : errors.total === 0 ? (
						<div className="text-[10px] text-muted-foreground">
							No error details found.
						</div>
					) : (
						<div className="space-y-2">
							{errors.groups.map((e, i) => (
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
							{errors.groups.length < errors.distinct && (
								<div className="pt-2 text-[9px] text-muted-foreground">
									Showing the top {errors.groups.length} of {errors.distinct}
									distinct messages.
								</div>
							)}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

// ─── TopToolsChart ────────────────────────────────────────────────────────────

const ALL_TIME_FILTER: LedgerAnalyticsFilter = { range: "all" };

export function TopToolsChart({
	data,
	filter = ALL_TIME_FILTER,
}: {
	data: TopToolCall[];
	filter?: LedgerAnalyticsFilter;
}) {
	const [selectedTool, setSelectedTool] = useState<{
		name: string;
		errorCount: number;
	} | null>(null);
	const empty = data.length === 0;
	const rows = data.map((d) => {
		const errorCount = d.errorCount ?? Math.round(d.count * d.errorRate);
		return {
			name: shortToolName(d.name),
			fullName: d.name,
			count: d.count,
			errorCount,
			errorRate: d.count > 0 ? errorCount / d.count : 0,
		};
	});
	const max = Math.max(1, ...rows.map((row) => row.count));

	return (
		<>
			<div className="border border-border bg-card">
				<div className="border-b border-border px-4 py-3">
					<div className="flex items-baseline justify-between gap-2">
						<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
							Top tool calls
						</div>
						{!empty && (
							<div className="text-[9px] text-muted-foreground/60">
								Top {data.length} by count
							</div>
						)}
					</div>
					<div className="mt-2 flex gap-4 text-[8px] tracking-widest text-muted-foreground uppercase">
						<span className="flex items-center gap-1.5">
							<span className="h-2 w-2 bg-[var(--data)]" />
							Total calls
						</span>
						<span className="flex items-center gap-1.5">
							<span className="h-2 w-2 bg-[var(--chart-error)]" />
							Errors
						</span>
					</div>
				</div>
				{empty ? (
					<div className="grid min-h-36 place-items-center text-[10px] tracking-widest text-muted-foreground/40 uppercase">
						No tool events recorded
					</div>
				) : (
					<div className="divide-y divide-border/40 p-2">
						{rows.map((row) => {
							const errorCount = row.errorCount;
							return (
								<button
									key={row.fullName}
									type="button"
									disabled={errorCount <= 0}
									onClick={() =>
										setSelectedTool({
											name: row.fullName,
											errorCount,
										})
									}
									className="block min-h-12 w-full px-2 py-2 text-left hover:bg-accent/30 disabled:cursor-default"
								>
									<div className="flex items-center justify-between gap-3">
										<span
											className="min-w-0 truncate font-mono text-[10px] text-foreground/80"
											title={row.fullName}
										>
											{row.name}
										</span>
										<span className="shrink-0 text-[9px] tabular-nums text-muted-foreground">
											{row.count} calls ·{" "}
											<span
												className={errorCount > 0 ? "text-destructive" : ""}
											>
												{errorCount} errors ({(row.errorRate * 100).toFixed(1)}
												%)
											</span>
										</span>
									</div>
									<div className="relative mt-1.5 h-1.5 overflow-hidden bg-secondary">
										<div
											className="absolute inset-y-0 left-0 bg-[var(--data)]"
											style={{ width: `${(row.count / max) * 100}%` }}
										/>
										<div
											className="absolute inset-y-0 left-0 bg-[var(--chart-error)]"
											style={{ width: `${(errorCount / max) * 100}%` }}
										/>
									</div>
								</button>
							);
						})}
					</div>
				)}
			</div>

			{selectedTool && (
				<ErrorModal
					toolName={selectedTool.name}
					filter={filter}
					expectedErrorCount={selectedTool.errorCount}
					onClose={() => setSelectedTool(null)}
				/>
			)}
		</>
	);
}
