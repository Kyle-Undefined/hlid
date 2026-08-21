/**
 * Step components for FirstRunWizard. Each is a self-contained screen;
 * the wizard owns all shared state and passes slices as props.
 */

import { Check } from "lucide-react";
import { useState } from "react";
import { THEME_OPTIONS } from "#/lib/agentOptions";
import type { ProviderInfo } from "#/lib/providerTypes";
import type { SetupMode } from "./FirstRunWizard";
import { FolderBrowser } from "./FolderBrowser";
import { RelativeFolderField } from "./RelativeFolderField";

// ─── Shared option constants ──────────────────────────────────────────────────

const VAULT_STYLE_OPTIONS: {
	value: "para" | "wiki";
	label: string;
	desc: string;
}[] = [
	{
		value: "para",
		label: "PARA (Obsidian)",
		desc: "Projects · Areas · Resources · Archive, hierarchical GTD-style vault",
	},
	{
		value: "wiki",
		label: "LLM Wiki (Karpathy)",
		desc: "raw/ · wiki/ · outputs/, three-layer architecture, LLM owns wiki",
	},
];

// ─── Shared field helpers (wizard-style, rounded borders) ────────────────────

function Field({
	label,
	value,
	onChange,
	placeholder,
}: {
	label: string;
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
}) {
	return (
		<label className="block space-y-1">
			<span className="text-xs font-medium text-muted-foreground">{label}</span>
			<input
				type="text"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				className="w-full bg-input border border-border rounded-md px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
			/>
		</label>
	);
}

function FolderRow({
	label,
	value,
	onChange,
	basePath,
	placeholder,
}: {
	label: string;
	value: string;
	onChange: (v: string) => void;
	basePath: string;
	placeholder?: string;
}) {
	return (
		<div className="space-y-1">
			<span className="text-xs font-medium text-muted-foreground">{label}</span>
			<RelativeFolderField
				value={value}
				onChange={onChange}
				basePath={basePath}
				placeholder={placeholder}
				fullWidth
			/>
		</div>
	);
}

// ─── WelcomeStep ─────────────────────────────────────────────────────────────

export function WelcomeStep({
	onChoose,
}: {
	onChoose: (mode: SetupMode) => void;
}) {
	return (
		<div className="space-y-4">
			<div>
				<h2 className="text-lg font-semibold text-foreground">Set up Hlid</h2>
				<p className="text-sm text-muted-foreground mt-1">
					Choose the amount of setup you want today. You can change settings
					later.
				</p>
			</div>
			<div className="space-y-2">
				<button
					type="button"
					onClick={() => onChoose("guided")}
					className="w-full rounded-lg border border-primary bg-primary/5 p-4 text-left hover:bg-primary/10"
				>
					<div className="text-sm font-semibold text-foreground">
						Guided setup
					</div>
					<div className="mt-1 text-xs text-muted-foreground">
						A short, safe path with the essentials visible first.
					</div>
				</button>
				<button
					type="button"
					onClick={() => onChoose("custom")}
					className="w-full rounded-lg border border-border p-4 text-left hover:bg-accent"
				>
					<div className="text-sm font-semibold text-foreground">
						Custom setup
					</div>
					<div className="mt-1 text-xs text-muted-foreground">
						Choose your vault structure, provider settings, and full interface.
					</div>
				</button>
			</div>
		</div>
	);
}

