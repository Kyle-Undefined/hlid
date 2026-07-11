import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type LocalSettings = {
	permissions?: {
		allow?: string[];
		deny?: string[];
	};
	[key: string]: unknown;
};

/** Persist a user-approved tool in the cwd-local Claude settings file. */
export function persistAlwaysAllowedTool(cwd: string, toolName: string): void {
	const settingsPath = join(cwd, ".claude", "settings.local.json");
	let settings: LocalSettings = {};
	try {
		settings = JSON.parse(readFileSync(settingsPath, "utf8")) as LocalSettings;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.error("[session] Failed to parse settings.local.json:", error);
		}
	}

	const allow = settings.permissions?.allow ?? [];
	if (allow.includes(toolName)) return;

	settings.permissions = {
		...settings.permissions,
		allow: [...allow, toolName],
	};
	mkdirSync(join(cwd, ".claude"), { recursive: true });
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}
