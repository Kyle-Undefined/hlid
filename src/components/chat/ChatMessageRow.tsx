import { memo } from "react";
import { AskUserQuestionCard } from "./AskUserQuestionCard";
import { AssistantMsg } from "./AssistantMsg";
import type { ChatMessage } from "./chatReducer";
import { PermissionCard } from "./PermissionCard";
import { PlanCard, type PlanDecision } from "./PlanCard";
import { UserMsg, type UserMsgQueueState } from "./UserMsg";

/** Dispatches a single transcript entry to its role-specific renderer. */
export const ChatMessageRow = memo(function ChatMessageRow({
	message,
	toolEventStartIndex = 0,
	olderToolEventCount = 0,
	onLoadOlderToolEvents,
	permissionLabels,
	queueState,
	onDecide,
	onSubmitAnswers,
	onPlanDecide,
	onCancelQueued,
	onPromoteQueued,
	canBranch,
	forkingMessageId,
	onBranch,
}: {
	message: ChatMessage;
	toolEventStartIndex?: number;
	olderToolEventCount?: number;
	onLoadOlderToolEvents?: () => void;
	permissionLabels: Map<string, string>;
	queueState: UserMsgQueueState | undefined;
	onDecide: (
		id: string,
		approved: boolean,
		saveScope?: "session" | "local",
		denyMessage?: string,
	) => void;
	onSubmitAnswers: (
		id: string,
		answers: Record<string, string[]>,
		notes?: Record<string, string>,
	) => void;
	onPlanDecide: (id: string, decision: PlanDecision, feedback?: string) => void;
	onCancelQueued: (id: string) => void;
	onPromoteQueued: (id: string) => void;
	canBranch?: boolean;
	forkingMessageId?: number | null;
	onBranch?: (dbId: number) => void;
}) {
	if (message.role === "user") {
		return (
			<UserMsg
				message={message}
				queueState={queueState}
				onCancel={onCancelQueued}
				onPromote={onPromoteQueued}
			/>
		);
	}
	if (message.role === "permission") {
		// Approved variants are folded into the tool block.
		// Pending and denied still render standalone.
		if (permissionLabels.has(message.id)) return null;
		return <PermissionCard message={message} onDecide={onDecide} />;
	}
	if (message.role === "assistant") {
		return (
			<AssistantMsg
				message={message}
				permissionLabels={permissionLabels}
				toolEventStartIndex={toolEventStartIndex}
				olderToolEventCount={olderToolEventCount}
				onLoadOlderToolEvents={onLoadOlderToolEvents}
				canBranch={canBranch}
				branching={message.dbId != null && forkingMessageId === message.dbId}
				onBranch={onBranch}
			/>
		);
	}
	if (message.role === "ask_user_question") {
		return <AskUserQuestionCard message={message} onSubmit={onSubmitAnswers} />;
	}
	if (message.role === "plan_proposal") {
		return <PlanCard message={message} onDecide={onPlanDecide} />;
	}
	if (message.role === "local_command_output") {
		return (
			<div className="min-w-0 max-w-full overflow-hidden break-all px-4 py-2 font-mono text-xs text-muted-foreground whitespace-pre-wrap border-l-2 border-primary/20 ml-4">
				{message.content}
			</div>
		);
	}
	return null;
});
