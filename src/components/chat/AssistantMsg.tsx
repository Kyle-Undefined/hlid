import { ChevronRight, GitFork, LoaderCircle, Route } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { MarkdownBody } from "#/components/MarkdownBody";
import { PrivacyMask } from "#/components/PrivacyMask";
import { useCopyToClipboard } from "#/hooks/useCopyToClipboard";
import type { ObsidianCaptureDestination } from "#/lib/obsidianCapture";
import type { ToolEventMessage } from "#/server/protocol";
import {
	type ActivityTrayRenderContext,
	AssistantActivityTray,
} from "./AssistantActivityTray";
import { planAssistantTranscript } from "./assistantTranscriptLayout";
import { CopyButton } from "./CopyButton";
import type {
	AssistantMessage,
	PermissionMessage,
	UserMessage,
} from "./chatReducer";
import { isHlidVisualizationToolEvent } from "./HlidVisualizationToolBlock";
import { ObsidianVaultChangeReview } from "./ObsidianVaultChangeReview";
import type { PermissionDecisionHandler } from "./PermissionCard";
import {
	isProjectPreviewToolEvent,
	ProjectPreviewActivityCard,
} from "./ProjectPreviewToolBlock";
import { ReadAloudButton } from "./ReadAloudButton";
import { SaveToObsidianActions } from "./SaveToObsidianActions";
import { TaskActivityGroupToolBlock } from "./TaskActivityToolBlock";
import { ToolBlock } from "./ToolBlock";

const EMPTY_ACCEPTED_STEERS: readonly UserMessage[] = [];

export function normalizeMd(text: string): string {
	// CommonMark: "**foo:**bar" — closer after punctuation, before word char,
	// is left-flanking only and cannot close strong. Insert a space after closer.
	return text.replace(
		/(\*\*[^\s*](?:[^*\n]|\*(?!\*))*?[^\w\s*])\*\*(?=\w)/gu,
		"$1** ",
	);
}

function acceptedSteerReceiptId(responseId: string, steerId: string): string {
	return `accepted-steer-${encodeURIComponent(responseId)}-${encodeURIComponent(steerId)}`;
}

function withoutTaskActivity(event: ToolEventMessage): ToolEventMessage {
	const { taskActivity: _taskActivity, ...rawEvent } = event;
	return rawEvent;
}

