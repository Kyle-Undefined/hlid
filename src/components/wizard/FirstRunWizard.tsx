import { useEffect, useState } from "react";
import type { HlidConfig } from "#/config";
import {
	DEFAULT_ATTACHMENTS_CONFIG,
	DEFAULT_AUTO_SLEEP_CONFIG,
	DEFAULT_VOICE_CONFIG,
} from "#/config";
import { DEFAULT_NAVIGATION_NAMES_CONFIG } from "#/lib/navigationNames";
import type { ProviderInfo } from "#/lib/providerTypes";
import { getProvidersFn } from "#/lib/serverFns/providers";
import { buildVaultSection } from "#/lib/vaultConfig";
import type { StructureState } from "./WizardSteps";
import {
	ConnectionStep,
	DoneStep,
	SafetyStep,
	StarterWorkspaceStep,
	StructureStep,
	VaultPickerStep,
	WelcomeStep,
	WorkspaceChoiceStep,
} from "./WizardSteps";

type Entry = { name: string; isDirectory: boolean };

export type SetupMode = "guided" | "custom";

type Step =
	| "welcome"
	| "workspace"
	| "starter"
	| "vault"
	| "structure"
	| "connection"
	| "safety"
	| "done";

const STEPS: Step[] = [
	"welcome",
	"workspace",
	"starter",
	"vault",
	"structure",
	"connection",
	"safety",
	"done",
];

export function detectVaultStructure(
	entries: Entry[],
): Partial<StructureState> {
	const find = (patterns: string[]) =>
		entries.find(
			(e) =>
				e.isDirectory &&
				patterns.some((p) => e.name.toLowerCase().includes(p.toLowerCase())),
		)?.name;

	const wikiFolder = find(["wiki"]);
	const rawFolder = find(["raw"]);
	const projectsFolder = find(["projects", "10 project", "1 project"]);
	const areasFolder = find(["areas", "20 area", "2 area"]);
	const isWiki = !!(wikiFolder || rawFolder) && !projectsFolder && !areasFolder;

	return {
		vaultStyle: isWiki ? "wiki" : "para",
		inbox: isWiki ? undefined : find(["inbox", "00"]),
		projects: isWiki ? undefined : projectsFolder,
		areas: isWiki ? undefined : areasFolder,
		resources: isWiki
			? undefined
			: find(["resources", "30 resource", "3 resource"]),
		archive: isWiki ? undefined : find(["archive", "40 archive", "4 archive"]),
		rawFolder: isWiki ? rawFolder : undefined,
		wikiFolder: isWiki ? wikiFolder : undefined,
		outputs: find(["outputs", "output"]),
	};
}

export function buildFirstRunConfig(
	s: StructureState,
	setupMode: SetupMode = "custom",
): HlidConfig {
	const selectedPermissionMode = s.permissionMode;
	return {
		vault: buildVaultSection({
			name: s.vaultName,
			path: s.vaultPath,
			style: s.vaultStyle,
			inbox: s.inbox,
			projects: s.projects,
			areas: s.areas,
			resources: s.resources,
			archive: s.archive,
			raw: s.rawFolder,
			wikiFolder: s.wikiFolder,
			outputs: s.outputs,
			skills: s.skills,
			memory: s.memory,
		}),
		server: {
			port: 3000,
			tls_proxy_port: 3443,
			local_network_access: false,
			allow_external_agents: false,
		},
		diagnostics: { event_log: true },
		claude: {
			model: "claude-sonnet-4-6",
			effort: "high",
			permission_mode:
				s.vaultProvider === "claude" ? selectedPermissionMode : "default",
			turn_recaps: true,
			agent_progress_summaries: false,
			interactive_mode: false,
			peer_inbox: false,
		},
		cliproxy: {
			enabled: false,
			mode: "external",
			base_url: "http://127.0.0.1:8317",
			api_key: "",
			model: "gpt-5.6-sol",
			effort: "xhigh",
			permission_mode: "default",
			turn_recaps: true,
		},
		codex: {
			model: "",
			effort: "medium",
			permission_mode:
				s.vaultProvider === "codex" ? selectedPermissionMode : "default",
			turn_recaps: true,
			windows_computer_use: { model: "inherit", effort: "medium" },
		},
		project_preview: { use_real_browser_profile: false },
		ui: {
			view_mode: setupMode === "guided" ? "simple" : "full",
			enter_to_submit: true,
			live_sessions_hotkey: "Alt+Shift+KeyS",
			hide_skills_index: true,
			show_provider_entries: false,
			theme: s.theme,
			html_plans: false,
			navigation_names: {
				preset: DEFAULT_NAVIGATION_NAMES_CONFIG.preset,
				labels: { ...DEFAULT_NAVIGATION_NAMES_CONFIG.labels },
			},
		},
		status_vocabulary: {
			active: ["Active", "In Progress"],
			planning: ["Planning", "Ideas"],
			done: ["Done", "Complete", "Archived"],
		},
		attachments: DEFAULT_ATTACHMENTS_CONFIG,
		voice: DEFAULT_VOICE_CONFIG,
		umbod: { enabled: false, manifest_path: "umbod.toml" },
		auto_sleep: DEFAULT_AUTO_SLEEP_CONFIG,
		agents: [],
		vault_provider: s.vaultProvider,
	};
}

