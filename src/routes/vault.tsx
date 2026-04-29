import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { ChevronDown, ChevronRight, Folder, Play } from "lucide-react";
import { useState } from "react";
import { MarkdownBody } from "#/components/MarkdownBody";
import { PrivacyMask } from "#/components/PrivacyMask";
import { getConfig } from "#/config";
import { useWs } from "#/hooks/useWs";
import * as wsStore from "#/hooks/wsStore";
import type { ProjectStatus } from "#/lib/classify";
import type { MemoryFile, Project, ProjectNode, Skill } from "#/lib/vault";
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
	const [config, { scanProjects, scanSkills, scanMemory }] = await Promise.all([
		getConfig(),
		import("#/lib/vault"),
	]);
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
		vault.path && vault.areas ? scanMemory(vault.path, vault.areas) : [];

	const resources =
		vault.path && vault.resources
			? scanProjects(vault.path, vault.resources, status_vocabulary)
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

// ─── projects ──────────────────────────────────────────────────────────────

const STATUS_ORDER: ProjectStatus[] = ["active", "planning", "done", "unknown"];

const STATUS_LABEL: Record<ProjectStatus, string> = {
	active: "ACTIVE",
	planning: "PLANNING",
	done: "DONE",
	unknown: "UNKNOWN",
};

const STATUS_DOT: Record<ProjectStatus, string> = {
	active: "bg-green-600",
	planning: "bg-primary",
	done: "bg-muted-foreground/40",
	unknown: "bg-muted-foreground/20",
};

function ProjectNodeItem({
	node,
	depth = 0,
}: {
	node: ProjectNode;
	depth?: number;
}) {
	const [open, setOpen] = useState(false);
	const hasContent = node.isFolder
		? !!(node.children && node.children.length > 0)
		: !!node.content;

	return (
		<div>
			<button
				type="button"
				onClick={() => hasContent && setOpen((v) => !v)}
				className={`w-full flex items-center gap-1.5 py-1 text-left transition-opacity ${
					hasContent
						? "hover:opacity-80 cursor-pointer"
						: "cursor-default opacity-50"
				}`}
				style={{ paddingLeft: `${depth * 14}px` }}
			>
				<span className="w-3 h-3 shrink-0 flex items-center justify-center">
					{hasContent ? (
						open ? (
							<ChevronDown className="w-2.5 h-2.5 text-muted-foreground" />
						) : (
							<ChevronRight className="w-2.5 h-2.5 text-muted-foreground" />
						)
					) : null}
				</span>
				{node.isFolder && (
					<Folder className="w-3 h-3 text-muted-foreground/70 shrink-0" />
				)}
				<PrivacyMask inline className="text-xs text-foreground/70 truncate">{node.name}</PrivacyMask>
			</button>
			{open && node.isFolder && node.children && (
				<div>
					{node.children.map((child) => (
						<ProjectNodeItem key={child.path} node={child} depth={depth + 1} />
					))}
				</div>
			)}
			{open && !node.isFolder && node.content && (
				<div
					className="text-xs text-foreground/70 leading-relaxed border-l border-border/50 py-2 pr-2"
					style={{ marginLeft: `${depth * 14 + 12}px`, paddingLeft: "8px" }}
				>
					<PrivacyMask><MarkdownBody content={node.content} /></PrivacyMask>
				</div>
			)}
		</div>
	);
}

