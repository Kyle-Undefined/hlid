import { ChevronRight, GitFork, LoaderCircle, Route } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { MarkdownBody } from "#/components/MarkdownBody";
import { PrivacyMask } from "#/components/PrivacyMask";
import { useCopyToClipboard } from "#/hooks/useCopyToClipboard";
import type { ObsidianCaptureDestination } from "#/lib/obsidianCapture";
import type { ToolEventMessage } from "#/server/protocol";
import { CopyButton } from "./CopyButton";
import type {
	AssistantMessage,
	PermissionMessage,
	UserMessage,
} from "./chatReducer";
import { ObsidianVaultChangeReview } from "./ObsidianVaultChangeReview";
import type { PermissionDecisionHandler } from "./PermissionCard";
import {
	isProjectPreviewToolEvent,
	ProjectPreviewActivityCard,
} from "./ProjectPreviewToolBlock";
import { ReadAloudButton } from "./ReadAloudButton";
import { SaveToObsidianActions } from "./SaveToObsidianActions";
import { ToolBlock } from "./ToolBlock";

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
			className="mx-3 my-1 block min-w-0 border-l border-primary/45 bg-primary/[0.035]"
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
	acceptedSteers = [],
	permissionLabels,
	sessionId,
	providerId,
	toolEventStartIndex = 0,
	olderToolEventCount = 0,
	onLoadOlderToolEvents,
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
	toolEventStartIndex?: number;
	olderToolEventCount?: number;
	onLoadOlderToolEvents?: () => void;
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
	const rawSteerBoundaries = acceptedSteers.map((steer) => {
		const rawBoundary = Number.isFinite(steer.steerToolEventIndex)
			? Math.floor(steer.steerToolEventIndex as number)
			: message.toolEvents.length;
		return Math.min(message.toolEvents.length, Math.max(0, rawBoundary));
	});
	const workflowEventIndexByAgentId = new Map<string, number>();
	for (const [eventIndex, event] of message.toolEvents.entries()) {
		if (event.subagent?.kind === "workflow") {
			workflowEventIndexByAgentId.set(event.subagent.agentId, eventIndex);
		}
	}
	const nestedSubagentEventIds = new Set<string>();
	const workflowChildren = new Map<
		string,
		NonNullable<ToolEventMessage["subagent"]>[]
	>();
	for (const [eventIndex, event] of message.toolEvents.entries()) {
		const child = event.subagent;
		if (!child?.parentActivityId) continue;
		const parentIndex = workflowEventIndexByAgentId.get(child.parentActivityId);
		if (parentIndex === undefined) continue;
		// A child emitted after an accepted steer belongs below that receipt.
		// Keep only same-boundary children inside the earlier workflow card.
		if (
			rawSteerBoundaries.some(
				(boundary) => parentIndex < boundary && boundary <= eventIndex,
			)
		) {
			continue;
		}
		nestedSubagentEventIds.add(event.id);
		const children = workflowChildren.get(child.parentActivityId) ?? [];
		children.push(child);
		workflowChildren.set(child.parentActivityId, children);
	}
	// Keep live subagents at the bottom of the active assistant turn. New parent
	// tool calls and text can then stream above them without pushing the cards
	// out of view. Once a subagent finishes it returns to its original transcript
	// position, preserving history order.
	const activeSubagentEvents = message.toolEvents.filter((event) => {
		const status = event.subagent?.status;
		return (
			!nestedSubagentEventIds.has(event.id) &&
			(status === "pending" || status === "running" || status === "paused")
		);
	});
	const previewEvents = message.toolEvents.filter(isProjectPreviewToolEvent);
	const groupedPreviewEvents = groupedProjectPreviewEventIds
		? previewEvents.filter((event) =>
				groupedProjectPreviewEventIds.has(event.id),
			)
		: previewEvents;
	const visibleToolStart = Math.min(
		Math.max(0, toolEventStartIndex),
		message.toolEvents.length,
	);
	const transcriptToolEventIndices = new Set<number>();
	for (
		let eventIndex = visibleToolStart;
		eventIndex < message.toolEvents.length;
		eventIndex++
	) {
		const event = message.toolEvents[eventIndex];
		if (
			!activeSubagentEvents.includes(event) &&
			!nestedSubagentEventIds.has(event.id) &&
			!groupedPreviewEvents.includes(event)
		) {
			transcriptToolEventIndices.add(eventIndex);
		}
	}
	const renderTool = (event: (typeof message.toolEvents)[number]) => {
		const historicalPreviewEvents = historicalProjectPreviewGroups?.get(
			event.id,
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
				childSubagents={
					event.subagent?.kind === "workflow"
						? workflowChildren.get(event.subagent.agentId)
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
			/>
		);
	};
	const steerReceiptsByBoundary = new Map<number, UserMessage[]>();
	for (const [steerIndex, steer] of acceptedSteers.entries()) {
		const boundary = Math.min(
			message.toolEvents.length,
			Math.max(visibleToolStart, rawSteerBoundaries[steerIndex]),
		);
		const receipts = steerReceiptsByBoundary.get(boundary) ?? [];
		receipts.push(steer);
		steerReceiptsByBoundary.set(boundary, receipts);
	}
	const transcriptItems: React.ReactNode[] = [];
	for (
		let eventIndex = visibleToolStart;
		eventIndex <= message.toolEvents.length;
		eventIndex++
	) {
		for (const steer of steerReceiptsByBoundary.get(eventIndex) ?? []) {
			transcriptItems.push(
				<AcceptedSteerReceipt
					key={`steer:${steer.id}`}
					message={steer}
					responseId={message.id}
				/>,
			);
		}
		if (
			eventIndex < message.toolEvents.length &&
			transcriptToolEventIndices.has(eventIndex)
		) {
			transcriptItems.push(renderTool(message.toolEvents[eventIndex]));
		}
	}
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
			{olderToolEventCount > 0 && onLoadOlderToolEvents && (
				<div className="my-1 flex w-full px-3 sm:justify-start">
					<button
						type="button"
						onClick={onLoadOlderToolEvents}
						className="flex min-h-9 w-full items-center justify-center border border-border px-3 py-1.5 text-[10px] tracking-widest text-muted-foreground uppercase transition-colors hover:bg-accent hover:text-foreground sm:w-auto"
					>
						Show {olderToolEventCount} earlier tool{" "}
						{olderToolEventCount === 1 ? "call" : "calls"}
					</button>
				</div>
			)}
			{transcriptItems}
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
			{activeSubagentEvents.map(renderTool)}
			{groupedProjectPreviewEventIds === undefined &&
				groupedPreviewEvents.length > 0 && (
					<ProjectPreviewActivityCard
						events={groupedPreviewEvents}
						permissionLabels={permissionLabels}
						active={message.streaming}
					/>
				)}
		</div>
	);
}
