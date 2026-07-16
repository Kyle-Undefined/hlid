import { Link, useLocation } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
	fetchUpdateStatus,
	getUpdateServerSnapshot,
	getUpdateSnapshot,
	subscribeUpdateStatus,
} from "#/hooks/updateStore";

function dismissedKey(updateId: string) {
	return `hlid:update-dismissed:${updateId}`;
}

export function UpdateBanner() {
	const status = useSyncExternalStore(
		subscribeUpdateStatus,
		getUpdateSnapshot,
		getUpdateServerSnapshot,
	);
	const [dismissed, setDismissed] = useState(false);
	const location = useLocation();
	const cliUpdate = status?.cliUpdates?.find((update) => update.available);
	const updateId = status?.available
		? `hlid:${status.latest}`
		: cliUpdate
			? `${cliUpdate.id}:${cliUpdate.latestVersion}`
			: null;

	// Trigger the shared fetch once. No-op if already fetched.
	useEffect(() => {
		void fetchUpdateStatus();
	}, []);

	// Check dismissal whenever latest version changes. localStorage access
	// can throw in restricted contexts (Safari private mode, third-party
	// frame, quota errors) — fall back to "not dismissed" so the banner is
	// still visible rather than crashing the component.
	useEffect(() => {
		if (!updateId) return;
		try {
			setDismissed(localStorage.getItem(dismissedKey(updateId)) === "1");
		} catch {
			setDismissed(false);
		}
	}, [updateId]);

	function dismiss() {
		if (updateId) {
			try {
				localStorage.setItem(dismissedKey(updateId), "1");
			} catch {
				// localStorage unavailable — dismissal won't persist across
				// reloads but the banner still hides for this session.
			}
		}
		setDismissed(true);
	}

	// Suppress when: no update ready, already dismissed, or user is on the forge
	// page where the full update UI is already visible.
	if (!updateId || dismissed || location.pathname === "/forge") {
		return null;
	}
	const label = status?.available
		? `Hlid v${status.latest} available`
		: `${cliUpdate?.label}${cliUpdate?.surface === "desktop" ? "" : " CLI"} v${cliUpdate?.latestVersion} available`;

	return (
		<output
			aria-live="polite"
			className="absolute top-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-3 py-1.5 rounded-full bg-background border border-primary/40 shadow-sm whitespace-nowrap"
		>
			<Link
				to="/forge"
				className="text-[10px] tracking-widest uppercase text-primary hover:text-primary/80 transition-colors"
			>
				{label}
			</Link>
			<button
				type="button"
				onClick={dismiss}
				aria-label="Dismiss update notification"
				className="text-sm text-primary/40 hover:text-primary transition-colors leading-none"
			>
				×
			</button>
		</output>
	);
}
