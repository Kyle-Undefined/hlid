export type ObsidianCommandPermission = {
	commandId: string;
	key: string;
};

function commandIdFromInput(input: unknown): string | null {
	if (!input || typeof input !== "object" || Array.isArray(input)) return null;
	const id = (input as Record<string, unknown>).id;
	if (typeof id !== "string") return null;
	const commandId = id.trim();
	if (!commandId || commandId.length > 512 || /[\r\n\0]/.test(commandId)) {
		return null;
	}
	return commandId;
}

export function isObsidianRunCommandRequest(
	toolName: string,
	input: unknown,
): boolean {
	const normalized = toolName.toLocaleLowerCase();
	const isRunCommand =
		normalized === "run_command" ||
		normalized === "run command" ||
		((normalized.endsWith("__run_command") ||
			normalized.endsWith(".run_command") ||
			normalized.endsWith("/run_command") ||
			normalized.endsWith(":run_command")) &&
			normalized.includes("hlid_obsidian")) ||
		(normalized.includes("obsidian") &&
			normalized.includes("command") &&
			(normalized.includes("run") || normalized.includes("execute")));
	return isRunCommand && commandIdFromInput(input) !== null;
}

export function resolveObsidianCommandPermission(
	toolName: string,
	input: unknown,
	vaultName: string,
): ObsidianCommandPermission | null {
	if (!isObsidianRunCommandRequest(toolName, input)) return null;
	const commandId = commandIdFromInput(input);
	if (commandId === null) return null;
	return {
		commandId,
		key: `hlid_obsidian:run_command:${vaultName}:${commandId}`,
	};
}
