import type { ReactNode } from "react";

/**
 * Shared sticky page header: uppercase eyebrow plus inline controls
 * (mobile category <select>, search input, status region) passed as children.
 * Children lay out in a 2-col grid on mobile and a flex row on md+,
 * matching the original Forge header behavior.
 */
export function PageHeader({
	eyebrow,
	children,
}: {
	eyebrow: string;
	children?: ReactNode;
}) {
	return (
		<header className="sticky top-0 z-20 shrink-0 border-b border-border bg-background/95 backdrop-blur px-4 py-3">
			<div className="max-w-[1000px] mx-auto grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 md:flex md:gap-3">
				<div className="text-[10px] tracking-widest uppercase shrink-0">
					{eyebrow}
				</div>
				{children}
			</div>
		</header>
	);
}

/**
 * Shared content-column intro: page/category title, optional count and
 * short description. Sits at the top of the scrolling content column.
 */
export function PageIntro({
	title,
	description,
	count,
}: {
	title: string;
	description?: string;
	count?: number;
}) {
	return (
		<div className="space-y-1">
			<div className="flex items-baseline gap-2">
				<h2 className="text-lg font-medium">{title}</h2>
				{count !== undefined && (
					<span className="text-xs text-muted-foreground/60 tabular-nums">
						{count}
					</span>
				)}
			</div>
			{description && (
				<p className="text-xs text-muted-foreground">{description}</p>
			)}
		</div>
	);
}
