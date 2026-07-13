import { ChevronDown, ChevronRight, MessageSquarePlus } from "lucide-react";
import { useState } from "react";
import type { AskQuestion } from "#/server/protocol";

/** One question's options + note field within the pending AskUserQuestion card. */
export function AskUserQuestionBlock({
	question,
	qIdx,
	totalQuestions,
	picks,
	autoSubmit,
	noteValue,
	onToggle,
	onSelectMaybeSubmit,
	onNoteChange,
	onFreeTextChange,
}: {
	question: AskQuestion;
	qIdx: number;
	totalQuestions: number;
	picks: string[];
	autoSubmit: boolean;
	noteValue: string;
	onToggle: (option: string) => void;
	onSelectMaybeSubmit: (option: string) => void;
	onNoteChange: (value: string) => void;
	onFreeTextChange: (value: string) => void;
}) {
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const [notesOpen, setNotesOpen] = useState(false);

	return (
		<div>
			{/* Question header */}
			<div className="px-4 py-3 border-b border-border">
				<div className="text-[9px] tracking-widest text-muted-foreground/65 uppercase mb-1.5">
					QUESTION{totalQuestions > 1 ? ` ${qIdx + 1}` : ""}
					{question.multiSelect && (
						<span className="ml-2 text-primary/60">· MULTI-SELECT</span>
					)}
				</div>
				<div className="text-sm text-foreground leading-relaxed">
					{question.question}
				</div>
			</div>

			{/* Options or direct form input */}
			{question.freeText ? (
				<div className="px-4 py-3">
					<input
						type={question.inputType ?? "text"}
						value={picks[0] ?? ""}
						onChange={(event) => onFreeTextChange(event.target.value)}
						placeholder={question.placeholder ?? "Enter an answer…"}
						className="w-full bg-background border border-border px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50 placeholder:text-muted-foreground/40"
					/>
				</div>
			) : (
				<div className="divide-y divide-border">
					{question.options.map((option, i) => {
						const isExpanded = expanded[option] === true;
						const isLong = option.length > 120;
						const isPicked = picks.includes(option);

						return (
							<div key={option}>
								<button
									type="button"
									onClick={() => {
										if (isLong && !isExpanded) {
											setExpanded((p) => ({ ...p, [option]: true }));
											return;
										}
										if (autoSubmit) {
											onSelectMaybeSubmit(option);
										} else {
											onToggle(option);
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
			)}

			{/* Notes — toggleable per-question free-text feedback */}
			<div className="px-4 py-2 border-t border-border/60">
				{notesOpen ? (
					<div className="flex flex-col gap-1.5">
						<label
							htmlFor={`notes-${qIdx}`}
							className="text-[9px] tracking-widest text-muted-foreground/60 uppercase"
						>
							Notes
						</label>
						<textarea
							id={`notes-${qIdx}`}
							value={noteValue}
							onChange={(e) => onNoteChange(e.target.value)}
							placeholder="add context for the agent…"
							rows={2}
							className="w-full resize-none bg-background border border-border px-2 py-1.5 text-xs text-foreground focus:outline-none focus:border-primary/50 placeholder:text-muted-foreground/40"
						/>
					</div>
				) : (
					<button
						type="button"
						onClick={() => setNotesOpen(true)}
						className="flex items-center gap-1.5 text-[9px] tracking-widest text-muted-foreground/50 hover:text-primary/70 transition-colors uppercase"
					>
						<MessageSquarePlus className="w-3 h-3" />
						Add note
					</button>
				)}
			</div>
		</div>
	);
}
