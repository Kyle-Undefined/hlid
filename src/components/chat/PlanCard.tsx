import { ChevronDown, ChevronRight, FileCode } from "lucide-react";
import { useEffect, useState } from "react";
import { MarkdownBody } from "#/components/MarkdownBody";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { PlanProposalMessage } from "./chatReducer";
import { PlanDecisionBar } from "./PlanDecisionBar";
import { PlanHtmlModal } from "./PlanHtmlModal";

export type PlanDecision = "approved" | "edited" | "cancelled";

const RESOLVED_LABEL: Record<
	Exclude<PlanProposalMessage["decision"], "pending">,
	string
> = {
	approved: "PLAN APPROVED",
	edited: "PLAN REVISED",
	cancelled: "PLAN CANCELLED",
};

/**
 * Cancel / Approve / Revise controls shared by the inline PlanCard and
 * PlanHtmlModal — kept as one component so the two surfaces never drift.
 */
export function PlanCard({
	message,
	onDecide,
}: {
	message: PlanProposalMessage;
	onDecide: (id: string, decision: PlanDecision, feedback?: string) => void;
}) {
	const [feedback, setFeedback] = useState("");
	const [expanded, setExpanded] = useState(false);
	const [modalOpen, setModalOpen] = useState(
		() => message.decision === "pending" && Boolean(message.htmlRelicId),
	);

	useEffect(() => {
		if (message.decision === "pending" && message.htmlRelicId) {
			setModalOpen(true);
		}
	}, [message.decision, message.htmlRelicId]);

	if (message.decision !== "pending") {
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
							onClick={() => setModalOpen(true)}
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
						onClose={() => setModalOpen(false)}
					/>
				)}
			</div>
		);
	}

	const submitEdit = () => {
		const msg = feedback.trim();
		if (!msg) return;
		onDecide(message.id, "edited", msg);
	};
	const cancel = () => onDecide(message.id, "cancelled");
	const approve = () => onDecide(message.id, "approved");

	if (message.htmlRelicId) {
		return (
			<div className="flex gap-0 py-3">
				<div className="w-12 shrink-0 text-[9px] tracking-widest text-primary/60 pt-0.5 uppercase">
					PLAN
				</div>
				<div className="flex-1 min-w-0 border border-border bg-card">
					<div className="px-4 py-3 border-b border-border flex items-center justify-between gap-2">
						<div className="text-[9px] tracking-widest text-muted-foreground/65 uppercase">
							PROPOSED PLAN (HTML)
						</div>
						<button
							type="button"
							onClick={() => setModalOpen(true)}
							className="flex items-center gap-1.5 text-[10px] tracking-widest text-primary/80 hover:text-primary uppercase"
						>
							<FileCode className="w-3 h-3" />
							VIEW PLAN
						</button>
					</div>
					<PlanDecisionBar
						feedback={feedback}
						onFeedbackChange={setFeedback}
						onCancel={cancel}
						onApprove={approve}
						onRevise={submitEdit}
					/>
				</div>
				{modalOpen && (
					<PlanHtmlModal
						relicId={message.htmlRelicId}
						feedback={feedback}
						onFeedbackChange={setFeedback}
						onCancel={cancel}
						onApprove={approve}
						onRevise={submitEdit}
						onClose={() => setModalOpen(false)}
					/>
				)}
			</div>
		);
	}

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
				<PlanDecisionBar
					feedback={feedback}
					onFeedbackChange={setFeedback}
					onCancel={cancel}
					onApprove={approve}
					onRevise={submitEdit}
				/>
			</div>
		</div>
	);
}
