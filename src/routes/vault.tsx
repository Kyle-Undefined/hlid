import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { ChevronDown, ChevronRight, Play } from "lucide-react";
import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getConfig } from "#/config";
import { useWs } from "#/hooks/useWs";
import * as wsStore from "#/hooks/wsStore";
import type { ProjectStatus } from "#/lib/classify";
import type { MemoryFile, Project, Skill } from "#/lib/vault";
import type { ClientMessage } from "#/server/protocol";

// ─── server fns ────────────────────────────────────────────────────────────

const getVaultData = createServerFn({ method: "GET" }).handler(async () => {
	const [config, { scanProjects, scanSkills, scanMemory }] = await Promise.all([
		getConfig(),
		import("#/lib/vault"),
	]);
	const { vault, status_vocabulary } = config;

	const projects =
		vault.path && vault.projects
			? scanProjects(vault.path, vault.projects, status_vocabulary)
			: [];

	const { skills, sectionOrder } =
		vault.path && vault.skills
			? scanSkills(vault.path, vault.skills, config.ui.hide_skills_index)
			: { skills: [], sectionOrder: [] };

	const memory =
		vault.path && vault.memory ? scanMemory(vault.path, vault.memory) : [];

	return { projects, skills, sectionOrder, memory, vocab: status_vocabulary };
});

// ─── route ─────────────────────────────────────────────────────────────────

type Tab = "projects" | "skills" | "memory";

