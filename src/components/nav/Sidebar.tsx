import { Link } from "@tanstack/react-router";
import {
	BarChart3,
	FolderOpen,
	LayoutDashboard,
	MessageSquare,
	Settings,
} from "lucide-react";
import { useSyncExternalStore } from "react";
import { version } from "../../../package.json";
import * as wsStore from "../../hooks/wsStore";

const NAV_ITEMS = [
	{ to: "/", label: "COCKPIT", icon: LayoutDashboard, exact: true },
	{ to: "/chat", label: "CHAT", icon: MessageSquare, exact: false },
	{ to: "/vault", label: "VAULT", icon: FolderOpen, exact: false },
	{ to: "/stats", label: "STATS", icon: BarChart3, exact: false },
	{ to: "/settings", label: "CONFIG", icon: Settings, exact: false },
] as const;

const SERVER_SNAP = {
	wsStatus: "connecting" as const,
	sessionState: "idle" as const,
	model: "",
};

export function Sidebar() {
	const { wsStatus, sessionState } = useSyncExternalStore(
		wsStore.subscribeStatus,
		wsStore.getSnapshot,
		() => SERVER_SNAP,
	);

	const isRunning = wsStatus === "connected" && sessionState === "running";
	const isError = wsStatus === "connected" && sessionState === "error";

	const dot =
		!wsStatus || wsStatus === "disconnected" || wsStatus === "connecting"
			? "bg-muted-foreground/25"
			: isError
				? "bg-destructive"
				: isRunning
					? "bg-primary animate-pulse"
					: "bg-green-600";

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
				<div className="text-[9px] tabular-nums text-muted-foreground/30 mt-0.5 font-mono">
					v{version}
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
