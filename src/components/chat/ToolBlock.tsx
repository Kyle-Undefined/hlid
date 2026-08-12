import {
	AlertTriangle,
	Check,
	CheckCircle2,
	ChevronLeft,
	ChevronRight,
	LoaderCircle,
	X,
} from "lucide-react";
import { memo, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { PrivacyMask } from "#/components/PrivacyMask";
import {
	type HistoricalToolEventDetail,
	loadToolEventDetail,
} from "#/hooks/toolEventDetailStore";
import { useDialogFocus } from "#/hooks/useDialogFocus";
import { useIsDesktop } from "#/hooks/useIsDesktop";
import { replacementUnifiedDiff } from "#/lib/unifiedDiff";
import type { SubagentSnapshot } from "#/server/agentProvider";
import type { ToolEventMessage } from "#/server/protocol";
import type { PermissionMessage } from "./chatReducer";
import {
	GeneratedMediaToolBlock,
	isGeneratedMediaToolEvent,
} from "./GeneratedMediaToolBlock";
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
import {
	ToolBlockExpandedPanel,
	type ToolDiffChange,
	type ToolResultMeta,
} from "./ToolBlockExpandedPanel";
import { resumeNativeWorkflow, stopNativeWorkflow } from "./workflowActions";

const RESULT_PREVIEW_CHARS = 120;
const INPUT_PREVIEW_CHARS = 140;
const taskActivityOpenOverrides = new Map<string, boolean>();

function firstLine(text: string): string {
	const nl = text.indexOf("\n");
	return nl === -1 ? text : text.slice(0, nl);
}

function lastNonemptyLine(text: string): string {
	return (
		text
			.split("\n")
			.reverse()
			.find((line) => line.trim()) ?? ""
	);
}

function inputPreview(value: unknown): string {
	const text =
		typeof value === "string"
			? value
			: (JSON.stringify(value) ?? String(value));
	return text.length <= INPUT_PREVIEW_CHARS
		? text
		: `${text.slice(0, INPUT_PREVIEW_CHARS)}…`;
}

type JsonObject = Record<string, unknown>;

function jsonObject(value: unknown): JsonObject | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: null;
}

function parsedJsonObject(text: string): JsonObject | null {
	if (!text || (text[0] !== "{" && text[0] !== "[")) return null;
	try {
		return jsonObject(JSON.parse(text));
	} catch {
		return null;
	}
}

function inputEntries(value: unknown): [string, unknown][] {
	const object = jsonObject(value);
	if (object) return Object.entries(object);
	return value === undefined || value === null ? [] : [["input", value]];
}

function stringField(object: JsonObject | null, key: string): string | null {
	return typeof object?.[key] === "string" ? object[key] : null;
}

function numberField(object: JsonObject | null, key: string): number | null {
	return typeof object?.[key] === "number" ? object[key] : null;
}

function commandSummary(object: JsonObject | null): string | null {
	const actions = Array.isArray(object?.commandActions)
		? object.commandActions
		: [];
	if (actions.length === 1) {
		const action = jsonObject(actions[0]);
		const command = stringField(action, "command");
		if (command) return command;
	}
	return stringField(object, "command");
}

function fileChanges(object: JsonObject | null): ToolDiffChange[] {
	if (!Array.isArray(object?.changes)) return [];
	return object.changes.flatMap((candidate) => {
		const change = jsonObject(candidate);
		const path = stringField(change, "path");
		const diff = stringField(change, "diff");
		if (!path || diff === null) return [];
		const kind = stringField(change, "kind") ?? undefined;
		return [{ path, diff, ...(kind ? { kind } : {}) }];
	});
}

