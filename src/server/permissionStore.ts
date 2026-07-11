import { updateProjectLocalSettings } from "../lib/projectMcp";

/** Persist a user-approved tool in the cwd-local Claude settings file. */
export function persistAlwaysAllowedTool(cwd: string, toolName: string): void {
	try {
		updateProjectLocalSettings(cwd, (settings) => {
			const allow = settings.permissions?.allow ?? [];
			if (allow.includes(toolName)) return;
			settings.permissions = {
				...settings.permissions,
				allow: [...allow, toolName],
			};
		});
	} catch (error) {
		console.error("[session] Failed to update settings.local.json:", error);
	}
}
