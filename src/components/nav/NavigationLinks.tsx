import { Link } from "@tanstack/react-router";
import type { NavigationId } from "#/lib/navigationNames";
import { themeSurfaceClass } from "#/lib/themeClasses";
import {
	NAV_ITEMS,
	navActiveOptions,
	navDisplayMetadata,
	navSearch,
} from "./items";

export function NavigationLinks({
	navigationLabels,
	lastRavenSession,
	variant,
	watchAdornment,
}: {
	navigationLabels: Record<NavigationId, string>;
	lastRavenSession: { sessionId: string; agent?: string } | null;
	variant: "desktop" | "mobile";
	watchAdornment?: React.ReactNode;
}) {
	const desktop = variant === "desktop";
	const baseClass = desktop
		? `flex items-center gap-3 px-4 py-2.5 text-[11px] tracking-widest text-sidebar-foreground/70 transition-colors duration-100 border-l-2 border-transparent ${themeSurfaceClass.sidebarAction}`
		: "min-w-0 flex-1 flex flex-col items-center gap-1 py-2.5 px-0.5 transition-colors duration-100 text-muted-foreground hover:text-foreground";
	const activeClass = desktop
		? "flex items-center gap-3 px-4 py-2.5 text-[11px] tracking-widest text-sidebar-primary border-l-2 border-sidebar-primary bg-sidebar-primary/5 transition-colors duration-100"
		: "min-w-0 flex-1 flex flex-col items-center gap-1 py-2.5 px-0.5 transition-colors duration-100 text-primary";

	return NAV_ITEMS.map(({ id, to, label, icon: Icon, exact }) => {
		const { displayLabel, ariaLabel, title } = navDisplayMetadata(
			id,
			label,
			navigationLabels,
		);
		return (
			<Link
				key={to}
				to={to}
				aria-label={ariaLabel}
				title={title}
				search={navSearch(to, lastRavenSession)}
				className={baseClass}
				activeProps={{ className: activeClass }}
				activeOptions={navActiveOptions(exact)}
			>
				<span className={desktop ? undefined : "relative"}>
					<Icon
						aria-hidden="true"
						className={desktop ? "h-3.5 w-3.5 shrink-0" : "h-4 w-4 shrink-0"}
					/>
					{to === "/" && watchAdornment}
				</span>
				<span
					className={
						desktop
							? "min-w-0 flex-1 truncate"
							: "w-full overflow-hidden text-ellipsis whitespace-nowrap text-center text-[clamp(7px,2vw,9px)] tracking-[0.08em]"
					}
				>
					{displayLabel}
				</span>
			</Link>
		);
	});
}
