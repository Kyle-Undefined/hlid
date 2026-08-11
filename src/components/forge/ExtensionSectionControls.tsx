import { useCallback, useEffect, useMemo, useState } from "react";
import { includesSearchText } from "#/lib/search";
import type {
	AvailableExtension,
	ExtensionInventory,
	ExtensionProviderId,
	ProviderExtension,
	ProviderMarketplace,
} from "#/server/extensionInventory";

export type ExtensionSectionView = "installed" | "marketplace";

const PROVIDERS = [
	{ id: "claude" as const, label: "Claude" },
	{ id: "codex" as const, label: "Codex" },
];

function environmentLabels(
	extensions: ProviderExtension[],
	marketplaces: ProviderMarketplace[],
): string[] {
	return [
		...new Set([
			...extensions.map((item) => item.environmentLabel),
			...marketplaces.map((item) => item.environmentLabel),
		]),
	].sort();
}

function matchingInstalledExtensions(
	inventory: ExtensionInventory,
	provider: ExtensionProviderId,
	search: string,
): ProviderExtension[] {
	return inventory.extensions.filter(
		(item) =>
			item.providerId === provider &&
			(!search.trim() ||
				includesSearchText(
					`${item.displayName} ${item.name} ${item.pluginId} ${item.description} ${item.marketplace} ${item.environmentLabel} ${item.components.map((component) => component.label).join(" ")}`,
					search,
				)),
	);
}

function matchingAvailableExtensions(
	inventory: ExtensionInventory,
	provider: ExtensionProviderId,
	environment: string,
	category: string,
	search: string,
): AvailableExtension[] {
	return inventory.available
		.filter(
			(item) =>
				item.providerId === provider &&
				(environment === "all" || item.environmentLabel === environment) &&
				(category === "all" || item.category === category),
		)
		.filter(
			(item) =>
				!search.trim() ||
				includesSearchText(
					`${item.displayName} ${item.name} ${item.pluginId} ${item.description} ${item.marketplace} ${item.environmentLabel} ${item.category} ${item.source}`,
					search,
				),
		);
}

export function useExtensionSectionViewModel(
	inventory: ExtensionInventory,
	clearReview: () => void,
	requestedView: ExtensionSectionView = "installed",
	requestedProvider?: ExtensionProviderId,
) {
	const [provider, setProvider] = useState<ExtensionProviderId>(
		requestedProvider ?? "claude",
	);
	const [view, setView] = useState<ExtensionSectionView>(requestedView);
	const [search, setSearch] = useState("");
	const [environment, setEnvironment] = useState("all");
	const [category, setCategory] = useState("all");
	useEffect(() => {
		setView(requestedView);
		if (requestedProvider) setProvider(requestedProvider);
		setEnvironment("all");
		setCategory("all");
		clearReview();
	}, [clearReview, requestedProvider, requestedView]);
	const changeContext = useCallback(
		(next: { provider?: ExtensionProviderId; view?: ExtensionSectionView }) => {
			if (next.provider) setProvider(next.provider);
			if (next.view) setView(next.view);
			setEnvironment("all");
			setCategory("all");
			clearReview();
		},
		[clearReview],
	);
	const providerExtensions = useMemo(
		() => matchingInstalledExtensions(inventory, provider, search),
		[inventory, provider, search],
	);
	const providerMarketplaces = useMemo(
		() => inventory.marketplaces.filter((item) => item.providerId === provider),
		[inventory.marketplaces, provider],
	);
	const providerEnvironments = useMemo(
		() => inventory.environments.filter((item) => item.providerId === provider),
		[inventory.environments, provider],
	);
	const providerAvailable = useMemo(
		() =>
			matchingAvailableExtensions(
				inventory,
				provider,
				environment,
				category,
				search,
			),
		[inventory, provider, environment, category, search],
	);
	const availableEnvironments = [
		...new Set(
			inventory.available
				.filter((item) => item.providerId === provider)
				.map((item) => item.environmentLabel),
		),
	].sort();
	const availableCategories = [
		...new Set(
			inventory.available
				.filter(
					(item) =>
						item.providerId === provider &&
						(environment === "all" || item.environmentLabel === environment) &&
						item.category,
				)
				.map((item) => item.category),
		),
	].sort();
	return {
		provider,
		view,
		search,
		environment,
		category,
		providerExtensions,
		providerMarketplaces,
		providerEnvironments,
		providerAvailable,
		labels: environmentLabels(providerExtensions, providerMarketplaces),
		availableEnvironments,
		availableCategories,
		providerErrors: inventory.errors.filter(
			(item) => item.providerId === provider,
		),
		changeProvider: (value: ExtensionProviderId) =>
			changeContext({ provider: value }),
		changeView: (value: ExtensionSectionView) => changeContext({ view: value }),
		setSearch,
		setEnvironment,
		setCategory,
	};
}

