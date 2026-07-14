/**
 * Published OpenAI API-equivalent token prices for models exposed by the
 * Codex CLI model catalog. Rates are USD per one million tokens.
 *
 * These are estimates, not the user's ChatGPT/Codex subscription charge.
 * Keep unpriced preview/internal models in the catalog with `rates: null` so
 * callers never silently treat an unknown price as free.
 *
 * Sources checked 2026-07-12:
 * https://developers.openai.com/api/docs/models/gpt-5.6-sol
 * https://developers.openai.com/api/docs/models/gpt-5.6-terra
 * https://developers.openai.com/api/docs/models/gpt-5.6-luna
 * https://developers.openai.com/api/docs/models/gpt-5.5
 * https://developers.openai.com/api/docs/models/gpt-5.4
 * https://developers.openai.com/api/docs/models/gpt-5.4-mini
 */

export type CodexTokenRates = {
	input: number;
	cachedInput: number;
	cacheWrite: number;
	output: number;
	longContextThreshold?: number;
	longContextInputMultiplier?: number;
	longContextOutputMultiplier?: number;
};

export type CodexPricingEntry = {
	model: string;
	rates: CodexTokenRates | null;
	note?: string;
};

const LONG_CONTEXT = {
	longContextThreshold: 272_000,
	longContextInputMultiplier: 2,
	longContextOutputMultiplier: 1.5,
} as const;

export const CODEX_MODEL_PRICING: readonly CodexPricingEntry[] = [
	{
		model: "gpt-5.6-sol",
		rates: {
			input: 5,
			cachedInput: 0.5,
			cacheWrite: 6.25,
			output: 30,
			...LONG_CONTEXT,
		},
	},
	{
		model: "gpt-5.6-terra",
		rates: {
			input: 2.5,
			cachedInput: 0.25,
			cacheWrite: 3.125,
			output: 15,
			...LONG_CONTEXT,
		},
	},
	{
		model: "gpt-5.6-luna",
		rates: {
			input: 1,
			cachedInput: 0.1,
			cacheWrite: 1.25,
			output: 6,
			...LONG_CONTEXT,
		},
	},
	{
		model: "gpt-5.5",
		rates: {
			input: 5,
			cachedInput: 0.5,
			cacheWrite: 5,
			output: 30,
			...LONG_CONTEXT,
		},
	},
	{
		model: "gpt-5.4",
		rates: {
			input: 2.5,
			cachedInput: 0.25,
			cacheWrite: 2.5,
			output: 15,
			...LONG_CONTEXT,
		},
	},
	{
		model: "gpt-5.4-mini",
		rates: {
			input: 0.75,
			cachedInput: 0.075,
			cacheWrite: 0.75,
			output: 4.5,
		},
	},
	{
		model: "gpt-5.3-codex-spark",
		rates: null,
		note: "Research preview; OpenAI has not published a finalized rate.",
	},
	{
		model: "codex-auto-review",
		rates: null,
		note: "Internal hidden model; no public token price.",
	},
] as const;

export type CanonicalTokenUsage = {
	/** Input tokens processed without a cache read/write discount. */
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
};

export type CodexHostedToolUsage = {
	/** OpenAI-hosted web search calls, including search/open/find actions. */
	webSearchCalls: number;
};

/** USD per call. OpenAI publishes web search at $10 per 1,000 calls. */
export const CODEX_HOSTED_TOOL_RATES = {
	webSearch: 10 / 1_000,
} as const;

export function canonicalizeCodexUsage(usage: {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
}): CanonicalTokenUsage {
	const cacheReadTokens = Math.max(0, usage.cacheReadTokens ?? 0);
	const cacheCreationTokens = Math.max(0, usage.cacheCreationTokens ?? 0);
	// OpenAI reports cached_tokens/cache_write_tokens inside total input tokens.
	// Hlid's provider-neutral schema stores uncached input and cache buckets as
	// disjoint values (matching Claude), so subtract both cache buckets here.
	const inputTokens = Math.max(
		0,
		usage.inputTokens - cacheReadTokens - cacheCreationTokens,
	);
	return {
		inputTokens,
		outputTokens: Math.max(0, usage.outputTokens),
		cacheReadTokens,
		cacheCreationTokens,
	};
}

export function getCodexPricing(
	model: string | null | undefined,
): CodexPricingEntry | null {
	if (!model) return null;
	const normalized = model.toLowerCase();
	if (normalized === "gpt-5.6") {
		return (
			CODEX_MODEL_PRICING.find((entry) => entry.model === "gpt-5.6-sol") ?? null
		);
	}
	return (
		CODEX_MODEL_PRICING.find(
			(entry) =>
				normalized === entry.model ||
				normalized.startsWith(`${entry.model}-20`),
		) ?? null
	);
}

export function estimateCodexCost(
	model: string | null | undefined,
	usage: CanonicalTokenUsage,
	hostedTools: CodexHostedToolUsage = { webSearchCalls: 0 },
): number | null {
	const rates = getCodexPricing(model)?.rates;
	if (!rates) return null;
	const promptTokens =
		usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
	const isLong =
		rates.longContextThreshold != null &&
		promptTokens > rates.longContextThreshold;
	const inputMultiplier = isLong ? (rates.longContextInputMultiplier ?? 1) : 1;
	const outputMultiplier = isLong
		? (rates.longContextOutputMultiplier ?? 1)
		: 1;
	const tokenCost =
		(usage.inputTokens * rates.input * inputMultiplier +
			usage.cacheReadTokens * rates.cachedInput * inputMultiplier +
			usage.cacheCreationTokens * rates.cacheWrite * inputMultiplier +
			usage.outputTokens * rates.output * outputMultiplier) /
		1_000_000;
	return (
		tokenCost +
		Math.max(0, hostedTools.webSearchCalls) * CODEX_HOSTED_TOOL_RATES.webSearch
	);
}
