import { AlertTriangle, Check, ChevronRight } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { PrivacyMask } from "#/components/PrivacyMask";
import {
	type HistoricalToolEventDetail,
	loadToolEventDetail,
} from "#/hooks/toolEventDetailStore";
import type { SubagentSnapshot } from "#/server/agentProvider";
import type { ToolEventMessage } from "#/server/protocol";
import type { PermissionMessage } from "./chatReducer";
import {
	HlidDelegationToolBlock,
	isHlidDelegationToolEvent,
} from "./HlidDelegationToolBlock";
import {
	HlidVisualizationToolBlock,
	isHlidVisualizationToolEvent,
} from "./HlidVisualizationToolBlock";
import type { PermissionDecisionHandler } from "./PermissionCard";
import {
	ProjectPreviewCaptureToolBlock,
	ProjectPreviewToolBlock,
} from "./ProjectPreviewToolBlock";
import { SubagentToolBlock } from "./SubagentToolBlock";
import { TaskActivityToolBlock } from "./TaskActivityToolBlock";
import { ToolBlockExpandedPanel } from "./ToolBlockExpandedPanel";
import { resumeNativeWorkflow, stopNativeWorkflow } from "./workflowActions";

const RESULT_PREVIEW_CHARS = 120;
const INPUT_PREVIEW_CHARS = 140;
const taskActivityOpenOverrides = new Map<string, boolean>();

function firstLine(text: string): string {
	const nl = text.indexOf("\n");
	return nl === -1 ? text : text.slice(0, nl);
}

function inputPreview(value: unknown): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.length <= INPUT_PREVIEW_CHARS
		? text
		: `${text.slice(0, INPUT_PREVIEW_CHARS)}…`;
}

/**
 * Strip the leading `   <line>\t` prefix that the Read tool prepends to every
 * line (cat -n style). Without this, markdown rendering of a Read result
 * collapses the tab and the numbers run inline with the content. Only strips
 * when the prefix appears on the majority of lines, so we don't mangle
 * arbitrary output that happens to start with digits + tab.
 */
export function stripReadLineNumbers(text: string): string {
	if (!text) return text;
	const lines = text.split("\n");
	const re = /^\s*\d+\t/;
	let matched = 0;
	for (const l of lines) {
		if (re.test(l)) matched++;
	}
	if (matched < Math.max(2, Math.floor(lines.length * 0.5))) return text;
	return lines.map((l) => l.replace(re, "")).join("\n");
}

/**
 * Heuristic — does this content look like markdown? Used to decide whether a
 * tool result renders as MarkdownBody (formatted) or <pre> (raw). Defaults to
 * pre because most tool output is logs/code/JSON, not prose.
 */