export type ExtensionSectionViewModel = ReturnType<
	typeof useExtensionSectionViewModel
>;

export function ExtensionSectionControls({
	model,
	loading,
	mutationActive,
	onRefresh,
}: {
	model: ExtensionSectionViewModel;
	loading: boolean;
	mutationActive: boolean;
	onRefresh: () => void;
}) {
	const searchLabel =
		model.view === "installed"
			? "Filter installed extensions"
			: "Search marketplaces";
	return (
		<>
			<div className="flex min-w-0 flex-col gap-2 @4xl:flex-row @4xl:items-center">
				<div
					data-forge-setting-label="extension provider"
					tabIndex={-1}
					className="inline-flex self-start border border-border bg-secondary p-1"
					role="tablist"
					aria-label="Extension provider"
				>
					{PROVIDERS.map((item) => (
						<button
							key={item.id}
							type="button"
							role="tab"
							aria-selected={model.provider === item.id}
							onClick={() => model.changeProvider(item.id)}
							className={`px-3 py-1.5 text-[10px] tracking-widest uppercase ${
								model.provider === item.id
									? "bg-primary/10 text-primary"
									: "text-muted-foreground hover:text-foreground"
							}`}
						>
							{item.label}
						</button>
					))}
				</div>
				<div
					data-forge-setting-label={
						model.view === "marketplace"
							? "extension marketplace"
							: "installed extensions"
					}
					tabIndex={-1}
					className="inline-flex self-start border border-border bg-secondary p-1"
					role="tablist"
					aria-label="Extension view"
				>
					{(["installed", "marketplace"] as const).map((item) => (
						<button
							key={item}
							type="button"
							role="tab"
							aria-selected={model.view === item}
							onClick={() => model.changeView(item)}
							className={`px-3 py-1.5 text-[10px] tracking-widest uppercase ${
								model.view === item
									? "bg-primary/10 text-primary"
									: "text-muted-foreground hover:text-foreground"
							}`}
						>
							{item}
						</button>
					))}
				</div>
				<input
					data-forge-setting-label={searchLabel.toLowerCase()}
					value={model.search}
					onChange={(event) => model.setSearch(event.target.value)}
					placeholder={searchLabel}
					aria-label={searchLabel}
					className="min-w-0 flex-1 bg-input border border-border px-2.5 py-1.5 text-xs @4xl:min-w-40"
				/>
				<button
					data-forge-setting-label="refresh extension inventory"
					type="button"
					onClick={onRefresh}
					disabled={loading || mutationActive}
					className="self-start border border-border px-3 py-1.5 text-[10px] tracking-widest uppercase disabled:opacity-50"
				>
					{loading ? "Inspecting…" : "Refresh"}
				</button>
			</div>
			{model.view === "marketplace" && (
				<div className="flex flex-col gap-2 sm:flex-row">
					<select
						data-forge-setting-label="marketplace environment"
						value={model.environment}
						onChange={(event) => model.setEnvironment(event.target.value)}
						aria-label="Marketplace environment"
						className="bg-input border border-border px-2.5 py-1.5 text-xs"
					>
						<option value="all">All environments</option>
						{model.availableEnvironments.map((label) => (
							<option key={label} value={label}>
								{label}
							</option>
						))}
					</select>
					<select
						data-forge-setting-label="marketplace category"
						value={model.category}
						onChange={(event) => model.setCategory(event.target.value)}
						aria-label="Marketplace category"
						className="bg-input border border-border px-2.5 py-1.5 text-xs"
					>
						<option value="all">All categories</option>
						{model.availableCategories.map((label) => (
							<option key={label} value={label}>
								{label}
							</option>
						))}
					</select>
				</div>
			)}
		</>
	);
}
