import { useEffect, useState } from "react";
import type { HlidConfig } from "#/config";
import { DEFAULT_ATTACHMENTS_CONFIG, DEFAULT_VOICE_CONFIG } from "#/config";
import { getProvidersFn, type ProviderInfo } from "#/lib/serverFns";
import { buildVaultSection } from "#/lib/vaultConfig";
import type { StructureState } from "./WizardSteps";
import {
	DoneStep,
	PrimerStep,
	StructureStep,
	VaultPickerStep,
	WelcomeStep,
} from "./WizardSteps";

type Entry = { name: string; isDirectory: boolean };

type Step = "welcome" | "vault" | "structure" | "primer" | "done";

const STEPS: Step[] = ["welcome", "vault", "structure", "primer", "done"];

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

export function buildFirstRunConfig(s: StructureState): HlidConfig {
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
		claude: {
			model: "claude-sonnet-4-6",
			effort: "high",
			permission_mode: s.permissionMode,
			turn_recaps: true,
			interactive_mode: false,
		},
		codex: {
			model: "",
			effort: "medium",
			permission_mode: "default",
			turn_recaps: true,
		},
		ui: {
			enter_to_submit: true,
			hide_skills_index: true,
			theme: s.theme,
			html_plans: false,
		},
		status_vocabulary: {
			active: ["Active", "In Progress"],
			planning: ["Planning", "Ideas"],
			done: ["Done", "Complete", "Archived"],
		},
		attachments: DEFAULT_ATTACHMENTS_CONFIG,
		voice: DEFAULT_VOICE_CONFIG,
		agents: [],
		vault_provider: "claude",
	};
}

export function vaultNameFromPath(path: string): string | null {
	const parts = path.split(/[\\/]/).filter(Boolean);
	return parts.at(-1) ?? null;
}

type Props = {
	onComplete: () => void;
};

export function FirstRunWizard({ onComplete }: Props) {
	const [step, setStep] = useState<Step>("welcome");
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
		permissionMode: "default",
		theme: "tan",
	});

	// Fetch providers once on mount so StructureStep can show dynamic permission options.
	useEffect(() => {
		getProvidersFn()
			.then(setProviders)
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

	async function save() {
		setSaving(true);
		setSaveError(null);
		try {
			const config = buildFirstRunConfig(structure);

			const res = await fetch("/api/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(config),
			});

			if (!res.ok) {
				const detail = await res.text().catch(() => "");
				throw new Error(detail || `Save failed (${res.status})`);
			}
			setStep("primer");
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
						<WelcomeStep onNext={() => setStep("vault")} />
					)}
					{step === "vault" && (
						<VaultPickerStep
							onSelect={(path) => {
								setStructure((s) => ({ ...s, vaultPath: path }));
								setStep("structure");
							}}
						/>
					)}
					{step === "structure" && (
						<StructureStep
							state={structure}
							saving={saving}
							onChange={(p) => setStructure((s) => ({ ...s, ...p }))}
							onBack={() => setStep("vault")}
							onSave={save}
							permissionOptions={
								providers.find((p) => p.id === "claude")?.permissionModes
							}
						/>
					)}
					{step === "primer" && <PrimerStep onNext={() => setStep("done")} />}
					{step === "done" && <DoneStep onComplete={onComplete} />}
				</div>
			</div>
		</div>
	);
}
