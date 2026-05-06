import { useSyncExternalStore } from "react";
import * as wsStore from "../../hooks/wsStore";

const SERVER_SNAP = {
	wsStatus: "connecting" as const,
	sessionState: "idle" as const,
	model: "",
	actualModel: null,
	hasPendingPermissions: false,
};

export function StatusDot() {
	const { wsStatus, sessionState, hasPendingPermissions } =
		useSyncExternalStore(
			wsStore.subscribeStatus,
			wsStore.getSnapshot,
			() => SERVER_SNAP,
		);

	const isRunning = wsStatus === "connected" && sessionState === "running";
	const isError = wsStatus === "connected" && sessionState === "error";

	const dot =
		wsStatus === "disconnected" || wsStatus === "connecting"
			? "bg-muted-foreground/25"
			: isError
				? "bg-destructive"
				: hasPendingPermissions
					? "bg-orange-500 animate-pulse"
					: isRunning
						? "bg-primary animate-pulse"
						: "bg-green-600";

	return (
		<div className={`md:hidden w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
	);
}
