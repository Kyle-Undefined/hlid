import { useMemo } from "react";
import type { QueuedChatMessage } from "#/hooks/wsStore";
import { approvedLabel } from "#/server/protocol";
import { AskUserQuestionCard } from "./AskUserQuestionCard";
import { AssistantMsg } from "./AssistantMsg";
import type { ChatMessage } from "./chatReducer";
import { PermissionCard } from "./PermissionCard";
import { PlanCard, type PlanDecision } from "./PlanCard";
import { UserMsg, type UserMsgQueueState } from "./UserMsg";

/**
 * Renders the full message thread: history, permission cards, queued messages,
 * and the scroll-anchor sentinel. Extracted from ChatPage to keep JSX readable.
 */
export function MessageList({
	messages,
	chatQueue,
	sessionId,
	sessionState,
	runningTurnId,
	handleDecide,
	handleSubmitAnswers,
	handlePlanDecide,
	handleCancelQueued,
	handlePromoteQueued,
	bottomRef,
}: {
	messages: ChatMessage[];
	chatQueue: QueuedChatMessage[];
	sessionId: string;
	sessionState: "idle" | "running" | "error";
	runningTurnId: string | null;
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
	handlePromoteQueued: (id: string) => void;
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

	// Slice C: build a lookup from queue.id → state. Match against the
	// server-reported runningTurnId for "currently running" — positional
	// heuristics are unreliable because chatQueue[0] can be either the
	// running turn (after a previous turn's done popped its predecessor) OR
	// a not-yet-running turn queued behind an idle-path msg.
	const queueStateById = useMemo(() => {
		const map = new Map<string, UserMsgQueueState>();
		const filtered = chatQueue.filter((qm) => qm.session_id === sessionId);
		let queuedIndex = 0;
		for (const qm of filtered) {
			if (qm.id === runningTurnId && sessionState === "running") {
				map.set(qm.id, { kind: "running" });
			} else {
				map.set(qm.id, { kind: "queued", index: queuedIndex });
				queuedIndex++;
			}
		}
		return map;
	}, [chatQueue, sessionId, sessionState, runningTurnId]);

	// Queued msgs live in wsStore._chatQueue (module state, survives SPA nav)
	// but the reducer transcript does not. On remount, history reloads from DB
	// — which has no row for a not-yet-running queued turn (server persists
	// the user row only when drainTurnQueue starts processing it) — so the
	// queued msg would vanish until processed. Re-surface any queued item not
	// already in the transcript:
	//   - skip ids already rendered (live case: synthetic user_message
	//     dispatched ADD_USER with id === queue.id)
	//   - skip the running turn (its user row is in DB with a fresh uid, so
	//     rendering the queue copy would double it)
	const orphanQueued = useMemo(() => {
		const renderedUserIds = new Set(
			messages.filter((m) => m.role === "user").map((m) => m.id),
		);
		return chatQueue.filter(
			(qm) =>
				qm.session_id === sessionId &&
				!renderedUserIds.has(qm.id) &&
				qm.id !== runningTurnId,
		);
	}, [messages, chatQueue, sessionId, runningTurnId]);

	return (
		<>
			{messages.map((m) => {
				if (m.role === "user") {
					return (
						<UserMsg
							key={m.id}
							message={m}
							queueState={queueStateById.get(m.id)}
							onCancel={handleCancelQueued}
							onPromote={handlePromoteQueued}
						/>
					);
				}
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
				if (m.role === "local_command_output") {
					return (
						<div
							key={m.id}
							className="min-w-0 max-w-full overflow-hidden break-all px-4 py-2 font-mono text-xs text-muted-foreground whitespace-pre-wrap border-l-2 border-primary/20 ml-4"
						>
							{m.content}
						</div>
					);
				}
				return null;
			})}
			{orphanQueued.map((qm) => (
				<UserMsg
					key={qm.id}
					message={{
						id: qm.id,
						role: "user" as const,
						text: qm.text,
						attachments: qm.attachments,
					}}
					queueState={queueStateById.get(qm.id)}
					onCancel={handleCancelQueued}
					onPromote={handlePromoteQueued}
				/>
			))}
			<div ref={bottomRef} />
		</>
	);
}
