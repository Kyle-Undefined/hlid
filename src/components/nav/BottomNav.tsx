import { Link } from "@tanstack/react-router";
import { LockButton } from "../auth/LockButton";
import { NAV_ITEMS } from "./items";
import { WsStatusDot } from "./SystemStatusDot";

const BASE =
	"flex-1 flex flex-col items-center gap-1 py-2.5 px-1 transition-colors duration-100";

export function BottomNav() {
	return (
		<nav
			aria-label="Primary navigation"
			className="fixed inset-x-0 bottom-0 z-30 md:hidden bg-sidebar border-t border-sidebar-border"
		>
			<div className="absolute top-1.5 right-2 z-10">
				<WsStatusDot />
			</div>
			<div className="flex pb-[env(safe-area-inset-bottom)]">
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
				<LockButton mobile />
			</div>
		</nav>
	);
}
