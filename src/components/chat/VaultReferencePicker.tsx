import {
	Archive,
	ArrowLeft,
	Eye,
	FileCode2,
	FileText,
	ImageIcon,
	LoaderCircle,
	Plus,
	X,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { ObsidianOpenButton } from "#/components/ObsidianOpenButton";
import { RelicPreview } from "#/components/relics/RelicPreview";
import type { ComposerReferenceSource } from "#/hooks/useVaultReferencePicker";
import type {
	ComposerReferenceItem,
	RelicReferenceItem,
	VaultReferenceItem,
	VaultReferencePreview,
	WorkspaceReferencePreview,
	WorkspaceReferenceSelection,
} from "#/lib/vaultReferences";

export function VaultReferenceBadges({
	references,
	onRemove,
}: {
	references: VaultReferenceItem[];
	onRemove: (relativePath: string) => void;
}) {
	if (references.length === 0) return null;
	return (
		<div className="flex flex-wrap gap-1.5 border-b border-primary/20 bg-primary/5 px-3 py-2">
			{references.map((reference) => (
				<div
					key={reference.relativePath}
					className="flex min-w-0 max-w-full items-center gap-1.5 border border-primary/25 bg-background/70 px-2 py-1 text-primary/80"
					title={reference.relativePath}
				>
					<FileText className="h-3 w-3 shrink-0" />
					<span className="min-w-0 truncate font-mono text-[10px]">
						@{reference.relativePath}
					</span>
					<ObsidianOpenButton relativePath={reference.relativePath} />
					<button
						type="button"
						onClick={() => onRemove(reference.relativePath)}
						className="shrink-0 text-primary/45 transition-colors hover:text-primary"
						aria-label={`Remove vault reference ${reference.relativePath}`}
					>
						<X className="h-3 w-3" />
					</button>
				</div>
			))}
		</div>
	);
}

export function WorkspaceReferenceBadges({
	references,
	onRemove,
}: {
	references: WorkspaceReferenceSelection[];
	onRemove: (relativePath: string) => void;
}) {
	if (references.length === 0) return null;
	return (
		<div className="flex flex-wrap gap-1.5 border-b border-sky-500/20 bg-sky-500/5 px-3 py-2">
			{references.map((reference) => (
				<div
					key={reference.relativePath}
					className="flex min-w-0 max-w-full items-center gap-1.5 border border-sky-500/25 bg-background/70 px-2 py-1 text-sky-500/80"
					title={`${reference.relativePath} · ${reference.environmentLabel} · sha256:${reference.sha256}`}
				>
					{reference.previewKind === "image" ? (
						<ImageIcon className="h-3 w-3 shrink-0" />
					) : (
						<FileCode2 className="h-3 w-3 shrink-0" />
					)}
					<span className="min-w-0 truncate font-mono text-[10px]">
						@{reference.relativePath}
					</span>
					<button
						type="button"
						onClick={() => onRemove(reference.relativePath)}
						className="shrink-0 text-sky-500/45 transition-colors hover:text-sky-500"
						aria-label={`Remove workspace reference ${reference.relativePath}`}
					>
						<X className="h-3 w-3" />
					</button>
				</div>
			))}
		</div>
	);
}

export function VaultReferencePicker({
	rootLabel,
	workspaceRootLabel,
	workspaceEnvironmentLabel,
	query,
	items,
	selectedIndex,
	loading,
	error,
	vaultTotal,
	relicTotal,
	workspaceTotal,
	workspaceAvailable,
	activeSource,
	truncated,
	workspacePreview,
	vaultPreview,
	relicPreview,
	previewLoading,
	previewError,
	workspaceSelectionLoading,
	onSelect,
	onPreviewReference,
	onSourceChange,
	onConfirmReference,
	onCancelReferencePreview,
	direction = "down",
}: {
	rootLabel: string;
	workspaceRootLabel: string;
	workspaceEnvironmentLabel: string;
	query: string;
	items: ComposerReferenceItem[];
	selectedIndex: number;
	loading: boolean;
	error: string | null;
	vaultTotal: number;
	relicTotal: number;
	workspaceTotal: number;
	workspaceAvailable: boolean;
	activeSource: ComposerReferenceSource;
	truncated: boolean;
	workspacePreview: WorkspaceReferencePreview | null;
	vaultPreview: VaultReferencePreview | null;
	relicPreview: RelicReferenceItem | null;
	previewLoading: boolean;
	previewError: string | null;
	workspaceSelectionLoading: string | null;
	onSelect: (reference: ComposerReferenceItem) => void;
	onPreviewReference: (reference: ComposerReferenceItem) => void;
	onSourceChange: (source: ComposerReferenceSource) => void;
	onConfirmReference: () => void;
	onCancelReferencePreview: () => void;
	direction?: "up" | "down";
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: selectedIndex triggers scrolling the newly highlighted option into view
	useEffect(() => {
		containerRef.current
			?.querySelector<HTMLElement>("[aria-selected='true']")
			?.scrollIntoView?.({ block: "nearest" });
	}, [selectedIndex]);

	return (
		<div
			ref={containerRef}
			id="vault-reference-picker"
			role="listbox"
			aria-label="Vault, workspace, and Relic references"
			className={`absolute ${direction === "up" ? "bottom-full" : "top-full"} left-0 right-0 z-50 flex max-h-[min(28rem,70vh)] min-w-0 flex-col overflow-hidden border border-border bg-card shadow-lg`}
		>
			<div className="z-10 flex items-center justify-between gap-3 border-b border-border bg-card px-3 py-2">
				<div className="min-w-0">
					<div className="truncate text-[9px] font-bold tracking-widest text-primary/65 uppercase">
						@ References
					</div>
					<div className="truncate text-[9px] text-muted-foreground/50">
						{query
							? `matching “${query}”`
							: activeSource === "vault"
								? rootLabel
								: activeSource === "workspace"
									? `${workspaceRootLabel} · ${workspaceEnvironmentLabel}`
									: "recent retained and ephemeral files"}
					</div>
				</div>
				<span className="shrink-0 text-[8px] tracking-widest text-muted-foreground/35 uppercase">
					{loading ? "searching" : `${items.length} shown`}
				</span>
			</div>
			<div
				role="tablist"
				aria-label="Reference source"
				className="flex shrink-0 border-b border-border bg-muted/10 px-2"
			>
				{(
					[
						["vault", "Vault", vaultTotal],
						...(workspaceAvailable
							? ([["workspace", "Workspace", workspaceTotal]] as const)
							: []),
						["relic", "Relics", relicTotal],
					] as const
				).map(([source, label, count]) => (
					<button
						key={source}
						type="button"
						role="tab"
						aria-selected={activeSource === source}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => onSourceChange(source)}
						className={`border-b px-2.5 py-1.5 text-[8px] font-bold tracking-widest uppercase transition-colors ${
							activeSource === source
								? "border-primary text-primary/80"
								: "border-transparent text-muted-foreground/40 hover:text-muted-foreground/70"
						}`}
					>
						{label} · {count}
					</button>
				))}
			</div>
			{previewLoading ? (
				<div className="flex min-h-32 items-center justify-center gap-2 px-3 py-6 text-[10px] text-muted-foreground/55">
					<LoaderCircle className="h-3.5 w-3.5 animate-spin" />
					Reading workspace file
				</div>
			) : workspacePreview ? (
				<div className="flex min-h-0 flex-1 flex-col">
					<div className="flex items-center justify-between gap-3 border-b border-border/70 px-3 py-2">
						<div className="min-w-0">
							<div className="truncate font-mono text-[10px] text-foreground/85">
								{workspacePreview.relativePath}
							</div>
							<div className="truncate text-[8px] tracking-wide text-muted-foreground/45">
								{workspacePreview.environmentLabel} ·{" "}
								{workspacePreview.sizeBytes.toLocaleString()} bytes · sha256:
								{workspacePreview.sha256.slice(0, 12)}
							</div>
						</div>
						<button
							type="button"
							onMouseDown={(event) => event.preventDefault()}
							onClick={onCancelReferencePreview}
							className="flex shrink-0 items-center gap-1 text-[8px] tracking-widest text-muted-foreground/45 uppercase hover:text-muted-foreground/75"
						>
							<ArrowLeft className="h-3 w-3" />
							Back
						</button>
					</div>
					{workspacePreview.previewKind === "text" ? (
						<pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-background/50 px-3 py-2 font-mono text-[10px] leading-relaxed text-foreground/75">
							{workspacePreview.content}
						</pre>
					) : (
						<div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[repeating-conic-gradient(hsl(var(--muted))_0_25%,transparent_0_50%)_50%/12px_12px] p-3">
							<img
								src={workspacePreview.dataUrl}
								alt={`Preview of ${workspacePreview.relativePath}`}
								className="max-h-80 max-w-full object-contain shadow-sm"
							/>
						</div>
					)}
					<div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2">
						<span className="text-[8px] text-muted-foreground/45">
							{workspacePreview.previewKind === "text" &&
							workspacePreview.truncated
								? "Preview truncated. The exact file path will be referenced."
								: workspacePreview.previewKind === "image"
									? `Exact ${workspacePreview.mime} preview`
									: "Exact UTF-8 text preview"}
						</span>
						<button
							type="button"
							onMouseDown={(event) => event.preventDefault()}
							onClick={onConfirmReference}
							className="flex items-center gap-1.5 border border-sky-500/30 bg-sky-500/10 px-2.5 py-1.5 text-[8px] font-bold tracking-widest text-sky-500/85 uppercase hover:bg-sky-500/15"
						>
							<Plus className="h-3 w-3" />
							Add reference
						</button>
					</div>
				</div>
			) : vaultPreview ? (
				<div className="flex min-h-0 flex-1 flex-col">
					<div className="flex items-center justify-between gap-3 border-b border-border/70 px-3 py-2">
						<div className="min-w-0">
							<div className="truncate font-mono text-[10px] text-foreground/85">
								{vaultPreview.relativePath}
							</div>
							<div className="truncate text-[8px] tracking-wide text-muted-foreground/45">
								Vault · {rootLabel}
							</div>
						</div>
						<button
							type="button"
							onMouseDown={(event) => event.preventDefault()}
							onClick={onCancelReferencePreview}
							className="flex shrink-0 items-center gap-1 text-[8px] tracking-widest text-muted-foreground/45 uppercase hover:text-muted-foreground/75"
						>
							<ArrowLeft className="h-3 w-3" />
							Back
						</button>
					</div>
					<pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-background/50 px-3 py-2 font-mono text-[10px] leading-relaxed text-foreground/75">
						{vaultPreview.content}
					</pre>
					<div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2">
						<span className="text-[8px] text-muted-foreground/45">
							{vaultPreview.truncated
								? "Preview truncated. The exact note will be referenced."
								: "Exact Obsidian note preview"}
						</span>
						<button
							type="button"
							onMouseDown={(event) => event.preventDefault()}
							onClick={onConfirmReference}
							className="flex items-center gap-1.5 border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-[8px] font-bold tracking-widest text-primary/85 uppercase hover:bg-primary/15"
						>
							<Plus className="h-3 w-3" />
							Add reference
						</button>
					</div>
				</div>
			) : relicPreview ? (
				<div className="flex min-h-0 flex-1 flex-col">
					<div className="flex items-center justify-between gap-3 border-b border-border/70 px-3 py-2">
						<div className="min-w-0">
							<div className="truncate font-mono text-[10px] text-foreground/85">
								{relicPreview.filename}
							</div>
							<div className="truncate text-[8px] tracking-wide text-muted-foreground/45">
								{relicPreview.category} · {relicPreview.mime}
							</div>
						</div>
						<button
							type="button"
							onMouseDown={(event) => event.preventDefault()}
							onClick={onCancelReferencePreview}
							className="flex shrink-0 items-center gap-1 text-[8px] tracking-widest text-muted-foreground/45 uppercase hover:text-muted-foreground/75"
						>
							<ArrowLeft className="h-3 w-3" />
							Back
						</button>
					</div>
					<div className="min-h-0 flex-1 overflow-auto bg-background/50 px-3 py-3">
						<RelicPreview id={relicPreview.id} mime={relicPreview.mime} />
					</div>
					<div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2">
						<span className="text-[8px] text-muted-foreground/45">
							Existing Relic preview
						</span>
						<button
							type="button"
							onMouseDown={(event) => event.preventDefault()}
							onClick={onConfirmReference}
							className="flex items-center gap-1.5 border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[8px] font-bold tracking-widest text-amber-500/85 uppercase hover:bg-amber-500/15"
						>
							<Plus className="h-3 w-3" />
							Add reference
						</button>
					</div>
				</div>
			) : (
				<div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
					{error || previewError ? (
						<div className="px-3 py-3 text-[10px] text-destructive/75">
							{previewError ?? error}
						</div>
					) : !loading && items.length === 0 ? (
						<div className="px-3 py-3 text-[10px] text-muted-foreground/55">
							No {activeSource} references found
							{query ? " for this search" : ""}.
						</div>
					) : (
						items.map((item, index) => {
							const isVault = item.source === "vault";
							const isWorkspace = item.source === "workspace";
							return (
								<div
									key={
										item.source === "relic"
											? `relic:${item.id}`
											: `${item.source}:${item.relativePath}`
									}
									id={`vault-reference-picker-opt-${index}`}
									role="option"
									aria-selected={index === selectedIndex}
									tabIndex={-1}
									onMouseDown={(event) => event.preventDefault()}
									onClick={() => onSelect(item)}
									onKeyDown={(event) => {
										if (event.key === "Enter" || event.key === " ") {
											event.preventDefault();
											onSelect(item);
										}
									}}
									className={`flex min-w-0 cursor-pointer items-center gap-2 px-3 py-2 text-left transition-colors select-none ${index === selectedIndex ? "bg-primary/10" : "hover:bg-primary/5"}`}
								>
									{workspaceSelectionLoading ===
									(item.source === "workspace"
										? item.relativePath
										: undefined) ? (
										<LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-sky-500/65" />
									) : isVault ? (
										<FileText className="h-3.5 w-3.5 shrink-0 text-primary/55" />
									) : isWorkspace ? (
										<FileCode2 className="h-3.5 w-3.5 shrink-0 text-sky-500/65" />
									) : (
										<Archive className="h-3.5 w-3.5 shrink-0 text-amber-500/65" />
									)}
									<div className="min-w-0 flex-1">
										<div className="truncate font-mono text-[11px] text-foreground/85">
											{item.source === "relic" ? item.filename : item.name}
										</div>
										<div className="truncate font-mono text-[9px] text-muted-foreground/45">
											{item.source === "relic"
												? `${item.category} · ${item.mime}`
												: item.relativePath}
										</div>
									</div>
									<button
										type="button"
										onMouseDown={(event) => event.preventDefault()}
										onClick={(event) => {
											event.stopPropagation();
											onPreviewReference(item);
										}}
										className={`shrink-0 p-1 transition-colors ${
											item.source === "vault"
												? "text-primary/45 hover:text-primary"
												: item.source === "workspace"
													? "text-sky-500/45 hover:text-sky-500"
													: "text-amber-500/45 hover:text-amber-500"
										}`}
										aria-label={`Preview ${
											item.source === "relic"
												? `Relic ${item.filename}`
												: `${item.source} file ${item.relativePath}`
										}`}
										title="Preview"
									>
										<Eye className="h-3.5 w-3.5" />
									</button>
								</div>
							);
						})
					)}
				</div>
			)}
			{truncated && !loading && (
				<div className="shrink-0 border-t border-border px-3 py-1.5 text-[8px] tracking-wider text-muted-foreground/35 uppercase">
					Type more to narrow the results
				</div>
			)}
		</div>
	);
}
