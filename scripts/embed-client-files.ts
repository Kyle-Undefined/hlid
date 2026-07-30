/** Return every file below `directory` as a sorted, relative POSIX path. */
export function scanEmbeddedFiles(directory: string): string[] {
	return Array.from(
		new Bun.Glob("**/*").scanSync({
			cwd: directory,
			dot: true,
			followSymlinks: true,
			onlyFiles: true,
		}),
		(path) => path.replaceAll("\\", "/"),
	).sort();
}
