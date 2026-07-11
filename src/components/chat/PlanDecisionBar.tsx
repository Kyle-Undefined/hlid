import { Check, CornerDownLeft, X } from "lucide-react";

/** Shared plan controls used by both the inline card and HTML modal. */
export function PlanDecisionBar({
	feedback,
	onFeedbackChange,
	onCancel,
	onApprove,
	onRevise,
}: {
	feedback: string;
	onFeedbackChange: (value: string) => void;
	onCancel: () => void;
	onApprove: () => void;
	onRevise: () => void;
}) {
	return (
		<div>
			<div className="grid grid-cols-2 sm:grid-cols-3">
				<button
					type="button"
					onClick={onCancel}
					aria-label="Cancel plan"
					className="min-w-0 flex items-center justify-center gap-1.5 sm:gap-2 px-1 py-2 text-[10px] tracking-widest text-destructive/70 hover:bg-destructive/5 transition-colors uppercase border-b border-r border-border sm:border-b-0"
				>
					<X className="w-3 h-3 shrink-0" /> CANCEL
				</button>
				<button
					type="button"
					onClick={onApprove}
					aria-label="Approve plan"
					className="min-w-0 flex items-center justify-center gap-1.5 sm:gap-2 px-1 py-2 text-[10px] tracking-widest text-green-500/70 hover:bg-green-500/5 transition-colors uppercase border-b border-border sm:border-b-0 sm:border-l"
				>
					<Check className="w-3 h-3 shrink-0" /> APPROVE
				</button>
				<button
					type="button"
					onClick={onRevise}
					disabled={!feedback.trim()}
					aria-label="Send revisions"
					className="col-span-2 sm:col-span-1 min-w-0 flex items-center justify-center gap-1.5 sm:gap-2 px-1 py-2 text-[10px] tracking-widest text-amber-500/80 hover:bg-amber-500/5 disabled:opacity-30 disabled:hover:bg-transparent transition-colors uppercase sm:border-l border-border"
				>
					<CornerDownLeft className="w-3 h-3 shrink-0" /> REVISE
				</button>
			</div>
			<div className="flex items-stretch border-t border-border">
				<textarea
					aria-label="Plan revision feedback"
					value={feedback}
					onChange={(event) => onFeedbackChange(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							onRevise();
						}
					}}
					placeholder="Suggest revisions to the plan…"
					rows={1}
					className="flex-1 resize-none bg-transparent px-3 py-2 text-xs text-foreground/80 placeholder:text-muted-foreground/40 outline-none font-mono"
				/>
			</div>
		</div>
	);
}
