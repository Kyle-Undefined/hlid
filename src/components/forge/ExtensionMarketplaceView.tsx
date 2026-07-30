import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmAction } from "#/components/ConfirmAction";
import type {
	ExtensionProviderId,
	ProviderExtensionEnvironment,
	ProviderMarketplace,
} from "#/server/extensionInventory";
import type { ExtensionMutationInput } from "#/server/extensionMutations";
import { AvailableExtensionCard } from "./AvailableExtensionCard";
import type { ExtensionSectionViewModel } from "./ExtensionSectionControls";
import type {
	ExtensionMutationSurface,
	ExtensionSectionController,
	ExtensionTargetMutationState,
} from "./useExtensionSectionController";

function MarketplaceCard({
	marketplace,
	mutation,
	onUpgrade,
	onRemove,
}: {
	marketplace: ProviderMarketplace;
	mutation: ExtensionTargetMutationState;
	onUpgrade?: () => void;
	onRemove?: () => void;
}) {
	const [confirmingAction, setConfirmingAction] = useState<
		"update" | "remove" | null
	>(null);
	const updateLabel =
		marketplace.health === "invalid" ? "Repair source" : "Refresh source";
	const updateConfirmText = updateLabel.toLowerCase();
	const canRefreshSource = marketplace.health !== "unavailable";
	const upgrading = mutation.activeAction === "upgrade_marketplace";
	const removing = mutation.activeAction === "remove_marketplace";
	return (
		<div className="border border-border/70 bg-secondary/40 p-3 min-w-0">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="text-xs font-medium">{marketplace.name}</div>
				{marketplace.pluginCount !== null && (
					<span className="text-[9px] tracking-widest uppercase text-muted-foreground">
						{marketplace.pluginCount} available
					</span>
				)}
			</div>
			{marketplace.source && (
				<div className="mt-1 text-[11px] text-muted-foreground break-all">
					{marketplace.source}
				</div>
			)}
			{marketplace.path && (
				<div className="mt-1 text-[10px] font-mono text-muted-foreground/80 break-all">
					{marketplace.path}
				</div>
			)}
			{marketplace.diagnostic && (
				<div className="mt-2 border border-status-warning/30 bg-status-warning/5 px-2 py-1.5 text-[10px] text-status-warning">
					{marketplace.diagnostic}
				</div>
			)}
			<div className="mt-2 flex flex-wrap items-center justify-between gap-2">
				<span className="text-[9px] tracking-widest uppercase text-muted-foreground">
					{marketplace.canManage ? "Configured source" : "Built in"}
				</span>
				{marketplace.canManage && (onUpgrade || onRemove) && (
					<div
						className={`flex flex-wrap items-center justify-end gap-1.5 ${
							confirmingAction ? "w-full" : "w-full sm:w-auto"
						}`}
					>
						{canRefreshSource && onUpgrade && confirmingAction !== "remove" && (
							<ConfirmAction
								key="update"
								label={`${updateConfirmText} ${marketplace.name}?`}
								confirmText={updateConfirmText}
								onConfirm={onUpgrade}
								disabled={mutation.blocked}
								onOpenChange={(open) =>
									setConfirmingAction(open ? "update" : null)
								}
								stacked
								className="justify-end"
								trigger={(open) => (
									<button
										aria-label={`${updateLabel} ${marketplace.name}`}
										type="button"
										disabled={mutation.blocked}
										onClick={open}
										className="border border-border px-2 py-1 text-[9px] tracking-widest uppercase disabled:opacity-40"
									>
										{upgrading ? "Working…" : updateLabel}
									</button>
								)}
							/>
						)}
						{onRemove && confirmingAction !== "update" && (
							<ConfirmAction
								key="remove"
								label={`remove ${marketplace.name}? ${
									marketplace.providerId === "claude"
										? "This removes its declaration from all Claude settings scopes. "
										: ""
								}Installed extensions remain installed.`}
								confirmText="remove source"
								variant="destructive"
								onConfirm={onRemove}
								disabled={mutation.blocked}
								onOpenChange={(open) =>
									setConfirmingAction(open ? "remove" : null)
								}
								stacked
								className="justify-end"
								trigger={(open) => (
									<button
										aria-label={`Remove ${marketplace.name}`}
										type="button"
										disabled={mutation.blocked}
										onClick={open}
										className="border border-destructive/30 px-2 py-1 text-[9px] tracking-widest text-destructive uppercase disabled:opacity-40"
									>
										{removing ? "Removing…" : "Remove"}
									</button>
								)}
							/>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

export function MarketplaceGrid({
	marketplaces,
	mutation,
}: {
	marketplaces: ProviderMarketplace[];
	mutation: ExtensionMutationSurface;
}) {
	return (
		<div className="grid gap-2 sm:grid-cols-2">
			{marketplaces.map((marketplace) => (
				<MarketplaceCard
					key={marketplace.id}
					marketplace={marketplace}
					mutation={mutation.stateFor(marketplace.id)}
					onUpgrade={() =>
						void mutation.mutate({
							action: "upgrade_marketplace",
							id: marketplace.id,
							expectedSource: marketplace.source,
						})
					}
					onRemove={() =>
						void mutation.mutate({
							action: "remove_marketplace",
							id: marketplace.id,
							expectedSource: marketplace.source,
						})
					}
				/>
			))}
		</div>
	);
}

function marketplaceInput(
	provider: ExtensionProviderId,
	environmentId: string,
	source: string,
	ref: string,
	sparse: string,
): ExtensionMutationInput {
	return {
		action: "add_marketplace",
		providerId: provider,
		environmentId,
		source: source.trim(),
		...(provider === "codex" && ref.trim() ? { ref: ref.trim() } : {}),
		sparse: sparse
			.split(/[,\n]/)
			.map((value) => value.trim())
			.filter(Boolean),
	};
}

export function useMarketplaceSourceDraft(
	environments: ProviderExtensionEnvironment[],
) {
	const [environmentId, setEnvironmentIdState] = useState("");
	const [source, setSourceState] = useState("");
	const [ref, setRefState] = useState("");
	const [sparse, setSparseState] = useState("");
	const revisionRef = useRef(0);
	const setEnvironmentId = useCallback((value: string) => {
		revisionRef.current += 1;
		setEnvironmentIdState(value);
	}, []);
	const setSource = useCallback((value: string) => {
		revisionRef.current += 1;
		setSourceState(value);
	}, []);
	const setRef = useCallback((value: string) => {
		revisionRef.current += 1;
		setRefState(value);
	}, []);
	const setSparse = useCallback((value: string) => {
		revisionRef.current += 1;
		setSparseState(value);
	}, []);
	useEffect(() => {
		if (environments.some((item) => item.id === environmentId)) return;
		setEnvironmentId(environments[0]?.id ?? "");
	}, [environmentId, environments, setEnvironmentId]);
	const submission = useCallback(
		() => ({
			revision: revisionRef.current,
			environmentId,
			source,
			ref,
			sparse,
		}),
		[environmentId, source, ref, sparse],
	);
	const clearIfCurrent = useCallback((snapshot: { revision: number }) => {
		if (snapshot.revision !== revisionRef.current) return;
		revisionRef.current += 1;
		setSourceState("");
		setRefState("");
		setSparseState("");
	}, []);
	return {
		environmentId,
		setEnvironmentId,
		source,
		setSource,
		ref,
		setRef,
		sparse,
		setSparse,
		submission,
		clearIfCurrent,
	};
}

export type MarketplaceSourceDraft = ReturnType<
	typeof useMarketplaceSourceDraft
>;

export function MarketplaceSourceForm({
	provider,
	environments,
	mutation,
	draft,
}: {
	provider: ExtensionProviderId;
	environments: ProviderExtensionEnvironment[];
	mutation: ExtensionMutationSurface;
	draft: MarketplaceSourceDraft;
}) {
	const targetMutation = mutation.stateFor(draft.environmentId);
	const adding = targetMutation.activeAction === "add_marketplace";
	const confirmationKey = JSON.stringify([
		provider,
		draft.environmentId,
		draft.source,
		draft.ref,
		draft.sparse,
	]);
	return (
		<details className="border border-border/70 bg-secondary/25">
			<summary className="cursor-pointer px-3 py-2 text-[10px] tracking-widest uppercase">
				Add marketplace source
			</summary>
			<div className="space-y-3 border-t border-border/70 p-3">
				<p className="text-xs text-muted-foreground">
					Add a Git URL, owner/repository, or local path to this provider’s
					native marketplace registry. Hlið will refresh the catalog after the
					provider accepts it.
				</p>
				<div className="grid gap-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
					<select
						aria-label="New marketplace environment"
						value={draft.environmentId}
						onChange={(event) => draft.setEnvironmentId(event.target.value)}
						className="min-w-0 bg-input border border-border px-2.5 py-1.5 text-xs"
					>
						{environments.map((item) => (
							<option key={item.id} value={item.id}>
								{item.environmentLabel}
							</option>
						))}
					</select>
					<input
						aria-label="Marketplace source"
						value={draft.source}
						onChange={(event) => draft.setSource(event.target.value)}
						placeholder="owner/repository or https://…"
						className="min-w-0 bg-input border border-border px-2.5 py-1.5 text-xs"
					/>
				</div>
				<div className="grid gap-2 sm:grid-cols-2">
					{provider === "codex" && (
						<input
							aria-label="Marketplace Git ref"
							value={draft.ref}
							onChange={(event) => draft.setRef(event.target.value)}
							placeholder="Optional Git ref"
							className="min-w-0 bg-input border border-border px-2.5 py-1.5 text-xs"
						/>
					)}
					<input
						aria-label="Marketplace sparse paths"
						value={draft.sparse}
						onChange={(event) => draft.setSparse(event.target.value)}
						placeholder="Optional sparse paths, comma separated"
						className="min-w-0 bg-input border border-border px-2.5 py-1.5 text-xs"
					/>
				</div>
				<div className="flex w-full justify-end">
					<ConfirmAction
						key={confirmationKey}
						label={`add marketplace source ${draft.source.trim()}?`}
						confirmText="add source"
						disabled={mutation.hasActive}
						onConfirm={() => {
							const submission = draft.submission();
							void mutation.mutate(
								marketplaceInput(
									provider,
									submission.environmentId,
									submission.source,
									submission.ref,
									submission.sparse,
								),
								() => draft.clearIfCurrent(submission),
							);
						}}
						stacked
						className="justify-end"
						trigger={(open) => (
							<button
								type="button"
								disabled={
									!draft.environmentId ||
									!draft.source.trim() ||
									mutation.hasActive
								}
								onClick={open}
								className="border border-primary/40 px-3 py-1.5 text-[10px] tracking-widest text-primary uppercase disabled:opacity-40"
							>
								{adding ? "Adding…" : "Add source"}
							</button>
						)}
					/>
				</div>
			</div>
		</details>
	);
}

export function ExtensionMarketplaceView({
	model,
	controller,
}: {
	model: ExtensionSectionViewModel;
	controller: ExtensionSectionController;
}) {
	return (
		<div className="border-t border-border p-4 space-y-4">
			<div className="space-y-2">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<h3 className="text-xs tracking-widest uppercase">Sources</h3>
					<span className="text-[10px] text-muted-foreground">
						{model.providerMarketplaces.length} configured
					</span>
				</div>
				{model.providerMarketplaces.length > 0 ? (
					<MarketplaceGrid
						marketplaces={model.providerMarketplaces}
						mutation={controller.mutation}
					/>
				) : (
					<p className="text-xs text-muted-foreground">
						No marketplace sources are configured for this provider.
					</p>
				)}
			</div>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3 className="text-xs tracking-widest uppercase">Marketplace</h3>
				<span className="text-[10px] text-muted-foreground">
					{model.providerAvailable.length} matching
				</span>
			</div>
			{model.providerAvailable.length > 0 ? (
				<div className="space-y-2">
					{model.providerAvailable.map((extension) => {
						const review =
							controller.review?.id === extension.id ? controller.review : null;
						const mutation = controller.mutation.stateFor(extension.id);
						return (
							<AvailableExtensionCard
								key={extension.id}
								extension={extension}
								review={review}
								loading={controller.reviewingId === extension.id}
								error={
									controller.reviewError?.id === extension.id
										? controller.reviewError.message
										: null
								}
								onReview={() => void controller.reviewExtension(extension)}
								onInstall={() => {
									if (!review) return;
									void controller.mutation.mutate({
										action: "install",
										id: extension.id,
										reviewToken: review.reviewToken,
									});
								}}
								mutation={mutation}
							/>
						);
					})}
				</div>
			) : (
				<p className="text-xs text-muted-foreground">
					No {model.provider === "claude" ? "Claude" : "Codex"} marketplace
					entries match these filters.
				</p>
			)}
		</div>
	);
}
