import { AlertTriangle, Check, ChevronRight } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { PrivacyMask } from "#/components/PrivacyMask";
import {
	type HistoricalToolEventDetail,
	loadToolEventDetail,
} from "#/hooks/toolEventDetailStore";
import type { ToolEventMessage } from "#/server/protocol";
import { SubagentToolBlock } from "./SubagentToolBlock";
import { ToolBlockExpandedPanel } from "./ToolBlockExpandedPanel";

const RESULT_PREVIEW_CHARS = 120;
const INPUT_PREVIEW_CHARS = 140;

function firstLine(text: string): string {
	const nl = text.indexOf("\n");
	return nl === -1 ? text : text.slice(0, nl);
}

function inputPreview(value: unknown): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.length <= INPUT_PREVIEW_CHARS
		? text
		: `${text.slice(0, INPUT_PREVIEW_CHARS)}…`;
}

/**
 * Strip the leading `   <line>\t` prefix that the Read tool prepends to every
 * line (cat -n style). Without this, markdown rendering of a Read result
 * collapses the tab and the numbers run inline with the content. Only strips
 * when the prefix appears on the majority of lines, so we don't mangle
 * arbitrary output that happens to start with digits + tab.
 */
export function stripReadLineNumbers(text: string): string {
	if (!text) return text;
	const lines = text.split("\n");
	const re = /^\s*\d+\t/;
	let matched = 0;
	for (const l of lines) {
		if (re.test(l)) matched++;
	}
	if (matched < Math.max(2, Math.floor(lines.length * 0.5))) return text;
	return lines.map((l) => l.replace(re, "")).join("\n");
}

/**
 * Heuristic — does this content look like markdown? Used to decide whether a
 * tool result renders as MarkdownBody (formatted) or <pre> (raw). Defaults to
 * pre because most tool output is logs/code/JSON, not prose.
 */
