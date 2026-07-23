import { isClaudeRuntimeProvider } from "./providerRuntime";
import { startsWithSearchText } from "./search";
import type { Skill } from "./skills";

export type CommandAction = "review" | "computer-use" | "goal";

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
	source: "vault" | "library" | "provider" | "hlid";
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

/** Keep provider-neutral commands plus commands owned by the active provider. */
export function filterProviderCompatibleCommands<
	T extends { providerId?: string },
>(selected: T[], providerId: string | null | undefined): T[] {
	const compatible = selected.filter(
		(command) => !command.providerId || command.providerId === providerId,
	);
	return compatible.length === selected.length ? selected : compatible;
}

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
	const providerOwned = Boolean(skill.providerId);
	return {
		id: `skill:${skill.file}`,
		name: skill.name,
		description: skill.description,
		source: providerOwned
			? "provider"
			: skill.source === "hlid"
				? "library"
				: "vault",
		...(skill.providerId ? { providerId: skill.providerId } : {}),
		execution: providerOwned
			? { kind: "prompt" }
			: { kind: "skill", filePath: skill.filePath },
	};
}

export function mergeCommands(
	vaultSkills: Skill[],
	providerCommands: ProviderCommand[],
	providerId?: string,
): CommandDescriptor[] {
	const commands = vaultSkills
		.filter((skill) => !skill.providerId || skill.providerId === providerId)
		.map(skillCommand);
	for (const command of providerCommands) {
		if (/\(user\)/i.test(command.name)) continue;
		const normalized = command.name.replace(/\s*\(user\)\s*$/i, "");
		if (!command.action && UI_OWNED_COMMANDS.has(normalized.toLowerCase()))
			continue;
		if (
			!command.action &&
			commands.some(
				(existing) => existing.name.toLowerCase() === normalized.toLowerCase(),
			)
		)
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
	return [command.name, ...(command.aliases ?? [])].some((candidate) =>
		startsWithSearchText(candidate, query),
	);
}

export type CommandSubmission = {
	text: string;
	skillContexts?: string[];
	commandAction?: CommandAction;
};

export type GoalCommandIntent =
	| { action: "edit" }
	| { action: "pause" | "resume" | "clear" }
	| { action: "set"; objective: string };

/** Turn Raven's native `/goal` syntax into an explicit app-server operation. */
export function parseGoalCommand(text: string): GoalCommandIntent {
	const value = text
		.trim()
		.replace(/^\/goal(?:\s+|$)/i, "")
		.trim();
	if (!value || value.toLowerCase() === "edit") return { action: "edit" };
	const action = value.toLowerCase();
	if (action === "pause" || action === "resume" || action === "clear") {
		return { action };
	}
	return { action: "set", objective: value };
}

export const CLAUDE_COMMAND_SELECTION_LIMIT = 6;

function isNativePromptCommand(command: CommandDescriptor): boolean {
	return command.execution.kind === "prompt" && command.source === "provider";
}

/**
 * Provider actions own the whole turn. Native ACP commands are text-prefix
 * commands, so ACP can reliably execute one per prompt; vault skills remain
 * composable because Hlid injects their files itself.
 */
export function canSelectCommand(
	selected: CommandDescriptor[],
	candidate: CommandDescriptor,
	providerId?: string,
): boolean {
	if (selected.some((command) => command.id === candidate.id)) return false;
	if (candidate.execution.kind === "provider-action") return true;
	const composable = selected.filter(
		(command) => command.execution.kind !== "provider-action",
	);
	if (
		providerId !== undefined &&
		isClaudeRuntimeProvider(providerId) &&
		composable.length >= CLAUDE_COMMAND_SELECTION_LIMIT
	)
		return false;
	if (
		providerId?.startsWith("acp:") &&
		isNativePromptCommand(candidate) &&
		composable.some(isNativePromptCommand)
	)
		return false;
	return true;
}

export function addCommandSelection(
	selected: CommandDescriptor[],
	candidate: CommandDescriptor,
	providerId?: string,
): CommandDescriptor[] {
	if (!canSelectCommand(selected, candidate, providerId)) return selected;
	if (candidate.execution.kind === "provider-action") return [candidate];
	const withoutAction = selected.filter(
		(command) => command.execution.kind !== "provider-action",
	);
	return [...withoutAction, candidate];
}

function providerCommandText(
	commands: CommandDescriptor[],
	vaultCommands: CommandDescriptor[],
	typed: string,
): string {
	const vaultMentions = vaultCommands
		.map((command) => `/${command.name}`)
		.join(" ");
	const vaultLabel = vaultMentions ? `skills: ${vaultMentions}` : "";
	if (commands.length === 0) {
		return typed ? `${vaultLabel}\n\n${typed}` : vaultLabel;
	}
	if (commands.every((command) => command.providerId === "codex")) {
		const mentions = [
			...commands.map((command) => `$${command.name}`),
			...(vaultLabel ? [vaultLabel] : []),
		].join(" ");
		return typed ? `${mentions}\n\n${typed}` : mentions;
	}
	if (commands.length === 1) {
		const mentions = [`/${commands[0].name}`, vaultLabel]
			.filter(Boolean)
			.join(" ");
		return `${mentions}${typed ? ` ${typed}` : ""}`;
	}
	const mentions = commands.map((command) => `/${command.name}`).join(", ");
	const vaultInstruction = vaultMentions
		? ` Also apply these vault skills: ${vaultMentions}.`
		: "";
	return `Use these skills/commands together: ${mentions}.${vaultInstruction}${typed ? `\n\n${typed}` : ""}`;
}

/** Build the prompt prefix for provider-native skills saved on a Routine. */
export function routineProviderCommandText(
	providerId: string,
	commandNames: readonly string[],
	typed: string,
): string {
	const names = [
		...new Set(commandNames.map((name) => name.trim()).filter(Boolean)),
	];
	if (names.length === 0) return typed;
	if (providerId === "codex") {
		const mentions = names.map((name) => `$${name}`).join(" ");
		return typed ? `${mentions}\n\n${typed}` : mentions;
	}
	if (names.length === 1) {
		return `/${names[0]}${typed ? ` ${typed}` : ""}`;
	}
	const mentions = names.map((name) => `/${name}`).join(", ");
	return `Use these skills/commands together: ${mentions}.${typed ? `\n\n${typed}` : ""}`;
}

/** Resolve a selected or manually typed slash command into a chat submission. */
export function resolveCommandSubmission(
	activeCommands: CommandDescriptor | CommandDescriptor[] | null,
	typed: string,
	commands: CommandDescriptor[],
): CommandSubmission {
	const selected = Array.isArray(activeCommands)
		? activeCommands
		: activeCommands
			? [activeCommands]
			: [];
	const activeCommand = selected.length === 1 ? selected[0] : null;
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
	const manualMatch =
		matches.find((command) => command.execution.kind === "provider-action") ??
		matches[0];
	const resolved =
		selected.length > 0 ? selected : manualMatch ? [manualMatch] : [];
	if (resolved.length === 0) return { text: commandText };

	const action = resolved.find(
		(command) => command.execution.kind === "provider-action",
	);
	if (action?.execution.kind === "provider-action") {
		return {
			text:
				selected.length > 0
					? `/${action.name}${typed ? ` ${typed}` : ""}`
					: commandText,
			commandAction: action.execution.action,
		};
	}
	const skillContexts = resolved.flatMap((command) =>
		command.execution.kind === "skill" ? [command.execution.filePath] : [],
	);
	const vaultCommands = resolved.filter(
		(command) => command.execution.kind === "skill",
	);
	const promptCommands = resolved.filter(isNativePromptCommand);
	const manualSuffix =
		selected.length === 0 && manualMatch
			? commandText.slice(manualMatch.name.length + 2).trim()
			: typed.trim();
	const text =
		providerCommandText(promptCommands, vaultCommands, manualSuffix) ||
		resolved.map((command) => `/${command.name}`).join(" ");
	return {
		text,
		...(skillContexts.length > 0 ? { skillContexts } : {}),
	};
}
