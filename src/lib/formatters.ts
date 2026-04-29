export const MODEL_LABELS: Record<string, string> = {
	"claude-opus-4-7": "Opus 4.7",
	"claude-sonnet-4-6": "Sonnet 4.6",
	"claude-haiku-4-5-20251001": "Haiku 4.5",
};

export function fmt(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

export function fmtMs(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
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
