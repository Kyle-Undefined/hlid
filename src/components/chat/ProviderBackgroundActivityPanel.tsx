import {
	AlertTriangle,
	CheckCircle2,
	ChevronRight,
	CircleHelp,
	CircleStop,
	LoaderCircle,
	Square,
} from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
	getSessionsStatus,
	subscribeSessionsStatus,
} from "#/hooks/wsSessionStatusStore";
import { send } from "#/hooks/wsStore";
import type { ProviderBackgroundActivity } from "#/server/agentProvider";
import type { SessionStatusEntry } from "#/server/protocol";

const EMPTY_SESSION_STATUSES: SessionStatusEntry[] = [];
const panelOpenOverrides = new Map<string, boolean>();

function statusPresentation(activity: ProviderBackgroundActivity): {
	label: string;
	tone: string;
	icon: React.ReactNode;
} {
	switch (activity.status) {
		case "running":
			return {
				label: "RUNNING",
				tone: "text-primary/65",
				icon: <LoaderCircle className="h-2.5 w-2.5 animate-spin" />,
			};
		case "completed":
			return {
				label: "COMPLETED",
				tone: "text-status-success/75",
				icon: <CheckCircle2 className="h-2.5 w-2.5" />,
			};
		case "failed":
			return {
				label: "FAILED",
				tone: "text-destructive/75",
				icon: <AlertTriangle className="h-2.5 w-2.5" />,
			};
		case "stopped":
			return {
				label: "STOPPED",
				tone: "text-muted-foreground/60",
				icon: <CircleStop className="h-2.5 w-2.5" />,
			};
		case "unknown":
			return {
				label: "NOT LIVE",
				tone: "text-status-warning/75",
				icon: <CircleHelp className="h-2.5 w-2.5" />,
			};
	}
}

function resourceLabel(activity: ProviderBackgroundActivity): string | null {
	const parts = [
		activity.osPid != null ? `PID ${activity.osPid}` : null,
		activity.cpuPercent != null
			? `${activity.cpuPercent.toFixed(1)}% CPU`
			: null,
		activity.rssKb != null
			? `${Math.max(1, Math.round(activity.rssKb / 1024))} MB`
			: null,
	].filter((part): part is string => part !== null);
	return parts.length > 0 ? parts.join(" · ") : null;
}

