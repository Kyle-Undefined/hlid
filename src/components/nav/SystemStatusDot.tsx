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
	if (pending) return "bg-status-warning animate-pulse";
	if (state === "running") return "bg-primary animate-pulse";
	return "bg-status-success";
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
		() => ({
			state: "idle" as const,
			sessionCount: 0,
			runningCount: 0,
			pendingPermissions: false,
		}),
	);

	return {
		wsStatus,
		sessionState,
		hasPendingPermissions,
		agg,
		dotClass: aggregateDotClass(
			wsStatus,
			agg,
			sessionState,
			hasPendingPermissions,
		),
	};
}

export function WsStatusDot() {
	const { wsStatus, sessionState, hasPendingPermissions, agg, dotClass } =
		useSystemStatusIndicator();

	const statusLabel = (() => {
		if (wsStatus === "disconnected" || wsStatus === "connecting")
			return "Connecting to system";
		const hasAggregateSessions = agg.sessionCount > 0;
		const state = hasAggregateSessions ? agg.state : sessionState;
		const pending = hasAggregateSessions
			? agg.pendingPermissions
			: hasPendingPermissions;
		if (state === "error") return "System error";
		if (pending) return "Waiting for permissions";
		if (state === "running") return "System running";
		return "System connected";
	})();

	return (
		<div
			className={`md:hidden w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`}
			role="img"
			aria-label={statusLabel}
		/>
	);
}
