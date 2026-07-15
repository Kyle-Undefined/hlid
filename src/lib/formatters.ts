const MODEL_LABELS: Record<string, string> = {
	"claude-opus-4-8": "Opus 4.8",
	"claude-opus-4-7": "Opus 4.7",
	"claude-sonnet-4-6": "Sonnet 4.6",
	"claude-haiku-4-5-20251001": "Haiku 4.5",
};

/** Strip the dated suffix the SDK reports (e.g. "-20251001"). */
export function normalizeModel(model: string): string {
	return model.replace(/-\d{8}$/, "");
}

/**
 * Stable identity used only for configured-vs-runtime comparisons.
 *
 * Claude's moving family aliases can be reported with a concrete release or
 * context suffix (for example `fable-5[1m]`) even when the configured picker
 * value is the family alias. Treat Fable, Sonnet, and Opus as family-stable so
 * those provider-side spellings do not create a false "different" badge.
 */
export function modelComparisonKey(model: string): string {
	const normalized = normalizeModel(model).toLowerCase();
	for (const family of ["fable", "sonnet", "opus"] as const) {
		if (new RegExp(`(^|[^a-z])${family}([^a-z]|$)`).test(normalized)) {
			return family;
		}
	}
	return normalized;
}

/**
 * Resolve the "effective" model for mismatch comparison + the mismatch flag.
 *
 * `actualModel` (from per-inference usage events) is authoritative once a turn
 * has run. Before that, the active session selection is used. Both are compared
 * with the configured Einherjar model, or the configured Vault model when no
 * Einherjar is active.
 */
export function deriveModelMismatch(
	configuredModel: string | null | undefined,
	actualModel: string | null | undefined,
	selectedModel: string | null | undefined,
): { effectiveActualModel: string | null; mismatch: boolean } {
	const effectiveActualModel = actualModel ?? selectedModel ?? null;
	const mismatch =
		!!effectiveActualModel &&
		!!configuredModel &&
		modelComparisonKey(effectiveActualModel) !==
			modelComparisonKey(configuredModel);
	return { effectiveActualModel, mismatch };
}

/** Short human label for a model ID. Falls back to stripping prefix/datestamp. */
export function fmtModel(model: string): string {
	const normalized = normalizeModel(model);
	return (
		MODEL_LABELS[model] ??
		MODEL_LABELS[normalized] ??
		normalized.replace("claude-", "")
	);
}

export function fmt(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

export function fmtMs(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

export function fmtDate(unixSecs: number): string {
	return new Date(unixSecs * 1000).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/** Deterministic date text for SSR before the browser applies its locale. */
export function fmtDateUtc(unixSecs: number): string {
	return new Date(unixSecs * 1000).toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		timeZone: "UTC",
		timeZoneName: "short",
	});
}

export function fmtRunTime(unixSecs: number): string {
	const d = new Date(unixSecs * 1000);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function fmtBytes(n: number): string {
	if (n < 0) throw new RangeError("fmtBytes: n must be non-negative");
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtResetTime(unixSecs: number): string {
	const diff = unixSecs - Date.now() / 1000;
	if (diff <= 0) return "now";
	const h = Math.floor(diff / 3600);
	const m = Math.floor((diff % 3600) / 60);
	if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}
