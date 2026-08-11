import type { ReactNode } from "react";

/**
 * Shared sticky page header: uppercase eyebrow plus inline controls
 * (mobile category <select>, search input, status region) passed as children.
 * Children wrap as the available content column narrows, keeping search and
 * status controls readable beside a category rail.
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
			<div className="mx-auto flex max-w-[1000px] min-w-0 flex-wrap items-center gap-2 md:gap-3">
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
	id,
	headingLevel = 2,
}: {
	title: string;
	description?: string;
	count?: number;
	/** Stable focusable anchor for direct navigation. */
	id?: string;
	/** Semantic heading level. Defaults to h2 for backward compatibility. */
	headingLevel?: 1 | 2 | 3;
}) {
	const Heading = `h${headingLevel}` as "h1" | "h2" | "h3";
	return (
		<div className="space-y-1">
			<div className="flex items-baseline gap-2">
				<Heading
					id={id}
					tabIndex={id ? -1 : undefined}
					className="scroll-mt-20 text-lg font-medium focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
				>
					{title}
				</Heading>
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
