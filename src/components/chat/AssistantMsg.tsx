import { GitFork, LoaderCircle } from "lucide-react";
import { MarkdownBody } from "#/components/MarkdownBody";
import { PrivacyMask } from "#/components/PrivacyMask";
import { useCopyToClipboard } from "#/hooks/useCopyToClipboard";
import type { ObsidianCaptureDestination } from "#/lib/obsidianCapture";
import type { ToolEventMessage } from "#/server/protocol";
import { CopyButton } from "./CopyButton";
import type { AssistantMessage } from "./chatReducer";
import { ObsidianVaultChangeReview } from "./ObsidianVaultChangeReview";
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

export function AssistantMsg({
	message,
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
}: {
	message: AssistantMessage;
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
}) {
	const { copy, copied } = useCopyToClipboard();
	const workflowAgentIds = new Set<string>();
	for (const event of message.toolEvents) {
		if (event.subagent?.kind === "workflow") {
			workflowAgentIds.add(event.subagent.agentId);
		}
	}
	const nestedSubagentEventIds = new Set<string>();
	const workflowChildren = new Map<
		string,
		NonNullable<ToolEventMessage["subagent"]>[]
	>();
	for (const event of message.toolEvents) {
		const child = event.subagent;
		if (
			!child?.parentActivityId ||
			!workflowAgentIds.has(child.parentActivityId)
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
	const transcriptToolEvents = message.toolEvents
		.slice(toolEventStartIndex)
		.filter(
			(event) =>
				!activeSubagentEvents.includes(event) &&
				!nestedSubagentEventIds.has(event.id) &&
				!groupedPreviewEvents.includes(event),
		);
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
			/>
		);
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
			{transcriptToolEvents.map(renderTool)}
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
					</PrivacyMask>
					{!message.streaming && message.text && (
						<div className="flex w-full basis-full shrink-0 items-center justify-end gap-1 pr-4 pl-12 pt-1">
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
