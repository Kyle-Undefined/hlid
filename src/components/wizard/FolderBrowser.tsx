import { useEffect, useState } from "react";
import { BrowserEntries, type BrowserEntry } from "./BrowserEntries";
import { joinBrowserPath, parentBrowserPath } from "./browserPath";

type Props = {
	initialPath?: string;
	onSelect: (path: string) => void;
	external?: boolean;
};

export function FolderBrowser({ initialPath, onSelect, external }: Props) {
	const [currentPath, setCurrentPath] = useState(initialPath ?? "");
	// Server-canonicalized path of the directory currently shown. Only this is safe
	// to pass to onSelect, since `currentPath` may be a tilde or a path that failed to load.
	const [selectablePath, setSelectablePath] = useState<string | null>(null);
	// The root the server landed on for the first (no-path) request, used to
	// prevent navigating above the allowed zone (e.g. the vault root).
	const [allowedRoot, setAllowedRoot] = useState<string | null>(null);
	const [entries, setEntries] = useState<BrowserEntry[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [typedPath, setTypedPath] = useState<string | null>(null);
	// Derived from the first server response — true when running on Windows host.
	const [isWindows, setIsWindows] = useState(false);

	useEffect(() => {
		const controller = new AbortController();
		setLoading(true);
		setError(null);
		const params = new URLSearchParams();
		if (currentPath) params.set("path", currentPath);
		if (external) params.set("external", "1");
		const qs = params.toString() ? `?${params.toString()}` : "";
		fetch(`/api/browse${qs}`, {
			signal: controller.signal,
		})
			.then((r) => r.json())
			.then(
				(data: { path: string; entries: BrowserEntry[]; error?: string }) => {
					if (data.error) {
						setError(data.error);
						setSelectablePath(null);
						return;
					}
					setCurrentPath(data.path);
					setSelectablePath(data.path);
					setTypedPath(null);
					setIsWindows(
						/^[a-zA-Z]:[\\/]/.test(data.path) || data.path.startsWith("\\\\"),
					);
					setEntries(data.entries.filter((e) => e.isDirectory));
					setAllowedRoot((prev) => prev ?? data.path);
				},
			)
			.catch((err) => {
				if ((err as Error).name !== "AbortError") {
					setError("Failed to load directory");
					setSelectablePath(null);
				}
			})
			.finally(() => setLoading(false));

		return () => controller.abort();
	}, [currentPath, external]);

	const navigate = (name: string) =>
		setCurrentPath(joinBrowserPath(currentPath, name));
	const goUp = () => setCurrentPath(parentBrowserPath(currentPath));
	const atRoot =
		!external && allowedRoot !== null && selectablePath === allowedRoot;

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center gap-2">
				<input
					type="text"
					value={typedPath ?? selectablePath ?? currentPath ?? "~"}
					onChange={(e) => setTypedPath(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && typedPath !== null) {
							setCurrentPath(typedPath);
							setTypedPath(null);
						}
					}}
					onBlur={() => {
						if (typedPath !== null) setCurrentPath(typedPath);
					}}
					className="flex-1 min-w-0 text-xs font-mono text-muted-foreground bg-secondary border border-border/50 px-2 py-1 rounded focus:outline-none focus:border-primary/50 transition-colors"
					spellCheck={false}
					autoComplete="off"
				/>
				{isWindows && (
					<button
						type="button"
						onClick={() => {
							fetch("/api/browse?wsl=1")
								.then((r) => r.json())
								.then((data: { wslHome?: string; error?: string }) => {
									if (data.wslHome) setCurrentPath(data.wslHome);
								})
								.catch(() => {});
						}}
						title="Browse default WSL distro home"
						className="text-[10px] tracking-widest px-2 py-1 border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors shrink-0 uppercase"
					>
						WSL
					</button>
				)}
				<button
					type="button"
					disabled={!selectablePath}
					onClick={() => selectablePath && onSelect(selectablePath)}
					className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground font-medium hover:opacity-90 transition-opacity shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
				>
					Select
				</button>
			</div>

			<BrowserEntries
				entries={entries}
				loading={loading}
				error={error}
				canGoUp={Boolean(currentPath && currentPath !== "/" && !atRoot)}
				onGoUp={goUp}
				onDirectory={navigate}
				emptyText="No subdirectories"
			/>
		</div>
	);
}