function claudeMutationChanges(
	eventName: string,
	input: JsonObject | null,
): ToolDiffChange[] {
	const path = stringField(input, "file_path");
	if (!path) return [];
	if (eventName === "Write") {
		const content = stringField(input, "content");
		if (content === null) return [];
		return [
			{
				path,
				kind: "add",
				diff: replacementUnifiedDiff(path, "", content),
			},
		];
	}
	if (eventName === "Edit") {
		const oldValue = stringField(input, "old_string");
		const newValue = stringField(input, "new_string");
		if (oldValue === null || newValue === null) return [];
		return [
			{
				path,
				kind: "update",
				diff: replacementUnifiedDiff(path, oldValue, newValue),
			},
		];
	}
	if (eventName !== "MultiEdit" || !Array.isArray(input?.edits)) return [];
	const diffs = input.edits.flatMap((candidate, index) => {
		const edit = jsonObject(candidate);
		const oldValue = stringField(edit, "old_string");
		const newValue = stringField(edit, "new_string");
		return oldValue === null || newValue === null
			? []
			: [replacementUnifiedDiff(path, oldValue, newValue, `edit ${index + 1}`)];
	});
	return diffs.length > 0
		? [{ path, kind: "update", diff: diffs.join("\n") }]
		: [];
}

function toolDiffChanges(
	event: ToolEventMessage,
	completed = parsedJsonObject(event.result ?? ""),
): ToolDiffChange[] {
	const input = jsonObject(event.input);
	const type =
		stringField(completed, "type") ?? stringField(input, "type") ?? event.name;
	if (type === "fileChange" || event.name === "fileChange") {
		const completedChanges = fileChanges(completed);
		return completedChanges.length > 0 ? completedChanges : fileChanges(input);
	}
	return claudeMutationChanges(event.name, input);
}

type ToolDiffOverview = {
	additions: number;
	deletions: number;
};

function toolDiffOverview(event: ToolEventMessage): ToolDiffOverview | null {
	const changes = toolDiffChanges(event);
	if (changes.length === 0) return null;
	let additions = 0;
	let deletions = 0;
	for (const change of changes) {
		for (const line of change.diff.split("\n")) {
			if (line.startsWith("+") && !line.startsWith("+++ ")) additions++;
			if (line.startsWith("-") && !line.startsWith("--- ")) deletions++;
		}
	}
	return additions > 0 || deletions > 0 ? { additions, deletions } : null;
}

function diffOverviewLabel({ additions, deletions }: ToolDiffOverview): string {
	return `${additions} ${additions === 1 ? "addition" : "additions"}, ${deletions} ${deletions === 1 ? "deletion" : "deletions"}`;
}

export function toolDisplayName(event: ToolEventMessage): string {
	const input = jsonObject(event.input);
	const type = stringField(input, "type") ?? event.name;
	if (type === "commandExecution" || event.name === "commandExecution") {
		return "Command";
	}
	if (type === "fileChange" || event.name === "fileChange") {
		return "File changes";
	}
	if (type === "imageView" || event.name === "imageView") return "Image";
	return event.name;
}

export function compactToolSummary(event: ToolEventMessage): string {
	const input = jsonObject(event.input);
	const type = stringField(input, "type") ?? event.name;
	if (type === "commandExecution" || event.name === "commandExecution") {
		return commandSummary(input) ?? "";
	}
	if (type === "fileChange" || event.name === "fileChange") {
		const changes = fileChanges(input);
		if (changes.length === 0) return "";
		return changes.length === 1
			? changes[0].path
			: `${changes[0].path} +${changes.length - 1} more`;
	}
	if (["Edit", "Write", "MultiEdit"].includes(event.name)) {
		return stringField(input, "file_path") ?? "";
	}
	const ignoredKeys = new Set([
		"type",
		"id",
		"status",
		"processId",
		"source",
		"durationMs",
	]);
	const first = inputEntries(event.input).find(
		([key]) => !ignoredKeys.has(key),
	);
	if (first) return `${first[0]}: ${inputPreview(first[1])}`;
	return event.result ? firstLine(event.result) : "";
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
	subagentContained?: boolean;
	pendingPermissions?: ReadonlyArray<PermissionMessage>;
	onDecidePermission?: PermissionDecisionHandler;
	/** Ordinary tools use the shared responsive inspector inside Activity trays. */
	onInspect?: (event: ToolEventMessage, trigger: HTMLElement) => void;
	/** Keep grouped Preview receipts compact while their rich lifecycle card stays pinned. */
	compactSpecialized?: boolean;
	responseSettled?: boolean;
};

