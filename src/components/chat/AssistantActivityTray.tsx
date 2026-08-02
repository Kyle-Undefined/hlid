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
	streaming,
	steerCount,
	open,
	onToggle,
	onSelectTool,
	renderContent,
}: {
	responseId: string;
	events: readonly ToolEventMessage[];
	streaming: boolean;
	steerCount: number;
	open: boolean;
	onToggle: () => void;
	onSelectTool?: (event: ToolEventMessage, trigger: HTMLElement) => void;
	renderContent: (context: ActivityTrayRenderContext) => ReactNode;
}) {
	const regionId = useId();
	const bodyRef = useRef<HTMLDivElement>(null);
	const [visibleCount, setVisibleCount] = useState(ACTIVITY_TOOL_PAGE_SIZE);
	const [detachedEnd, setDetachedEnd] = useState<number | null>(null);
	const [loadFeedback, setLoadFeedback] = useState<LoadFeedback | null>(null);
	const loadFrameRef = useRef<number | null>(null);
	const prependSnapshotRef = useRef<{
		scrollHeight: number;
		scrollTop: number;
	} | null>(null);
	const eventCount = events.length;
	const endIndex = Math.min(detachedEnd ?? eventCount, eventCount);
	const startIndex = Math.max(0, endIndex - visibleCount);
	const earlierCount = Math.min(ACTIVITY_TOOL_PAGE_SIZE, startIndex);
	const newerCount = Math.max(0, eventCount - endIndex);
	const errorCount = useMemo(
		() => events.filter((event) => event.isError).length,
		[events],
	);
	const runningCount = useMemo(
		() => activeToolCount(events, streaming),
		[events, streaming],
	);
	const summaryParts = [
		countLabel(eventCount, "tool call"),
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
		if (loadFrameRef.current !== null) {
			cancelAnimationFrame(loadFrameRef.current);
			loadFrameRef.current = null;
		}
		setVisibleCount(ACTIVITY_TOOL_PAGE_SIZE);
		setDetachedEnd(null);
		setLoadFeedback(null);
	}, [open]);
	useEffect(() => {
		if (loadFeedback?.phase !== "loaded") return;
		const timeout = window.setTimeout(() => setLoadFeedback(null), 1_200);
		return () => window.clearTimeout(timeout);
	}, [loadFeedback]);
	useEffect(
		() => () => {
			if (loadFrameRef.current !== null) {
				cancelAnimationFrame(loadFrameRef.current);
			}
		},
		[],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: visibleCount is the DOM prepend commit that makes scroll-height restoration possible
	useLayoutEffect(() => {
		const snapshot = prependSnapshotRef.current;
		const body = bodyRef.current;
		if (!snapshot || !body) return;
		prependSnapshotRef.current = null;
		body.scrollTop =
			snapshot.scrollTop + (body.scrollHeight - snapshot.scrollHeight);
	}, [visibleCount]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: eventCount is the live append signal that keeps an attached tray pinned to its tail
	useEffect(() => {
		if (!open || detachedEnd !== null) return;
		const body = bodyRef.current;
		if (!body) return;
		const frame = requestAnimationFrame(() => {
			body.scrollTop = body.scrollHeight;
		});
		return () => cancelAnimationFrame(frame);
	}, [detachedEnd, eventCount, open]);

	const loadEarlier = () => {
		if (loadFeedback?.phase === "loading") return;
		const body = bodyRef.current;
		if (body) {
			prependSnapshotRef.current = {
				scrollHeight: body.scrollHeight,
				scrollTop: body.scrollTop,
			};
		}
		const loaded = earlierCount;
		setLoadFeedback({ phase: "loading" });
		loadFrameRef.current = requestAnimationFrame(() => {
			loadFrameRef.current = null;
			setVisibleCount((count) => count + ACTIVITY_TOOL_PAGE_SIZE);
			setLoadFeedback({
				phase: "loaded",
				loaded,
				shown: Math.min(endIndex, visibleCount + loaded),
				total: eventCount,
			});
		});
	};

	return (
		<section
			data-activity-tray={responseId}
			className="mx-3 my-1 min-w-0 overflow-hidden border border-border/65 bg-background/35"
		>
			<button
				type="button"
				data-activity-tray-header={responseId}
				aria-expanded={open}
				aria-controls={regionId}
				aria-label={`Activity, ${summary}, ${open ? "expanded" : "collapsed"}`}
				onClick={onToggle}
				className="group flex min-h-10 w-full min-w-0 items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-primary/[0.035] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/60"
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
