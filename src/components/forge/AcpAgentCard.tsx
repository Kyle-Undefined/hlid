import { useEffect, useMemo, useRef, useState } from "react";
import { ConfirmAction } from "#/components/ConfirmAction";
import type { HlidConfig } from "#/config";
import type {
	AcpManagedMutationAction,
	AcpTargetStatus,
} from "#/lib/acpManagedTypes";
import type { ProviderInfo } from "#/lib/providerTypes";
import { CONFIG_SECRET_SENTINEL } from "#/lib/publicConfig";
import { includesSearchText } from "#/lib/search";
import type {
	AcpAgentInfo,
	AcpAuthMethod,
	AcpCatalogItem,
	AcpProviderNativeSessionPage,
	AcpProviderSessionImportResult,
} from "#/lib/serverFns/acp";
import { AcpAuthMethodRow } from "./AcpAuthMethodRow";

export type AcpAgentConfig = NonNullable<HlidConfig["acp_agents"]>[number];
export type AcpModelOption = NonNullable<ProviderInfo["models"]>[number];
type OpenCodeModelFilter = NonNullable<AcpAgentConfig["model_filter"]>;
type OpenCodeModelFilterMode = "all" | OpenCodeModelFilter["mode"];
type AcpCardOperation =
	| "inspect"
	| "refresh"
	| "sessions"
	| "import"
	| AcpManagedMutationAction
	| null;
const EMPTY_MODEL_IDS: string[] = [];
const MAX_MODEL_FILTER_SELECTIONS = 256;

function providerSessionUpdatedLabel(updatedAt: string): string {
	const timestamp = new Date(updatedAt);
	return Number.isNaN(timestamp.getTime())
		? updatedAt
		: timestamp.toLocaleString();
}

function ProviderNativeSessionBrowser({
	item,
	page,
	imports,
	disabled,
	operation,
	importingProviderSessionId,
	onLoadMore,
	onClose,
	onImport,
}: {
	item: AcpCatalogItem;
	page: AcpProviderNativeSessionPage;
	imports: Record<string, AcpProviderSessionImportResult> | undefined;
	disabled: boolean;
	operation: AcpCardOperation;
	importingProviderSessionId?: string;
	onLoadMore: (cursor: string) => void;
	onClose: () => void;
	onImport: (providerSessionId: string) => void;
}) {
	return (
		<div className="min-w-0 space-y-3 border border-primary/25 bg-background/50 px-3 py-3">
			<div className="flex min-w-0 items-start justify-between gap-3">
				<div className="min-w-0 space-y-1">
					<div className="text-[9px] tracking-widest text-foreground/70 uppercase">
						Provider-native sessions
					</div>
					<p className="text-xs text-muted-foreground">
						Read-only metadata from {item.name} for this exact workspace.
						Browsing does not load or expand conversation history. These are not
						Hlid sessions or forks.
					</p>
					<p className="text-[10px] text-muted-foreground">
						{page.canImportSessions
							? "Import creates a Hlid entry with provider-native continuity. Earlier transcript remains provider-owned and is not copied into Hlid."
							: "This agent advertises session metadata only. It does not advertise loading or resuming these sessions, so Hlid cannot import them."}
					</p>
				</div>
				<button
					type="button"
					disabled={disabled}
					onClick={onClose}
					className="shrink-0 text-[10px] text-primary uppercase disabled:text-muted-foreground/50"
				>
					Close
				</button>
			</div>
			{page.sessions.length === 0 ? (
				<p className="text-xs text-muted-foreground">
					No provider-native sessions were returned for this workspace.
				</p>
			) : (
				<ul className="min-w-0 divide-y divide-border/60 border border-border/70">
					{page.sessions.map((session) => {
						const imported = imports?.[session.sessionId];
						const importing =
							operation === "import" &&
							importingProviderSessionId === session.sessionId;
						return (
							<li
								key={session.sessionId}
								className="flex min-w-0 flex-col gap-2 px-3 py-2 @2xl:flex-row @2xl:items-start @2xl:justify-between"
							>
								<div className="min-w-0 space-y-0.5">
									<div className="break-words text-xs text-foreground">
										{session.title?.trim() || "Untitled provider session"}
									</div>
									<code className="block break-all text-[10px] text-muted-foreground">
										{session.sessionId}
									</code>
									{session.updatedAt && (
										<time
											dateTime={session.updatedAt}
											className="block text-[10px] text-muted-foreground"
										>
											Updated {providerSessionUpdatedLabel(session.updatedAt)}
										</time>
									)}
								</div>
								{imported ? (
									<div className="shrink-0 space-y-0.5 text-left @2xl:text-right">
										<a
											href={`/raven?session=${encodeURIComponent(imported.sessionId)}`}
											className="text-[10px] text-primary uppercase"
										>
											Open in Raven
										</a>
										<p className="text-[9px] text-status-success/80">
											{imported.created
												? "Hlid entry created"
												: "Existing Hlid entry found"}
										</p>
									</div>
								) : page.canImportSessions ? (
									<button
										type="button"
										disabled={disabled}
										onClick={() => onImport(session.sessionId)}
										className="shrink-0 text-left text-[10px] text-primary uppercase disabled:text-muted-foreground/50 @2xl:text-right"
									>
										{importing ? "Importing…" : "Import into Hlid"}
									</button>
								) : (
									<span className="shrink-0 text-[10px] text-muted-foreground @2xl:text-right">
										Metadata only
									</span>
								)}
							</li>
						);
					})}
				</ul>
			)}
			{page.nextCursor && (
				<button
					type="button"
					disabled={disabled}
					onClick={() => onLoadMore(page.nextCursor ?? "")}
					className="text-[10px] text-primary uppercase disabled:text-muted-foreground/50"
				>
					{operation === "sessions" ? "Loading…" : "Load more"}
				</button>
			)}
		</div>
	);
}

