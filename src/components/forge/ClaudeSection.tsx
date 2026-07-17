import type { HlidConfig } from "#/config";
import {
	defaultEffortFor,
	effortOptionsFor,
	modelOptions as getModelOptions,
} from "#/lib/providerOptions";
import type { AccountInfo, ProviderInfo } from "#/lib/providerTypes";
import { Field, Section, StatusIndicator } from "./fields";

export type ClaudeForm = {
	model: string;
	effort: HlidConfig["claude"]["effort"];
	maxTurns: string;
	permissionMode: HlidConfig["claude"]["permission_mode"];
	turnRecaps: boolean;
	recapModel: string;
	vaultProvider: string;
	/** Use Claude CLI directly in a terminal instead of the Agent SDK. */
	interactiveMode: boolean;
	/** Codex-only Windows-native Computer Use preferences. */
	windowsComputerUseModel?: string;
	windowsComputerUseEffort?: string;
};

const selectClass =
	"w-32 sm:w-48 lg:w-80 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50 transition-colors appearance-none cursor-pointer";

function ProviderField({
	claude,
	onChange,
	providers,
}: {
	claude: ClaudeForm;
	onChange: (patch: Partial<ClaudeForm>) => void;
	providers: ProviderInfo[];
}) {
	const active = providers.find((p) => p.id === claude.vaultProvider);
	return (
		<Field label="Provider" hint="provider used for vault chat">
			<div className="flex items-center gap-2">
				<select
					value={claude.vaultProvider}
					onChange={(e) => onChange({ vaultProvider: e.target.value })}
					className={selectClass}
				>
					{providers.map((p) => (
						<option key={p.id} value={p.id}>
							{p.label}
						</option>
					))}
				</select>
				{active?.available === false && (
					<span className="text-[9px] text-destructive/70">
						{active?.unavailableReason ?? "unavailable"}
					</span>
				)}
			</div>
		</Field>
	);
}

function WindowsComputerUseFields({
	claude,
	onChange,
	provider,
	capability,
}: {
	claude: ClaudeForm;
	onChange: (patch: Partial<ClaudeForm>) => void;
	provider: ProviderInfo;
	capability: NonNullable<ProviderInfo["hostCapabilities"]>[string];
}) {
	const configuredModel = claude.windowsComputerUseModel ?? "inherit";
	const configuredEffort = claude.windowsComputerUseEffort ?? "medium";
	const models = getModelOptions(provider);
	const selectedModel = models.find((model) => model.value === configuredModel);
	const efforts = effortOptionsFor(provider, configuredModel);
	const effortOptions = [
		{
			value: "inherit",
			label: "Inherit from calling session",
			desc: "Use the reasoning effort selected in the session that requested Computer Use",
		},
		...efforts,
	];
	const changeModel = (model: string) => {
		const availableEfforts = effortOptionsFor(provider, model);
		const patch: Partial<ClaudeForm> = { windowsComputerUseModel: model };
		if (
			configuredEffort !== "inherit" &&
			!availableEfforts.some((effort) => effort.value === configuredEffort)
		) {
			patch.windowsComputerUseEffort =
				defaultEffortFor(provider, model) ??
				availableEfforts[0]?.value ??
				"inherit";
		}
		onChange(patch);
	};
	return (
		<>
			<div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
				<div>
					<div className="text-sm text-foreground">{capability.label}</div>
					<div className="text-xs text-muted-foreground mt-0.5">
						Windows-native desktop worker
					</div>
				</div>
				<StatusIndicator
					ok={capability.available}
					label={
						capability.available
							? "Computer Use ready"
							: "Computer Use unavailable"
					}
				>
					{capability.available
						? "ready"
						: (capability.reason ?? "unavailable")}
				</StatusIndicator>
			</div>
			<Field label="Model">
				<div>
					<select
						aria-label="Computer Use model"
						value={configuredModel}
						onChange={(event) => changeModel(event.target.value)}
						className={selectClass}
					>
						<option value="inherit">Inherit from calling session</option>
						{models.map((model) => (
							<option
								key={model.value}
								value={model.value}
								title={model.description}
							>
								{model.label}
								{model.isDefault ? " (default)" : ""}
							</option>
						))}
					</select>
					<div className="text-xs text-muted-foreground mt-1 max-w-[12rem] sm:max-w-xs lg:max-w-sm">
						{configuredModel === "inherit"
							? "Use the model selected in the session that requested Computer Use."
							: selectedModel?.description}
					</div>
				</div>
			</Field>
			<RadioCardGroup
				legend="EFFORT"
				ariaLabel="Computer Use effort"
				name="computer-use-effort"
				options={effortOptions}
				value={configuredEffort}
				onSelect={(effort) => onChange({ windowsComputerUseEffort: effort })}
			/>
			<div className="px-4 py-3 text-xs text-muted-foreground">
				Applied to the next Computer Use worker. Unsupported native choices use
				a visible safe fallback.
			</div>
		</>
	);
}

