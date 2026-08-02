import { FileClock, LoaderCircle, RotateCcw, X } from "lucide-react";
import { createPortal } from "react-dom";
import { PrivacyMask } from "#/components/PrivacyMask";
import { useDialogFocus } from "#/hooks/useDialogFocus";
import type { FileRewindResultMessage } from "#/server/protocol";

export function FileRewindDialog({
	result,
	pending,
	onExecute,
	onClose,
}: {
	result: FileRewindResultMessage | null;
	pending: "preview" | "execute" | null;
	onExecute: () => void;
	onClose: () => void;
}) {
	const { dialogRef, onDialogKeyDown } = useDialogFocus<HTMLDivElement>(
		onClose,
		true,
		"dialog",
	);
	const completed = result?.action === "execute" && !result.error;
	const canExecute =
		result?.action === "preview" &&
		result.can_rewind &&
		Boolean(result.preview_id) &&
		pending === null;

	return createPortal(
		// biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled by the focused dialog
		// biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop pattern
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 p-3 backdrop-blur-sm sm:p-5"
			onClick={pending ? undefined : onClose}
		>
			<div
				ref={dialogRef}
				tabIndex={-1}
				role="dialog"
				aria-modal="true"
				aria-label="Claude file rewind"
				onClick={(event) => event.stopPropagation()}
				onKeyDown={onDialogKeyDown}
				className="flex max-h-[min(82vh,680px)] w-full max-w-xl flex-col overflow-hidden border border-border bg-background shadow-2xl outline-none"
			>
				<header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
					<FileClock className="h-4 w-4 text-primary/65" />
					<div className="min-w-0 flex-1">
						<h2 className="text-sm font-medium text-foreground/85">
							{completed ? "File rewind complete" : "Preview file rewind"}
						</h2>
						<p className="mt-0.5 text-[10px] text-muted-foreground/50">
							Claude checkpoint for this user turn
						</p>
					</div>
					<button
						type="button"
						onClick={onClose}
						disabled={pending !== null}
						aria-label="Close file rewind"
						className="p-1 text-muted-foreground/45 hover:text-foreground disabled:opacity-30"
					>
						<X className="h-4 w-4" />
					</button>
				</header>

				<div className="min-h-0 flex-1 overflow-y-auto p-4">
					{pending && !result ? (
						<div className="flex items-center gap-2 py-8 text-xs text-muted-foreground/60">
							<LoaderCircle className="h-4 w-4 animate-spin" />
							Inspecting Claude's tracked changes
						</div>
					) : result?.error ? (
						<div
							role="alert"
							className="border border-destructive/35 bg-destructive/5 p-3 text-xs text-destructive"
						>
							{result.error}
						</div>
					) : result ? (
						<div className="space-y-4">
							<div className="grid grid-cols-3 gap-2 text-center">
								<div className="border border-border/60 px-2 py-2">
									<div className="text-sm text-foreground/80">
										{result.files_changed.length}
									</div>
									<div className="text-[9px] uppercase tracking-widest text-muted-foreground/45">
										files
									</div>
								</div>
								<div className="border border-border/60 px-2 py-2">
									<div className="text-sm text-foreground/80">
										+{result.insertions}
									</div>
									<div className="text-[9px] uppercase tracking-widest text-muted-foreground/45">
										insertions
									</div>
								</div>
								<div className="border border-border/60 px-2 py-2">
									<div className="text-sm text-foreground/80">
										-{result.deletions}
									</div>
									<div className="text-[9px] uppercase tracking-widest text-muted-foreground/45">
										deletions
									</div>
								</div>
							</div>
							{result.files_changed.length > 0 ? (
								<div>
									<div className="mb-2 text-[9px] uppercase tracking-widest text-muted-foreground/50">
										Tracked files
									</div>
									<div className="max-h-56 overflow-y-auto border border-border/60 bg-card/25">
										{result.files_changed.map((file) => (
											<PrivacyMask
												key={file}
												className="border-b border-border/40 px-3 py-2 font-mono text-[10px] text-foreground/70 last:border-b-0"
											>
												{file}
											</PrivacyMask>
										))}
									</div>
								</div>
							) : (
								<p className="text-xs text-muted-foreground/60">
									Claude found no tracked file changes for this checkpoint.
								</p>
							)}
						</div>
					) : null}

					<div className="mt-4 border border-amber-500/25 bg-amber-500/5 p-3 text-[10px] leading-relaxed text-muted-foreground/65">
						Only changes made through Claude's Write, Edit, and NotebookEdit
						tools are tracked. Bash changes, directories, Git state, other tool
						side effects, and conversation history are not rewound.
					</div>
				</div>

				<footer className="flex shrink-0 justify-end gap-2 border-t border-border px-4 py-3">
					<button
						type="button"
						onClick={onClose}
						disabled={pending !== null}
						className="border border-border px-3 py-1.5 text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground disabled:opacity-40"
					>
						{completed ? "Done" : "Cancel"}
					</button>
					{canExecute && (
						<button
							type="button"
							onClick={onExecute}
							className="flex items-center gap-1.5 border border-destructive/55 bg-destructive/10 px-3 py-1.5 text-[10px] uppercase tracking-widest text-destructive hover:bg-destructive/15"
						>
							<RotateCcw className="h-3.5 w-3.5" />
							Rewind files
						</button>
					)}
					{pending === "execute" && (
						<div className="flex items-center gap-1.5 px-2 text-[10px] uppercase tracking-widest text-muted-foreground/60">
							<LoaderCircle className="h-3.5 w-3.5 animate-spin" />
							Rewinding
						</div>
					)}
				</footer>
			</div>
		</div>,
		document.body,
	);
}
