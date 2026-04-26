import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import type { HlidConfig } from "#/config";
import { FolderBrowser } from "./FolderBrowser";
import { RelativeFolderField } from "./RelativeFolderField";

type Entry = { name: string; isDirectory: boolean };

type Step = "welcome" | "vault" | "structure" | "done";

const PERMISSION_OPTIONS = [
	{
		value: "default" as const,
		label: "Ask for approval",
		desc: "Claude asks before doing anything",
	},
	{
		value: "acceptEdits" as const,
		label: "Auto-approve edits",
		desc: "edits go through automatically, everything else still asks",
	},
	{
		value: "bypassPermissions" as const,
		label: "Auto-approve all",
		desc: "everything goes through, no interruptions",
	},
];

function detect(
	entries: Entry[],
): Partial<Pick<HlidConfig["vault"], "inbox" | "projects" | "areas">> {
	const find = (patterns: string[]) =>
		entries.find((e) =>
			patterns.some((p) => e.name.toLowerCase().includes(p.toLowerCase())),
		)?.name;

	return {
		inbox: find(["inbox", "00"]),
		projects: find(["projects", "10 project"]),
		areas: find(["areas", "20 area"]),
	};
}

type Props = {
	onComplete: () => void;
};

export function FirstRunWizard({ onComplete }: Props) {
	const [step, setStep] = useState<Step>("welcome");
	const [vaultPath, setVaultPath] = useState("");
	const [vaultName, setVaultName] = useState("My Vault");
	const [inbox, setInbox] = useState("");
	const [projects, setProjects] = useState("");
	const [areas, setAreas] = useState("");
	const [skills, setSkills] = useState("");
	const [memory, setMemory] = useState("");
	const [permissionMode, setPermissionMode] = useState<
		"default" | "acceptEdits" | "bypassPermissions"
	>("default");
	const [saving, setSaving] = useState(false);

	// auto-detect structure when vault is picked
	useEffect(() => {
		if (!vaultPath) return;
		fetch(`/api/browse?path=${encodeURIComponent(vaultPath)}`)
			.then((r) => r.json())
			.then((data: { entries: Entry[]; path: string }) => {
				const detected = detect(data.entries);
				if (detected.inbox) setInbox(detected.inbox);
				if (detected.projects) setProjects(detected.projects);
				if (detected.areas) setAreas(detected.areas);
				// use last folder name as vault name
				const parts = data.path.split("/").filter(Boolean);
				if (parts.length > 0) setVaultName(parts[parts.length - 1]);
			})
			.catch(() => {});
	}, [vaultPath]);

	async function save() {
		setSaving(true);
		try {
			const config: HlidConfig = {
				vault: {
					name: vaultName,
					path: vaultPath,
					inbox: inbox || undefined,
					projects: projects || undefined,
					areas: areas || undefined,
					skills: skills || undefined,
					memory: memory || undefined,
				},
				server: { port: 3000, host: "0.0.0.0" },
				claude: {
					model: "claude-sonnet-4-6",
					effort: "high" as const,
					permission_mode: permissionMode,
				},
				ui: { enter_to_submit: true, hide_skills_index: true },
				status_vocabulary: {
					active: ["Active", "In Progress"],
					planning: ["Planning", "Ideas"],
					done: ["Done", "Complete", "Archived"],
				},
			};

			const res = await fetch("/api/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(config),
			});

			if (!res.ok) throw new Error("Save failed");
			setStep("done");
		} catch {
			setSaving(false);
		}
	}

	return (
		<div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex flex-col sm:items-center sm:justify-center">
			<div className="flex flex-col flex-1 sm:flex-none w-full sm:max-w-lg bg-card border-0 sm:border sm:border-border sm:rounded-xl sm:shadow-2xl overflow-hidden sm:m-4">
				{/* Progress */}
				<div className="flex border-b border-border shrink-0">
					{(["welcome", "vault", "structure", "done"] as Step[]).map((s, i) => (
						<div
							key={s}
							className={`flex-1 h-1 transition-colors ${
								["welcome", "vault", "structure", "done"].indexOf(step) >= i
									? "bg-primary"
									: "bg-border"
							}`}
						/>
					))}
				</div>

				<div className="flex-1 overflow-y-auto p-4 sm:p-6">
					{step === "welcome" && (
						<div className="space-y-4">
							<div>
								<h2 className="text-lg font-semibold text-foreground">
									The gate awaits
								</h2>
								<p className="text-sm text-muted-foreground mt-1">
									Hlið stands watch over your vault. One minute to open the
									gate.
								</p>
							</div>
							<ul className="space-y-2 text-sm text-muted-foreground">
								{[
									"Bind your Obsidian vault",
									"Review what Hlid has mapped",
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
								onClick={() => setStep("vault")}
								className="w-full py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
							>
								Open the gate
							</button>
						</div>
					)}

					{step === "vault" && (
						<div className="space-y-4">
							<div>
								<h2 className="text-lg font-semibold text-foreground">
									Find your hall
								</h2>
								<p className="text-sm text-muted-foreground mt-1">
									Navigate to your vault and press Select.
								</p>
							</div>
							<FolderBrowser
								onSelect={(path) => {
									setVaultPath(path);
									setStep("structure");
								}}
							/>
						</div>
					)}

					{step === "structure" && (
						<div className="space-y-4">
							<div>
								<h2 className="text-lg font-semibold text-foreground">
									Mark the bounds
								</h2>
								<p className="text-sm text-muted-foreground mt-1">
									Hlið has mapped your vault. Correct anything that looks off.
								</p>
							</div>

							<div className="space-y-3">
								<Field
									label="Vault name"
									value={vaultName}
									onChange={setVaultName}
								/>
								<FolderRow
									label="Inbox folder"
									value={inbox}
									onChange={setInbox}
									basePath={vaultPath}
									placeholder="e.g. 00 Inbox"
								/>
								<FolderRow
									label="Projects folder"
									value={projects}
									onChange={setProjects}
									basePath={vaultPath}
									placeholder="e.g. 10 Projects"
								/>
								<FolderRow
									label="Areas folder"
									value={areas}
									onChange={setAreas}
									basePath={vaultPath}
									placeholder="e.g. 20 Areas"
								/>
								<FolderRow
									label="Skills folder"
									value={skills}
									onChange={setSkills}
									basePath={vaultPath}
									placeholder="_munin/skills"
								/>
								<FolderRow
									label="Memory folder"
									value={memory}
									onChange={setMemory}
									basePath={vaultPath}
									placeholder="_munin/memory"
								/>
							</div>

							<div className="space-y-2">
								<p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
									Claude's authority
								</p>
								<div className="space-y-1.5">
									{PERMISSION_OPTIONS.map((opt) => (
										<label
											key={opt.value}
											className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
												permissionMode === opt.value
													? "border-primary bg-primary/5"
													: "border-border hover:bg-accent"
											}`}
										>
											<input
												type="radio"
												name="permission"
												value={opt.value}
												checked={permissionMode === opt.value}
												onChange={() => setPermissionMode(opt.value)}
												className="mt-0.5 accent-primary shrink-0"
											/>
											<div>
												<div className="text-sm font-medium text-foreground">
													{opt.label}
												</div>
												<div className="text-xs text-muted-foreground">
													{opt.desc}
												</div>
											</div>
										</label>
									))}
								</div>
							</div>

							<div className="flex gap-2">
								<button
									type="button"
									onClick={() => setStep("vault")}
									className="flex-1 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent transition-colors"
								>
									Back
								</button>
								<button
									type="button"
									onClick={save}
									disabled={saving}
									className="flex-1 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
								>
									{saving ? "Sealing…" : "Seal and enter"}
								</button>
							</div>
						</div>
					)}

					{step === "done" && (
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
					)}
				</div>
			</div>
		</div>
	);
}

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
