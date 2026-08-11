import type { ReactNode } from "react";
import { normalizeSearchText } from "#/lib/search";
import { themeSurfaceClass } from "#/lib/themeClasses";

/**
 * Shared bordered section panel with an optional uppercase eyebrow header.
 * Used by Forge settings sections and Vault groups.
 */
export function Section({
	title,
	description,
	adornment,
	count,
	id,
	headingLevel = 2,
	children,
}: {
	title?: ReactNode;
	description?: string;
	adornment?: ReactNode;
	count?: number;
	/** Stable anchor for the heading, or for the wrapper when no title is present. */
	id?: string;
	/** Semantic heading level. Defaults to h2. */
	headingLevel?: 2 | 3 | 4;
	children: ReactNode;
}) {
	const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
	const settingLabel =
		typeof title === "string" ? normalizeSearchText(title) : undefined;
	return (
		<div
			id={title == null ? id : undefined}
			data-forge-section={id}
			className="min-w-0 space-y-2"
		>
			{title != null && (
				<div className="px-1">
					<div className="flex items-center gap-2">
						{adornment}
						<Heading
							id={id}
							data-forge-setting-label={settingLabel}
							tabIndex={settingLabel || id ? -1 : undefined}
							className="scroll-mt-20 text-[10px] tracking-widest text-muted-foreground uppercase focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
						>
							{title}
						</Heading>
						{count !== undefined && (
							<span className="text-[10px] text-muted-foreground/50 tabular-nums">
								{count}
							</span>
						)}
					</div>
					{description && (
						<p className="text-xs text-muted-foreground mt-1">{description}</p>
					)}
				</div>
			)}
			<div
				className={`min-w-0 border border-border divide-y divide-border ${themeSurfaceClass.card}`}
			>
				{children}
			</div>
		</div>
	);
}
