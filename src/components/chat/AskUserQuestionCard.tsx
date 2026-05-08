import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { AskUserQuestionChatMessage } from "./chatReducer";

export function AskUserQuestionCard({
	message,
	onSelect,
}: {
	message: AskUserQuestionChatMessage;
	onSelect: (id: string, selectedOption: string) => void;
}) {
	const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
	const answered = message.selectedOption !== null;

	if (answered) {
		return (
			<div className="flex gap-0">
				<div className="w-12 shrink-0 text-[9px] tracking-widest text-muted-foreground/50 pt-0.5 uppercase">
					ASK
				</div>
				<div className="flex items-center gap-2 text-xs text-muted-foreground/65">
					<Check className="w-3 h-3 text-green-600/60" />
					<span className="tracking-wider text-[10px] uppercase">
						{message.selectedOption}
					</span>
				</div>
			</div>
		);
	}

	return (
		<div className="flex gap-0">
			<div className="w-12 shrink-0 text-[9px] tracking-widest text-primary/60 pt-0.5 uppercase">
				ASK
			</div>
			<div className="flex-1 min-w-0 border border-border bg-card">
				{/* Question */}
				<div className="px-4 py-3 border-b border-border">
					<div className="text-[9px] tracking-widest text-muted-foreground/65 uppercase mb-1.5">
						QUESTION
					</div>
					<div className="text-sm text-foreground leading-relaxed">
						{message.question}
					</div>
				</div>

				{/* Options */}
				<div className="divide-y divide-border">
					{message.options.map((option, i) => {
						const isExpanded = expandedIdx === i;
						// If option is long (>120 chars), offer expand before confirming.
						// Short options are selected on single tap.
						const isLong = option.length > 120;

						return (
							<div key={`${message.id}-${option.slice(0, 40)}`}>
								<button
									type="button"
									onClick={() => {
										if (isLong && !isExpanded) {
											setExpandedIdx(i);
										} else {
											onSelect(message.id, option);
										}
									}}
									className="flex items-start gap-3 px-4 py-3 text-left hover:bg-secondary/50 active:bg-secondary/80 transition-colors w-full group"
								>
									<span className="w-5 h-5 border border-border/60 flex items-center justify-center shrink-0 mt-0.5 text-[9px] font-mono text-muted-foreground/60 group-hover:border-primary/40 group-hover:text-primary/60 transition-colors">
										{String.fromCharCode(65 + i)}
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
								{/* Expanded confirm button for long options */}
								{isExpanded && (
									<div className="px-4 pb-3 flex justify-end border-t border-border/40 pt-2">
										<button
											type="button"
											onClick={() => onSelect(message.id, option)}
											className="px-3 py-1 bg-primary text-primary-foreground text-[10px] tracking-widest font-bold hover:opacity-90 transition-opacity uppercase"
										>
											SELECT →
										</button>
									</div>
								)}
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}
