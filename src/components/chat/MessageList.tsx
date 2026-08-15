import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type {
	AssistantMessage,
	ChatMessage,
	LoadEarlierToolEvents,
	PermissionMessage,
} from "./chatReducer";
import { HlidDelegationActivityPanel } from "./HlidDelegationActivityPanel";
import { isHlidVisualizationToolEvent } from "./HlidVisualizationToolBlock";
import {
	groupProjectPreviewEventLifecycles,
	isProjectPreviewToolEvent,
	ProjectPreviewActivityCard,
	selectActiveProjectPreviewEvents,
} from "./ProjectPreviewToolBlock";
import { ProviderBackgroundActivityPanel } from "./ProviderBackgroundActivityPanel";
import { isActivityInspectorToolEvent, ToolInspector } from "./ToolBlock";
import { UserMsg } from "./UserMsg";
import {
	type QueuedChatMessage,
	useMessageListView,
} from "./useMessageListView";

function latestHlidVisualizationEvent(
	messages: ChatMessage[],
	providerId?: string,
): ToolEventMessage | null {
	if (providerId !== "codex") return null;
	for (
		let messageIndex = messages.length - 1;
		messageIndex >= 0;
		messageIndex--
	) {
		const message = messages[messageIndex];
		if (message.role !== "assistant") continue;
		for (
			let eventIndex = message.toolEvents.length - 1;
			eventIndex >= 0;
			eventIndex--
		) {
			const event = message.toolEvents[eventIndex];
			if (isHlidVisualizationToolEvent(event)) return event;
		}
	}
	return null;
}

type ActivityTrayState = {
	sessionId: string;
	collapsedAutomaticId: string | null;
	manualOpenId: string | null;
};

type SelectedTool = {
	responseId: string;
	eventId: string;
	trigger: HTMLElement;
};

function activityInspectorEventsForResponse(
	message: AssistantMessage,
	providerId: string | undefined,
	groupedProjectPreviewEventIds: ReadonlySet<string>,
	historicalProjectPreviewGroups: ReadonlyMap<string, ToolEventMessage[]>,
): ToolEventMessage[] {
	const historicalPreviewEventIds = new Set<string>();
	for (const events of historicalProjectPreviewGroups.values()) {
		for (const event of events) historicalPreviewEventIds.add(event.id);
	}
	return message.toolEvents.filter((event) => {
		const compactPinnedPreview =
			groupedProjectPreviewEventIds.has(event.id) &&
			isProjectPreviewToolEvent(event) &&
			!historicalPreviewEventIds.has(event.id);
		return isActivityInspectorToolEvent(
			event,
			providerId,
			compactPinnedPreview,
		);
	});
}

function mountedToolTrigger(
	responseId: string,
	eventId: string,
): HTMLElement | null {
	for (const tray of document.querySelectorAll<HTMLElement>(
		"[data-activity-tray]",
	)) {
		if (tray.dataset.activityTray !== responseId) continue;
		for (const trigger of tray.querySelectorAll<HTMLElement>(
			"[data-tool-event-id]",
		)) {
			if (trigger.dataset.toolEventId === eventId) return trigger;
		}
	}
	return null;
}

const EMPTY_PROJECT_PREVIEW_EVENT_IDS: ReadonlySet<string> = new Set();
const EMPTY_PROJECT_PREVIEW_GROUPS: ReadonlyMap<string, ToolEventMessage[]> =
	new Map();
