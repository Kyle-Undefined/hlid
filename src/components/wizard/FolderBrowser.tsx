import { ChevronRight, Folder } from "lucide-react";
import { useEffect, useState } from "react";

type Entry = { name: string; isDirectory: boolean };

function parentPath(path: string): string {
	const parts = path.replace(/\/$/, "").split("/");
	parts.pop();
	return parts.join("/") || "/";
}

function joinPath(base: string, name: string): string {
	return base === "/" ? `/${name}` : `${base}/${name}`;
}

type Props = {
	initialPath?: string;
	onSelect: (path: string) => void;
};

export function FolderBrowser({ initialPath, onSelect }: Props) {
	const [currentPath, setCurrentPath] = useState(initialPath ?? "");
	const [entries, setEntries] = useState<Entry[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		setLoading(true);
		setError(null);
		fetch(`/api/browse?path=${encodeURIComponent(currentPath || "~")}`, {
			signal: controller.signal,
		})
			.then((r) => r.json())
			.then((data: { path: string; entries: Entry[]; error?: string }) => {
				if (data.error) {
					setError(data.error);
					return;
				}
				setCurrentPath(data.path);
				setEntries(data.entries.filter((e) => e.isDirectory));
			})
			.catch((err) => {
				if ((err as Error).name !== "AbortError") {
					setError("Failed to load directory");
				}
			})
			.finally(() => setLoading(false));

		return () => controller.abort();
	}, [currentPath]);

	const navigate = (name: string) =>
		setCurrentPath(joinPath(currentPath, name));
	const goUp = () => setCurrentPath(parentPath(currentPath));

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between">
				<code className="text-xs text-muted-foreground bg-secondary px-2 py-1 rounded truncate max-w-[calc(100%-5rem)]">
					{currentPath || "~"}
				</code>
				<button
					type="button"
					onClick={() => onSelect(currentPath)}
					className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground font-medium hover:opacity-90 transition-opacity shrink-0"
				>
					Select
				</button>
			</div>

			<div className="border border-border rounded-lg overflow-hidden">
				<div className="max-h-[40svh] sm:max-h-52 overflow-y-auto divide-y divide-border">
					{currentPath && currentPath !== "/" && (
						<button
							type="button"
							onClick={goUp}
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
						entries.map((e) => (
							<button
								key={e.name}
								type="button"
								onClick={() => navigate(e.name)}
								className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-accent transition-colors text-left"
							>
								<Folder className="w-3.5 h-3.5 text-primary shrink-0" />
								<span>{e.name}</span>
							</button>
						))}

					{!loading && !error && entries.length === 0 && (
						<div className="px-3 py-4 text-sm text-muted-foreground text-center">
							No subdirectories
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
