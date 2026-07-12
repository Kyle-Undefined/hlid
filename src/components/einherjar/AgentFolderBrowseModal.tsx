import { FolderBrowser } from "#/components/wizard/FolderBrowser";

/** Fullscreen folder-picker dialog for selecting an agent's directory. */
export function AgentFolderBrowseModal({
	initialPath,
	externalAllowed,
	onSelect,
	onClose,
}: {
	initialPath: string | undefined;
	externalAllowed: boolean;
	onSelect: (path: string) => void;
	onClose: () => void;
}) {
	return (
		<div className="fixed inset-0 z-50 bg-background/90 backdrop-blur-sm flex items-center justify-center p-4">
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="browse-agent-dialog-title"
				className="w-full max-w-md bg-card border border-border shadow-2xl p-5 space-y-4"
				onKeyDown={(event) => {
					if (event.key === "Escape") onClose();
				}}
			>
				<div className="flex items-center justify-between">
					<div
						id="browse-agent-dialog-title"
						className="text-[10px] tracking-widest text-muted-foreground uppercase"
					>
						SELECT AGENT DIRECTORY
					</div>
					<button
						type="button"
						onClick={onClose}
						className="text-[10px] tracking-widest text-muted-foreground hover:text-foreground transition-colors uppercase"
					>
						CANCEL
					</button>
				</div>
				<FolderBrowser
					initialPath={initialPath}
					external={externalAllowed}
					onSelect={onSelect}
				/>
			</div>
		</div>
	);
}
