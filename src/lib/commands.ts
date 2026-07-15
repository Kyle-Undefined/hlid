import type { Skill } from "./skills";

export type CommandAction = "review" | "computer-use";

export type CommandExecution =
	| { kind: "skill"; filePath: string }
	| { kind: "prompt" }
	| { kind: "provider-action"; action: CommandAction };

/** A slash command that Hlid can offer for the active provider/session. */
export type CommandDescriptor = {
	id: string;
	name: string;
	description: string;
	argumentHint?: string;
	aliases?: string[];
	source: "vault" | "provider" | "hlid";
	providerId?: string;
	execution: CommandExecution;
};

export type ProviderCommand = {
	name: string;
	description: string;
	argumentHint: string;
	aliases?: string[];
	action?: CommandAction;
};

const UI_OWNED_COMMANDS = new Set([
	"model",
	"permissions",
	"permission",
	"plan",
	"usage",
	"new",
	"compact",
	"status",
	"mcp",
]);

export function skillCommand(skill: Skill): CommandDescriptor {
	return {
		id: `skill:${skill.file}`,
		name: skill.name,
		description: skill.description,
		source: "vault",
		execution: { kind: "skill", filePath: skill.filePath },
	};
}

export function mergeCommands(
	vaultSkills: Skill[],
	providerCommands: ProviderCommand[],
	providerId?: string,
): CommandDescriptor[] {
	const commands = vaultSkills.map(skillCommand);
	for (const command of providerCommands) {
		if (/\(user\)/i.test(command.name)) continue;
		const normalized = command.name.replace(/\s*\(user\)\s*$/i, "");
		if (!command.action && UI_OWNED_COMMANDS.has(normalized.toLowerCase()))
			continue;
		commands.push({
			id: `${command.action ? "hlid" : "provider"}:${providerId ?? "active"}:${normalized.toLowerCase()}`,
			name: normalized,
			description: command.description,
			...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
			...(command.aliases?.length ? { aliases: command.aliases } : {}),
			source: command.action ? "hlid" : "provider",
			...(providerId ? { providerId } : {}),
			execution: command.action
				? { kind: "provider-action", action: command.action }
				: { kind: "prompt" },
		});
	}
	return commands;
}

export function commandMatches(
	command: CommandDescriptor,
	query: string,
): boolean {
	const normalized = query.toLowerCase();
	return [command.name, ...(command.aliases ?? [])].some((candidate) =>
		candidate.toLowerCase().startsWith(normalized),
	);
}

export type CommandSubmission = {
	text: string;
	skillContext?: string;
	commandAction?: CommandAction;
};

/** Resolve a selected or manually typed slash command into a chat submission. */
export function resolveCommandSubmission(
	activeCommand: CommandDescriptor | null,
	typed: string,
	commands: CommandDescriptor[],
): CommandSubmission {
	const commandText = activeCommand
		? `/${activeCommand.name}${typed ? ` ${typed}` : ""}`
		: typed;
	const slashName = commandText.startsWith("/")
		? commandText.slice(1).split(/[:\s]/)[0].toLowerCase()
		: "";
	const matches = commands.filter(
		(command) =>
			command.name.toLowerCase() === slashName ||
			command.aliases?.some((alias) => alias.toLowerCase() === slashName),
	);
	const match =
		activeCommand ??
		matches.find((command) => command.execution.kind === "provider-action") ??
		matches[0];
	if (!match) return { text: commandText };

	if (match.execution.kind === "skill") {
		const suffix = activeCommand
			? typed.trim()
			: commandText.slice(match.name.length + 2).trim();
		return {
			text: suffix || commandText,
			skillContext: match.execution.filePath,
		};
	}
	if (match.execution.kind === "provider-action") {
		return {
			text: commandText,
			commandAction: match.execution.action,
		};
	}
	return { text: commandText };
}
