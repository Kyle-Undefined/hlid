import { Link } from "@tanstack/react-router";
import {
	BarChart3,
	FolderOpen,
	LayoutDashboard,
	MessageSquare,
	Settings,
} from "lucide-react";

const NAV_ITEMS = [
	{ to: "/", label: "Main", icon: LayoutDashboard, exact: true },
	{ to: "/chat", label: "Chat", icon: MessageSquare, exact: false },
	{ to: "/stats", label: "Stats", icon: BarChart3, exact: false },
	{ to: "/vault", label: "Vault", icon: FolderOpen, exact: false },
	{ to: "/settings", label: "Settings", icon: Settings, exact: false },
] as const;

const BASE =
	"flex-1 flex flex-col items-center gap-1 py-2 px-1 transition-colors duration-150";

export function BottomNav() {
	return (
		<nav className="fixed bottom-0 left-0 right-0 md:hidden bg-sidebar border-t border-sidebar-border z-50">
			<div className="flex safe-area-inset-bottom">
				{NAV_ITEMS.map(({ to, label, icon: Icon, exact }) => (
					<Link
						key={to}
						to={to}
						className={`${BASE} text-sidebar-foreground/40 hover:text-sidebar-foreground`}
						activeProps={{ className: `${BASE} text-sidebar-primary` }}
						activeOptions={{ exact }}
					>
						<Icon className="w-5 h-5" />
						<span className="text-[10px] leading-none">{label}</span>
					</Link>
				))}
			</div>
		</nav>
	);
}
