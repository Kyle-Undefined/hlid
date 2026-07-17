import type { CanonicalTokenUsage } from "./codexPricing";
import { type PricingTokenRates, resolvePricing } from "./pricingCatalog";

/**
 * Published first-party Claude API prices in USD per million tokens.
 * Aggregate history does not retain cache TTL, so estimates use the published
 * five-minute cache-write rate while the catalog also displays the one-hour rate.
 *
 * Sources checked 2026-07-17:
 * https://platform.claude.com/docs/en/about-claude/pricing
 * https://www.anthropic.com/news/claude-sonnet-5
 */

export type ClaudeTokenRates = {
	input: number;
	cacheRead: number;
	cacheWrite5m: number;
	cacheWrite1h: number;
	output: number;
};

export type ClaudePricingEntry = {
	model: string;
	rates: ClaudeTokenRates;
};

function asClaudeRates(rates: PricingTokenRates): ClaudeTokenRates {
	return {
		input: rates.input,
		cacheRead: rates.cachedInput,
		cacheWrite5m: rates.cacheWrite,
		cacheWrite1h: rates.cacheWrite1h ?? rates.cacheWrite,
		output: rates.output,
	};
}

export function getClaudePricing(
	model: string | null | undefined,
	atMs = Date.now(),
): ClaudePricingEntry | null {
	const resolved = resolvePricing("claude", model, atMs);
	return resolved?.rates
		? { model: resolved.model, rates: asClaudeRates(resolved.rates) }
		: null;
}

export function estimateClaudeCost(
	model: string | null | undefined,
	usage: CanonicalTokenUsage,
	atMs = Date.now(),
): number | null {
	const rates = getClaudePricing(model, atMs)?.rates;
	if (!rates) return null;
	return (
		(usage.inputTokens * rates.input +
			usage.cacheReadTokens * rates.cacheRead +
			usage.cacheCreationTokens * rates.cacheWrite5m +
			usage.outputTokens * rates.output) /
		1_000_000
	);
}