function invocationLabel(
	item: AcpCatalogItem,
	target?: AcpTargetStatus,
): string {
	return [target?.command ?? item.command, ...(target?.args ?? item.args)]
		.filter(Boolean)
		.join(" ");
}

function modelDiscoveryIdentity(item: AcpCatalogItem): string {
	return JSON.stringify({
		providerId: item.providerId,
		version: item.version,
		command: item.command,
		args: item.args,
		env: Object.entries(item.env ?? {}).sort(([a], [b]) => a.localeCompare(b)),
	});
}

function sortedModelIds(models: Iterable<string>): string[] {
	return [...new Set(models)].sort((a, b) => a.localeCompare(b));
}

function sameModelIds(left: string[], right: string[]): boolean {
	const normalizedLeft = sortedModelIds(left);
	const normalizedRight = sortedModelIds(right);
	return (
		normalizedLeft.length === normalizedRight.length &&
		normalizedLeft.every((model, index) => model === normalizedRight[index])
	);
}

function OpenCodeModelVisibility({
	configured,
	models,
	disabled,
	configurationCurrent,
	onUpdateOverride,
	onDiscoverModels,
}: {
	configured: AcpAgentConfig;
	models: AcpModelOption[] | undefined;
	disabled: boolean;
	configurationCurrent: boolean;
	onUpdateOverride: (patch: Partial<AcpAgentConfig>) => void;
	onDiscoverModels?: () => Promise<ProviderInfo["models"]>;
}) {
	const filter = configured.model_filter;
	const savedMode: OpenCodeModelFilterMode =
		filter?.mode === "hide" && filter.models.length === 0
			? "all"
			: (filter?.mode ?? "all");
	const savedModels = filter?.models ?? EMPTY_MODEL_IDS;
	const [mode, setMode] = useState<OpenCodeModelFilterMode>(savedMode);
	const [selectedModels, setSelectedModels] = useState<string[]>(savedModels);
	const [search, setSearch] = useState("");
	const [discoveredModels, setDiscoveredModels] = useState<
		AcpModelOption[] | undefined
	>();
	const [discovering, setDiscovering] = useState(false);
	const [discoveryComplete, setDiscoveryComplete] = useState(false);
	const [discoveryError, setDiscoveryError] = useState<string | null>(null);
	const discoveryRequestRef = useRef(0);
	const activeModels = discoveredModels ?? models;

	useEffect(() => {
		setMode(
			filter?.mode === "hide" && filter.models.length === 0
				? "all"
				: (filter?.mode ?? "all"),
		);
		setSelectedModels(filter?.models ?? EMPTY_MODEL_IDS);
	}, [filter?.mode, filter?.models]);

	useEffect(
		() => () => {
			discoveryRequestRef.current += 1;
		},
		[],
	);

	const options = useMemo(() => {
		const advertised = new Map(
			(activeModels ?? []).map((model) => [model.value, model] as const),
		);
		return [
			...(activeModels ?? []).filter(
				(model, index, all) =>
					all.findIndex((candidate) => candidate.value === model.value) ===
					index,
			),
			...sortedModelIds([...savedModels, ...selectedModels])
				.filter((model) => !advertised.has(model))
				.map((model) => ({
					value: model,
					label: model,
					description: "Not currently advertised by OpenCode",
				})),
		];
	}, [activeModels, savedModels, selectedModels]);
	const shownOptions = useMemo(() => {
		const query = search.trim();
		if (!query) return options;
		return options.filter((model) =>
			includesSearchText(
				`${model.label} ${model.value} ${model.description ?? ""}`,
				query,
			),
		);
	}, [options, search]);
	const selected = useMemo(() => new Set(selectedModels), [selectedModels]);
	const knownModelIds = useMemo(
		() => sortedModelIds((activeModels ?? []).map((model) => model.value)),
		[activeModels],
	);
	const editorDisabled = disabled || discovering;
	const effectiveMode: OpenCodeModelFilterMode =
		mode === "hide" && selectedModels.length === 0 ? "all" : mode;
	const changed =
		effectiveMode !== savedMode ||
		(effectiveMode !== "all" && !sameModelIds(selectedModels, savedModels));
	const emptySelection = mode !== "all" && selectedModels.length === 0;
	const selectionLimitReached =
		selectedModels.length >= MAX_MODEL_FILTER_SELECTIONS;
	const selectionOverLimit =
		selectedModels.length > MAX_MODEL_FILTER_SELECTIONS;
	const fullCatalogKnown = discoveryComplete || savedMode === "all";
	const hidesAllKnownModels =
		mode === "hide" &&
		fullCatalogKnown &&
		knownModelIds.length > 0 &&
		knownModelIds.every((model) => selected.has(model));
	const invalidSelection =
		emptySelection || hidesAllKnownModels || selectionOverLimit;

	function toggleModel(model: string, checked: boolean): void {
		setSelectedModels((current) =>
			checked
				? current.length >= MAX_MODEL_FILTER_SELECTIONS
					? current
					: sortedModelIds([...current, model])
				: current.filter((candidate) => candidate !== model),
		);
	}

	function apply(): void {
		if (editorDisabled || !changed || invalidSelection) return;
		const normalizedModels = sortedModelIds(selectedModels);
		const patch: Partial<AcpAgentConfig> = {
			model_filter:
				effectiveMode === "all"
					? undefined
					: { mode: effectiveMode, models: normalizedModels },
		};
		for (const key of ["model", "recap_model"] as const) {
			const configuredModel = configured[key];
			if (!configuredModel) continue;
			const selected = normalizedModels.includes(configuredModel);
			if (
				(effectiveMode === "hide" && selected) ||
				(effectiveMode === "only" && !selected)
			) {
				patch[key] = undefined;
			}
		}
		onUpdateOverride(patch);
	}

	async function discoverModels(): Promise<void> {
		if (!onDiscoverModels || discovering || !configurationCurrent) return;
		const request = ++discoveryRequestRef.current;
		setDiscovering(true);
		setDiscoveryComplete(false);
		setDiscoveryError(null);
		try {
			const discovered = await onDiscoverModels();
			if (request !== discoveryRequestRef.current) return;
			if (!discovered) {
				throw new Error("OpenCode did not return a model catalog");
			}
			setDiscoveredModels(discovered);
			setDiscoveryComplete(true);
		} catch (cause) {
			if (request !== discoveryRequestRef.current) return;
			setDiscoveryError(
				cause instanceof Error
					? cause.message
					: "OpenCode model discovery failed",
			);
		} finally {
			if (request === discoveryRequestRef.current) setDiscovering(false);
		}
	}

	return (
		<div className="min-w-0 space-y-3 border border-primary/25 bg-background/40 px-3 py-3">
			<div className="flex min-w-0 flex-col gap-2 @2xl:flex-row @2xl:items-start @2xl:justify-between">
				<div className="min-w-0 space-y-1">
					<div className="text-[9px] tracking-widest text-foreground/70 uppercase">
						Model visibility
					</div>
					<p className="text-xs text-muted-foreground">
						Applies only to OpenCode ACP sessions launched from this Hlid
						integration. Standalone OpenCode and CLIProxy keep their own model
						configuration. Defaults excluded by the filter reset to OpenCode's
						provider default.
					</p>
				</div>
				{onDiscoverModels && (
					<button
						type="button"
						disabled={disabled || discovering || !configurationCurrent}
						title={
							configurationCurrent
								? undefined
								: "Wait for the OpenCode configuration to be saved"
						}
						onClick={() => void discoverModels()}
						className="shrink-0 border border-border px-2.5 py-1.5 text-[10px] tracking-widest text-primary uppercase disabled:text-muted-foreground/50"
					>
						{discovering
							? "Refreshing full model list…"
							: "Refresh full model list"}
					</button>
				)}
			</div>
			{discoveryComplete && (
				<p className="text-[10px] text-status-success/80" aria-live="polite">
					Full OpenCode model list refreshed.
				</p>
			)}
			{discoveryError && (
				<p className="text-xs text-destructive" role="alert">
					{discoveryError}. Showing the last available model list.
				</p>
			)}
			<fieldset className="grid min-w-0 gap-2 @2xl:grid-cols-3">
				<legend className="sr-only">OpenCode model visibility</legend>
				{(
					[
						["all", "Use all", "Show every model OpenCode advertises."],
						[
							"hide",
							"Hide selected",
							"Remove selected models from Hlid sessions.",
						],
						["only", "Only selected", "Offer only the models you select."],
					] as const
				).map(([value, label, description]) => (
					<label
						key={value}
						className={`flex cursor-pointer items-start gap-2 border px-2.5 py-2 text-xs ${
							mode === value
								? "border-primary/50 bg-primary/10"
								: "border-border/70"
						}`}
					>
						<input
							type="radio"
							name="opencode-model-visibility"
							value={value}
							checked={mode === value}
							disabled={editorDisabled}
							onChange={() => setMode(value)}
							className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary"
						/>
						<span className="min-w-0">
							<span className="block text-foreground">{label}</span>
							<span className="block text-[10px] text-muted-foreground">
								{description}
							</span>
						</span>
					</label>
				))}
			</fieldset>
			{mode !== "all" && (
				<div className="min-w-0 space-y-2">
					<div className="flex min-w-0 flex-col gap-2 @2xl:flex-row @2xl:items-center">
						<input
							value={search}
							disabled={editorDisabled}
							onChange={(event) => setSearch(event.target.value)}
							aria-label="Search OpenCode models"
							placeholder="Search models"
							className="min-w-0 flex-1 border border-border bg-input px-2.5 py-1.5 text-xs"
						/>
						<div className="flex items-center justify-between gap-3 text-[10px] text-muted-foreground @2xl:justify-end">
							<span>{selectedModels.length} selected</span>
							<button
								type="button"
								disabled={editorDisabled || selectedModels.length === 0}
								onClick={() => setSelectedModels([])}
								className="text-primary uppercase disabled:text-muted-foreground/50"
							>
								Clear selected
							</button>
						</div>
					</div>
					<div className="max-h-64 min-w-0 overflow-y-auto border border-border/70">
						{shownOptions.length > 0 ? (
							shownOptions.map((model) => {
								const unavailable = !(activeModels ?? []).some(
									(candidate) => candidate.value === model.value,
								);
								return (
									<label
										key={model.value}
										className="flex min-w-0 cursor-pointer items-start gap-2 border-b border-border/50 px-2.5 py-2 last:border-b-0"
									>
										<input
											type="checkbox"
											checked={selected.has(model.value)}
											disabled={
												editorDisabled ||
												(!selected.has(model.value) && selectionLimitReached)
											}
											onChange={(event) =>
												toggleModel(model.value, event.target.checked)
											}
											className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary"
										/>
										<span className="min-w-0 text-xs">
											<span className="block break-words text-foreground">
												{model.label}
											</span>
											{model.label !== model.value && (
												<code className="block break-all text-[10px] text-muted-foreground">
													{model.value}
												</code>
											)}
											{unavailable && (
												<span className="block text-[10px] text-status-warning">
													Saved, but not currently advertised by OpenCode
												</span>
											)}
										</span>
									</label>
								);
							})
						) : (
							<p className="px-2.5 py-3 text-xs text-muted-foreground">
								{options.length > 0
									? "No models match this search."
									: "Refresh models & modes to load the current OpenCode catalog."}
							</p>
						)}
					</div>
				</div>
			)}
			{emptySelection && (
				<p className="text-xs text-destructive" role="alert">
					{`Choose at least one model before applying ${
						mode === "hide" ? "Hide selected" : "Only selected"
					}.`}
				</p>
			)}
			{hidesAllKnownModels && (
				<p className="text-xs text-destructive" role="alert">
					Hide selected cannot hide every currently known model. Disable
					OpenCode instead.
				</p>
			)}
			{selectionLimitReached && mode !== "all" && (
				<output className="block text-xs text-status-warning">
					You can select up to {MAX_MODEL_FILTER_SELECTIONS} models. Clear one
					before selecting another.
				</output>
			)}
			<div className="flex flex-wrap items-center gap-3">
				<button
					type="button"
					disabled={editorDisabled || !changed || invalidSelection}
					onClick={apply}
					className="border border-primary/50 px-3 py-1.5 text-[10px] tracking-widest text-primary uppercase disabled:border-border disabled:text-muted-foreground/50"
				>
					Apply model visibility
				</button>
				{changed && !invalidSelection && (
					<span className="text-[10px] text-muted-foreground">
						Changes are staged until you apply them.
					</span>
				)}
			</div>
		</div>
	);
}

