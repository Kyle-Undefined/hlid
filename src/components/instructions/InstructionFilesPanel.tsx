import { ChevronDown, ChevronRight, FileText } from "lucide-react";
import { useState } from "react";
import { MarkdownBody } from "#/components/MarkdownBody";
import { PrivacyMask } from "#/components/PrivacyMask";
import type {
	InstructionFileDocument,
	InstructionFileTarget,
} from "#/lib/instructionFileTypes";
import {
	readInstructionFileFn,
	writeInstructionFileFn,
} from "#/lib/serverFns/instructionFiles";

function formatSize(bytes: number | null): string {
	if (bytes === null) return "missing";
	if (bytes < 1024) return `${bytes} B`;
	return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
}

function providerLabel(provider: InstructionFileTarget["provider"]): string {
	return provider === "codex" ? "Codex" : "Claude";
}

function InstructionFileRow({
	target,
	onUpdated,
}: {
	target: InstructionFileTarget;
	onUpdated?: (target: InstructionFileTarget) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const [document, setDocument] = useState<InstructionFileDocument | null>(
		null,
	);
	const [draft, setDraft] = useState("");
	const [editing, setEditing] = useState(false);
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<string | null>(null);

	async function open() {
		if (expanded) {
			setExpanded(false);
			return;
		}
		setExpanded(true);
		if (document || !target.writable) return;
		setBusy(true);
		setStatus(null);
		try {
			const loaded = await readInstructionFileFn({ data: target.id });
			setDocument(loaded);
			setDraft(loaded.content);
			if (!loaded.exists) setEditing(true);
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "Unable to read file");
		} finally {
			setBusy(false);
		}
	}

	async function save() {
		if (!document) return;
		setBusy(true);
		setStatus(null);
		try {
			const saved = await writeInstructionFileFn({
				data: {
					id: target.id,
					content: draft,
					expectedRevision: document.revision,
				},
			});
			setDocument(saved);
			setDraft(saved.content);
			setEditing(false);
			setStatus("Saved. Reload active provider sessions to use the change.");
			onUpdated?.(saved);
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "Unable to save file");
		} finally {
			setBusy(false);
		}
	}

	const current = document ?? target;
	const accessibleName = `${target.filename} · ${target.scopeLabel} · ${target.environmentLabel}`;

	return (
		<div>
			<div className="flex items-center gap-3 px-4 py-3">
				<button
					type="button"
					onClick={() => void open()}
					disabled={!target.writable || busy}
					aria-expanded={expanded}
					aria-label={`${expanded ? "Collapse" : "Expand"} ${accessibleName}`}
					className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default"
				>
					<span className="text-muted-foreground/50">
						{expanded ? (
							<ChevronDown className="h-3.5 w-3.5" />
						) : (
							<ChevronRight className="h-3.5 w-3.5" />
						)}
					</span>
					<FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-2">
							<span className="font-mono text-xs text-foreground">
								{target.filename}
							</span>
							<span className="border border-border/70 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">
								{providerLabel(target.provider)}
							</span>
							<span className="text-[9px] text-muted-foreground/60">
								{formatSize(current.size)}
							</span>
						</div>
						<PrivacyMask className="mt-0.5 truncate font-mono text-[9px] text-muted-foreground/40">
							{target.path}
						</PrivacyMask>
						{target.error && (
							<div className="mt-0.5 text-[9px] text-destructive/70">
								{target.error}
							</div>
						)}
					</div>
				</button>
				{target.writable && !expanded && (
					<button
						type="button"
						onClick={() => void open()}
						className="shrink-0 px-2 py-1 text-[9px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
					>
						{target.exists ? "Open" : "Create"}
					</button>
				)}
			</div>

			{expanded && (
				<div className="space-y-3 border-t border-border/50 bg-secondary/20 px-4 py-4">
					{busy && !document ? (
						<div className="text-xs text-muted-foreground">Loading…</div>
					) : editing && document ? (
						<>
							<textarea
								aria-label={`Edit ${accessibleName}`}
								spellCheck={false}
								value={draft}
								onChange={(event) => setDraft(event.target.value)}
								className="min-h-72 w-full resize-y border border-border bg-background p-3 font-mono text-xs text-foreground focus:border-primary/50 focus:outline-none"
							/>
							<div className="flex flex-wrap items-center gap-2">
								<button
									type="button"
									disabled={busy}
									onClick={() => void save()}
									className="border border-primary/40 px-3 py-1.5 text-[10px] uppercase tracking-widest text-primary hover:bg-primary/10 disabled:opacity-40"
								>
									{busy ? "Saving…" : "Save"}
								</button>
								<button
									type="button"
									disabled={busy}
									onClick={() => {
										setDraft(document.content);
										setEditing(false);
										setStatus(null);
									}}
									className="px-3 py-1.5 text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground disabled:opacity-40"
								>
									Cancel
								</button>
							</div>
						</>
					) : document ? (
						<>
							<div className="max-h-96 overflow-auto text-xs leading-relaxed text-foreground/80">
								<PrivacyMask>
									{document.content ? (
										<MarkdownBody content={document.content} />
									) : (
										<span className="text-muted-foreground">Empty file</span>
									)}
								</PrivacyMask>
							</div>
							<button
								type="button"
								onClick={() => {
									setEditing(true);
									setStatus(null);
								}}
								className="border border-border px-3 py-1.5 text-[10px] uppercase tracking-widest text-muted-foreground hover:bg-accent hover:text-foreground"
							>
								Edit
							</button>
						</>
					) : null}
					{status && (
						<div className="text-xs text-muted-foreground">{status}</div>
					)}
				</div>
			)}
		</div>
	);
}

export function InstructionFilesPanel({
	targets,
	onUpdated,
}: {
	targets: InstructionFileTarget[];
	onUpdated?: (target: InstructionFileTarget) => void;
}) {
	let priorGroup = "";
	return (
		<>
			{targets.map((target) => {
				const group = `${target.scopeLabel}\0${target.environmentLabel}`;
				const showGroup = group !== priorGroup;
				priorGroup = group;
				return (
					<div key={target.id}>
						{showGroup && (
							<div className="border-b border-border/50 bg-secondary/20 px-4 py-2 text-[9px] uppercase tracking-widest text-muted-foreground/60">
								{target.scopeLabel} · {target.environmentLabel}
							</div>
						)}
						<InstructionFileRow target={target} onUpdated={onUpdated} />
					</div>
				);
			})}
		</>
	);
}
