import { useState } from "react";
import { FolderBrowser } from "./FolderBrowser";

export function RelativeFolderField({
	value,
	onChange,
	basePath,
	placeholder,
	fullWidth,
}: {
	value: string;
	onChange: (v: string) => void;
	basePath: string;
	placeholder?: string;
	fullWidth?: boolean;
}) {
	const [open, setOpen] = useState(false);

	return (
		<div className="flex items-center gap-2">
			<input
				type="text"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				className={`${fullWidth ? "flex-1 min-w-0" : "w-32 sm:w-48"} bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors`}
			/>
			<button
				type="button"
				onClick={() => setOpen(true)}
				disabled={!basePath}
				className="text-[10px] tracking-widest px-2 py-1.5 border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors shrink-0 uppercase disabled:opacity-30"
			>
				BROWSE
			</button>

			{open && (
				<div className="fixed inset-0 z-50 bg-background/90 backdrop-blur-sm flex items-center justify-center p-4">
					<div className="w-full max-w-md bg-card border border-border shadow-2xl p-5 space-y-4">
						<div className="flex items-center justify-between">
							<div className="text-[10px] tracking-widest text-muted-foreground uppercase">
								PICK FOLDER
							</div>
							<button
								type="button"
								onClick={() => setOpen(false)}
								className="text-[10px] tracking-widest text-muted-foreground hover:text-foreground transition-colors uppercase"
							>
								CANCEL
							</button>
						</div>
						<FolderBrowser
							initialPath={basePath}
							onSelect={(path) => {
								const rel = path.startsWith(`${basePath}/`)
									? path.slice(basePath.length + 1)
									: (path.split("/").pop() ?? path);
								onChange(rel);
								setOpen(false);
							}}
						/>
					</div>
				</div>
			)}
		</div>
	);
}
