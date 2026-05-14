import { Link } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { version } from "../../../package.json";
import {
	fetchUpdateStatus,
	getUpdateSnapshot,
	subscribeUpdateStatus,
	type UpdateStatus,
} from "../../hooks/updateStore";
import * as wsStore from "../../hooks/wsStore";
import { NAV_ITEMS } from "./items";
import { statusDotClass } from "./SystemStatusDot";

export function Sidebar() {
	const { wsStatus, sessionState, hasPendingPermissions } =
		useSyncExternalStore(
			wsStore.subscribeStatus,
			wsStore.getSnapshot,
			() => wsStore.INITIAL_SNAPSHOT,
		);

	const dot = statusDotClass(wsStatus, sessionState, hasPendingPermissions);

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
		<aside className="hidden md:flex flex-col w-44 shrink-0 bg-sidebar border-r border-sidebar-border">
			<div className="px-4 py-4 border-b border-sidebar-border">
				<div className="flex items-center gap-2">
					<div className="text-[13px] font-bold tracking-[0.25em] text-primary">
						Hlið
					</div>
					<div className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
				</div>
				<div className="text-[9px] tracking-widest text-muted-foreground/50 mt-0.5 uppercase">
					watcher of worlds
				</div>
				<div className="text-[9px] tabular-nums text-muted-foreground/30 mt-0.5 font-mono flex items-center gap-1">
					v{version}
					{updateAvailable && latestVersion && (
						<span className="text-primary/70" title="Update available">
							→ v{latestVersion}
						</span>
					)}
				</div>
			</div>

			<nav className="flex-1 py-1">
				{NAV_ITEMS.map(({ to, label, icon: Icon, exact }) => (
					<Link
						key={to}
						to={to}
						className="flex items-center gap-3 px-4 py-2.5 text-[11px] tracking-widest text-muted-foreground hover:text-foreground hover:bg-accent transition-colors duration-100 border-l-2 border-transparent"
						activeProps={{
							className:
								"flex items-center gap-3 px-4 py-2.5 text-[11px] tracking-widest text-primary border-l-2 border-primary bg-primary/5 transition-colors duration-100",
						}}
						activeOptions={{ exact }}
					>
						<Icon className="w-3.5 h-3.5 shrink-0" />
						<span>{label}</span>
					</Link>
				))}
			</nav>
		</aside>
	);
}
