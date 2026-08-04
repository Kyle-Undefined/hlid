import {
	Check,
	ChevronRight,
	Maximize2,
	Minimize2,
	Minus,
	Plus,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PrivacyMask } from "#/components/PrivacyMask";
import { useDialogFocus } from "#/hooks/useDialogFocus";
import { isHlidVisualizationToolName } from "#/lib/toolEventPaging";
import type { ToolEventMessage } from "#/server/protocol";

const ATTACHMENT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const VISUALIZATION_FILENAME_RE =
	/^[a-z0-9](?:[a-z0-9-]{0,197}[a-z0-9])?\.html$/;
const MAX_TITLE_CHARS = 250;
export const VISUALIZATION_OFFSCREEN_GRACE_MS = 60_000;
const MIN_VISUALIZATION_ZOOM = 0.5;
const MAX_VISUALIZATION_ZOOM = 1.5;
const VISUALIZATION_ZOOM_STEP = 0.1;

export type HlidVisualizationResult = {
	type: "hlid_visualization";
	attachment_id: string;
	filename: string;
	title: string;
};

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Parse only Hlid's compact, attachment-backed visualization handoff. */
export function parseHlidVisualizationResult(
	result: string | null | undefined,
): HlidVisualizationResult | null {
	if (!result) return null;
	let value: unknown;
	try {
		value = JSON.parse(result);
	} catch {
		return null;
	}
	const parsed = record(value);
	if (parsed?.type !== "hlid_visualization") return null;
	const attachmentId = parsed.attachment_id;
	const filename = parsed.filename;
	const title = parsed.title;
	if (
		typeof attachmentId !== "string" ||
		!ATTACHMENT_ID_RE.test(attachmentId) ||
		typeof filename !== "string" ||
		!VISUALIZATION_FILENAME_RE.test(filename) ||
		typeof title !== "string"
	) {
		return null;
	}
	const normalizedTitle = title.trim();
	if (!normalizedTitle || normalizedTitle.length > MAX_TITLE_CHARS) return null;
	return {
		type: "hlid_visualization",
		attachment_id: attachmentId,
		filename,
		title: normalizedTitle,
	};
}

export function isHlidVisualizationToolEvent(event: ToolEventMessage): boolean {
	return isHlidVisualizationToolName(event.name);
}

function boundedVisualizationZoom(zoom: number): number {
	return Math.min(
		MAX_VISUALIZATION_ZOOM,
		Math.max(MIN_VISUALIZATION_ZOOM, Math.round(zoom * 10) / 10),
	);
}

function VisualizationZoomControls({
	zoom,
	onChange,
}: {
	zoom: number;
	onChange: (zoom: number) => void;
}) {
	return (
		<fieldset className="flex shrink-0 items-center gap-0.5 border-0 p-0">
			<legend className="sr-only">Visualization zoom</legend>
			<button
				type="button"
				onClick={() =>
					onChange(boundedVisualizationZoom(zoom - VISUALIZATION_ZOOM_STEP))
				}
				disabled={zoom <= MIN_VISUALIZATION_ZOOM}
				aria-label="Zoom visualization out"
				title="Zoom out"
				className="p-1.5 text-muted-foreground/55 hover:text-foreground disabled:opacity-25"
			>
				<Minus className="h-3.5 w-3.5" />
			</button>
			<button
				type="button"
				onClick={() => onChange(1)}
				aria-label="Reset visualization zoom"
				title="Reset zoom"
				className="w-8 py-1 text-center font-mono text-[8px] text-muted-foreground/55 hover:text-foreground"
			>
				<span aria-live="polite">{Math.round(zoom * 100)}%</span>
			</button>
			<button
				type="button"
				onClick={() =>
					onChange(boundedVisualizationZoom(zoom + VISUALIZATION_ZOOM_STEP))
				}
				disabled={zoom >= MAX_VISUALIZATION_ZOOM}
				aria-label="Zoom visualization in"
				title="Zoom in"
				className="p-1.5 text-muted-foreground/55 hover:text-foreground disabled:opacity-25"
			>
				<Plus className="h-3.5 w-3.5" />
			</button>
		</fieldset>
	);
}