type SpecializedToolEventKind =
	| "generated-media"
	| "subagent"
	| "visualization"
	| "project-preview-capture"
	| "project-preview-lifecycle";

function specializedToolEventKind(
	event: ToolEventMessage,
	providerId?: string,
): SpecializedToolEventKind | null {
	if (isGeneratedMediaToolEvent(event)) return "generated-media";
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

export function isActivityInspectorToolEvent(
	event: ToolEventMessage,
	providerId?: string,
	compactSpecialized = false,
): boolean {
	if (isHlidDelegationToolEvent(event) || event.taskActivity) return false;
	const kind = specializedToolEventKind(event, providerId);
	if (kind === null) return true;
	return (
		compactSpecialized &&
		(kind === "project-preview-capture" || kind === "project-preview-lifecycle")
	);
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
	subagentContained,
	pendingPermissions,
	onDecidePermission,
}: ToolBlockProps & { kind: SpecializedToolEventKind }) {
	if (kind === "generated-media") {
		return <GeneratedMediaToolBlock event={event} />;
	}
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
			contained={subagentContained}
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
	resultLabel?: string;
	resultMeta: ToolResultMeta[];
	diffChanges: ToolDiffChange[];
	progressContent?: string;
	progressPreview?: string;
	progressTitle?: string;
	progressTruncated?: boolean;
};

type ToolResultState = {
	isError: boolean;
	hasResult: boolean;
	text: string;
	preview: string | null;
};

type NormalizedToolContent = {
	inputEntries: [string, unknown][];
	isError: boolean;
	hasResult: boolean;
	resultText: string;
	resultLabel?: string;
	resultMeta: ToolResultMeta[];
	diffChanges: ToolDiffChange[];
};

function prettyJsonText(text: string): string {
	if (!text || (text[0] !== "{" && text[0] !== "[")) return text;
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return text;
	}
}

