import { Folder } from "lucide-react";
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
import type { FolderGroup, MemoryFile, ProjectNode } from "#/lib/vault";
import { matchesQuery } from "#/lib/vaultSearch";
import { ProjectNodeItem } from "./ProjectsTab";

// ─── MemoryCard ───────────────────────────────────────────────────────────────

function MemoryCard({ file }: { file: MemoryFile }) {
	const [open, setOpen] = useState(false);

	return (
		<div className="divide-y divide-border">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				aria-label={open ? `Collapse ${file.name}` : `Expand ${file.name}`}
				className={`${ROW_BUTTON} hover:bg-accent cursor-pointer`}
			>
				<RowChevron open={open} />
				<div className="min-w-0 flex-1">
					<PrivacyMask className="text-sm text-foreground break-words">
						{file.name}
					</PrivacyMask>
					<PrivacyMask className="text-[10px] tracking-wider text-muted-foreground font-mono truncate mt-0.5">
						{file.path}
					</PrivacyMask>
				</div>
			</button>
			{open && (
				<div className={ROW_EXPANDED}>
					<div className={ROW_EXPANDED_INNER}>
						<PrivacyMask>
							<MarkdownBody content={file.content} />
						</PrivacyMask>
						{file.vaultRelativePath && (
							<ObsidianOpenButton
								relativePath={file.vaultRelativePath}
								labeled
								className="mt-3 text-[9px] tracking-widest uppercase"
							/>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

// ─── FolderGroupsTab ─────────────────────────────────────────────────────────

function filterNodes(nodes: ProjectNode[], query: string): ProjectNode[] {
	if (!query.trim()) return nodes;
	const out: ProjectNode[] = [];
	for (const node of nodes) {
		if (matchesQuery(query, node.name)) {
			out.push(node);
			continue;
		}
		if (node.children) {
			const kids = filterNodes(node.children, query);
			if (kids.length > 0) out.push({ ...node, children: kids });
		}
	}
	return out;
}

export function FolderGroupsTab({
	groups,
	emptyLabel,
	query = "",
}: {
	groups: FolderGroup[];
	emptyLabel?: string;
	query?: string;
}) {
	const filtered = useMemo(() => {
		if (!query.trim()) return groups;
		return groups
			.map((g) =>
				matchesQuery(query, g.name)
					? g
					: { ...g, children: filterNodes(g.children, query) },
			)
			.filter((g) => g.children.length > 0);
	}, [groups, query]);

	if (groups.length === 0) {
		return (
			<VaultEmptyState>{emptyLabel ?? "nothing here yet"}</VaultEmptyState>
		);
	}

	if (filtered.length === 0) {
		return <VaultEmptyState>no matches for “{query.trim()}”</VaultEmptyState>;
	}

	return (
		<div className="space-y-6">
			{filtered.map((g) => (
				<Section
					key={g.name || "__root__"}
					title={<PrivacyMask inline>{g.name || "ROOT"}</PrivacyMask>}
					adornment={
						<Folder className="w-3 h-3 text-muted-foreground/60 shrink-0" />
					}
					count={g.children.length}
				>
					{g.children.length > 0 ? (
						<div className="px-3 py-2">
							{g.children.map((child) => (
								<ProjectNodeItem key={child.path} node={child} />
							))}
						</div>
					) : (
						<div className="px-4 py-3 text-[11px] tracking-wider text-muted-foreground/60">
							empty
						</div>
					)}
				</Section>
			))}
		</div>
	);
}

// ─── NotesTab ─────────────────────────────────────────────────────────────────

export function NotesTab({
	notes,
	emptyLabel,
	query = "",
}: {
	notes: MemoryFile[];
	emptyLabel?: string;
	query?: string;
}) {
	const filtered = useMemo(
		() => notes.filter((f) => matchesQuery(query, f.name, f.path)),
		[notes, query],
	);

	if (notes.length === 0) {
		return (
			<VaultEmptyState>{emptyLabel ?? "nothing here yet"}</VaultEmptyState>
		);
	}

	if (filtered.length === 0) {
		return <VaultEmptyState>no matches for “{query.trim()}”</VaultEmptyState>;
	}

	return (
		<Section>
			{filtered.map((f) => (
				<MemoryCard key={f.path} file={f} />
			))}
		</Section>
	);
}
