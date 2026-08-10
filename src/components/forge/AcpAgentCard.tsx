import { useEffect, useMemo, useRef, useState } from "react";
import type { HlidConfig } from "#/config";
import type { ProviderInfo } from "#/lib/providerTypes";
import { includesSearchText } from "#/lib/search";
import type {
	AcpAgentInfo,
	AcpAuthMethod,
	AcpCatalogItem,
} from "#/lib/serverFns/acp";
import { AcpAuthMethodRow } from "./AcpAuthMethodRow";

export type AcpAgentConfig = NonNullable<HlidConfig["acp_agents"]>[number];
export type AcpModelOption = NonNullable<ProviderInfo["models"]>[number];
type OpenCodeModelFilter = NonNullable<AcpAgentConfig["model_filter"]>;
type OpenCodeModelFilterMode = "all" | OpenCodeModelFilter["mode"];
type AcpCardOperation = "inspect" | "refresh" | null;
const EMPTY_MODEL_IDS: string[] = [];
const MAX_MODEL_FILTER_SELECTIONS = 256;

function invocationLabel(item: AcpCatalogItem): string {
	return [item.command, ...item.args].filter(Boolean).join(" ");
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

/** One catalog entry: enable toggle, command/install guidance, config overrides, and auth methods. */
export function AcpAgentCard({
	item,
	configured,
	operation,
	disabled,
	authMethods,
	agentInfo,
	models,
	onDiscoverModels,
	optionsRefreshed,
	configurationCurrent,
	onToggle,
	onUpdateOverride,
	onInspect,
	onRefreshOptions,
}: {
	item: AcpCatalogItem;
	configured: AcpAgentConfig | undefined;
	operation: AcpCardOperation;
	disabled: boolean;
	authMethods: AcpAuthMethod[] | undefined;
	agentInfo: AcpAgentInfo | null | undefined;
	models?: AcpModelOption[];
	onDiscoverModels?: () => Promise<ProviderInfo["models"]>;
	optionsRefreshed: boolean;
	configurationCurrent: boolean;
	onToggle: () => void;
	onUpdateOverride: (patch: Partial<AcpAgentConfig>) => void;
	onInspect: (methodId?: string) => void;
	onRefreshOptions: () => void;
}) {
	const enabled = Boolean(configured);
	const openCode = item.id === "opencode";
	const invocation = invocationLabel(item);
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
				<button
					type="button"
					disabled={disabled}
					onClick={onToggle}
					className="shrink-0 border border-border px-2 py-1 text-[10px] uppercase"
				>
					{enabled ? "Disable" : "Enable"}
				</button>
			</div>
			{openCode ? (
				<div
					className={`min-w-0 space-y-2 border px-3 py-2 text-xs ${
						item.available
							? "border-status-success/30 bg-status-success/5"
							: "border-status-warning/30 bg-status-warning/5"
					}`}
				>
					<div
						className={
							item.available ? "text-status-success" : "text-status-warning"
						}
					>
						{item.available
							? enabled
								? agentInfo
									? "OpenCode ACP initialized"
									: "OpenCode CLI found · verify the ACP connection"
								: "OpenCode CLI found · enable it to use Raven"
							: "OpenCode CLI not found"}
					</div>
					{item.available ? (
						<div className="min-w-0 space-y-1 text-[10px] text-muted-foreground">
							<div>
								<span className="uppercase tracking-widest">Resolved CLI</span>{" "}
								<code className="break-all text-foreground/80">
									{item.resolvedExecutable ?? item.command}
								</code>
							</div>
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
								Hlid needs the CLI in the same environment where Hlid runs.
							</p>
							<p className="break-words text-status-warning/90">
								{item.unavailableReason ?? item.installGuidance}
							</p>
							<p>{item.installGuidance}</p>
						</div>
					)}
				</div>
			) : (
				<div className="min-w-0 space-y-0.5 break-all font-mono text-[10px] text-muted-foreground">
					<div>
						{item.available
							? `${invocation} · path found`
							: item.installGuidance}
					</div>
					{item.available && item.resolvedExecutable && (
						<div>resolved {item.resolvedExecutable}</div>
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
						Desktop session management and message-level undo or redo are not
						exposed by this ACP connection.
					</div>
					<p className="@2xl:col-span-2">
						Models, modes, and effort controls come from the current OpenCode
						workspace. Model visibility configures what OpenCode exposes to Hlid
						sessions; Hlid does not infer account-level hidden models.
					</p>
				</div>
			)}
			{openCode && configured && (
				<OpenCodeModelVisibility
					key={`${configurationCurrent}:${modelDiscoveryIdentity(item)}`}
					configured={configured}
					models={models}
					disabled={disabled}
					configurationCurrent={configurationCurrent}
					onUpdateOverride={onUpdateOverride}
					onDiscoverModels={onDiscoverModels}
				/>
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
							placeholder={item.command || "full command path"}
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
							placeholder={item.args.join(" ")}
							className="mt-1 w-full bg-input border border-border px-2 py-1 text-xs font-mono normal-case"
						/>
					</label>
				</div>
			)}
			{enabled && item.available && (
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
