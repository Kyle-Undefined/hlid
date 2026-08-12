import { useLastRavenSession } from "#/hooks/ravenSessionStore";
import { NavigationLinks } from "./NavigationLinks";
import { useNavigationLabels } from "./NavigationNamesContext";
import { WsStatusDot } from "./SystemStatusDot";

export function BottomNav() {
	const navigationLabels = useNavigationLabels();
	const lastRavenSession = useLastRavenSession();
	return (
		<nav
			aria-label="Primary navigation"
			className="relative z-30 shrink-0 bg-sidebar border-t border-sidebar-border md:hidden"
		>
			<div className="flex w-full pb-[env(safe-area-inset-bottom)]">
				<NavigationLinks
					navigationLabels={navigationLabels}
					lastRavenSession={lastRavenSession}
					variant="mobile"
					watchAdornment={
						<span className="absolute -right-4 -top-1">
							<WsStatusDot />
						</span>
					}
				/>
			</div>
		</nav>
	);
}