function OpenCodeGoUsage({
	configured,
	disabled,
	onUpdateOverride,
}: {
	configured: AcpAgentConfig;
	disabled: boolean;
	onUpdateOverride: (patch: Partial<AcpAgentConfig>) => void;
}) {
	const apiKey = configured.opencode_go_usage?.api_key ?? "";
	const enabled = configured.opencode_go_usage !== undefined;

	function updateApiKey(value: string): void {
		onUpdateOverride({
			opencode_go_usage: value ? { api_key: value } : undefined,
		});
	}

	return (
		<div className="min-w-0 space-y-3 border border-border/70 bg-background/40 px-3 py-3">
			<label className="flex min-w-0 items-start gap-2 text-xs text-foreground">
				<input
					type="checkbox"
					checked={enabled}
					disabled={disabled || !enabled}
					onChange={() => onUpdateOverride({ opencode_go_usage: undefined })}
					className="mt-0.5"
				/>
				<span className="min-w-0">
					<span className="block text-[9px] tracking-widest text-foreground/70 uppercase">
						OpenCode Go usage
					</span>
					<span className="block text-[10px] text-muted-foreground">
						Show account-wide limits for OpenCode Go models only, across Windows
						and WSL. These windows do not control auto-sleep or Ledger
						accounting.
					</span>
				</span>
			</label>
			<label className="block text-[9px] tracking-widest text-muted-foreground uppercase">
				OpenCode Go API key
				<input
					type="password"
					autoComplete="off"
					spellCheck={false}
					disabled={disabled}
					value={apiKey}
					onChange={(event) => updateApiKey(event.target.value)}
					placeholder="required before enabling usage"
					className="mt-1 w-full border border-border bg-input px-2 py-1 text-xs font-mono normal-case"
				/>
				<span className="mt-1 block text-[10px] font-sans normal-case tracking-normal text-muted-foreground">
					{apiKey === CONFIG_SECRET_SENTINEL
						? "Saved key retained. Enter a replacement or clear it to remove."
						: "Hlid stores this key only for the official OpenCode usage endpoint. It is not forwarded to OpenCode ACP."}
				</span>
			</label>
		</div>
	);
}

