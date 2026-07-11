import { ChevronRight, File, Folder } from "lucide-react";

export interface BrowserEntry {
	name: string;
	isDirectory: boolean;
}

interface BrowserEntriesProps {
	entries: BrowserEntry[];
	loading: boolean;
	error: string | null;
	canGoUp: boolean;
	onGoUp: () => void;
	onDirectory: (name: string) => void;
	onFile?: (name: string) => void;
	emptyText: string;
}

export function BrowserEntries({
	entries,
	loading,
	error,
	canGoUp,
	onGoUp,
	onDirectory,
	onFile,
	emptyText,
}: BrowserEntriesProps) {
	return (
		<div className="border border-border rounded-lg overflow-hidden">
			<div className="max-h-[40svh] sm:max-h-52 overflow-y-auto divide-y divide-border">
				{canGoUp && (
					<button
						type="button"
						onClick={onGoUp}
						className="w-full flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:bg-accent transition-colors text-left"
					>
						<ChevronRight className="w-3.5 h-3.5 rotate-180 shrink-0" />
						<span className="font-mono">..</span>
					</button>
				)}

				{loading && (
					<div className="px-3 py-4 text-sm text-muted-foreground text-center">
						Loading…
					</div>
				)}

				{error && (
					<div className="px-3 py-4 text-sm text-destructive text-center">
						{error}
					</div>
				)}

				{!loading &&
					!error &&
					entries.map((entry) => (
						<button
							key={entry.name}
							type="button"
							onClick={() =>
								entry.isDirectory
									? onDirectory(entry.name)
									: onFile?.(entry.name)
							}
							className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-accent transition-colors text-left"
						>
							{entry.isDirectory ? (
								<Folder className="w-3.5 h-3.5 text-primary shrink-0" />
							) : (
								<File className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
							)}
							<span className={entry.isDirectory ? undefined : "font-mono"}>
								{entry.name}
							</span>
						</button>
					))}

				{!loading && !error && entries.length === 0 && (
					<div className="px-3 py-4 text-sm text-muted-foreground text-center">
						{emptyText}
					</div>
				)}
			</div>
		</div>
	);
}
