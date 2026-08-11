import { ConfirmAction } from "#/components/ConfirmAction";
import type {
	AvailableExtension,
	ExtensionReview,
} from "#/server/extensionInventory";
import {
	ExtensionComponents,
	ExtensionMetaValue,
	TrustReviewAndManifest,
} from "./ExtensionReviewDetails";
import type { ExtensionTargetMutationState } from "./useExtensionSectionController";

function AvailableInstallAction({
	extension,
	review,
	mutation,
	onInstall,
}: {
	extension: AvailableExtension;
	review: ExtensionReview;
	mutation: ExtensionTargetMutationState;
	onInstall: () => void;
}) {
	if (extension.installed) return null;
	const packageReview = review.reviewLevel === "package";
	const installing = mutation.activeAction === "install";
	return (
		<div
			className={`flex flex-wrap items-center justify-between gap-3 border px-3 py-2 ${
				packageReview
					? "border-primary/25 bg-primary/5"
					: "border-status-warning/40 bg-status-warning/10"
			}`}
		>
			<div className="text-xs text-muted-foreground">
				{packageReview ? (
					<>
						Install the reviewed package through {extension.providerLabel} in{" "}
						{extension.environmentLabel}. Idle runtimes refresh immediately; a
						running turn reloads the provider before its next turn.
					</>
				) : (
					<>
						<strong className="text-status-warning">
							The package files have not been reviewed.
						</strong>{" "}
						{extension.providerLabel} will download and activate this extension
						from the marketplace metadata. After it finishes, the marketplace
						row stays in place and refreshes to Installed; switch to Installed
						when you want to inspect the downloaded files.
					</>
				)}
			</div>
			<ConfirmAction
				label={
					packageReview
						? `install ${extension.name}?`
						: "install without package review?"
				}
				confirmText={packageReview ? "install" : "install anyway"}
				variant={packageReview ? "primary" : "destructive"}
				onConfirm={onInstall}
				disabled={mutation.blocked}
				stacked
				className="justify-end flex-wrap"
				trigger={(open) => (
					<button
						type="button"
						data-forge-setting-label="install extension"
						disabled={mutation.blocked}
						onClick={open}
						className={`border px-3 py-1.5 text-[10px] tracking-widest uppercase disabled:opacity-40 ${
							packageReview
								? "border-primary/40 text-primary hover:bg-primary/10"
								: "border-status-warning/50 text-status-warning hover:bg-status-warning/10"
						}`}
					>
						{installing ? "Installing…" : "Install"}
					</button>
				)}
			/>
		</div>
	);
}

function AvailableExtensionReview({
	extension,
	review,
	mutation,
	onInstall,
}: {
	extension: AvailableExtension;
	review: ExtensionReview;
	mutation: ExtensionTargetMutationState;
	onInstall: () => void;
}) {
	const trustSignals = [
		...review.capabilities,
		...review.components
			.filter((item) => ["hooks", "mcp", "scripts", "apps"].includes(item.kind))
			.map((item) => item.label),
	];
	return (
		<div className="border-t border-border px-4 py-4 space-y-4">
			<div
				className={`border px-3 py-2 text-xs ${
					review.reviewLevel === "package"
						? "border-status-success/30 bg-status-success/5"
						: "border-status-warning/30 bg-status-warning/5 text-status-warning"
				}`}
			>
				<div className="font-medium">
					{review.reviewLevel === "package"
						? "Complete package review"
						: "Marketplace metadata only"}
				</div>
				<div className="mt-1 text-muted-foreground">{review.reviewMessage}</div>
			</div>
			<AvailableInstallAction
				extension={extension}
				review={review}
				mutation={mutation}
				onInstall={onInstall}
			/>
			{review.errors.map((message) => (
				<div
					key={message}
					className="border border-status-warning/30 bg-status-warning/5 px-3 py-2 text-xs text-status-warning"
				>
					{message}
				</div>
			))}
			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				<ExtensionMetaValue label="Plugin ID" value={review.pluginId} mono />
				<ExtensionMetaValue label="Marketplace" value={review.marketplace} />
				<ExtensionMetaValue label="Source" value={review.source} mono />
				<ExtensionMetaValue label="Author" value={review.author} />
				<ExtensionMetaValue label="Homepage" value={review.homepage} />
			</div>
			<ExtensionComponents components={review.components} />
			<TrustReviewAndManifest
				skillFiles={review.skillFiles}
				trustSignals={trustSignals}
				trustFallbackMessage="The reviewed data does not declare additional trust capabilities."
				manifestSummary={
					review.reviewLevel === "package"
						? "Complete manifest"
						: "Marketplace entry"
				}
				manifestPath={review.manifestPath}
				manifestText={review.manifestText}
			/>
		</div>
	);
}

export function AvailableExtensionCard({
	extension,
	review,
	loading,
	error,
	onReview,
	onInstall,
	mutation,
}: {
	extension: AvailableExtension;
	review: ExtensionReview | null;
	loading: boolean;
	error: string | null;
	onReview: () => void;
	onInstall: () => void;
	mutation: ExtensionTargetMutationState;
}) {
	return (
		<div className="border border-border bg-card">
			<div className="px-4 py-3">
				<div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-2">
							<span className="text-sm font-medium">
								{extension.displayName}
							</span>
							{extension.version && (
								<span className="font-mono text-[10px] text-muted-foreground">
									{extension.version}
								</span>
							)}
							<span className="border border-border px-1.5 py-0.5 text-[9px] tracking-widest uppercase text-muted-foreground">
								{extension.installed ? "Installed" : "Available"}
							</span>
							{extension.category && (
								<span className="border border-border px-1.5 py-0.5 text-[9px] tracking-widest uppercase text-muted-foreground">
									{extension.category}
								</span>
							)}
						</div>
						<div className="mt-1 text-xs text-muted-foreground line-clamp-2">
							{extension.description || extension.pluginId}
						</div>
					</div>
					<button
						type="button"
						data-forge-setting-label="review extension"
						onClick={onReview}
						disabled={loading}
						className="border border-border px-3 py-1.5 text-[10px] tracking-widest uppercase disabled:opacity-50"
					>
						{loading ? "Reviewing…" : review ? "Close review" : "Review"}
					</button>
				</div>
				<div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
					<span>{extension.marketplace}</span>
					<span>{extension.environmentLabel}</span>
					<span>
						{extension.reviewLevel === "package"
							? "Package cached locally"
							: "Marketplace metadata cached"}
					</span>
				</div>
			</div>
			{error && (
				<div className="border-t border-border px-4 py-3 text-xs text-destructive">
					{error}
				</div>
			)}
			{review && (
				<AvailableExtensionReview
					extension={extension}
					review={review}
					mutation={mutation}
					onInstall={onInstall}
				/>
			)}
		</div>
	);
}