function ModelField({
	claude,
	onChange,
	activeProvider,
	allowProviderDefault,
}: {
	claude: ClaudeForm;
	onChange: (patch: Partial<ClaudeForm>) => void;
	activeProvider: ProviderInfo | undefined;
	allowProviderDefault: boolean;
}) {
	const modelOptions = getModelOptions(activeProvider);
	const selectedModel = modelOptions.find((m) => m.value === claude.model);
	// Model switch may invalidate the effort choice — reset to the new model's default.
	const changeModel = (model: string) => {
		const newEffortOptions = effortOptionsFor(activeProvider, model);
		const patch: Partial<ClaudeForm> = { model };
		if (!newEffortOptions.some((o) => o.value === claude.effort)) {
			patch.effort =
				defaultEffortFor(activeProvider, model) ??
				newEffortOptions[0]?.value ??
				"";
		}
		onChange(patch);
	};
	return (
		<Field label="Model">
			<div>
				<select
					value={claude.model}
					onChange={(e) => changeModel(e.target.value)}
					className={selectClass}
				>
					{allowProviderDefault && (
						<option value="">— provider default —</option>
					)}
					{modelOptions.map((m) => (
						<option key={m.value} value={m.value} title={m.description}>
							{m.label}
							{m.isDefault ? " (default)" : ""}
						</option>
					))}
				</select>
				{selectedModel?.description && (
					<div className="text-xs text-muted-foreground mt-1 max-w-[12rem] sm:max-w-xs lg:max-w-sm">
						{selectedModel.description}
					</div>
				)}
			</div>
		</Field>
	);
}

function RadioCardGroup({
	legend,
	ariaLabel,
	name,
	options,
	value,
	onSelect,
}: {
	legend: string;
	ariaLabel?: string;
	name: string;
	options: readonly {
		value: string;
		label: string;
		desc?: string;
		isDefault?: boolean;
	}[];
	value: string;
	onSelect: (value: string) => void;
}) {
	return (
		<fieldset
			aria-label={ariaLabel ?? legend}
			className="border-0 m-0 p-0 px-4 py-3"
		>
			<div className="text-[9px] tracking-widest text-muted-foreground uppercase mb-2">
				{legend}
			</div>
			<div className="space-y-1.5">
				{options.map((opt) => (
					<label
						key={opt.value}
						className={`flex items-start gap-3 p-3 border cursor-pointer transition-colors ${
							value === opt.value
								? "border-primary/40 bg-primary/5"
								: "border-border hover:bg-accent"
						}`}
					>
						<input
							type="radio"
							name={name}
							value={opt.value}
							checked={value === opt.value}
							onChange={() => onSelect(opt.value)}
							className="mt-0.5 accent-primary shrink-0"
						/>
						<div>
							<div className="text-sm text-foreground">
								{opt.label}
								{opt.isDefault ? " (default)" : ""}
							</div>
							{opt.desc && (
								<div className="text-xs text-muted-foreground">{opt.desc}</div>
							)}
						</div>
					</label>
				))}
			</div>
		</fieldset>
	);
}

function CheckboxField({
	label,
	hint,
	checked,
	onChange,
}: {
	label: string;
	hint: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		<Field label={label} hint={hint}>
			<label className="flex items-center gap-2 cursor-pointer">
				<input
					type="checkbox"
					checked={checked}
					onChange={(e) => onChange(e.target.checked)}
					className="w-3.5 h-3.5 accent-primary"
				/>
				<span className="text-xs text-muted-foreground">enabled</span>
			</label>
		</Field>
	);
}

function MaxTurnsField({
	claude,
	onChange,
}: {
	claude: ClaudeForm;
	onChange: (patch: Partial<ClaudeForm>) => void;
}) {
	return (
		<Field
			label="Max turns"
			hint="max turns the provider can run, blank means no limit"
		>
			<input
				type="number"
				min={1}
				value={claude.maxTurns}
				onChange={(e) => {
					const raw = e.target.value;
					if (raw === "") {
						onChange({ maxTurns: "" });
					} else {
						const n = parseInt(raw, 10);
						onChange({
							maxTurns: Number.isFinite(n) ? String(Math.max(1, n)) : "",
						});
					}
				}}
				placeholder="unlimited"
				className="w-32 sm:w-48 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors"
			/>
		</Field>
	);
}

