import { memo, useMemo } from "react";
import { useProjectPreview } from "#/hooks/projectPreviewStore";
import type { QueuedChatMessage } from "#/hooks/wsChatQueueStore";
import type { ObsidianCaptureDestination } from "#/lib/obsidianCapture";
import { formatVaultReferencedMessage } from "#/lib/vaultReferences";
import type { ToolEventMessage } from "#/server/protocol";
import { ChatMessageRow } from "./ChatMessageRow";
import type { ChatMessage } from "./chatReducer";
import type { PlanDecision } from "./PlanCard";
import {
	groupProjectPreviewEventLifecycles,
	isProjectPreviewToolEvent,
	ProjectPreviewActivityCard,
	selectActiveProjectPreviewEvents,
} from "./ProjectPreviewToolBlock";
import { UserMsg } from "./UserMsg";
import { useMessageListView } from "./useMessageListView";

/**
 * Renders the full message thread: history, permission cards, queued messages,
 * and the scroll-anchor sentinel. Extracted from ChatPage to keep JSX readable.
 */
export const MessageList = memo(function MessageList({
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
	handleSteerQueued,
	canSteerQueued,
	bottomRef,
	hasOlderHistory = false,
	isLoadingOlderHistory = false,
	onLoadOlderHistory,
	canBranch,
	forkingMessageId,
	onBranch,
	obsidianCapture,
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
	handleSteerQueued: (id: string) => void;
	canSteerQueued: boolean;
	bottomRef: React.MutableRefObject<HTMLDivElement | null>;
	hasOlderHistory?: boolean;
	isLoadingOlderHistory?: boolean;
	onLoadOlderHistory?: () => Promise<number>;
	/** "Branch from here" precondition (Claude-only, session idle). */
	canBranch?: boolean;
	forkingMessageId?: number | null;
	onBranch?: (dbId: number) => void;
	obsidianCapture?: ObsidianCaptureDestination | null;
}) {
	const {
		olderHistoryCount,
		olderToolEventCount,
		visibleMessages,
		toolEventStartByMessageId,
		toolEventRevealMessageId,
		permissionLabels,
		queueStateById,
		orphanQueued,
		loadOlder,
		loadOlderToolEvents,
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
	const allProjectPreviewEvents = useMemo(
		() =>
			messages
				.flatMap((message) =>
					message.role === "assistant"
						? message.toolEvents.filter(isProjectPreviewToolEvent)
						: [],
				)
				.slice(-50),
		[messages],
	);
	const liveProjectPreview = useProjectPreview(
		allProjectPreviewEvents.length > 0 ? sessionId : "",
	);
	const projectPreviewEvents = selectActiveProjectPreviewEvents(
		allProjectPreviewEvents,
		liveProjectPreview,
		sessionState === "running",
	);
	const groupedProjectPreviewEventIds = useMemo(() => {
		const ids = new Set(projectPreviewEvents.map((event) => event.id));
		for (const lifecycle of groupProjectPreviewEventLifecycles(
			allProjectPreviewEvents,
		)) {
			if (lifecycle.some((event) => ids.has(event.id))) continue;
			for (const event of lifecycle.slice(1)) ids.add(event.id);
		}
		return ids;
	}, [allProjectPreviewEvents, projectPreviewEvents]);
	const historicalProjectPreviewGroups = useMemo(() => {
		const activeIds = new Set(projectPreviewEvents.map((event) => event.id));
		const groups = new Map<string, ToolEventMessage[]>();
		for (const lifecycle of groupProjectPreviewEventLifecycles(
			allProjectPreviewEvents,
		)) {
			if (lifecycle.some((event) => activeIds.has(event.id))) continue;
			const anchor = lifecycle[0];
			if (anchor) groups.set(anchor.id, lifecycle);
		}
		return groups;
	}, [allProjectPreviewEvents, projectPreviewEvents]);
	const hasActiveProjectPreview =
		liveProjectPreview?.state === "starting" ||
		liveProjectPreview?.state === "ready";

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
					toolEventStartIndex={toolEventStartByMessageId.get(m.id) ?? 0}
					olderToolEventCount={
						m.id === toolEventRevealMessageId ? olderToolEventCount : 0
					}
					onLoadOlderToolEvents={loadOlderToolEvents}
					permissionLabels={permissionLabels}
					queueState={queueStateById.get(m.id)}
					onDecide={handleDecide}
					onSubmitAnswers={handleSubmitAnswers}
					onPlanDecide={handlePlanDecide}
					onCancelQueued={handleCancelQueued}
					onPromoteQueued={handlePromoteQueued}
					onSteerQueued={handleSteerQueued}
					canSteerQueued={
						canSteerQueued &&
						chatQueue.find((queued) => queued.id === m.id)?.steerable !== false
					}
					canBranch={canBranch}
					forkingMessageId={forkingMessageId}
					onBranch={onBranch}
					obsidianCapture={obsidianCapture}
					groupedProjectPreviewEventIds={groupedProjectPreviewEventIds}
					historicalProjectPreviewGroups={historicalProjectPreviewGroups}
				/>
			))}
			{orphanQueued.map((qm) => (
				<UserMsg
					key={qm.id}
					message={{
						id: qm.id,
						role: "user" as const,
						text: formatVaultReferencedMessage(
							qm.text,
							qm.vault_references ?? [],
						),
						attachments: qm.attachments,
					}}
					queueState={queueStateById.get(qm.id)}
					onCancel={handleCancelQueued}
					onPromote={handlePromoteQueued}
					onSteer={handleSteerQueued}
					canSteer={canSteerQueued && qm.steerable !== false}
				/>
			))}
			{(projectPreviewEvents.length > 0 || hasActiveProjectPreview) && (
				<ProjectPreviewActivityCard
					key={`project-preview:${liveProjectPreview?.id ?? sessionId}`}
					events={projectPreviewEvents}
					permissionLabels={permissionLabels}
					active={sessionState === "running"}
					sessionId={sessionId}
				/>
			)}
			<div ref={bottomRef} />
		</>
	);
});
