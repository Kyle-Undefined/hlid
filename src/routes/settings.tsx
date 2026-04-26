import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { FolderBrowser } from "#/components/wizard/FolderBrowser";
import { RelativeFolderField } from "#/components/wizard/RelativeFolderField";
import type { HlidConfig } from "#/config";
import { getConfig } from "#/config";
import { useWs } from "#/hooks/useWs";

export const Route = createFileRoute("/settings")({
	loader: () => getConfig(),
	component: SettingsPage,
});

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
		desc: "everything Claude has, Opus 4.6/4.7 only",
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

function Section({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<div className="space-y-2">
			<div className="text-[9px] tracking-widest text-muted-foreground uppercase px-1">
				{title}
			</div>
			<div className="border border-border bg-card divide-y divide-border">
				{children}
			</div>
		</div>
	);
}

function Field({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex items-center justify-between gap-6 px-4 py-3">
			<div className="min-w-0">
				<div className="text-sm text-foreground">{label}</div>
				{hint && (
					<div className="text-xs text-muted-foreground mt-0.5">{hint}</div>
				)}
			</div>
			<div className="shrink-0">{children}</div>
		</div>
	);
}

function TextInput({
	value,
	onChange,
	placeholder,
	mono,
}: {
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	mono?: boolean;
}) {
	return (
		<input
			type="text"
			value={value}
			onChange={(e) => onChange(e.target.value)}
			placeholder={placeholder}
			className={`w-32 sm:w-48 bg-secondary border border-border px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors ${mono ? "font-mono text-xs" : ""}`}
		/>
	);
}

function VocabRow({
	label,
	value,
	onChange,
}: {
	label: string;
	value: string;
	onChange: (v: string) => void;
}) {
	return (
		<div className="px-4 py-3 space-y-1.5">
			<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
				{label}
			</div>
			<input
				type="text"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="w-full bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors"
				placeholder="comma separated values"
			/>
		</div>
	);
}

function PathField({
	value,
	onChange,
}: {
	value: string;
	onChange: (v: string) => void;
}) {
	const [open, setOpen] = useState(false);

	return (
		<div className="flex items-center gap-2">
			<input
				type="text"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder="~/vault"
				className="w-32 sm:w-48 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors"
			/>
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="text-[10px] tracking-widest px-2 py-1.5 border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors shrink-0 uppercase"
			>
				BROWSE
			</button>

			{open && (
				<div className="fixed inset-0 z-50 bg-background/90 backdrop-blur-sm flex items-center justify-center p-4">
					<div className="w-full max-w-md bg-card border border-border shadow-2xl p-5 space-y-4">
						<div className="flex items-center justify-between">
							<div className="text-[10px] tracking-widest text-muted-foreground uppercase">
								PICK VAULT FOLDER
							</div>
							<button
								type="button"
								onClick={() => setOpen(false)}
								className="text-[10px] tracking-widest text-muted-foreground hover:text-foreground transition-colors uppercase"
							>
								CANCEL
							</button>
						</div>
						<FolderBrowser
							initialPath={value || undefined}
							onSelect={(path) => {
								onChange(path);
								setOpen(false);
							}}
						/>
					</div>
				</div>
			)}
		</div>
	);
}

