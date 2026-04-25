import { Link } from "@tanstack/react-router";
import {
	BarChart3,
	FolderOpen,
	LayoutDashboard,
	MessageSquare,
	Settings,
} from "lucide-react";

const NAV_ITEMS = [
	{ to: "/", label: "COCKPIT", icon: LayoutDashboard, exact: true },
	{ to: "/chat", label: "CHAT", icon: MessageSquare, exact: false },
	{ to: "/vault", label: "VAULT", icon: FolderOpen, exact: false },
	{ to: "/stats", label: "STATS", icon: BarChart3, exact: false },
	{ to: "/settings", label: "CONFIG", icon: Settings, exact: false },
] as const;

const BASE =
	"flex-1 flex flex-col items-center gap-1 py-2.5 px-1 transition-colors duration-100";

export function BottomNav() {
	return (
		<nav className="fixed bottom-0 left-0 right-0 md:hidden bg-sidebar border-t border-sidebar-border z-50">
			<div className="flex safe-area-inset-bottom">
				{NAV_ITEMS.map(({ to, label, icon: Icon, exact }) => (
					<Link
						key={to}
						to={to}
						className={`${BASE} text-muted-foreground hover:text-foreground`}
						activeProps={{ className: `${BASE} text-primary` }}
						activeOptions={{ exact }}
					>
						<Icon className="w-4 h-4" />
						<span className="text-[9px] tracking-widest">{label}</span>
					</Link>
				))}
			</div>
		</nav>
	);
}
