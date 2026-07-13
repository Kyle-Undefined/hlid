export type CliUpdateStatus = {
	id: "codex" | "claude";
	label: string;
	installedVersion: string | null;
	latestVersion: string | null;
	available: boolean;
	updateCommand?: string;
	checkedAt: number;
	error?: string;
};
