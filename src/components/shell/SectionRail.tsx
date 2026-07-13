export type SectionRailItem = {
	id: string;
	label: string;
	count?: number;
	group?: string;
};

/**
 * Shared narrow section rail for local page navigation (Forge, Vault).
 * Hidden below md — pages provide a <select> fallback in their header.
 */
export function SectionRail({
	items,
	activeId,
	onSelect,
	label,
	useAriaCurrent,
}: {
	items: SectionRailItem[];
	activeId: string;
	onSelect: (id: string) => void;
	label: string;
	/** true = URL-backed nav (aria-current="page"), false = local state (aria-pressed) */
	useAriaCurrent?: boolean;
}) {
	const groups: string[] = [];
	for (const item of items) {
		const g = item.group ?? "";
		if (!groups.includes(g)) groups.push(g);
	}
	return (
		<aside
			className="hidden md:flex w-52 shrink-0 border-r border-border bg-card/30 p-3 flex-col gap-1 overflow-auto"
			aria-label={label}
		>
			{groups.map((group, index) => (
				<div
					key={group || "__default__"}
					className={index ? "mt-3 pt-3 border-t border-border" : ""}
				>
					{items
						.filter((item) => (item.group ?? "") === group)
						.map((item) => {
							const active = item.id === activeId;
							return (
								<button
									key={item.id}
									type="button"
									onClick={() => onSelect(item.id)}
									{...(useAriaCurrent
										? { "aria-current": active ? ("page" as const) : undefined }
										: { "aria-pressed": active })}
									className={`w-full px-3 py-2 text-left text-xs transition-colors flex items-center justify-between gap-2 ${
										active
											? "bg-primary/10 text-primary"
											: "text-muted-foreground hover:bg-accent hover:text-foreground"
									}`}
								>
									<span className="truncate">{item.label}</span>
									{item.count !== undefined && (
										<span
											className={`text-[10px] tabular-nums shrink-0 ${
												active ? "text-primary/70" : "text-muted-foreground/50"
											}`}
										>
											{item.count}
										</span>
									)}
								</button>
							);
						})}
				</div>
			))}
		</aside>
	);
}