export function ProviderBackgroundActivityPanel({
	sessionId,
}: {
	sessionId: string;
}) {
	const sessionStatuses = useSyncExternalStore(
		subscribeSessionsStatus,
		getSessionsStatus,
		() => EMPTY_SESSION_STATUSES,
	);
	const session = useMemo(
		() =>
			sessionStatuses.find(
				(status) =>
					status.session_id === sessionId || status.db_session_id === sessionId,
			),
		[sessionId, sessionStatuses],
	);
	const activities = (session?.background_activities ?? []).filter(
		(activity) => activity.status === "running",
	);
	const runningCount = activities.filter(
		(activity) => activity.status === "running",
	).length;
	const [openOverride, setOpenOverride] = useState<boolean | null>(
		() => panelOpenOverrides.get(sessionId) ?? null,
	);
	const [busy, setBusy] = useState<string | null>(null);
	useEffect(() => {
		setOpenOverride(panelOpenOverrides.get(sessionId) ?? null);
		setBusy(null);
	}, [sessionId]);
	useEffect(() => {
		if (!busy) return;
		const stillRunning =
			busy === "clean"
				? runningCount > 0
				: activities.some(
						(activity) =>
							activity.activityId === busy && activity.status === "running",
					);
		if (!stillRunning) setBusy(null);
	}, [activities, busy, runningCount]);

	if (activities.length === 0) return null;
	const open = openOverride ?? false;
	const canClean = activities.some(
		(activity) => activity.status === "running" && activity.capabilities.clean,
	);
	const summary = `${runningCount} running`;

	const toggleOpen = () => {
		const next = !open;
		panelOpenOverrides.set(sessionId, next);
		setOpenOverride(next);
	};
	const terminate = (activityId: string) => {
		setBusy(activityId);
		if (
			!send({
				type: "background_activity_control",
				action: "terminate",
				activity_id: activityId,
				session_id: session?.session_id ?? sessionId,
			})
		) {
			setBusy(null);
		}
	};
	const clean = () => {
		if (
			!window.confirm(
				"Stop every running Codex background terminal in this session?",
			)
		) {
			return;
		}
		setBusy("clean");
		if (
			!send({
				type: "background_activity_control",
				action: "clean",
				session_id: session?.session_id ?? sessionId,
			})
		) {
			setBusy(null);
		}
	};

	return (
		<section className="mx-1 rounded border border-border/45 bg-muted/10">
			<div className="flex min-w-0 items-center gap-1 px-2 py-1.5">
				<button
					type="button"
					onClick={toggleOpen}
					aria-expanded={open}
					className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
				>
					<ChevronRight
						className={`h-3 w-3 shrink-0 text-muted-foreground/55 transition-transform ${open ? "rotate-90" : ""}`}
					/>
					<span className="font-mono text-[10px] tracking-wide text-muted-foreground/75">
						BACKGROUND ACTIVITY
					</span>
					<span className="truncate font-mono text-[10px] text-muted-foreground/50">
						{summary}
					</span>
				</button>
				{canClean && (
					<button
						type="button"
						onClick={clean}
						disabled={busy !== null}
						className="rounded px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground/65 hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
					>
						STOP ALL
					</button>
				)}
			</div>
			{open && (
				<div
					data-testid="provider-background-activity-list"
					className="max-h-56 space-y-1 overflow-y-auto overscroll-contain border-t border-border/35 px-2 py-2 sm:max-h-80"
				>
					{activities.map((activity) => {
						const presentation = statusPresentation(activity);
						const resources = resourceLabel(activity);
						return (
							<div
								key={`${activity.providerSessionId}:${activity.activityId}`}
								className="rounded border border-border/35 bg-background/35 px-2 py-1.5"
							>
								<div className="flex min-w-0 items-start gap-2">
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-1.5">
											<span
												className={`flex items-center gap-1 font-mono text-[9px] ${presentation.tone}`}
											>
												{presentation.icon}
												{presentation.label}
											</span>
											<span className="font-mono text-[9px] text-muted-foreground/45">
												{activity.providerId}
											</span>
											{resources && (
												<span className="truncate font-mono text-[9px] text-muted-foreground/45">
													{resources}
												</span>
											)}
										</div>
										<div
											title={
												activity.command ??
												activity.description ??
												activity.kind
											}
											className="mt-0.5 truncate font-mono text-[10px] text-foreground/75"
										>
											{activity.command ??
												activity.description ??
												activity.kind}
										</div>
										{activity.cwd && (
											<div className="truncate font-mono text-[9px] text-muted-foreground/45">
												{activity.cwd}
											</div>
										)}
									</div>
									{activity.status === "running" &&
										activity.capabilities.terminate && (
											<button
												type="button"
												onClick={() => terminate(activity.activityId)}
												disabled={busy !== null}
												aria-label="Stop background activity"
												className="rounded p-1 text-muted-foreground/60 hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
											>
												{busy === activity.activityId ? (
													<LoaderCircle className="h-3 w-3 animate-spin" />
												) : (
													<Square className="h-3 w-3" />
												)}
											</button>
										)}
								</div>
								{activity.recentOutput && (
									<pre className="mt-1 line-clamp-2 whitespace-pre-wrap break-all rounded bg-muted/20 px-1.5 py-1 font-mono text-[9px] leading-relaxed text-muted-foreground/65 sm:line-clamp-4">
										{activity.recentOutput}
									</pre>
								)}
							</div>
						);
					})}
				</div>
			)}
		</section>
	);
}
