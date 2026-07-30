import { MarketplaceGrid } from "./ExtensionMarketplaceView";
import type { ExtensionSectionViewModel } from "./ExtensionSectionControls";
import { InstalledExtensionCard } from "./InstalledExtensionCard";
import type { ExtensionSectionController } from "./useExtensionSectionController";

export function ExtensionInstalledView({
	model,
	controller,
	inventoryGeneration,
}: {
	model: ExtensionSectionViewModel;
	controller: ExtensionSectionController;
	inventoryGeneration: number;
}) {
	if (model.labels.length === 0) {
		return (
			<div className="border-t border-border px-4 py-6 text-xs text-muted-foreground">
				No installed {model.provider === "claude" ? "Claude" : "Codex"}{" "}
				extensions were found.
			</div>
		);
	}
	return (
		<div className="border-t border-border p-4 space-y-6">
			{model.labels.map((label) => {
				const extensions = model.providerExtensions.filter(
					(item) => item.environmentLabel === label,
				);
				const marketplaces = model.providerMarketplaces.filter(
					(item) => item.environmentLabel === label,
				);
				return (
					<div key={label} className="space-y-3">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<h3 className="text-xs tracking-widest uppercase">{label}</h3>
							<span className="text-[10px] text-muted-foreground">
								{extensions.length} installed
							</span>
						</div>
						{marketplaces.length > 0 && (
							<MarketplaceGrid
								marketplaces={marketplaces}
								mutation={controller.mutation}
							/>
						)}
						<div className="space-y-2">
							{extensions.map((extension) => {
								const mutationState = controller.mutation.stateFor(
									extension.id,
									extension.environmentId,
								);
								return (
									<InstalledExtensionCard
										key={extension.id}
										extension={extension}
										inventoryGeneration={inventoryGeneration}
										mutation={mutationState}
										onUpdate={
											extension.nativeUpdate?.available === true
												? () =>
														void controller.mutation.mutate({
															action: "update",
															id: extension.id,
															environmentId: extension.environmentId,
															expectedVersion: extension.version,
														})
												: undefined
										}
										onSetEnabled={() =>
											void controller.mutation.mutate({
												action: "set_enabled",
												id: extension.id,
												environmentId: extension.environmentId,
												expectedVersion: extension.version,
												expectedEnabled: extension.enabled,
												enabled: !extension.enabled,
											})
										}
										onUninstall={() =>
											void controller.mutation.mutate({
												action: "uninstall",
												id: extension.id,
												environmentId: extension.environmentId,
												expectedVersion: extension.version,
											})
										}
									/>
								);
							})}
							{extensions.length === 0 && (
								<p className="text-xs text-muted-foreground">
									No installed extensions match this filter.
								</p>
							)}
						</div>
					</div>
				);
			})}
		</div>
	);
}
