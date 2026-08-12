import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useLastRavenSession } from "#/hooks/ravenSessionStore";
import { semanticStatusClass, themeSurfaceClass } from "#/lib/themeClasses";
import { version } from "../../../package.json";
import {
	fetchUpdateStatus,
	getUpdateSnapshot,
	subscribeUpdateStatus,
	type UpdateStatus,
} from "../../hooks/updateStore";
import { LockButton } from "../auth/LockButton";
import { NavigationLinks } from "./NavigationLinks";
import { useNavigationLabels } from "./NavigationNamesContext";
import { useSystemStatusIndicator } from "./SystemStatusDot";

export function Sidebar() {
	const navigationLabels = useNavigationLabels();
	const {
		attentionCount,
		attentionTone,
		dotClass: dot,
	} = useSystemStatusIndicator();
	const lastRavenSession = useLastRavenSession();

	const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
	useEffect(() => {
		// Read current store state immediately (handles case where fetch already
		// completed before this component mounted).
		setUpdateStatus(getUpdateSnapshot());
		// Trigger the fetch (idempotent — no-op if banner already fired it).
		void fetchUpdateStatus();
		// Subscribe to future store updates.
		return subscribeUpdateStatus(() => {
			setUpdateStatus(getUpdateSnapshot());
		});
	}, []);
	const updateAvailable = updateStatus?.available ?? false;
	const latestVersion = updateStatus?.latest;

	return (
		<aside
			className={`hidden md:flex flex-col w-44 shrink-0 border-r border-sidebar-border ${themeSurfaceClass.sidebar}`}
		>
			<div className="px-4 py-4 border-b border-sidebar-border">
				<div className="flex items-center gap-2">
					<div className="text-[13px] font-bold tracking-[0.25em] text-sidebar-primary">
						Hlið
					</div>
					<Link
						to="/"
						aria-label="Open Watch attention summary"
						title="Open Watch attention summary"
						className="relative flex items-center"
					>
						<div className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
						{attentionCount > 0 && (
							<span
								className={`absolute -top-1.5 -right-2.5 font-mono text-[8px] leading-none tabular-nums ${
									attentionTone === "needs_attention"
										? semanticStatusClass.warning.text
										: attentionTone === "working"
											? "text-sidebar-primary/70"
											: attentionTone === "sleeping"
												? "text-sidebar-foreground/55"
												: semanticStatusClass.info.textMuted
								}`}
							>
								{attentionCount > 9 ? "9+" : attentionCount}
							</span>
						)}
					</Link>
				</div>
				<div className="text-[9px] tracking-widest text-sidebar-foreground/50 mt-0.5 uppercase">
					watcher of worlds
				</div>
				<div className="text-[9px] tabular-nums text-sidebar-foreground/30 mt-0.5 font-mono flex items-center gap-1">
					v{version}
					{updateAvailable && latestVersion && (
						<span className="text-sidebar-primary/70" title="Update available">
							→ v{latestVersion}
						</span>
					)}
				</div>
			</div>

			<nav aria-label="Primary navigation" className="flex-1 py-1">
				<NavigationLinks
					navigationLabels={navigationLabels}
					lastRavenSession={lastRavenSession}
					variant="desktop"
				/>
			</nav>
			<div className="border-t border-sidebar-border">
				<LockButton />
			</div>
		</aside>
	);
}
