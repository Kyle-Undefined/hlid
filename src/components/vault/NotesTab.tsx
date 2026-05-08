import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import { useState } from "react";
import { MarkdownBody } from "#/components/MarkdownBody";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { FolderGroup, MemoryFile } from "#/lib/vault";
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
				className="w-full flex items-center gap-3 px-4 py-3 hover:bg-accent transition-colors text-left"
			>
				{open ? (
					<ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
				) : (
					<ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
				)}
				<div className="min-w-0">
					<PrivacyMask className="text-sm text-foreground truncate">
						{file.name}
					</PrivacyMask>
					<PrivacyMask className="text-[10px] tracking-wider text-muted-foreground font-mono truncate mt-0.5">
						{file.path}
					</PrivacyMask>
				</div>
			</button>
			{open && (
				<div className="px-6 py-4 bg-secondary/30 text-xs text-foreground/80 leading-relaxed">
					<PrivacyMask>
						<MarkdownBody content={file.content} />
					</PrivacyMask>
				</div>
			)}
		</div>
	);
}

// ─── FolderGroupsTab ─────────────────────────────────────────────────────────

export function FolderGroupsTab({
	groups,
	emptyLabel,
}: {
	groups: FolderGroup[];
	emptyLabel?: string;
}) {
	if (groups.length === 0) {
		return (
			<div className="border border-border bg-card px-4 py-8 text-center">
				<p className="text-xs tracking-wider text-muted-foreground">
					{emptyLabel ?? "nothing here yet"}
				</p>
			</div>
		);
	}
	return (
		<div className="space-y-6">
			{groups.map((g) => (
				<div key={g.name || "__root__"} className="space-y-2">
					<div className="flex items-center gap-2">
						<Folder className="w-3 h-3 text-muted-foreground/60 shrink-0" />
						<PrivacyMask
							inline
							className="text-[10px] tracking-widest text-muted-foreground uppercase"
						>
							{g.name || "ROOT"}
						</PrivacyMask>
						<span className="text-[10px] text-muted-foreground/50">
							{g.children.length}
						</span>
					</div>
					{g.children.length > 0 ? (
						<div className="border border-border bg-card px-3 py-2">
							{g.children.map((child) => (
								<ProjectNodeItem key={child.path} node={child} />
							))}
						</div>
					) : (
						<div className="border border-border bg-card px-4 py-3 text-[11px] tracking-wider text-muted-foreground/60">
							empty
						</div>
					)}
				</div>
			))}
		</div>
	);
}

// ─── NotesTab ─────────────────────────────────────────────────────────────────

export function NotesTab({
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
