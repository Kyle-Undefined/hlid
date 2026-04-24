import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import type { HlidConfig } from "#/config";
import { FolderBrowser } from "./FolderBrowser";

type Entry = { name: string; isDirectory: boolean };

type Step = "welcome" | "vault" | "structure" | "done";

const PERMISSION_OPTIONS = [
	{
		value: "default" as const,
		label: "Ask for approval",
		desc: "Claude will ask before taking any action",
	},
	{
		value: "acceptEdits" as const,
		label: "Auto-approve edits",
		desc: "File edits auto-approved, other actions still ask",
	},
	{
		value: "bypassPermissions" as const,
		label: "Auto-approve all",
		desc: "All actions approved automatically. Fastest mode.",
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
					skills: ".claude/skills",
					memory: ".claude/projects",
				},
				server: { port: 3000, host: "0.0.0.0" },
				claude: {
					model: "claude-sonnet-4-6",
					permission_mode: permissionMode,
				},
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
		<div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4">
			<div className="w-full max-w-lg bg-card border border-border rounded-xl shadow-2xl overflow-hidden">
				{/* Progress */}
				<div className="flex border-b border-border">
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

				<div className="p-6">
					{step === "welcome" && (
						<div className="space-y-4">
							<div>
								<h2 className="text-lg font-semibold text-foreground">
									Welcome to Hlid
								</h2>
								<p className="text-sm text-muted-foreground mt-1">
									Your always-on vault command center. Takes about a minute to
									set up.
								</p>
							</div>
							<ul className="space-y-2 text-sm text-muted-foreground">
								{[
									"Pick your Obsidian vault folder",
									"Confirm the structure Hlid detected",
									"Choose how Claude handles permissions",
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
								Get started
							</button>
						</div>
					)}

					{step === "vault" && (
						<div className="space-y-4">
							<div>
								<h2 className="text-lg font-semibold text-foreground">
									Pick your vault
								</h2>
								<p className="text-sm text-muted-foreground mt-1">
									Navigate to your Obsidian vault folder and hit Select.
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
									Confirm your setup
								</h2>
								<p className="text-sm text-muted-foreground mt-1">
									Hlid scanned your vault and pre-filled what it found. Edit
									anything that looks off.
								</p>
							</div>

							<div className="space-y-3">
								<Field
									label="Vault name"
									value={vaultName}
									onChange={setVaultName}
								/>
								<Field
									label="Inbox folder"
									value={inbox}
									onChange={setInbox}
									placeholder="e.g. 00 Inbox"
								/>
								<Field
									label="Projects folder"
									value={projects}
									onChange={setProjects}
									placeholder="e.g. 10 Projects"
								/>
								<Field
									label="Areas folder"
									value={areas}
									onChange={setAreas}
									placeholder="e.g. 20 Areas"
								/>
							</div>

							<div className="space-y-2">
								<p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
									Claude permissions
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
									{saving ? "Saving…" : "Save and finish"}
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
									You're all set
								</h2>
								<p className="text-sm text-muted-foreground mt-1">
									Hlid is configured and ready to go.
								</p>
							</div>
							<button
								type="button"
								onClick={onComplete}
								className="w-full py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
							>
								Go to cockpit
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
