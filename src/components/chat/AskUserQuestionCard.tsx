import {
	Check,
	ChevronDown,
	ChevronRight,
	MessageSquarePlus,
} from "lucide-react";
import { useMemo, useState } from "react";
import type {
	AskUserQuestionAnswers,
	AskUserQuestionNotes,
} from "#/server/protocol";
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
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	// Per-question note text and toggle state.
	const [notes, setNotes] = useState<Record<string, string>>({});
	const [notesOpen, setNotesOpen] = useState<Record<string, boolean>>({});

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
		const answers = message.answers ?? {};
		const submittedNotes = message.notes ?? {};
		return (
			<div className="flex gap-0">
				<div className="w-12 shrink-0 text-[9px] tracking-widest text-muted-foreground/50 pt-0.5 uppercase">
					ASK
				</div>
				<div className="flex flex-col gap-1.5 text-xs text-muted-foreground/65 min-w-0">
					{questions.map((q) => {
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
				{questions.map((q, qIdx) => {
					const picks = pending[q.question] ?? [];
					return (
						<div key={q.question}>
							{/* Question header */}
							<div className="px-4 py-3 border-b border-border">
								<div className="text-[9px] tracking-widest text-muted-foreground/65 uppercase mb-1.5">
									QUESTION{questions.length > 1 ? ` ${qIdx + 1}` : ""}
									{q.multiSelect && (
										<span className="ml-2 text-primary/60">· MULTI-SELECT</span>
									)}
								</div>
								<div className="text-sm text-foreground leading-relaxed">
									{q.question}
								</div>
							</div>

							{/* Options */}
							<div className="divide-y divide-border">
								{q.options.map((option, i) => {
									const optKey = `${q.question}::${option}`;
									const isExpanded = expanded[optKey] === true;
									const isLong = option.length > 120;
									const isPicked = picks.includes(option);

									return (
										<div key={optKey}>
											<button
												type="button"
												onClick={() => {
													if (isLong && !isExpanded) {
														setExpanded((p) => ({ ...p, [optKey]: true }));
														return;
													}
													if (autoSubmit) {
														selectAndMaybeSubmit(q.question, option);
													} else {
														toggle(q.question, option, q.multiSelect);
													}
												}}
												aria-pressed={isPicked}
												className={`flex items-start gap-3 px-4 py-3 text-left transition-colors w-full group ${
													isPicked
														? "bg-primary/5"
														: "hover:bg-secondary/50 active:bg-secondary/80"
												}`}
											>
												<span
													className={`w-5 h-5 border flex items-center justify-center shrink-0 mt-0.5 text-[9px] font-mono transition-colors ${
														isPicked
															? "border-primary bg-primary text-primary-foreground"
															: "border-border/60 text-muted-foreground/60 group-hover:border-primary/40 group-hover:text-primary/60"
													}`}
												>
													{isPicked ? "✓" : String.fromCharCode(65 + i)}
												</span>
												<span
													className={`flex-1 text-sm text-foreground/85 leading-relaxed whitespace-pre-wrap break-words ${isLong && !isExpanded ? "line-clamp-3" : ""}`}
												>
													{option}
												</span>
												{isLong && (
													<span className="shrink-0 mt-0.5 text-muted-foreground/40">
														{isExpanded ? (
															<ChevronDown className="w-3.5 h-3.5" />
														) : (
															<ChevronRight className="w-3.5 h-3.5" />
														)}
													</span>
												)}
											</button>
										</div>
									);
								})}
							</div>

							{/* Notes — toggleable per-question free-text feedback */}
							<div className="px-4 py-2 border-t border-border/60">
								{notesOpen[q.question] ? (
									<div className="flex flex-col gap-1.5">
										<label
											htmlFor={`notes-${qIdx}`}
											className="text-[9px] tracking-widest text-muted-foreground/60 uppercase"
										>
											Notes
										</label>
										<textarea
											id={`notes-${qIdx}`}
											value={notes[q.question] ?? ""}
											onChange={(e) =>
												setNotes((prev) => ({
													...prev,
													[q.question]: e.target.value,
												}))
											}
											placeholder="add context for the agent…"
											rows={2}
											className="w-full resize-none bg-background border border-border px-2 py-1.5 text-xs text-foreground focus:outline-none focus:border-primary/50 placeholder:text-muted-foreground/40"
										/>
									</div>
								) : (
									<button
										type="button"
										onClick={() =>
											setNotesOpen((prev) => ({
												...prev,
												[q.question]: true,
											}))
										}
										className="flex items-center gap-1.5 text-[9px] tracking-widest text-muted-foreground/50 hover:text-primary/70 transition-colors uppercase"
									>
										<MessageSquarePlus className="w-3 h-3" />
										Add note
									</button>
								)}
							</div>
						</div>
					);
				})}

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
