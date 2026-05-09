import type { HlidConfig } from "#/config";
import type { ProviderInfo } from "#/lib/serverFns";
import { Field, Section } from "./fields";

export type ClaudeForm = {
	model: string;
	effort: HlidConfig["claude"]["effort"];
	maxTurns: string;
	permissionMode: HlidConfig["claude"]["permission_mode"];
	turnRecaps: boolean;
	vaultProvider: string;
};

const EFFORT_OPTIONS: {
	value: HlidConfig["claude"]["effort"];
	label: string;
	desc: string;
}[] = [
	{ value: "low", label: "Low", desc: "minimal thinking, quick turnaround" },
	{ value: "medium", label: "Medium", desc: "some thinking, pretty balanced" },
	{
		value: "high",
		label: "High",
		desc: "solid reasoning, this is the default",
	},
	{ value: "xhigh", label: "X-High", desc: "goes deeper, Opus 4.7 only" },
	{
		value: "max",
		label: "Max",
		desc: "everything Claude has, Opus 4.7 only",
	},
];

const MODEL_OPTIONS = [
	{ value: "claude-opus-4-7", label: "Opus 4.7" },
	{ value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
	{ value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
] as const;

const PERMISSION_OPTIONS: {
	value: HlidConfig["claude"]["permission_mode"];
	label: string;
	desc: string;
}[] = [
	{
		value: "default",
		label: "Ask for approval",
		desc: "Claude asks before doing anything",
	},
	{
		value: "acceptEdits",
		label: "Auto-approve edits",
		desc: "edits go through automatically, everything else still asks",
	},
	{
		value: "bypassPermissions",
		label: "Auto-approve all",
		desc: "everything goes through, no interruptions",
	},
];

export function ClaudeSection({
	claude,
	onChange,
	providers,
}: {
	claude: ClaudeForm;
	onChange: (patch: Partial<ClaudeForm>) => void;
	providers: ProviderInfo[];
}) {
	const isClaudeProvider = claude.vaultProvider === "claude";

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
			{isClaudeProvider && (
				<>
					<Field label="Model">
						<select
							value={claude.model}
							onChange={(e) => onChange({ model: e.target.value })}
							className="w-32 sm:w-48 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50 transition-colors appearance-none cursor-pointer"
						>
							{MODEL_OPTIONS.map((m) => (
								<option key={m.value} value={m.value}>
									{m.label}
								</option>
							))}
						</select>
					</Field>
					<fieldset className="px-4 py-3 space-y-2 border-0 m-0 p-0 px-4 py-3">
						<legend className="text-[9px] tracking-widest text-muted-foreground uppercase mb-2">
							EFFORT
						</legend>
						<div className="space-y-1.5">
							{EFFORT_OPTIONS.map((opt) => (
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
										onChange={() => onChange({ effort: opt.value })}
										className="mt-0.5 accent-primary shrink-0"
									/>
									<div>
										<div className="text-sm text-foreground">{opt.label}</div>
										<div className="text-xs text-muted-foreground">
											{opt.desc}
										</div>
									</div>
								</label>
							))}
						</div>
					</fieldset>
					<fieldset className="border-0 m-0 p-0 px-4 py-3">
						<legend className="text-[9px] tracking-widest text-muted-foreground uppercase mb-2">
							PERMISSIONS
						</legend>
						<div className="space-y-1.5">
							{PERMISSION_OPTIONS.map((opt) => (
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
										onChange={() => onChange({ permissionMode: opt.value })}
										className="mt-0.5 accent-primary shrink-0"
									/>
									<div>
										<div className="text-sm text-foreground">{opt.label}</div>
										<div className="text-xs text-muted-foreground">
											{opt.desc}
										</div>
									</div>
								</label>
							))}
						</div>
					</fieldset>
					<Field
						label="Max turns"
						hint="max turns Claude can run, blank means no limit"
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
						hint="generate a brief Haiku summary after turns with tool use"
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
				</>
			)}
		</Section>
	);
}
