import { Link } from "@tanstack/react-router";
import { Menu, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { NavigationId } from "#/lib/navigationNames";
import { themeSurfaceClass } from "#/lib/themeClasses";
import {
	moreNavItems,
	navActiveOptions,
	navDisplayMetadata,
	navItemsForMode,
	navSearch,
} from "./items";
import { useViewMode } from "./NavigationNamesContext";

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
	const viewMode = useViewMode();
	const [moreOpen, setMoreOpen] = useState(false);
	const moreMenuId = useId();
	const containerRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!moreOpen) return;
		const closeOnOutsideClick = (event: MouseEvent) => {
			if (!containerRef.current?.contains(event.target as Node)) {
				setMoreOpen(false);
			}
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setMoreOpen(false);
		};
		document.addEventListener("mousedown", closeOnOutsideClick);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("mousedown", closeOnOutsideClick);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, [moreOpen]);
	const desktop = variant === "desktop";
	const baseClass = desktop
		? `flex items-center gap-3 px-4 py-2.5 text-[11px] tracking-widest text-sidebar-foreground/70 transition-colors duration-100 border-l-2 border-transparent ${themeSurfaceClass.sidebarAction}`
		: "min-w-0 flex-1 flex flex-col items-center gap-1 py-2.5 px-0.5 transition-colors duration-100 text-muted-foreground hover:text-foreground";
	const activeClass = desktop
		? "flex items-center gap-3 px-4 py-2.5 text-[11px] tracking-widest text-sidebar-primary border-l-2 border-sidebar-primary bg-sidebar-primary/5 transition-colors duration-100"
		: "min-w-0 flex-1 flex flex-col items-center gap-1 py-2.5 px-0.5 transition-colors duration-100 text-primary";

	const links = navItemsForMode(viewMode).map(
		({ id, to, label, icon: Icon, exact }) => {
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
		},
	);
	if (viewMode === "full") return links;

	return (
		<>
			{links}
			<div
				ref={containerRef}
				className={desktop ? "relative" : "relative flex-1"}
			>
				<button
					type="button"
					aria-haspopup="menu"
					aria-label="More navigation"
					aria-expanded={moreOpen}
					aria-controls={moreMenuId}
					onClick={() => setMoreOpen((open) => !open)}
					className={`${baseClass} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
				>
					{moreOpen ? (
						<X aria-hidden="true" className="h-4 w-4 shrink-0" />
					) : (
						<Menu aria-hidden="true" className="h-4 w-4 shrink-0" />
					)}
					<span
						className={
							desktop
								? "min-w-0 flex-1 text-left"
								: "text-[clamp(7px,2vw,9px)] tracking-[0.08em]"
						}
					>
						MORE
					</span>
				</button>
				{moreOpen && (
					<div
						id={moreMenuId}
						role="menu"
						aria-label="More navigation destinations"
						className={
							desktop
								? "absolute bottom-0 left-full z-50 ml-2 w-44 border border-border bg-popover p-1 shadow-xl"
								: "absolute bottom-full right-1 z-50 mb-2 w-44 border border-border bg-popover p-1 shadow-xl"
						}
					>
						{moreNavItems().map(({ id, to, label, icon: Icon, exact }) => {
							const metadata = navDisplayMetadata(id, label, navigationLabels);
							return (
								<Link
									key={to}
									to={to}
									aria-label={metadata.ariaLabel}
									title={metadata.title}
									role="menuitem"
									activeOptions={navActiveOptions(exact)}
									onClick={() => setMoreOpen(false)}
									className="flex items-center gap-3 px-3 py-2 text-xs tracking-wider text-popover-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								>
									<Icon aria-hidden="true" className="h-4 w-4" />
									<span>{metadata.displayLabel}</span>
								</Link>
							);
						})}
					</div>
				)}
			</div>
		</>
	);
}
