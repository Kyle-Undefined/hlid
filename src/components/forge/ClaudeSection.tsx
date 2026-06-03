import type { HlidConfig } from "#/config";
import type { ProviderInfo } from "#/lib/serverFns";
import { Field, Section } from "./fields";

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
};

export function ClaudeSection({
	claude,
	onChange,
	providers,
}: {
	claude: ClaudeForm;
	onChange: (patch: Partial<ClaudeForm>) => void;
	providers: ProviderInfo[];
}) {
	// Options come from the selected provider's declared capabilities.
	const activeProvider = providers.find((p) => p.id === claude.vaultProvider);
	const modelOptions = activeProvider?.models ?? [];
	const effortOptions = activeProvider?.effortLevels ?? [];
	const permissionOptions = activeProvider?.permissionModes ?? [];
	const isClaude = claude.vaultProvider === "claude";
	const allowsProviderDefaultModel = !isClaude;
	// Show provider-specific settings only when the provider declares capabilities.
	const hasProviderOptions =
		modelOptions.length > 0 ||
		effortOptions.length > 0 ||
		permissionOptions.length > 0;

	return (
		<Section title="Vault Agent">
			{providers.length > 0 && (
				<Field label="Provider" hint="provider used for vault chat">
					<div className="flex items-center gap-2">
						<select
							value={claude.vaultProvider}
							onChange={(e) => onChange({ vaultProvider: e.target.value })}
							className="w-32 sm:w-48 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50 transition-colors appearance-none cursor-pointer"
						>
							{providers.map((p) => (
								<option key={p.id} value={p.id}>
									{p.label}
								</option>
							))}
						</select>
						{providers.find((p) => p.id === claude.vaultProvider)?.available ===
							false && (
							<span className="text-[9px] text-destructive/70">
								{providers.find((p) => p.id === claude.vaultProvider)
									?.unavailableReason ?? "unavailable"}
							</span>
						)}
					</div>
				</Field>
			)}
			{hasProviderOptions && (
				<>
					{modelOptions.length > 0 && (
						<Field label="Model">
							<select
								value={claude.model}
								onChange={(e) => onChange({ model: e.target.value })}
								className="w-32 sm:w-48 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50 transition-colors appearance-none cursor-pointer"
							>
								{allowsProviderDefaultModel && (
									<option value="">— provider default —</option>
								)}
								{modelOptions.map((m) => (
									<option key={m.value} value={m.value}>
										{m.label}
									</option>
								))}
							</select>
						</Field>
					)}
					{effortOptions.length > 0 && (
						<fieldset className="border-0 m-0 p-0 px-4 py-3">
							<div className="text-[9px] tracking-widest text-muted-foreground uppercase mb-2">
								EFFORT
							</div>
							<div className="space-y-1.5">
								{effortOptions.map((opt) => (
									<label
										key={opt.value}
										className={`flex items-start gap-3 p-3 border cursor-pointer transition-colors ${
											claude.effort === opt.value
												? "border-primary/40 bg-primary/5"
												: "border-border hover:bg-accent"
										}`}
									>
										<input
											type="radio"
											name="effort"
											value={opt.value}
											checked={claude.effort === opt.value}
											onChange={() =>
												onChange({
													effort: opt.value as HlidConfig["claude"]["effort"],
												})
											}
											className="mt-0.5 accent-primary shrink-0"
										/>
										<div>
											<div className="text-sm text-foreground">{opt.label}</div>
											{opt.desc && (
												<div className="text-xs text-muted-foreground">
													{opt.desc}
												</div>
											)}
										</div>
									</label>
								))}
							</div>
						</fieldset>
					)}
					{permissionOptions.length > 0 && (
						<fieldset className="border-0 m-0 p-0 px-4 py-3">
							<div className="text-[9px] tracking-widest text-muted-foreground uppercase mb-2">
								PERMISSIONS
							</div>
							<div className="space-y-1.5">
								{permissionOptions.map((opt) => (
									<label
										key={opt.value}
										className={`flex items-start gap-3 p-3 border cursor-pointer transition-colors ${
											claude.permissionMode === opt.value
												? "border-primary/40 bg-primary/5"
												: "border-border hover:bg-accent"
										}`}
									>
										<input
											type="radio"
											name="permission"
											value={opt.value}
											checked={claude.permissionMode === opt.value}
											onChange={() =>
												onChange({
													permissionMode:
														opt.value as HlidConfig["claude"]["permission_mode"],
												})
											}
											className="mt-0.5 accent-primary shrink-0"
										/>
										<div>
											<div className="text-sm text-foreground">{opt.label}</div>
											{opt.desc && (
												<div className="text-xs text-muted-foreground">
													{opt.desc}
												</div>
											)}
										</div>
									</label>
								))}
							</div>
						</fieldset>
					)}
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
					<Field
						label="Turn recaps"
						hint="generate a brief summary after turns with tool use"
					>
						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={claude.turnRecaps}
								onChange={(e) => onChange({ turnRecaps: e.target.checked })}
								className="w-3.5 h-3.5 accent-primary"
							/>
							<span className="text-xs text-muted-foreground">enabled</span>
						</label>
					</Field>
					<Field label="Recap model" hint="model used for turn recap summaries">
						<select
							value={claude.recapModel}
							onChange={(e) => onChange({ recapModel: e.target.value })}
							className="w-32 sm:w-48 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50 transition-colors appearance-none cursor-pointer"
						>
							<option value="">— provider default —</option>
							{modelOptions.map((m) => (
								<option key={m.value} value={m.value}>
									{m.label}
								</option>
							))}
						</select>
					</Field>
					{isClaude && (
						<Field
							label="Interactive mode"
							hint="to not go against your &quot;programmatic&quot; usage, if you desire"
						>
							<label className="flex items-center gap-2 cursor-pointer">
								<input
									type="checkbox"
									checked={claude.interactiveMode}
									onChange={(e) =>
										onChange({ interactiveMode: e.target.checked })
									}
									className="w-3.5 h-3.5 accent-primary"
								/>
								<span className="text-xs text-muted-foreground">enabled</span>
							</label>
						</Field>
					)}
				</>
			)}
		</Section>
	);
}
