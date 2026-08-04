import { Check, ChevronRight, LoaderCircle } from "lucide-react";
import {
	type ReactNode,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { ToolEventMessage } from "#/server/protocol";

export const ACTIVITY_TOOL_PAGE_SIZE = 20;

export type ActivityTrayRenderContext = {
	startIndex: number;
	endIndex: number;
	onSelectTool?: (event: ToolEventMessage, trigger: HTMLElement) => void;
};

type LoadFeedback =
	| { phase: "loading" }
	| {
			phase: "loaded";
			loaded: number;
			shown: number;
			total: number;
	  };

function activeToolCount(
	events: readonly ToolEventMessage[],
	streaming: boolean,
): number {
	if (!streaming) return 0;
	return events.filter((event) => {
		const status = event.subagent?.status;
		if (status === "pending" || status === "running" || status === "paused") {
			return true;
		}
		return event.result === undefined && !event.isError;
	}).length;
}

function countLabel(count: number, singular: string, plural = `${singular}s`) {
	return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * A response-owned, bounded activity viewport. The body is conditionally
 * mounted so a collapsed historical response keeps only its compact header in
 * the DOM. Tool summaries remain in reducer state for live correlation.
 */
export function AssistantActivityTray({
	responseId,
	events,
	totalCount,
	errorCount: aggregateErrorCount,
	hasEarlier = false,
	onLoadEarlier,
	streaming,
	steerCount,
	open,
	onToggle,
	onBackground,
	onSelectTool,
	renderContent,
}: {
	responseId: string;
	events: readonly ToolEventMessage[];
	/** Aggregate persisted count when only a bounded historical suffix is loaded. */
	totalCount?: number;
	errorCount?: number;
	hasEarlier?: boolean;
	onLoadEarlier?: () => Promise<number>;
	streaming: boolean;
	steerCount: number;
	open: boolean;
	onToggle: () => void;
	onBackground?: () => void;
	onSelectTool?: (event: ToolEventMessage, trigger: HTMLElement) => void;
	renderContent: (context: ActivityTrayRenderContext) => ReactNode;
}) {
	const regionId = useId();
	const bodyRef = useRef<HTMLDivElement>(null);
	const [visibleCount, setVisibleCount] = useState(ACTIVITY_TOOL_PAGE_SIZE);
	const [detachedEnd, setDetachedEnd] = useState<number | null>(null);
	const [loadFeedback, setLoadFeedback] = useState<LoadFeedback | null>(null);
	const loadFrameRef = useRef<number | null>(null);
	const tailPinFrameRef = useRef<{
		frame: number;
		eventCount: number;
	} | null>(null);
	const anchoredPrependEventCountRef = useRef<number | null>(null);
	const loadGenerationRef = useRef(0);
	const prependSnapshotRef = useRef<{
		scrollHeight: number;
		scrollTop: number;
		visibleCount: number;
		eventCount: number;
	} | null>(null);
	const eventCount = events.length;
	const resolvedTotalCount = Math.max(eventCount, totalCount ?? eventCount);
	const endIndex = Math.min(detachedEnd ?? eventCount, eventCount);
	const startIndex = Math.max(0, endIndex - visibleCount);
	const loadedEarlierCount = Math.min(ACTIVITY_TOOL_PAGE_SIZE, startIndex);
	const serverEarlierCount =
		hasEarlier && onLoadEarlier
			? Math.min(
					ACTIVITY_TOOL_PAGE_SIZE,
					Math.max(0, resolvedTotalCount - eventCount),
				)
			: 0;
	const earlierCount = loadedEarlierCount || serverEarlierCount;
	const newerCount = Math.max(0, eventCount - endIndex);
	const loadedErrorCount = useMemo(
		() => events.filter((event) => event.isError).length,
		[events],
	);
	const errorCount = aggregateErrorCount ?? loadedErrorCount;
	const runningCount = useMemo(
		() => activeToolCount(events, streaming),
		[events, streaming],
	);
	const summaryParts = [
		countLabel(resolvedTotalCount, "tool call"),
		...(errorCount > 0 ? [countLabel(errorCount, "error")] : []),
		...(runningCount > 0
			? [countLabel(runningCount, "running", "running")]
			: []),
		...(steerCount > 0 ? [countLabel(steerCount, "steer")] : []),
	];
	const summary = summaryParts.join(" · ");

	// A collapsed tray intentionally forgets its expanded window. Reopening starts
	// at the newest 20 calls, keeping remount cost predictable.
	useEffect(() => {
		if (open) return;
		loadGenerationRef.current += 1;
		if (loadFrameRef.current !== null) {
			cancelAnimationFrame(loadFrameRef.current);
			loadFrameRef.current = null;
		}
		setVisibleCount(ACTIVITY_TOOL_PAGE_SIZE);
		setDetachedEnd(null);
		setLoadFeedback(null);
		prependSnapshotRef.current = null;
		anchoredPrependEventCountRef.current = null;
	}, [open]);
	useEffect(() => {
		if (loadFeedback?.phase !== "loaded") return;
		const timeout = window.setTimeout(() => setLoadFeedback(null), 1_200);
		return () => window.clearTimeout(timeout);
	}, [loadFeedback]);
	useEffect(
		() => () => {
			loadGenerationRef.current += 1;
			if (loadFrameRef.current !== null) {
				cancelAnimationFrame(loadFrameRef.current);
			}
			if (tailPinFrameRef.current !== null) {
				cancelAnimationFrame(tailPinFrameRef.current.frame);
			}
		},
		[],
	);
	useLayoutEffect(() => {
		const snapshot = prependSnapshotRef.current;
		const body = bodyRef.current;
		if (!snapshot || !body) return;
		// A server page can reach the parent before this tray expands its local
		// window. Keep the snapshot until those newly loaded rows actually mount.
		if (visibleCount <= snapshot.visibleCount) return;
		prependSnapshotRef.current = null;
		body.scrollTop =
			snapshot.scrollTop + (body.scrollHeight - snapshot.scrollHeight);
		if (eventCount !== snapshot.eventCount) {
			anchoredPrependEventCountRef.current = eventCount;
			const tailPin = tailPinFrameRef.current;
			if (tailPin?.eventCount === eventCount) {
				cancelAnimationFrame(tailPin.frame);
				tailPinFrameRef.current = null;
			}
		}
	}, [eventCount, visibleCount]);

	useEffect(() => {
		if (!open || detachedEnd !== null) return;
		const body = bodyRef.current;
		if (!body) return;
		if (anchoredPrependEventCountRef.current === eventCount) {
			anchoredPrependEventCountRef.current = null;
			return;
		}
		anchoredPrependEventCountRef.current = null;
		const frame = requestAnimationFrame(() => {
			if (tailPinFrameRef.current?.frame === frame) {
				tailPinFrameRef.current = null;
			}
			body.scrollTop = body.scrollHeight;
		});
		tailPinFrameRef.current = { frame, eventCount };
		return () => {
			cancelAnimationFrame(frame);
			if (tailPinFrameRef.current?.frame === frame) {
				tailPinFrameRef.current = null;
			}
		};
	}, [detachedEnd, eventCount, open]);

	const loadEarlier = () => {
		if (loadFeedback?.phase === "loading") return;
		const body = bodyRef.current;
		if (body) {
			prependSnapshotRef.current = {
				scrollHeight: body.scrollHeight,
				scrollTop: body.scrollTop,
				visibleCount,
				eventCount,
			};
		}
		const revealLoaded = loadedEarlierCount;
		setLoadFeedback({ phase: "loading" });
		if (revealLoaded > 0) {
			loadFrameRef.current = requestAnimationFrame(() => {
				loadFrameRef.current = null;
				setVisibleCount((count) => count + revealLoaded);
				setLoadFeedback({
					phase: "loaded",
					loaded: revealLoaded,
					shown: Math.min(resolvedTotalCount, visibleCount + revealLoaded),
					total: resolvedTotalCount,
				});
			});
			return;
		}
		if (!onLoadEarlier) {
			prependSnapshotRef.current = null;
			setLoadFeedback(null);
			return;
		}
		const generation = ++loadGenerationRef.current;
		void onLoadEarlier().then(
			(loadedValue) => {
				if (loadGenerationRef.current !== generation || !open) return;
				const loaded = Number.isFinite(loadedValue)
					? Math.max(0, Math.floor(loadedValue))
					: 0;
				if (loaded === 0) {
					prependSnapshotRef.current = null;
					setLoadFeedback(null);
					return;
				}
				setVisibleCount((count) => count + loaded);
				setLoadFeedback({
					phase: "loaded",
					loaded,
					shown: Math.min(resolvedTotalCount, visibleCount + loaded),
					total: resolvedTotalCount,
				});
			},
			() => {
				if (loadGenerationRef.current !== generation || !open) return;
				prependSnapshotRef.current = null;
				setLoadFeedback(null);
			},
		);
	};

	return (
		<section
			data-activity-tray={responseId}
			className="mx-3 my-1 min-w-0 overflow-hidden border border-border/65 bg-background/35"
		>
			<div className="flex min-w-0 items-stretch">
				<button
					type="button"
					data-activity-tray-header={responseId}
					aria-expanded={open}
					aria-controls={regionId}
					aria-label={`Activity, ${summary}, ${open ? "expanded" : "collapsed"}`}
					onClick={onToggle}
					className="group flex min-h-10 min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-primary/[0.035] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/60"
				>
					<ChevronRight
						className={`h-3 w-3 shrink-0 text-primary/50 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
						aria-hidden="true"
					/>
					<span className="shrink-0 text-[9px] font-medium uppercase tracking-[0.16em] text-primary/70">
						Activity
					</span>
					<span className="min-w-0 flex-1 truncate font-mono text-[9px] text-muted-foreground/55">
						{summary}
					</span>
					{runningCount > 0 && (
						<LoaderCircle
							className="h-3 w-3 shrink-0 animate-spin text-primary/60"
							aria-hidden="true"
						/>
					)}
				</button>
				{runningCount > 0 && onBackground && (
					<button
						type="button"
						onClick={onBackground}
						aria-label="Background running Claude tools"
						title="Move Claude's running Bash commands and subagents into the background"
						className="shrink-0 border-l border-border/55 px-3 text-[8px] font-medium uppercase tracking-[0.14em] text-primary/65 transition-colors hover:bg-primary/[0.035] hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/60"
					>
						Background
					</button>
				)}
			</div>
			{open && (
				<section
					ref={bodyRef}
					id={regionId}
					aria-label={`Activity for response, ${summary}`}
					className="max-h-44 min-h-0 overflow-y-auto overscroll-contain border-t border-border/55 sm:max-h-52"
					onWheel={(event) => {
						if (streaming && event.deltaY < 0 && detachedEnd === null) {
							setDetachedEnd(eventCount);
						}
					}}
					onTouchMove={() => {
						if (streaming && detachedEnd === null) setDetachedEnd(eventCount);
					}}
				>
					{(earlierCount > 0 || loadFeedback) && (
						<button
							type="button"
							data-activity-load-earlier={startIndex}
							onClick={loadEarlier}
							disabled={loadFeedback !== null}
							aria-label={
								loadFeedback?.phase === "loading"
									? "Loading earlier tool calls"
									: loadFeedback?.phase === "loaded"
										? `Loaded ${loadFeedback.loaded} earlier, ${loadFeedback.shown} of ${loadFeedback.total} shown`
										: `Load ${earlierCount} earlier`
							}
							className={`sticky top-0 z-10 flex min-h-9 w-full items-center justify-center gap-1.5 border-b bg-background/95 px-3 py-1.5 text-[9px] uppercase tracking-widest transition-colors ${
								loadFeedback?.phase === "loaded"
									? "border-status-success/25 text-status-success"
									: "border-border/55 text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground"
							}`}
						>
							<span aria-live="polite" aria-atomic="true">
								{loadFeedback?.phase === "loading" ? (
									<span className="flex items-center gap-1.5">
										<LoaderCircle
											className="h-3 w-3 animate-spin"
											aria-hidden="true"
										/>
										Loading earlier
									</span>
								) : loadFeedback?.phase === "loaded" ? (
									<span className="flex items-center gap-1.5">
										<Check className="h-3 w-3" aria-hidden="true" />
										Loaded {loadFeedback.loaded} · {loadFeedback.shown} of{" "}
										{loadFeedback.total}
									</span>
								) : (
									<>Load {earlierCount} earlier</>
								)}
							</span>
						</button>
					)}
					{newerCount > 0 && (
						<button
							type="button"
							onClick={() => {
								if (loadFrameRef.current !== null) {
									cancelAnimationFrame(loadFrameRef.current);
									loadFrameRef.current = null;
								}
								setLoadFeedback(null);
								setVisibleCount(ACTIVITY_TOOL_PAGE_SIZE);
								setDetachedEnd(null);
							}}
							className="sticky top-0 z-10 flex min-h-9 w-full items-center justify-center border-b border-primary/20 bg-background/95 px-3 py-1.5 text-[9px] uppercase tracking-widest text-primary/70 transition-colors hover:bg-accent"
						>
							Jump to live · {countLabel(newerCount, "new call")}
						</button>
					)}
					{renderContent({ startIndex, endIndex, onSelectTool })}
				</section>
			)}
		</section>
	);
}
