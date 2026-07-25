import { useSyncExternalStore } from "react";
import {
	type AggregateNavStatus,
	getAggregateNavStatus,
	subscribeSessionsStatus,
} from "../../hooks/wsSessionStatusStore";
import * as wsStore from "../../hooks/wsStore";
import type { SessionStatusEntry } from "../../server/protocol";

/**
 * Tailwind class for a single pool session's status dot (SessionStatusEntry).
 * Shared by SessionsLedger and any other component rendering per-session dots.
 */
export function sessionEntryDotClass(s: SessionStatusEntry): string {
	if (s.state === "error") return "bg-destructive";
	if (s.hasPendingPermissions) return "bg-status-warning animate-pulse";
	if (s.state === "running") return "bg-primary animate-pulse";
	return "bg-muted-foreground/40";
}

/**
 * Aggregate dot class derived from pool-wide sessions_status.
 * Falls back to per-session state when no sessions are in the pool.
 */
function aggregateDotClass(
	wsStatus: wsStore.WsStatus,
	agg: AggregateNavStatus,
	fallbackState: "idle" | "running" | "error",
	fallbackPending: boolean,
): string {
	if (wsStatus === "disconnected" || wsStatus === "connecting") {
		return "bg-muted-foreground/25";
	}
	// An idle aggregate is still authoritative when the pool contains sessions.
	// Falling back based on the state value itself lets an older focused-chat
	// heartbeat turn a correctly idle pool back into a pulsing/running icon.
	const hasAggregateSessions = agg.sessionCount > 0;
	const state = hasAggregateSessions ? agg.state : fallbackState;
	const pending = hasAggregateSessions
		? agg.pendingPermissions
		: fallbackPending;
	if (state === "error") return "bg-destructive";
	if (pending || agg.needsAttentionCount > 0)
		return "bg-status-warning animate-pulse";
	if (state === "running" || agg.workingCount > 0)
		return "bg-primary animate-pulse";
	if (agg.queuedCount > 0) return "bg-status-info";
	return "bg-status-success";
}

export type SystemAttentionTone =
	| "needs_attention"
	| "working"
	| "queued"
	| "none";

const SERVER_AGGREGATE_NAV_STATUS: AggregateNavStatus = {
	state: "idle",
	sessionCount: 0,
	runningCount: 0,
	pendingPermissions: false,
	attentionSessionCount: 0,
	needsAttentionCount: 0,
	workingCount: 0,
	queuedCount: 0,
	recentCount: 0,
};

function attentionHeadline(agg: AggregateNavStatus): {
	count: number;
	tone: SystemAttentionTone;
} {
	if (agg.needsAttentionCount > 0) {
		return { count: agg.needsAttentionCount, tone: "needs_attention" };
	}
	if (agg.workingCount > 0) {
		return { count: agg.workingCount, tone: "working" };
	}
	if (agg.queuedCount > 0) {
		return { count: agg.queuedCount, tone: "queued" };
	}
	return { count: 0, tone: "none" };
}

export function useSystemStatusIndicator() {
	const { wsStatus, sessionState, hasPendingPermissions } =
		useSyncExternalStore(
			wsStore.subscribeStatus,
			wsStore.getSnapshot,
			() => wsStore.INITIAL_SNAPSHOT,
		);

	const agg = useSyncExternalStore(
		subscribeSessionsStatus,
		getAggregateNavStatus,
		() => SERVER_AGGREGATE_NAV_STATUS,
	);
	const headline =
		wsStatus === "connected"
			? attentionHeadline(agg)
			: { count: 0, tone: "none" as const };

	return {
		wsStatus,
		sessionState,
		hasPendingPermissions,
		agg,
		attentionCount: headline.count,
		attentionTone: headline.tone,
		dotClass: aggregateDotClass(
			wsStatus,
			agg,
			sessionState,
			hasPendingPermissions,
		),
	};
}

export function WsStatusDot() {
	const {
		wsStatus,
		sessionState,
		hasPendingPermissions,
		agg,
		attentionCount,
		attentionTone,
		dotClass,
	} = useSystemStatusIndicator();

	const statusLabel = (() => {
		if (wsStatus === "disconnected" || wsStatus === "connecting")
			return "Connecting to system";
		const hasAggregateSessions = agg.sessionCount > 0;
		const state = hasAggregateSessions ? agg.state : sessionState;
		const pending = hasAggregateSessions
			? agg.pendingPermissions
			: hasPendingPermissions;
		if (state === "error") return "System error";
		if (pending || agg.needsAttentionCount > 0) {
			const count = agg.needsAttentionCount || 1;
			return `${count} ${
				count === 1 ? "session needs" : "sessions need"
			} attention`;
		}
		if (state === "running" || agg.workingCount > 0) {
			const count = agg.workingCount || 1;
			return `${count} ${count === 1 ? "session" : "sessions"} working`;
		}
		if (agg.queuedCount > 0)
			return `${agg.queuedCount} ${
				agg.queuedCount === 1 ? "session" : "sessions"
			} queued`;
		return "System connected";
	})();
	const countClass =
		attentionTone === "needs_attention"
			? "text-status-warning"
			: attentionTone === "working"
				? "text-primary"
				: "text-status-info";

	return (
		<div
			className="flex shrink-0 items-center gap-1 md:hidden"
			role="img"
			aria-label={statusLabel}
		>
			<span
				data-testid="system-status-dot"
				className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`}
			/>
			{attentionCount > 0 && (
				<span
					aria-hidden="true"
					className={`font-mono text-[8px] leading-none tabular-nums ${countClass}`}
				>
					{attentionCount > 9 ? "9+" : attentionCount}
				</span>
			)}
		</div>
	);
}
