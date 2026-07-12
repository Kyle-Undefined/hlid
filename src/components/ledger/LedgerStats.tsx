import { PrivacyMask } from "#/components/PrivacyMask";
import { formatDisplayCost, totalDisplayCost } from "#/lib/costDisplay";
import { fmt } from "#/lib/formatters";

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

// ─── StatRows ─────────────────────────────────────────────────────────────────
// Shared row set rendered identically in every stats card (SESSION, TODAY,
// THIS MONTH, ALL-TIME, LIVE). Keeps layout vertically aligned across the row
// of cards on the stats tab and removes the prior inconsistency where each
// window surfaced a slightly different subset of metrics.

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

export function StatRows({ s }: { s: StatBundle }) {
	const pricedQueries = Math.max(0, s.queries - (s.unpriced_queries ?? 0));
	const avgCost =
		pricedQueries > 0
			? `${(s.estimated_cost ?? 0) > 0 ? "~" : ""}$${(
					totalDisplayCost(s) / pricedQueries
				).toFixed(4)}`
			: "--";
	const avgTurns = s.queries > 0 ? (s.turns / s.queries).toFixed(1) : "--";
	const hit = cacheHitPct(
		s.input_tokens,
		s.cache_read_tokens,
		s.cache_creation_tokens,
	);
	const cacheTokens = s.cache_read_tokens + s.cache_creation_tokens;
	const total =
		s.input_tokens +
		s.output_tokens +
		s.cache_read_tokens +
		s.cache_creation_tokens;
	const costLabel =
		(s.estimated_cost ?? 0) > 0
			? "Cost (estimated)"
			: (s.unpriced_queries ?? 0) > 0
				? "Cost (partial)"
				: "Cost";
	return (
		<>
			<Row label={costLabel} value={formatDisplayCost(s)} />
			<Row label="Avg cost/query" value={avgCost} />
			<Row label="Queries" value={String(s.queries)} />
			<Row label="Turns" value={String(s.turns)} />
			<Row label="Avg turns/query" value={avgTurns} />
			<Row label="Input" value={fmt(s.input_tokens)} />
			<Row label="Output" value={fmt(s.output_tokens)} />
			<Row label="Cache read" value={fmt(s.cache_read_tokens)} />
			<Row label="Cache creation" value={fmt(s.cache_creation_tokens)} />
			<Row label="Cache hit rate" value={`${hit}%`} />
			<Row label="Cache tokens" value={fmt(cacheTokens)} />
			<Row label="Total tokens" value={fmt(total)} />
		</>
	);
}
