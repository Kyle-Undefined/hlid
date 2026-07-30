import { useState } from "react";
import { ConfirmAction } from "#/components/ConfirmAction";
import type {
	ExtensionReview,
	ProviderExtension,
} from "#/server/extensionInventory";
import {
	ExtensionComponents,
	ExtensionMetaValue,
	TrustReviewAndManifest,
} from "./ExtensionReviewDetails";
import { useInstalledExtensionReview } from "./useInstalledExtensionReview";

function readableDate(value: string): string {
	if (!value) return "";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function statusClass(enabled: boolean): string {
	return enabled
		? "border-status-success/30 bg-status-success/10 text-status-success"
		: "border-border bg-secondary text-muted-foreground";
}

function InstalledRecoveryNotice({
	extension,
}: {
	extension: ProviderExtension;
}) {
	if (extension.cacheRecovery?.action === "marketplace_refresh_reinstall") {
		return (
			<div className="border border-status-warning/30 bg-status-warning/5 px-3 py-2 text-xs text-status-warning">
				<div>
					{extension.nativeUpdate?.reason ??
						"Codex does not expose a native per-plugin update command."}
				</div>
				<div className="mt-1 text-muted-foreground">
					Refresh the {extension.marketplace || "configured"} marketplace
					source, then uninstall this package and install it again from
					Marketplace after reviewing it.
				</div>
			</div>
		);
	}
	if (extension.cacheRecovery?.action === "restore_source") {
		return (
			<div className="border border-status-warning/30 bg-status-warning/5 px-3 py-2 text-xs text-status-warning">
				<div>
					{extension.nativeUpdate?.reason ??
						"Codex does not expose a native per-plugin update command."}
				</div>
				<div className="mt-1 text-muted-foreground">
					Hlið cannot prove that a manageable source and reviewable replacement
					package are available. Restore or add the package source, refresh
					inventory, and review the replacement before removing this
					installation.
				</div>
			</div>
		);
	}
	return null;
}

function InstalledStatusAction({
	extension,
	mutating,
	onSetEnabled,
}: {
	extension: ProviderExtension;
	mutating: boolean;
	onSetEnabled: () => void;
}) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-3 border border-border/70 bg-secondary/25 px-3 py-2">
			<div className="text-xs text-muted-foreground">
				<span className="text-foreground/85">
					{extension.enabled ? "Enabled" : "Disabled"}
				</span>{" "}
				in {extension.providerLabel}. Idle runtimes refresh immediately; a
				running turn reloads the provider before its next turn.
			</div>
			<button
				type="button"
				disabled={mutating}
				onClick={onSetEnabled}
				className={`border px-3 py-1.5 text-[10px] tracking-widest uppercase disabled:opacity-40 ${
					extension.enabled
						? "border-destructive/40 text-destructive hover:bg-destructive/10"
						: "border-primary/40 text-primary hover:bg-primary/10"
				}`}
			>
				{mutating ? "Working…" : extension.enabled ? "Disable" : "Enable"}
			</button>
		</div>
	);
}

function InstalledUpdateAction({
	extension,
	mutating,
	onUpdate,
}: {
	extension: ProviderExtension;
	mutating: boolean;
	onUpdate?: () => void;
}) {
	if (!onUpdate) return null;
	const repairingCache = extension.cacheRecovery?.action === "native_update";
	return (
		<div className="flex flex-wrap items-center justify-between gap-3 border border-border/70 bg-secondary/25 px-3 py-2">
			<div className="text-xs text-muted-foreground">
				{repairingCache
					? "The installed cache is missing or corrupt. Ask Claude to repair it through its native plugin update command."
					: "Check the configured Claude marketplace and update this installed plugin in place."}
			</div>
			<ConfirmAction
				label={`${repairingCache ? "repair" : "update"} ${extension.name}?`}
				confirmText={repairingCache ? "repair" : "update"}
				onConfirm={onUpdate}
				stacked
				className="justify-end flex-wrap"
				trigger={(open) => (
					<button
						type="button"
						disabled={mutating}
						onClick={open}
						className="border border-primary/40 px-3 py-1.5 text-[10px] tracking-widest uppercase text-primary hover:bg-primary/10 disabled:opacity-40"
					>
						{mutating
							? repairingCache
								? "Repairing…"
								: "Updating…"
							: repairingCache
								? "Repair cache"
								: "Update"}
					</button>
				)}
			/>
		</div>
	);
}

