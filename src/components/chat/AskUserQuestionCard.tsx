import { useMemo, useState } from "react";
import type {
	AskUserQuestionAnswers,
	AskUserQuestionNotes,
} from "#/server/protocol";
import { AnsweredQuestionsSummary } from "./AnsweredQuestionsSummary";
import { AskUserQuestionBlock } from "./AskUserQuestionBlock";
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
	const autoSubmit = questions.length === 1 && !questions[0].multiSelect;

	// Local pending selections, keyed by question text. Each value is an array
	// so multiSelect questions can accumulate; single-select uses a 1-element array.
	const [pending, setPending] = useState<Record<string, string[]>>({});
	// Per-question note text.
	const [notes, setNotes] = useState<Record<string, string>>({});

	const allAnswered = useMemo(
		() => questions.every((q) => (pending[q.question]?.length ?? 0) > 0),
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

	return (
		<div className="flex gap-0">
			<div className="w-12 shrink-0 text-[9px] tracking-widest text-primary/60 pt-0.5 uppercase">
				ASK
			</div>
			<div className="flex-1 min-w-0 border border-border bg-card divide-y divide-border">
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
					/>
				))}

				{/* Submit bar — appears when auto-submit doesn't apply */}
				{!autoSubmit && (
					<div className="px-4 py-3 flex items-center justify-between gap-3">
						<div className="text-[9px] tracking-widest text-muted-foreground/40 uppercase">
							{allAnswered
								? "all answered"
								: `${Object.values(pending).filter((v) => v.length > 0).length} / ${questions.length} answered`}
						</div>
						<button
							type="button"
							onClick={submitAll}
							disabled={!allAnswered}
							className="px-3 py-1.5 bg-primary text-primary-foreground text-[10px] tracking-widest font-bold hover:opacity-90 transition-opacity disabled:opacity-30 uppercase"
						>
							SUBMIT →
						</button>
					</div>
				)}
			</div>
		</div>
	);
}
