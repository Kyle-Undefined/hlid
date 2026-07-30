import { PrivacyMask } from "#/components/PrivacyMask";

// ─── StatCell ─────────────────────────────────────────────────────────────────

export function StatCell({
	label,
	value,
	sub,
	dim,
}: {
	label: string;
	value: string;
	sub?: string;
	dim?: boolean;
}) {
	return (
		<div className="p-4 flex flex-col gap-1">
			<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
				{label}
			</div>
			<PrivacyMask
				inline
				className={`text-xl font-bold tabular-nums ${dim ? "text-muted-foreground/20" : "text-[var(--data)]"}`}
			>
				{value}
			</PrivacyMask>
			{sub && (
				<PrivacyMask
					inline
					className="text-[10px] text-muted-foreground tracking-wider"
				>
					{sub}
				</PrivacyMask>
			)}
		</div>
	);
}

// ─── Row ──────────────────────────────────────────────────────────────────────

export function Row({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-center justify-between px-4 py-2.5 border-b border-border last:border-0">
			<span className="text-[10px] tracking-widest text-muted-foreground uppercase">
				{label}
			</span>
			<PrivacyMask
				inline
				className="text-sm font-medium text-foreground tabular-nums"
			>
				{value}
			</PrivacyMask>
		</div>
	);
}

export type StatBundle = {
	cost: number;
	estimated_cost?: number;
	unpriced_queries?: number;
	queries: number;
	turns: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
};

/**
 * Cache hit rate as a percentage string (one decimal).
 * Returns "0" when total input is zero to avoid division by zero.
 */
export function cacheHitPct(
	input: number,
	cacheRead: number,
	cacheCreate: number,
): string {
	const total = input + cacheRead + cacheCreate;
	return total > 0 ? ((cacheRead / total) * 100).toFixed(1) : "0";
}
