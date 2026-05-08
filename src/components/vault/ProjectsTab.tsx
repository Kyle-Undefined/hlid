import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import { useState } from "react";
import { MarkdownBody } from "#/components/MarkdownBody";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { ProjectStatus } from "#/lib/classify";
import type { Project, ProjectNode } from "#/lib/vault";

// ─── Status metadata ──────────────────────────────────────────────────────────

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

// ─── ProjectNodeItem ──────────────────────────────────────────────────────────

export function ProjectNodeItem({
	node,
	depth = 0,
}: {
	node: ProjectNode;
	depth?: number;
}) {
	const [open, setOpen] = useState(false);
	const hasContent = node.isFolder
		? !!(node.children && node.children.length > 0)
		: !!node.content?.trim();

	return (
		<div>
			<button
				type="button"
				onClick={() => hasContent && setOpen((v) => !v)}
				tabIndex={hasContent ? undefined : -1}
				aria-disabled={!hasContent}
				aria-expanded={hasContent ? open : false}
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
				<PrivacyMask inline className="text-xs text-foreground/70 truncate">
					{node.name}
				</PrivacyMask>
			</button>
			{open && node.isFolder && node.children && (
				<div>
					{node.children.map((child) => (
						<ProjectNodeItem key={child.path} node={child} depth={depth + 1} />
					))}
				</div>
			)}
			{open && !node.isFolder && node.content?.trim() && (
				<div
					className="text-xs text-foreground/70 leading-relaxed border-l border-border/50 py-2 pr-2"
					style={{ marginLeft: `${depth * 14 + 12}px`, paddingLeft: "8px" }}
				>
					<PrivacyMask>
						<MarkdownBody content={node.content} />
					</PrivacyMask>
				</div>
			)}
		</div>
	);
}

// ─── ProjectCard ──────────────────────────────────────────────────────────────

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
				tabIndex={hasContent ? undefined : -1}
				aria-expanded={hasContent ? open : false}
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
					<PrivacyMask>
						<MarkdownBody content={project.content} />
					</PrivacyMask>
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

// ─── ProjectGroup ─────────────────────────────────────────────────────────────

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

// ─── ProjectsTab ──────────────────────────────────────────────────────────────

export function ProjectsTab({
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
