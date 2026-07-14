import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { PageHeader, PageIntro } from "#/components/shell/PageHeader";
import { SectionRail } from "#/components/shell/SectionRail";
import { FolderGroupsTab, NotesTab } from "#/components/vault/NotesTab";
import { ProjectsTab } from "#/components/vault/ProjectsTab";
import { SkillsTab } from "#/components/vault/SkillsTab";
import { getConfig } from "#/config";
import { useWs } from "#/hooks/useWs";
import { setPendingPrompt } from "#/hooks/wsChatQueueStore";
import { ROUTE_SCROLL_RESTORATION_IDS } from "#/lib/scrollContainers";
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

const FIELD_DESCRIPTIONS: Record<VaultFolderKey, string> = {
	inbox: "Notes waiting to be sorted.",
	projects: "Active work and ideas with a defined outcome.",
	areas: "Ongoing responsibilities without an end date.",
	resources: "Reference material and topics worth keeping.",
	archive: "Finished or inactive material.",
	raw: "Unprocessed source notes.",
	wiki_folder: "Wiki pages and long-form reference.",
	skills: "Reusable workflows and agent instructions.",
	memory: "Saved context and durable project knowledge.",
	outputs: "Generated documents and finished artifacts.",
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

	const [query, setQuery] = useState("");

	const tab =
		tabConfig.find((t) => t.id === rawTab)?.id ?? tabConfig[0]?.id ?? "";

	const counts = useMemo<Record<string, number>>(
		() => ({
			inbox: inbox.length,
			projects: projects.length,
			areas: areas.reduce((n, g) => n + g.children.length, 0),
			resources: resources.reduce((n, g) => n + g.children.length, 0),
			archive: archive.length,
			raw: raw.length,
			wiki_folder: wikiPages.length,
			skills: skills.length,
			memory: memory.length,
			outputs: outputs.length,
		}),
		[
			inbox,
			projects,
			areas,
			resources,
			archive,
			raw,
			wikiPages,
			skills,
			memory,
			outputs,
		],
	);

	function setTab(t: string) {
		setQuery("");
		navigate({ search: { tab: t } });
	}

	function runSkill(content: string) {
		setPendingPrompt(content);
		send({ type: "chat", text: content } satisfies ClientMessage);
		navigate({
			to: "/raven",
			search: { session: undefined, agent: undefined },
		});
	}

	const activeLabel = FIELD_LABELS[tab as VaultFolderKey] ?? tab;
	const title = activeLabel.charAt(0) + activeLabel.slice(1).toLowerCase();
	const description = FIELD_DESCRIPTIONS[tab as VaultFolderKey];

	return (
		<div className="flex h-full min-h-0">
			<SectionRail
				items={tabConfig.map((t) => ({
					id: t.id,
					label: t.label,
					count: counts[t.id],
				}))}
				activeId={tab}
				onSelect={setTab}
				label="Vault categories"
				useAriaCurrent
			/>
			<div className="flex-1 min-w-0 flex flex-col">
				<PageHeader eyebrow="Vault">
					<select
						value={tab}
						onChange={(e) => setTab(e.target.value)}
						aria-label="Vault category"
						className="md:hidden w-full min-w-0 bg-secondary border border-border px-2 py-1.5 text-xs"
					>
						{tabConfig.map((t) => (
							<option key={t.id} value={t.id}>
								{t.label}
							</option>
						))}
					</select>
					<input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder={`Search ${title.toLowerCase()}`}
						aria-label="Search vault"
						className="col-span-2 row-start-2 w-full bg-secondary border border-border px-3 py-1.5 text-xs focus:outline-none focus:border-primary/50 md:col-span-1 md:row-auto md:ml-auto md:max-w-sm"
					/>
				</PageHeader>

				<div
					data-scroll-restoration-id={ROUTE_SCROLL_RESTORATION_IDS.vaultContent}
					data-scroll-to-top="route"
					className="flex-1 overflow-auto"
				>
					<div className="max-w-[1000px] mx-auto p-4 sm:p-6 space-y-6">
						<PageIntro
							title={title}
							description={description}
							count={counts[tab]}
						/>
						{tab === "projects" && (
							<ProjectsTab initial={projects} query={query} />
						)}
						{tab === "wiki_folder" && (
							<ProjectsTab
								initial={wikiPages}
								emptyLabel="wiki is empty"
								query={query}
							/>
						)}
						{tab === "skills" && (
							<SkillsTab
								skills={skills}
								sectionOrder={sectionOrder}
								onRun={runSkill}
								query={query}
							/>
						)}
						{tab === "memory" && (
							<NotesTab
								notes={memory}
								emptyLabel="nothing in memory yet"
								query={query}
							/>
						)}
						{tab === "inbox" && (
							<NotesTab
								notes={inbox}
								emptyLabel="inbox is empty"
								query={query}
							/>
						)}
						{tab === "raw" && (
							<NotesTab
								notes={raw}
								emptyLabel="raw folder is empty"
								query={query}
							/>
						)}
						{tab === "areas" && (
							<FolderGroupsTab
								groups={areas}
								emptyLabel="no areas found"
								query={query}
							/>
						)}
						{tab === "resources" && (
							<FolderGroupsTab
								groups={resources}
								emptyLabel="no resources found"
								query={query}
							/>
						)}
						{tab === "archive" && (
							<ProjectsTab
								initial={archive}
								emptyLabel="archive is empty"
								query={query}
							/>
						)}
						{tab === "outputs" && (
							<NotesTab
								notes={outputs}
								emptyLabel="no outputs yet"
								query={query}
							/>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