function RecapModelField({
	claude,
	onChange,
	activeProvider,
}: {
	claude: ClaudeForm;
	onChange: (patch: Partial<ClaudeForm>) => void;
	activeProvider: ProviderInfo | undefined;
}) {
	return (
		<Field label="Recap model" hint="model used for turn recap summaries">
			<select
				value={claude.recapModel}
				onChange={(e) => onChange({ recapModel: e.target.value })}
				className={selectClass}
			>
				<option value="">— provider default —</option>
				{getModelOptions(activeProvider).map((m) => (
					<option key={m.value} value={m.value}>
						{m.label}
					</option>
				))}
			</select>
		</Field>
	);
}

export function ClaudeSection({
	claude,
	onChange,
	providers,
	accountInfo,
}: {
	claude: ClaudeForm;
	onChange: (patch: Partial<ClaudeForm>) => void;
	providers: ProviderInfo[];
	/** Account info for the live claude session backing the vault agent, if any. */
	accountInfo?: AccountInfo | null;
}) {
	// Options come from the selected provider's declared capabilities.
	const activeProvider = providers.find((p) => p.id === claude.vaultProvider);
	const modelOptions = getModelOptions(activeProvider);
	const effortOptions = effortOptionsFor(activeProvider, claude.model);
	const permissionOptions = activeProvider?.permissionModes ?? [];
	const isClaude = claude.vaultProvider === "claude";
	// Show provider-specific settings only when the provider declares capabilities.
	const hasProviderOptions =
		modelOptions.length > 0 ||
		effortOptions.length > 0 ||
		permissionOptions.length > 0;

	return (
		<Section title="Vault Agent">
			{accountInfo && (
				<div className="px-4 py-2 text-xs text-muted-foreground border-b border-border/50">
					Account: {accountInfo.email ?? "unknown"}
					{accountInfo.subscriptionType
						? ` · ${accountInfo.subscriptionType}`
						: ""}
				</div>
			)}
			{providers.length > 0 && (
				<ProviderField
					claude={claude}
					onChange={onChange}
					providers={providers}
				/>
			)}
			{activeProvider?.hostCapabilities &&
				Object.entries(activeProvider.hostCapabilities).map(
					([id, capability]) =>
						id === "windowsComputerUse" ? null : (
							<Field key={id} label={capability.label} hint="host capability">
								<span
									className={
										capability.available
											? "text-[10px] text-green-600/80"
											: "text-[10px] text-destructive/70"
									}
								>
									{capability.available
										? "ready"
										: (capability.reason ?? "unavailable")}
								</span>
							</Field>
						),
				)}
			{hasProviderOptions && (
				<>
					{modelOptions.length > 0 && (
						<ModelField
							claude={claude}
							onChange={onChange}
							activeProvider={activeProvider}
							allowProviderDefault={!isClaude}
						/>
					)}
					{effortOptions.length > 0 && (
						<RadioCardGroup
							legend="EFFORT"
							name="effort"
							options={effortOptions}
							value={claude.effort}
							onSelect={(effort) => onChange({ effort })}
						/>
					)}
					{permissionOptions.length > 0 && (
						<RadioCardGroup
							legend="PERMISSIONS"
							name="permission"
							options={permissionOptions}
							value={claude.permissionMode}
							onSelect={(value) =>
								onChange({
									permissionMode:
										value as HlidConfig["claude"]["permission_mode"],
								})
							}
						/>
					)}
					<MaxTurnsField claude={claude} onChange={onChange} />
					<CheckboxField
						label="Turn recaps"
						hint="generate a brief summary after turns with tool use"
						checked={claude.turnRecaps}
						onChange={(turnRecaps) => onChange({ turnRecaps })}
					/>
					<RecapModelField
						claude={claude}
						onChange={onChange}
						activeProvider={activeProvider}
					/>
					{isClaude && (
						<CheckboxField
							label="Interactive mode"
							hint='to not go against your "programmatic" usage, if you desire'
							checked={claude.interactiveMode}
							onChange={(interactiveMode) => onChange({ interactiveMode })}
						/>
					)}
				</>
			)}
		</Section>
	);
}

export function ComputerUseSection({
	claude,
	onChange,
	providers,
}: {
	claude: ClaudeForm;
	onChange: (patch: Partial<ClaudeForm>) => void;
	providers: ProviderInfo[];
}) {
	const provider = providers.find(
		(candidate) => candidate.id === claude.vaultProvider,
	);
	const capability = provider?.hostCapabilities?.windowsComputerUse;
	if (provider?.id !== "codex" || !capability) return null;

	return (
		<Section title="Computer Use">
			<WindowsComputerUseFields
				claude={claude}
				onChange={onChange}
				provider={provider}
				capability={capability}
			/>
		</Section>
	);
}