function postVisualizationZoom(
	frame: HTMLIFrameElement | null,
	zoom: number,
): void {
	frame?.contentWindow?.postMessage(
		{ type: "hlid:visualization-zoom", version: 1, zoom },
		"*",
	);
}

function VisualizationFrame({
	rawUrl,
	title,
	zoom,
	className,
}: {
	rawUrl: string;
	title: string;
	zoom: number;
	className: string;
}) {
	const frameRef = useRef<HTMLIFrameElement>(null);
	useEffect(() => postVisualizationZoom(frameRef.current, zoom), [zoom]);
	return (
		<div
			data-testid="visualization-viewport"
			className={`relative overflow-hidden bg-transparent ${className}`}
		>
			<iframe
				ref={frameRef}
				src={rawUrl}
				title={title}
				sandbox="allow-scripts"
				referrerPolicy="no-referrer"
				loading="lazy"
				scrolling="yes"
				onLoad={(event) => postVisualizationZoom(event.currentTarget, zoom)}
				style={{
					touchAction: "pan-x pan-y pinch-zoom",
				}}
				className="absolute inset-0 block h-full w-full overscroll-auto border-0 bg-transparent [-webkit-overflow-scrolling:touch]"
			/>
		</div>
	);
}

export function HlidVisualizationToolBlock({
	event,
	permissionLabel,
	sessionId,
	expanded = false,
	onToggle,
	onInactive,
}: {
	event: ToolEventMessage;
	permissionLabel?: string;
	sessionId?: string;
	expanded?: boolean;
	onToggle?: () => void;
	onInactive?: () => void;
}) {
	const [zoom, setZoom] = useState(1);
	const [maximized, setMaximized] = useState(false);
	const {
		dialogRef: containerRef,
		onBackdropClick,
		onDialogKeyDown,
	} = useDialogFocus<HTMLDivElement>(
		() => setMaximized(false),
		maximized,
		"dialog",
	);
	useEffect(() => {
		if (!expanded) setMaximized(false);
	}, [expanded]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: useDialogFocus returns a stable ref; maximized rebinds the observer after the surface changes
	useEffect(() => {
		const container = containerRef.current;
		if (!expanded || maximized || !container || !onInactive) return;

		let offscreenTimer: ReturnType<typeof setTimeout> | null = null;
		let intersectsViewport = true;
		const clearOffscreenTimer = () => {
			if (offscreenTimer === null) return;
			clearTimeout(offscreenTimer);
			offscreenTimer = null;
		};
		const scheduleOffscreenCollapse = () => {
			if (offscreenTimer !== null) return;
			offscreenTimer = setTimeout(onInactive, VISUALIZATION_OFFSCREEN_GRACE_MS);
		};

		const observer =
			typeof IntersectionObserver === "undefined"
				? null
				: new IntersectionObserver((entries) => {
						const entry = entries[0];
						if (!entry) return;
						intersectsViewport = entry.isIntersecting;
						if (intersectsViewport) clearOffscreenTimer();
						else scheduleOffscreenCollapse();
					});
		observer?.observe(container);

		const handleDocumentVisibility = () => {
			if (document.visibilityState === "hidden") {
				scheduleOffscreenCollapse();
			} else if (intersectsViewport) {
				clearOffscreenTimer();
			}
		};
		document.addEventListener("visibilitychange", handleDocumentVisibility);

		return () => {
			observer?.disconnect();
			document.removeEventListener(
				"visibilitychange",
				handleDocumentVisibility,
			);
			clearOffscreenTimer();
		};
	}, [expanded, maximized, onInactive]);

	const visualization = parseHlidVisualizationResult(event.result);
	if (event.isError || !visualization || !sessionId) {
		const progress = event.subagent?.currentStep?.trim();
		return (
			<div className="my-2 min-w-0 max-w-full border border-border/50 bg-muted/5 px-3 py-3 text-[10px] tracking-wide text-muted-foreground/65">
				{event.isError
					? "Visualization failed"
					: event.result === undefined
						? progress || "Creating visualization…"
						: "Visualization unavailable"}
			</div>
		);
	}
	const rawUrl = [
		`/api/attachments/${encodeURIComponent(visualization.attachment_id)}/raw`,
		`visualization_session_id=${encodeURIComponent(sessionId)}`,
	].join("?");

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: keyboard handling is only active when this same element becomes the maximized dialog
		// biome-ignore lint/a11y/useAriaPropsSupportedByRole: role and aria-modal are enabled together while maximized
		<div
			ref={containerRef}
			tabIndex={maximized ? -1 : undefined}
			role={maximized ? "dialog" : undefined}
			aria-modal={maximized ? "true" : undefined}
			aria-label={
				maximized ? `Visualization viewer: ${visualization.title}` : undefined
			}
			onKeyDown={maximized ? onDialogKeyDown : undefined}
			onClick={maximized ? onBackdropClick : undefined}
			className={
				maximized
					? "fixed inset-0 z-50 flex min-h-0 flex-col bg-background/90 p-2 backdrop-blur-sm focus:outline-none md:p-4"
					: "my-2 min-w-0 max-w-full overflow-hidden border border-border/50 bg-muted/5"
			}
		>
			<PrivacyMask className={maximized ? "flex min-h-0 flex-1" : undefined}>
				<figure
					data-hlid-visualization={visualization.attachment_id}
					data-visualization-filename={visualization.filename}
					className={
						maximized
							? "flex min-h-0 flex-1 flex-col overflow-hidden border border-border bg-card shadow-2xl"
							: undefined
					}
				>
					<figcaption className="flex min-w-0 shrink-0 items-center border-b border-border/40">
						<button
							type="button"
							onClick={onToggle}
							aria-expanded={expanded}
							aria-controls={`visualization-${visualization.attachment_id}`}
							aria-label={`${expanded ? "Collapse" : "Expand"} visualization: ${visualization.title}`}
							className="group flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-[10px] font-medium tracking-wide text-foreground/75 transition-colors hover:bg-primary/[0.03]"
							title={
								expanded ? "Collapse visualization" : "Expand visualization"
							}
						>
							<ChevronRight
								className={`h-3 w-3 shrink-0 text-primary/50 transition-transform duration-150 group-hover:text-primary/80 ${expanded ? "rotate-90" : ""}`}
								aria-hidden="true"
							/>
							<span className="min-w-0 flex-1 truncate">
								{visualization.title}
							</span>
							{!expanded && (
								<span className="shrink-0 text-[8px] tracking-widest text-muted-foreground/45 uppercase">
									Ready
								</span>
							)}
						</button>
						{expanded && (
							<div className="flex shrink-0 items-center border-l border-border/40 px-0.5">
								<VisualizationZoomControls zoom={zoom} onChange={setZoom} />
								<button
									type="button"
									onClick={() => setMaximized((current) => !current)}
									aria-label={
										maximized
											? "Restore inline visualization"
											: "Maximize visualization"
									}
									title={maximized ? "Restore inline" : "Maximize"}
									className="p-1.5 text-muted-foreground/55 hover:text-foreground"
								>
									{maximized ? (
										<Minimize2 className="h-3.5 w-3.5" />
									) : (
										<Maximize2 className="h-3.5 w-3.5" />
									)}
								</button>
							</div>
						)}
					</figcaption>
					{expanded && (
						<div
							id={`visualization-${visualization.attachment_id}`}
							className={maximized ? "min-h-0 flex-1" : undefined}
						>
							<VisualizationFrame
								rawUrl={rawUrl}
								title={visualization.title}
								zoom={zoom}
								className={
									maximized ? "h-full min-h-0" : "h-[min(70svh,40rem)] min-h-64"
								}
							/>
						</div>
					)}
				</figure>
			</PrivacyMask>
			{permissionLabel && (
				<div className="flex shrink-0 items-center gap-1.5 border-t border-border/30 px-3 py-1 text-[8px] tracking-widest text-muted-foreground/50 uppercase">
					<Check className="h-2.5 w-2.5 text-status-success/60" />
					<span>{permissionLabel}</span>
				</div>
			)}
		</div>
	);
}
