import { ChevronsUp, X } from "lucide-react";
import type { UserMessage } from "#/components/chat/chatReducer";
import { PrivacyMask } from "#/components/PrivacyMask";
import { useCopyToClipboard } from "#/hooks/useCopyToClipboard";
import { AttachmentChip } from "./AttachmentChip";
import { CopyButton } from "./CopyButton";

export type UserMsgQueueState =
	| { kind: "running" }
	| { kind: "queued"; index: number };

export function UserMsg({
	message,
	queueState,
	onCancel,
	onPromote,
}: {
	message: UserMessage;
	/**
	 * Slice C: when present, this user message is still pending or running on
	 * the server (correlated via msg.id ↔ chatQueue.id). `queued` items show
	 * a Q-chip with cancel + promote-to-now buttons; `running` shows RUN
	 * with no controls (use abort instead).
	 */
	queueState?: UserMsgQueueState;
	onCancel?: (id: string) => void;
	/**
	 * Slice C: promote this queued msg to run immediately. Server interrupts
	 * the current turn and runs this one next. Available only on queued items
	 * (not running) — buttons are hidden when queueState.kind === 'running'.
	 */
	onPromote?: (id: string) => void;
}) {
	const { copy, copied } = useCopyToClipboard();
	const isQueued = queueState?.kind === "queued";
	const isRunning = queueState?.kind === "running";
	const label = isRunning
		? "RUN"
		: isQueued
			? `Q${queueState.index + 1}`
			: "ME";
	return (
		<div className="group flex items-start justify-end gap-3 py-3 border-b border-border/40">
			<div
				className={`flex flex-col items-end gap-1.5 min-w-0 max-w-[78%] ${
					isQueued || isRunning ? "opacity-60" : ""
				}`}
			>
				{message.attachments && message.attachments.length > 0 && (
					<PrivacyMask className="flex flex-wrap gap-1.5 justify-end">
						{message.attachments.map((a) => (
							<AttachmentChip key={a.id} a={a} />
						))}
					</PrivacyMask>
				)}
				{message.text && (
					<PrivacyMask className="w-full">
						<div
							className="text-sm text-foreground whitespace-pre-wrap text-right leading-relaxed w-full"
							style={{ overflowWrap: "anywhere" }}
						>
							{message.text}
						</div>
					</PrivacyMask>
				)}
			</div>
			<div className="flex flex-col items-end gap-0.5 shrink-0">
				{message.text && !isQueued && !isRunning && (
					<CopyButton
						onCopy={() => copy(message.text)}
						copied={copied}
						className="opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity"
					/>
				)}
				<div
					className={`text-[9px] tracking-widest pt-0.5 w-11 text-right ${
						isQueued || isRunning
							? "text-muted-foreground/60"
							: "text-primary/60"
					}`}
				>
					{label}
				</div>
				{isQueued && (
					<div className="flex items-center gap-0.5">
						{onPromote && (
							<button
								type="button"
								onClick={() => onPromote(message.id)}
								className="text-muted-foreground/40 hover:text-primary transition-colors p-1"
								aria-label={`Send queued message ${queueState.index + 1} now`}
								title="Send now (interrupts current)"
							>
								<ChevronsUp className="w-3.5 h-3.5" />
							</button>
						)}
						{onCancel && (
							<button
								type="button"
								onClick={() => onCancel(message.id)}
								className="text-muted-foreground/40 hover:text-destructive/70 transition-colors p-1"
								aria-label={`Cancel queued message ${queueState.index + 1}`}
							>
								<X className="w-3.5 h-3.5" />
							</button>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