export function WorkspaceChoiceStep({
	onStarter,
	onExisting,
	onBack,
}: {
	onStarter: () => void;
	onExisting: () => void;
	onBack: () => void;
}) {
	return (
		<div className="space-y-4">
			<div>
				<h2 className="text-lg font-semibold text-foreground">
					Choose your workspace
				</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					A starter workspace is new and separate. Hlid never changes an
					existing vault during setup.
				</p>
			</div>
			<button
				type="button"
				onClick={onStarter}
				className="w-full rounded-lg border border-primary bg-primary/5 p-4 text-left hover:bg-primary/10"
			>
				<div className="text-sm font-semibold text-foreground">
					Create a starter workspace
				</div>
				<div className="mt-1 text-xs text-muted-foreground">
					Creates a new “Hlid Starter” folder with empty PARA folders and one
					welcome note.
				</div>
			</button>
			<button
				type="button"
				onClick={onExisting}
				className="w-full rounded-lg border border-border p-4 text-left hover:bg-accent"
			>
				<div className="text-sm font-semibold text-foreground">
					Use an existing vault
				</div>
				<div className="mt-1 text-xs text-muted-foreground">
					Connect a folder you already own. Nothing inside it is created or
					replaced.
				</div>
			</button>
			<button
				type="button"
				onClick={onBack}
				className="w-full py-2 text-sm text-muted-foreground hover:text-foreground"
			>
				Back
			</button>
		</div>
	);
}

export function StarterWorkspaceStep({
	creating,
	onCreate,
	onBack,
}: {
	creating: boolean;
	onCreate: (parentPath: string) => void;
	onBack: () => void;
}) {
	return (
		<div className="space-y-4">
			<div>
				<h2 className="text-lg font-semibold text-foreground">
					Where should it go?
				</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					Select a folder in your home directory. Hlid will only create a new
					folder named “Hlid Starter” inside it; existing files are never
					overwritten.
				</p>
			</div>
			<FolderBrowser
				onSelect={onCreate}
				selectLabel={creating ? "Creating…" : "Create Hlid Starter"}
				disabled={creating}
			/>
			<button
				type="button"
				onClick={onBack}
				disabled={creating}
				className="w-full py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
			>
				Back
			</button>
		</div>
	);
}

// ─── VaultPickerStep ─────────────────────────────────────────────────────────

export function VaultPickerStep({
	onSelect,
	onBack,
}: {
	onSelect: (path: string) => void;
	onBack: () => void;
}) {
	return (
		<div className="space-y-4">
			<div>
				<h2 className="text-lg font-semibold text-foreground">
					Find your hall
				</h2>
				<p className="text-sm text-muted-foreground mt-1">
					Navigate to your vault and press Select.
				</p>
			</div>
			<FolderBrowser onSelect={onSelect} />
			<button
				type="button"
				onClick={onBack}
				className="w-full py-2 text-sm text-muted-foreground hover:text-foreground"
			>
				Back
			</button>
		</div>
	);
}

export function ConnectionStep({
	providers,
	saving,
	onBack,
	onContinue,
}: {
	providers: ProviderInfo[];
	saving: boolean;
	onBack: () => void;
	onContinue: () => void;
}) {
	const [choice, setChoice] = useState<"local" | "account" | "later">("later");
	const localAvailable = providers.filter(
		(provider) =>
			provider.available && provider.id !== "claude" && provider.id !== "codex",
	);
	const accountAvailable = providers.filter(
		(provider) =>
			provider.available &&
			(provider.id === "claude" || provider.id === "codex"),
	);
	const choices = [
		[
			"local",
			"Local",
			`Use a local provider you have already configured.${localAvailable.length ? ` Detected: ${localAvailable.map((provider) => provider.label).join(", ")}.` : " No local provider is being assumed."}`,
		],
		[
			"account",
			"Account",
			`Connect an account later in provider settings.${accountAvailable.length ? ` Available now: ${accountAvailable.map((provider) => provider.label).join(", ")}.` : " Availability will be checked when you configure it."}`,
		],
		["later", "Later", "Finish now and set up a provider when you are ready."],
	] as const;
	return (
		<div className="space-y-4">
			<div>
				<h2 className="text-lg font-semibold text-foreground">
					How would you like to connect?
				</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					This only saves your workspace choice. Hlid does not install software,
					sign in, or claim that a provider is ready.
				</p>
			</div>
			<div className="space-y-2 text-sm">
				{choices.map(([value, label, description]) => (
					<label
						key={value}
						className={`block cursor-pointer rounded-lg border p-3 ${choice === value ? "border-primary bg-primary/5" : "border-border hover:bg-accent"}`}
					>
						<input
							className="sr-only"
							type="radio"
							name="connection"
							value={value}
							checked={choice === value}
							onChange={() => setChoice(value)}
						/>
						<div className="font-medium text-foreground">{label}</div>
						<div className="mt-1 text-xs text-muted-foreground">
							{description}
						</div>
					</label>
				))}
			</div>
			<div className="flex gap-2">
				<button
					type="button"
					onClick={onBack}
					disabled={saving}
					className="flex-1 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent disabled:opacity-50"
				>
					Back
				</button>
				<button
					type="button"
					onClick={onContinue}
					disabled={saving}
					className="flex-1 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
				>
					{saving ? "Saving…" : "Finish setup"}
				</button>
			</div>
		</div>
	);
}