function ProjectCard({ project }: { project: Project }) {
	const [open, setOpen] = useState(false);
	const hasContent =
		!!project.content?.trim() ||
		!!(project.isFolder && project.children && project.children.length > 0);

	return (
		<div className="divide-y divide-border">
			<button
				type="button"
				onClick={() => hasContent && setOpen((v) => !v)}
				className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
					hasContent ? "hover:bg-accent cursor-pointer" : "cursor-default"
				}`}
			>
				{hasContent ? (
					open ? (
						<ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
					) : (
						<ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
					)
				) : (
					<span className="w-3 h-3 shrink-0" />
				)}
				<div className="min-w-0 flex-1">
					<PrivacyMask inline className="text-sm text-foreground truncate">
						{project.title}
					</PrivacyMask>
					{project.tags.length > 0 && (
						<PrivacyMask className="flex gap-1 mt-0.5 flex-wrap">
							{project.tags.map((t) => (
								<span
									key={t}
									className="text-[9px] tracking-wider px-1.5 py-0.5 bg-secondary text-muted-foreground"
								>
									{t}
								</span>
							))}
						</PrivacyMask>
					)}
				</div>
				<div className="flex items-center gap-1.5 px-2 py-0.5 bg-secondary text-[10px] tracking-wider text-muted-foreground shrink-0">
					<span
						className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[project.status]}`}
					/>
					<PrivacyMask inline>{project.rawStatus || "NO STATUS"}</PrivacyMask>
				</div>
			</button>
			{open && project.content && project.content.trim() && (
				<div className="px-6 py-4 bg-secondary/30 text-xs text-foreground/80 leading-relaxed">
					<PrivacyMask><MarkdownBody content={project.content} /></PrivacyMask>
				</div>
			)}
			{open &&
				project.isFolder &&
				project.children &&
				project.children.length > 0 && (
					<div className="px-4 py-3 bg-secondary/20 space-y-0.5">
						{project.children.map((child) => (
							<ProjectNodeItem key={child.path} node={child} depth={0} />
						))}
					</div>
				)}
		</div>
	);
}

