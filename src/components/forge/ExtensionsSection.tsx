import { useCallback, useEffect, useMemo, useState } from "react";
import { ConfirmAction } from "#/components/ConfirmAction";
import { includesSearchText } from "#/lib/search";
import {
	getExtensionInventoryFn,
	getExtensionReviewFn,
	mutateExtensionFn,
} from "#/lib/serverFns/extensions";
import type {
	AvailableExtension,
	ExtensionInventory,
	ExtensionProviderId,
	ExtensionReview,
	ExtensionSkillFile,
	ProviderExtension,
	ProviderMarketplace,
} from "#/server/extensionInventory";
import type { ExtensionMutationInput } from "#/server/extensionMutations";
import { Section } from "./fields";

const EMPTY_INVENTORY: ExtensionInventory = {
	generatedAt: "",
	environments: [],
	extensions: [],
	marketplaces: [],
	available: [],
	errors: [],
};

const PROVIDERS = [
	{ id: "claude" as const, label: "Claude" },
	{ id: "codex" as const, label: "Codex" },
];

function readableDate(value: string): string {
	if (!value) return "";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function statusClass(enabled: boolean): string {
	return enabled
		? "border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400"
		: "border-border bg-secondary text-muted-foreground";
}

function MetaValue({
	label,
	value,
	mono = false,
}: {
	label: string;
	value: string;
	mono?: boolean;
}) {
	if (!value) return null;
	return (
		<div className="min-w-0">
			<div className="text-[9px] tracking-widest uppercase text-muted-foreground">
				{label}
			</div>
			<div className={`mt-0.5 text-xs break-all ${mono ? "font-mono" : ""}`}>
				{value}
			</div>
		</div>
	);
}

function PackageFilesReview({ files }: { files: ExtensionSkillFile[] }) {
	if (files.length === 0) return null;
	return (
		<div>
			<div className="text-[9px] tracking-widest uppercase text-muted-foreground">
				Package files · {files.length}
			</div>
			<div className="mt-2 space-y-2">
				{files.map((file) => (
					<details
						key={file.path}
						className="border border-border/70 bg-secondary/30"
					>
						<summary className="cursor-pointer px-3 py-2 text-[10px] font-mono break-all">
							{file.path}
							{file.size !== undefined
								? ` · ${file.size.toLocaleString()} bytes`
								: ""}
						</summary>
						<div className="border-t border-border/70">
							{file.truncated && (
								<div className="border-b border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[10px] text-[var(--status-warning)]">
									Preview truncated at the extension review limit.
								</div>
							)}
							{file.binary ? (
								<div className="p-3 text-[10px] text-muted-foreground">
									Binary file. Content is not rendered in the review.
								</div>
							) : (
								<pre className="max-h-[32rem] overflow-auto p-3 text-[10px] leading-relaxed whitespace-pre-wrap break-words">
									{file.content}
								</pre>
							)}
						</div>
					</details>
				))}
			</div>
		</div>
	);
}

function MarketplaceCard({
	marketplace,
	mutating,
	onUpgrade,
	onRemove,
}: {
	marketplace: ProviderMarketplace;
	mutating: boolean;
	onUpgrade?: () => void;
	onRemove?: () => void;
}) {
	const [confirmingAction, setConfirmingAction] = useState<
		"update" | "remove" | null
	>(null);
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
			<div className="mt-2 flex flex-wrap items-center justify-between gap-2">
				<span className="text-[9px] tracking-widest uppercase text-muted-foreground">
					{marketplace.canManage ? "Configured source" : "Built in"}
				</span>
				{marketplace.canManage && onUpgrade && onRemove && (
					<div
						className={`flex flex-wrap items-center justify-end gap-1.5 ${
							confirmingAction ? "w-full" : "w-full sm:w-auto"
						}`}
					>
						{confirmingAction !== "remove" && (
							<ConfirmAction
								key="update"
								label={`update ${marketplace.name}?`}
								confirmText="update"
								onConfirm={onUpgrade}
								onOpenChange={(open) =>
									setConfirmingAction(open ? "update" : null)
								}
								stacked
								className="justify-end"
								trigger={(open) => (
									<button
										aria-label={`Update ${marketplace.name}`}
										type="button"
										disabled={mutating}
										onClick={open}
										className="border border-border px-2 py-1 text-[9px] tracking-widest uppercase disabled:opacity-40"
									>
										{mutating ? "Working…" : "Update"}
									</button>
								)}
							/>
						)}
						{confirmingAction !== "update" && (
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
								onOpenChange={(open) =>
									setConfirmingAction(open ? "remove" : null)
								}
								stacked
								className="justify-end"
								trigger={(open) => (
									<button
										aria-label={`Remove ${marketplace.name}`}
										type="button"
										disabled={mutating}
										onClick={open}
										className="border border-destructive/30 px-2 py-1 text-[9px] tracking-widest text-destructive uppercase disabled:opacity-40"
									>
										Remove
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

function AvailableExtensionCard({
	extension,
	review,
	loading,
	error,
	onReview,
	onInstall,
	mutating,
}: {
	extension: AvailableExtension;
	review: ExtensionReview | null;
	loading: boolean;
	error: string | null;
	onReview: () => void;
	onInstall: () => void;
	mutating: boolean;
}) {
	const trustSignals = review
		? [
				...review.capabilities,
				...review.components
					.filter((item) =>
						["hooks", "mcp", "scripts", "apps"].includes(item.kind),
					)
					.map((item) => item.label),
			]
		: [];
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
				<div className="border-t border-border px-4 py-4 space-y-4">
					<div
						className={`border px-3 py-2 text-xs ${
							review.reviewLevel === "package"
								? "border-green-500/30 bg-green-500/5"
								: "border-amber-500/30 bg-amber-500/5 text-[var(--status-warning)]"
						}`}
					>
						<div className="font-medium">
							{review.reviewLevel === "package"
								? "Complete package review"
								: "Marketplace metadata only"}
						</div>
						<div className="mt-1 text-muted-foreground">
							{review.reviewMessage}
						</div>
					</div>
					{!extension.installed && (
						<div
							className={`flex flex-wrap items-center justify-between gap-3 border px-3 py-2 ${
								review.reviewLevel === "package"
									? "border-primary/25 bg-primary/5"
									: "border-amber-500/40 bg-amber-500/10"
							}`}
						>
							<div className="text-xs text-muted-foreground">
								{review.reviewLevel === "package" ? (
									<>
										Install the reviewed package through{" "}
										{extension.providerLabel} in {extension.environmentLabel}.
										Idle runtimes refresh immediately; a running turn reloads
										the provider before its next turn.
									</>
								) : (
									<>
										<strong className="text-[var(--status-warning)]">
											The package files have not been reviewed.
										</strong>{" "}
										{extension.providerLabel} will download and activate this
										extension from the marketplace metadata. After it finishes,
										the marketplace row stays in place and refreshes to
										Installed; switch to Installed when you want to inspect the
										downloaded files.
									</>
								)}
							</div>
							<ConfirmAction
								label={
									review.reviewLevel === "package"
										? `install ${extension.name}?`
										: "install without package review?"
								}
								confirmText={
									review.reviewLevel === "package"
										? "install"
										: "install anyway"
								}
								variant={
									review.reviewLevel === "package" ? "primary" : "destructive"
								}
								onConfirm={onInstall}
								stacked
								className="justify-end flex-wrap"
								trigger={(open) => (
									<button
										type="button"
										disabled={mutating}
										onClick={open}
										className={`border px-3 py-1.5 text-[10px] tracking-widest uppercase disabled:opacity-40 ${
											review.reviewLevel === "package"
												? "border-primary/40 text-primary hover:bg-primary/10"
												: "border-amber-500/50 text-[var(--status-warning)] hover:bg-amber-500/10"
										}`}
									>
										{mutating ? "Installing…" : "Install"}
									</button>
								)}
							/>
						</div>
					)}
					{review.errors.map((message) => (
						<div
							key={message}
							className="border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-[var(--status-warning)]"
						>
							{message}
						</div>
					))}
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
						<MetaValue label="Plugin ID" value={review.pluginId} mono />
						<MetaValue label="Marketplace" value={review.marketplace} />
						<MetaValue label="Source" value={review.source} mono />
						<MetaValue label="Author" value={review.author} />
						<MetaValue label="Homepage" value={review.homepage} />
					</div>
					{review.components.length > 0 && (
						<div>
							<div className="text-[9px] tracking-widest uppercase text-muted-foreground">
								Bundled components
							</div>
							<div className="mt-2 flex flex-wrap gap-1.5">
								{review.components.map((component) => (
									<span
										key={component.kind}
										title={component.names.join(", ")}
										className="border border-border bg-secondary px-2 py-1 text-[10px]"
									>
										{component.label} · {component.count}
									</span>
								))}
							</div>
						</div>
					)}
					<PackageFilesReview files={review.skillFiles} />
					<div>
						<div className="text-[9px] tracking-widest uppercase text-muted-foreground">
							Trust review
						</div>
						{trustSignals.length > 0 ? (
							<div className="mt-2 flex flex-wrap gap-1.5">
								{[...new Set(trustSignals)].map((signal) => (
									<span
										key={signal}
										className="border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-[10px] text-[var(--status-warning)]"
									>
										{signal}
									</span>
								))}
							</div>
						) : (
							<p className="mt-1 text-xs text-muted-foreground">
								The reviewed data does not declare additional trust
								capabilities.
							</p>
						)}
					</div>
					<details className="border border-border/70 bg-secondary/30">
						<summary className="cursor-pointer px-3 py-2 text-[10px] tracking-widest uppercase">
							{review.reviewLevel === "package"
								? "Complete manifest"
								: "Marketplace entry"}
						</summary>
						<div className="border-t border-border/70">
							<div className="px-3 py-2 text-[10px] font-mono text-muted-foreground break-all">
								{review.manifestPath}
							</div>
							<pre className="max-h-96 overflow-auto border-t border-border/70 p-3 text-[10px] leading-relaxed whitespace-pre-wrap break-words">
								{review.manifestText}
							</pre>
						</div>
					</details>
				</div>
			)}
		</div>
	);
}

function ExtensionCard({
	extension,
	onUpdate,
	onSetEnabled,
	onUninstall,
	mutating,
}: {
	extension: ProviderExtension;
	onUpdate?: () => void;
	onSetEnabled: () => void;
	onUninstall: () => void;
	mutating: boolean;
}) {
	const [review, setReview] = useState<ExtensionReview | null>(null);
	const [reviewing, setReviewing] = useState(false);
	const [reviewError, setReviewError] = useState<string | null>(null);
	const reviewComponents = review?.components ?? extension.components;
	const trustSignals = [
		...(review?.capabilities ?? extension.capabilities),
		...reviewComponents
			.filter((item) => ["hooks", "mcp", "scripts", "apps"].includes(item.kind))
			.map((item) => item.label),
	];
	const loadReview = useCallback(async () => {
		if (review || reviewing) return;
		setReviewing(true);
		setReviewError(null);
		try {
			setReview(await getExtensionReviewFn({ data: { id: extension.id } }));
		} catch (cause) {
			setReviewError(
				cause instanceof Error
					? cause.message
					: "Unable to load the installed package review",
			);
		} finally {
			setReviewing(false);
		}
	}, [extension.id, review, reviewing]);
	return (
		<details
			className="group border border-border bg-card"
			onToggle={(event) => {
				if (event.currentTarget.open) void loadReview();
			}}
		>
			<summary className="cursor-pointer list-none px-4 py-3 [&::-webkit-details-marker]:hidden">
				<div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-2">
							<span
								className={`size-2 rounded-full ${
									extension.enabled ? "bg-green-500" : "bg-muted-foreground/40"
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
					<div className="border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-[var(--status-warning)]">
						{extension.errors.map((error) => (
							<div key={error}>{error}</div>
						))}
					</div>
				)}
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
				{onUpdate && (
					<div className="flex flex-wrap items-center justify-between gap-3 border border-border/70 bg-secondary/25 px-3 py-2">
						<div className="text-xs text-muted-foreground">
							Check the configured Claude marketplace and update this installed
							plugin in place.
						</div>
						<ConfirmAction
							label={`update ${extension.name}?`}
							confirmText="update"
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
									{mutating ? "Updating…" : "Update"}
								</button>
							)}
						/>
					</div>
				)}
				<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
					<MetaValue label="Plugin ID" value={extension.pluginId} mono />
					<MetaValue label="Marketplace" value={extension.marketplace} />
					<MetaValue label="Source" value={extension.source} mono />
					<MetaValue label="Author" value={extension.author} />
					<MetaValue label="Homepage" value={extension.homepage} />
					<MetaValue label="Repository" value={extension.repository} />
					<MetaValue label="License" value={extension.license} />
					<MetaValue
						label="Installed"
						value={readableDate(extension.installedAt)}
					/>
					<MetaValue
						label="Last updated"
						value={readableDate(extension.lastUpdated)}
					/>
				</div>
				<MetaValue
					label="Installation path"
					value={extension.installPath}
					mono
				/>
				{reviewComponents.length > 0 && (
					<div>
						<div className="text-[9px] tracking-widest uppercase text-muted-foreground">
							Bundled components
						</div>
						<div className="mt-2 flex flex-wrap gap-1.5">
							{reviewComponents.map((component) => (
								<span
									key={component.kind}
									title={component.names.join(", ")}
									className="border border-border bg-secondary px-2 py-1 text-[10px]"
								>
									{component.label} · {component.count}
								</span>
							))}
						</div>
					</div>
				)}
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
				<PackageFilesReview files={review?.skillFiles ?? []} />
				<div>
					<div className="text-[9px] tracking-widest uppercase text-muted-foreground">
						Trust review
					</div>
					{trustSignals.length > 0 ? (
						<div className="mt-2 flex flex-wrap gap-1.5">
							{[...new Set(trustSignals)].map((signal) => (
								<span
									key={signal}
									className="border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-[10px] text-[var(--status-warning)]"
								>
									{signal}
								</span>
							))}
						</div>
					) : (
						<p className="mt-1 text-xs text-muted-foreground">
							The manifest does not declare additional trust capabilities.
						</p>
					)}
				</div>
				<details className="border border-border/70 bg-secondary/30">
					<summary className="cursor-pointer px-3 py-2 text-[10px] tracking-widest uppercase">
						Complete manifest
					</summary>
					<div className="border-t border-border/70">
						<div className="px-3 py-2 text-[10px] font-mono text-muted-foreground break-all">
							{extension.manifestPath}
						</div>
						<pre className="max-h-96 overflow-auto border-t border-border/70 p-3 text-[10px] leading-relaxed whitespace-pre-wrap break-words">
							{extension.manifestText || "Manifest unavailable"}
						</pre>
					</div>
				</details>
				<div className="flex flex-wrap items-center justify-between gap-3 border border-destructive/20 bg-destructive/5 px-3 py-2">
					<div className="text-xs text-muted-foreground">
						Remove from {extension.providerLabel} in{" "}
						{extension.environmentLabel}. Idle runtimes refresh immediately; a
						running turn reloads the provider before its next turn.
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
			</div>
		</details>
	);
}

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

export function ExtensionsSection() {
	const [inventory, setInventory] =
		useState<ExtensionInventory>(EMPTY_INVENTORY);
	const [provider, setProvider] = useState<ExtensionProviderId>("claude");
	const [view, setView] = useState<"installed" | "marketplace">("installed");
	const [search, setSearch] = useState("");
	const [environment, setEnvironment] = useState("all");
	const [category, setCategory] = useState("all");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [review, setReview] = useState<ExtensionReview | null>(null);
	const [reviewingId, setReviewingId] = useState<string | null>(null);
	const [reviewError, setReviewError] = useState<{
		id: string;
		message: string;
	} | null>(null);
	const [mutatingId, setMutatingId] = useState<string | null>(null);
	const [mutationNotice, setMutationNotice] = useState<string | null>(null);
	const [mutationError, setMutationError] = useState<string | null>(null);
	const [marketplaceEnvironmentId, setMarketplaceEnvironmentId] = useState("");
	const [marketplaceSource, setMarketplaceSource] = useState("");
	const [marketplaceRef, setMarketplaceRef] = useState("");
	const [marketplaceSparse, setMarketplaceSparse] = useState("");

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			setInventory(await getExtensionInventoryFn());
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Unable to inspect provider extensions",
			);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);
	useEffect(() => {
		if (!mutationNotice) return;
		const timer = setTimeout(() => setMutationNotice(null), 5_000);
		return () => clearTimeout(timer);
	}, [mutationNotice]);

	const providerExtensions = useMemo(
		() =>
			inventory.extensions.filter(
				(item) =>
					item.providerId === provider &&
					(!search.trim() ||
						includesSearchText(
							`${item.displayName} ${item.name} ${item.pluginId} ${item.description} ${item.marketplace} ${item.environmentLabel} ${item.components.map((component) => component.label).join(" ")}`,
							search,
						)),
			),
		[inventory.extensions, provider, search],
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
			inventory.available.filter(
				(item) =>
					item.providerId === provider &&
					(environment === "all" || item.environmentLabel === environment) &&
					(category === "all" || item.category === category) &&
					(!search.trim() ||
						includesSearchText(
							`${item.displayName} ${item.name} ${item.pluginId} ${item.description} ${item.marketplace} ${item.environmentLabel} ${item.category} ${item.source}`,
							search,
						)),
			),
		[inventory.available, provider, environment, category, search],
	);
	const labels = environmentLabels(providerExtensions, providerMarketplaces);
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
	const providerErrors = inventory.errors.filter(
		(item) => item.providerId === provider,
	);
	useEffect(() => {
		if (
			providerEnvironments.some((item) => item.id === marketplaceEnvironmentId)
		) {
			return;
		}
		setMarketplaceEnvironmentId(providerEnvironments[0]?.id ?? "");
	}, [marketplaceEnvironmentId, providerEnvironments]);
	const reviewExtension = useCallback(
		async (extension: AvailableExtension) => {
			if (review?.id === extension.id) {
				setReview(null);
				setReviewError(null);
				return;
			}
			setReviewingId(extension.id);
			setReviewError(null);
			setReview(null);
			try {
				setReview(await getExtensionReviewFn({ data: { id: extension.id } }));
			} catch (cause) {
				setReviewError({
					id: extension.id,
					message:
						cause instanceof Error
							? cause.message
							: "Unable to review this extension",
				});
			} finally {
				setReviewingId(null);
			}
		},
		[review?.id],
	);
	const mutateExtension = useCallback(
		async (input: ExtensionMutationInput) => {
			setMutatingId("environmentId" in input ? input.environmentId : input.id);
			setMutationNotice(null);
			setMutationError(null);
			try {
				const response = await mutateExtensionFn({ data: input });
				const result = response.result;
				const subject = result.subject || result.pluginId || "Extension";
				setMutationNotice(
					result.action === "install"
						? `${subject} installed in ${result.environmentLabel}.`
						: result.action === "update"
							? `${subject} updated in ${result.environmentLabel}.`
							: result.action === "uninstall"
								? `${subject} removed from ${result.environmentLabel}.`
								: result.action === "set_enabled" &&
										input.action === "set_enabled"
									? `${subject} ${input.enabled ? "enabled" : "disabled"} in ${result.environmentLabel}.`
									: result.action === "add_marketplace"
										? `${subject} added in ${result.environmentLabel}.`
										: result.action === "upgrade_marketplace"
											? `${subject} updated in ${result.environmentLabel}.`
											: `${subject} removed from ${result.environmentLabel}.`,
				);
				if (result.action === "add_marketplace") {
					setMarketplaceSource("");
					setMarketplaceRef("");
					setMarketplaceSparse("");
				}
				setReview(null);
				await load();
			} catch (cause) {
				setMutationError(
					cause instanceof Error ? cause.message : "Extension action failed",
				);
			} finally {
				setMutatingId(null);
			}
		},
		[load],
	);

	return (
		<Section
			title="Provider Extensions"
			description="Review, install, and remove extensions, and manage marketplace sources through each CLI's native plugin registry. Claude and Codex remain separate systems."
		>
			<div className="px-4 py-3 space-y-3">
				<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
					<div
						className="inline-flex self-start border border-border bg-secondary p-1"
						role="tablist"
						aria-label="Extension provider"
					>
						{PROVIDERS.map((item) => (
							<button
								key={item.id}
								type="button"
								role="tab"
								aria-selected={provider === item.id}
								onClick={() => {
									setProvider(item.id);
									setEnvironment("all");
									setCategory("all");
									setReview(null);
									setReviewError(null);
								}}
								className={`px-3 py-1.5 text-[10px] tracking-widest uppercase ${
									provider === item.id
										? "bg-primary/10 text-primary"
										: "text-muted-foreground hover:text-foreground"
								}`}
							>
								{item.label}
							</button>
						))}
					</div>
					<div
						className="inline-flex self-start border border-border bg-secondary p-1"
						role="tablist"
						aria-label="Extension view"
					>
						{(["installed", "marketplace"] as const).map((item) => (
							<button
								key={item}
								type="button"
								role="tab"
								aria-selected={view === item}
								onClick={() => {
									setView(item);
									setEnvironment("all");
									setCategory("all");
									setReview(null);
									setReviewError(null);
								}}
								className={`px-3 py-1.5 text-[10px] tracking-widest uppercase ${
									view === item
										? "bg-primary/10 text-primary"
										: "text-muted-foreground hover:text-foreground"
								}`}
							>
								{item}
							</button>
						))}
					</div>
					<input
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						placeholder={
							view === "installed"
								? "Filter installed extensions"
								: "Search marketplaces"
						}
						aria-label={
							view === "installed"
								? "Filter installed extensions"
								: "Search marketplaces"
						}
						className="min-w-0 flex-1 bg-secondary border border-border px-2.5 py-1.5 text-xs"
					/>
					<button
						type="button"
						onClick={() => void load()}
						disabled={loading}
						className="self-start border border-border px-3 py-1.5 text-[10px] tracking-widest uppercase disabled:opacity-50"
					>
						{loading ? "Inspecting…" : "Refresh"}
					</button>
				</div>
				{view === "marketplace" && (
					<div className="space-y-3">
						<div className="flex flex-col gap-2 sm:flex-row">
							<select
								value={environment}
								onChange={(event) => setEnvironment(event.target.value)}
								aria-label="Marketplace environment"
								className="bg-secondary border border-border px-2.5 py-1.5 text-xs"
							>
								<option value="all">All environments</option>
								{availableEnvironments.map((label) => (
									<option key={label} value={label}>
										{label}
									</option>
								))}
							</select>
							<select
								value={category}
								onChange={(event) => setCategory(event.target.value)}
								aria-label="Marketplace category"
								className="bg-secondary border border-border px-2.5 py-1.5 text-xs"
							>
								<option value="all">All categories</option>
								{availableCategories.map((label) => (
									<option key={label} value={label}>
										{label}
									</option>
								))}
							</select>
						</div>
						<details className="border border-border/70 bg-secondary/25">
							<summary className="cursor-pointer px-3 py-2 text-[10px] tracking-widest uppercase">
								Add marketplace source
							</summary>
							<div className="space-y-3 border-t border-border/70 p-3">
								<p className="text-xs text-muted-foreground">
									Add a Git URL, owner/repository, or local path to this
									provider’s native marketplace registry. Hlið will refresh the
									catalog after the provider accepts it.
								</p>
								<div className="grid gap-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
									<select
										aria-label="New marketplace environment"
										value={marketplaceEnvironmentId}
										onChange={(event) =>
											setMarketplaceEnvironmentId(event.target.value)
										}
										className="min-w-0 bg-secondary border border-border px-2.5 py-1.5 text-xs"
									>
										{providerEnvironments.map((item) => (
											<option key={item.id} value={item.id}>
												{item.environmentLabel}
											</option>
										))}
									</select>
									<input
										aria-label="Marketplace source"
										value={marketplaceSource}
										onChange={(event) =>
											setMarketplaceSource(event.target.value)
										}
										placeholder="owner/repository or https://…"
										className="min-w-0 bg-secondary border border-border px-2.5 py-1.5 text-xs"
									/>
								</div>
								<div className="grid gap-2 sm:grid-cols-2">
									{provider === "codex" && (
										<input
											aria-label="Marketplace Git ref"
											value={marketplaceRef}
											onChange={(event) =>
												setMarketplaceRef(event.target.value)
											}
											placeholder="Optional Git ref"
											className="min-w-0 bg-secondary border border-border px-2.5 py-1.5 text-xs"
										/>
									)}
									<input
										aria-label="Marketplace sparse paths"
										value={marketplaceSparse}
										onChange={(event) =>
											setMarketplaceSparse(event.target.value)
										}
										placeholder="Optional sparse paths, comma separated"
										className="min-w-0 bg-secondary border border-border px-2.5 py-1.5 text-xs"
									/>
								</div>
								<div className="flex w-full justify-end">
									<ConfirmAction
										label={`add marketplace source ${marketplaceSource.trim()}?`}
										confirmText="add source"
										onConfirm={() =>
											void mutateExtension({
												action: "add_marketplace",
												providerId: provider,
												environmentId: marketplaceEnvironmentId,
												source: marketplaceSource.trim(),
												...(provider === "codex" && marketplaceRef.trim()
													? { ref: marketplaceRef.trim() }
													: {}),
												sparse: marketplaceSparse
													.split(/[,\n]/)
													.map((value) => value.trim())
													.filter(Boolean),
											})
										}
										stacked
										className="justify-end"
										trigger={(open) => (
											<button
												type="button"
												disabled={
													!marketplaceEnvironmentId ||
													!marketplaceSource.trim() ||
													mutatingId !== null
												}
												onClick={open}
												className="border border-primary/40 px-3 py-1.5 text-[10px] tracking-widest text-primary uppercase disabled:opacity-40"
											>
												{mutatingId === marketplaceEnvironmentId
													? "Adding…"
													: "Add source"}
											</button>
										)}
									/>
								</div>
							</div>
						</details>
					</div>
				)}
				<p className="text-xs text-muted-foreground">
					{view === "installed"
						? "Expand an extension to review its installation, bundled components, trust signals, and complete manifest."
						: "Browse local snapshots from the marketplaces configured in this provider environment. Review one package at a time before installing it through the provider CLI."}
				</p>
				{error && <p className="text-xs text-destructive">{error}</p>}
				{mutationNotice && (
					<p className="text-xs text-green-600 dark:text-green-400">
						{mutationNotice}
					</p>
				)}
				{mutationError && (
					<p className="text-xs text-destructive">{mutationError}</p>
				)}
				{providerErrors.map((item) => (
					<p
						key={`${item.environmentLabel}-${item.message}`}
						className="text-xs text-[var(--status-warning)]"
					>
						{item.environmentLabel}: {item.message}
					</p>
				))}
			</div>
			{loading &&
			inventory.extensions.length === 0 &&
			inventory.available.length === 0 ? (
				<div className="border-t border-border px-4 py-6 text-xs text-muted-foreground">
					Inspecting native plugin registries…
				</div>
			) : view === "marketplace" ? (
				<div className="border-t border-border p-4 space-y-4">
					<div className="space-y-2">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<h3 className="text-xs tracking-widest uppercase">Sources</h3>
							<span className="text-[10px] text-muted-foreground">
								{providerMarketplaces.length} configured
							</span>
						</div>
						{providerMarketplaces.length > 0 ? (
							<div className="grid gap-2 sm:grid-cols-2">
								{providerMarketplaces.map((marketplace) => (
									<MarketplaceCard
										key={marketplace.id}
										marketplace={marketplace}
										mutating={mutatingId === marketplace.id}
										onUpgrade={() =>
											void mutateExtension({
												action: "upgrade_marketplace",
												id: marketplace.id,
												expectedSource: marketplace.source,
											})
										}
										onRemove={() =>
											void mutateExtension({
												action: "remove_marketplace",
												id: marketplace.id,
												expectedSource: marketplace.source,
											})
										}
									/>
								))}
							</div>
						) : (
							<p className="text-xs text-muted-foreground">
								No marketplace sources are configured for this provider.
							</p>
						)}
					</div>
					<div className="flex flex-wrap items-center justify-between gap-2">
						<h3 className="text-xs tracking-widest uppercase">Marketplace</h3>
						<span className="text-[10px] text-muted-foreground">
							{providerAvailable.length} matching
						</span>
					</div>
					{providerAvailable.length > 0 ? (
						<div className="space-y-2">
							{providerAvailable.map((extension) => (
								<AvailableExtensionCard
									key={extension.id}
									extension={extension}
									review={review?.id === extension.id ? review : null}
									loading={reviewingId === extension.id}
									error={
										reviewError?.id === extension.id
											? reviewError.message
											: null
									}
									onReview={() => void reviewExtension(extension)}
									onInstall={() => {
										if (!review || review.id !== extension.id) return;
										void mutateExtension({
											action: "install",
											id: extension.id,
											reviewToken: review.reviewToken,
										});
									}}
									mutating={mutatingId === extension.id}
								/>
							))}
						</div>
					) : (
						<p className="text-xs text-muted-foreground">
							No {provider === "claude" ? "Claude" : "Codex"} marketplace
							entries match these filters.
						</p>
					)}
				</div>
			) : labels.length === 0 ? (
				<div className="border-t border-border px-4 py-6 text-xs text-muted-foreground">
					No installed {provider === "claude" ? "Claude" : "Codex"} extensions
					were found.
				</div>
			) : (
				<div className="border-t border-border p-4 space-y-6">
					{labels.map((label) => {
						const extensions = providerExtensions.filter(
							(item) => item.environmentLabel === label,
						);
						const marketplaces = providerMarketplaces.filter(
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
									<div className="grid gap-2 sm:grid-cols-2">
										{marketplaces.map((marketplace) => (
											<MarketplaceCard
												key={marketplace.id}
												marketplace={marketplace}
												mutating={mutatingId === marketplace.id}
												onUpgrade={() =>
													void mutateExtension({
														action: "upgrade_marketplace",
														id: marketplace.id,
														expectedSource: marketplace.source,
													})
												}
												onRemove={() =>
													void mutateExtension({
														action: "remove_marketplace",
														id: marketplace.id,
														expectedSource: marketplace.source,
													})
												}
											/>
										))}
									</div>
								)}
								<div className="space-y-2">
									{extensions.map((extension) => (
										<ExtensionCard
											key={extension.id}
											extension={extension}
											mutating={mutatingId === extension.id}
											onUpdate={
												extension.providerId === "claude"
													? () =>
															void mutateExtension({
																action: "update",
																id: extension.id,
																expectedVersion: extension.version,
															})
													: undefined
											}
											onSetEnabled={() =>
												void mutateExtension({
													action: "set_enabled",
													id: extension.id,
													expectedVersion: extension.version,
													expectedEnabled: extension.enabled,
													enabled: !extension.enabled,
												})
											}
											onUninstall={() =>
												void mutateExtension({
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
			)}
		</Section>
	);
}