export const Route = createFileRoute("/vault")({
	validateSearch: (s: Record<string, unknown>) => ({
		tab: (s.tab as Tab | undefined) ?? "projects",
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

function ProjectCard({ project }: { project: Project }) {
	return (
		<div className="flex items-center justify-between gap-4 px-4 py-3">
			<div className="min-w-0">
				<div className="text-sm text-foreground truncate">{project.title}</div>
				{project.tags.length > 0 && (
					<div className="flex gap-1 mt-0.5 flex-wrap">
						{project.tags.map((t) => (
							<span
								key={t}
								className="text-[9px] tracking-wider px-1.5 py-0.5 bg-secondary text-muted-foreground"
							>
								{t}
							</span>
						))}
					</div>
				)}
			</div>
			<div className="flex items-center gap-1.5 px-2 py-0.5 bg-secondary text-[10px] tracking-wider text-muted-foreground shrink-0">
				<span
					className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[project.status]}`}
				/>
				{project.rawStatus || "NO STATUS"}
			</div>
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

function ProjectsTab({ initial }: { initial: Project[] }) {
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
					no projects found, set a projects folder in config
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

// ─── shared markdown renderer ──────────────────────────────────────────────

function MarkdownBody({ content }: { content: string }) {
	return (
		<Markdown
			remarkPlugins={[remarkGfm]}
			components={{
				p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
				h1: ({ children }) => (
					<h1 className="text-base font-bold mb-2 mt-4 first:mt-0">
						{children}
					</h1>
				),
				h2: ({ children }) => (
					<h2 className="text-sm font-bold mb-2 mt-4 first:mt-0 tracking-wide">
						{children}
					</h2>
				),
				h3: ({ children }) => (
					<h3 className="text-sm font-semibold mb-1.5 mt-3 first:mt-0">
						{children}
					</h3>
				),
				ul: ({ children }) => (
					<ul className="list-disc pl-5 mb-3 space-y-0.5">{children}</ul>
				),
				ol: ({ children }) => (
					<ol className="list-decimal pl-5 mb-3 space-y-0.5">{children}</ol>
				),
				li: ({ children }) => <li className="leading-relaxed">{children}</li>,
				code: ({ children, className }) => {
					const isBlock = className?.startsWith("language-");
					return isBlock ? (
						<code className="block bg-secondary/60 border border-border px-3 py-2 text-xs font-mono text-foreground/90 overflow-x-auto whitespace-pre mb-3">
							{children}
						</code>
					) : (
						<code className="bg-secondary/80 px-1.5 py-0.5 text-[11px] font-mono text-primary/80">
							{children}
						</code>
					);
				},
				pre: ({ children }) => <pre className="mb-3">{children}</pre>,
				blockquote: ({ children }) => (
					<blockquote className="border-l-2 border-primary/30 pl-3 text-foreground/75 italic mb-3">
						{children}
					</blockquote>
				),
				a: ({ href, children }) => (
					<a
						href={href}
						className="text-primary underline underline-offset-2 hover:text-primary/80"
						target="_blank"
						rel="noreferrer"
					>
						{children}
					</a>
				),
				strong: ({ children }) => (
					<strong className="font-semibold text-foreground">{children}</strong>
				),
				hr: () => <hr className="border-border my-3" />,
				table: ({ children }) => (
					<div className="overflow-x-auto mb-3">
						<table className="text-xs w-full border-collapse">{children}</table>
					</div>
				),
				th: ({ children }) => (
					<th className="border border-border px-3 py-1.5 text-left text-[10px] tracking-wider text-muted-foreground bg-secondary/40">
						{children}
					</th>
				),
				td: ({ children }) => (
					<td className="border border-border px-3 py-1.5">{children}</td>
				),
			}}
		>
			{content}
		</Markdown>
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
						<div className="text-sm text-foreground">{skill.name}</div>
						{skill.description && (
							<div className="text-xs text-muted-foreground mt-0.5 truncate">
								{skill.description}
							</div>
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
					<MarkdownBody content={skill.content} />
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
						<span className="text-[10px] tracking-widest text-muted-foreground uppercase">
							{g.section ?? "SKILLS"}
						</span>
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

// ─── memory ────────────────────────────────────────────────────────────────

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
					<div className="text-sm text-foreground">{file.name}</div>
					<div className="text-[10px] tracking-wider text-muted-foreground font-mono truncate mt-0.5">
						{file.path}
					</div>
				</div>
			</button>
			{open && (
				<div className="px-6 py-4 bg-secondary/30 text-xs text-foreground/80 leading-relaxed">
					<MarkdownBody content={file.content} />
				</div>
			)}
		</div>
	);
}

function MemoryTab({ memory }: { memory: MemoryFile[] }) {
	if (memory.length === 0) {
		return (
			<div className="border border-border bg-card px-4 py-8 text-center">
				<p className="text-xs tracking-wider text-muted-foreground">
					nothing in memory yet
				</p>
			</div>
		);
	}

	return (
		<div className="border border-border bg-card overflow-hidden divide-y divide-border">
			{memory.map((f) => (
				<MemoryCard key={f.path} file={f} />
			))}
		</div>
	);
}

// ─── page ──────────────────────────────────────────────────────────────────

const TABS: { id: Tab; label: string }[] = [
	{ id: "projects", label: "PROJECTS" },
	{ id: "skills", label: "SKILLS" },
	{ id: "memory", label: "MEMORY" },
];

function VaultPage() {
	const { projects, skills, sectionOrder, memory } = Route.useLoaderData();
	const { tab } = Route.useSearch();
	const navigate = useNavigate({ from: "/vault" });
	const { send } = useWs();

	function setTab(t: Tab) {
		navigate({ search: { tab: t } });
	}

	function runSkill(content: string) {
		wsStore.setPendingPrompt(content);
		send({ type: "chat", text: content } satisfies ClientMessage);
		navigate({ to: "/chat", search: { session: undefined } });
	}

	return (
		<div className="flex flex-col h-full">
			{/* Tabs */}
			<div className="flex border-b border-border shrink-0">
				{TABS.map((t) => (
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
				{tab === "skills" && (
					<SkillsTab
						skills={skills}
						sectionOrder={sectionOrder}
						onRun={runSkill}
					/>
				)}
				{tab === "memory" && <MemoryTab memory={memory} />}
			</div>
		</div>
	);
}
