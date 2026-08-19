import {
	AlertTriangle,
	Bot,
	CheckCircle2,
	CirclePause,
	ExternalLink,
	GitBranch,
	LoaderCircle,
	XCircle,
} from "lucide-react";
import {
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { PrivacyMask } from "#/components/PrivacyMask";
import {
	getDataRevisionSnapshot,
	subscribeDataRevisionSnapshot,
} from "#/hooks/wsDataRevisionStore";
import {
	getSessionsStatus,
	subscribeSessionsStatus,
} from "#/hooks/wsSessionStatusStore";
import {
	compactDelegationCost,
	compactDelegationCount,
	compactDelegationDuration,
	liveDelegationUsageLabel,
	liveSessionReasonLabel,
} from "#/lib/liveSessionSwitcher";
import type { HlidDelegationListItem } from "#/lib/serverFns/hlidDelegations";
import {
	cleanupHlidWorktreeFn,
	getHlidDelegationsFn,
} from "#/lib/serverFns/hlidDelegations";
import type { SessionStatusEntry } from "#/server/protocol";
import {
	activitySummary,
	CollapsibleActivityPanel,
	usePersistentPanelOpen,
} from "./CollapsibleActivityPanel";

const EMPTY_SESSION_STATUSES: SessionStatusEntry[] = [];
const PANEL_CHILD_LIMIT = 50;
const panelOpenOverrides = new Map<string, boolean>();

type StatusPresentation = {
	label: string;
	tone: string;
	icon: "running" | "completed" | "interrupted" | "cancelled" | "failed";
};

function statusPresentation(child: HlidDelegationListItem): StatusPresentation {
	if (
		(child.status === "pending" || child.status === "running") &&
		child.progress_text?.startsWith("Stopping")
	) {
		return {
			label: "STOPPING",
			tone: "text-status-warning/80",
			icon: "interrupted",
		};
	}

	switch (child.status) {
		case "pending":
			return {
				label: "PENDING",
				tone: "text-primary/60",
				icon: "running",
			};
		case "running":
			return {
				label: "RUNNING",
				tone: "text-primary/60",
				icon: "running",
			};
		case "completed":
			return {
				label: "COMPLETED",
				tone: "text-status-success/70",
				icon: "completed",
			};
		case "interrupted":
			return {
				label: "INTERRUPTED",
				tone: "text-status-warning/80",
				icon: "interrupted",
			};
		case "cancelled":
			return {
				label: "CANCELLED",
				tone: "text-muted-foreground/55",
				icon: "cancelled",
			};
		case "timed_out":
			return {
				label: "TIMED OUT",
				tone: "text-status-warning/80",
				icon: "failed",
			};
		// Retained for delegations persisted before orchestration caps were removed.
		case "budget_exhausted":
			return {
				label: "BUDGET EXHAUSTED",
				tone: "text-status-warning/80",
				icon: "failed",
			};
		case "failed":
			return {
				label: "FAILED",
				tone: "text-destructive/75",
				icon: "failed",
			};
	}
}

function StatusIcon({ presentation }: { presentation: StatusPresentation }) {
	if (presentation.icon === "running") {
		return <LoaderCircle className="h-2.5 w-2.5 animate-spin" />;
	}
	if (presentation.icon === "completed") {
		return <CheckCircle2 className="h-2.5 w-2.5" />;
	}
	if (presentation.icon === "interrupted") {
		return <CirclePause className="h-2.5 w-2.5" />;
	}
	if (presentation.icon === "cancelled") {
		return <XCircle className="h-2.5 w-2.5" />;
	}
	return <AlertTriangle className="h-2.5 w-2.5" />;
}

function active(child: HlidDelegationListItem): boolean {
	return child.status === "pending" || child.status === "running";
}

function childDurationSeconds(
	child: HlidDelegationListItem,
	now: number,
): number {
	const durationEnd = active(child)
		? now
		: (child.ended_at ?? child.updated_at);
	return Math.max(0, durationEnd - child.started_at);
}

function childElapsedSpanSeconds(
	children: HlidDelegationListItem[],
	now: number,
): number {
	if (children.length === 0) return 0;
	const firstStart = Math.min(...children.map((child) => child.started_at));
	const lastEnd = Math.max(
		...children.map((child) =>
			active(child) ? now : (child.ended_at ?? child.updated_at),
		),
	);
	return Math.max(0, lastEnd - firstStart);
}

function directChildUsageSummary(
	children: HlidDelegationListItem[],
	now: number,
): string {
	const tokens = children.reduce(
		(total, child) => total + child.tokens_used,
		0,
	);
	const cost = children.reduce((total, child) => total + child.cost_used, 0);
	const elapsed = childElapsedSpanSeconds(children, now);
	return `${compactDelegationCount(tokens)} tokens · ${compactDelegationCost(cost)} · ${compactDelegationDuration(elapsed)} elapsed`;
}

function attentionNeeded(status: SessionStatusEntry | undefined): boolean {
	return status?.attention?.bucket === "needs_attention";
}

function childPriority(
	child: HlidDelegationListItem,
	status: SessionStatusEntry | undefined,
): number {
	if (attentionNeeded(status)) return 0;
	if (active(child)) return 1;
	if (child.status === "interrupted" && child.resumable) return 2;
	if (
		child.status === "failed" ||
		child.status === "timed_out" ||
		child.status === "budget_exhausted"
	) {
		return 3;
	}
	return 4;
}

function useLiveNow(enabled: boolean): number {
	const [now, setNow] = useState(() => Math.floor(Date.now() / 1_000));
	useEffect(() => {
		if (!enabled) return;
		setNow(Math.floor(Date.now() / 1_000));
		const timer = window.setInterval(
			() => setNow(Math.floor(Date.now() / 1_000)),
			1_000,
		);
		return () => window.clearInterval(timer);
	}, [enabled]);
	return now;
}

function ChildRow({
	child,
	parentSessionId,
	sessionStatus,
	now,
}: {
	child: HlidDelegationListItem;
	parentSessionId: string;
	sessionStatus?: SessionStatusEntry;
	now: number;
}) {
	const presentation = statusPresentation(child);
	const attentionLabel =
		sessionStatus && attentionNeeded(sessionStatus)
			? liveSessionReasonLabel(sessionStatus)
			: null;
	const duration = compactDelegationDuration(childDurationSeconds(child, now));
	const openUrl = `/raven?session=${encodeURIComponent(child.child_session_id)}`;
	const [cleanupPending, setCleanupPending] = useState(false);
	const [cleanupMessage, setCleanupMessage] = useState<string | null>(null);
	const canCleanWorktree =
		child.workspace_mode === "worktree" &&
		child.complete &&
		child.worktree_state !== "cleaned";
	const cleanWorktree = async () => {
		setCleanupPending(true);
		setCleanupMessage(null);
		try {
			const result = await cleanupHlidWorktreeFn({
				data: { sessionId: parentSessionId, id: child.id },
			});
			setCleanupMessage(
				result.cleaned
					? "Worktree cleaned"
					: result.dirty
						? "Retained: uncommitted changes"
						: `Retained: ${result.unique_commits} unique commit${result.unique_commits === 1 ? "" : "s"}`,
			);
		} catch (error) {
			setCleanupMessage(
				error instanceof Error ? error.message : "Worktree cleanup failed",
			);
		} finally {
			setCleanupPending(false);
		}
	};

	return (
		<li
			data-delegation-id={child.id}
			className="grid min-h-14 min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2 gap-y-1 border-t border-primary/10 px-3 py-2"
		>
			<Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/55" />
			<div className="min-w-0">
				<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
					<output
						aria-label={`${presentation.label.toLowerCase()} delegation status`}
						className={`flex shrink-0 items-center gap-1 text-[8px] tracking-widest ${presentation.tone}`}
					>
						<StatusIcon presentation={presentation} />
						{presentation.label}
					</output>
					<span className="max-w-full truncate border border-primary/15 px-1 py-0.5 font-mono text-[8px] text-primary/45">
						{child.provider_id}
						{child.model ? ` · ${child.model}` : ""}
					</span>
					{child.effort && (
						<span className="shrink-0 border border-primary/15 px-1 py-0.5 font-mono text-[8px] text-primary/45">
							{child.effort} effort
						</span>
					)}
					{child.workspace_mode === "worktree" && (
						<span
							title={child.worktree_branch ?? "Managed worktree"}
							className="flex shrink-0 items-center gap-1 border border-primary/15 px-1 py-0.5 font-mono text-[8px] text-primary/45"
						>
							<GitBranch className="h-2.5 w-2.5" />
							{child.worktree_state}
						</span>
					)}
					{attentionLabel && (
						<span className="flex shrink-0 items-center gap-1 text-[8px] tracking-widest text-status-warning/80 uppercase">
							<AlertTriangle className="h-2.5 w-2.5" />
							{attentionLabel}
						</span>
					)}
				</div>
				<PrivacyMask className="mt-1 block min-w-0 truncate text-[10px] text-primary/70">
					{child.task}
				</PrivacyMask>
			</div>
			<a
				href={openUrl}
				aria-label={`Open ${child.task} child`}
				title="Open child"
				className="flex min-h-9 min-w-9 shrink-0 items-center justify-center gap-1 text-[8px] tracking-widest text-primary/65 uppercase hover:text-primary sm:px-2"
			>
				<span aria-hidden="true" className="hidden sm:inline">
					Open
				</span>
				<span className="sr-only">Open child</span>
				<ExternalLink className="h-3 w-3" />
			</a>
			{(child.progress_text || attentionLabel) && (
				<PrivacyMask className="col-span-2 col-start-2 min-w-0 truncate text-[9px] text-muted-foreground/55">
					{attentionLabel
						? `${attentionLabel}${child.progress_text ? ` · ${child.progress_text}` : ""}`
						: child.progress_text}
				</PrivacyMask>
			)}
			<div className="col-span-2 col-start-2 flex min-w-0 flex-wrap gap-x-3 gap-y-1 font-mono text-[8px] text-primary/45">
				{duration && <span>{duration}</span>}
				{/* Non-null caps occur only on historical delegation snapshots. */}
				{(child.tokens_used > 0 || child.token_budget !== null) && (
					<span>
						{compactDelegationCount(child.tokens_used)}
						{child.token_budget !== null
							? ` / ${compactDelegationCount(child.token_budget)}`
							: ""}{" "}
						tokens
					</span>
				)}
				{(child.cost_used > 0 || child.cost_budget !== null) && (
					<span>
						{compactDelegationCost(child.cost_used)}
						{child.cost_budget !== null
							? ` / ${compactDelegationCost(child.cost_budget)}`
							: ""}
					</span>
				)}
				{canCleanWorktree && (
					<button
						type="button"
						disabled={cleanupPending}
						onClick={() => void cleanWorktree()}
						className="text-primary/55 hover:text-primary disabled:opacity-40"
					>
						{cleanupPending ? "Checking worktree…" : "Clean up worktree"}
					</button>
				)}
				{cleanupMessage && <span>{cleanupMessage}</span>}
			</div>
		</li>
	);
}

function panelSummary(
	children: HlidDelegationListItem[],
	statusByChildSession: ReadonlyMap<string, SessionStatusEntry>,
): string {
	const needsAttention = children.filter((child) =>
		attentionNeeded(statusByChildSession.get(child.child_session_id)),
	).length;
	const running = children.filter(active).length;
	const waiting = children.filter(
		(child) => child.status === "interrupted" && child.resumable,
	).length;
	const failed = children.filter(
		(child) =>
			child.status === "failed" ||
			child.status === "timed_out" ||
			child.status === "budget_exhausted",
	).length;
	const completed = children.filter(
		(child) => child.status === "completed" || child.status === "cancelled",
	).length;
	return activitySummary([
		`${children.length} ${children.length === 1 ? "child" : "children"}`,
		needsAttention > 0 ? `${needsAttention} needs you` : null,
		running > 0 ? `${running} running` : null,
		waiting > 0 ? `${waiting} waiting` : null,
		failed > 0 ? `${failed} failed` : null,
		completed > 0 ? `${completed} settled` : null,
	]);
}

export function HlidDelegationActivityPanel({
	sessionId,
}: {
	sessionId: string;
}) {
	const sessionsRevision = useSyncExternalStore(
		subscribeDataRevisionSnapshot,
		() => getDataRevisionSnapshot().sessions,
		() => 0,
	);
	const sessionStatuses = useSyncExternalStore(
		subscribeSessionsStatus,
		getSessionsStatus,
		() => EMPTY_SESSION_STATUSES,
	);
	const [loadedChildren, setLoadedChildren] = useState<{
		sessionId: string;
		children: HlidDelegationListItem[];
	} | null>(null);
	const [refreshFailed, setRefreshFailed] = useState(false);
	const requestGeneration = useRef(0);
	const children =
		loadedChildren?.sessionId === sessionId ? loadedChildren.children : null;

	useEffect(() => {
		if (!sessionId) return;
		const requestedRevision = sessionsRevision;
		const generation = ++requestGeneration.current;
		void getHlidDelegationsFn({
			data: { sessionId, limit: PANEL_CHILD_LIMIT },
		})
			.then((loaded) => {
				if (
					requestGeneration.current !== generation ||
					getDataRevisionSnapshot().sessions !== requestedRevision
				) {
					return;
				}
				const unique = new Map<string, HlidDelegationListItem>();
				for (const child of loaded) {
					if (!unique.has(child.id)) unique.set(child.id, child);
				}
				setLoadedChildren({
					sessionId,
					children: [...unique.values()],
				});
				setRefreshFailed(false);
			})
			.catch(() => {
				if (requestGeneration.current === generation) {
					setRefreshFailed(true);
				}
			});
	}, [sessionId, sessionsRevision]);

	const statusByChildSession = useMemo(
		() =>
			new Map(
				sessionStatuses
					.filter(
						(
							status,
						): status is SessionStatusEntry & {
							db_session_id: string;
						} => Boolean(status.db_session_id),
					)
					.map((status) => [status.db_session_id, status]),
			),
		[sessionStatuses],
	);
	const orderedChildren = useMemo(
		() =>
			[...(children ?? [])].sort(
				(left, right) =>
					childPriority(left, statusByChildSession.get(left.child_session_id)) -
						childPriority(
							right,
							statusByChildSession.get(right.child_session_id),
						) ||
					right.started_at - left.started_at ||
					right.id.localeCompare(left.id),
			),
		[children, statusByChildSession],
	);
	const parentSessionStatus = useMemo(
		() => sessionStatuses.find((status) => status.db_session_id === sessionId),
		[sessionId, sessionStatuses],
	);
	const { open, toggleOpen } = usePersistentPanelOpen(
		sessionId,
		panelOpenOverrides,
	);
	const now = useLiveNow(orderedChildren.some(active));
	const descendantUsageSummary = parentSessionStatus
		? liveDelegationUsageLabel(parentSessionStatus)
		: null;
	const usageSummary =
		descendantUsageSummary ?? directChildUsageSummary(orderedChildren, now);

	if (orderedChildren.length === 0) return null;

	return (
		<CollapsibleActivityPanel
			label="Hlid delegated children"
			title="Hlid children"
			summary={`${panelSummary(orderedChildren, statusByChildSession)}${refreshFailed ? " · refresh unavailable" : ""}`}
			icon={<Bot className="h-3.5 w-3.5 text-primary/60" />}
			open={open}
			onToggle={toggleOpen}
			toggleAriaLabel={`${open ? "Hide" : "Show"} Hlid delegated children`}
			bodyClassName="max-h-80 overflow-y-auto overscroll-contain sm:max-h-96"
			details={
				<div
					title={
						descendantUsageSummary
							? "Tokens and cost are cumulative across all delegated descendants. Elapsed time spans the first descendant start through the last stop, or now while work is active."
							: "Tokens and cost are cumulative across the direct children shown. Elapsed time spans the first child start through the last stop, or now while work is active."
					}
					className="mt-0.5 font-mono text-[8px] leading-tight text-primary/45"
				>
					{usageSummary}
				</div>
			}
		>
			<ul aria-label="Durable Hlid children" className="list-none">
				{orderedChildren.map((child) => (
					<ChildRow
						key={child.id}
						child={child}
						parentSessionId={sessionId}
						sessionStatus={statusByChildSession.get(child.child_session_id)}
						now={now}
					/>
				))}
			</ul>
		</CollapsibleActivityPanel>
	);
}