export function SafetyStep({
	value,
	saving,
	onChange,
	onBack,
	onContinue,
}: {
	value: StructureState["permissionMode"];
	saving: boolean;
	onChange: (value: StructureState["permissionMode"]) => void;
	onBack: () => void;
	onContinue: () => void;
}) {
	const choices = [
		{
			value: "default",
			label: "Ask before making changes",
			description:
				"Recommended. Hlid can read and explain, then asks before edits.",
		},
		{
			value: "acceptEdits",
			label: "Allow normal workspace edits",
			description:
				"Routine edits can proceed while sensitive actions still ask.",
		},
		{
			value: "bypassPermissions",
			label: "Allow all supported actions",
			description:
				"Advanced. Use only when you understand the provider's permissions.",
		},
	] as const;
	return (
		<div className="space-y-4">
			<div>
				<h2 className="text-lg font-semibold text-foreground">
					Choose your safety level
				</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					This keeps each provider's real permission behavior. You can change it
					later.
				</p>
			</div>
			<div className="space-y-2">
				{choices.map((choice) => (
					<label
						key={choice.value}
						className={`block cursor-pointer rounded-lg border p-3 ${value === choice.value ? "border-primary bg-primary/5" : "border-border hover:bg-accent"}`}
					>
						<input
							className="sr-only"
							type="radio"
							name="safety"
							value={choice.value}
							checked={value === choice.value}
							onChange={() => onChange(choice.value)}
						/>
						<div className="text-sm font-medium text-foreground">
							{choice.label}
						</div>
						<div className="mt-1 text-xs text-muted-foreground">
							{choice.description}
						</div>
					</label>
				))}
			</div>
			<div className="flex gap-2">
				<button
					type="button"
					onClick={onBack}
					disabled={saving}
					className="flex-1 rounded-lg border border-border py-2 text-sm text-muted-foreground hover:bg-accent disabled:opacity-50"
				>
					Back
				</button>
				<button
					type="button"
					onClick={onContinue}
					disabled={saving}
					className="flex-1 rounded-lg bg-primary py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
				>
					{saving ? "Saving…" : "Finish setup"}
				</button>
			</div>
		</div>
	);
}

// ─── StructureStep ───────────────────────────────────────────────────────────

export type StructureState = {
	vaultName: string;
	vaultPath: string;
	vaultStyle: "para" | "wiki";
	inbox: string;
	projects: string;
	areas: string;
	resources: string;
	archive: string;
	rawFolder: string;
	wikiFolder: string;
	outputs: string;
	skills: string;
	memory: string;
	vaultProvider: string;
	permissionMode: "default" | "acceptEdits" | "bypassPermissions";
	theme: "dark" | "tan";
};

