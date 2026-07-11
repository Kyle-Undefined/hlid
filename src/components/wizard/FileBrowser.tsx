import { useEffect, useState } from "react";
import { BrowserEntries, type BrowserEntry } from "./BrowserEntries";
import { joinBrowserPath, parentBrowserPath } from "./browserPath";

type Props = {
	initialPath?: string;
	extensions?: string[];
	external?: boolean;
	onSelect: (path: string) => void;
};

export function FileBrowser({
	initialPath,
	extensions,
	external,
	onSelect,
}: Props) {
	const initialDir = (() => {
		if (!initialPath) return "";
		const lastSlash = Math.max(
			initialPath.lastIndexOf("/"),
			initialPath.lastIndexOf("\\"),
		);
		return lastSlash > 0 ? initialPath.substring(0, lastSlash) : "";
	})();

	const [currentPath, setCurrentPath] = useState(initialDir);
	const [entries, setEntries] = useState<BrowserEntry[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		setLoading(true);
		setError(null);
		const params = new URLSearchParams({ path: currentPath || "~" });
		if (external) params.set("external", "1");
		fetch(`/api/browse?${params.toString()}`, {
			signal: controller.signal,
		})
			.then((r) => {
				if (!r.ok) throw new Error(`Browse failed: ${r.status}`);
				return r.json();
			})
			.then(
				(data: { path: string; entries: BrowserEntry[]; error?: string }) => {
					if (data.error) {
						setError(data.error);
						return;
					}
					setCurrentPath(data.path);
					const filtered = data.entries.filter((e) => {
						if (e.isDirectory) return true;
						if (!extensions) return true;
						return extensions.some((ext) => e.name.endsWith(ext));
					});
					setEntries(filtered);
				},
			)
			.catch((err) => {
				if ((err as Error).name !== "AbortError") {
					setError("Failed to load directory");
				}
			})
			.finally(() => setLoading(false));

		return () => controller.abort();
	}, [currentPath, extensions, external]);

	const navigate = (name: string) =>
		setCurrentPath(joinBrowserPath(currentPath, name));
	const goUp = () => setCurrentPath(parentBrowserPath(currentPath));

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between">
				<code className="text-xs text-muted-foreground bg-secondary px-2 py-1 rounded truncate max-w-[calc(100%-5rem)]">
					{currentPath || "~"}
				</code>
			</div>

			<BrowserEntries
				entries={entries}
				loading={loading}
				error={error}
				canGoUp={Boolean(currentPath && currentPath !== "/")}
				onGoUp={goUp}
				onDirectory={navigate}
				onFile={(name) => onSelect(joinBrowserPath(currentPath, name))}
				emptyText="No files found"
			/>
		</div>
	);
}
