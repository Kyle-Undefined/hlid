import { ChevronRight, File, Folder } from "lucide-react";
import { useEffect, useState } from "react";

type Entry = { name: string; isDirectory: boolean };

function isWindowsPath(path: string): boolean {
	return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function parentPath(path: string): string {
	if (isWindowsPath(path)) {
		const trimmed = path.replace(/[\\/]+$/, "");
		const idx = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
		if (idx <= 2) return `${trimmed.slice(0, 2)}\\`;
		return trimmed.slice(0, idx);
	}
	const parts = path.replace(/\/$/, "").split("/");
	parts.pop();
	return parts.join("/") || "/";
}

function joinPath(base: string, name: string): string {
	if (isWindowsPath(base)) {
		const sep = base.endsWith("\\") || base.endsWith("/") ? "" : "\\";
		return `${base}${sep}${name}`;
	}
	return base === "/" ? `/${name}` : `${base}/${name}`;
}

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
	const [entries, setEntries] = useState<Entry[]>([]);
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
			.then((data: { path: string; entries: Entry[]; error?: string }) => {
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
			})
			.catch((err) => {
				if ((err as Error).name !== "AbortError") {
					setError("Failed to load directory");
				}
			})
			.finally(() => setLoading(false));

		return () => controller.abort();
	}, [currentPath, extensions, external]);

	const navigate = (name: string) =>
		setCurrentPath(joinPath(currentPath, name));
	const goUp = () => setCurrentPath(parentPath(currentPath));

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between">
				<code className="text-xs text-muted-foreground bg-secondary px-2 py-1 rounded truncate max-w-[calc(100%-5rem)]">
					{currentPath || "~"}
				</code>
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
						entries.map((e) =>
							e.isDirectory ? (
								<button
									key={e.name}
									type="button"
									onClick={() => navigate(e.name)}
									className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-accent transition-colors text-left"
								>
									<Folder className="w-3.5 h-3.5 text-primary shrink-0" />
									<span>{e.name}</span>
								</button>
							) : (
								<button
									key={e.name}
									type="button"
									onClick={() => onSelect(joinPath(currentPath, e.name))}
									className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-accent transition-colors text-left"
								>
									<File className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
									<span className="font-mono">{e.name}</span>
								</button>
							),
						)}

					{!loading && !error && entries.length === 0 && (
						<div className="px-3 py-4 text-sm text-muted-foreground text-center">
							No files found
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