function statusLabel(value: string): string {
	return value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

function mcpResultText(completed: JsonObject): string | null {
	const error = jsonObject(completed.error);
	const errorMessage = stringField(error, "message");
	if (errorMessage) return errorMessage;
	const result = jsonObject(completed.result);
	if (!result) return null;
	const content = Array.isArray(result.content) ? result.content : [];
	const parts = content.flatMap((candidate) => {
		const item = jsonObject(candidate);
		const text = stringField(item, "text");
		if (text !== null) return [text];
		const type = stringField(item, "type");
		if (type === "image" || type === "inputImage") return ["[image result]"];
		if (candidate === null || candidate === undefined) return [];
		return [JSON.stringify(candidate, null, 2) ?? String(candidate)];
	});
	if (parts.length > 0) return parts.join("\n");
	if (
		result.structuredContent !== null &&
		result.structuredContent !== undefined
	) {
		return (
			JSON.stringify(result.structuredContent, null, 2) ??
			String(result.structuredContent)
		);
	}
	return null;
}

function normalizedToolContent(
	event: ToolEventMessage,
	result: ToolResultState,
): NormalizedToolContent {
	const input = jsonObject(event.input);
	const completed = parsedJsonObject(result.text);
	const type =
		stringField(completed, "type") ?? stringField(input, "type") ?? event.name;

	if (type === "commandExecution" || event.name === "commandExecution") {
		const command = commandSummary(completed) ?? commandSummary(input);
		const cwd = stringField(completed, "cwd") ?? stringField(input, "cwd");
		const entries: [string, unknown][] = [];
		if (command) entries.push(["command", command]);
		if (cwd) entries.push(["cwd", cwd]);
		const status = stringField(completed, "status");
		const exitCode = numberField(completed, "exitCode");
		const durationMs = numberField(completed, "durationMs");
		const output = stringField(completed, "aggregatedOutput");
		const failed =
			result.isError ||
			status === "failed" ||
			status === "error" ||
			(exitCode !== null && exitCode !== 0);
		const resultMeta: ToolResultMeta[] = [];
		if (status) resultMeta.push(["status", statusLabel(status)]);
		if (exitCode !== null) resultMeta.push(["exit", String(exitCode)]);
		if (durationMs !== null)
			resultMeta.push(["duration", `${durationMs.toLocaleString()} ms`]);
		return {
			inputEntries: entries.length > 0 ? entries : inputEntries(event.input),
			isError: failed,
			hasResult: result.hasResult,
			resultText: output ?? (completed ? "" : result.text),
			resultLabel: "Output",
			resultMeta,
			diffChanges: [],
		};
	}

	if (type === "fileChange" || event.name === "fileChange") {
		const changes = toolDiffChanges(event, completed);
		const status =
			stringField(completed, "status") ?? stringField(input, "status");
		const paths = changes.map((change) => change.path);
		const entries: [string, unknown][] = paths.length
			? [[paths.length === 1 ? "file" : "files", paths.join("\n")]]
			: inputEntries(event.input);
		return {
			inputEntries: entries,
			isError: result.isError || status === "failed" || status === "error",
			hasResult: result.hasResult || changes.length > 0,
			resultText: "",
			resultLabel: "Changes",
			resultMeta: status ? [["status", statusLabel(status)]] : [],
			diffChanges: changes,
		};
	}

	const mutationChanges = toolDiffChanges(event, completed);
	if (mutationChanges.length > 0) {
		const path = mutationChanges[0].path;
		return {
			inputEntries: [
				["file", path],
				...(event.name === "Edit" && typeof input?.replace_all === "boolean"
					? ([["replace all", input.replace_all]] as [string, unknown][])
					: []),
			],
			isError: result.isError,
			hasResult: result.hasResult || mutationChanges.length > 0,
			resultText: prettyJsonText(result.text),
			resultLabel: "Changes",
			resultMeta: [],
			diffChanges: mutationChanges,
		};
	}

	if (type === "mcpToolCall" && completed) {
		const status = stringField(completed, "status");
		const durationMs = numberField(completed, "durationMs");
		const text = mcpResultText(completed);
		const resultMeta: ToolResultMeta[] = [];
		if (status) resultMeta.push(["status", statusLabel(status)]);
		if (durationMs !== null)
			resultMeta.push(["duration", `${durationMs.toLocaleString()} ms`]);
		return {
			inputEntries: inputEntries(event.input),
			isError:
				result.isError ||
				status === "failed" ||
				status === "error" ||
				(completed.error !== null && completed.error !== undefined),
			hasResult: result.hasResult,
			resultText: text ?? prettyJsonText(result.text),
			resultMeta,
			diffChanges: [],
		};
	}

	return {
		inputEntries: inputEntries(event.input),
		isError: result.isError,
		hasResult: result.hasResult,
		resultText: prettyJsonText(result.text),
		resultMeta: [],
		diffChanges: [],
	};
}

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
	const isReasoning = event.name === "Reasoning";
	const result = toolResultState(event, historical);
	const normalized = normalizedToolContent(event, result);
	const pills = normalized.inputEntries.slice(0, 3);
	const canProcessResult =
		open && (!historical.needsDetail || historical.detail !== null);
	const strippedResult = canProcessResult
		? stripReadLineNumbers(normalized.resultText)
		: "";
	const renderResultAsMarkdown =
		canProcessResult &&
		normalized.hasResult &&
		!normalized.isError &&
		normalized.diffChanges.length === 0 &&
		(isReasoning || looksLikeMarkdown(strippedResult));
	const previewText = normalized.resultText || result.preview;
	const progressContent = event.progress?.content;
	const progressPreview = progressContent
		? lastNonemptyLine(progressContent).slice(0, RESULT_PREVIEW_CHARS)
		: event.progress?.title;

	return {
		inputEntries: normalized.inputEntries,
		pills,
		isReasoning,
		isError: normalized.isError,
		hasResult: normalized.hasResult,
		renderResultAsMarkdown,
		strippedResult,
		resultPreview: previewText
			? firstLine(previewText).slice(0, RESULT_PREVIEW_CHARS)
			: normalized.hasResult
				? ""
				: null,
		...(normalized.resultLabel ? { resultLabel: normalized.resultLabel } : {}),
		resultMeta: normalized.resultMeta,
		diffChanges: normalized.diffChanges,
		...(progressContent ? { progressContent } : {}),
		...(progressPreview ? { progressPreview } : {}),
		...(event.progress?.title ? { progressTitle: event.progress.title } : {}),
		...(event.progress?.contentTruncated ? { progressTruncated: true } : {}),
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
		<>
			{!presentation.hasResult &&
				(presentation.progressContent || presentation.progressTitle) && (
					<PrivacyMask className="mx-3 mb-2 min-w-0 max-w-[calc(100%_-_1.5rem)] border border-primary/15 bg-primary/[0.025] px-3 py-2">
						<div className="text-[8px] tracking-widest text-primary/60 uppercase">
							Running
						</div>
						{presentation.progressTitle && (
							<div className="mt-1 text-[10px] text-muted-foreground/70">
								{presentation.progressTitle}
							</div>
						)}
						{presentation.progressContent && (
							<pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-foreground/75">
								{presentation.progressContent}
							</pre>
						)}
						{presentation.progressTruncated && (
							<div className="mt-1 text-[8px] tracking-wider text-muted-foreground/50 uppercase">
								Latest snapshot truncated
							</div>
						)}
					</PrivacyMask>
				)}
			<ToolBlockExpandedPanel
				inputEntries={presentation.inputEntries}
				hasResult={presentation.hasResult}
				isError={presentation.isError}
				isReasoning={presentation.isReasoning}
				renderResultAsMarkdown={presentation.renderResultAsMarkdown}
				strippedResult={presentation.strippedResult}
				resultLabel={presentation.resultLabel}
				resultMeta={presentation.resultMeta}
				diffChanges={presentation.diffChanges}
			/>
		</>
	);
}