export function looksLikeMarkdown(text: string): boolean {
	if (!text) return false;
	// Headings (start of string or after newline).
	if (/^#{1,6} \S/m.test(text)) return true;
	// Fenced code blocks.
	if (/```/.test(text)) return true;
	// GitHub-flavored alert blockquotes.
	if (/^> \[![A-Z]+]/m.test(text)) return true;
	// Bullet/numbered lists at line start.
	if (/^(?:[-*+] |\d+\. )\S/m.test(text)) return true;
	// Inline link with brackets.
	if (/\[[^\]\n]+]\([^)\n]+\)/.test(text)) return true;
	// Multiple bold spans (single one is too weak).
	const boldMatches = text.match(/\*\*[^*\n]+\*\*/g);
	if (boldMatches && boldMatches.length >= 2) return true;
	// Markdown table.
	if (/^\|[^\n]+\|\s*\n\|[\s\-:|]+\|/m.test(text)) return true;
	return false;
}

export const ToolBlock = memo(function ToolBlock({
	event,
	permissionLabel,
}: {
	event: ToolEventMessage;
	permissionLabel?: string;
}) {
	const [open, setOpen] = useState(false);
	const [detail, setDetail] = useState<HistoricalToolEventDetail | null>(null);
	const [detailLoading, setDetailLoading] = useState(false);
	const [detailError, setDetailError] = useState<string | null>(null);
	const needsDetail =
		event.resultTruncated === true && Boolean(event.detailSessionId);

	useEffect(() => {
		if (
			!open ||
			!needsDetail ||
			!event.detailSessionId ||
			detail ||
			detailError
		)
			return;
		let cancelled = false;
		setDetailLoading(true);
		setDetailError(null);
		void loadToolEventDetail(event.detailSessionId, event.id)
			.then((loaded) => {
				if (!cancelled) setDetail(loaded);
			})
			.catch((error: unknown) => {
				if (!cancelled) {
					setDetailError(
						error instanceof Error
							? error.message
							: "Unable to load tool result",
					);
				}
			})
			.finally(() => {
				if (!cancelled) setDetailLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open, needsDetail, event.detailSessionId, event.id, detail, detailError]);

	if (event.subagent) {
		return <SubagentToolBlock subagent={event.subagent} />;
	}
	const inputEntries = Object.entries(event.input ?? {});
	const pills = inputEntries.slice(0, 3);
	const isReasoning = event.name === "Reasoning";
	const hydratedDetail = needsDetail ? detail : null;
	const isError = hydratedDetail?.isError ?? event.isError;
	const hasResult =
		typeof event.result === "string" ||
		(hydratedDetail?.result !== undefined && hydratedDetail.result !== null) ||
		(event.resultLength !== undefined && event.resultLength !== null);
	const resultText = hydratedDetail?.result ?? event.result ?? "";
	const canProcessResult = open && (!needsDetail || detail !== null);
	const strippedResult = canProcessResult
		? stripReadLineNumbers(resultText)
		: "";
	const renderResultAsMarkdown =
		canProcessResult &&
		hasResult &&
		!isError &&
		(isReasoning || looksLikeMarkdown(strippedResult));
	const resultPreview = hasResult
		? firstLine(event.result ?? resultText).slice(0, RESULT_PREVIEW_CHARS)
		: null;

	return (
		<div className="my-0.5 min-w-0 max-w-full overflow-hidden">
			<button
				type="button"
				onClick={() => {
					const nextOpen = !open;
					setOpen(nextOpen);
					// The shared detail cache is byte-bounded. Drop this component's
					// additional reference when it closes so evicted results can be GC'd.
					if (!nextOpen && needsDetail) setDetail(null);
				}}
				aria-expanded={open}
				className="flex items-center gap-2.5 w-full min-w-0 max-w-full overflow-hidden px-3 py-1.5 group hover:bg-primary/[0.03] transition-colors text-left"
			>
				<ChevronRight
					className={`w-3 h-3 shrink-0 text-primary/50 group-hover:text-primary/80 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
				/>
				<PrivacyMask
					inline
					className="text-[11px] font-medium tracking-wider text-primary/70 group-hover:text-primary/90 shrink-0"
				>
					{event.name}
				</PrivacyMask>
				<PrivacyMask className="flex flex-1 min-w-0 max-w-full gap-1.5 flex-nowrap overflow-hidden">
					{pills.map(([k, v]) => (
						<span
							key={k}
							className="block min-w-0 max-w-full truncate whitespace-nowrap text-[9px] tracking-wide border border-primary/20 text-primary/50 px-1.5 py-0.5 font-mono overflow-hidden"
						>
							{k}: {inputPreview(v)}
						</span>
					))}
				</PrivacyMask>
			</button>
			{permissionLabel && (
				<div className="flex items-center gap-1.5 pl-8 pr-3 pb-1 -mt-0.5 text-[9px] tracking-widest text-muted-foreground/55 uppercase">
					<Check className="w-2.5 h-2.5 text-green-600/55" />
					<span>{permissionLabel}</span>
				</div>
			)}
			{!open && hasResult && (
				<div
					className={`flex items-center gap-1.5 pl-8 pr-3 pb-1 text-[10px] font-mono leading-tight ${
						isError ? "text-destructive/70" : "text-muted-foreground/55"
					}`}
				>
					{isError && (
						<AlertTriangle
							className="w-2.5 h-2.5 shrink-0 text-destructive/70"
							aria-label="Error"
						/>
					)}
					<span className="truncate">
						<PrivacyMask inline>
							{resultPreview && resultPreview.length > 0
								? resultPreview
								: isError
									? "(error)"
									: "(empty)"}
						</PrivacyMask>
					</span>
				</div>
			)}
			{open && needsDetail && !detail && (
				<div className="mx-3 mb-1.5 min-w-0 max-w-[calc(100%_-_1.5rem)] border border-[var(--tool-panel-border)] bg-[var(--tool-panel)] px-3 py-2 text-[11px] text-muted-foreground/70">
					{detailError ? (
						<div className="flex items-center justify-between gap-3">
							<span>{detailError}</span>
							<button
								type="button"
								onClick={() => setDetailError(null)}
								className="shrink-0 text-primary/75 hover:text-primary underline underline-offset-2"
							>
								Retry
							</button>
						</div>
					) : (
						<span>{detailLoading ? "Loading full result…" : "Loading…"}</span>
					)}
				</div>
			)}
			{open && (!needsDetail || detail) && (
				<ToolBlockExpandedPanel
					inputEntries={inputEntries}
					hasResult={hasResult}
					isError={isError}
					isReasoning={isReasoning}
					renderResultAsMarkdown={renderResultAsMarkdown}
					strippedResult={strippedResult}
				/>
			)}
		</div>
	);
});
