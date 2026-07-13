export type CliUpdateStatus = {
	id: "codex" | "claude" | `acp:${string}`;
	label: string;
	installedVersion: string | null;
	latestVersion: string | null;
	available: boolean;
	updateCommand?: string;
	checkedAt: number;
	error?: string;
};
