import { Check } from "lucide-react";
import { ASK_USER_QUESTION_CANCEL_KEY } from "#/server/protocol";
import { AskUserQuestionProvenance } from "./AskUserQuestionProvenance";
import type { AskUserQuestionChatMessage } from "./chatReducer";

/** Read-only recap of an already-answered AskUserQuestion turn. */
export function AnsweredQuestionsSummary({
	message,
}: {
	message: AskUserQuestionChatMessage;
}) {
	const answers = message.answers ?? {};
	const submittedNotes = message.notes ?? {};
	const wasCancelled = ASK_USER_QUESTION_CANCEL_KEY in answers;
	const peerReviewState = wasCancelled
		? "cancelled"
		: Object.values(answers).some((picks) =>
					picks.includes("Deliver to Claude"),
				)
			? "delivered"
			: "denied";
	const answerSummary = (
		<div className="flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground/65">
			{wasCancelled ? (
				<div className="text-[10px] uppercase tracking-wider">Cancelled</div>
			) : (
				message.questions.map((q) => {
					const picks = answers[q.question] ?? [];
					const note = submittedNotes[q.question];
					return (
						<div key={q.question} className="flex min-w-0 flex-col gap-0.5">
							<div className="flex items-center gap-2">
								<Check className="h-3 w-3 shrink-0 text-status-success/60" />
								<span className="text-[10px] uppercase tracking-wider">
									{picks.length > 0 ? picks.join(", ") : "—"}
								</span>
							</div>
							{note && (
								<div className="ml-5 whitespace-pre-wrap break-words text-[11px] italic leading-relaxed text-foreground/65">
									{note}
								</div>
							)}
						</div>
					);
				})
			)}
		</div>
	);
	return (
		<div className="flex gap-0">
			<div className="w-12 shrink-0 text-[9px] tracking-widest text-muted-foreground/50 pt-0.5 uppercase">
				ASK
			</div>
			{message.provenance?.peer ? (
				<div className="min-w-0 flex-1 border border-border bg-card">
					<AskUserQuestionProvenance
						provenance={message.provenance}
						peerReviewState={peerReviewState}
					/>
					<div className="px-4 py-3">{answerSummary}</div>
				</div>
			) : (
				answerSummary
			)}
		</div>
	);
}
