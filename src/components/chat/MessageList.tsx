import type { QueuedChatMessage } from "#/hooks/wsChatQueueStore";
import { ChatMessageRow } from "./ChatMessageRow";
import type { ChatMessage } from "./chatReducer";
import type { PlanDecision } from "./PlanCard";
import { UserMsg } from "./UserMsg";
import { useMessageListView } from "./useMessageListView";

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
	hasOlderHistory = false,
	isLoadingOlderHistory = false,
	onLoadOlderHistory,
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
	hasOlderHistory?: boolean;
	isLoadingOlderHistory?: boolean;
	onLoadOlderHistory?: () => Promise<number>;
}) {
	const {
		olderHistoryCount,
		visibleMessages,
		permissionLabels,
		queueStateById,
		orphanQueued,
		loadOlder,
	} = useMessageListView({
		messages,
		chatQueue,
		sessionId,
		sessionState,
		runningTurnId,
		hasOlderHistory,
		isLoadingOlderHistory,
		onLoadOlderHistory,
	});

	return (
		<>
			{olderHistoryCount > 0 && (
				<div className="flex justify-center px-4 py-3">
					<button
						type="button"
						onClick={loadOlder}
						disabled={isLoadingOlderHistory}
						className="border border-border px-3 py-1.5 text-[10px] tracking-widest text-muted-foreground uppercase transition-colors hover:bg-accent hover:text-foreground"
					>
						{isLoadingOlderHistory
							? "Loading older"
							: `Load ${olderHistoryCount} older`}
					</button>
				</div>
			)}
			{visibleMessages.map((m) => (
				<ChatMessageRow
					key={m.id}
					message={m}
					permissionLabels={permissionLabels}
					queueState={queueStateById.get(m.id)}
					onDecide={handleDecide}
					onSubmitAnswers={handleSubmitAnswers}
					onPlanDecide={handlePlanDecide}
					onCancelQueued={handleCancelQueued}
					onPromoteQueued={handlePromoteQueued}
				/>
			))}
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
