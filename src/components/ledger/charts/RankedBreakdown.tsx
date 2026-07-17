import { PrivacyMask } from "#/components/PrivacyMask";

export type RankedBreakdownRow = {
	key: string;
	label: string;
	value: number;
};

export function RankedBreakdown({
	title,
	subtitle,
	rows,
	emptyMessage,
	valueLabel,
	onSelect,
}: {
	title: string;
	subtitle: string;
	rows: RankedBreakdownRow[];
	emptyMessage: string;
	valueLabel: (value: number) => string;
	onSelect?: (key: string) => void;
}) {
	const max = Math.max(1, ...rows.map((row) => row.value));
	return (
		<div className="border border-border bg-card">
			<div className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-3">
				<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
					{title}
				</div>
				<div className="text-[9px] tabular-nums text-muted-foreground/60">
					{subtitle}
				</div>
			</div>
			{rows.length === 0 ? (
				<div className="grid min-h-32 place-items-center px-4 text-[10px] tracking-widest text-muted-foreground/40 uppercase">
					{emptyMessage}
				</div>
			) : (
				<div className="divide-y divide-border/50 p-2">
					{rows.map((row, index) => {
						const content = (
							<>
								<div className="flex items-center justify-between gap-3">
									<div className="min-w-0 truncate text-[10px] text-foreground/80">
										<span className="mr-2 tabular-nums text-muted-foreground/40">
											{index + 1}
										</span>
										{row.label}
									</div>
									<PrivacyMask
										inline
										className="shrink-0 text-[9px] tabular-nums text-muted-foreground"
									>
										{valueLabel(row.value)}
									</PrivacyMask>
								</div>
								<div className="mt-1.5 h-1.5 overflow-hidden bg-secondary">
									<div
										className="h-full bg-[var(--data)]"
										style={{ width: `${(row.value / max) * 100}%` }}
									/>
								</div>
							</>
						);
						return onSelect ? (
							<button
								key={row.key}
								type="button"
								onClick={() => onSelect(row.key)}
								className="block min-h-12 w-full px-2 py-2 text-left hover:bg-accent/30"
								title="Open matching sessions"
							>
								{content}
							</button>
						) : (
							<div key={row.key} className="min-h-12 px-2 py-2">
								{content}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
