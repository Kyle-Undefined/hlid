import {
	effortOptionsFor,
	modelOptions as getModelOptions,
} from "#/lib/providerOptions";
import type { ProviderInfo } from "#/lib/serverFns";

export type AgentConfigurationValue = {
	mode: "cwd" | "context";
	provider: string;
	model: string;
	effort: string;
	maxTurns: string;
	permissionMode: string;
	recapModel: string;
	interactiveMode?: boolean;
};

const selectClass =
	"flex-1 bg-secondary border border-border px-2 py-1 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50 transition-colors appearance-none cursor-pointer";

function FieldRow({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex items-center gap-2">
			<span className="text-[9px] tracking-widest text-muted-foreground/50 uppercase shrink-0 w-24">
				{label}
			</span>
			{children}
		</div>
	);
}

function ModelOptions({
	models,
}: {
	models: ReturnType<typeof getModelOptions>;
}) {
	return models.map((model) => (
		<option key={model.value} value={model.value} title={model.description}>
			{model.label}
			{model.isDefault ? " (default)" : ""}
		</option>
	));
}

export function AgentConfigurationFields({
	value,
	providers,
	onChange,
	includeInteractive = false,
}: {
	value: AgentConfigurationValue;
	providers: ProviderInfo[];
	onChange: (patch: Partial<AgentConfigurationValue>) => void;
	includeInteractive?: boolean;
}) {
	const activeProvider = providers.find(
		(provider) => provider.id === value.provider,
	);
	const modelOptions = getModelOptions(activeProvider);
	const effortOptions = effortOptionsFor(activeProvider, value.model);
	const permissionOptions = activeProvider?.permissionModes ?? [];
	const hasProviderOptions =
		modelOptions.length > 0 ||
		effortOptions.length > 0 ||
		permissionOptions.length > 0;
	const unavailableReason =
		activeProvider?.available === false
			? (activeProvider.unavailableReason ?? "unavailable")
			: null;

	return (
		<>
			<div className="flex items-center gap-2 flex-wrap">
				<span className="text-[9px] tracking-widest text-muted-foreground/50 uppercase shrink-0">
					Mode
				</span>
				<div className="flex border border-border">
					<button
						type="button"
						onClick={() => onChange({ mode: "cwd" })}
						className={`text-[10px] tracking-widest px-2.5 py-1 uppercase transition-colors ${
							value.mode === "cwd"
								? "bg-primary/10 text-primary"
								: "text-muted-foreground/60 hover:text-foreground"
						}`}
					>
						CWD
					</button>
					<button
						type="button"
						onClick={() => onChange({ mode: "context" })}
						className={`text-[10px] tracking-widest px-2.5 py-1 uppercase transition-colors border-l border-border ${
							value.mode === "context"
								? "bg-primary/10 text-primary"
								: "text-muted-foreground/60 hover:text-foreground"
						}`}
					>
						CONTEXT
					</button>
				</div>
				<span className="text-[9px] text-muted-foreground/40 leading-snug">
					{value.mode === "cwd"
						? "claude runs in agent's directory"
						: "claude stays in vault, loads CLAUDE.md as persona"}
				</span>
			</div>

			{providers.length > 0 && (
				<div className="flex items-center gap-2">
					<span className="text-[9px] tracking-widest text-muted-foreground/50 uppercase shrink-0">
						Provider
					</span>
					<div className="flex border border-border">
						{providers.map((provider, index) => (
							<button
								key={provider.id}
								type="button"
								onClick={() => onChange({ provider: provider.id })}
								className={`text-[10px] tracking-widest px-2.5 py-1 uppercase transition-colors ${index > 0 ? "border-l border-border" : ""} ${
									value.provider === provider.id
										? "bg-primary/10 text-primary"
										: "text-muted-foreground/60 hover:text-foreground"
								}`}
							>
								{provider.label}
							</button>
						))}
					</div>
					{unavailableReason && (
						<span className="text-[9px] text-destructive/70">
							{unavailableReason}
						</span>
					)}
				</div>
			)}

			{hasProviderOptions && (
				<div className="space-y-2 pt-1">
					<FieldRow label="Model">
						<select
							value={value.model}
							onChange={(event) => {
								const model = event.target.value;
								const validEfforts = effortOptionsFor(activeProvider, model);
								onChange({
									model,
									effort:
										value.effort &&
										!validEfforts.some(
											(option) => option.value === value.effort,
										)
											? ""
											: value.effort,
								});
							}}
							className={selectClass}
						>
							<option value="">— vault default —</option>
							<ModelOptions models={modelOptions} />
						</select>
					</FieldRow>

					<FieldRow label="Effort">
						<select
							value={value.effort}
							onChange={(event) => onChange({ effort: event.target.value })}
							className={selectClass}
						>
							<option value="">— vault default —</option>
							{effortOptions.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
									{option.isDefault ? " (default)" : ""}
								</option>
							))}
						</select>
					</FieldRow>

					<FieldRow label="Permissions">
						<select
							value={value.permissionMode}
							onChange={(event) =>
								onChange({ permissionMode: event.target.value })
							}
							className={selectClass}
						>
							<option value="">— vault default —</option>
							{permissionOptions.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</select>
					</FieldRow>

					<FieldRow label="Max turns">
						<input
							type="number"
							min={1}
							value={value.maxTurns}
							onChange={(event) => {
								const parsed = Number.parseInt(event.target.value, 10);
								onChange({
									maxTurns:
										event.target.value === "" || !Number.isFinite(parsed)
											? ""
											: String(Math.max(1, parsed)),
								});
							}}
							placeholder="vault default"
							className="flex-1 bg-secondary border border-border px-2 py-1 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors"
						/>
					</FieldRow>

					<FieldRow label="Recap model">
						<select
							value={value.recapModel}
							onChange={(event) => onChange({ recapModel: event.target.value })}
							className={selectClass}
						>
							<option value="">
								{activeProvider?.id === "claude"
									? "— default (haiku) —"
									: "— provider default —"}
							</option>
							<ModelOptions models={modelOptions} />
						</select>
					</FieldRow>

					{includeInteractive && value.provider === "claude" && (
						<FieldRow label="Interactive mode">
							<label className="flex items-center gap-2 cursor-pointer">
								<input
									type="checkbox"
									checked={value.interactiveMode === true}
									onChange={(event) =>
										onChange({ interactiveMode: event.target.checked })
									}
									className="w-3.5 h-3.5 accent-primary"
								/>
								<span className="text-xs text-muted-foreground">
									to not go against your &quot;programmatic&quot; usage, if you
									desire
								</span>
							</label>
						</FieldRow>
					)}
				</div>
			)}
		</>
	);
}
