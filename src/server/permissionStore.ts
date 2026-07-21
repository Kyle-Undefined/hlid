import { writeConfig } from "../lib/config-writer";
import { updateProjectLocalSettings } from "../lib/projectMcp";
import { loadConfig } from "./config";

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

/** Persist trust for one exact command in the currently configured Obsidian vault. */
export function persistAlwaysAllowedObsidianCommand(
	vaultName: string,
	vaultPath: string,
	commandId: string,
): void {
	const config = loadConfig();
	if (config.vault.name !== vaultName || config.vault.path !== vaultPath) {
		throw new Error(
			"The configured Obsidian vault changed before command approval could be saved.",
		);
	}
	const remembered = config.vault.obsidian_command_allowlist ?? [];
	if (remembered.includes(commandId)) return;
	writeConfig({
		...config,
		vault: {
			...config.vault,
			obsidian_command_allowlist: [...remembered, commandId],
		},
	});
}
