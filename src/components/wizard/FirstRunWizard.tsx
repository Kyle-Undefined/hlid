import { useEffect, useState } from "react";
import type { HlidConfig } from "#/config";
import { DEFAULT_ATTACHMENTS_CONFIG } from "#/config";
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

function detect(entries: Entry[]): Partial<StructureState> {
	const find = (patterns: string[]) =>
		entries.find((e) =>
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

type Props = {
	onComplete: () => void;
};

export function FirstRunWizard({ onComplete }: Props) {
	const [step, setStep] = useState<Step>("welcome");
	const [saving, setSaving] = useState(false);
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
				const detected = detect(data.entries);
				const parts = data.path.split("/").filter(Boolean);
				setStructure((s) => ({
					...s,
					...detected,
					vaultName: parts.length > 0 ? parts[parts.length - 1] : s.vaultName,
				}));
			})
			.catch(() => {});
	}, [structure.vaultPath]);

	async function save() {
		setSaving(true);
		try {
			const s = structure;
			const config: HlidConfig = {
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
					effort: "high" as const,
					permission_mode: s.permissionMode,
					turn_recaps: true,
				},
				ui: {
					enter_to_submit: true,
					hide_skills_index: true,
					theme: s.theme,
				},
				status_vocabulary: {
					active: ["Active", "In Progress"],
					planning: ["Planning", "Ideas"],
					done: ["Done", "Complete", "Archived"],
				},
				attachments: DEFAULT_ATTACHMENTS_CONFIG,
				agents: [],
				vault_provider: "claude",
			};

			const res = await fetch("/api/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(config),
			});

			if (!res.ok) throw new Error("Save failed");
			setStep("primer");
		} catch {
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
