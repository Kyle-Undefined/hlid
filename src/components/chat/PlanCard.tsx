import { Check, CornerDownLeft, X } from "lucide-react";
import { useState } from "react";
import { MarkdownBody } from "#/components/MarkdownBody";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { PlanProposalMessage } from "./chatReducer";

export type PlanDecision = "approved" | "edited" | "cancelled";

const RESOLVED_LABEL: Record<
	Exclude<PlanProposalMessage["decision"], "pending">,
	string
> = {
	approved: "PLAN APPROVED",
	edited: "PLAN REVISED",
	cancelled: "PLAN CANCELLED",
};

export function PlanCard({
	message,
	onDecide,
}: {
	message: PlanProposalMessage;
	onDecide: (id: string, decision: PlanDecision, feedback?: string) => void;
}) {
	const [feedback, setFeedback] = useState("");

	if (message.decision !== "pending") {
		const label = RESOLVED_LABEL[message.decision];
		const isApproved = message.decision === "approved";
		return (
			<div className="py-3 border-b border-border/40">
				<div className="flex items-baseline gap-2 px-3 mb-2">
					<span className="text-[9px] tracking-widest text-muted-foreground/55 uppercase">
						PLAN
					</span>
					<span
						className={`text-[9px] tracking-widest uppercase ${
							isApproved
								? "text-green-600/70"
								: message.decision === "edited"
									? "text-amber-500/80"
									: "text-destructive/70"
						}`}
					>
						{label}
					</span>
				</div>
				<PrivacyMask className="text-sm text-foreground/75 leading-relaxed pr-4 px-3 opacity-70">
					<MarkdownBody content={message.plan} />
				</PrivacyMask>
			</div>
		);
	}

	const submitEdit = () => {
		const msg = feedback.trim();
		if (!msg) return;
		onDecide(message.id, "edited", msg);
	};

	return (
		<div className="flex gap-0 py-3">
			<div className="w-12 shrink-0 text-[9px] tracking-widest text-primary/60 pt-0.5 uppercase">
				PLAN
			</div>
			<div className="flex-1 min-w-0 border border-border bg-card">
				<div className="px-4 py-3 border-b border-border">
					<div className="text-[9px] tracking-widest text-muted-foreground/65 uppercase mb-2">
						PROPOSED PLAN
					</div>
					<PrivacyMask className="text-sm text-foreground leading-relaxed">
						<MarkdownBody content={message.plan} />
					</PrivacyMask>
				</div>
				<div className="grid grid-cols-2 sm:grid-cols-3">
					<button
						type="button"
						onClick={() => onDecide(message.id, "cancelled")}
						aria-label="Cancel plan"
						className="min-w-0 flex items-center justify-center gap-1.5 sm:gap-2 px-1 py-2 text-[10px] tracking-widest text-destructive/70 hover:bg-destructive/5 transition-colors uppercase border-b border-r border-border sm:border-b-0"
					>
						<X className="w-3 h-3 shrink-0" />
						CANCEL
					</button>
					<button
						type="button"
						onClick={() => onDecide(message.id, "approved")}
						aria-label="Approve plan"
						className="min-w-0 flex items-center justify-center gap-1.5 sm:gap-2 px-1 py-2 text-[10px] tracking-widest text-green-500/70 hover:bg-green-500/5 transition-colors uppercase border-b border-border sm:border-b-0 sm:border-l"
					>
						<Check className="w-3 h-3 shrink-0" />
						APPROVE
					</button>
					<button
						type="button"
						onClick={submitEdit}
						disabled={!feedback.trim()}
						aria-label="Send revisions"
						className="col-span-2 sm:col-span-1 min-w-0 flex items-center justify-center gap-1.5 sm:gap-2 px-1 py-2 text-[10px] tracking-widest text-amber-500/80 hover:bg-amber-500/5 disabled:opacity-30 disabled:hover:bg-transparent transition-colors uppercase sm:border-l border-border"
					>
						<CornerDownLeft className="w-3 h-3 shrink-0" />
						REVISE
					</button>
				</div>
				<div className="flex items-stretch border-t border-border">
					<textarea
						aria-label="Plan revision feedback"
						value={feedback}
						onChange={(e) => setFeedback(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								submitEdit();
							}
						}}
						placeholder="Suggest revisions to the plan…"
						rows={1}
						className="flex-1 resize-none bg-transparent px-3 py-2 text-xs text-foreground/80 placeholder:text-muted-foreground/40 outline-none font-mono"
					/>
				</div>
			</div>
		</div>
	);
}
