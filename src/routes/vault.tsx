import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { ChevronDown, ChevronRight, Play } from "lucide-react";
import { useState } from "react";
import { getConfig } from "#/config";
import { useWs } from "#/hooks/useWs";
import type {
	MemoryFile,
	Project,
	ProjectStatus,
	Skill,
	StatusVocabulary,
} from "#/lib/vault";
import {
	classifyStatus,
	scanMemory,
	scanProjects,
	scanSkills,
	setProjectStatus,
} from "#/lib/vault";
import type { ClientMessage } from "#/server/protocol";

// ─── server fns ────────────────────────────────────────────────────────────

const getVaultData = createServerFn({ method: "GET" }).handler(async () => {
	const config = await getConfig();
	const { vault, status_vocabulary } = config;

	const projects =
		vault.path && vault.projects
			? scanProjects(vault.path, vault.projects, status_vocabulary)
			: [];

	const skills =
		vault.path && vault.skills ? scanSkills(vault.path, vault.skills) : [];

	const memory =
		vault.path && vault.memory ? scanMemory(vault.path, vault.memory) : [];

	return { projects, skills, memory, vocab: status_vocabulary };
});

const updateStatus = createServerFn({ method: "POST" })
	.inputValidator((d: unknown) => {
		if (
			typeof d !== "object" ||
			d === null ||
			typeof (d as Record<string, unknown>).file !== "string" ||
			typeof (d as Record<string, unknown>).status !== "string"
		) {
			throw new Error("Invalid input");
		}
		return d as { file: string; status: string };
	})
	.handler(async ({ data }) => {
		const config = await getConfig();
		if (!config.vault.path || !config.vault.projects) return;
		setProjectStatus(
			config.vault.path,
			config.vault.projects,
			data.file,
			data.status,
		);
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

function StatusPill({
	project,
	allStatuses,
	onChange,
}: {
	project: Project;
	allStatuses: string[];
	onChange: (status: string) => void;
}) {
	const [open, setOpen] = useState(false);

	return (
		<div className="relative">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex items-center gap-1.5 px-2 py-0.5 bg-secondary text-[10px] tracking-wider text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
			>
				<span
					className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[project.status]}`}
				/>
				{project.rawStatus || "NO STATUS"}
			</button>

			{open && (
				<>
					<button
						type="button"
						aria-label="Close"
						className="fixed inset-0 z-40"
						onClick={() => setOpen(false)}
					/>
					<div className="absolute right-0 top-full mt-px z-50 bg-popover border border-border shadow-lg overflow-hidden min-w-32">
						{allStatuses.map((s) => (
							<button
								key={s}
								type="button"
								onClick={() => {
									onChange(s);
									setOpen(false);
								}}
								className={`w-full text-left px-3 py-1.5 text-xs tracking-wider hover:bg-accent transition-colors ${s === project.rawStatus ? "text-primary" : "text-foreground"}`}
							>
								{s}
							</button>
						))}
					</div>
				</>
			)}
		</div>
	);
}

function ProjectCard({
	project,
	allStatuses,
	onStatusChange,
}: {
	project: Project;
	allStatuses: string[];
	onStatusChange: (file: string, status: string) => void;
}) {
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
			<StatusPill
				project={project}
				allStatuses={allStatuses}
				onChange={(s) => onStatusChange(project.file, s)}
			/>
		</div>
	);
}

function ProjectGroup({
	status,
	projects,
	allStatuses,
	onStatusChange,
}: {
	status: ProjectStatus;
	projects: Project[];
	allStatuses: string[];
	onStatusChange: (file: string, status: string) => void;
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
					<ProjectCard
						key={p.file}
						project={p}
						allStatuses={allStatuses}
						onStatusChange={onStatusChange}
					/>
				))}
			</div>
		</div>
	);
}

function ProjectsTab({
	initial,
	vocab,
}: {
	initial: Project[];
	vocab: StatusVocabulary;
}) {
	const [projects, setProjects] = useState<Project[]>(initial);

	const allStatuses = Array.from(
		new Set(projects.map((p) => p.rawStatus).filter(Boolean)),
	).sort();

	async function handleStatusChange(file: string, newStatus: string) {
		const prev = projects;
		setProjects((ps) =>
			ps.map((p) =>
				p.file === file
					? {
							...p,
							rawStatus: newStatus,
							status: classifyStatus(newStatus, vocab),
						}
					: p,
			),
		);
		try {
			await updateStatus({ data: { file, status: newStatus } });
		} catch {
			setProjects(prev);
		}
	}

	const grouped = STATUS_ORDER.reduce(
		(acc, s) => {
			acc[s] = projects.filter((p) => p.status === s);
			return acc;
		},
		{} as Record<ProjectStatus, Project[]>,
	);

	if (projects.length === 0) {
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
				<ProjectGroup
					key={s}
					status={s}
					projects={grouped[s]}
					allStatuses={allStatuses}
					onStatusChange={handleStatusChange}
				/>
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
	return (
		<div className="flex items-center justify-between gap-4 px-4 py-3">
			<div className="min-w-0">
				<div className="text-sm text-foreground">{skill.name}</div>
				{skill.description && (
					<div className="text-xs text-muted-foreground mt-0.5 truncate">
						{skill.description}
					</div>
				)}
			</div>
			<button
				type="button"
				onClick={() => onRun(skill.content)}
				title="Run this skill"
				className="flex items-center gap-1.5 px-2.5 py-1.5 bg-primary/10 border border-primary/20 text-[10px] tracking-widest text-primary hover:bg-primary/20 transition-colors shrink-0 uppercase"
			>
				<Play className="w-3 h-3" />
				RUN
			</button>
		</div>
	);
}

function SkillsTab({
	skills,
	onRun,
}: {
	skills: Skill[];
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

	return (
		<div className="border border-border bg-card divide-y divide-border">
			{skills.map((s) => (
				<SkillCard key={s.file} skill={s} onRun={onRun} />
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
				<div className="px-4 py-3 bg-secondary/30">
					<pre className="text-xs text-foreground/70 whitespace-pre-wrap font-mono leading-relaxed max-h-64 overflow-y-auto">
						{file.content}
					</pre>
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
	const { projects, skills, memory, vocab } = Route.useLoaderData();
	const { tab } = Route.useSearch();
	const navigate = useNavigate({ from: "/vault" });
	const { send } = useWs();

	function setTab(t: Tab) {
		navigate({ search: { tab: t } });
	}

	function runSkill(content: string) {
		const msg: ClientMessage = { type: "chat", text: content };
		send(msg);
		navigate({ to: "/chat" });
	}

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div className="px-5 py-3.5 border-b border-border shrink-0">
				<span className="text-[11px] tracking-widest text-muted-foreground uppercase">
					VAULT
				</span>
			</div>

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
				{tab === "projects" && <ProjectsTab initial={projects} vocab={vocab} />}
				{tab === "skills" && <SkillsTab skills={skills} onRun={runSkill} />}
				{tab === "memory" && <MemoryTab memory={memory} />}
			</div>
		</div>
	);
}
