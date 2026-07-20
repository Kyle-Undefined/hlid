import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import { useMemo, useState } from "react";
import { MarkdownBody } from "#/components/MarkdownBody";
import { ObsidianOpenButton } from "#/components/ObsidianOpenButton";
import { PrivacyMask } from "#/components/PrivacyMask";
import { Section } from "#/components/shell/Section";
import {
	ROW_BUTTON,
	ROW_EXPANDED,
	ROW_EXPANDED_INNER,
	RowChevron,
} from "#/components/vault/row";
import { VaultEmptyState } from "#/components/vault/VaultEmptyState";
import type { ProjectStatus } from "#/lib/classify";
import type { Project, ProjectNode } from "#/lib/vault";
import { matchesQuery } from "#/lib/vaultSearch";

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
					{node.vaultRelativePath && (
						<ObsidianOpenButton
							relativePath={node.vaultRelativePath}
							labeled
							className="mt-3 text-[9px] tracking-widest uppercase"
						/>
					)}
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
				className={`${ROW_BUTTON} ${
					hasContent ? "hover:bg-accent cursor-pointer" : "cursor-default"
				}`}
			>
				<RowChevron open={open} visible={hasContent} />
				<div className="min-w-0 flex-1">
					<PrivacyMask inline className="text-sm text-foreground break-words">
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
				<div className={ROW_EXPANDED}>
					<div className={ROW_EXPANDED_INNER}>
						<PrivacyMask>
							<MarkdownBody content={project.content} />
						</PrivacyMask>
						{project.vaultRelativePath && (
							<ObsidianOpenButton
								relativePath={project.vaultRelativePath}
								labeled
								className="mt-3 text-[9px] tracking-widest uppercase"
							/>
						)}
					</div>
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
		<Section
			title={STATUS_LABEL[status]}
			adornment={
				<span
					className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[status]}`}
				/>
			}
			count={projects.length}
		>
			{projects.map((p) => (
				<ProjectCard key={p.file} project={p} />
			))}
		</Section>
	);
}

// ─── ProjectsTab ──────────────────────────────────────────────────────────────

export function ProjectsTab({
	initial,
	emptyLabel,
	query = "",
}: {
	initial: Project[];
	emptyLabel?: string;
	query?: string;
}) {
	const filtered = useMemo(
		() =>
			initial.filter((p) =>
				matchesQuery(query, p.title, p.file, p.rawStatus, p.tags),
			),
		[initial, query],
	);

	if (initial.length === 0) {
		return (
			<VaultEmptyState>
				{emptyLabel ?? "no projects found, set a projects folder in config"}
			</VaultEmptyState>
		);
	}

	if (filtered.length === 0) {
		return <VaultEmptyState>no matches for “{query.trim()}”</VaultEmptyState>;
	}

	const grouped = STATUS_ORDER.reduce(
		(acc, s) => {
			acc[s] = filtered.filter((p) => p.status === s);
			return acc;
		},
		{} as Record<ProjectStatus, Project[]>,
	);

	return (
		<div className="space-y-6">
			{STATUS_ORDER.map((s) => (
				<ProjectGroup key={s} status={s} projects={grouped[s]} />
			))}
		</div>
	);
}
