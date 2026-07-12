import { MarkdownBody } from "#/components/MarkdownBody";
import { PrivacyMask } from "#/components/PrivacyMask";

/** Expanded tool-call detail: input args (if any) followed by the result/error/reasoning body. */
export function ToolBlockExpandedPanel({
	inputEntries,
	hasResult,
	isError,
	isReasoning,
	renderResultAsMarkdown,
	strippedResult,
}: {
	inputEntries: [string, unknown][];
	hasResult: boolean;
	isError?: boolean;
	isReasoning: boolean;
	renderResultAsMarkdown: boolean;
	strippedResult: string;
}) {
	return (
		<PrivacyMask className="mx-3 mb-1.5 min-w-0 max-w-[calc(100%_-_1.5rem)] overflow-hidden border border-[var(--tool-panel-border)] bg-[var(--tool-panel)]">
			{inputEntries.length > 0 && (
				<div className="min-w-0 max-w-full text-[11px] text-primary/60 font-mono leading-relaxed p-3 overflow-y-auto overflow-x-hidden max-h-48 space-y-1">
					{inputEntries.map(([k, v]) => (
						<div key={k} className="flex gap-1.5 min-w-0">
							<span className="text-primary/40 shrink-0">{k}:</span>
							{typeof v === "string" ? (
								<span className="flex-1 min-w-0 max-w-full whitespace-pre-wrap break-all overflow-hidden">
									{v}
								</span>
							) : (
								<span className="flex-1 min-w-0 max-w-full whitespace-pre-wrap break-all overflow-hidden">
									{JSON.stringify(v, null, 2)}
								</span>
							)}
						</div>
					))}
				</div>
			)}
			{hasResult && (
				<div
					className={
						inputEntries.length > 0
							? "border-t border-[var(--tool-panel-border)]"
							: undefined
					}
				>
					<div
						className={`text-[9px] tracking-widest uppercase px-3 pt-2 pb-1 ${
							isError ? "text-destructive/70" : "text-muted-foreground/50"
						}`}
					>
						{isError ? "Error" : isReasoning ? "Reasoning" : "Result"}
					</div>
					{renderResultAsMarkdown ? (
						<div className="px-3 pb-3 overflow-auto max-h-64 text-[12px] text-primary/80 leading-relaxed">
							<MarkdownBody content={strippedResult} />
						</div>
					) : (
						<pre
							className={`text-[11px] font-mono leading-relaxed px-3 pb-3 overflow-auto max-h-64 whitespace-pre-wrap break-words ${
								isError ? "text-destructive/80" : "text-primary/70"
							}`}
						>
							{strippedResult}
						</pre>
					)}
				</div>
			)}
		</PrivacyMask>
	);
}
