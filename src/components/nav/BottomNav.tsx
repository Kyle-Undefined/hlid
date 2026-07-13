import { Link } from "@tanstack/react-router";
import { LockButton } from "../auth/LockButton";
import { NAV_ITEMS } from "./items";
import { WsStatusDot } from "./SystemStatusDot";

const BASE =
	"min-w-0 flex-1 flex flex-col items-center gap-1 py-2.5 px-0.5 transition-colors duration-100";

const LABEL =
	"w-full overflow-hidden text-ellipsis whitespace-nowrap text-center text-[clamp(7px,2vw,9px)] tracking-[0.08em]";

export function BottomNav() {
	return (
		<nav
			aria-label="Primary navigation"
			className="relative z-30 shrink-0 bg-sidebar border-t border-sidebar-border md:hidden"
		>
			<div className="absolute top-1.5 right-2 z-10">
				<WsStatusDot />
			</div>
			<div className="flex w-full pb-[env(safe-area-inset-bottom)]">
				{NAV_ITEMS.map(({ to, label, icon: Icon, exact }) => (
					<Link
						key={to}
						to={to}
						className={`${BASE} text-muted-foreground hover:text-foreground`}
						activeProps={{ className: `${BASE} text-primary` }}
						activeOptions={{ exact }}
					>
						<Icon className="w-4 h-4 shrink-0" />
						<span className={LABEL}>{label}</span>
					</Link>
				))}
				<LockButton mobile />
			</div>
		</nav>
	);
}