function ProjectGroup({
	status,
	projects,
}: {
	status: ProjectStatus;
	projects: Project[];
}) {
	if (projects.length === 0) return null;
	return (
		<div className="space-y-2">
			<div className="flex items-center gap-2">
				<span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[status]}`} />
				<h2 className="text-[10px] tracking-widest text-muted-foreground uppercase">
					{STATUS_LABEL[status]}
				</h2>
				<span className="text-[10px] text-muted-foreground/50">
					{projects.length}
				</span>
			</div>
			<div className="border border-border bg-card divide-y divide-border">
				{projects.map((p) => (
					<ProjectCard key={p.file} project={p} />
				))}
			</div>
		</div>
	);
}

function ProjectsTab({
	initial,
	emptyLabel,
}: {
	initial: Project[];
	emptyLabel?: string;
}) {
	const grouped = STATUS_ORDER.reduce(
		(acc, s) => {
			acc[s] = initial.filter((p) => p.status === s);
			return acc;
		},
		{} as Record<ProjectStatus, Project[]>,
	);

	if (initial.length === 0) {
		return (
			<div className="border border-border bg-card px-4 py-8 text-center">
				<p className="text-xs tracking-wider text-muted-foreground">
					{emptyLabel ?? "no projects found, set a projects folder in config"}
				</p>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{STATUS_ORDER.map((s) => (
				<ProjectGroup key={s} status={s} projects={grouped[s]} />
			))}
		</div>
	);
}

// ─── skills ────────────────────────────────────────────────────────────────

function SkillCard({
	skill,
	onRun,
}: {
	skill: Skill;
	onRun: (content: string) => void;
}) {
	const [open, setOpen] = useState(false);

	return (
		<div className="divide-y divide-border">
			<div className="flex items-center gap-3 px-4 py-3">
				<button
					type="button"
					onClick={() => setOpen((v) => !v)}
					className="flex items-center gap-3 min-w-0 flex-1 text-left hover:opacity-80 transition-opacity"
				>
					{open ? (
						<ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
					) : (
						<ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
					)}
					<div className="min-w-0">
						<PrivacyMask className="text-sm text-foreground truncate">{skill.name}</PrivacyMask>
						{skill.description && (
							<PrivacyMask className="text-xs text-muted-foreground mt-0.5 truncate">
								{skill.description}
							</PrivacyMask>
						)}
					</div>
				</button>
				<button
					type="button"
					onClick={() => onRun(`/${skill.name}`)}
					title="Run this skill"
					className="flex items-center gap-1.5 px-2.5 py-1.5 bg-primary/10 border border-primary/20 text-[10px] tracking-widest text-primary hover:bg-primary/20 transition-colors shrink-0 uppercase"
				>
					<Play className="w-3 h-3" />
					RUN
				</button>
			</div>
			{open && skill.content && (
				<div className="px-6 py-4 bg-secondary/30 text-xs text-foreground/80 leading-relaxed">
					<PrivacyMask><MarkdownBody content={skill.content} /></PrivacyMask>
				</div>
			)}
		</div>
	);
}

function groupSkills(
	skills: Skill[],
	sectionOrder: string[],
): { section: string | null; skills: Skill[] }[] {
	const groups: { section: string | null; skills: Skill[] }[] = [];
	const seen = new Set<string>();

	for (const sec of sectionOrder) {
		const members = skills.filter((s) => s.section === sec);
		if (members.length === 0) continue;
		groups.push({ section: sec, skills: members });
		for (const s of members) seen.add(s.file);
	}

	groups.sort((a, b) => (a.section ?? "").localeCompare(b.section ?? ""));
	const unsectioned = skills.filter((s) => !seen.has(s.file));
	if (unsectioned.length > 0)
		groups.push({ section: null, skills: unsectioned });

	return groups;
}

function SkillsTab({
	skills,
	sectionOrder,
	onRun,
}: {
	skills: Skill[];
	sectionOrder: string[];
	onRun: (content: string) => void;
}) {
	if (skills.length === 0) {
		return (
			<div className="border border-border bg-card px-4 py-8 text-center">
				<p className="text-xs tracking-wider text-muted-foreground">
					no skills here yet, add{" "}
					<code className="font-mono text-primary">.md</code> files to your
					skills folder
				</p>
			</div>
		);
	}

	const groups = groupSkills(skills, sectionOrder);

	return (
		<div className="space-y-6">
			{groups.map((g) => (
				<div key={g.section ?? "__unsectioned__"} className="space-y-2">
					<div className="flex items-center gap-2">
						<span className="w-1.5 h-1.5 rounded-full bg-primary/40 shrink-0" />
						<PrivacyMask inline className="text-[10px] tracking-widest text-muted-foreground uppercase">
							{g.section ?? "SKILLS"}
						</PrivacyMask>
						<span className="text-[10px] text-muted-foreground/50">
							{g.skills.length}
						</span>
					</div>
					<div className="border border-border bg-card divide-y divide-border">
						{g.skills.map((s) => (
							<SkillCard key={s.file} skill={s} onRun={onRun} />
						))}
					</div>
				</div>
			))}
		</div>
	);
}

// ─── memory / generic folder ───────────────────────────────────────────────

function MemoryCard({ file }: { file: MemoryFile }) {
	const [open, setOpen] = useState(false);

	return (
		<div className="divide-y divide-border">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="w-full flex items-center gap-3 px-4 py-3 hover:bg-accent transition-colors text-left"
			>
				{open ? (
					<ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
				) : (
					<ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
				)}
				<div className="min-w-0">
					<PrivacyMask className="text-sm text-foreground truncate">{file.name}</PrivacyMask>
					<PrivacyMask className="text-[10px] tracking-wider text-muted-foreground font-mono truncate mt-0.5">
						{file.path}
					</PrivacyMask>
				</div>
			</button>
			{open && (
				<div className="px-6 py-4 bg-secondary/30 text-xs text-foreground/80 leading-relaxed">
					<PrivacyMask><MarkdownBody content={file.content} /></PrivacyMask>
				</div>
			)}
		</div>
	);
}

function NotesTab({
	notes,
	emptyLabel,
}: {
	notes: MemoryFile[];
	emptyLabel?: string;
}) {
	if (notes.length === 0) {
		return (
			<div className="border border-border bg-card px-4 py-8 text-center">
				<p className="text-xs tracking-wider text-muted-foreground">
					{emptyLabel ?? "nothing here yet"}
				</p>
			</div>
		);
	}

	return (
		<div className="border border-border bg-card overflow-hidden divide-y divide-border">
			{notes.map((f) => (
				<MemoryCard key={f.path} file={f} />
			))}
		</div>
	);
}

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
					<NotesTab notes={areas} emptyLabel="no areas found" />
				)}
				{tab === "resources" && (
					<ProjectsTab initial={resources} emptyLabel="no resources found" />
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
