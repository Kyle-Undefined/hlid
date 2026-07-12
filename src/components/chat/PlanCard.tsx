import { FileCode } from "lucide-react";
import { useEffect, useState } from "react";
import { MarkdownBody } from "#/components/MarkdownBody";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { PlanProposalMessage } from "./chatReducer";
import { PlanDecisionBar } from "./PlanDecisionBar";
import { PlanHtmlModal } from "./PlanHtmlModal";
import { ResolvedPlanCard } from "./ResolvedPlanCard";

export type PlanDecision = "approved" | "edited" | "cancelled";

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
	const [modalOpen, setModalOpen] = useState(
		() => message.decision === "pending" && Boolean(message.htmlRelicId),
	);

	useEffect(() => {
		if (message.decision === "pending" && message.htmlRelicId) {
			setModalOpen(true);
		}
	}, [message.decision, message.htmlRelicId]);

	if (message.decision !== "pending") {
		return (
			<ResolvedPlanCard
				message={message}
				modalOpen={modalOpen}
				onModalOpenChange={setModalOpen}
			/>
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