function InstalledMetadata({ extension }: { extension: ProviderExtension }) {
	return (
		<>
			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				<ExtensionMetaValue label="Plugin ID" value={extension.pluginId} mono />
				<ExtensionMetaValue label="Marketplace" value={extension.marketplace} />
				<ExtensionMetaValue label="Source" value={extension.source} mono />
				<ExtensionMetaValue label="Author" value={extension.author} />
				<ExtensionMetaValue label="Homepage" value={extension.homepage} />
				<ExtensionMetaValue label="Repository" value={extension.repository} />
				<ExtensionMetaValue label="License" value={extension.license} />
				<ExtensionMetaValue
					label="Installed"
					value={readableDate(extension.installedAt)}
				/>
				<ExtensionMetaValue
					label="Last updated"
					value={readableDate(extension.lastUpdated)}
				/>
			</div>
			<ExtensionMetaValue
				label="Installation path"
				value={extension.installPath}
				mono
			/>
		</>
	);
}

function installedManifestSummary(
	extension: ProviderExtension,
	review: ExtensionReview | null,
): string {
	if (review?.reviewLevel === "package") return "Complete manifest";
	if (review?.reviewLevel === "marketplace") return "Marketplace metadata";
	if (review) return "Manifest unavailable";
	if (extension.reviewHealth === "metadata_only") return "Marketplace metadata";
	if (extension.reviewHealth === "damaged") return "Manifest unavailable";
	return "Complete manifest";
}

function InstalledReviewState({
	review,
	reviewing,
	reviewError,
}: {
	review: ExtensionReview | null;
	reviewing: boolean;
	reviewError: string | null;
}) {
	return (
		<>
			{reviewing && (
				<div className="border border-border/70 bg-secondary/25 px-3 py-2 text-xs text-muted-foreground">
					Loading package files…
				</div>
			)}
			{reviewError && (
				<div className="border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
					{reviewError}
				</div>
			)}
			{review && review.reviewLevel !== "package" && (
				<div className="border border-status-warning/30 bg-status-warning/5 px-3 py-2 text-xs text-status-warning">
					{review.reviewMessage}
				</div>
			)}
		</>
	);
}

function InstalledReview({
	extension,
	review,
	reviewing,
	reviewError,
}: {
	extension: ProviderExtension;
	review: ExtensionReview | null;
	reviewing: boolean;
	reviewError: string | null;
}) {
	const components = review?.components ?? extension.components;
	const trustSignals = [
		...(review?.capabilities ?? extension.capabilities),
		...components
			.filter((item) => ["hooks", "mcp", "scripts", "apps"].includes(item.kind))
			.map((item) => item.label),
	];
	return (
		<>
			<ExtensionComponents components={components} />
			<InstalledReviewState
				review={review}
				reviewing={reviewing}
				reviewError={reviewError}
			/>
			<TrustReviewAndManifest
				skillFiles={review?.skillFiles ?? []}
				trustSignals={trustSignals}
				trustFallbackMessage="The manifest does not declare additional trust capabilities."
				manifestSummary={installedManifestSummary(extension, review)}
				manifestPath={extension.manifestPath}
				manifestText={extension.manifestText || "Manifest unavailable"}
			/>
		</>
	);
}

