import { memo, useMemo } from "react";
import { useProjectPreview } from "#/hooks/projectPreviewStore";
import type { HlidContextReceiptTarget } from "#/lib/hlidContext";
import { formatVaultReferencedMessage } from "#/lib/vaultReferences";
import type { SubagentSnapshot } from "#/server/agentProvider";
import type { ToolEventMessage } from "#/server/protocol";
import {
	ChatMessageRow,
	type ObsidianCaptureDestination,
	type PlanDecision,
} from "./ChatMessageRow";
import type { ChatMessage, PermissionMessage } from "./chatReducer";
import { HlidDelegationActivityPanel } from "./HlidDelegationActivityPanel";
import {
	groupProjectPreviewEventLifecycles,
	isProjectPreviewToolEvent,
	ProjectPreviewActivityCard,
	selectActiveProjectPreviewEvents,
} from "./ProjectPreviewToolBlock";
import { UserMsg } from "./UserMsg";
import {
	type QueuedChatMessage,
	useMessageListView,
} from "./useMessageListView";

/**
 * Renders the full message thread: history, permission cards, queued messages,
 * and the scroll-anchor sentinel. Extracted from ChatPage to keep JSX readable.
 */
export const MessageList = memo(function MessageList({
	messages,
	chatQueue,
	sessionId,
	providerId,
	sessionState,
	runningTurnId,
	handleDecide,
	handleSubmitAnswers,
	handlePlanDecide,
	handleCancelQueued,
	handlePromoteQueued,
	handleSteerQueued,
	onViewContext,
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
	providerId?: string;
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
	onViewContext?: (target: HlidContextReceiptTarget) => void;
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
		acceptedSteersByAssistantId,
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
	const permissionPlacement = useMemo(() => {
		const subagents = new Map<string, SubagentSnapshot>();
		const workflowKeys = new Set<string>();
		const requesterKey = (provider: string, agentId: string) =>
			`${provider}:${agentId}`;
		for (const message of visibleMessages) {
			if (message.role !== "assistant") continue;
			for (const event of message.toolEvents) {
				const subagent = event.subagent;
				if (!subagent) continue;
				const key = requesterKey(subagent.provider, subagent.agentId);
				subagents.set(key, subagent);
				if (subagent.kind === "workflow") workflowKeys.add(key);
			}
		}
		const byWorkflow = new Map<string, PermissionMessage[]>();
		const embeddedIds = new Set<string>();
		for (const message of visibleMessages) {
			if (
				message.role !== "permission" ||
				message.decision !== "pending" ||
				!message.requester
			) {
				continue;
			}
			const caller = subagents.get(
				requesterKey(message.requester.providerId, message.requester.agentId),
			);
			if (!caller?.parentActivityId) continue;
			const workflowKey = requesterKey(
				caller.provider,
				caller.parentActivityId,
			);
			if (!workflowKeys.has(workflowKey)) continue;
			const approvals = byWorkflow.get(workflowKey) ?? [];
			approvals.push(message);
			byWorkflow.set(workflowKey, approvals);
			embeddedIds.add(message.id);
		}
		return { subagents, byWorkflow, embeddedIds };
	}, [visibleMessages]);

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
					acceptedSteers={
						m.role === "assistant"
							? acceptedSteersByAssistantId.get(m.id)
							: undefined
					}
					sessionId={sessionId}
					providerId={providerId}
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
					onViewContext={onViewContext}
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
					requesterSubagents={permissionPlacement.subagents}
					pendingPermissionsByWorkflow={permissionPlacement.byWorkflow}
					embeddedPermissionIds={permissionPlacement.embeddedIds}
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
					sessionId={sessionId}
				/>
			)}
			<HlidDelegationActivityPanel sessionId={sessionId} />
			<div ref={bottomRef} />
		</>
	);
});
