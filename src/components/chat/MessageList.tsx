import { useMemo } from "react";
import type { QueuedChatMessage } from "#/hooks/wsStore";
import { approvedLabel } from "#/server/protocol";
import { AskUserQuestionCard } from "./AskUserQuestionCard";
import { AssistantMsg } from "./AssistantMsg";
import type { ChatMessage } from "./chatReducer";
import { PermissionCard } from "./PermissionCard";
import { PlanCard, type PlanDecision } from "./PlanCard";
import { QueuedMsg } from "./QueuedMsg";
import { UserMsg } from "./UserMsg";

/**
 * Renders the full message thread: history, permission cards, queued messages,
 * and the scroll-anchor sentinel. Extracted from ChatPage to keep JSX readable.
 */
export function MessageList({
	messages,
	chatQueue,
	sessionId,
	handleDecide,
	handleSubmitAnswers,
	handlePlanDecide,
	handleCancelQueued,
	bottomRef,
}: {
	messages: ChatMessage[];
	chatQueue: QueuedChatMessage[];
	sessionId: string;
	handleDecide: (
		id: string,
		approved: boolean,
		saveScope?: "session" | "local",
		denyMessage?: string,
	) => void;
	handleSubmitAnswers: (
		id: string,
		answers: Record<string, string[]>,
		notes?: Record<string, string>,
	) => void;
	handlePlanDecide: (
		id: string,
		decision: PlanDecision,
		feedback?: string,
	) => void;
	handleCancelQueued: (id: string) => void;
	bottomRef: React.MutableRefObject<HTMLDivElement | null>;
}) {
	// Approved permissions render as a chip under the matching tool block
	// (matched by toolUseID === ToolEvent.id) instead of a separate row, so a
	// long run of approvals doesn't stack up above each tool call.
	const permissionLabels = useMemo(() => {
		const map = new Map<string, string>();
		for (const m of messages) {
			if (m.role !== "permission") continue;
			const label = approvedLabel(m.decision);
			if (label) map.set(m.id, label);
		}
		return map;
	}, [messages]);

	return (
		<>
			{messages.map((m) => {
				if (m.role === "user") return <UserMsg key={m.id} message={m} />;
				if (m.role === "permission") {
					// Approved variants are folded into the tool block.
					// Pending and denied still render standalone.
					if (permissionLabels.has(m.id)) return null;
					return (
						<PermissionCard key={m.id} message={m} onDecide={handleDecide} />
					);
				}
				if (m.role === "assistant") {
					return (
						<AssistantMsg
							key={m.id}
							message={m}
							permissionLabels={permissionLabels}
						/>
					);
				}
				if (m.role === "ask_user_question") {
					return (
						<AskUserQuestionCard
							key={m.id}
							message={m}
							onSubmit={handleSubmitAnswers}
						/>
					);
				}
				if (m.role === "plan_proposal") {
					return (
						<PlanCard key={m.id} message={m} onDecide={handlePlanDecide} />
					);
				}
				return null;
			})}
			{chatQueue
				.filter((qm) => qm.session_id === sessionId)
				.map((qm, i) => (
					<QueuedMsg
						key={qm.id}
						message={qm}
						index={i}
						onCancel={handleCancelQueued}
					/>
				))}
			<div ref={bottomRef} />
		</>
	);
}
