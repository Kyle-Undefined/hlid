import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { FolderGroupsTab, NotesTab } from "#/components/vault/NotesTab";
import { ProjectsTab } from "#/components/vault/ProjectsTab";
import { SkillsTab } from "#/components/vault/SkillsTab";
import { getConfig } from "#/config";
import { useWs } from "#/hooks/useWs";
import * as wsStore from "#/hooks/wsStore";
import type { ClientMessage } from "#/server/protocol";

// ─── server fns ────────────────────────────────────────────────────────────

type VaultFolderKey =
	| "inbox"
	| "projects"
	| "areas"
	| "resources"
	| "archive"
	| "raw"
	| "wiki_folder"
	| "skills"
	| "memory"
	| "outputs";

const PARA_ORDER: VaultFolderKey[] = [
	"inbox",
	"projects",
	"areas",
	"resources",
	"archive",
	"skills",
	"memory",
	"outputs",
];
const WIKI_ORDER: VaultFolderKey[] = [
	"raw",
	"wiki_folder",
	"outputs",
	"skills",
	"memory",
];

const FIELD_LABELS: Record<VaultFolderKey, string> = {
	inbox: "INBOX",
	projects: "PROJECTS",
	areas: "AREAS",
	resources: "RESOURCES",
	archive: "ARCHIVE",
	raw: "RAW",
	wiki_folder: "WIKI",
	skills: "SKILLS",
	memory: "MEMORY",
	outputs: "OUTPUTS",
};

type VaultConfig = Awaited<ReturnType<typeof getConfig>>["vault"];

function scanConfiguredFolder<T>(
	vault: VaultConfig,
	key: VaultFolderKey,
	scan: (root: string, folder: string) => T,
	fallback: T,
): T {
	const folder = vault[key];
	return vault.path && typeof folder === "string"
		? scan(vault.path, folder)
		: fallback;
}

function configuredVaultTabs(vault: VaultConfig) {
	const fieldOrder = vault.style === "wiki" ? WIKI_ORDER : PARA_ORDER;
	return fieldOrder
		.filter((key) => Boolean(vault[key]))
		.map((key) => ({ id: key, label: FIELD_LABELS[key] }));
}

const getVaultData = createServerFn({ method: "GET" }).handler(async () => {
	const [config, { scanProjects, scanSkills, scanMemory, scanFolderGroups }] =
		await Promise.all([getConfig(), import("#/lib/vault")]);
	const { vault, status_vocabulary } = config;

	const tabConfig = configuredVaultTabs(vault);
	const scanProjectFolder = (root: string, folder: string) =>
		scanProjects(root, folder, status_vocabulary);
	const projects = scanConfiguredFolder(
		vault,
		"projects",
		scanProjectFolder,
		[],
	);
	const wikiPages = scanConfiguredFolder(
		vault,
		"wiki_folder",
		scanProjectFolder,
		[],
	);
	const { skills, sectionOrder } = scanConfiguredFolder(
		vault,
		"skills",
		(root, folder) => scanSkills(root, folder, config.ui.hide_skills_index),
		{ skills: [], sectionOrder: [] },
	);
	const memory = scanConfiguredFolder(vault, "memory", scanMemory, []);
	const inbox = scanConfiguredFolder(vault, "inbox", scanMemory, []);
	const raw = scanConfiguredFolder(vault, "raw", scanMemory, []);
	const areas = scanConfiguredFolder(vault, "areas", scanFolderGroups, []);
	const resources = scanConfiguredFolder(
		vault,
		"resources",
		scanFolderGroups,
		[],
	);
	const archive = scanConfiguredFolder(vault, "archive", scanProjectFolder, []);
	const outputs = scanConfiguredFolder(vault, "outputs", scanMemory, []);

	return {
		tabConfig,
		projects,
		wikiPages,
		resources,
		archive,
		skills,
		sectionOrder,
		memory,
		inbox,
		raw,
		areas,
		outputs,
		vocab: status_vocabulary,
	};
});

// ─── route ─────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/vault")({
	validateSearch: (s: Record<string, unknown>) => ({
		tab: s.tab as string | undefined,
	}),
	loader: () => getVaultData(),
	component: VaultPage,
});

// ─── page ──────────────────────────────────────────────────────────────────

function VaultPage() {
	const {
		tabConfig,
		projects,
		wikiPages,
		resources,
		archive,
		skills,
		sectionOrder,
		memory,
		inbox,
		raw,
		areas,
		outputs,
	} = Route.useLoaderData();
	const { tab: rawTab } = Route.useSearch();
	const navigate = useNavigate({ from: "/vault" });
	const { send } = useWs();

	const tab =
		tabConfig.find((t) => t.id === rawTab)?.id ?? tabConfig[0]?.id ?? "";

	function setTab(t: string) {
		navigate({ search: { tab: t } });
	}

	function runSkill(content: string) {
		wsStore.setPendingPrompt(content);
		send({ type: "chat", text: content } satisfies ClientMessage);
		navigate({
			to: "/raven",
			search: { session: undefined, agent: undefined },
		});
	}

	return (
		<div className="flex flex-col h-full">
			{/* Tabs */}
			<div className="flex flex-wrap border-b border-border shrink-0">
				{tabConfig.map((t) => (
					<button
						key={t.id}
						type="button"
						onClick={() => setTab(t.id)}
						className={`px-5 py-2.5 text-[10px] tracking-widest transition-colors border-b-2 -mb-px ${
							tab === t.id
								? "border-primary text-primary"
								: "border-transparent text-muted-foreground hover:text-foreground"
						}`}
					>
						{t.label}
					</button>
				))}
			</div>

			{/* Content */}
			<div className="flex-1 overflow-auto p-5 space-y-5">
				{tab === "projects" && <ProjectsTab initial={projects} />}
				{tab === "wiki_folder" && (
					<ProjectsTab initial={wikiPages} emptyLabel="wiki is empty" />
				)}
				{tab === "skills" && (
					<SkillsTab
						skills={skills}
						sectionOrder={sectionOrder}
						onRun={runSkill}
					/>
				)}
				{tab === "memory" && (
					<NotesTab notes={memory} emptyLabel="nothing in memory yet" />
				)}
				{tab === "inbox" && (
					<NotesTab notes={inbox} emptyLabel="inbox is empty" />
				)}
				{tab === "raw" && (
					<NotesTab notes={raw} emptyLabel="raw folder is empty" />
				)}
				{tab === "areas" && (
					<FolderGroupsTab groups={areas} emptyLabel="no areas found" />
				)}
				{tab === "resources" && (
					<FolderGroupsTab groups={resources} emptyLabel="no resources found" />
				)}
				{tab === "archive" && (
					<ProjectsTab initial={archive} emptyLabel="archive is empty" />
				)}
				{tab === "outputs" && (
					<NotesTab notes={outputs} emptyLabel="no outputs yet" />
				)}
			</div>
		</div>
	);
}