/** Grid of radio-selectable cards (sr-only input, styled label) sharing one name group. */
function RadioCardGrid<T extends string>({
	name,
	label,
	value,
	options,
	onChange,
}: {
	name: string;
	label: string;
	value: T;
	options: readonly { value: T; label: string; desc: string }[];
	onChange: (v: T) => void;
}) {
	return (
		<div className="space-y-2">
			<p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
				{label}
			</p>
			<div className="grid grid-cols-2 gap-2">
				{options.map((opt) => (
					<label
						key={opt.value}
						className={`flex flex-col gap-1 p-3 rounded-lg border cursor-pointer transition-colors ${
							value === opt.value
								? "border-primary bg-primary/5"
								: "border-border hover:bg-accent"
						}`}
					>
						<input
							type="radio"
							name={name}
							value={opt.value}
							checked={value === opt.value}
							onChange={() => onChange(opt.value)}
							className="sr-only"
						/>
						<span className="text-sm font-medium text-foreground">
							{opt.label}
						</span>
						<span className="text-xs text-muted-foreground">{opt.desc}</span>
					</label>
				))}
			</div>
		</div>
	);
}

function VaultFoldersFields({
	state,
	onChange,
}: {
	state: StructureState;
	onChange: (patch: Partial<StructureState>) => void;
}) {
	return (
		<div className="space-y-3">
			<Field
				label="Vault name"
				value={state.vaultName}
				onChange={(v) => onChange({ vaultName: v })}
			/>
			{state.vaultStyle === "para" ? (
				<>
					<FolderRow
						label="Inbox folder"
						value={state.inbox}
						onChange={(v) => onChange({ inbox: v })}
						basePath={state.vaultPath}
						placeholder="e.g. 00 Inbox"
					/>
					<FolderRow
						label="Projects folder"
						value={state.projects}
						onChange={(v) => onChange({ projects: v })}
						basePath={state.vaultPath}
						placeholder="e.g. 10 Projects"
					/>
					<FolderRow
						label="Areas folder"
						value={state.areas}
						onChange={(v) => onChange({ areas: v })}
						basePath={state.vaultPath}
						placeholder="e.g. 20 Areas"
					/>
					<FolderRow
						label="Resources folder"
						value={state.resources}
						onChange={(v) => onChange({ resources: v })}
						basePath={state.vaultPath}
						placeholder="e.g. 30 Resources"
					/>
					<FolderRow
						label="Archive folder"
						value={state.archive}
						onChange={(v) => onChange({ archive: v })}
						basePath={state.vaultPath}
						placeholder="e.g. 40 Archive"
					/>
				</>
			) : (
				<>
					<FolderRow
						label="Raw folder"
						value={state.rawFolder}
						onChange={(v) => onChange({ rawFolder: v })}
						basePath={state.vaultPath}
						placeholder="raw"
					/>
					<FolderRow
						label="Wiki folder"
						value={state.wikiFolder}
						onChange={(v) => onChange({ wikiFolder: v })}
						basePath={state.vaultPath}
						placeholder="wiki"
					/>
					<FolderRow
						label="Outputs folder"
						value={state.outputs}
						onChange={(v) => onChange({ outputs: v })}
						basePath={state.vaultPath}
						placeholder="outputs"
					/>
				</>
			)}
			<FolderRow
				label="Skills folder"
				value={state.skills}
				onChange={(v) => onChange({ skills: v })}
				basePath={state.vaultPath}
				placeholder="_munin/skills"
			/>
			<FolderRow
				label="Memory folder"
				value={state.memory}
				onChange={(v) => onChange({ memory: v })}
				basePath={state.vaultPath}
				placeholder="_munin/memory"
			/>
		</div>
	);
}

