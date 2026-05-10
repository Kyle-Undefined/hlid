import { AlertTriangle, Check, ChevronRight } from "lucide-react";
import { useState } from "react";
import { MarkdownBody } from "#/components/MarkdownBody";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { ToolEventMessage } from "#/server/protocol";

const RESULT_PREVIEW_CHARS = 120;

function firstLine(text: string): string {
	const nl = text.indexOf("\n");
	return nl === -1 ? text : text.slice(0, nl);
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

export function ToolBlock({
	event,
	permissionLabel,
}: {
	event: ToolEventMessage;
	permissionLabel?: string;
}) {
	const [open, setOpen] = useState(false);
	const pills = Object.entries(event.input ?? {}).slice(0, 3);
	const hasResult = typeof event.result === "string";
	const resultText = event.result ?? "";
	const strippedResult = stripReadLineNumbers(resultText);
	const renderResultAsMarkdown =
		hasResult && !event.isError && looksLikeMarkdown(strippedResult);
	const resultPreview = hasResult
		? firstLine(resultText).slice(0, RESULT_PREVIEW_CHARS)
		: null;

	return (
		<div className="my-0.5">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				aria-expanded={open}
				className="flex items-center gap-2.5 w-full px-3 py-1.5 group hover:bg-primary/[0.03] transition-colors text-left"
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
				<PrivacyMask className="flex gap-1.5 flex-wrap">
					{pills.map(([k, v]) => (
						<span
							key={k}
							className="text-[9px] tracking-wide border border-primary/20 text-primary/50 px-1.5 py-0.5 font-mono break-all"
						>
							{k}: {typeof v === "string" ? v : JSON.stringify(v)}
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
						event.isError ? "text-destructive/70" : "text-muted-foreground/55"
					}`}
				>
					{event.isError && (
						<AlertTriangle
							className="w-2.5 h-2.5 shrink-0 text-destructive/70"
							aria-label="Error"
						/>
					)}
					<span className="truncate">
						<PrivacyMask inline>
							{resultPreview && resultPreview.length > 0
								? resultPreview
								: event.isError
									? "(error)"
									: "(empty)"}
						</PrivacyMask>
					</span>
				</div>
			)}
			{open && (
				<PrivacyMask className="mx-3 mb-1.5 border border-[var(--tool-panel-border)] bg-[var(--tool-panel)]">
					<div className="text-[11px] text-primary/60 font-mono leading-relaxed p-3 overflow-auto max-h-48 space-y-1">
						{Object.entries(event.input ?? {}).map(([k, v]) => (
							<div key={k} className="flex gap-1.5 min-w-0">
								<span className="text-primary/40 shrink-0">{k}:</span>
								{typeof v === "string" ? (
									<span className="whitespace-pre-wrap break-words min-w-0">
										{v}
									</span>
								) : (
									<span className="whitespace-pre-wrap break-words min-w-0">
										{JSON.stringify(v, null, 2)}
									</span>
								)}
							</div>
						))}
					</div>
					{hasResult && (
						<div className="border-t border-[var(--tool-panel-border)]">
							<div
								className={`text-[9px] tracking-widest uppercase px-3 pt-2 pb-1 ${
									event.isError
										? "text-destructive/70"
										: "text-muted-foreground/50"
								}`}
							>
								{event.isError ? "Error" : "Result"}
							</div>
							{renderResultAsMarkdown ? (
								<div className="px-3 pb-3 overflow-auto max-h-64 text-[12px] text-primary/80 leading-relaxed">
									<MarkdownBody content={strippedResult} />
								</div>
							) : (
								<pre
									className={`text-[11px] font-mono leading-relaxed px-3 pb-3 overflow-auto max-h-64 whitespace-pre-wrap break-words ${
										event.isError ? "text-destructive/80" : "text-primary/70"
									}`}
								>
									{strippedResult}
								</pre>
							)}
						</div>
					)}
				</PrivacyMask>
			)}
		</div>
	);
}
