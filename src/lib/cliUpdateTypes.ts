export type CliUpdateStatus = {
	id:
		| "codex"
		| "claude"
		| "codex-desktop"
		| "claude-desktop"
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
	/** Human-facing workflow when an update is visible but cannot be applied by Hlid. */
	updateInstructions?: string;
	updateMode?: "automatic" | "interactive";
	requiresElevation?: boolean;
	checkedAt: number;
	error?: string;
};
