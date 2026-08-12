import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useId, useState } from "react";

export function activitySummary(
	parts: ReadonlyArray<string | null | undefined | false>,
): string {
	return parts
		.filter((part): part is string => typeof part === "string")
		.join(" · ");
}

export function usePersistentPanelOpen(
	stateKey: string,
	overrides: Map<string, boolean>,
): { open: boolean; toggleOpen: () => void } {
	const [openOverride, setOpenOverride] = useState<boolean | null>(
		() => overrides.get(stateKey) ?? null,
	);

	useEffect(() => {
		setOpenOverride(overrides.get(stateKey) ?? null);
	}, [stateKey, overrides]);

	const open = openOverride ?? false;
	return {
		open,
		toggleOpen: () => {
			const next = !open;
			overrides.set(stateKey, next);
			setOpenOverride(next);
		},
	};
}

export function CollapsibleActivityPanel({
	label,
	title,
	summary,
	icon,
	details,
	open,
	onToggle,
	toggleAriaLabel,
	keepMounted = false,
	bodyClassName,
	children,
}: {
	label: string;
	title: string;
	summary: string;
	icon: ReactNode;
	details?: ReactNode;
	open: boolean;
	onToggle: () => void;
	toggleAriaLabel?: string;
	keepMounted?: boolean;
	bodyClassName: string;
	children: ReactNode;
}) {
	const bodyId = useId();
	const body = (
		<div id={bodyId} hidden={keepMounted && !open} className={bodyClassName}>
			{children}
		</div>
	);

	return (
		<section
			aria-label={label}
			className="my-1 min-w-0 max-w-full overflow-hidden border-y border-primary/10 bg-primary/[0.015]"
		>
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={open}
				aria-controls={bodyId}
				aria-label={
					toggleAriaLabel ??
					`${label}, ${summary}, ${open ? "expanded" : "collapsed"}`
				}
				className="grid min-h-11 w-full min-w-0 grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-2 overflow-hidden px-3 py-2 text-left transition-colors hover:bg-primary/[0.03] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/60"
			>
				<ChevronRight
					className={`h-3 w-3 shrink-0 text-primary/50 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
					aria-hidden="true"
				/>
				<span aria-hidden="true">{icon}</span>
				<div className="min-w-0">
					<div className="truncate text-[10px] font-medium tracking-wider text-primary/75">
						{title}
					</div>
					<div className="truncate font-mono text-[9px] text-muted-foreground/55">
						{summary}
					</div>
					{details}
				</div>
			</button>
			{keepMounted ? body : open ? body : null}
		</section>
	);
}