function InstalledUninstallAction({
	extension,
	mutating,
	onUninstall,
}: {
	extension: ProviderExtension;
	mutating: boolean;
	onUninstall: () => void;
}) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-3 border border-destructive/20 bg-destructive/5 px-3 py-2">
			<div className="text-xs text-muted-foreground">
				Remove from {extension.providerLabel} in {extension.environmentLabel}.
				Idle runtimes refresh immediately; a running turn reloads the provider
				before its next turn.
			</div>
			<ConfirmAction
				label={`remove ${extension.name}?`}
				confirmText="remove"
				onConfirm={onUninstall}
				stacked
				className="justify-end flex-wrap"
				trigger={(open) => (
					<button
						type="button"
						disabled={mutating}
						onClick={open}
						className="border border-destructive/40 px-3 py-1.5 text-[10px] tracking-widest uppercase text-destructive hover:bg-destructive/10 disabled:opacity-40"
					>
						{mutating ? "Removing…" : "Uninstall"}
					</button>
				)}
			/>
		</div>
	);
}

export function InstalledExtensionCard({
	extension,
	inventoryGeneration,
	onUpdate,
	onSetEnabled,
	onUninstall,
	mutating,
}: {
	extension: ProviderExtension;
	inventoryGeneration: number;
	onUpdate?: () => void;
	onSetEnabled: () => void;
	onUninstall: () => void;
	mutating: boolean;
}) {
	const [expanded, setExpanded] = useState(false);
	const { review, reviewing, reviewError, requestReview } =
		useInstalledExtensionReview(extension, expanded, inventoryGeneration);
	return (
		<details
			className="group border border-border bg-card"
			onToggle={(event) => {
				const open = event.currentTarget.open;
				setExpanded(open);
				if (open) requestReview();
			}}
		>
			<summary className="cursor-pointer list-none px-4 py-3 [&::-webkit-details-marker]:hidden">
				<div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-2">
							<span
								className={`size-2 rounded-full ${
									extension.enabled
										? "bg-status-success"
										: "bg-muted-foreground/40"
								}`}
								aria-hidden="true"
							/>
							<span className="text-sm font-medium">
								{extension.displayName}
							</span>
							<span className="font-mono text-[10px] text-muted-foreground">
								{extension.version}
							</span>
						</div>
						<div className="mt-1 text-xs text-muted-foreground line-clamp-2">
							{extension.description || extension.pluginId}
						</div>
					</div>
					<div className="flex flex-wrap items-center justify-end gap-1.5">
						<span
							className={`border px-1.5 py-0.5 text-[9px] tracking-widest uppercase ${statusClass(extension.enabled)}`}
						>
							{extension.enabled ? "Enabled" : "Disabled"}
						</span>
						<span className="border border-border px-1.5 py-0.5 text-[9px] tracking-widest uppercase text-muted-foreground">
							{extension.scope}
						</span>
						<span className="text-[10px] text-muted-foreground group-open:rotate-180">
							⌄
						</span>
					</div>
				</div>
			</summary>
			<div className="border-t border-border px-4 py-4 space-y-4">
				{extension.errors.length > 0 && (
					<div className="border border-status-warning/30 bg-status-warning/5 px-3 py-2 text-xs text-status-warning">
						{extension.errors.map((error) => (
							<div key={error}>{error}</div>
						))}
					</div>
				)}
				<InstalledRecoveryNotice extension={extension} />
				<InstalledStatusAction
					extension={extension}
					mutating={mutating}
					onSetEnabled={onSetEnabled}
				/>
				<InstalledUpdateAction
					extension={extension}
					mutating={mutating}
					onUpdate={onUpdate}
				/>
				<InstalledMetadata extension={extension} />
				<InstalledReview
					extension={extension}
					review={review}
					reviewing={reviewing}
					reviewError={reviewError}
				/>
				<InstalledUninstallAction
					extension={extension}
					mutating={mutating}
					onUninstall={onUninstall}
				/>
			</div>
		</details>
	);
}
