import { Link } from "@tanstack/react-router";
import {
	BarChart3,
	FolderOpen,
	LayoutDashboard,
	MessageSquare,
	Settings,
} from "lucide-react";
import { useWs } from "#/hooks/useWs";

const NAV_ITEMS = [
	{ to: "/", label: "Main", icon: LayoutDashboard, exact: true },
	{ to: "/chat", label: "Chat", icon: MessageSquare, exact: false },
	{ to: "/stats", label: "Stats", icon: BarChart3, exact: false },
	{ to: "/vault", label: "Vault", icon: FolderOpen, exact: false },
	{ to: "/settings", label: "Settings", icon: Settings, exact: false },
] as const;

function SidebarStatus() {
	const { wsStatus, sessionState } = useWs();

	const dot =
		wsStatus !== "connected"
			? "bg-muted-foreground/40"
			: sessionState === "running"
				? "bg-yellow-400 animate-pulse"
				: sessionState === "error"
					? "bg-destructive"
					: "bg-green-400";

	const label =
		wsStatus !== "connected"
			? "Offline"
			: sessionState === "running"
				? "Running"
				: sessionState === "error"
					? "Error"
					: "Ready";

	return (
		<div className="px-4 py-3 border-t border-sidebar-border">
			<div className="flex items-center gap-2">
				<div className={`w-1.5 h-1.5 rounded-full ${dot}`} />
				<span className="text-xs text-sidebar-foreground/40">{label}</span>
			</div>
		</div>
	);
}

export function Sidebar() {
	return (
		<aside className="hidden md:flex flex-col w-52 shrink-0 bg-sidebar border-r border-sidebar-border">
			<div className="px-4 py-5 border-b border-sidebar-border">
				<h1 className="text-base font-semibold text-sidebar-foreground tracking-tight">
					Hlid
				</h1>
				<p className="text-xs text-sidebar-foreground/40 mt-0.5">
					command center
				</p>
			</div>

			<nav className="flex-1 p-2 space-y-0.5">
				{NAV_ITEMS.map(({ to, label, icon: Icon, exact }) => (
					<Link
						key={to}
						to={to}
						className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors duration-150"
						activeProps={{
							className:
								"flex items-center gap-3 px-3 py-2 rounded-md text-sm bg-sidebar-accent text-sidebar-primary font-medium transition-colors duration-150",
						}}
						activeOptions={{ exact }}
					>
						<Icon className="w-4 h-4 shrink-0" />
						<span>{label}</span>
					</Link>
				))}
			</nav>

			<SidebarStatus />
		</aside>
	);
}