export function vaultNameFromPath(path: string): string | null {
	const parts = path.split(/[\\/]/).filter(Boolean);
	return parts.at(-1) ?? null;
}

type Props = {
	onComplete: () => void;
	onTestChat?: () => void;
};

export function FirstRunWizard({ onComplete, onTestChat }: Props) {
	const [step, setStep] = useState<Step>("welcome");
	const [setupMode, setSetupMode] = useState<SetupMode>("guided");
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [providers, setProviders] = useState<ProviderInfo[]>([]);
	const [structure, setStructure] = useState<StructureState>({
		vaultName: "My Vault",
		vaultPath: "",
		vaultStyle: "para",
		inbox: "",
		projects: "",
		areas: "",
		resources: "",
		archive: "",
		rawFolder: "",
		wikiFolder: "",
		outputs: "",
		skills: "",
		memory: "",
		vaultProvider: "claude",
		permissionMode: "default",
		theme: "tan",
	});

	// Fetch providers once on mount so StructureStep can show dynamic permission options.
	useEffect(() => {
		getProvidersFn()
			.then((inventory) => {
				setProviders(inventory);
				setStructure((current) => {
					const supported = inventory.filter(
						(provider) =>
							(provider.id === "claude" || provider.id === "codex") &&
							provider.available,
					);
					if (
						supported.some((provider) => provider.id === current.vaultProvider)
					)
						return current;
					const fallback = supported[0];
					return fallback
						? {
								...current,
								vaultProvider: fallback.id,
								permissionMode: "default",
							}
						: current;
				});
			})
			.catch(() => {});
	}, []);

	// Auto-detect structure when vault is picked.
	useEffect(() => {
		if (!structure.vaultPath) return;
		fetch(`/api/browse?path=${encodeURIComponent(structure.vaultPath)}`)
			.then((r) => r.json())
			.then((data: { entries: Entry[]; path: string }) => {
				const detected = detectVaultStructure(data.entries);
				setStructure((s) => ({
					...s,
					...detected,
					vaultName: vaultNameFromPath(data.path) ?? s.vaultName,
				}));
			})
			.catch(() => {});
	}, [structure.vaultPath]);

	function selectVault(path: string) {
		setStructure((s) => ({ ...s, vaultPath: path }));
		setStep(setupMode === "custom" ? "structure" : "connection");
	}

	async function createStarterWorkspace(parentPath: string) {
		setSaving(true);
		setSaveError(null);
		try {
			const res = await fetch("/api/starter-workspace", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ parent_path: parentPath }),
			});
			const body = (await res.json().catch(() => null)) as {
				path?: string;
				error?: string;
			} | null;
			if (!res.ok || !body?.path) {
				throw new Error(
					body?.error || `Could not create starter workspace (${res.status})`,
				);
			}
			const workspacePath = body.path;
			setStructure((s) => ({
				...s,
				vaultName: vaultNameFromPath(workspacePath) ?? s.vaultName,
				vaultPath: workspacePath,
				vaultStyle: "para",
				inbox: "00 Inbox",
				projects: "10 Projects",
				areas: "20 Areas",
				resources: "30 Resources",
				archive: "40 Archive",
				skills: "_munin/skills",
				memory: "_munin/memory",
			}));
			setStep(setupMode === "custom" ? "structure" : "connection");
		} catch (error) {
			setSaveError(
				error instanceof Error
					? error.message
					: "Could not create starter workspace",
			);
		} finally {
			setSaving(false);
		}
	}

	async function save() {
		setSaving(true);
		setSaveError(null);
		try {
			const config = buildFirstRunConfig(structure, setupMode);

			const res = await fetch("/api/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(config),
			});

			if (!res.ok) {
				const detail = await res.text().catch(() => "");
				throw new Error(detail || `Save failed (${res.status})`);
			}
			setStep("done");
		} catch (error) {
			setSaveError(error instanceof Error ? error.message : "Save failed");
			setSaving(false);
		}
	}

	return (
		<div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex flex-col sm:items-center sm:justify-center">
			<div className="flex flex-col flex-1 sm:flex-none w-full sm:max-w-lg bg-card border-0 sm:border sm:border-border sm:rounded-xl sm:shadow-2xl overflow-hidden sm:m-4">
				{/* Progress bar */}
				<div className="flex border-b border-border shrink-0">
					{STEPS.map((s, i) => (
						<div
							key={s}
							className={`flex-1 h-1 transition-colors ${
								STEPS.indexOf(step) >= i ? "bg-primary" : "bg-border"
							}`}
						/>
					))}
				</div>

				<div className="flex-1 overflow-y-auto p-4 sm:p-6">
					{saveError && (
						<div
							className="mb-4 rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
							role="alert"
						>
							{saveError}
						</div>
					)}
					{step === "welcome" && (
						<WelcomeStep
							onChoose={(mode) => {
								setSetupMode(mode);
								setStep("workspace");
							}}
						/>
					)}
					{step === "workspace" && (
						<WorkspaceChoiceStep
							onStarter={() => setStep("starter")}
							onExisting={() => setStep("vault")}
							onBack={() => setStep("welcome")}
						/>
					)}
					{step === "starter" && (
						<StarterWorkspaceStep
							creating={saving}
							onCreate={createStarterWorkspace}
							onBack={() => setStep("workspace")}
						/>
					)}
					{step === "vault" && (
						<VaultPickerStep
							onSelect={selectVault}
							onBack={() => setStep("workspace")}
						/>
					)}
					{step === "structure" && (
						<StructureStep
							state={structure}
							saving={saving}
							onChange={(p) => setStructure((s) => ({ ...s, ...p }))}
							onBack={() => setStep("vault")}
							onSave={() => setStep("connection")}
							permissionOptions={
								providers.find((p) => p.id === structure.vaultProvider)
									?.permissionModes
							}
							providerLabel={
								providers.find((p) => p.id === structure.vaultProvider)
									?.label ?? "Agent"
							}
							providerOptions={providers
								.filter(
									(provider) =>
										(provider.id === "claude" || provider.id === "codex") &&
										provider.available,
								)
								.map((provider) => ({
									value: provider.id,
									label: provider.label,
									desc: `Run vault sessions with ${provider.label}`,
								}))}
						/>
					)}
					{step === "connection" && (
						<ConnectionStep
							providers={providers}
							saving={saving}
							onBack={() =>
								setStep(setupMode === "custom" ? "structure" : "workspace")
							}
							onContinue={() =>
								setupMode === "guided" ? setStep("safety") : void save()
							}
						/>
					)}
					{step === "safety" && (
						<SafetyStep
							value={structure.permissionMode}
							saving={saving}
							onChange={(permissionMode) =>
								setStructure((current) => ({ ...current, permissionMode }))
							}
							onBack={() => setStep("connection")}
							onContinue={save}
						/>
					)}
					{step === "done" && (
						<DoneStep onComplete={onComplete} onTestChat={onTestChat} />
					)}
				</div>
			</div>
		</div>
	);
}
