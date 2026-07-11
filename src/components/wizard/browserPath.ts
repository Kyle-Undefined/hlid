function isWindowsPath(path: string): boolean {
	return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

export function parentBrowserPath(path: string): string {
	if (isWindowsPath(path)) {
		const trimmed = path.replace(/[\\/]+$/, "");
		const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
		if (index <= 2) return `${trimmed.slice(0, 2)}\\`;
		return trimmed.slice(0, index);
	}
	const parts = path.replace(/\/$/, "").split("/");
	parts.pop();
	return parts.join("/") || "/";
}

export function joinBrowserPath(base: string, name: string): string {
	if (isWindowsPath(base)) {
		const separator = base.endsWith("\\") || base.endsWith("/") ? "" : "\\";
		return `${base}${separator}${name}`;
	}
	return base === "/" ? `/${name}` : `${base}/${name}`;
}
