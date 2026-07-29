import {
	AlertTriangle,
	Camera,
	Check,
	ChevronRight,
	Eye,
	LoaderCircle,
	Monitor,
	MousePointer2,
	RotateCcw,
	Square,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ImageViewerModal } from "#/components/ImageViewerModal";
import {
	requestProjectPreviewPresentation,
	useProjectPreview,
	useProjectPreviewUnavailable,
} from "#/hooks/projectPreviewStore";
import { loadToolEventDetail } from "#/hooks/toolEventDetailStore";
import {
	type ProjectPreviewAction,
	useProjectPreviewActions,
} from "#/hooks/useProjectPreviewActions";
import {
	getProjectPreviewAgentFrameFn,
	type ProjectPreviewAgentFrame,
	type ProjectPreviewSnapshot,
} from "#/lib/serverFns/projectPreviews";
import type { ToolEventMessage } from "#/server/protocol";

type ProjectPreviewCaptureMetadata = {
	preview_id: string;
	session_id?: string;
	path: string;
	viewport: "desktop" | "tablet" | "mobile";
	width: number;
	height: number;
	full_page: boolean;
	size_bytes: number;
	frame_id?: string;
	last_action?: string;
};

function parseProjectPreviewToolJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		// Claude's rich MCP tool result is persisted as its text block followed
		// by one marker for each image block. The image itself is retained by the
		// Preview browser, so remove only that exact transport suffix before
		// parsing the capture provenance.
		const withoutImageSuffix = value
			.replace(/(?:\s*\[image\]\s*)+$/, "")
			.trimEnd();
		if (withoutImageSuffix === value) throw new Error("Invalid tool result.");
		return JSON.parse(withoutImageSuffix);
	}
}