function SettingsPage() {
	const initial = Route.useLoaderData();
	const { send } = useWs();

	const [vaultName, setVaultName] = useState(initial.vault.name);
	const [vaultPath, setVaultPath] = useState(initial.vault.path);
	const [inbox, setInbox] = useState(initial.vault.inbox ?? "");
	const [projects, setProjects] = useState(initial.vault.projects ?? "");
	const [areas, setAreas] = useState(initial.vault.areas ?? "");
	const [skills, setSkills] = useState(initial.vault.skills ?? "");
	const [memory, setMemory] = useState(initial.vault.memory ?? "");
	const [model, setModel] = useState(initial.claude.model);
	const [effort, setEffort] = useState(initial.claude.effort);
	const [maxTurns, setMaxTurns] = useState(
		initial.claude.max_turns !== undefined
			? String(initial.claude.max_turns)
			: "",
	);
	const [permissionMode, setPermissionMode] = useState(
		initial.claude.permission_mode,
	);
	const [port, setPort] = useState(String(initial.server.port));
	const [host, setHost] = useState(initial.server.host);
	const [enterToSubmit, setEnterToSubmit] = useState(
		initial.ui.enter_to_submit,
	);
	const [hideSkillsIndex, setHideSkillsIndex] = useState(
		initial.ui.hide_skills_index,
	);
	const [vocabActive, setVocabActive] = useState(
		initial.status_vocabulary.active.join(", "),
	);
	const [vocabPlanning, setVocabPlanning] = useState(
		initial.status_vocabulary.planning.join(", "),
	);
	const [vocabDone, setVocabDone] = useState(
		initial.status_vocabulary.done.join(", "),
	);

	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function save() {
		setSaving(true);
		setError(null);
		setSaved(false);

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
			server: {
				port: Number(port) || 3000,
				host: host || "0.0.0.0",
			},
			claude: {
				model,
				effort,
				max_turns: maxTurns !== "" ? Number(maxTurns) : undefined,
				permission_mode: permissionMode,
			},
			ui: {
				enter_to_submit: enterToSubmit,
				hide_skills_index: hideSkillsIndex,
			},
			status_vocabulary: {
				active: vocabActive
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean),
				planning: vocabPlanning
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean),
				done: vocabDone
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean),
			},
		};

		try {
			const res = await fetch("/api/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(config),
			});
			if (!res.ok) {
				let msg = "Save failed";
				try {
					const body = (await res.json()) as { error?: string };
					if (body.error) msg = body.error;
				} catch {}
				throw new Error(msg);
			}
			setSaved(true);
			setTimeout(() => setSaved(false), 3000);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Save failed");
		} finally {
			setSaving(false);
		}
	}

	function reloadSession() {
		send({ type: "reload_session" });
	}

	return (
		<div className="flex flex-col h-full">
			<div className="flex-1 overflow-auto p-5 space-y-6">
				<Section title="Vault">
					<Field label="Name">
						<TextInput value={vaultName} onChange={setVaultName} />
					</Field>
					<Field label="Path">
						<PathField value={vaultPath} onChange={setVaultPath} />
					</Field>
					<Field label="Inbox folder">
						<RelativeFolderField
							value={inbox}
							onChange={setInbox}
							basePath={vaultPath}
							placeholder="00 Inbox"
						/>
					</Field>
					<Field label="Projects folder">
						<RelativeFolderField
							value={projects}
							onChange={setProjects}
							basePath={vaultPath}
							placeholder="10 Projects"
						/>
					</Field>
					<Field label="Areas folder">
						<RelativeFolderField
							value={areas}
							onChange={setAreas}
							basePath={vaultPath}
							placeholder="20 Areas"
						/>
					</Field>
					<Field
						label="Skills folder"
						hint="vault skills (relative to vault path)"
					>
						<RelativeFolderField
							value={skills}
							onChange={setSkills}
							basePath={vaultPath}
							placeholder=".claude/skills"
						/>
					</Field>
					<Field
						label="Memory folder"
						hint="vault memory files (relative to vault path)"
					>
						<RelativeFolderField
							value={memory}
							onChange={setMemory}
							basePath={vaultPath}
							placeholder=".claude/projects"
						/>
					</Field>
				</Section>

				<Section title="Claude">
					<Field label="Model">
						<select
							value={model}
							onChange={(e) => setModel(e.target.value)}
							className="w-32 sm:w-48 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50 transition-colors appearance-none cursor-pointer"
						>
							{MODEL_OPTIONS.map((m) => (
								<option key={m.value} value={m.value}>
									{m.label}
								</option>
							))}
						</select>
					</Field>
					<div className="px-4 py-3 space-y-2">
						<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
							EFFORT
						</div>
						<div className="space-y-1.5">
							{EFFORT_OPTIONS.map((opt) => (
								<label
									key={opt.value}
									className={`flex items-start gap-3 p-3 border cursor-pointer transition-colors ${
										effort === opt.value
											? "border-primary/40 bg-primary/5"
											: "border-border hover:bg-accent"
									}`}
								>
									<input
										type="radio"
										name="effort"
										value={opt.value}
										checked={effort === opt.value}
										onChange={() => setEffort(opt.value)}
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
					</div>
					<div className="px-4 py-3 space-y-2">
						<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
							PERMISSIONS
						</div>
						<div className="space-y-1.5">
							{PERMISSION_OPTIONS.map((opt) => (
								<label
									key={opt.value}
									className={`flex items-start gap-3 p-3 border cursor-pointer transition-colors ${
										permissionMode === opt.value
											? "border-primary/40 bg-primary/5"
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
										<div className="text-sm text-foreground">{opt.label}</div>
										<div className="text-xs text-muted-foreground">
											{opt.desc}
										</div>
									</div>
								</label>
							))}
						</div>
					</div>
					<Field
						label="Max turns"
						hint="max turns Claude can run, blank means no limit"
					>
						<input
							type="number"
							min={1}
							value={maxTurns}
							onChange={(e) => setMaxTurns(e.target.value)}
							placeholder="unlimited"
							className="w-32 sm:w-48 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors"
						/>
					</Field>
				</Section>

				<Section title="Server">
					<Field label="Port">
						<TextInput
							value={port}
							onChange={setPort}
							placeholder="3000"
							mono
						/>
					</Field>
					<Field label="Host">
						<TextInput
							value={host}
							onChange={setHost}
							placeholder="0.0.0.0"
							mono
						/>
					</Field>
				</Section>

				<Section title="Status Vocabulary">
					<VocabRow
						label="Active"
						value={vocabActive}
						onChange={setVocabActive}
					/>
					<VocabRow
						label="Planning"
						value={vocabPlanning}
						onChange={setVocabPlanning}
					/>
					<VocabRow label="Done" value={vocabDone} onChange={setVocabDone} />
				</Section>

				<Section title="UI">
					<Field
						label="Enter to submit"
						hint="desktop only, mobile always uses Enter for newline"
					>
						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={enterToSubmit}
								onChange={(e) => setEnterToSubmit(e.target.checked)}
								className="accent-primary w-3.5 h-3.5"
							/>
							<span className="text-xs text-muted-foreground">
								{enterToSubmit ? "on" : "off"}
							</span>
						</label>
					</Field>
					<Field label="Hide skills index.md">
						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={hideSkillsIndex}
								onChange={(e) => setHideSkillsIndex(e.target.checked)}
								className="accent-primary w-3.5 h-3.5"
							/>
							<span className="text-xs text-muted-foreground">
								{hideSkillsIndex ? "on" : "off"}
							</span>
						</label>
					</Field>
				</Section>

				<Section title="Session">
					<Field
						label="Reload session"
						hint="restarts Claude with the current config and wipes conversation history"
					>
						<button
							type="button"
							onClick={reloadSession}
							className="text-[10px] tracking-widest px-3 py-1.5 border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors uppercase"
						>
							RELOAD
						</button>
					</Field>
				</Section>
			</div>

			{/* Save bar */}
			<div className="shrink-0 border-t border-border bg-background/95 px-5 py-3 flex items-center justify-between gap-4">
				<div className="text-xs tracking-wider">
					{error && <span className="text-destructive">{error}</span>}
					{saved && (
						<span className="text-green-500">
							saved, reload session to apply changes
						</span>
					)}
				</div>
				<button
					type="button"
					onClick={save}
					disabled={saving}
					className="px-4 py-2 bg-primary text-primary-foreground text-[10px] tracking-widest font-bold hover:opacity-90 transition-opacity disabled:opacity-50 uppercase"
				>
					{saving ? "SAVING…" : "SAVE CHANGES"}
				</button>
			</div>
		</div>
	);
}
