import type { ProviderSessionConfigSnapshot } from "../server/agentProvider";
import type { ProviderInfo } from "./providerTypes";

/**
 * Refine one cached provider catalog row with options from its live session.
 * The caller owns session/provider scoping; this helper never mutates the
 * process-wide provider cache.
 */
export function applyLiveProviderConfig(
	providers: readonly ProviderInfo[],
	providerId: string,
	config: ProviderSessionConfigSnapshot,
): ProviderInfo[] {
	return providers.map((provider) => {
		if (provider.id !== providerId) return provider;
		let models = config.models ?? provider.models;
		if (
			config.models === undefined &&
			config.activeModel &&
			config.effortLevels
		) {
			models = models?.map((model) =>
				model.value === config.activeModel
					? { ...model, efforts: config.effortLevels }
					: model,
			);
		}
		return {
			...provider,
			...(models !== undefined ? { models } : {}),
			...(config.activeModel && config.effortLevels
				? { effortLevels: undefined }
				: {}),
			liveSessionConfig: {
				...(config.activeModel !== undefined
					? { activeModel: config.activeModel }
					: {}),
				...(config.activeEffort !== undefined
					? { activeEffort: config.activeEffort }
					: {}),
				...(config.modes !== undefined ? { modes: config.modes } : {}),
				...(config.activeMode !== undefined
					? { activeMode: config.activeMode }
					: {}),
				...(config.planModeValue !== undefined
					? { planModeValue: config.planModeValue }
					: {}),
			},
		};
	});
}
