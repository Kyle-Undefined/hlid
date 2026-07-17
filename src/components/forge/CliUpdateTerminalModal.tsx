import { X } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { TerminalView } from "#/components/TerminalView";
import { useDialogFocus } from "#/hooks/useDialogFocus";

export function CliUpdateTerminalModal({
	label,
	command,
	cwd,
	sessionId,
	initiallyCopied,
	onClose,
}: {
	label: string;
	command: string;
	cwd: string;
	sessionId: string;
	initiallyCopied: boolean;
	onClose: () => void;
}) {
	const { dialogRef, onDialogKeyDown } =
		useDialogFocus<HTMLDivElement>(onClose);
	const [copied, setCopied] = useState(initiallyCopied);

	async function copyCommand() {
		try {
			await navigator.clipboard.writeText(command);
			setCopied(true);
		} catch {
			setCopied(false);
		}
	}

	return createPortal(
		// biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled by the dialog
		// biome-ignore lint/a11y/noStaticElementInteractions: standard modal backdrop
		<div
			className="fixed inset-0 z-50 bg-background/90 backdrop-blur-sm flex items-center justify-center p-3 md:p-6"
			onClick={onClose}
		>
			<div
				ref={dialogRef}
				tabIndex={-1}
				role="dialog"
				aria-modal="true"
				aria-label={`${label} update terminal`}
				className="flex h-[82vh] w-[96vw] max-w-5xl flex-col overflow-hidden border border-border bg-card shadow-2xl focus:outline-none"
				onClick={(event) => event.stopPropagation()}
				onKeyDown={onDialogKeyDown}
			>
				<div className="flex items-center gap-3 border-b border-border px-4 py-2">
					<div className="min-w-0 flex-1">
						<div className="text-[10px] tracking-widest text-primary uppercase">
							{label} update terminal
						</div>
						<div className="truncate font-mono text-[9px] text-muted-foreground/60">
							{cwd}
						</div>
					</div>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close update terminal"
						className="p-1 text-muted-foreground hover:text-foreground transition-colors"
					>
						<X className="h-4 w-4" />
					</button>
				</div>

				<div className="flex flex-wrap items-center gap-2 border-b border-border/70 px-4 py-2">
					<code className="min-w-0 flex-1 select-all break-all text-[10px] text-primary/80">
						{command}
					</code>
					<button
						type="button"
						onClick={() => void copyCommand()}
						className="shrink-0 border border-primary/40 px-2.5 py-1 text-[9px] tracking-widest text-primary uppercase hover:bg-primary/10"
					>
						{copied ? "COPIED" : "COPY COMMAND"}
					</button>
				</div>

				<div className="min-h-0 flex-1 bg-[#0d0d0d]">
					<TerminalView
						sessionId={sessionId}
						cwd={cwd}
						active
						wsPath="/ws/shell"
						terminateOnDisconnect
					/>
				</div>
				<div className="border-t border-border px-4 py-2 text-[10px] text-muted-foreground">
					Paste the copied command into this terminal. Interactive sudo prompts
					stay here in Hlid; close this window when the update finishes, then
					select CHECK.
				</div>
			</div>
		</div>,
		document.body,
	);
}
