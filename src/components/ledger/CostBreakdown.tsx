import {
	cacheHitPct,
	Row,
	type StatBundle,
} from "#/components/ledger/LedgerStats";
import { PrivacyMask } from "#/components/PrivacyMask";
import { totalDisplayCost } from "#/lib/costDisplay";
import { fmt } from "#/lib/formatters";

// ─── CostBreakdown ────────────────────────────────────────────────────────────
// Full-width card showing token composition, cache savings estimate, and
// per-query efficiency. Uses all-time data for maximum analytical richness.
// Savings estimates use Sonnet pricing as a reasonable baseline.

const LEGEND = [
	{ color: "bg-primary", label: "Input" },
	{ color: "bg-yellow-600", label: "Output" },
	{ color: "bg-green-600", label: "Cache read" },
	{ color: "bg-orange-600", label: "Cache write" },
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

	// Cache savings estimate — Sonnet pricing (input=$3/MTok, read=$0.30/MTok, write=$3.75/MTok)
	const INPUT_RATE = 3.0;
	const READ_RATE = 0.3;
	const WRITE_RATE = 3.75;
	const cacheReadSavings =
		(s.cache_read_tokens / 1e6) * (INPUT_RATE - READ_RATE);
	const cacheWriteOverhead =
		(s.cache_creation_tokens / 1e6) * (WRITE_RATE - INPUT_RATE);
	const netCacheBenefit = cacheReadSavings - cacheWriteOverhead;
	const netStr =
		netCacheBenefit >= 0
			? `+$${netCacheBenefit.toFixed(4)} (est.)`
			: `-$${Math.abs(netCacheBenefit).toFixed(4)} (est.)`;

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
							className="h-full bg-primary transition-all"
							style={{ width: `${inputPct}%` }}
						/>
						<div
							className="h-full bg-yellow-600 transition-all"
							style={{ width: `${outputPct}%` }}
						/>
						<div
							className="h-full bg-green-600 transition-all"
							style={{ width: `${readPct}%` }}
						/>
						<div
							className="h-full bg-orange-600 transition-all"
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
					label="Savings from reads (est.)"
					value={`+$${cacheReadSavings.toFixed(4)}`}
				/>
				<Row
					label="Overhead from writes (est.)"
					value={`-$${cacheWriteOverhead.toFixed(4)}`}
				/>
				<Row label="Net cache benefit (est.)" value={netStr} />
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
