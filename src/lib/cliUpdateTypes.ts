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
	/** Human-facing app version when it differs from the installer/package version. */
	appVersion?: string | null;
	installedVersion: string | null;
	latestVersion: string | null;
	available: boolean;
	updateCommand?: string;
	updateMode?: "automatic" | "interactive";
	requiresElevation?: boolean;
	checkedAt: number;
	error?: string;
};
