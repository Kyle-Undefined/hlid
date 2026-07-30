import type { ProviderInfo } from "../lib/providerTypes";
import type { HlidOrchestrationTargetCatalog } from "./hlidHelp";
import { boundedValue } from "./hlidHelpValue";

const MAX_PROVIDERS = 12;
const MAX_MODELS = 8;
const MAX_EFFORTS = 4;
const MAX_SERVICE_TIERS = 4;

type ProviderTarget = HlidOrchestrationTargetCatalog["providers"][number];
type ModelTarget = ProviderTarget["models"]["items"][number];
type ProviderModel = NonNullable<ProviderInfo["models"]>[number];
type ExactOptions = NonNullable<ModelTarget["efforts"]>;

type CatalogContext = {
	totalProviders: number;
	availableProviders: number;
	maxChars: number;
};

function catalogWith(
	context: CatalogContext,
	providers: ProviderTarget[],
): HlidOrchestrationTargetCatalog {
	return {
		source: "live-provider-catalog",
		snapshot: "current",
		totalProviders: context.totalProviders,
		availableProviders: context.availableProviders,
		returnedProviders: providers.length,
		truncated: providers.length < context.totalProviders,
		providers,
	};
}

function fitsCatalog(
	context: CatalogContext,
	providers: ProviderTarget[],
): boolean {
	return (
		JSON.stringify(catalogWith(context, providers)).length <= context.maxChars
	);
}

function createProviderTarget(
	provider: ProviderInfo,
	models: ProviderModel[],
): ProviderTarget {
	const providerEfforts = provider.effortLevels ?? [];
	return {
		id: provider.id,
		label: boundedValue(provider.label, 80),
		available: provider.available,
		...(provider.unavailableReason
			? { unavailableReason: boundedValue(provider.unavailableReason, 160) }
			: {}),
		...(providerEfforts.length
			? {
					effortLevels: {
						total: providerEfforts.length,
						returned: 0,
						truncated: true,
						items: [],
					},
				}
			: {}),
		models: {
			total: models.length,
			returned: 0,
			truncated: models.length > 0,
			items: [],
		},
	};
}

function createModelTarget(model: ProviderModel): ModelTarget {
	const efforts = model.efforts ?? [];
	const serviceTiers = model.serviceTiers ?? [];
	return {
		value: model.value,
		label: boundedValue(model.label, 80),
		...(model.isDefault ? { isDefault: true } : {}),
		...(efforts.length
			? {
					efforts: {
						total: efforts.length,
						returned: 0,
						truncated: true,
						items: [],
					},
				}
			: {}),
		...(serviceTiers.length
			? {
					serviceTiers: {
						total: serviceTiers.length,
						returned: 0,
						truncated: true,
						items: [],
					},
				}
			: {}),
	};
}

function withModel(
	provider: ProviderTarget,
	model: ModelTarget,
): ProviderTarget {
	const items = [...provider.models.items, model];
	return {
		...provider,
		models: {
			total: provider.models.total,
			returned: items.length,
			truncated: items.length < provider.models.total,
			items,
		},
	};
}

function withModelOptions(
	model: ModelTarget,
	field: "efforts" | "serviceTiers",
	options: ExactOptions,
): ModelTarget {
	return field === "efforts"
		? { ...model, efforts: options }
		: { ...model, serviceTiers: options };
}

function appendModelOptions(
	model: ModelTarget,
	values: readonly { value: string }[],
	field: "efforts" | "serviceTiers",
	limit: number,
	fits: (candidate: ModelTarget) => boolean,
): ModelTarget {
	let result = model;
	for (const option of values.slice(0, limit)) {
		const items = [...(result[field]?.items ?? []), option.value];
		const candidate = withModelOptions(result, field, {
			total: values.length,
			returned: items.length,
			truncated: items.length < values.length,
			items,
		});
		if (!fits(candidate)) break;
		result = candidate;
	}
	return result;
}

function appendModels(
	context: CatalogContext,
	acceptedProviders: ProviderTarget[],
	initial: ProviderTarget,
	models: ProviderModel[],
): ProviderTarget {
	let result = initial;
	for (const model of models.slice(0, MAX_MODELS)) {
		let target = createModelTarget(model);
		const fits = (candidate: ModelTarget) =>
			fitsCatalog(context, [
				...acceptedProviders,
				withModel(result, candidate),
			]);
		if (!fits(target)) continue;
		target = appendModelOptions(
			target,
			model.efforts ?? [],
			"efforts",
			MAX_EFFORTS,
			fits,
		);
		target = appendModelOptions(
			target,
			model.serviceTiers ?? [],
			"serviceTiers",
			MAX_SERVICE_TIERS,
			fits,
		);
		result = withModel(result, target);
	}
	return result;
}

function appendProviderEfforts(
	context: CatalogContext,
	acceptedProviders: ProviderTarget[],
	provider: ProviderInfo,
	initial: ProviderTarget,
): ProviderTarget {
	const efforts = provider.effortLevels ?? [];
	let result = initial;
	for (const effort of efforts.slice(0, MAX_EFFORTS)) {
		const items = [...(result.effortLevels?.items ?? []), effort.value];
		const candidate: ProviderTarget = {
			...result,
			effortLevels: {
				total: efforts.length,
				returned: items.length,
				truncated: items.length < efforts.length,
				items,
			},
		};
		if (!fitsCatalog(context, [...acceptedProviders, candidate])) break;
		result = candidate;
	}
	return result;
}

function buildProviderTarget(
	context: CatalogContext,
	acceptedProviders: ProviderTarget[],
	provider: ProviderInfo,
): ProviderTarget | null {
	const models = (provider.models ?? []).filter((model) => !model.hidden);
	let target = createProviderTarget(provider, models);
	if (!fitsCatalog(context, [...acceptedProviders, target])) return null;
	target = appendModels(context, acceptedProviders, target, models);
	return appendProviderEfforts(context, acceptedProviders, provider, target);
}

function orderedProviders(providerCatalog: readonly ProviderInfo[]) {
	return providerCatalog
		.map((provider, index) => ({ provider, index }))
		.sort(
			(left, right) =>
				Number(right.provider.available) - Number(left.provider.available) ||
				left.index - right.index,
		)
		.slice(0, MAX_PROVIDERS);
}

export function buildOrchestrationTargetCatalog(
	providerCatalog: readonly ProviderInfo[] | undefined,
	maxChars: number,
): HlidOrchestrationTargetCatalog {
	if (!providerCatalog) {
		return {
			source: "live-provider-catalog",
			snapshot: "unavailable",
			totalProviders: 0,
			availableProviders: 0,
			returnedProviders: 0,
			truncated: false,
			providers: [],
		};
	}
	const context = {
		totalProviders: providerCatalog.length,
		availableProviders: providerCatalog.filter((provider) => provider.available)
			.length,
		maxChars,
	};
	const providers: ProviderTarget[] = [];
	for (const { provider } of orderedProviders(providerCatalog)) {
		const target = buildProviderTarget(context, providers, provider);
		if (target) providers.push(target);
	}
	return catalogWith(context, providers);
}
