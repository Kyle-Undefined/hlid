import { useCallback, useEffect, useState } from "react";
import type {
	PricingCatalogAliasView,
	PricingCatalogModelView,
	PricingCatalogState,
} from "#/lib/pricingCatalog";

function effectiveWindow(rule: {
	effectiveFrom?: string;
	effectiveUntil?: string;
}): string {
	if (!rule.effectiveFrom && !rule.effectiveUntil) return "Always";
	return `${rule.effectiveFrom ?? "Beginning"} → ${rule.effectiveUntil ?? "No end"}`;
}

function sourceBadge(source: "built-in" | "local") {
	return (
		<span
			className={`inline-flex border px-1.5 py-0.5 text-[8px] tracking-widest uppercase ${
				source === "local"
					? "border-primary/40 text-primary"
					: "border-border text-muted-foreground"
			}`}
		>
			{source}
		</span>
	);
}

function rate(value: number | undefined): string {
	return value === undefined ? "—" : `$${value.toLocaleString()}`;
}

function ModelsTable({ models }: { models: PricingCatalogModelView[] }) {
	return (
		<div className="overflow-x-auto border border-border bg-card">
			<table className="w-full min-w-[760px] text-left text-xs">
				<thead className="border-b border-border bg-secondary/40 text-[9px] tracking-widest text-muted-foreground uppercase">
					<tr>
						<th className="px-3 py-2 font-normal">Model</th>
						<th className="px-3 py-2 font-normal">Effective UTC</th>
						<th className="px-3 py-2 font-normal">Input</th>
						<th className="px-3 py-2 font-normal">Cached</th>
						<th className="px-3 py-2 font-normal">Write</th>
						<th className="px-3 py-2 font-normal">Output</th>
					</tr>
				</thead>
				<tbody className="divide-y divide-border">
					{models.map((rule) => (
						<tr
							key={`${rule.source}:${rule.provider}:${rule.model}:${rule.effectiveFrom ?? ""}:${rule.effectiveUntil ?? ""}`}
							title={rule.note}
						>
							<td className="px-3 py-2.5">
								<div className="flex items-center gap-2">
									<span className="font-mono">{rule.model}</span>
									{sourceBadge(rule.source)}
								</div>
								<div className="mt-1 text-[9px] tracking-wider text-muted-foreground uppercase">
									{rule.provider}
								</div>
								{rule.rates?.longContextThreshold !== undefined && (
									<div className="mt-1 text-[9px] text-muted-foreground">
										Long context &gt;{" "}
										{rule.rates.longContextThreshold.toLocaleString()}: input ×
										{rule.rates.longContextInputMultiplier ?? 1}, output ×
										{rule.rates.longContextOutputMultiplier ?? 1}
									</div>
								)}
								{rule.note && (
									<div className="mt-1 max-w-72 text-[9px] text-muted-foreground">
										{rule.note}
									</div>
								)}
							</td>
							<td className="px-3 py-2.5 text-muted-foreground">
								{effectiveWindow(rule)}
							</td>
							{rule.rates ? (
								<>
									<td className="px-3 py-2.5 tabular-nums">
										{rate(rule.rates.input)}
									</td>
									<td className="px-3 py-2.5 tabular-nums">
										{rate(rule.rates.cachedInput)}
									</td>
									<td className="px-3 py-2.5 tabular-nums">
										{rate(rule.rates.cacheWrite)}
										{rule.rates.cacheWrite1h !== undefined && (
											<span className="block text-[9px] text-muted-foreground">
												1h {rate(rule.rates.cacheWrite1h)}
											</span>
										)}
									</td>
									<td className="px-3 py-2.5 tabular-nums">
										{rate(rule.rates.output)}
									</td>
								</>
							) : (
								<td
									colSpan={4}
									className="px-3 py-2.5 text-[9px] tracking-widest text-[var(--status-warning)] uppercase"
								>
									Unpriced
								</td>
							)}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function AliasesTable({ aliases }: { aliases: PricingCatalogAliasView[] }) {
	return (
		<div className="overflow-x-auto border border-border bg-card">
			<table className="w-full min-w-[620px] text-left text-xs">
				<thead className="border-b border-border bg-secondary/40 text-[9px] tracking-widest text-muted-foreground uppercase">
					<tr>
						<th className="px-3 py-2 font-normal">Alias</th>
						<th className="px-3 py-2 font-normal">Resolves to</th>
						<th className="px-3 py-2 font-normal">Effective UTC</th>
					</tr>
				</thead>
				<tbody className="divide-y divide-border">
					{aliases.map((rule) => (
						<tr
							key={`${rule.source}:${rule.provider}:${rule.alias}:${rule.effectiveFrom ?? ""}:${rule.effectiveUntil ?? ""}`}
							title={rule.note}
						>
							<td className="px-3 py-2.5">
								<div className="flex items-center gap-2">
									<span className="font-mono">{rule.alias}</span>
									{sourceBadge(rule.source)}
								</div>
								<div className="mt-1 text-[9px] tracking-wider text-muted-foreground uppercase">
									{rule.provider}
								</div>
								{rule.note && (
									<div className="mt-1 max-w-72 text-[9px] text-muted-foreground">
										{rule.note}
									</div>
								)}
							</td>
							<td className="px-3 py-2.5 font-mono">{rule.model}</td>
							<td className="px-3 py-2.5 text-muted-foreground">
								{effectiveWindow(rule)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

async function responseBody(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return {};
	}
}

function apiError(body: unknown, fallback: string): string {
	if (
		typeof body === "object" &&
		body !== null &&
		"error" in body &&
		typeof body.error === "string"
	) {
		return body.error;
	}
	return fallback;
}

function isCatalog(body: unknown): body is PricingCatalogState {
	return (
		typeof body === "object" &&
		body !== null &&
		"path" in body &&
		typeof body.path === "string" &&
		"text" in body &&
		typeof body.text === "string" &&
		"models" in body &&
		Array.isArray(body.models) &&
		"aliases" in body &&
		Array.isArray(body.aliases)
	);
}

export function PricingSection() {
	const [catalog, setCatalog] = useState<PricingCatalogState | null>(null);
	const [text, setText] = useState("");
	const [savedText, setSavedText] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [status, setStatus] = useState<string | null>(null);
	const dirty = text !== savedText;

	const applyCatalog = useCallback((next: PricingCatalogState) => {
		setCatalog(next);
		setText(next.text);
		setSavedText(next.text);
	}, []);

	const load = useCallback(async () => {
		setLoading(true);
		setStatus(null);
		try {
			const response = await fetch("/api/pricing", { cache: "no-store" });
			const body = await responseBody(response);
			if (!response.ok)
				throw new Error(apiError(body, "Failed to load pricing catalog"));
			if (!isCatalog(body)) throw new Error("Invalid pricing catalog response");
			applyCatalog(body);
		} catch (error) {
			setStatus(
				error instanceof Error ? error.message : "Failed to load pricing",
			);
		} finally {
			setLoading(false);
		}
	}, [applyCatalog]);

	useEffect(() => {
		void load();
	}, [load]);

	async function save() {
		setSaving(true);
		setStatus("Validating…");
		try {
			const response = await fetch("/api/pricing", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text }),
			});
			const body = await responseBody(response);
			if (!response.ok) throw new Error(apiError(body, "Save failed"));
			if (!isCatalog(body)) throw new Error("Invalid pricing catalog response");
			applyCatalog(body);
			setStatus("Pricing overrides saved");
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "Save failed");
		} finally {
			setSaving(false);
		}
	}

	if (loading && !catalog) {
		return (
			<div className="border border-border bg-card p-6 text-xs text-muted-foreground">
				Loading pricing catalog…
			</div>
		);
	}
	if (!catalog) {
		return (
			<div className="border border-destructive/40 bg-card p-4 space-y-3 text-xs">
				<p className="text-destructive">{status ?? "Pricing unavailable"}</p>
				<button
					type="button"
					onClick={() => void load()}
					className="border border-border px-3 py-1.5 text-[10px] tracking-widest uppercase hover:bg-accent"
				>
					Retry
				</button>
			</div>
		);
	}

	const localModels = catalog.models.filter((rule) => rule.source === "local");
	const localAliases = catalog.aliases.filter(
		(rule) => rule.source === "local",
	);

	return (
		<div className="space-y-6">
			<section className="space-y-2">
				<div className="px-1">
					<h3 className="text-[10px] tracking-widest text-muted-foreground uppercase">
						Model rates
					</h3>
					<p className="mt-1 text-xs text-muted-foreground">
						USD per million tokens. Local rules take precedence only inside
						their effective window.
					</p>
				</div>
				<ModelsTable models={catalog.models} />
			</section>

			<section className="space-y-2">
				<div className="px-1">
					<h3 className="text-[10px] tracking-widest text-muted-foreground uppercase">
						Alias timeline
					</h3>
					<p className="mt-1 text-xs text-muted-foreground">
						Use dated aliases for moving labels such as codex-auto-review.
					</p>
				</div>
				<AliasesTable aliases={catalog.aliases} />
			</section>

			<section className="border border-border bg-card p-4 space-y-4">
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div>
						<h3 className="text-sm font-medium">Local override file</h3>
						<p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
							{catalog.path}
						</p>
					</div>
					<span className="text-[9px] tracking-widest text-muted-foreground uppercase">
						{localModels.length} model rules · {localAliases.length} alias rules
					</span>
				</div>
				<div className="border border-primary/20 bg-primary/5 p-3 text-xs text-muted-foreground">
					Built-ins are read-only. Existing priced ledger rows stay frozen;
					overrides apply to fallback estimates recorded after save. Dates are
					UTC and <code>effective_until</code> is exclusive.
				</div>
				{catalog.error && (
					<div className="whitespace-pre-wrap border border-destructive/40 p-3 text-xs text-destructive">
						The saved override file is invalid, so Hlið is using built-ins only.
						{"\n"}
						{catalog.error}
					</div>
				)}
				<textarea
					aria-label="Pricing overrides TOML"
					spellCheck={false}
					value={text}
					onChange={(event) => {
						setText(event.target.value);
						setStatus(null);
					}}
					className="min-h-80 w-full border border-border bg-secondary p-3 font-mono text-xs focus:border-primary/50 focus:outline-none"
				/>
				<div className="flex flex-wrap items-center gap-3">
					<button
						type="button"
						onClick={() => void save()}
						disabled={!dirty || saving || loading}
						className="border border-border px-3 py-1.5 text-[10px] tracking-widest uppercase hover:bg-accent disabled:opacity-40"
					>
						{saving ? "Saving…" : "Validate & save"}
					</button>
					<button
						type="button"
						onClick={() => void load()}
						disabled={saving || loading}
						className="px-3 py-1.5 text-[10px] tracking-widest text-muted-foreground uppercase hover:text-foreground disabled:opacity-40"
					>
						{loading ? "Reloading…" : dirty ? "Discard & reload" : "Reload"}
					</button>
					<span
						aria-live="polite"
						className={`whitespace-pre-wrap text-xs ${status && !status.includes("saved") && status !== "Validating…" ? "text-destructive" : "text-muted-foreground"}`}
					>
						{status ?? (dirty ? "Unsaved changes" : "")}
					</span>
				</div>
			</section>
		</div>
	);
}
