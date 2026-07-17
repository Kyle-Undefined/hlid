import { estimateClaudeCost } from "./claudePricing";
import { type CanonicalTokenUsage, estimateCodexCost } from "./codexPricing";

export function isSyntheticModel(model: string | null | undefined): boolean {
	return model?.trim().toLowerCase() === "<synthetic>";
}

/** API-equivalent fallback estimate when the provider did not report a cost. */
export function estimateProviderCost(
	providerId: string,
	model: string | null | undefined,
	usage: CanonicalTokenUsage,
	atMs = Date.now(),
): number | null {
	if (providerId === "codex") return estimateCodexCost(model, usage);
	if (providerId === "claude") return estimateClaudeCost(model, usage, atMs);
	return null;
}

export function hasProviderPricing(
	providerId: string,
	model: string | null | undefined,
	atMs = Date.now(),
): boolean {
	return (
		estimateProviderCost(
			providerId,
			model,
			{
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
			},
			atMs,
		) !== null
	);
}