function AcceptedSteerReceipt({
	message,
	responseId,
}: {
	message: UserMessage;
	responseId: string;
}) {
	const [expanded, setExpanded] = useState(false);
	const [canExpand, setCanExpand] = useState(false);
	const textRef = useRef<HTMLSpanElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: canExpand swaps the wrapper and must rebind measurement to the replacement text node
	useLayoutEffect(() => {
		if (!message.text) {
			setCanExpand(false);
			return;
		}
		const text = textRef.current;
		if (!text || expanded) return;
		const measure = () => {
			setCanExpand(text.scrollHeight > text.clientHeight + 1);
		};
		measure();
		if (typeof ResizeObserver !== "undefined") {
			const observer = new ResizeObserver(measure);
			observer.observe(text);
			return () => observer.disconnect();
		}
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, [canExpand, expanded, message.text]);
	const content = (
		<>
			<Route
				className="mt-0.5 h-3 w-3 shrink-0 text-primary/65"
				aria-hidden="true"
			/>
			<span className="mt-px shrink-0 text-[8px] font-medium tracking-[0.14em] text-primary/65 uppercase">
				Steer accepted
			</span>
			<span
				ref={textRef}
				data-steer-text
				className={`min-w-0 flex-1 text-[11px] leading-4 text-muted-foreground/75 ${
					expanded
						? "whitespace-pre-wrap break-words"
						: "line-clamp-2 break-words"
				}`}
			>
				<PrivacyMask inline>{message.text}</PrivacyMask>
			</span>
			{canExpand && (
				<ChevronRight
					className={`mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/40 transition-transform ${
						expanded ? "rotate-90" : ""
					}`}
					aria-hidden="true"
				/>
			)}
		</>
	);
	const contentClassName =
		"flex w-full min-w-0 items-start gap-2 px-2.5 py-1.5 text-left";
	return (
		<output
			id={acceptedSteerReceiptId(responseId, message.id)}
			aria-live="polite"
			aria-atomic="true"
			data-steer-receipt={message.id}
			className="mx-3 block min-w-0 border-l border-primary/45 bg-primary/[0.035]"
		>
			{canExpand ? (
				<button
					type="button"
					data-steer-focus
					aria-expanded={expanded}
					onClick={() => setExpanded((value) => !value)}
					className={`${contentClassName} transition-colors hover:bg-primary/[0.045]`}
					title={expanded ? "Collapse accepted steer" : "Expand accepted steer"}
				>
					{content}
				</button>
			) : (
				<div data-steer-focus tabIndex={-1} className={contentClassName}>
					{content}
				</div>
			)}
		</output>
	);
}

export function AssistantMsg({
	message,
	acceptedSteers = EMPTY_ACCEPTED_STEERS,
	permissionLabels,
	sessionId,
	providerId,
	expandedVisualizationEventId,
	onToggleVisualization,
	onVisualizationInactive,
	activityOpen,
	onToggleActivity,
	onBackgroundActivity,
	onSelectTool,
	canBranch = false,
	branching = false,
	onBranch,
	obsidianCapture,
	groupedProjectPreviewEventIds,
	historicalProjectPreviewGroups,
	pendingPermissionsByWorkflow,
	onDecidePermission,
}: {
	message: AssistantMessage;
	acceptedSteers?: readonly UserMessage[];
	permissionLabels?: Map<string, string>;
	sessionId?: string;
	providerId?: string;
	expandedVisualizationEventId?: string | null;
	onToggleVisualization?: (eventId: string) => void;
	onVisualizationInactive?: (eventId: string) => void;
	activityOpen?: boolean;
	onToggleActivity?: () => void;
	onBackgroundActivity?: () => void;
	onSelectTool?: (event: ToolEventMessage, trigger: HTMLElement) => void;
	/** Whole-session precondition (Claude-only, session idle) — see raven.tsx. */
	canBranch?: boolean;
	/** True while this specific row's branch fork is in flight. */
	branching?: boolean;
	onBranch?: (dbId: number) => void;
	obsidianCapture?: ObsidianCaptureDestination | null;
	groupedProjectPreviewEventIds?: ReadonlySet<string>;
	historicalProjectPreviewGroups?: ReadonlyMap<string, ToolEventMessage[]>;
	pendingPermissionsByWorkflow?: ReadonlyMap<
		string,
		ReadonlyArray<PermissionMessage>
	>;
	onDecidePermission?: PermissionDecisionHandler;
}) {
	const { copy, copied } = useCopyToClipboard();
	const [localActivityOpen, setLocalActivityOpen] = useState(true);
	const resolvedActivityOpen = activityOpen ?? localActivityOpen;
	const toggleActivity =
		onToggleActivity ?? (() => setLocalActivityOpen((current) => !current));
	const suppressedProjectPreviewEventIds = useMemo(() => {
		// MessageList pins the active Preview lifecycle in one rich session card.
		// Keep those calls visible as compact response-owned receipts, while still
		// suppressing the duplicate non-anchor rows of settled historical groups.
		if (historicalProjectPreviewGroups === undefined) {
			return groupedProjectPreviewEventIds;
		}
		const ids = new Set<string>();
		for (const events of historicalProjectPreviewGroups.values()) {
			for (const event of events.slice(1)) ids.add(event.id);
		}
		return ids;
	}, [groupedProjectPreviewEventIds, historicalProjectPreviewGroups]);
	const persistentTranscriptPlan = useMemo(
		() =>
			planAssistantTranscript({
				toolEvents: message.toolEvents,
				acceptedSteers,
				toolEventStartIndex: 0,
				groupedProjectPreviewEventIds: suppressedProjectPreviewEventIds,
				isProjectPreviewEvent: isProjectPreviewToolEvent,
			}),
		[message.toolEvents, acceptedSteers, suppressedProjectPreviewEventIds],
	);
	const renderTool = (
		event: (typeof message.toolEvents)[number],
		transcriptPlan = persistentTranscriptPlan,
		inspectTool?: ActivityTrayRenderContext["onSelectTool"],
	) => {
		const historicalPreviewEvents = historicalProjectPreviewGroups?.get(
			event.id,
		);
		const compactPinnedPreview = Boolean(
			inspectTool &&
				groupedProjectPreviewEventIds?.has(event.id) &&
				isProjectPreviewToolEvent(event) &&
				!historicalPreviewEvents,
		);
		return historicalPreviewEvents ? (
			<ProjectPreviewActivityCard
				key={event.id}
				events={historicalPreviewEvents}
				permissionLabels={permissionLabels}
				historicalGroup
			/>
		) : (
			<ToolBlock
				key={event.id}
				event={event}
				permissionLabel={permissionLabels?.get(event.id)}
				sessionId={sessionId}
				providerId={providerId}
				expandedVisualizationEventId={expandedVisualizationEventId}
				onToggleVisualization={onToggleVisualization}
				onVisualizationInactive={onVisualizationInactive}
				childSubagents={
					event.subagent?.kind === "workflow"
						? transcriptPlan.workflowChildEventIndices
								.get(event.subagent.agentId)
								?.map(
									(eventIndex) =>
										message.toolEvents[eventIndex].subagent as NonNullable<
											ToolEventMessage["subagent"]
										>,
								)
						: undefined
				}
				pendingPermissions={
					event.subagent?.kind === "workflow"
						? pendingPermissionsByWorkflow?.get(
								`${event.subagent.provider}:${event.subagent.agentId}`,
							)
						: undefined
				}
				onDecidePermission={onDecidePermission}
				onInspect={inspectTool}
				compactSpecialized={compactPinnedPreview}
				responseSettled={!message.streaming}
			/>
		);
	};
	const taskActivityGroups = useMemo(
		() =>
			persistentTranscriptPlan.taskActivityGroups.map((group) => ({
				...group,
				events: group.eventIndices.map(
					(eventIndex) => message.toolEvents[eventIndex],
				),
			})),
		[message.toolEvents, persistentTranscriptPlan.taskActivityGroups],
	);
	const activeTaskActivityGroups = message.streaming ? taskActivityGroups : [];
	const activeTaskActivityGroupKeys = new Set(
		activeTaskActivityGroups.map((group) => group.key),
	);
	const renderTaskActivityGroup = (
		group: (typeof taskActivityGroups)[number],
	) => (
		<TaskActivityGroupToolBlock
			key={group.key}
			events={group.events}
			sessionId={sessionId}
			responseSettled={!message.streaming}
		>
			{group.events.map((event) => (
				<ToolBlock
					key={event.id}
					event={withoutTaskActivity(event)}
					permissionLabel={permissionLabels?.get(event.id)}
					sessionId={sessionId}
					providerId={providerId}
				/>
			))}
		</TaskActivityGroupToolBlock>
	);
	const renderActivityContent = ({
		startIndex,
		endIndex,
		onSelectTool: inspectTool,
	}: ActivityTrayRenderContext) => {
		const transcriptPlan = planAssistantTranscript({
			toolEvents: message.toolEvents,
			acceptedSteers,
			toolEventStartIndex: startIndex,
			toolEventEndIndex: endIndex,
			groupedProjectPreviewEventIds: suppressedProjectPreviewEventIds,
			isProjectPreviewEvent: isProjectPreviewToolEvent,
		});
		return transcriptPlan.items.flatMap((item) => {
			if (item.kind === "task_group") {
				if (activeTaskActivityGroupKeys.has(item.key)) return [];
				const events = item.eventIndices.map(
					(eventIndex) => message.toolEvents[eventIndex],
				);
				return events.length > 0
					? [
							renderTaskActivityGroup({
								key: item.key,
								eventIndices: item.eventIndices,
								events,
							}),
						]
					: [];
			}
			const event = message.toolEvents[item.eventIndex];
			if (providerId === "codex" && isHlidVisualizationToolEvent(event)) {
				return [];
			}
			return [renderTool(event, transcriptPlan, inspectTool)];
		});
	};
	const trailingVisualizationEvents = useMemo(
		() =>
			providerId === "codex"
				? message.toolEvents.filter(isHlidVisualizationToolEvent)
				: [],
		[message.toolEvents, providerId],
	);
	const activeSubagentEvents = useMemo(
		() =>
			persistentTranscriptPlan.activeSubagentEventIndices.map(
				(eventIndex) => message.toolEvents[eventIndex],
			),
		[message.toolEvents, persistentTranscriptPlan.activeSubagentEventIndices],
	);
	const groupedPreviewEvents = useMemo(
		() =>
			persistentTranscriptPlan.groupedProjectPreviewEventIndices.map(
				(eventIndex) => message.toolEvents[eventIndex],
			),
		[
			message.toolEvents,
			persistentTranscriptPlan.groupedProjectPreviewEventIndices,
		],
	);
	const hasAcceptedSteer = acceptedSteers.length > 0;
	const latestAcceptedSteer = acceptedSteers.at(-1);
	const jumpToAcceptedSteer = () => {
		if (!latestAcceptedSteer) return;
		const receipt = document.getElementById(
			acceptedSteerReceiptId(message.id, latestAcceptedSteer.id),
		);
		receipt?.scrollIntoView?.({ behavior: "smooth", block: "center" });
		receipt
			?.querySelector<HTMLElement>("[data-steer-focus]")
			?.focus({ preventScroll: true });
	};
	return (
		<div className="group w-full min-w-0 max-w-full overflow-hidden py-3 border-b border-border/40 space-y-1.5">
			{(message.toolEvents.length > 0 || acceptedSteers.length > 0) && (
				<AssistantActivityTray
					responseId={message.id}
					events={message.toolEvents}
					streaming={message.streaming}
					steerCount={acceptedSteers.length}
					open={resolvedActivityOpen}
					onToggle={toggleActivity}
					onBackground={onBackgroundActivity}
					onSelectTool={onSelectTool}
					renderContent={renderActivityContent}
				/>
			)}
			{acceptedSteers.length > 0 && (
				<section
					data-steer-stack={message.id}
					aria-label={`${acceptedSteers.length} accepted steer${acceptedSteers.length === 1 ? "" : "s"} for this response`}
					className="space-y-1 py-0.5"
				>
					{acceptedSteers.map((steer) => (
						<AcceptedSteerReceipt
							key={steer.id}
							message={steer}
							responseId={message.id}
						/>
					))}
				</section>
			)}
			{(message.text || message.streaming) && (
				<div className="flex flex-wrap items-start gap-0">
					<div className="shrink-0 pt-0.5 w-12 flex">
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 32 32"
							className="w-4 h-4 opacity-60"
							role="img"
							aria-label="Assistant"
						>
							<path
								d="M2 16 C7 6 25 6 30 16 C25 26 7 26 2 16Z"
								fill="none"
								style={{ stroke: "var(--data)" }}
								strokeWidth="1.5"
								strokeLinejoin="round"
							/>
							<circle
								cx="16"
								cy="16"
								r="5.5"
								fill="none"
								style={{ stroke: "var(--data)" }}
								strokeWidth="1.5"
							/>
							<circle cx="16" cy="16" r="2" style={{ fill: "var(--data)" }} />
						</svg>
					</div>
					<PrivacyMask className="flex-1 text-sm leading-relaxed pr-4 min-w-0 text-[var(--agent-msg)]">
						<MarkdownBody
							content={normalizeMd(message.text ?? "")}
							streaming={message.streaming}
						/>
						{message.streaming && (
							<span className="inline-block w-[7px] h-[1em] ml-0.5 align-middle bg-primary/50 cursor-blink" />
						)}
						{message.streaming && hasAcceptedSteer && (
							<button
								type="button"
								onClick={jumpToAcceptedSteer}
								aria-label="View accepted steer receipt"
								className="ml-1 inline-flex min-h-6 min-w-6 items-center justify-center rounded-sm px-1 align-middle text-[8px] font-medium tracking-[0.14em] text-primary/55 uppercase transition-colors hover:text-primary/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
								title={`${acceptedSteers.length} accepted steer${acceptedSteers.length === 1 ? "" : "s"} in this response`}
							>
								Steered
							</button>
						)}
					</PrivacyMask>
					{!message.streaming && message.text && (
						<div className="flex w-full basis-full shrink-0 items-center justify-end gap-1 pr-4 pl-12 pt-1">
							{hasAcceptedSteer && (
								<button
									type="button"
									onClick={jumpToAcceptedSteer}
									aria-label="View accepted steer receipt"
									className="mr-auto inline-flex min-h-6 min-w-6 items-center justify-center rounded-sm px-1 text-[8px] font-medium tracking-[0.14em] text-primary/45 uppercase transition-colors hover:text-primary/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
									title={`${acceptedSteers.length} accepted steer${acceptedSteers.length === 1 ? "" : "s"} in this response`}
								>
									Steered
								</button>
							)}
							{message.cost !== null && (
								<PrivacyMask
									inline
									className="text-[9px] tabular-nums text-muted-foreground/40 pt-0.5 font-mono"
								>
									{message.costEstimated ? "~" : ""}${message.cost.toFixed(4)}
								</PrivacyMask>
							)}
							<CopyButton
								onCopy={() => copy(message.text ?? "")}
								copied={copied}
							/>
							<ReadAloudButton
								messageId={message.id}
								text={message.text}
								dbId={message.dbId}
							/>
							<SaveToObsidianActions
								text={message.text}
								capture={obsidianCapture}
							/>
							{canBranch && message.dbId != null && onBranch && (
								<button
									type="button"
									onClick={() => onBranch(message.dbId as number)}
									disabled={branching}
									aria-label="Branch from here"
									title="Fork a new session from this point in the conversation"
									className="disabled:opacity-40 text-muted-foreground/50 hover:text-foreground transition-colors"
								>
									{branching ? (
										<LoaderCircle className="w-3 h-3 animate-spin" />
									) : (
										<GitFork className="w-3 h-3" />
									)}
								</button>
							)}
						</div>
					)}
				</div>
			)}
			{trailingVisualizationEvents.map((event) => renderTool(event))}
			{!message.streaming && (
				<ObsidianVaultChangeReview toolEvents={message.toolEvents} />
			)}
			{message.recap && !message.streaming && (
				<div className="my-0.5">
					<div className="flex items-baseline gap-2.5 w-full px-3 py-1.5">
						<span className="text-muted-foreground/30 text-[11px] shrink-0 leading-none select-none">
							—
						</span>
						<span className="text-[9px] font-medium tracking-wider text-muted-foreground/40 uppercase shrink-0">
							RECAP
						</span>
						<span className="text-[11px] text-primary/55 leading-relaxed">
							{message.recap}
						</span>
					</div>
				</div>
			)}
			{activeTaskActivityGroups.map(renderTaskActivityGroup)}
			{activeSubagentEvents.map((event) => renderTool(event))}
			{groupedProjectPreviewEventIds === undefined &&
				groupedPreviewEvents.length > 0 && (
					<ProjectPreviewActivityCard
						events={groupedPreviewEvents}
						permissionLabels={permissionLabels}
					/>
				)}
		</div>
	);
}
