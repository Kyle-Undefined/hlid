import { MarketplaceGrid } from "./ExtensionMarketplaceView";
import type { ExtensionSectionViewModel } from "./ExtensionSectionControls";
import { InstalledExtensionCard } from "./InstalledExtensionCard";
import type { ExtensionSectionController } from "./useExtensionSectionController";

export function ExtensionInstalledView({
	model,
	controller,
}: {
	model: ExtensionSectionViewModel;
	controller: ExtensionSectionController;
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
								mutatingId={controller.mutatingId}
								mutate={controller.mutate}
							/>
						)}
						<div className="space-y-2">
							{extensions.map((extension) => (
								<InstalledExtensionCard
									key={extension.id}
									extension={extension}
									mutating={controller.mutatingId === extension.id}
									onUpdate={
										extension.nativeUpdate?.available === true
											? () =>
													void controller.mutate({
														action: "update",
														id: extension.id,
														expectedVersion: extension.version,
													})
											: undefined
									}
									onSetEnabled={() =>
										void controller.mutate({
											action: "set_enabled",
											id: extension.id,
											expectedVersion: extension.version,
											expectedEnabled: extension.enabled,
											enabled: !extension.enabled,
										})
									}
									onUninstall={() =>
										void controller.mutate({
											action: "uninstall",
											id: extension.id,
											expectedVersion: extension.version,
										})
									}
								/>
							))}
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
