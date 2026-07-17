/**
 * Step components for FirstRunWizard. Each is a self-contained screen;
 * the wizard owns all shared state and passes slices as props.
 */
import { Check } from "lucide-react";
import { THEME_OPTIONS } from "#/lib/agentOptions";
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

const PRIMER_ITEMS: { name: string; meaning: string }[] = [
	{
		name: "Watch",
		meaning:
			"your cockpit. Inbox count, what's running, what owes you attention.",
	},
	{
		name: "Vault",
		meaning: "projects, skills, memory. The shape of your hall.",
	},
	{
		name: "Relics",
		meaning: "attachments. PDFs, images, files Claude has touched.",
	},
	{
		name: "Raven",
		meaning: "chat. Huginn and Muninn carry your messages to Claude and back.",
	},
	{
		name: "Einherjar",
		meaning: "agents. Óðinn's chosen warriors, summoned for specific tasks.",
	},
	{
		name: "Ledger",
		meaning: "sessions, tokens, cost. What you've spent, what you've used.",
	},
	{
		name: "Forge",
		meaning: "settings. Where you reshape the thing.",
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
				className="w-full bg-secondary border border-border rounded-md px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
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

export function WelcomeStep({ onNext }: { onNext: () => void }) {
	return (
		<div className="space-y-4">
			<div>
				<h2 className="text-lg font-semibold text-foreground">
					The gate awaits
				</h2>
				<p className="text-sm text-muted-foreground mt-1">
					Hlið stands watch over your vault. One minute to open the gate.
				</p>
			</div>
			<ul className="space-y-2 text-sm text-muted-foreground">
				{[
					"Bind your Obsidian vault",
					"Review what Hlið has mapped",
					"Set the bounds of Claude's reach",
				].map((item) => (
					<li key={item} className="flex items-center gap-2">
						<Check className="w-3.5 h-3.5 text-primary shrink-0" />
						{item}
					</li>
				))}
			</ul>
			<button
				type="button"
				onClick={onNext}
				className="w-full py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
			>
				Open the gate
			</button>
		</div>
	);
}

// ─── VaultPickerStep ─────────────────────────────────────────────────────────

export function VaultPickerStep({
	onSelect,
}: {
	onSelect: (path: string) => void;
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
}: {
	value: StructureState["permissionMode"];
	onChange: (v: StructureState["permissionMode"]) => void;
	options: ReadonlyArray<{ value: string; label: string; desc?: string }>;
}) {
	if (options.length === 0) return null;
	return (
		<div className="space-y-2">
			<p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
				Claude's authority
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
	permissionOptions = [],
}: {
	state: StructureState;
	saving: boolean;
	onChange: (patch: Partial<StructureState>) => void;
	onBack: () => void;
	onSave: () => void;
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

			<PermissionModePicker
				value={state.permissionMode}
				onChange={(permissionMode) => onChange({ permissionMode })}
				options={permissionOptions}
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

// ─── PrimerStep ───────────────────────────────────────────────────────────────

export function PrimerStep({ onNext }: { onNext: () => void }) {
	return (
		<div className="space-y-4">
			<div>
				<h2 className="text-lg font-semibold text-foreground">
					The lay of the land
				</h2>
				<p className="text-sm text-muted-foreground mt-1">
					The menu speaks Norse. Half the fun of a project is a name that{" "}
					<em>hits</em>. The other half is telling you what it actually does.
				</p>
			</div>
			<div className="rounded-lg border border-border bg-secondary/30 p-3 space-y-1.5">
				<div className="text-xs">
					<span className="font-semibold text-foreground">
						Hlið / Hliðskjálf
					</span>
					<span className="text-muted-foreground">
						{" "}
						— the app itself. Óðinn's high seat, where he watched all nine
						realms.
					</span>
				</div>
			</div>
			<ul className="space-y-2">
				{PRIMER_ITEMS.map((item) => (
					<li key={item.name} className="text-xs leading-relaxed flex gap-2">
						<span className="font-semibold text-foreground tracking-widest uppercase shrink-0 w-20">
							{item.name}
						</span>
						<span className="text-muted-foreground">{item.meaning}</span>
					</li>
				))}
			</ul>
			<p className="text-xs text-muted-foreground/70 italic">
				You'll get the hang of it. The icons help.
			</p>
			<button
				type="button"
				onClick={onNext}
				className="w-full py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
			>
				Got it
			</button>
		</div>
	);
}

// ─── DoneStep ────────────────────────────────────────────────────────────────

export function DoneStep({ onComplete }: { onComplete: () => void }) {
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
			<button
				type="button"
				onClick={onComplete}
				className="w-full py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
			>
				Take the Watch
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