function CompactOrdinaryToolEvent({
	event,
	permissionLabel,
	responseSettled = false,
	onInspect,
}: {
	event: ToolEventMessage;
	permissionLabel?: string;
	responseSettled?: boolean;
	onInspect: (event: ToolEventMessage, trigger: HTMLElement) => void;
}) {
	const label = toolDisplayName(event);
	const summary = compactToolSummary(event);
	const diffOverview = toolDiffOverview(event);
	const completed = parsedJsonObject(event.result ?? "");
	const completedStatus = stringField(completed, "status");
	const failed =
		Boolean(event.isError) ||
		completedStatus === "failed" ||
		completedStatus === "error" ||
		/"status"\s*:\s*"(?:failed|error)"/.test(event.result ?? "");
	const running = !responseSettled && event.result === undefined && !failed;
	const progressSummary = running
		? event.progress?.content
			? lastNonemptyLine(event.progress.content).slice(0, RESULT_PREVIEW_CHARS)
			: event.progress?.title
		: undefined;
	const visibleSummary = progressSummary || summary;
	const status = failed ? "Failed" : running ? "Running" : "Complete";
	return (
		<div className="min-w-0 max-w-full border-b border-border/35 last:border-b-0">
			<button
				type="button"
				data-tool-event-id={event.id}
				onClick={(clickEvent) => onInspect(event, clickEvent.currentTarget)}
				aria-label={`${label}${visibleSummary ? ` ${visibleSummary}` : ""}${diffOverview ? `, ${diffOverviewLabel(diffOverview)}` : ""}, ${status}`}
				className="group flex min-h-8 w-full min-w-0 items-center gap-2 overflow-hidden px-3 py-1.5 text-left transition-colors hover:bg-primary/[0.035] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/55"
			>
				<ChevronRight
					className="h-3 w-3 shrink-0 text-primary/45 group-hover:text-primary/75"
					aria-hidden="true"
				/>
				<PrivacyMask
					inline
					className="max-w-[42%] shrink-0 truncate text-[10px] font-medium tracking-wide text-primary/70 group-hover:text-primary/90 sm:max-w-[34%]"
				>
					{label}
				</PrivacyMask>
				<PrivacyMask
					inline
					className="min-w-0 flex-1 truncate font-mono text-[9px] text-muted-foreground/50"
				>
					{visibleSummary}
				</PrivacyMask>
				{diffOverview && (
					<span
						data-tool-diff-overview
						aria-hidden="true"
						className="flex shrink-0 items-center gap-1.5 font-mono text-[9px] tabular-nums"
					>
						<span className="text-status-success/70">
							+{diffOverview.additions}
						</span>
						<span className="text-destructive/70">
							-{diffOverview.deletions}
						</span>
					</span>
				)}
				<span
					className={`flex shrink-0 items-center gap-1 text-[8px] uppercase tracking-widest ${
						failed
							? "text-destructive/75"
							: running
								? "text-primary/65"
								: "text-status-success/60"
					}`}
				>
					{failed ? (
						<AlertTriangle className="h-2.5 w-2.5" aria-hidden="true" />
					) : running ? (
						<LoaderCircle
							className="h-2.5 w-2.5 animate-spin"
							aria-hidden="true"
						/>
					) : (
						<CheckCircle2 className="h-2.5 w-2.5" aria-hidden="true" />
					)}
					<span className="hidden sm:inline">{status}</span>
				</span>
			</button>
			{permissionLabel && (
				<div className="flex items-center gap-1.5 px-8 pb-1 text-[8px] uppercase tracking-widest text-muted-foreground/50">
					<Check className="h-2.5 w-2.5 text-status-success/55" />
					<span>{permissionLabel}</span>
				</div>
			)}
		</div>
	);
}

