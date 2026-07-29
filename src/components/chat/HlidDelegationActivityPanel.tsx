import {
	AlertTriangle,
	Bot,
	CheckCircle2,
	ChevronRight,
	CirclePause,
	ExternalLink,
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
	compactDelegationDuration,
	liveDelegationUsageLabel,
	liveSessionReasonLabel,
} from "#/lib/liveSessionSwitcher";
import type { HlidDelegationListItem } from "#/lib/serverFns/hlidDelegations";
import { getHlidDelegationsFn } from "#/lib/serverFns/hlidDelegations";
import type { SessionStatusEntry } from "#/server/protocol";

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

function compactCount(value: number): string {
	if (value < 1_000) return `${Math.floor(value)}`;
	if (value < 1_000_000) {
		return `${Number((value / 1_000).toFixed(1))}k`;
	}
	return `${Number((value / 1_000_000).toFixed(1))}m`;
}

function compactCost(value: number): string {
	if (value === 0) return "$0";
	if (value < 0.01) return `$${value.toFixed(4)}`;
	if (value < 1) return `$${value.toFixed(3)}`;
	return `$${value.toFixed(2)}`;
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
	return `${compactCount(tokens)} tokens · ${compactCost(cost)} · ${compactDelegationDuration(elapsed)} elapsed`;
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
	sessionStatus,
	now,
}: {
	child: HlidDelegationListItem;
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
						{compactCount(child.tokens_used)}
						{child.token_budget !== null
							? ` / ${compactCount(child.token_budget)}`
							: ""}{" "}
						tokens
					</span>
				)}
				{(child.cost_used > 0 || child.cost_budget !== null) && (
					<span>
						{compactCost(child.cost_used)}
						{child.cost_budget !== null
							? ` / ${compactCost(child.cost_budget)}`
							: ""}
					</span>
				)}
			</div>
		</li>
	);
}

function panelSummary(children: HlidDelegationListItem[]): string {
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
	return [
		`${children.length} ${children.length === 1 ? "child" : "children"}`,
		running > 0 ? `${running} running` : null,
		waiting > 0 ? `${waiting} waiting` : null,
		failed > 0 ? `${failed} failed` : null,
		completed > 0 ? `${completed} settled` : null,
	]
		.filter((part): part is string => part !== null)
		.join(" · ");
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
	const needsOpen = orderedChildren.some(
		(child) =>
			active(child) ||
			(child.status === "interrupted" && child.resumable) ||
			attentionNeeded(statusByChildSession.get(child.child_session_id)),
	);
	const [openOverride, setOpenOverride] = useState<boolean | null>(
		() => panelOpenOverrides.get(sessionId) ?? null,
	);
	useEffect(() => {
		setOpenOverride(panelOpenOverrides.get(sessionId) ?? null);
	}, [sessionId]);
	const open = openOverride ?? needsOpen;
	const now = useLiveNow(orderedChildren.some(active));
	const descendantUsageSummary = parentSessionStatus
		? liveDelegationUsageLabel(parentSessionStatus)
		: null;
	const usageSummary =
		descendantUsageSummary ?? directChildUsageSummary(orderedChildren, now);

	if (orderedChildren.length === 0) return null;

	const toggleOpen = () => {
		const next = !open;
		panelOpenOverrides.set(sessionId, next);
		setOpenOverride(next);
	};

	return (
		<section
			aria-label="Hlid delegated children"
			className="my-1 min-w-0 max-w-full overflow-hidden border-y border-primary/10 bg-primary/[0.015]"
		>
			<button
				type="button"
				onClick={toggleOpen}
				aria-expanded={open}
				aria-label={`${open ? "Hide" : "Show"} Hlid delegated children`}
				className="grid min-h-11 w-full min-w-0 grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-2 overflow-hidden px-3 py-2 text-left transition-colors hover:bg-primary/[0.03]"
			>
				<ChevronRight
					className={`h-3 w-3 shrink-0 text-primary/50 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
				/>
				<Bot className="h-3.5 w-3.5 shrink-0 text-primary/60" />
				<div className="min-w-0">
					<div className="truncate text-[10px] font-medium tracking-wider text-primary/75">
						Hlid children
					</div>
					<div className="truncate font-mono text-[8px] text-muted-foreground/50">
						{panelSummary(orderedChildren)}
						{refreshFailed ? " · refresh unavailable" : ""}
					</div>
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
				</div>
			</button>
			{open && (
				<ul
					aria-label="Durable Hlid children"
					className="max-h-80 list-none overflow-y-auto overscroll-contain sm:max-h-96"
				>
					{orderedChildren.map((child) => (
						<ChildRow
							key={child.id}
							child={child}
							sessionStatus={statusByChildSession.get(child.child_session_id)}
							now={now}
						/>
					))}
				</ul>
			)}
		</section>
	);
}
