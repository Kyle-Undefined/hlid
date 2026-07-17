export type AgentDisplayCandidate = {
	path: string;
	resolvedPath?: string;
	name?: string | null;
};

function comparableAgentPath(value: string): string {
	let normalized = value.trim().replace(/\\/g, "/");
	const wsl = normalized.match(/^\/\/(?:wsl\$|wsl\.localhost)\/[^/]+(\/.*)$/i);
	if (wsl) normalized = wsl[1];
	const drive = normalized.match(/^([a-z]):\/(.*)$/i);
	if (drive) normalized = `/mnt/${drive[1].toLowerCase()}/${drive[2]}`;
	return normalized
		.replace(/\/{2,}/g, "/")
		.replace(/\/$/, "")
		.toLowerCase();
}

export function sameAgentDisplayPath(left: string, right: string): boolean {
	return comparableAgentPath(left) === comparableAgentPath(right);
}

export function agentPathBasename(path: string): string {
	return (
		path
			.trim()
			.replace(/[\\/]+$/, "")
			.split(/[\\/]/)
			.pop() || "agent"
	);
}

export function agentDisplayName(
	path: string,
	candidates: AgentDisplayCandidate[],
): string {
	const match = candidates.find(
		(candidate) =>
			sameAgentDisplayPath(candidate.path, path) ||
			(candidate.resolvedPath != null &&
				sameAgentDisplayPath(candidate.resolvedPath, path)),
	);
	return match?.name?.trim() || agentPathBasename(path);
}
