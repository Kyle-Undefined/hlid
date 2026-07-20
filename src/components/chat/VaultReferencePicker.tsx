import { Archive, FileText, X } from "lucide-react";
import { Fragment, useEffect, useRef } from "react";
import type {
	ComposerReferenceItem,
	VaultReferenceItem,
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

export function VaultReferencePicker({
	rootLabel,
	query,
	items,
	selectedIndex,
	loading,
	error,
	vaultTotal,
	relicTotal,
	truncated,
	onSelect,
	direction = "down",
}: {
	rootLabel: string;
	query: string;
	items: ComposerReferenceItem[];
	selectedIndex: number;
	loading: boolean;
	error: string | null;
	vaultTotal: number;
	relicTotal: number;
	truncated: boolean;
	onSelect: (reference: ComposerReferenceItem) => void;
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
			aria-label="Vault files and Relics"
			className={`absolute ${direction === "up" ? "bottom-full" : "top-full"} left-0 right-0 z-50 max-h-64 min-w-0 overflow-x-hidden overflow-y-auto border border-border bg-card shadow-lg`}
		>
			<div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-card px-3 py-2">
				<div className="min-w-0">
					<div className="truncate text-[9px] font-bold tracking-widest text-primary/65 uppercase">
						@ References
					</div>
					<div className="truncate text-[9px] text-muted-foreground/50">
						{query ? `matching “${query}”` : `${rootLabel} first, then Relics`}
					</div>
				</div>
				<span className="shrink-0 text-[8px] tracking-widest text-muted-foreground/35 uppercase">
					{loading
						? "searching"
						: `${vaultTotal} vault · ${relicTotal} relic${relicTotal === 1 ? "" : "s"}`}
				</span>
			</div>
			{error ? (
				<div className="px-3 py-3 text-[10px] text-destructive/75">{error}</div>
			) : !loading && items.length === 0 ? (
				<div className="px-3 py-3 text-[10px] text-muted-foreground/55">
					No Vault files or Relics found{query ? " for this search" : ""}.
				</div>
			) : (
				items.map((item, index) => {
					const startsGroup =
						index === 0 || items[index - 1]?.source !== item.source;
					const isVault = item.source === "vault";
					return (
						<Fragment
							key={isVault ? `vault:${item.relativePath}` : `relic:${item.id}`}
						>
							{startsGroup && (
								<div
									role="presentation"
									className="border-b border-border/60 bg-muted/20 px-3 py-1 text-[8px] font-bold tracking-widest text-muted-foreground/50 uppercase"
								>
									{isVault ? `Vault · ${rootLabel}` : "Relics · recent files"}
								</div>
							)}
							<div
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
								{isVault ? (
									<FileText className="h-3.5 w-3.5 shrink-0 text-primary/55" />
								) : (
									<Archive className="h-3.5 w-3.5 shrink-0 text-amber-500/65" />
								)}
								<div className="min-w-0 flex-1">
									<div className="truncate font-mono text-[11px] text-foreground/85">
										{isVault ? item.name : item.filename}
									</div>
									<div className="truncate font-mono text-[9px] text-muted-foreground/45">
										{isVault
											? item.relativePath
											: `${item.category} · ${item.mime}`}
									</div>
								</div>
							</div>
						</Fragment>
					);
				})
			)}
			{truncated && !loading && (
				<div className="border-t border-border px-3 py-1.5 text-[8px] tracking-wider text-muted-foreground/35 uppercase">
					Type more to narrow the results
				</div>
			)}
		</div>
	);
}
