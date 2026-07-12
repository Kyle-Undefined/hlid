import { Check } from "lucide-react";
import type { AskUserQuestionChatMessage } from "./chatReducer";

/** Read-only recap of an already-answered AskUserQuestion turn. */
export function AnsweredQuestionsSummary({
	message,
}: {
	message: AskUserQuestionChatMessage;
}) {
	const answers = message.answers ?? {};
	const submittedNotes = message.notes ?? {};
	return (
		<div className="flex gap-0">
			<div className="w-12 shrink-0 text-[9px] tracking-widest text-muted-foreground/50 pt-0.5 uppercase">
				ASK
			</div>
			<div className="flex flex-col gap-1.5 text-xs text-muted-foreground/65 min-w-0">
				{message.questions.map((q) => {
					const picks = answers[q.question] ?? [];
					const note = submittedNotes[q.question];
					return (
						<div key={q.question} className="flex flex-col gap-0.5 min-w-0">
							<div className="flex items-center gap-2">
								<Check className="w-3 h-3 text-green-600/60 shrink-0" />
								<span className="tracking-wider text-[10px] uppercase">
									{picks.length > 0 ? picks.join(", ") : "—"}
								</span>
							</div>
							{note && (
								<div className="ml-5 text-[11px] text-foreground/65 italic leading-relaxed whitespace-pre-wrap break-words">
									{note}
								</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}
