import { X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ToolErrorEntry, TopToolCall } from "#/db";
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
	const { dialogRef, onDialogKeyDown } =
		useDialogFocus<HTMLDivElement>(onClose);

	useEffect(() => {
		let cancelled = false;
		getToolErrorsFn({ data: toolName })
			.then((data) => {
				if (!cancelled) setErrors(data);
			})
			.catch(() => {
				if (!cancelled) setErrors([]);
			});
		return () => {
			cancelled = true;
		};
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
							const errorCount = Math.round(row.count * row.errorRate);
							return (
								<button
									key={row.fullName}
									type="button"
									disabled={row.errorRate <= 0}
									onClick={() => setSelectedTool(row.fullName)}
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
					toolName={selectedTool}
					onClose={() => setSelectedTool(null)}
				/>
			)}
		</>
	);
}
