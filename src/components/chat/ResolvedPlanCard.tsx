import { ChevronDown, ChevronRight, FileCode } from "lucide-react";
import { useState } from "react";
import { MarkdownBody } from "#/components/MarkdownBody";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { PlanProposalMessage } from "./chatReducer";
import { PlanHtmlModal } from "./PlanHtmlModal";

const RESOLVED_LABEL: Record<
	Exclude<PlanProposalMessage["decision"], "pending">,
	string
> = {
	approved: "PLAN APPROVED",
	edited: "PLAN REVISED",
	cancelled: "PLAN CANCELLED",
};

/** Collapsed/expandable recap of an already-decided plan proposal (approved, edited, or cancelled). */
export function ResolvedPlanCard({
	message,
	modalOpen,
	onModalOpenChange,
}: {
	message: PlanProposalMessage;
	modalOpen: boolean;
	onModalOpenChange: (open: boolean) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	if (message.decision === "pending") return null;
	const label = RESOLVED_LABEL[message.decision];
	const isApproved = message.decision === "approved";
	const labelColor = isApproved
		? "text-green-600/70"
		: message.decision === "edited"
			? "text-amber-500/80"
			: "text-destructive/70";

	// Revised plans: hide content — they're superseded by the next proposal.
	if (message.decision === "edited") {
		return (
			<div className="py-2 border-b border-border/40">
				<div className="flex items-center gap-2 px-3">
					<span className="w-3 shrink-0" />
					<span className="text-[9px] tracking-widest text-muted-foreground/40 uppercase">
						PLAN
					</span>
					<span
						className={`text-[9px] tracking-widest uppercase ${labelColor}`}
					>
						{label}
					</span>
				</div>
			</div>
		);
	}

	// Approved / cancelled: collapsed by default, expandable on click.
	return (
		<div className="py-2 border-b border-border/40">
			<div className="flex items-center gap-2 px-3">
				<button
					type="button"
					onClick={() => setExpanded((v) => !v)}
					aria-label={expanded ? "Collapse plan" : "Expand plan"}
					className="flex items-center gap-2 flex-1 text-left"
				>
					<span className="w-3 shrink-0 text-muted-foreground/30">
						{expanded ? (
							<ChevronDown className="w-3 h-3" />
						) : (
							<ChevronRight className="w-3 h-3" />
						)}
					</span>
					<span className="text-[9px] tracking-widest text-muted-foreground/40 uppercase">
						PLAN
					</span>
					<span
						className={`text-[9px] tracking-widest uppercase ${labelColor}`}
					>
						{label}
					</span>
				</button>
				{message.htmlRelicId && (
					<button
						type="button"
						onClick={() => onModalOpenChange(true)}
						className="flex items-center gap-1 text-[9px] tracking-widest text-muted-foreground/50 hover:text-foreground uppercase"
					>
						<FileCode className="w-3 h-3" />
						VIEW HTML
					</button>
				)}
			</div>
			{expanded && (
				<PrivacyMask className="text-sm text-foreground/65 leading-relaxed pr-4 px-8 pt-2 opacity-70">
					<MarkdownBody content={message.plan} />
				</PrivacyMask>
			)}
			{modalOpen && message.htmlRelicId && (
				<PlanHtmlModal
					relicId={message.htmlRelicId}
					readOnly
					onClose={() => onModalOpenChange(false)}
				/>
			)}
		</div>
	);
}
