import type { CanonicalTokenUsage } from "./codexPricing";

/**
 * Sources checked 2026-07-17:
 * https://platform.claude.com/docs/en/about-claude/pricing
 * https://www.anthropic.com/news/claude-sonnet-5
 */

/** Published first-party Claude API prices in USD per million tokens. */
export type ClaudeTokenRates = {
	input: number;
	cacheRead: number;
	/** Aggregate history does not retain cache TTL, so fallback uses the 5m rate. */
	cacheWrite5m: number;
	cacheWrite1h: number;
	output: number;
};

export type ClaudePricingEntry = {
	model: string;
	rates: ClaudeTokenRates;
};

const SONNET_5_INTRO_END_MS = Date.UTC(2026, 8, 1);

const FABLE_5: ClaudeTokenRates = {
	input: 10,
	cacheWrite5m: 12.5,
	cacheWrite1h: 20,
	cacheRead: 1,
	output: 50,
};

const OPUS_48: ClaudeTokenRates = {
	input: 5,
	cacheWrite5m: 6.25,
	cacheWrite1h: 10,
	cacheRead: 0.5,
	output: 25,
};

const OPUS_4_LEGACY: ClaudeTokenRates = {
	input: 15,
	cacheWrite5m: 18.75,
	cacheWrite1h: 30,
	cacheRead: 1.5,
	output: 75,
};

const SONNET_5_INTRO: ClaudeTokenRates = {
	input: 2,
	cacheWrite5m: 2.5,
	cacheWrite1h: 4,
	cacheRead: 0.2,
	output: 10,
};

const SONNET_5_STANDARD: ClaudeTokenRates = {
	input: 3,
	cacheWrite5m: 3.75,
	cacheWrite1h: 6,
	cacheRead: 0.3,
	output: 15,
};

const SONNET_4: ClaudeTokenRates = { ...SONNET_5_STANDARD };

const HAIKU_45: ClaudeTokenRates = {
	input: 1,
	cacheWrite5m: 1.25,
	cacheWrite1h: 2,
	cacheRead: 0.1,
	output: 5,
};

const HAIKU_35: ClaudeTokenRates = {
	input: 0.8,
	cacheWrite5m: 1,
	cacheWrite1h: 1.6,
	cacheRead: 0.08,
	output: 4,
};

export const CLAUDE_MODEL_PRICING: readonly ClaudePricingEntry[] = [
	{ model: "claude-fable-5", rates: FABLE_5 },
	{ model: "claude-mythos-5", rates: FABLE_5 },
	{ model: "claude-opus-4-8", rates: OPUS_48 },
	{ model: "claude-opus-4-7", rates: OPUS_48 },
	{ model: "claude-opus-4-6", rates: OPUS_48 },
	{ model: "claude-opus-4-5", rates: OPUS_48 },
	{ model: "claude-opus-4-1", rates: OPUS_4_LEGACY },
	{ model: "claude-opus-4", rates: OPUS_4_LEGACY },
	{ model: "claude-sonnet-4-6", rates: SONNET_4 },
	{ model: "claude-sonnet-4-5", rates: SONNET_4 },
	{ model: "claude-sonnet-4", rates: SONNET_4 },
	{ model: "claude-haiku-4-5", rates: HAIKU_45 },
	{ model: "claude-haiku-3-5", rates: HAIKU_35 },
] as const;

/**
 * Resolve exact and dated Claude model IDs. Sonnet 5 has a published time-based
 * introductory rate, so the query timestamp is part of the lookup.
 */
export function getClaudePricing(
	model: string | null | undefined,
	atMs = Date.now(),
): ClaudePricingEntry | null {
	if (!model) return null;
	const normalized = model.toLowerCase();
	if (
		normalized === "claude-sonnet-5" ||
		normalized.startsWith("claude-sonnet-5-")
	) {
		return {
			model: "claude-sonnet-5",
			rates: atMs < SONNET_5_INTRO_END_MS ? SONNET_5_INTRO : SONNET_5_STANDARD,
		};
	}
	return (
		CLAUDE_MODEL_PRICING.find(
			(entry) =>
				normalized === entry.model ||
				normalized.startsWith(`${entry.model}-20`),
		) ?? null
	);
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