function PermissionModePicker({
	value,
	onChange,
	options,
	providerLabel,
}: {
	value: StructureState["permissionMode"];
	onChange: (v: StructureState["permissionMode"]) => void;
	options: ReadonlyArray<{ value: string; label: string; desc?: string }>;
	providerLabel: string;
}) {
	if (options.length === 0) return null;
	return (
		<div className="space-y-2">
			<p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
				{providerLabel}'s authority
			</p>
			<div className="space-y-1.5">
				{options.map((opt) => (
					<label
						key={opt.value}
						className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
							value === opt.value
								? "border-primary bg-primary/5"
								: "border-border hover:bg-accent"
						}`}
					>
						<input
							type="radio"
							name="permission"
							value={opt.value}
							checked={value === opt.value}
							onChange={() =>
								onChange(opt.value as StructureState["permissionMode"])
							}
							className="mt-0.5 accent-primary shrink-0"
						/>
						<div>
							<div className="text-sm font-medium text-foreground">
								{opt.label}
							</div>
							{opt.desc && (
								<div className="text-xs text-muted-foreground">{opt.desc}</div>
							)}
						</div>
					</label>
				))}
			</div>
		</div>
	);
}

export function StructureStep({
	state,
	saving,
	onChange,
	onBack,
	onSave,
	providerOptions = [],
	providerLabel = "Agent",
	permissionOptions = [],
}: {
	state: StructureState;
	saving: boolean;
	onChange: (patch: Partial<StructureState>) => void;
	onBack: () => void;
	onSave: () => void;
	providerOptions?: ReadonlyArray<{
		value: string;
		label: string;
		desc: string;
	}>;
	providerLabel?: string;
	/** Permission modes declared by the active provider. Falls back to empty (no radio group shown). */
	permissionOptions?: ReadonlyArray<{
		value: string;
		label: string;
		desc?: string;
	}>;
}) {
	return (
		<div className="space-y-4">
			<div>
				<h2 className="text-lg font-semibold text-foreground">
					Mark the bounds
				</h2>
				<p className="text-sm text-muted-foreground mt-1">
					Hlið has mapped your vault. Correct anything that looks off.
				</p>
			</div>

			<RadioCardGrid
				name="vaultStyle"
				label="Vault style"
				value={state.vaultStyle}
				options={VAULT_STYLE_OPTIONS}
				onChange={(vaultStyle) => onChange({ vaultStyle })}
			/>

			<VaultFoldersFields state={state} onChange={onChange} />

			{providerOptions.length > 0 && (
				<RadioCardGrid
					name="vaultProvider"
					label="Vault agent"
					value={state.vaultProvider}
					options={providerOptions}
					onChange={(vaultProvider) =>
						onChange({ vaultProvider, permissionMode: "default" })
					}
				/>
			)}

			<PermissionModePicker
				value={state.permissionMode}
				onChange={(permissionMode) => onChange({ permissionMode })}
				options={permissionOptions}
				providerLabel={providerLabel}
			/>

			<RadioCardGrid
				name="theme"
				label="Theme"
				value={state.theme}
				options={WIZARD_THEME_OPTIONS}
				onChange={(theme) => onChange({ theme })}
			/>

			<div className="flex gap-2">
				<button
					type="button"
					onClick={onBack}
					className="flex-1 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent transition-colors"
				>
					Back
				</button>
				<button
					type="button"
					onClick={onSave}
					disabled={saving}
					className="flex-1 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
				>
					{saving ? "Sealing…" : "Seal and enter"}
				</button>
			</div>
		</div>
	);
}

// ─── DoneStep ────────────────────────────────────────────────────────────────

export function DoneStep({
	onComplete,
	onTestChat,
}: {
	onComplete: () => void;
	onTestChat?: () => void;
}) {
	return (
		<div className="space-y-4 text-center">
			<div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
				<Check className="w-6 h-6 text-primary" />
			</div>
			<div>
				<h2 className="text-lg font-semibold text-foreground">
					The gate is open
				</h2>
				<p className="text-sm text-muted-foreground mt-1">
					Hlið is ready. Your hall awaits.
				</p>
			</div>
			{onTestChat && (
				<button
					type="button"
					onClick={onTestChat}
					className="w-full rounded-lg bg-primary py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
				>
					Try a test chat
				</button>
			)}
			<button
				type="button"
				onClick={onComplete}
				className="w-full rounded-lg border border-border py-2 text-sm font-medium text-foreground hover:bg-accent"
			>
				Go to Home
			</button>
		</div>
	);
}
const WIZARD_THEME_OPTIONS = THEME_OPTIONS.filter(
	(option) => option.value !== "custom",
) as ReadonlyArray<{
	value: "dark" | "tan";
	label: string;
	desc: string;
}>;
