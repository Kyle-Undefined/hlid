import { useMemo, useState } from "react";
import type {
	AskUserQuestionAnswers,
	AskUserQuestionNotes,
} from "#/server/protocol";
import { ASK_USER_QUESTION_CANCEL_KEY } from "#/server/protocol";
import { AnsweredQuestionsSummary } from "./AnsweredQuestionsSummary";
import { AskUserQuestionBlock } from "./AskUserQuestionBlock";
import { AskUserQuestionProvenance } from "./AskUserQuestionProvenance";
import type { AskUserQuestionChatMessage } from "./chatReducer";

export function AskUserQuestionCard({
	message,
	onSubmit,
}: {
	message: AskUserQuestionChatMessage;
	onSubmit: (
		id: string,
		answers: AskUserQuestionAnswers,
		notes?: AskUserQuestionNotes,
	) => void;
}) {
	const { questions } = message;
	const answered = message.answers !== null;

	// Auto-submit applies when there's exactly one question and it isn't multiSelect.
	const autoSubmit =
		questions.length === 1 &&
		!questions[0].multiSelect &&
		questions[0].freeText !== true;

	// Local pending selections, keyed by question text. Each value is an array
	// so multiSelect questions can accumulate; single-select uses a 1-element array.
	const [pending, setPending] = useState<Record<string, string[]>>({});
	// Per-question note text.
	const [notes, setNotes] = useState<Record<string, string>>({});

	const allAnswered = useMemo(
		() =>
			questions.every(
				(q) => q.optional || (pending[q.question]?.length ?? 0) > 0,
			),
		[questions, pending],
	);

	function buildNotesPayload(): AskUserQuestionNotes | undefined {
		const out: AskUserQuestionNotes = {};
		for (const [q, n] of Object.entries(notes)) {
			const trimmed = n.trim();
			if (trimmed) out[q] = trimmed;
		}
		return Object.keys(out).length > 0 ? out : undefined;
	}

	if (answered) {
		return <AnsweredQuestionsSummary message={message} />;
	}

	function toggle(question: string, option: string, multiSelect: boolean) {
		setPending((prev) => {
			const current = prev[question] ?? [];
			if (multiSelect) {
				return current.includes(option)
					? { ...prev, [question]: current.filter((o) => o !== option) }
					: { ...prev, [question]: [...current, option] };
			}
			return { ...prev, [question]: [option] };
		});
	}

	function selectAndMaybeSubmit(question: string, option: string) {
		const next = { ...pending, [question]: [option] };
		setPending(next);
		if (autoSubmit) onSubmit(message.id, next, buildNotesPayload());
	}

	function submitAll() {
		onSubmit(message.id, pending, buildNotesPayload());
	}

	function cancel() {
		onSubmit(message.id, { [ASK_USER_QUESTION_CANCEL_KEY]: [] });
	}

	function setFreeText(question: string, value: string) {
		setPending((previous) => ({
			...previous,
			[question]: value.trim() ? [value] : [],
		}));
	}

	return (
		<section
			data-notification-attention="question"
			tabIndex={-1}
			aria-label="Pending question"
			className="flex scroll-mt-4 gap-0 outline-none transition-[box-shadow,background-color] focus:ring-2 focus:ring-primary/60 data-[notification-highlight=true]:bg-primary/5 data-[notification-highlight=true]:ring-2 data-[notification-highlight=true]:ring-primary/60"
		>
			<div className="w-12 shrink-0 text-[9px] tracking-widest text-primary/60 pt-0.5 uppercase">
				ASK
			</div>
			<div className="flex-1 min-w-0 border border-border bg-card divide-y divide-border">
				{message.provenance && (
					<AskUserQuestionProvenance provenance={message.provenance} />
				)}
				{questions.map((q, qIdx) => (
					<AskUserQuestionBlock
						key={q.question}
						question={q}
						qIdx={qIdx}
						totalQuestions={questions.length}
						picks={pending[q.question] ?? []}
						autoSubmit={autoSubmit}
						noteValue={notes[q.question] ?? ""}
						onToggle={(option) => toggle(q.question, option, q.multiSelect)}
						onSelectMaybeSubmit={(option) =>
							selectAndMaybeSubmit(q.question, option)
						}
						onNoteChange={(value) =>
							setNotes((prev) => ({ ...prev, [q.question]: value }))
						}
						onFreeTextChange={(value) => setFreeText(q.question, value)}
					/>
				))}

				{/* Submit bar — appears when auto-submit doesn't apply */}
				{(!autoSubmit || message.provenance) && (
					<div className="px-4 py-3 flex items-center justify-between gap-3">
						{!autoSubmit ? (
							<div className="text-[9px] tracking-widest text-muted-foreground/40 uppercase">
								{allAnswered
									? "all required answered"
									: `${Object.values(pending).filter((v) => v.length > 0).length} answered`}
							</div>
						) : (
							<div />
						)}
						<div className="flex items-center gap-2">
							{message.provenance && (
								<button
									type="button"
									onClick={cancel}
									className="px-3 py-1.5 border border-border text-muted-foreground text-[10px] tracking-widest font-bold hover:text-foreground hover:border-foreground/30 transition-colors uppercase"
								>
									Cancel
								</button>
							)}
							{!autoSubmit && (
								<button
									type="button"
									onClick={submitAll}
									disabled={!allAnswered}
									className="px-3 py-1.5 bg-primary text-primary-foreground text-[10px] tracking-widest font-bold hover:opacity-90 transition-opacity disabled:opacity-30 uppercase"
								>
									SUBMIT →
								</button>
							)}
						</div>
					</div>
				)}
			</div>
		</section>
	);
}