function readableBytes(value: number): string {
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
	return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function operationLabel(target: AcpTargetStatus): string | null {
	const operation = target.operation;
	if (!operation) return null;
	const action =
		operation.action === "remove"
			? "Removing"
			: operation.action === "update"
				? "Updating"
				: "Installing";
	const phase =
		operation.phase.charAt(0).toUpperCase() + operation.phase.slice(1);
	const progress =
		operation.received === undefined
			? ""
			: operation.total
				? ` · ${readableBytes(operation.received)} of ${readableBytes(operation.total)}`
				: ` · ${readableBytes(operation.received)}`;
	return `${action} · ${phase}${progress}`;
}

function mutationConfirmation(
	item: AcpCatalogItem,
	target: AcpTargetStatus,
	action: AcpManagedMutationAction,
): string {
	if (action === "remove") {
		return `remove Hlid-managed ${item.name} from ${target.label}?`;
	}
	if (action === "update") {
		const versions =
			target.installedVersion && target.registryVersion
				? ` from v${target.installedVersion} to v${target.registryVersion}`
				: "";
		return `update ${item.name}${versions} in ${target.label}?`;
	}
	if (target.provenance === "external") {
		return `install a Hlid-managed ${item.name} v${target.registryVersion} in ${target.label} and switch Hlid to it? The existing installation will remain unchanged.`;
	}
	return `install ${item.name} v${target.registryVersion} in ${target.label}?`;
}

function TargetMutationAction({
	item,
	target,
	action,
	disabled,
	buttonAriaLabel,
	onMutate,
}: {
	item: AcpCatalogItem;
	target: AcpTargetStatus;
	action: AcpManagedMutationAction;
	disabled: boolean;
	buttonAriaLabel?: string;
	onMutate: (action: AcpManagedMutationAction) => void;
}) {
	const destructive = action === "remove";
	const active = target.operation?.action === action;
	const externalHandoff =
		action === "install" && target.provenance === "external";
	const label =
		action === "remove"
			? "Remove"
			: action === "update"
				? "Update"
				: externalHandoff
					? "Manage with Hlid"
					: "Install";
	const activeLabel =
		action === "remove"
			? "Removing…"
			: action === "update"
				? "Updating…"
				: "Installing…";
	return (
		<ConfirmAction
			label={mutationConfirmation(item, target, action)}
			confirmText={externalHandoff ? "manage" : action}
			variant={destructive ? "destructive" : "primary"}
			onConfirm={() => onMutate(action)}
			disabled={disabled}
			stacked
			className="justify-end flex-wrap"
			trigger={(open) => (
				<button
					type="button"
					aria-label={buttonAriaLabel}
					disabled={disabled}
					onClick={open}
					className={`border px-3 py-1.5 text-[10px] tracking-widest uppercase disabled:opacity-40 ${
						destructive
							? "border-destructive/40 text-destructive hover:bg-destructive/10"
							: "border-primary/40 text-primary hover:bg-primary/10"
					}`}
				>
					{active ? activeLabel : label}
				</button>
			)}
		/>
	);
}

function AcpTargetInstallation({
	item,
	target,
	selectedTargetId,
	enabled,
	disabled,
	configurationCurrent,
	onSelectTarget,
	onManagedMutation,
}: {
	item: AcpCatalogItem;
	target: AcpTargetStatus | undefined;
	selectedTargetId: string;
	enabled: boolean;
	disabled: boolean;
	configurationCurrent: boolean;
	onSelectTarget: (targetId: string) => void;
	onManagedMutation: (
		targetId: string,
		action: AcpManagedMutationAction,
	) => void;
}) {
	if (item.targets.length === 0) return null;
	const operation = target ? operationLabel(target) : null;
	const otherManagedUpdates = enabled
		? item.targets.filter(
				(candidate) =>
					candidate.targetId !== target?.targetId &&
					candidate.provenance === "managed" &&
					candidate.canUpdate,
			)
		: [];
	const targetLocked = disabled || enabled || Boolean(target?.operation);
	const version = target?.installedVersion ?? target?.observedVersion;
	const status = !target
		? "Execution environment unavailable"
		: target.provenance === "managed"
			? `Managed by Hlid · ${target.label}${version ? ` · v${version}` : ""}`
			: target.provenance === "external"
				? `Externally managed · ${target.label}${version ? ` · v${version}` : ""}`
				: `Not installed in ${target.label}`;
	return (
		<div className="min-w-0 space-y-2 border border-border/70 bg-background/40 px-3 py-3">
			<div className="flex min-w-0 flex-col gap-2 @2xl:flex-row @2xl:items-end @2xl:justify-between">
				<label className="min-w-0 text-[9px] tracking-widest text-muted-foreground uppercase">
					Execution environment
					<select
						aria-label={`${item.name} execution environment`}
						value={selectedTargetId}
						disabled={targetLocked}
						onChange={(event) => onSelectTarget(event.target.value)}
						className="mt-1 w-full min-w-0 border border-border bg-input px-2.5 py-1.5 text-xs normal-case disabled:opacity-60"
					>
						{item.targets.map((candidate) => (
							<option key={candidate.targetId} value={candidate.targetId}>
								{candidate.label}
								{candidate.recommended ? " · Recommended" : ""}
							</option>
						))}
					</select>
				</label>
				<div
					className={`text-xs ${
						target?.available ? "text-status-success" : "text-status-warning"
					}`}
				>
					{status}
				</div>
			</div>
			{enabled && (
				<p className="text-[10px] text-muted-foreground">
					Disable this agent before changing its execution environment or
					removing its managed installation.
				</p>
			)}
			{target?.resolvedExecutable && (
				<div className="break-all text-[10px] text-muted-foreground">
					<span className="tracking-widest uppercase">Resolved CLI</span>{" "}
					<code className="text-foreground/80">
						{target.resolvedExecutable}
					</code>
				</div>
			)}
			{operation && (
				<output className="block text-xs text-primary" aria-live="polite">
					{operation}
				</output>
			)}
			{target?.error && (
				<p className="text-xs text-destructive" role="alert">
					{target.error}
				</p>
			)}
			{target?.blockedReason && !target.operation && (
				<p className="text-[10px] text-status-warning">
					{target.blockedReason}
				</p>
			)}
			{target?.provenance === "external" && (
				<p className="text-[10px] text-muted-foreground">
					{target.canInstall
						? "Hlid can use this executable now or switch to a verified Hlid-managed copy. The existing installation stays untouched."
						: "Hlid can use this executable but will not update or remove it."}
				</p>
			)}
			{target && (
				<div className="flex flex-wrap items-center gap-2">
					{target.canInstall && (
						<TargetMutationAction
							item={item}
							target={target}
							action="install"
							disabled={
								disabled || !configurationCurrent || Boolean(target.operation)
							}
							onMutate={(action) => onManagedMutation(target.targetId, action)}
						/>
					)}
					{target.provenance === "managed" && target.canUpdate && (
						<TargetMutationAction
							item={item}
							target={target}
							action="update"
							disabled={
								disabled || !configurationCurrent || Boolean(target.operation)
							}
							onMutate={(action) => onManagedMutation(target.targetId, action)}
						/>
					)}
					{target.provenance === "managed" && (
						<TargetMutationAction
							item={item}
							target={target}
							action="remove"
							disabled={
								disabled ||
								!configurationCurrent ||
								enabled ||
								!target.canRemove ||
								Boolean(target.operation)
							}
							onMutate={(action) => onManagedMutation(target.targetId, action)}
						/>
					)}
				</div>
			)}
			{otherManagedUpdates.length > 0 && (
				<div className="space-y-2 border-t border-border/60 pt-2">
					<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
						Other environment updates
					</div>
					<p className="text-[10px] text-muted-foreground">
						Updates the exact Hlid-managed installation without changing this
						agent&apos;s active execution environment.
					</p>
					{otherManagedUpdates.map((candidate) => {
						const candidateOperation = operationLabel(candidate);
						return (
							<div
								key={candidate.targetId}
								className="flex min-w-0 flex-col gap-2 border border-border/60 px-2.5 py-2 @2xl:flex-row @2xl:items-center @2xl:justify-between"
							>
								<div className="min-w-0 text-[10px] text-muted-foreground">
									<div className="text-foreground/80">{candidate.label}</div>
									<div>
										v
										{candidate.installedVersion ??
											candidate.observedVersion ??
											"—"}
										{candidate.registryVersion
											? ` → v${candidate.registryVersion}`
											: ""}
									</div>
									{candidateOperation && (
										<output className="block text-primary" aria-live="polite">
											{candidateOperation}
										</output>
									)}
								</div>
								<TargetMutationAction
									item={item}
									target={candidate}
									action="update"
									buttonAriaLabel={`Update ${item.name} in ${candidate.label}`}
									disabled={
										disabled ||
										!configurationCurrent ||
										Boolean(candidate.operation)
									}
									onMutate={(action) =>
										onManagedMutation(candidate.targetId, action)
									}
								/>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

/** One catalog entry: enable toggle, command/install guidance, config overrides, and auth methods. */
export function AcpAgentCard({
	item,
	configured,
	selectedTargetId,
	operation,
	disabled,
	authMethods,
	agentInfo,
	canListSessions,
	providerSessions,
	providerSessionImports,
	importingProviderSessionId,
	models,
	onDiscoverModels,
	optionsRefreshed,
	configurationCurrent,
	managedMutationConfigurationCurrent = configurationCurrent,
	onToggle,
	onSelectTarget,
	onManagedMutation,
	onUpdateOverride,
	onInspect,
	onRefreshOptions,
	onBrowseProviderSessions,
	onCloseProviderSessions,
	onImportProviderSession,
	ollamaModelCount = 0,
	onOpenOllama,
}: {
	item: AcpCatalogItem;
	configured: AcpAgentConfig | undefined;
	selectedTargetId: string;
	operation: AcpCardOperation;
	disabled: boolean;
	authMethods: AcpAuthMethod[] | undefined;
	agentInfo: AcpAgentInfo | null | undefined;
	canListSessions?: boolean;
	providerSessions?: AcpProviderNativeSessionPage | null;
	providerSessionImports?: Record<string, AcpProviderSessionImportResult>;
	importingProviderSessionId?: string;
	models?: AcpModelOption[];
	onDiscoverModels?: () => Promise<ProviderInfo["models"]>;
	optionsRefreshed: boolean;
	configurationCurrent: boolean;
	managedMutationConfigurationCurrent?: boolean;
	onToggle: () => void;
	onSelectTarget: (targetId: string) => void;
	onManagedMutation: (
		targetId: string,
		action: AcpManagedMutationAction,
	) => void;
	onUpdateOverride: (patch: Partial<AcpAgentConfig>) => void;
	onInspect: (methodId?: string) => void;
	onRefreshOptions: () => void;
	onBrowseProviderSessions?: (cursor?: string) => void;
	onCloseProviderSessions?: () => void;
	onImportProviderSession?: (providerSessionId: string) => void;
	ollamaModelCount?: number;
	onOpenOllama?: () => void;
}) {
	const enabled = Boolean(configured);
	const openCode = item.id === "opencode";
	const selectedTarget =
		item.targets.find((target) => target.targetId === selectedTargetId) ??
		item.targets.find((target) => target.selected) ??
		item.targets.find((target) => target.recommended) ??
		item.targets[0];
	const available = selectedTarget?.available ?? item.available;
	const canEnable = selectedTarget?.canEnable ?? item.available;
	const canConfigureExternal =
		selectedTarget?.provenance === "missing" && !selectedTarget.canInstall;
	const resolvedExecutable =
		selectedTarget?.resolvedExecutable ?? item.resolvedExecutable;
	const command = selectedTarget?.command ?? item.command;
	const args = selectedTarget?.args ?? item.args;
	const installGuidance =
		selectedTarget?.installGuidance ?? item.installGuidance;
	const invocation = invocationLabel(item, selectedTarget);
	return (
		<div className="min-w-0 space-y-3 px-4 py-3">
			{openCode && (
				<div className="flex min-w-0 flex-wrap items-center gap-2 text-[9px] tracking-widest uppercase">
					<span className="border border-primary/40 bg-primary/10 px-2 py-0.5 text-primary">
						Featured integration
					</span>
					<span className="text-muted-foreground">OpenCode over ACP</span>
				</div>
			)}
			<div className="flex min-w-0 flex-col items-start gap-3 @2xl:flex-row @2xl:justify-between">
				<div className="min-w-0">
					<div className="break-words text-sm">
						{item.name}{" "}
						<span className="text-[9px] text-muted-foreground">
							{openCode ? "ACP registry" : "catalog"} {item.version}
						</span>
					</div>
					<p className="break-words text-xs text-muted-foreground">
						{openCode
							? "Use OpenCode in Raven through its supported Agent Client Protocol connection."
							: item.description}
					</p>
				</div>
				{(enabled || canEnable || canConfigureExternal) && (
					<button
						type="button"
						disabled={disabled}
						onClick={onToggle}
						className="shrink-0 border border-border px-2 py-1 text-[10px] uppercase disabled:opacity-40"
					>
						{enabled ? "Disable" : "Enable"}
					</button>
				)}
			</div>
			<AcpTargetInstallation
				item={item}
				target={selectedTarget}
				selectedTargetId={selectedTarget?.targetId ?? selectedTargetId}
				enabled={enabled}
				disabled={disabled}
				configurationCurrent={managedMutationConfigurationCurrent}
				onSelectTarget={onSelectTarget}
				onManagedMutation={onManagedMutation}
			/>
			{openCode ? (
				<div
					className={`min-w-0 space-y-2 border px-3 py-2 text-xs ${
						available
							? "border-status-success/30 bg-status-success/5"
							: "border-status-warning/30 bg-status-warning/5"
					}`}
				>
					<div
						className={
							available ? "text-status-success" : "text-status-warning"
						}
					>
						{available
							? enabled
								? agentInfo
									? "OpenCode ACP initialized"
									: "OpenCode CLI found · verify the ACP connection"
								: "OpenCode CLI found · enable it to use Raven"
							: "OpenCode CLI not found"}
					</div>
					{available ? (
						<div className="min-w-0 space-y-1 text-[10px] text-muted-foreground">
							<div>
								<span className="uppercase tracking-widest">ACP command</span>{" "}
								<code className="break-all text-foreground/80">
									{invocation}
								</code>
							</div>
							<p>
								OpenCode Desktop is optional here; Hlid connects directly to
								this CLI.
							</p>
						</div>
					) : (
						<div className="space-y-1 text-[10px] text-muted-foreground">
							<p>
								OpenCode Desktop and the OpenCode CLI are separate installs.
								Hlid needs the CLI in the selected execution environment.
							</p>
							<p className="break-words text-status-warning/90">
								{selectedTarget?.blockedReason ??
									item.unavailableReason ??
									installGuidance}
							</p>
							<p>{installGuidance}</p>
						</div>
					)}
				</div>
			) : (
				<div className="min-w-0 space-y-0.5 break-all font-mono text-[10px] text-muted-foreground">
					<div>
						{available ? `${invocation} · path found` : installGuidance}
					</div>
					{available && resolvedExecutable && (
						<div>resolved {resolvedExecutable}</div>
					)}
				</div>
			)}
			{agentInfo && (
				<div className="break-all font-mono text-[10px] text-status-success/80">
					{openCode ? "installed" : "initialized"} {agentInfo.name}{" "}
					{agentInfo.version}
				</div>
			)}
			{openCode && (
				<div className="grid min-w-0 gap-2 text-[10px] text-muted-foreground @2xl:grid-cols-2">
					<div className="border border-border/70 px-3 py-2">
						<div className="mb-1 tracking-widest text-foreground/70 uppercase">
							Available through ACP
						</div>
						Raven chat, OpenCode tools, approval requests, project instructions,
						modes, and OpenCode-configured MCP servers.
					</div>
					<div className="border border-border/70 px-3 py-2">
						<div className="mb-1 tracking-widest text-foreground/70 uppercase">
							Connection boundary
						</div>
						Provider-native session browsing appears only when OpenCode
						advertises it. Desktop controls and message-level undo or redo
						remain provider-owned.
					</div>
					<p className="@2xl:col-span-2">
						Models, modes, and effort controls come from the current OpenCode
						workspace. Model visibility configures what OpenCode exposes to Hlid
						sessions; Hlid does not infer account-level hidden models.
					</p>
				</div>
			)}
			{openCode && (
				<div className="flex min-w-0 flex-col gap-3 border border-primary/25 bg-background/50 px-3 py-3 @2xl:flex-row @2xl:items-center @2xl:justify-between">
					<div className="min-w-0">
						<div className="text-[9px] tracking-widest text-foreground/70 uppercase">
							Ollama local models
						</div>
						<p className="break-words text-[10px] text-muted-foreground">
							{ollamaModelCount > 0
								? configured
									? `${ollamaModelCount} Ollama model${ollamaModelCount === 1 ? "" : "s"} configured for Hlid-managed OpenCode.`
									: `${ollamaModelCount} Ollama model${ollamaModelCount === 1 ? " is" : "s are"} selected. Enable OpenCode to connect ${ollamaModelCount === 1 ? "it" : "them"}.`
								: "No Ollama models are configured for OpenCode. Ollama is managed as its own Forge integration."}
						</p>
					</div>
					{onOpenOllama && (
						<button
							type="button"
							onClick={onOpenOllama}
							className="min-h-11 shrink-0 border border-primary/40 px-3 py-1.5 text-[10px] tracking-widest text-primary uppercase hover:bg-primary/10 lg:min-h-0"
						>
							{ollamaModelCount > 0 ? "Manage Ollama" : "Set up Ollama"}
						</button>
					)}
				</div>
			)}
			{openCode && configured && (
				<>
					<OpenCodeGoUsage
						configured={configured}
						disabled={disabled}
						onUpdateOverride={onUpdateOverride}
					/>
					<OpenCodeModelVisibility
						key={`${configurationCurrent}:${modelDiscoveryIdentity(item)}`}
						configured={configured}
						models={models}
						disabled={disabled}
						configurationCurrent={configurationCurrent}
						onUpdateOverride={onUpdateOverride}
						onDiscoverModels={onDiscoverModels}
					/>
				</>
			)}
			{configured && (
				<div className="grid sm:grid-cols-2 gap-2">
					<label className="text-[9px] tracking-widest text-muted-foreground uppercase">
						Executable override
						<input
							disabled={disabled}
							value={configured.executable ?? ""}
							onChange={(event) =>
								onUpdateOverride({
									executable: event.target.value || undefined,
								})
							}
							placeholder={command || "full command path"}
							className="mt-1 w-full bg-input border border-border px-2 py-1 text-xs font-mono normal-case"
						/>
					</label>
					<label className="text-[9px] tracking-widest text-muted-foreground uppercase">
						Arguments override
						<input
							disabled={disabled}
							value={configured.args?.join(" ") ?? ""}
							onChange={(event) =>
								onUpdateOverride({
									args: event.target.value.trim()
										? event.target.value.trim().split(/\s+/)
										: undefined,
								})
							}
							placeholder={args.join(" ")}
							className="mt-1 w-full bg-input border border-border px-2 py-1 text-xs font-mono normal-case"
						/>
					</label>
				</div>
			)}
			{enabled && available && (
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
					<button
						type="button"
						disabled={disabled || !configurationCurrent}
						onClick={() => onInspect()}
						className="text-[10px] text-primary uppercase"
					>
						{!configurationCurrent
							? "Waiting for saved configuration…"
							: operation === "inspect"
								? openCode
									? "Verifying…"
									: "Checking…"
								: openCode
									? "Verify OpenCode ACP"
									: "Inspect agent"}
					</button>
					{canListSessions && onBrowseProviderSessions && (
						<button
							type="button"
							disabled={disabled || !configurationCurrent}
							onClick={() => onBrowseProviderSessions()}
							className="text-[10px] text-primary uppercase disabled:text-muted-foreground/50"
						>
							{operation === "sessions" && !providerSessions
								? "Loading provider sessions…"
								: "Browse provider sessions"}
						</button>
					)}
					{canListSessions === false && (
						<span className="text-[10px] text-muted-foreground">
							Provider-native session listing not advertised.
						</span>
					)}
					<button
						type="button"
						disabled={disabled || !configurationCurrent}
						onClick={onRefreshOptions}
						className="text-[10px] text-primary uppercase"
					>
						{!configurationCurrent
							? "Waiting for saved configuration…"
							: operation === "refresh"
								? "Refreshing…"
								: openCode
									? "Refresh models & modes"
									: "Refresh options"}
					</button>
					{optionsRefreshed && (
						<span
							className="text-[10px] text-status-success/80"
							aria-live="polite"
						>
							{openCode
								? "Models and modes refreshed for this workspace."
								: "Options refreshed for this workspace."}
						</span>
					)}
				</div>
			)}
			{providerSessions &&
				onBrowseProviderSessions &&
				onCloseProviderSessions &&
				onImportProviderSession && (
					<ProviderNativeSessionBrowser
						item={item}
						page={providerSessions}
						imports={providerSessionImports}
						disabled={disabled}
						operation={operation}
						importingProviderSessionId={importingProviderSessionId}
						onLoadMore={onBrowseProviderSessions}
						onClose={onCloseProviderSessions}
						onImport={onImportProviderSession}
					/>
				)}
			{authMethods && authMethods.length > 0 && (
				<div className="min-w-0 space-y-2">
					<div className="space-y-1 text-xs text-muted-foreground">
						<div className="text-[9px] tracking-widest uppercase">
							Credential management
						</div>
						<p>
							{openCode
								? "OpenCode advertises these credential actions; it does not mean you are signed out. Use them only to add or replace credentials."
								: "These are login methods advertised by the agent, not a sign-in status. If the agent is already signed in, no action is needed."}
						</p>
					</div>
					{authMethods.map((method) => (
						<AcpAuthMethodRow
							key={method.id}
							method={method}
							item={item}
							disabled={disabled}
							onAuthenticate={(methodId) => onInspect(methodId)}
						/>
					))}
				</div>
			)}
		</div>
	);
}
