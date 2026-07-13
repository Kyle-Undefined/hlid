import type { ReactNode } from "react";

/** Compact deliberate empty state shown inside the Vault content column. */
export function VaultEmptyState({ children }: { children: ReactNode }) {
	return (
		<div className="border border-border bg-card px-4 py-8 text-center">
			<p className="text-xs tracking-wider text-muted-foreground">{children}</p>
		</div>
	);
}
