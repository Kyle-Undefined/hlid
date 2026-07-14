export type CliUpdateStatus = {
	id:
		| "codex"
		| "claude"
		| `wsl:${string}:codex`
		| `wsl:${string}:claude`
		| `acp:${string}`;
	label: string;
	installedVersion: string | null;
	latestVersion: string | null;
	available: boolean;
	updateCommand?: string;
	updateMode?: "automatic" | "interactive";
	requiresElevation?: boolean;
	checkedAt: number;
	error?: string;
};
