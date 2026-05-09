const MODEL_LABELS: Record<string, string> = {
	"claude-opus-4-7": "Opus 4.7",
	"claude-sonnet-4-6": "Sonnet 4.6",
	"claude-haiku-4-5-20251001": "Haiku 4.5",
};

/** Strip the dated suffix the SDK reports (e.g. "-20251001"). */
export function normalizeModel(model: string): string {
	return model.replace(/-\d{8}$/, "");
}

/**
 * Resolve the "effective" model for mismatch comparison + the mismatch flag.
 *
 * `actualModel` (from per-inference usage events) is authoritative once a turn
 * has run. Before that, the selected agent's configured model is used so the
 * badge surfaces an opus-vs-sonnet override before any inference occurs.
 */
export function deriveModelMismatch(
	vaultModel: string | null | undefined,
	actualModel: string | null | undefined,
	agentModel: string | null | undefined,
): { effectiveActualModel: string | null; mismatch: boolean } {
	const effectiveActualModel = actualModel ?? agentModel ?? null;
	const mismatch =
		!!effectiveActualModel &&
		!!vaultModel &&
		normalizeModel(effectiveActualModel) !== normalizeModel(vaultModel);
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
