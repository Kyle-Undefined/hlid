import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { FolderBrowser } from "#/components/wizard/FolderBrowser";
import type { HlidConfig } from "#/config";
import { getConfig } from "#/config";
import { useWs } from "#/hooks/useWs";

export const Route = createFileRoute("/settings")({
	loader: () => getConfig(),
	component: SettingsPage,
});

const PERMISSION_OPTIONS: {
	value: HlidConfig["claude"]["permission_mode"];
	label: string;
	desc: string;
}[] = [
	{
		value: "default",
		label: "Ask for approval",
		desc: "Claude asks before taking any action",
	},
	{
		value: "acceptEdits",
		label: "Auto-approve edits",
		desc: "File edits auto-approved, other actions still ask",
	},
	{
		value: "bypassPermissions",
		label: "Auto-approve all",
		desc: "All actions approved automatically. Fastest mode.",
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
		<div className="space-y-3">
			<h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
				{title}
			</h2>
			<div className="rounded-lg border border-border bg-card divide-y divide-border">
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
		<div className="flex items-start justify-between gap-6 px-4 py-3">
			<div className="min-w-0">
				<div className="text-sm font-medium text-foreground">{label}</div>
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
			className={`w-48 bg-secondary border border-border rounded-md px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring ${mono ? "font-mono text-xs" : ""}`}
		/>
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
				className="w-48 bg-secondary border border-border rounded-md px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
			/>
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="text-xs px-2.5 py-1.5 rounded-md border border-border text-muted-foreground hover:bg-accent transition-colors shrink-0"
			>
				Browse
			</button>

			{open && (
				<div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4">
					<div className="w-full max-w-md bg-card border border-border rounded-xl shadow-2xl p-5 space-y-4">
						<div className="flex items-center justify-between">
							<h3 className="text-sm font-semibold text-foreground">
								Pick vault folder
							</h3>
							<button
								type="button"
								onClick={() => setOpen(false)}
								className="text-muted-foreground hover:text-foreground transition-colors text-xs"
							>
								Cancel
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
	const [model, setModel] = useState(initial.claude.model);
	const [permissionMode, setPermissionMode] = useState(
		initial.claude.permission_mode,
	);
	const [port, setPort] = useState(String(initial.server.port));
	const [host, setHost] = useState(initial.server.host);

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
				skills: initial.vault.skills,
				memory: initial.vault.memory,
			},
			server: {
				port: Number(port) || 3000,
				host: host || "0.0.0.0",
			},
			claude: {
				model,
				permission_mode: permissionMode,
			},
			status_vocabulary: initial.status_vocabulary,
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
		<div className="p-6 max-w-2xl mx-auto space-y-8 pb-24">
			<div>
				<h1 className="text-xl font-semibold text-foreground tracking-tight">
					Settings
				</h1>
				<p className="text-sm text-muted-foreground mt-0.5">
					Vault, Claude, and server config.
				</p>
			</div>

			<Section title="Vault">
				<Field label="Name">
					<TextInput value={vaultName} onChange={setVaultName} />
				</Field>
				<Field label="Path" hint="Absolute path to your Obsidian vault">
					<PathField value={vaultPath} onChange={setVaultPath} />
				</Field>
				<Field label="Inbox folder" hint="Relative folder name inside vault">
					<TextInput value={inbox} onChange={setInbox} placeholder="00 Inbox" />
				</Field>
				<Field label="Projects folder">
					<TextInput
						value={projects}
						onChange={setProjects}
						placeholder="10 Projects"
					/>
				</Field>
				<Field label="Areas folder">
					<TextInput value={areas} onChange={setAreas} placeholder="20 Areas" />
				</Field>
			</Section>

			<Section title="Claude">
				<Field label="Model">
					<TextInput
						value={model}
						onChange={setModel}
						placeholder="claude-sonnet-4-6"
						mono
					/>
				</Field>
				<div className="px-4 py-3 space-y-2">
					<div className="text-sm font-medium text-foreground">Permissions</div>
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
			</Section>

			<Section title="Server">
				<Field label="Port">
					<TextInput value={port} onChange={setPort} placeholder="3000" mono />
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

			<Section title="Session">
				<Field
					label="Reload session"
					hint="Reinitializes Claude with current config. Clears conversation history."
				>
					<button
						type="button"
						onClick={reloadSession}
						className="text-sm px-3 py-1.5 rounded-md border border-border text-muted-foreground hover:bg-accent transition-colors"
					>
						Reload
					</button>
				</Field>
			</Section>

			{/* sticky save bar */}
			<div className="fixed bottom-0 left-0 right-0 md:left-52 border-t border-border bg-background/95 backdrop-blur-sm px-6 py-3 flex items-center justify-between gap-4">
				<div className="text-sm">
					{error && <span className="text-destructive">{error}</span>}
					{saved && (
						<span className="text-green-400">
							Saved. Reload session to apply.
						</span>
					)}
				</div>
				<button
					type="button"
					onClick={save}
					disabled={saving}
					className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
				>
					{saving ? "Saving…" : "Save changes"}
				</button>
			</div>
		</div>
	);
}
