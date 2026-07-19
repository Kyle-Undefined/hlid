import { estimateClaudeCost } from "./claudePricing";
import { type CanonicalTokenUsage, estimateCodexCost } from "./codexPricing";
import { isCliProxyProvider } from "./providerIds";

function routedModel(
	model: string | null | undefined,
): string | null | undefined {
	if (!model) return model;
	const withoutProvider = model.includes("/")
		? model.slice(model.indexOf("/") + 1)
		: model;
	return withoutProvider.replace(
		/\((?:none|auto|minimal|low|medium|high|xhigh|\d+)\)$/i,
		"",
	);
}

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
	if (isCliProxyProvider(providerId)) {
		const actualModel = routedModel(model);
		return (
			estimateClaudeCost(actualModel, usage, atMs) ??
			estimateCodexCost(actualModel, usage, { webSearchCalls: 0 }, atMs)
		);
	}
	if (providerId === "codex") {
		return estimateCodexCost(model, usage, { webSearchCalls: 0 }, atMs);
	}
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
