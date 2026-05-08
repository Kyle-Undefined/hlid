import { useSyncExternalStore } from "react";
import * as wsStore from "../../hooks/wsStore";

/**
 * Tailwind class for the connection/session status dot, given the
 * three relevant pieces of state. Shared by the mobile BottomNav dot
 * and the desktop Sidebar header dot so they always agree.
 */
export function statusDotClass(
	wsStatus: wsStore.WsStatus,
	sessionState: "idle" | "running" | "error",
	hasPendingPermissions: boolean,
): string {
	if (wsStatus === "disconnected" || wsStatus === "connecting") {
		return "bg-muted-foreground/25";
	}
	if (sessionState === "error") return "bg-destructive";
	if (hasPendingPermissions) return "bg-orange-500 animate-pulse";
	if (sessionState === "running") return "bg-primary animate-pulse";
	return "bg-green-600";
}

export function WsStatusDot() {
	const { wsStatus, sessionState, hasPendingPermissions } =
		useSyncExternalStore(
			wsStore.subscribeStatus,
			wsStore.getSnapshot,
			() => wsStore.INITIAL_SNAPSHOT,
		);

	const statusLabel = (() => {
		if (wsStatus === "disconnected" || wsStatus === "connecting")
			return "Connecting to system";
		if (sessionState === "error") return "System error";
		if (hasPendingPermissions) return "Waiting for permissions";
		if (sessionState === "running") return "System running";
		return "System connected";
	})();

	return (
		<div
			className={`md:hidden w-1.5 h-1.5 rounded-full shrink-0 ${statusDotClass(
				wsStatus,
				sessionState,
				hasPendingPermissions,
			)}`}
			role="img"
			aria-label={statusLabel}
		/>
	);
}