const EMPTY_PERMISSION_PLACEMENT = {
	subagents: new Map<string, SubagentSnapshot>(),
	byWorkflow: new Map<string, PermissionMessage[]>(),
	embeddedIds: new Set<string>(),
};

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
	onPreviewFileRewind,
	onBackgroundActivity,
	canSteerQueued,
	bottomRef,
	hasOlderHistory = false,
	isLoadingOlderHistory = false,
	onLoadOlderHistory,
	restoreMessageId,
	onLoadEarlierToolEvents,
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
	onPreviewFileRewind?: (turnId: string) => void;
	onBackgroundActivity?: () => void;
	canSteerQueued: boolean;
	bottomRef: React.MutableRefObject<HTMLDivElement | null>;
	hasOlderHistory?: boolean;
	isLoadingOlderHistory?: boolean;
	onLoadOlderHistory?: () => Promise<number>;
	restoreMessageId?: string | null;
	onLoadEarlierToolEvents?: LoadEarlierToolEvents;
	/** "Branch from here" precondition (Claude-only, session idle). */
	canBranch?: boolean;
	forkingMessageId?: number | null;
	onBranch?: (dbId: number) => void;
	obsidianCapture?: ObsidianCaptureDestination | null;
}) {
	const {
		olderHistoryCount,
		visibleMessages,
		acceptedSteersByAssistantId,
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
		restoreMessageId,
	});
	const latestActivityResponseId = useMemo(() => {
		for (let index = visibleMessages.length - 1; index >= 0; index--) {
			const message = visibleMessages[index];
			if (message.role === "assistant" && message.toolEvents.length > 0) {
				return message.id;
			}
		}
		return null;
	}, [visibleMessages]);
	const [activityTrayState, setActivityTrayState] = useState<ActivityTrayState>(
		() => ({
			sessionId,
			collapsedAutomaticId: null,
			manualOpenId: null,
		}),
	);
	const [selectedTool, setSelectedTool] = useState<SelectedTool | null>(null);
	const previousLatestActivityRef = useRef<{
		sessionId: string;
		responseId: string | null;
	}>({ sessionId, responseId: latestActivityResponseId });
	const scopedActivityTrayState =
		activityTrayState.sessionId === sessionId
			? activityTrayState
			: {
					sessionId,
					collapsedAutomaticId: null,
					manualOpenId: null,
				};
	const isActivityOpen = useCallback(
		(responseId: string) =>
			(responseId === latestActivityResponseId &&
				scopedActivityTrayState.collapsedAutomaticId !== responseId) ||
			(responseId !== latestActivityResponseId &&
				scopedActivityTrayState.manualOpenId === responseId),
		[latestActivityResponseId, scopedActivityTrayState],
	);
	const closeInspector = useCallback(() => {
		setSelectedTool((current) => {
			const trigger = current?.trigger;
			if (trigger) {
				requestAnimationFrame(() => {
					if (trigger.isConnected) trigger.focus();
				});
			}
			return null;
		});
	}, []);
	useEffect(() => {
		const previous = previousLatestActivityRef.current;
		if (previous.sessionId !== sessionId) {
			previousLatestActivityRef.current = {
				sessionId,
				responseId: latestActivityResponseId,
			};
			setActivityTrayState({
				sessionId,
				collapsedAutomaticId: null,
				manualOpenId: null,
			});
			setSelectedTool(null);
			return;
		}
		if (previous.responseId === latestActivityResponseId) return;
		previousLatestActivityRef.current = {
			sessionId,
			responseId: latestActivityResponseId,
		};
		setActivityTrayState({
			sessionId,
			collapsedAutomaticId: null,
			manualOpenId: null,
		});
		setSelectedTool(null);
	}, [latestActivityResponseId, sessionId]);
	const handleToggleActivity = useCallback(
		(responseId: string) => {
			closeInspector();
			setActivityTrayState((current) => {
				const scoped =
					current.sessionId === sessionId
						? current
						: {
								sessionId,
								collapsedAutomaticId: null,
								manualOpenId: null,
							};
				if (responseId === latestActivityResponseId) {
					return {
						...scoped,
						collapsedAutomaticId:
							scoped.collapsedAutomaticId === responseId ? null : responseId,
					};
				}
				return {
					...scoped,
					manualOpenId: scoped.manualOpenId === responseId ? null : responseId,
				};
			});
		},
		[closeInspector, latestActivityResponseId, sessionId],
	);
	const handleSelectTool = useCallback(
		(responseId: string, event: ToolEventMessage, trigger: HTMLElement) => {
			setSelectedTool({ responseId, eventId: event.id, trigger });
		},
		[],
	);
	const latestVisualizationEvent = useMemo(
		() => latestHlidVisualizationEvent(messages, providerId),
		[messages, providerId],
	);
	const [expandedVisualizationEventId, setExpandedVisualizationEventId] =
		useState<string | null>(null);
	const visualizationSessionIdRef = useRef<string | null>(null);
	const latestVisualizationEventIdRef = useRef<string | null>(null);
	useEffect(() => {
		const latestEventId = latestVisualizationEvent?.id ?? null;
		if (visualizationSessionIdRef.current !== sessionId) {
			visualizationSessionIdRef.current = sessionId;
			latestVisualizationEventIdRef.current = latestEventId;
			setExpandedVisualizationEventId(
				sessionState === "running" &&
					latestVisualizationEvent?.result === undefined
					? latestEventId
					: null,
			);
			return;
		}
		if (latestVisualizationEventIdRef.current === latestEventId) return;
		latestVisualizationEventIdRef.current = latestEventId;
		if (latestVisualizationEvent && sessionState === "running") {
			setExpandedVisualizationEventId(latestVisualizationEvent.id);
		} else if (!latestVisualizationEvent) {
			setExpandedVisualizationEventId(null);
		}
	}, [latestVisualizationEvent, sessionId, sessionState]);
	const handleToggleVisualization = useCallback((eventId: string) => {
		setExpandedVisualizationEventId((current) =>
			current === eventId ? null : eventId,
		);
	}, []);
	const handleVisualizationInactive = useCallback((eventId: string) => {
		setExpandedVisualizationEventId((current) =>
			current === eventId ? null : current,
		);
	}, []);
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
	const projectPreviewEvents = useMemo(
		() =>
			selectActiveProjectPreviewEvents(
				allProjectPreviewEvents,
				liveProjectPreview,
			),
		[allProjectPreviewEvents, liveProjectPreview],
	);
	const groupedProjectPreviewEventIds = useMemo(() => {
		if (allProjectPreviewEvents.length === 0) {
			return EMPTY_PROJECT_PREVIEW_EVENT_IDS;
		}
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
		if (allProjectPreviewEvents.length === 0) {
			return EMPTY_PROJECT_PREVIEW_GROUPS;
		}
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
	const selectedToolContext = useMemo(() => {
		if (!selectedTool) return null;
		const owner = visibleMessages.find(
			(message) =>
				message.role === "assistant" && message.id === selectedTool.responseId,
		);
		if (owner?.role !== "assistant") return null;
		const events = activityInspectorEventsForResponse(
			owner,
			providerId,
			groupedProjectPreviewEventIds,
			historicalProjectPreviewGroups,
		);
		const index = events.findIndex(
			(event) => event.id === selectedTool.eventId,
		);
		if (index < 0) return null;
		return { event: events[index], events, index };
	}, [
		groupedProjectPreviewEventIds,
		historicalProjectPreviewGroups,
		providerId,
		selectedTool,
		visibleMessages,
	]);
	const navigateSelectedTool = useCallback(
		(direction: -1 | 1) => {
			setSelectedTool((current) => {
				if (!current) return null;
				const owner = visibleMessages.find(
					(message) =>
						message.role === "assistant" && message.id === current.responseId,
				);
				if (owner?.role !== "assistant") return current;
				const events = activityInspectorEventsForResponse(
					owner,
					providerId,
					groupedProjectPreviewEventIds,
					historicalProjectPreviewGroups,
				);
				const index = events.findIndex((event) => event.id === current.eventId);
				const next = events[index + direction];
				if (!next) return current;
				return {
					...current,
					eventId: next.id,
					trigger:
						mountedToolTrigger(current.responseId, next.id) ?? current.trigger,
				};
			});
		},
		[
			groupedProjectPreviewEventIds,
			historicalProjectPreviewGroups,
			providerId,
			visibleMessages,
		],
	);
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
				message.providerOutcome === "blocked" ||
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
		return subagents.size === 0 &&
			byWorkflow.size === 0 &&
			embeddedIds.size === 0
			? EMPTY_PERMISSION_PLACEMENT
			: { subagents, byWorkflow, embeddedIds };
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
				<div key={m.id} className="contents" data-raven-message-id={m.id}>
					<ChatMessageRow
						message={m}
						acceptedSteers={
							m.role === "assistant"
								? acceptedSteersByAssistantId.get(m.id)
								: undefined
						}
						sessionId={sessionId}
						providerId={providerId}
						expandedVisualizationEventId={expandedVisualizationEventId}
						onToggleVisualization={handleToggleVisualization}
						onVisualizationInactive={handleVisualizationInactive}
						activityOpen={
							m.role === "assistant" ? isActivityOpen(m.id) : undefined
						}
						onToggleActivity={handleToggleActivity}
						onBackgroundActivity={
							m.role === "assistant" && m.streaming
								? onBackgroundActivity
								: undefined
						}
						onSelectTool={handleSelectTool}
						onLoadEarlierToolEvents={onLoadEarlierToolEvents}
						permissionLabels={permissionLabels}
						queueState={queueStateById.get(m.id)}
						onDecide={handleDecide}
						onSubmitAnswers={handleSubmitAnswers}
						onPlanDecide={handlePlanDecide}
						onCancelQueued={handleCancelQueued}
						onPromoteQueued={handlePromoteQueued}
						onSteerQueued={handleSteerQueued}
						onViewContext={onViewContext}
						onPreviewFileRewind={onPreviewFileRewind}
						canSteerQueued={
							canSteerQueued &&
							chatQueue.find((queued) => queued.id === m.id)?.steerable !==
								false
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
				</div>
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
			<ProviderBackgroundActivityPanel sessionId={sessionId} />
			{selectedToolContext && (
				<ToolInspector
					event={selectedToolContext.event}
					onClose={closeInspector}
					navigation={{
						position: selectedToolContext.index + 1,
						total: selectedToolContext.events.length,
						onPrevious:
							selectedToolContext.index > 0
								? () => navigateSelectedTool(-1)
								: undefined,
						onNext:
							selectedToolContext.index < selectedToolContext.events.length - 1
								? () => navigateSelectedTool(1)
								: undefined,
					}}
				/>
			)}
			<div ref={bottomRef} />
		</>
	);
});
