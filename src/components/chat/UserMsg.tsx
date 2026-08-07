import { Braces, ChevronsUp, History, Route, X } from "lucide-react";
import type { UserMessage } from "#/components/chat/chatReducer";
import { PrivacyMask } from "#/components/PrivacyMask";
import { useCopyToClipboard } from "#/hooks/useCopyToClipboard";
import type { HlidContextReceiptTarget } from "#/lib/hlidContext";
import { AttachmentChip } from "./AttachmentChip";
import { CopyButton } from "./CopyButton";

export type UserMsgQueueState =
	| { kind: "running" }
	| { kind: "steering" }
	| { kind: "promoting" }
	| { kind: "queued"; index: number };

export function UserMsg({
	message,
	queueState,
	onCancel,
	onPromote,
	onSteer,
	onViewContext,
	onPreviewFileRewind,
	canSteer = false,
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
	onSteer?: (id: string) => void;
	onViewContext?: (target: HlidContextReceiptTarget) => void;
	onPreviewFileRewind?: (turnId: string) => void;
	canSteer?: boolean;
}) {
	const { copy, copied } = useCopyToClipboard();
	const isQueued = queueState?.kind === "queued";
	const isRunning = queueState?.kind === "running";
	const isSteering = queueState?.kind === "steering";
	const isPromoting = queueState?.kind === "promoting";
	const isLivePartial =
		message.source === "codex_realtime" && message.streaming === true;
	const contextTarget = message.hasContextReceipt
		? {
				...(message.transcriptSeq !== undefined
					? { seq: message.transcriptSeq }
					: {}),
				turnId: message.id,
			}
		: null;
	const label = isRunning
		? "ME"
		: isSteering
			? "STEER"
			: isPromoting
				? "NEXT"
				: isQueued
					? `Q${queueState.index + 1}`
					: isLivePartial
						? "LIVE"
						: "ME";
	return (
		<div className="group flex items-start justify-end gap-3 py-3 border-b border-border/40">
			<div
				className={`flex flex-col items-end gap-1.5 min-w-0 max-w-[78%] ${
					isQueued || isRunning || isSteering || isPromoting ? "opacity-60" : ""
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
							className="text-sm whitespace-pre-wrap text-right leading-relaxed w-full text-[var(--user-msg)]"
							style={{ overflowWrap: "anywhere" }}
						>
							{message.text}
							{isLivePartial && (
								<span className="inline-block w-[7px] h-[1em] ml-1 align-middle bg-primary/50 cursor-blink" />
							)}
						</div>
					</PrivacyMask>
				)}
			</div>
			<div className="flex flex-col items-end gap-0.5 shrink-0">
				<div
					className={`text-[9px] tracking-widest pt-0.5 w-11 text-right ${
						isQueued || isRunning || isSteering || isPromoting
							? "text-muted-foreground/60"
							: "text-primary/60"
					}`}
				>
					{label}
				</div>
				{!isQueued &&
					!isRunning &&
					!isSteering &&
					!isPromoting &&
					!isLivePartial &&
					(message.text ||
						(contextTarget && onViewContext) ||
						(message.hasFileCheckpoint && onPreviewFileRewind)) && (
						<div className="flex items-center gap-0.5">
							{message.hasFileCheckpoint && onPreviewFileRewind && (
								<button
									type="button"
									onClick={() => onPreviewFileRewind(message.id)}
									className="p-1 text-muted-foreground/40 transition-colors hover:text-primary"
									aria-label="Preview file rewind to this turn"
									title="Preview file rewind"
								>
									<History className="h-3.5 w-3.5" />
								</button>
							)}
							{contextTarget && onViewContext && (
								<button
									type="button"
									onClick={() => onViewContext(contextTarget)}
									className="p-1 text-muted-foreground/40 transition-colors hover:text-primary"
									aria-label="View context sent with this turn"
									title="View turn context"
								>
									<Braces className="h-3.5 w-3.5" />
								</button>
							)}
							{message.text && (
								<CopyButton onCopy={() => copy(message.text)} copied={copied} />
							)}
						</div>
					)}
				{isQueued && (
					<div className="flex items-center gap-0.5">
						{canSteer && onSteer && (
							<button
								type="button"
								onClick={() => onSteer(message.id)}
								className="text-muted-foreground/40 hover:text-primary transition-colors p-1"
								aria-label={`Steer current run with queued message ${queueState.index + 1}`}
								title="Steer current run"
							>
								<Route className="w-3.5 h-3.5" />
							</button>
						)}
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
