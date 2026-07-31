import { ExtensionInstalledView } from "./ExtensionInstalledView";
import {
	ExtensionMarketplaceView,
	MarketplaceSourceForm,
	useMarketplaceSourceDraft,
} from "./ExtensionMarketplaceView";
import {
	ExtensionSectionControls,
	useExtensionSectionViewModel,
} from "./ExtensionSectionControls";
import { Section } from "./fields";
import {
	type ExtensionSectionController,
	useExtensionSectionController,
} from "./useExtensionSectionController";

function ProviderInspectionErrors({
	controller,
	errors,
}: {
	controller: ExtensionSectionController;
	errors: ExtensionSectionController["inventory"]["errors"];
}) {
	return errors.map((item) => (
		<div
			key={`${item.environmentLabel}-${item.message}`}
			className="flex flex-wrap items-center justify-between gap-2 border border-status-warning/20 bg-status-warning/5 px-3 py-2 text-xs text-status-warning"
		>
			<span className="min-w-0 break-words [overflow-wrap:anywhere]">
				{item.environmentLabel}: {item.message}
			</span>
			{item.recovery === "retry_inventory" && (
				<button
					type="button"
					onClick={() => void controller.retryInspection()}
					disabled={controller.loading || controller.mutation.hasActive}
					className="border border-status-warning/40 px-2 py-1 text-[9px] tracking-widest uppercase disabled:opacity-40"
				>
					{controller.loading ? "Retrying…" : "Retry inspection"}
				</button>
			)}
		</div>
	));
}

export function ExtensionsSection() {
	const controller = useExtensionSectionController();
	const model = useExtensionSectionViewModel(
		controller.inventory,
		controller.clearReview,
	);
	const marketplaceSourceDraft = useMarketplaceSourceDraft(
		model.providerEnvironments,
	);
	const initiallyLoading =
		controller.loading &&
		controller.inventory.extensions.length === 0 &&
		controller.inventory.available.length === 0;
	return (
		<Section
			title="Provider Extensions"
			description="Review, install, and remove extensions, and manage marketplace sources through each CLI's native plugin registry. Claude and Codex remain separate systems."
		>
			<div className="px-4 py-3 space-y-3">
				<ExtensionSectionControls
					model={model}
					loading={controller.loading}
					mutationActive={controller.mutation.hasActive}
					onRefresh={() => void controller.retryInspection()}
				/>
				{model.view === "marketplace" && (
					<MarketplaceSourceForm
						provider={model.provider}
						environments={model.providerEnvironments}
						mutation={controller.mutation}
						draft={marketplaceSourceDraft}
					/>
				)}
				<p className="text-xs text-muted-foreground">
					{model.view === "installed"
						? "Expand an extension to review its installation, bundled components, trust signals, and complete manifest."
						: "Browse local snapshots from the marketplaces configured in this provider environment. Review one package at a time before installing it through the provider CLI."}
				</p>
				{controller.inventoryError && (
					<p className="break-words [overflow-wrap:anywhere] text-xs text-destructive">
						{controller.inventoryError}
					</p>
				)}
				{controller.mutation.feedback.map((item) =>
					item.kind === "success" ? (
						<output
							key={item.operationId}
							className="block text-xs text-status-success"
						>
							{item.message}
						</output>
					) : (
						<div
							key={item.operationId}
							role="alert"
							className="flex min-w-0 items-start justify-between gap-3 text-xs text-destructive"
						>
							<span className="min-w-0 break-all">{item.message}</span>
							<button
								type="button"
								aria-label="Dismiss extension action error"
								onClick={() =>
									controller.mutation.dismissFeedback(
										item.targetId,
										item.operationId,
									)
								}
								className="shrink-0 text-[9px] tracking-widest uppercase text-muted-foreground hover:text-foreground"
							>
								Dismiss
							</button>
						</div>
					),
				)}
				<ProviderInspectionErrors
					controller={controller}
					errors={model.providerErrors}
				/>
			</div>
			{initiallyLoading ? (
				<div className="border-t border-border px-4 py-6 text-xs text-muted-foreground">
					Inspecting native plugin registries…
				</div>
			) : model.view === "marketplace" ? (
				<ExtensionMarketplaceView model={model} controller={controller} />
			) : (
				<ExtensionInstalledView
					model={model}
					controller={controller}
					inventoryGeneration={controller.inventoryGeneration}
				/>
			)}
		</Section>
	);
}
