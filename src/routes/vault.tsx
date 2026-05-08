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

const getVaultData = createServerFn({ method: "GET" }).handler(async () => {
	const [config, { scanProjects, scanSkills, scanMemory, scanFolderGroups }] =
		await Promise.all([getConfig(), import("#/lib/vault")]);
	const { vault, status_vocabulary } = config;

	const isWiki = vault.style === "wiki";
	const fieldOrder = isWiki ? WIKI_ORDER : PARA_ORDER;

	const tabConfig = fieldOrder
		.filter((key) => !!vault[key])
		.map((key) => ({ id: key, label: FIELD_LABELS[key] }));

	const projects =
		vault.path && vault.projects
			? scanProjects(vault.path, vault.projects, status_vocabulary)
			: [];

	const wikiPages =
		vault.path && vault.wiki_folder
			? scanProjects(vault.path, vault.wiki_folder, status_vocabulary)
			: [];

	const { skills, sectionOrder } =
		vault.path && vault.skills
			? scanSkills(vault.path, vault.skills, config.ui.hide_skills_index)
			: { skills: [], sectionOrder: [] };

	const memory =
		vault.path && vault.memory ? scanMemory(vault.path, vault.memory) : [];

	const inbox =
		vault.path && vault.inbox ? scanMemory(vault.path, vault.inbox) : [];

	const raw = vault.path && vault.raw ? scanMemory(vault.path, vault.raw) : [];

	const areas =
		vault.path && vault.areas ? scanFolderGroups(vault.path, vault.areas) : [];

	const resources =
		vault.path && vault.resources
			? scanFolderGroups(vault.path, vault.resources)
			: [];

	const archive =
		vault.path && vault.archive
			? scanProjects(vault.path, vault.archive, status_vocabulary)
			: [];

	const outputs =
		vault.path && vault.outputs ? scanMemory(vault.path, vault.outputs) : [];

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
