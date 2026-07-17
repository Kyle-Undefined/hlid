import {
	cacheHitPct,
	Row,
	type StatBundle,
} from "#/components/ledger/LedgerStats";
import { PrivacyMask } from "#/components/PrivacyMask";
import { totalDisplayCost } from "#/lib/costDisplay";
import { fmt } from "#/lib/formatters";

// ─── CostBreakdown ────────────────────────────────────────────────────────────
// Full-width card showing token composition, cache activity, and per-query
// efficiency. Uses all-time data for maximum analytical richness.

const LEGEND = [
	{ color: "bg-[var(--token-input)]", label: "Input" },
	{ color: "bg-[var(--token-output)]", label: "Output" },
	{ color: "bg-[var(--cache-read)]", label: "Cache read" },
	{ color: "bg-[var(--cache-write)]", label: "Cache write" },
] as const;

export function CostBreakdown({ s }: { s: StatBundle }) {
	const totalTokens =
		s.input_tokens +
		s.output_tokens +
		s.cache_read_tokens +
		s.cache_creation_tokens;

	// Stacked bar segment percentages
	const inputPct = totalTokens > 0 ? (s.input_tokens / totalTokens) * 100 : 0;
	const outputPct = totalTokens > 0 ? (s.output_tokens / totalTokens) * 100 : 0;
	const readPct =
		totalTokens > 0 ? (s.cache_read_tokens / totalTokens) * 100 : 0;
	const writePct =
		totalTokens > 0 ? (s.cache_creation_tokens / totalTokens) * 100 : 0;
	const pcts = [inputPct, outputPct, readPct, writePct];

	// Per-query efficiency
	const avgCostPerQuery =
		s.queries - (s.unpriced_queries ?? 0) > 0
			? `${(s.estimated_cost ?? 0) > 0 ? "~" : ""}$${(
					totalDisplayCost(s) / (s.queries - (s.unpriced_queries ?? 0))
				).toFixed(4)}`
			: "--";
	const avgTokensPerQuery =
		s.queries > 0 ? fmt(Math.round(totalTokens / s.queries)) : "--";
	const outputInputRatio =
		s.input_tokens > 0
			? `${(s.output_tokens / s.input_tokens).toFixed(2)}×`
			: "--";

	const hitRate = cacheHitPct(
		s.input_tokens,
		s.cache_read_tokens,
		s.cache_creation_tokens,
	);

	return (
		<div className="border border-border bg-card">
			{/* Card header */}
			<div className="px-4 py-3 border-b border-border">
				<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
					Cost Breakdown
				</div>
			</div>

			{/* ── Token Composition ──────────────────────────────────────────── */}
			<div className="px-4 py-4 border-b border-border space-y-3">
				<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
					Token Composition
				</div>

				{/* Stacked bar */}
				{totalTokens > 0 ? (
					<div
						role="img"
						aria-label="Token composition bar"
						className="flex h-1.5 overflow-hidden bg-secondary"
					>
						<div
							className="h-full bg-[var(--token-input)] transition-all"
							style={{ width: `${inputPct}%` }}
						/>
						<div
							className="h-full bg-[var(--token-output)] transition-all"
							style={{ width: `${outputPct}%` }}
						/>
						<div
							className="h-full bg-[var(--cache-read)] transition-all"
							style={{ width: `${readPct}%` }}
						/>
						<div
							className="h-full bg-[var(--cache-write)] transition-all"
							style={{ width: `${writePct}%` }}
						/>
					</div>
				) : (
					<div className="h-1.5 bg-secondary" />
				)}

				{/* Legend */}
				<div className="flex flex-wrap gap-x-4 gap-y-1">
					{LEGEND.map(({ color, label }, i) => (
						<div key={label} className="flex items-center gap-1.5">
							<div className={`w-2 h-2 shrink-0 ${color}`} />
							<span className="text-[10px] tracking-wider text-muted-foreground uppercase">
								{label}
							</span>
							<PrivacyMask
								inline
								className="text-[10px] tabular-nums text-foreground"
							>
								{totalTokens > 0 ? `${pcts[i].toFixed(0)}%` : "--"}
							</PrivacyMask>
						</div>
					))}
				</div>
			</div>

			{/* ── Cache Impact ───────────────────────────────────────────────── */}
			<div className="border-b border-border">
				<div className="px-4 py-2.5 border-b border-border">
					<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
						Cache Impact
					</div>
				</div>
				<Row label="Cache hit rate" value={`${hitRate}%`} />
				<Row label="Tokens from cache" value={fmt(s.cache_read_tokens)} />
				<Row
					label="Tokens written to cache"
					value={fmt(s.cache_creation_tokens)}
				/>
			</div>

			{/* ── Per-Query Efficiency ───────────────────────────────────────── */}
			<div>
				<div className="px-4 py-2.5 border-b border-border">
					<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
						Per-Query Efficiency
					</div>
				</div>
				<Row label="Avg cost / query" value={avgCostPerQuery} />
				<Row label="Avg tokens / query" value={avgTokensPerQuery} />
				<Row label="Output / input ratio" value={outputInputRatio} />
			</div>
		</div>
	);
}
