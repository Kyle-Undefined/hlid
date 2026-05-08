import { PrivacyMask } from "#/components/PrivacyMask";
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

// ─── Bar ──────────────────────────────────────────────────────────────────────

export function Bar({
	value,
	max,
	label,
}: {
	value: number;
	max: number;
	label: string;
}) {
	const rawPct = max > 0 ? (value / max) * 100 : 0;
	const pct = Number.isFinite(rawPct) ? Math.min(Math.max(rawPct, 0), 100) : 0;
	const color =
		pct > 80 ? "bg-destructive" : pct > 60 ? "bg-yellow-600" : "bg-primary";
	return (
		<div className="space-y-1.5">
			<div className="flex justify-between text-[10px] tracking-wider">
				<span className="text-muted-foreground uppercase">{label}</span>
				<PrivacyMask inline className="text-foreground tabular-nums">
					{fmt(value)} / {fmt(max)} ({pct.toFixed(0)}%)
				</PrivacyMask>
			</div>
			<div
				role="progressbar"
				aria-valuenow={Math.round(pct)}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-label={label}
				className="h-1.5 bg-secondary overflow-hidden"
			>
				<div
					className={`h-full transition-all ${color}`}
					style={{ width: `${pct}%` }}
				/>
			</div>
		</div>
	);
}

// ─── UtilBar ──────────────────────────────────────────────────────────────────

export function UtilBar({ utilization }: { utilization: number }) {
	const rawPct = Number.isFinite(utilization) ? utilization * 100 : 0;
	const pct = Math.min(Math.max(rawPct, 0), 100);
	const color =
		pct > 80 ? "bg-destructive" : pct > 60 ? "bg-yellow-600" : "bg-primary";
	return (
		<div className="space-y-1.5">
			<div className="flex justify-between text-[10px] tracking-wider">
				<span className="text-muted-foreground uppercase">Utilization</span>
				<span className="text-foreground tabular-nums">{pct.toFixed(0)}%</span>
			</div>
			<div
				role="progressbar"
				aria-valuenow={Math.round(pct)}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-label="Utilization"
				className="h-1.5 bg-secondary overflow-hidden"
			>
				<div
					className={`h-full transition-all ${color}`}
					style={{ width: `${pct}%` }}
				/>
			</div>
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
