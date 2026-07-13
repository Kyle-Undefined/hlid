import type { ReactNode } from "react";

/**
 * Shared bordered section panel with an optional uppercase eyebrow header.
 * Used by Forge settings sections and Vault groups.
 */
export function Section({
	title,
	description,
	adornment,
	count,
	children,
}: {
	title?: ReactNode;
	description?: string;
	adornment?: ReactNode;
	count?: number;
	children: ReactNode;
}) {
	return (
		<div className="space-y-2">
			{title != null && (
				<div className="px-1">
					<div className="flex items-center gap-2">
						{adornment}
						<div className="text-[10px] tracking-widest text-muted-foreground uppercase">
							{title}
						</div>
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
			<div className="border border-border bg-card divide-y divide-border">
				{children}
			</div>
		</div>
	);
}