export function looksLikeMarkdown(text: string): boolean {
	if (!text) return false;
	// Headings (start of string or after newline).
	if (/^#{1,6} \S/m.test(text)) return true;
	// Fenced code blocks.
	if (/```/.test(text)) return true;
	// GitHub-flavored alert blockquotes.
	if (/^> \[![A-Z]+]/m.test(text)) return true;
	// Bullet/numbered lists at line start.
	if (/^(?:[-*+] |\d+\. )\S/m.test(text)) return true;
	// Inline link with brackets.
	if (/\[[^\]\n]+]\([^)\n]+\)/.test(text)) return true;
	// Multiple bold spans (single one is too weak).
	const boldMatches = text.match(/\*\*[^*\n]+\*\*/g);
	if (boldMatches && boldMatches.length >= 2) return true;
	// Markdown table.
	if (/^\|[^\n]+\|\s*\n\|[\s\-:|]+\|/m.test(text)) return true;
	return false;
}

type ToolBlockProps = {
	event: ToolEventMessage;
	permissionLabel?: string;
	sessionId?: string;
	providerId?: string;
	expandedVisualizationEventId?: string | null;
	onToggleVisualization?: (eventId: string) => void;
	onVisualizationInactive?: (eventId: string) => void;
	childSubagents?: ReadonlyArray<SubagentSnapshot>;
	pendingPermissions?: ReadonlyArray<PermissionMessage>;
	onDecidePermission?: PermissionDecisionHandler;
};

type SpecializedToolEventKind =
	| "subagent"
	| "visualization"
	| "project-preview-capture"
	| "project-preview-lifecycle";

function specializedToolEventKind(
	event: ToolEventMessage,
	providerId?: string,
): SpecializedToolEventKind | null {
	if (providerId === "codex" && isHlidVisualizationToolEvent(event)) {
		return "visualization";
	}
	if (event.subagent) return "subagent";
	if (
		event.name.endsWith("capture_project_preview") ||
		event.name.endsWith("control_project_preview")
	) {
		return "project-preview-capture";
	}
	if (
		event.name.endsWith("start_project_preview") ||
		event.name.endsWith("inspect_project_preview") ||
		event.name.endsWith("stop_project_preview")
	) {
		return "project-preview-lifecycle";
	}
	return null;
}

function SpecializedToolEvent({
	kind,
	event,
	permissionLabel,
	sessionId,
	providerId,
	expandedVisualizationEventId,
	onToggleVisualization,
	onVisualizationInactive,
	childSubagents,
	pendingPermissions,
	onDecidePermission,
}: ToolBlockProps & { kind: SpecializedToolEventKind }) {
	if (kind === "visualization") {
		return (
			<HlidVisualizationToolBlock
				event={event}
				permissionLabel={permissionLabel}
				sessionId={sessionId}
				expanded={expandedVisualizationEventId === event.id}
				onToggle={
					onToggleVisualization
						? () => onToggleVisualization(event.id)
						: undefined
				}
				onInactive={
					onVisualizationInactive
						? () => onVisualizationInactive(event.id)
						: undefined
				}
			/>
		);
	}
	if (kind === "project-preview-capture") {
		return (
			<ProjectPreviewCaptureToolBlock
				event={event}
				permissionLabel={permissionLabel}
			/>
		);
	}
	if (kind === "project-preview-lifecycle") {
		return (
			<ProjectPreviewToolBlock
				event={event}
				permissionLabel={permissionLabel}
			/>
		);
	}

	const subagent = event.subagent;
	if (!subagent) return null;
	const workflow = subagent.kind === "workflow";
	const ownsCurrentProvider =
		providerId === undefined || providerId === subagent.provider;
	const resumeSessionId =
		workflow && ownsCurrentProvider && subagent.workflowRunId
			? sessionId
			: undefined;
	return (
		<SubagentToolBlock
			subagent={subagent}
			childSubagents={childSubagents}
			pendingPermissions={pendingPermissions}
			onDecidePermission={onDecidePermission}
			onStop={
				workflow && ownsCurrentProvider && sessionId && subagent.taskId
					? () => stopNativeWorkflow(sessionId, subagent.taskId ?? "")
					: undefined
			}
			onResume={
				resumeSessionId
					? () => resumeNativeWorkflow(resumeSessionId, subagent)
					: undefined
			}
		/>
	);
}

type HistoricalToolDetailState = {
	needsDetail: boolean;
	detail: HistoricalToolEventDetail | null;
	loading: boolean;
	error: string | null;
	retry: () => void;
	release: () => void;
};

function useHistoricalToolEventDetail(
	event: ToolEventMessage,
	open: boolean,
): HistoricalToolDetailState {
	const [detail, setDetail] = useState<HistoricalToolEventDetail | null>(null);
	const [detailLoading, setDetailLoading] = useState(false);
	const [detailError, setDetailError] = useState<string | null>(null);
	const needsDetail =
		event.resultTruncated === true && Boolean(event.detailSessionId);

	useEffect(() => {
		if (
			!open ||
			!needsDetail ||
			!event.detailSessionId ||
			detail ||
			detailError
		)
			return;
		let cancelled = false;
		setDetailLoading(true);
		setDetailError(null);
		void loadToolEventDetail(event.detailSessionId, event.id)
			.then((loaded) => {
				if (!cancelled) setDetail(loaded);
			})
			.catch((error: unknown) => {
				if (!cancelled) {
					setDetailError(
						error instanceof Error
							? error.message
							: "Unable to load tool result",
					);
				}
			})
			.finally(() => {
				if (!cancelled) setDetailLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open, needsDetail, event.detailSessionId, event.id, detail, detailError]);

	return {
		needsDetail,
		detail,
		loading: detailLoading,
		error: detailError,
		retry: () => setDetailError(null),
		// The shared detail cache is byte-bounded. Drop this component's
		// additional reference when it closes so evicted results can be GC'd.
		release: () => {
			if (needsDetail) setDetail(null);
		},
	};
}

type ToolEventPresentation = {
	inputEntries: [string, unknown][];
	pills: [string, unknown][];
	isReasoning: boolean;
	isError: boolean;
	hasResult: boolean;
	renderResultAsMarkdown: boolean;
	strippedResult: string;
	resultPreview: string | null;
};

type ToolResultState = {
	isError: boolean;
	hasResult: boolean;
	text: string;
	preview: string | null;
};

function hasToolResult(
	event: ToolEventMessage,
	hydratedDetail: HistoricalToolEventDetail | null,
): boolean {
	if (typeof event.result === "string") return true;
	if (hydratedDetail?.result !== undefined && hydratedDetail.result !== null) {
		return true;
	}
	return event.resultLength !== undefined && event.resultLength !== null;
}

function toolResultState(
	event: ToolEventMessage,
	historical: HistoricalToolDetailState,
): ToolResultState {
	const hydratedDetail = historical.needsDetail ? historical.detail : null;
	const isError = Boolean(hydratedDetail?.isError ?? event.isError);
	const hasResult = hasToolResult(event, hydratedDetail);
	const text = hydratedDetail?.result ?? event.result ?? "";
	const preview = hasResult
		? firstLine(event.result ?? text).slice(0, RESULT_PREVIEW_CHARS)
		: null;
	return { isError, hasResult, text, preview };
}

function toolEventPresentation(
	event: ToolEventMessage,
	open: boolean,
	historical: HistoricalToolDetailState,
): ToolEventPresentation {
	const inputEntries = Object.entries(event.input ?? {});
	const pills = inputEntries.slice(0, 3);
	const isReasoning = event.name === "Reasoning";
	const result = toolResultState(event, historical);
	const canProcessResult =
		open && (!historical.needsDetail || historical.detail !== null);
	const strippedResult = canProcessResult
		? stripReadLineNumbers(result.text)
		: "";
	const renderResultAsMarkdown =
		canProcessResult &&
		result.hasResult &&
		!result.isError &&
		(isReasoning || looksLikeMarkdown(strippedResult));

	return {
		inputEntries,
		pills,
		isReasoning,
		isError: result.isError,
		hasResult: result.hasResult,
		renderResultAsMarkdown,
		strippedResult,
		resultPreview: result.preview,
	};
}

function ToolDetailPanel({
	open,
	historical,
	presentation,
}: {
	open: boolean;
	historical: HistoricalToolDetailState;
	presentation: ToolEventPresentation;
}) {
	if (!open) return null;
	if (historical.needsDetail && !historical.detail) {
		return (
			<div className="mx-3 mb-1.5 min-w-0 max-w-[calc(100%_-_1.5rem)] border border-[var(--tool-panel-border)] bg-[var(--tool-panel)] px-3 py-2 text-[11px] text-muted-foreground/70">
				{historical.error ? (
					<div className="flex items-center justify-between gap-3">
						<span>{historical.error}</span>
						<button
							type="button"
							onClick={historical.retry}
							className="shrink-0 text-primary/75 underline underline-offset-2 hover:text-primary"
						>
							Retry
						</button>
					</div>
				) : (
					<span>
						{historical.loading ? "Loading full result…" : "Loading…"}
					</span>
				)}
			</div>
		);
	}
	return (
		<ToolBlockExpandedPanel
			inputEntries={presentation.inputEntries}
			hasResult={presentation.hasResult}
			isError={presentation.isError}
			isReasoning={presentation.isReasoning}
			renderResultAsMarkdown={presentation.renderResultAsMarkdown}
			strippedResult={presentation.strippedResult}
		/>
	);
}

function ToolEventSummary({
	event,
	permissionLabel,
	open,
	onToggle,
	presentation,
}: {
	event: ToolEventMessage;
	permissionLabel?: string;
	open: boolean;
	onToggle: () => void;
	presentation: ToolEventPresentation;
}) {
	return (
		<>
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={open}
				className="flex items-center gap-2.5 w-full min-w-0 max-w-full overflow-hidden px-3 py-1.5 group hover:bg-primary/[0.03] transition-colors text-left"
			>
				<ChevronRight
					className={`w-3 h-3 shrink-0 text-primary/50 group-hover:text-primary/80 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
				/>
				<PrivacyMask
					inline
					className="text-[11px] font-medium tracking-wider text-primary/70 group-hover:text-primary/90 shrink-0"
				>
					{event.name}
				</PrivacyMask>
				<PrivacyMask className="flex flex-1 min-w-0 max-w-full gap-1.5 flex-nowrap overflow-hidden">
					{presentation.pills.map(([key, value]) => (
						<span
							key={key}
							className="block min-w-0 max-w-full truncate whitespace-nowrap text-[9px] tracking-wide border border-primary/20 text-primary/50 px-1.5 py-0.5 font-mono overflow-hidden"
						>
							{key}: {inputPreview(value)}
						</span>
					))}
				</PrivacyMask>
			</button>
			{permissionLabel && (
				<div className="flex items-center gap-1.5 pl-8 pr-3 pb-1 -mt-0.5 text-[9px] tracking-widest text-muted-foreground/55 uppercase">
					<Check className="w-2.5 h-2.5 text-status-success/55" />
					<span>{permissionLabel}</span>
				</div>
			)}
			{!open && presentation.hasResult && (
				<div
					className={`flex items-center gap-1.5 pl-8 pr-3 pb-1 text-[10px] font-mono leading-tight ${
						presentation.isError
							? "text-destructive/70"
							: "text-muted-foreground/55"
					}`}
				>
					{presentation.isError && (
						<AlertTriangle
							className="w-2.5 h-2.5 shrink-0 text-destructive/70"
							aria-label="Error"
						/>
					)}
					<span className="truncate">
						<PrivacyMask inline>
							{presentation.resultPreview &&
							presentation.resultPreview.length > 0
								? presentation.resultPreview
								: presentation.isError
									? "(error)"
									: "(empty)"}
						</PrivacyMask>
					</span>
				</div>
			)}
		</>
	);
}

function ExpandableToolEventBlock({
	event,
	permissionLabel,
	sessionId,
}: Pick<ToolBlockProps, "event" | "permissionLabel" | "sessionId">) {
	const taskStateKey = event.taskActivity
		? `${sessionId ?? event.detailSessionId ?? "unknown"}:${event.id}`
		: null;
	const [open, setOpen] = useState(() =>
		taskStateKey
			? (taskActivityOpenOverrides.get(taskStateKey) ?? false)
			: false,
	);
	const historical = useHistoricalToolEventDetail(event, open);
	const presentation = toolEventPresentation(event, open, historical);
	const toggleOpen = () => {
		const nextOpen = !open;
		setOpen(nextOpen);
		if (taskStateKey) taskActivityOpenOverrides.set(taskStateKey, nextOpen);
		if (!nextOpen) historical.release();
	};
	const detailPanel = (
		<ToolDetailPanel
			open={open}
			historical={historical}
			presentation={presentation}
		/>
	);

	if (isHlidDelegationToolEvent(event)) {
		return (
			<HlidDelegationToolBlock
				event={event}
				permissionLabel={permissionLabel}
				open={open}
				onToggle={toggleOpen}
			>
				{detailPanel}
			</HlidDelegationToolBlock>
		);
	}
	if (event.taskActivity) {
		return (
			<TaskActivityToolBlock
				event={{ ...event, taskActivity: event.taskActivity }}
				permissionLabel={permissionLabel}
				open={open}
				onToggle={toggleOpen}
			>
				{detailPanel}
			</TaskActivityToolBlock>
		);
	}
	return (
		<div className="my-0.5 min-w-0 max-w-full overflow-hidden">
			<ToolEventSummary
				event={event}
				permissionLabel={permissionLabel}
				open={open}
				onToggle={toggleOpen}
				presentation={presentation}
			/>
			{detailPanel}
		</div>
	);
}

export const ToolBlock = memo(function ToolBlock(props: ToolBlockProps) {
	const kind = specializedToolEventKind(props.event, props.providerId);
	return kind ? (
		<SpecializedToolEvent {...props} kind={kind} />
	) : (
		<ExpandableToolEventBlock
			event={props.event}
			permissionLabel={props.permissionLabel}
			sessionId={props.sessionId}
		/>
	);
});
