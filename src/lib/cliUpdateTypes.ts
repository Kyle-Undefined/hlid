export type CliUpdateStatus = {
	id:
		| "codex"
		| "claude"
		| "codex-desktop"
		| `wsl:${string}:codex`
		| `wsl:${string}:claude`
		| `acp:${string}`;
	label: string;
	surface?: "cli" | "desktop";
	installedVersion: string | null;
	latestVersion: string | null;
	available: boolean;
	updateCommand?: string;
	updateMode?: "automatic" | "interactive";
	requiresElevation?: boolean;
	checkedAt: number;
	error?: string;
};