function captureMetadataFromValue(
	value: unknown,
	depth = 0,
): ProjectPreviewCaptureMetadata | null {
	if (depth > 2) return null;
	if (typeof value === "string") {
		try {
			return captureMetadataFromValue(
				parseProjectPreviewToolJson(value),
				depth + 1,
			);
		} catch {
			return null;
		}
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (
		typeof record.preview_id === "string" &&
		typeof record.width === "number" &&
		typeof record.height === "number"
	) {
		return value as ProjectPreviewCaptureMetadata;
	}
	for (const key of ["contentItems", "content"]) {
		const items = record[key];
		if (!Array.isArray(items)) continue;
		for (const item of items) {
			if (!item || typeof item !== "object" || Array.isArray(item)) continue;
			const metadata = captureMetadataFromValue(
				(item as Record<string, unknown>).text,
				depth + 1,
			);
			if (metadata) return metadata;
		}
	}
	return captureMetadataFromValue(record.result, depth + 1);
}

function captureMetadataFromResult(
	result: string | null | undefined,
): ProjectPreviewCaptureMetadata | null {
	if (!result) return null;
	try {
		return captureMetadataFromValue(parseProjectPreviewToolJson(result));
	} catch {
		return null;
	}
}

function captureMetadata(
	event: ToolEventMessage,
): ProjectPreviewCaptureMetadata | null {
	return captureMetadataFromResult(event.result);
}

function isCaptureActivity(event: ToolEventMessage): boolean {
	return (
		event.name.endsWith("capture_project_preview") ||
		event.name.endsWith("control_project_preview")
	);
}

function ProjectPreviewCaptureOpener({
	capture,
	event,
	className,
	children,
}: {
	capture: ProjectPreviewCaptureMetadata | null;
	event: ToolEventMessage;
	className: string;
	children: ReactNode;
}) {
	const [frame, setFrame] = useState<ProjectPreviewAgentFrame | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const canHydrateCapture = Boolean(
		!event.isError &&
			isCaptureActivity(event) &&
			event.resultTruncated &&
			event.detailSessionId,
	);
	const canOpen =
		Boolean(capture?.frame_id && capture.session_id && capture.preview_id) ||
		canHydrateCapture;

	const open = async () => {
		if (!canOpen) return;
		setLoading(true);
		setError(null);
		try {
			let resolvedCapture = capture;
			if (
				(!resolvedCapture?.frame_id ||
					!resolvedCapture.session_id ||
					!resolvedCapture.preview_id) &&
				event.resultTruncated &&
				event.detailSessionId
			) {
				const detail = await loadToolEventDetail(
					event.detailSessionId,
					event.id,
				);
				resolvedCapture = captureMetadataFromResult(detail.result);
			}
			if (
				!resolvedCapture?.frame_id ||
				!resolvedCapture.session_id ||
				!resolvedCapture.preview_id
			) {
				throw new Error("This Preview action has no retained capture.");
			}
			const result = await getProjectPreviewAgentFrameFn({
				data: {
					sessionId: resolvedCapture.session_id,
					previewId: resolvedCapture.preview_id,
					frameId: resolvedCapture.frame_id,
				},
			});
			if (!result) {
				throw new Error("This Preview capture is no longer available.");
			}
			setFrame(result);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoading(false);
		}
	};

	return (
		<>
			{canOpen ? (
				<button
					type="button"
					onClick={() => void open()}
					disabled={loading}
					className={`${className} disabled:cursor-wait`}
					aria-label={
						capture?.path
							? `View Preview capture at ${capture.path}`
							: "View Preview capture"
					}
				>
					{children}
					<Eye
						className="h-3 w-3 shrink-0 text-primary/55"
						aria-hidden
						data-testid="preview-capture-open-indicator"
					/>
					{loading && (
						<LoaderCircle className="h-3 w-3 shrink-0 animate-spin" />
					)}
				</button>
			) : (
				<div className={className}>{children}</div>
			)}
			{error && (
				<div className="px-3 pb-2 text-[10px] text-destructive">{error}</div>
			)}
			{frame &&
				createPortal(
					<ImageViewerModal
						src={`data:${frame.mime};base64,${frame.image_base64}`}
						alt={`Preview capture at ${frame.path}`}
						onClose={() => setFrame(null)}
					/>,
					document.body,
				)}
		</>
	);
}

function ExpandablePreviewError({
	message,
	label = "Preview error",
}: {
	message: string;
	label?: string;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div className="border-t border-destructive/20 text-[10px] text-destructive">
			<button
				type="button"
				onClick={() => setOpen((current) => !current)}
				aria-expanded={open}
				className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left"
			>
				<ChevronRight
					className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
				/>
				<span className="min-w-0 flex-1 truncate">{message}</span>
				<span className="shrink-0 text-[8px] uppercase tracking-widest opacity-60">
					{label}
				</span>
			</button>
			{open && (
				<pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words border-t border-destructive/15 px-3 py-2 font-mono text-[10px] leading-4">
					{message}
				</pre>
			)}
		</div>
	);
}

export function ProjectPreviewCaptureToolBlock({
	event,
	permissionLabel,
}: {
	event: ToolEventMessage;
	permissionLabel?: string;
}) {
	const capture = captureMetadata(event);
	const isControl = event.name.endsWith("control_project_preview");
	const failed = Boolean(event.isError);
	const pending = !event.result && !failed;
	const complete = !pending && !failed;
	const content = (
		<>
			{pending ? (
				<LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-primary/70" />
			) : failed ? (
				<AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
			) : isControl ? (
				<MousePointer2 className="h-3.5 w-3.5 shrink-0 text-primary/70" />
			) : (
				<Camera className="h-3.5 w-3.5 shrink-0 text-primary/70" />
			)}
			<div className="min-w-0 flex-1">
				<div className="truncate text-[11px] tracking-wide text-foreground/80">
					{pending
						? isControl
							? "Controlling Project Preview"
							: "Capturing Project Preview"
						: failed
							? isControl
								? "Project Preview control failed"
								: "Project Preview capture failed"
							: isControl
								? "Project Preview controlled by agent"
								: "Project Preview captured for agent"}
				</div>
				<div className="truncate text-[9px] uppercase tracking-widest text-muted-foreground">
					{capture
						? `${capture.last_action ? `${capture.last_action} · ` : ""}${capture.viewport} · ${capture.width}×${capture.height}${capture.full_page ? " · full page" : ""} · ${capture.path}`
						: pending
							? isControl
								? "acting"
								: "rendering"
							: failed
								? "failed"
								: "Open captured frame"}
				</div>
			</div>
			{complete && (
				<Check
					className="h-3.5 w-3.5 shrink-0 text-status-success"
					aria-hidden
				/>
			)}
		</>
	);
	return (
		<div className="my-1 mx-3 border border-border/50 bg-muted/10">
			<ProjectPreviewCaptureOpener
				capture={capture}
				event={event}
				className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left"
			>
				{content}
			</ProjectPreviewCaptureOpener>
			{permissionLabel && (
				<div className="border-t border-border/30 px-3 py-1 text-[9px] uppercase tracking-widest text-muted-foreground/50">
					{permissionLabel}
				</div>
			)}
			{failed && event.result && (
				<ExpandablePreviewError message={event.result} />
			)}
		</div>
	);
}

function resultSnapshot(
	event: ToolEventMessage,
): ProjectPreviewSnapshot | null {
	if (!event.result) return null;
	try {
		const value = JSON.parse(event.result) as ProjectPreviewSnapshot;
		return value?.session_id && value?.id ? value : null;
	} catch {
		return null;
	}
}

export function isProjectPreviewToolEvent(event: ToolEventMessage): boolean {
	return [
		"start_project_preview",
		"inspect_project_preview",
		"capture_project_preview",
		"control_project_preview",
		"stop_project_preview",
	].some((name) => event.name.endsWith(name));
}

function projectPreviewEventId(event: ToolEventMessage): string | null {
	return (
		resultSnapshot(event)?.id ?? captureMetadata(event)?.preview_id ?? null
	);
}

function isActivePreviewState(state: ProjectPreviewSnapshot["state"]): boolean {
	return state === "starting" || state === "ready";
}

function findLastProjectPreviewEventIndex(
	events: ToolEventMessage[],
	matches: (event: ToolEventMessage) => boolean,
): number {
	for (let index = events.length - 1; index >= 0; index--) {
		const event = events[index];
		if (event && matches(event)) return index;
	}
	return -1;
}

export function selectActiveProjectPreviewEvents(
	events: ToolEventMessage[],
	livePreview: ProjectPreviewSnapshot | null,
	sessionActive: boolean,
): ToolEventMessage[] {
	const latestStartIndex = findLastProjectPreviewEventIndex(events, (event) =>
		event.name.endsWith("start_project_preview"),
	);
	if (latestStartIndex >= 0) {
		const latestStart = events[latestStartIndex];
		const latestSnapshot = latestStart ? resultSnapshot(latestStart) : null;
		if (livePreview && latestSnapshot?.id === livePreview.id) {
			return isActivePreviewState(livePreview.state)
				? events.slice(latestStartIndex)
				: [];
		}
		if (
			!livePreview &&
			latestSnapshot &&
			isActivePreviewState(latestSnapshot.state)
		) {
			return events.slice(latestStartIndex);
		}
		if (
			latestStart &&
			!latestStart.result &&
			!latestStart.isError &&
			sessionActive
		) {
			return events.slice(latestStartIndex);
		}
	}
	if (!livePreview || !isActivePreviewState(livePreview.state)) return [];
	const matchingStartIndex = findLastProjectPreviewEventIndex(
		events,
		(event) =>
			event.name.endsWith("start_project_preview") &&
			projectPreviewEventId(event) === livePreview.id,
	);
	const firstMatchingIndex = events.findIndex(
		(event) => projectPreviewEventId(event) === livePreview.id,
	);
	const lifecycleStart =
		matchingStartIndex >= 0 ? matchingStartIndex : firstMatchingIndex;
	if (lifecycleStart >= 0) return events.slice(lifecycleStart);
	// Raven can restart a stopped Preview directly. That creates a fresh live
	// Preview ID without fabricating a second agent tool call, so keep the most
	// recent transcript lifecycle attached to the pinned live card.
	return latestStartIndex >= 0 ? events.slice(latestStartIndex) : [];
}

export function groupProjectPreviewEventLifecycles(
	events: ToolEventMessage[],
): ToolEventMessage[][] {
	const groups: ToolEventMessage[][] = [];
	let current: ToolEventMessage[] = [];
	for (const event of events) {
		if (event.name.endsWith("start_project_preview") && current.length > 0) {
			groups.push(current);
			current = [];
		}
		current.push(event);
	}
	if (current.length > 0) groups.push(current);
	return groups;
}

function previewActivityLabel(event: ToolEventMessage): string {
	if (event.name.endsWith("start_project_preview")) return "Start";
	if (event.name.endsWith("inspect_project_preview")) return "Inspect";
	if (event.name.endsWith("capture_project_preview")) return "Capture";
	if (event.name.endsWith("control_project_preview")) return "Control";
	if (event.name.endsWith("stop_project_preview")) return "Stop";
	return "Preview";
}

function ProjectPreviewActivityEvent({
	event,
	permissionLabel,
}: {
	event: ToolEventMessage;
	permissionLabel?: string;
}) {
	const capture = captureMetadata(event);
	const pending = !event.result && !event.isError;
	const [errorOpen, setErrorOpen] = useState(false);
	const [fullError, setFullError] = useState<string | null>(null);
	const [detailLoading, setDetailLoading] = useState(false);
	const [detailError, setDetailError] = useState<string | null>(null);

	const toggleError = () => {
		const next = !errorOpen;
		setErrorOpen(next);
		if (
			!next ||
			!event.resultTruncated ||
			!event.detailSessionId ||
			fullError ||
			detailLoading
		) {
			return;
		}
		setDetailLoading(true);
		setDetailError(null);
		void loadToolEventDetail(event.detailSessionId, event.id)
			.then((detail) => setFullError(detail.result ?? event.result ?? ""))
			.catch((cause) =>
				setDetailError(cause instanceof Error ? cause.message : String(cause)),
			)
			.finally(() => setDetailLoading(false));
	};

	const summary = capture
		? `${capture.viewport} · ${capture.width}×${capture.height} · ${capture.path}`
		: event.isError
			? event.result || "Preview action failed."
			: pending
				? "running"
				: isCaptureActivity(event) && event.resultTruncated
					? "Open captured frame"
					: "complete";
	const row = (
		<>
			{pending ? (
				<LoaderCircle className="h-3 w-3 shrink-0 animate-spin text-primary/60" />
			) : event.isError ? (
				<AlertTriangle className="h-3 w-3 shrink-0 text-destructive" />
			) : (
				<Check className="h-3 w-3 shrink-0 text-status-success/70" />
			)}
			<span className="shrink-0 uppercase tracking-widest text-primary/60">
				{previewActivityLabel(event)}
			</span>
			<span className="min-w-0 flex-1 truncate text-muted-foreground/55">
				{summary}
			</span>
			{permissionLabel && (
				<span className="shrink-0 text-[8px] uppercase tracking-widest text-muted-foreground/40">
					{permissionLabel}
				</span>
			)}
		</>
	);

	if (event.isError) {
		return (
			<div>
				<button
					type="button"
					onClick={toggleError}
					aria-expanded={errorOpen}
					aria-label={`${previewActivityLabel(event)} error details`}
					className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-[10px]"
				>
					<ChevronRight
						className={`h-3 w-3 shrink-0 text-destructive/70 transition-transform ${errorOpen ? "rotate-90" : ""}`}
					/>
					{row}
				</button>
				{errorOpen && (
					<pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words border-t border-destructive/15 px-3 py-2 font-mono text-[10px] leading-4 text-destructive">
						{detailLoading
							? "Loading full error…"
							: detailError
								? detailError
								: fullError || event.result || "Preview action failed."}
					</pre>
				)}
			</div>
		);
	}

	return (
		<ProjectPreviewCaptureOpener
			capture={capture}
			event={event}
			className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-[10px]"
		>
			{row}
		</ProjectPreviewCaptureOpener>
	);
}

const projectPreviewOpenOverrides = new Map<string, boolean>();

function ProjectPreviewInlineActions({
	sessionId,
	pendingAction,
	runAction,
}: {
	sessionId: string;
	pendingAction: ProjectPreviewAction | null;
	runAction: (action: ProjectPreviewAction) => Promise<void>;
}) {
	return (
		<>
			<button
				type="button"
				onClick={() => requestProjectPreviewPresentation(sessionId)}
				className="p-1.5 text-muted-foreground/60 hover:text-primary"
				title="Show preview"
				aria-label="Show preview"
			>
				<Eye className="h-3.5 w-3.5" />
			</button>
			<button
				type="button"
				onClick={() => void runAction("restart")}
				disabled={pendingAction !== null}
				className="p-1.5 text-muted-foreground/60 hover:text-primary disabled:opacity-30"
				title="Restart preview"
				aria-label="Restart preview"
			>
				{pendingAction === "restart" ? (
					<LoaderCircle className="h-3.5 w-3.5 animate-spin" />
				) : (
					<RotateCcw className="h-3.5 w-3.5" />
				)}
			</button>
			<button
				type="button"
				onClick={() => void runAction("stop")}
				disabled={pendingAction !== null}
				className="p-1.5 text-muted-foreground/60 hover:text-destructive disabled:opacity-30"
				title="Stop preview"
				aria-label="Stop preview"
			>
				{pendingAction === "stop" ? (
					<LoaderCircle className="h-3.5 w-3.5 animate-spin" />
				) : (
					<Square className="h-3.5 w-3.5" />
				)}
			</button>
		</>
	);
}

export function ProjectPreviewActivityCard({
	events,
	permissionLabels,
	active = false,
	sessionId: explicitSessionId,
	historicalGroup = false,
}: {
	events: ToolEventMessage[];
	permissionLabels?: Map<string, string>;
	active?: boolean;
	sessionId?: string;
	historicalGroup?: boolean;
}) {
	const historical = events
		.map(resultSnapshot)
		.filter((value): value is ProjectPreviewSnapshot => value !== null)
		.at(-1);
	const sessionId =
		explicitSessionId ??
		historical?.session_id ??
		events.find((event) => event.detailSessionId)?.detailSessionId ??
		"";
	const live = useProjectPreview(sessionId);
	const unavailable = useProjectPreviewUnavailable(sessionId);
	const eventPreviewId =
		historical?.id ??
		events
			.map(captureMetadata)
			.find((value): value is ProjectPreviewCaptureMetadata => value !== null)
			?.preview_id;
	const matchingLive = !historicalGroup
		? live
		: eventPreviewId && live?.id === eventPreviewId
			? live
			: null;
	const resolvedPreview =
		matchingLive ??
		(unavailable && historical
			? {
					...historical,
					state: "stopped" as const,
				}
			: historical);
	const preview =
		historicalGroup && resolvedPreview
			? {
					...resolvedPreview,
					state:
						resolvedPreview.state === "failed"
							? ("failed" as const)
							: ("stopped" as const),
				}
			: resolvedPreview;
	const previewId = preview?.id ?? eventPreviewId ?? "";
	const ready = preview?.state === "ready";
	const stateKey = `${sessionId}:${previewId}`;
	const [openOverride, setOpenOverride] = useState<boolean | null>(
		() => projectPreviewOpenOverrides.get(stateKey) ?? null,
	);
	const open = openOverride ?? Boolean(active || ready);
	const [activityOpen, setActivityOpen] = useState(false);
	const {
		error,
		pendingAction: pending,
		runAction: act,
	} = useProjectPreviewActions(preview);

	useEffect(() => {
		setOpenOverride(projectPreviewOpenOverrides.get(stateKey) ?? null);
	}, [stateKey]);

	const toggleOpen = () => {
		const next = !open;
		projectPreviewOpenOverrides.set(stateKey, next);
		setOpenOverride(next);
	};

	const state =
		preview?.state ??
		(events.some((event) => event.isError)
			? "failed"
			: historicalGroup
				? "stopped"
				: "starting");
	const statusTone =
		state === "ready"
			? "text-status-success/70"
			: state === "failed"
				? "text-destructive/75"
				: "text-primary/60";
	const captureCount = events.filter((event) => {
		if (event.isError || !isCaptureActivity(event)) return false;
		return Boolean(
			captureMetadata(event)?.frame_id ||
				(event.resultTruncated && event.detailSessionId),
		);
	}).length;
	const errorCount = events.filter((event) => event.isError).length;

	return (
		<div className="my-0.5 min-w-0 max-w-full overflow-hidden">
			<div className="flex min-h-11 min-w-0 items-center gap-2 px-3 py-2">
				<button
					type="button"
					onClick={toggleOpen}
					aria-expanded={open}
					aria-label={`${preview?.label ?? "Project Preview"} ${state}`}
					className="flex min-w-0 flex-1 items-center gap-2 text-left transition-colors hover:text-primary"
				>
					<ChevronRight
						className={`h-3 w-3 shrink-0 text-primary/50 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
					/>
					{state === "starting" ? (
						<LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-primary/60" />
					) : state === "failed" ? (
						<AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
					) : (
						<Monitor className="h-3.5 w-3.5 shrink-0 text-primary/60" />
					)}
					<span className="min-w-0 shrink truncate text-[11px] font-medium tracking-wider text-primary/75">
						{preview?.label ?? "Project Preview"}
					</span>
					<span
						className={`shrink-0 text-[9px] font-medium uppercase tracking-widest ${statusTone}`}
					>
						{state}
						{preview?.port ? ` · :${preview.port}` : ""}
					</span>
					<span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground/55">
						{events.length} {events.length === 1 ? "action" : "actions"}
						{captureCount > 0
							? ` · ${captureCount} ${captureCount === 1 ? "capture" : "captures"}`
							: ""}
					</span>
				</button>
				{preview && state !== "stopped" && (
					<ProjectPreviewInlineActions
						sessionId={preview.session_id}
						pendingAction={pending}
						runAction={act}
					/>
				)}
			</div>
			{open && (
				<div className="mx-3 mb-2 overflow-hidden border border-[var(--tool-panel-border)] bg-[var(--tool-panel)]">
					<button
						type="button"
						onClick={() => setActivityOpen((current) => !current)}
						aria-expanded={activityOpen}
						aria-label="Preview activity"
						className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-[10px] uppercase tracking-widest text-muted-foreground/65"
					>
						<ChevronRight
							className={`h-3 w-3 shrink-0 text-primary/50 transition-transform ${activityOpen ? "rotate-90" : ""}`}
						/>
						<span>Activity</span>
						<span className="min-w-0 flex-1 truncate opacity-65">
							{events.length} {events.length === 1 ? "event" : "events"}
							{errorCount > 0 ? ` · ${errorCount} failed` : ""}
						</span>
					</button>
					{activityOpen && (
						<div className="divide-y divide-border/25 border-t border-border/25">
							{events.map((event) => (
								<ProjectPreviewActivityEvent
									key={event.id}
									event={event}
									permissionLabel={permissionLabels?.get(event.id)}
								/>
							))}
						</div>
					)}
					{(error || preview?.error) && (
						<ExpandablePreviewError message={error ?? preview?.error ?? ""} />
					)}
				</div>
			)}
		</div>
	);
}

export function ProjectPreviewToolBlock({
	event,
	permissionLabel,
}: {
	event: ToolEventMessage;
	permissionLabel?: string;
}) {
	const historical = resultSnapshot(event);
	const sessionId = historical?.session_id ?? event.detailSessionId ?? "";
	const live = useProjectPreview(sessionId);
	const unavailable = useProjectPreviewUnavailable(sessionId);
	const preview =
		(live?.id === historical?.id ? live : null) ??
		(unavailable && historical
			? {
					...historical,
					state: "stopped" as const,
					error: "This preview is no longer running.",
				}
			: historical);
	const {
		error,
		pendingAction: pending,
		runAction: act,
	} = useProjectPreviewActions(preview);
	const isStart = event.name.endsWith("start_project_preview");

	const state = preview?.state ?? (event.isError ? "failed" : "starting");
	const statusTone =
		state === "ready"
			? "text-status-success"
			: state === "failed"
				? "text-destructive"
				: "text-muted-foreground";
	return (
		<div className="my-1 mx-3 border border-border/50 bg-muted/10">
			<div className="flex min-w-0 items-center gap-2 px-3 py-2">
				{state === "starting" ? (
					<LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-primary/70" />
				) : state === "failed" ? (
					<AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
				) : (
					<Monitor className="h-3.5 w-3.5 shrink-0 text-primary/70" />
				)}
				<div className="min-w-0 flex-1">
					<div className="truncate text-[11px] tracking-wide text-foreground/80">
						{preview?.label ??
							(isStart ? "Starting Project Preview" : "Project Preview")}
					</div>
					<div
						className={`truncate text-[9px] uppercase tracking-widest ${statusTone}`}
					>
						{state}
						{preview?.port ? ` · :${preview.port}` : ""}
					</div>
				</div>
				{preview && state !== "stopped" && (
					<ProjectPreviewInlineActions
						sessionId={preview.session_id}
						pendingAction={pending}
						runAction={act}
					/>
				)}
			</div>
			{permissionLabel && (
				<div className="border-t border-border/30 px-3 py-1 text-[9px] uppercase tracking-widest text-muted-foreground/50">
					{permissionLabel}
				</div>
			)}
			{(error || preview?.error || (event.isError && event.result)) && (
				<ExpandablePreviewError
					message={error ?? preview?.error ?? event.result ?? ""}
				/>
			)}
		</div>
	);
}