/** Responsive ordinary-tool detail surface: side inspector on desktop, sheet on mobile. */
export type ToolInspectorNavigation = {
	position: number;
	total: number;
	onPrevious?: () => void;
	onNext?: () => void;
};

function ToolInspectorDetail({ event }: { event: ToolEventMessage }) {
	const historical = useHistoricalToolEventDetail(event, true);
	const presentation = toolEventPresentation(event, true, historical);
	return (
		<ToolDetailPanel open historical={historical} presentation={presentation} />
	);
}

export function ToolInspector({
	event,
	onClose,
	navigation,
}: {
	event: ToolEventMessage;
	onClose: () => void;
	navigation?: ToolInspectorNavigation;
}) {
	const isDesktop = useIsDesktop();
	const label = toolDisplayName(event);
	const { dialogRef, onDialogKeyDown } = useDialogFocus<HTMLDivElement>(
		onClose,
		!isDesktop,
	);

	useEffect(() => {
		if (isDesktop) return;
		const previous = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = previous;
		};
	}, [isDesktop]);
	useEffect(() => {
		if (!isDesktop) return;
		dialogRef.current?.focus();
		const handleEscape = (keyEvent: globalThis.KeyboardEvent) => {
			if (keyEvent.key !== "Escape") return;
			keyEvent.preventDefault();
			onClose();
		};
		window.addEventListener("keydown", handleEscape);
		return () => window.removeEventListener("keydown", handleEscape);
	}, [dialogRef, isDesktop, onClose]);

	return createPortal(
		// biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled by the dialog focus hook
		// biome-ignore lint/a11y/noStaticElementInteractions: responsive inspector backdrop
		<div
			className={`fixed inset-0 z-[70] flex ${
				isDesktop
					? "pointer-events-none justify-end"
					: "items-end bg-background/70 backdrop-blur-sm"
			}`}
			onClick={isDesktop ? undefined : onClose}
		>
			<div
				ref={dialogRef}
				tabIndex={-1}
				role="dialog"
				aria-modal={isDesktop ? undefined : "true"}
				aria-label={`${label} tool details`}
				onClick={(clickEvent) => clickEvent.stopPropagation()}
				onKeyDown={(keyEvent) => {
					if (!isDesktop) {
						onDialogKeyDown(keyEvent);
						return;
					}
					if (keyEvent.key === "Escape") {
						keyEvent.preventDefault();
						onClose();
					}
				}}
				className={`flex min-h-0 flex-col overflow-hidden border border-border bg-background shadow-2xl focus:outline-none ${
					isDesktop
						? "pointer-events-auto h-full w-[min(42rem,52vw)] border-y-0 border-r-0"
						: "max-h-[82dvh] w-full rounded-t-lg border-b-0"
				}`}
			>
				<div className="flex min-h-12 items-center gap-3 border-b border-border px-4 py-2">
					<div className="min-w-0 flex-1">
						<div className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/55">
							Tool details
						</div>
						<PrivacyMask className="truncate text-[11px] font-medium text-primary/80">
							{label}
						</PrivacyMask>
					</div>
					{navigation && (
						<div className="flex shrink-0 items-center gap-1">
							<button
								type="button"
								onClick={navigation.onPrevious}
								disabled={!navigation.onPrevious}
								aria-label="Previous tool call"
								className="inline-flex h-8 w-8 items-center justify-center text-muted-foreground/55 transition-colors hover:text-foreground disabled:opacity-25 disabled:hover:text-muted-foreground/55"
							>
								<ChevronLeft className="h-4 w-4" aria-hidden="true" />
							</button>
							<span
								aria-live="polite"
								aria-atomic="true"
								className="min-w-10 text-center font-mono text-[9px] tabular-nums text-muted-foreground/55"
							>
								{navigation.position} / {navigation.total}
							</span>
							<button
								type="button"
								onClick={navigation.onNext}
								disabled={!navigation.onNext}
								aria-label="Next tool call"
								className="inline-flex h-8 w-8 items-center justify-center text-muted-foreground/55 transition-colors hover:text-foreground disabled:opacity-25 disabled:hover:text-muted-foreground/55"
							>
								<ChevronRight className="h-4 w-4" aria-hidden="true" />
							</button>
						</div>
					)}
					<button
						type="button"
						onClick={onClose}
						aria-label="Close tool details"
						className="p-2 text-muted-foreground/55 transition-colors hover:text-foreground"
					>
						<X className="h-4 w-4" />
					</button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto py-3 overscroll-contain">
					<ToolInspectorDetail key={event.id} event={event} />
				</div>
			</div>
		</div>,
		document.body,
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
	const label = toolDisplayName(event);
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
					{label}
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
			{!open && !presentation.hasResult && presentation.progressPreview && (
				<div className="flex items-center gap-1.5 pl-8 pr-3 pb-1 text-[10px] font-mono leading-tight text-primary/60">
					<LoaderCircle
						className="h-2.5 w-2.5 shrink-0 animate-spin"
						aria-hidden="true"
					/>
					<span className="truncate">
						<PrivacyMask inline>{presentation.progressPreview}</PrivacyMask>
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
	if (
		props.onInspect &&
		isActivityInspectorToolEvent(
			props.event,
			props.providerId,
			props.compactSpecialized,
		)
	) {
		return (
			<CompactOrdinaryToolEvent
				event={props.event}
				permissionLabel={props.permissionLabel}
				responseSettled={props.responseSettled}
				onInspect={props.onInspect}
			/>
		);
	}
	if (kind) {
		return <SpecializedToolEvent {...props} kind={kind} />;
	}
	return (
		<ExpandableToolEventBlock
			event={props.event}
			permissionLabel={props.permissionLabel}
			sessionId={props.sessionId}
		/>
	);
});
