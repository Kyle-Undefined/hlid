import { ChevronRight, FileDiff } from "lucide-react";
import { useState } from "react";
import { ObsidianOpenButton } from "#/components/ObsidianOpenButton";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { ToolEventMessage } from "#/server/protocol";
import {
	obsidianVaultChanges,
	type ObsidianVaultChange as ParsedObsidianVaultChange,
	type VaultChangeKind,
} from "./obsidianVaultChanges";

// fallow-ignore-next-line unused-export -- preserve the existing parser import surface for tests and downstream callers.
export { obsidianVaultChanges };
export type ObsidianVaultChange = ParsedObsidianVaultChange;

function changeLabel(kind: VaultChangeKind): string {
	switch (kind) {
		case "created":
			return "Created";
		case "appended":
			return "Appended";
		case "prepended":
			return "Prepended";
		case "replaced":
			return "Replaced";
		case "patched":
			return "Patched";
		case "moved":
			return "Moved";
		case "renamed":
			return "Renamed";
		case "trashed":
			return "Trashed";
		case "base":
			return "Base item";
		case "task":
			return "Task";
		case "property-set":
			return "Property";
		case "property-remove":
			return "Property";
		case "command":
			return "Command";
	}
}

function changedContentPreview(content: string, prefix: "+" | "-"): string {
	const bounded =
		content.length > 1_200 ? `${content.slice(0, 1_200)}\n…` : content;
	return bounded
		.split("\n")
		.map((line) => `${prefix} ${line}`)
		.join("\n");
}

function ActiveNoteContext({ label, path }: { label: string; path: string }) {
	return (
		<div className="flex min-w-0 items-center gap-1.5">
			<span className="shrink-0">{label}</span>
			<PrivacyMask className="min-w-0 truncate font-mono text-primary/65">
				{path}
			</PrivacyMask>
			<ObsidianOpenButton relativePath={path} />
		</div>
	);
}

function CommandChangeDetails({ change }: { change: ObsidianVaultChange }) {
	const sameActiveNote =
		change.activeBefore &&
		change.activeBefore === change.activeAfter &&
		change.activeBefore;
	return (
		<div className="mt-1 space-y-0.5 text-[9px] text-muted-foreground/55">
			{sameActiveNote ? (
				<ActiveNoteContext label="Active note when run" path={sameActiveNote} />
			) : (
				<>
					{change.activeBefore && (
						<ActiveNoteContext
							label="Active before"
							path={change.activeBefore}
						/>
					)}
					{change.activeAfter && (
						<ActiveNoteContext label="Active after" path={change.activeAfter} />
					)}
				</>
			)}
			{!change.activeBefore && !change.activeAfter && (
				<p>Active-note context unavailable</p>
			)}
			<p className="text-muted-foreground/45">
				Commands may affect other vault files.
			</p>
		</div>
	);
}

function ChangedContent({
	content,
	prefix,
}: {
	content: string;
	prefix: "+" | "-";
}) {
	const removed = prefix === "-";
	return (
		<PrivacyMask
			className={`mt-1 ml-16 max-h-28 overflow-auto whitespace-pre-wrap border-l pl-2 font-mono text-[10px] leading-relaxed ${
				removed
					? "border-red-600/25 text-red-700/70 dark:text-red-400/60"
					: "border-green-600/25 text-green-700/70 dark:text-green-400/60"
			}`}
		>
			{changedContentPreview(content, prefix)}
		</PrivacyMask>
	);
}

function VaultChangeRow({ change }: { change: ObsidianVaultChange }) {
	return (
		<div className="min-w-0 text-[11px]">
			<div className="flex min-w-0 items-start gap-2">
				<span className="w-14 shrink-0 text-[9px] font-medium tracking-wider text-muted-foreground/60 uppercase">
					{changeLabel(change.kind)}
				</span>
				<div className="min-w-0 flex-1">
					<PrivacyMask className="font-mono text-primary/75">
						{change.commandId ??
							change.summary ??
							(change.from ? `${change.from} → ${change.path}` : change.path)}
					</PrivacyMask>
					{change.kind === "command" && (
						<CommandChangeDetails change={change} />
					)}
				</div>
				{change.path && change.kind !== "trashed" && (
					<ObsidianOpenButton relativePath={change.path} />
				)}
			</div>
			{change.previousContent && (
				<ChangedContent content={change.previousContent} prefix="-" />
			)}
			{change.content && <ChangedContent content={change.content} prefix="+" />}
		</div>
	);
}

export function ObsidianVaultChangeReview({
	toolEvents,
}: {
	toolEvents: ToolEventMessage[];
}) {
	const [open, setOpen] = useState(false);
	const changes = obsidianVaultChanges(toolEvents);
	if (changes.length === 0) return null;
	const hasFileChanges = changes.some((change) => Boolean(change.path));

	return (
		<div className="mx-3 my-1.5 min-w-0 border border-primary/15 bg-primary/[0.02]">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				aria-label={`Vault activity, ${changes.length}`}
				className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-primary/[0.04]"
			>
				<ChevronRight
					className={`h-3 w-3 shrink-0 text-primary/50 transition-transform ${open ? "rotate-90" : ""}`}
				/>
				<FileDiff className="h-3 w-3 shrink-0 text-primary/60" />
				<span className="text-[10px] font-medium tracking-wider text-primary/70 uppercase">
					Vault activity
				</span>
				<span className="text-[10px] text-muted-foreground/55 tabular-nums">
					{changes.length}
				</span>
			</button>
			{open && (
				<div className="border-t border-primary/10 px-3 py-2 space-y-2">
					{changes.map((change) => (
						<VaultChangeRow key={change.id} change={change} />
					))}
					{hasFileChanges && (
						<p className="pl-16 text-[9px] text-muted-foreground/45">
							Use Obsidian for full history and recovery options.
						</p>
					)}
				</div>
			)}
		</div>
	);
}
