/**
 * Parse an explicit Windows UNC path into its WSL distro and POSIX path.
 * This module deliberately has no Node imports so config validation remains
 * safe in browser bundles.
 */
export function parseWslUncSyntax(
	path: string,
): { distro: string; posixPath: string } | null {
	const match = path.match(/^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)\\(.*)$/i);
	if (!match) return null;
	return {
		distro: match[1],
		posixPath: `/${match[2].replace(/\\/g, "/")}`,
	};
}
