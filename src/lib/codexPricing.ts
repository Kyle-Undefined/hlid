import { type PricingTokenRates, resolvePricing } from "./pricingCatalog";

/**
 * Published OpenAI API-equivalent token prices for models exposed by the
 * Codex CLI model catalog. Rates are USD per one million tokens.
 *
 * These are estimates, not the user's ChatGPT/Codex subscription charge.
 * Built-in rates live in the shared effective-dated catalog and can be
 * supplemented by pricing-overrides.toml without changing application code.
 *
 * Sources checked 2026-07-17:
 * https://developers.openai.com/api/docs/models/gpt-5.6-sol
 * https://developers.openai.com/api/docs/models/gpt-5.6-terra
 * https://developers.openai.com/api/docs/models/gpt-5.6-luna
 * https://developers.openai.com/api/docs/models/gpt-5.5
 * https://developers.openai.com/api/docs/models/gpt-5.4
 * https://developers.openai.com/api/docs/models/gpt-5.4-mini
 * https://developers.openai.com/api/docs/models/gpt-5.3-codex
 * https://help.openai.com/en/articles/20001106-codex-rate-card
 */

export type CodexTokenRates = PricingTokenRates;

export type CodexPricingEntry = {
	model: string;
	rates: CodexTokenRates | null;
	note?: string;
};

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
	atMs = Date.now(),
): CodexPricingEntry | null {
	const resolved = resolvePricing("codex", model, atMs);
	return resolved
		? {
				model: resolved.model,
				rates: resolved.rates,
				...(resolved.note ? { note: resolved.note } : {}),
			}
		: null;
}

export function estimateCodexCost(
	model: string | null | undefined,
	usage: CanonicalTokenUsage,
	hostedTools: CodexHostedToolUsage = { webSearchCalls: 0 },
	atMs = Date.now(),
): number | null {
	const rates = getCodexPricing(model, atMs)?.rates;
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
