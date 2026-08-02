import { existsSync, readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { instructionFileNameForProvider } from "./providerRuntime";

export { instructionFileNameForProvider } from "./providerRuntime";

export const AGENT_INSTRUCTION_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;

export type AgentInstructionFileName =
	(typeof AGENT_INSTRUCTION_FILE_NAMES)[number];

export type AgentInstructions = {
	filename: AgentInstructionFileName;
	content: string;
};

/**
 * Find the context-mode instruction file for an agent directory.
 * AGENTS.md is provider-neutral and takes precedence for ACP contexts;
 * CLAUDE.md remains the compatibility fallback.
 */
export function findAgentInstructionFile(
	agentPath: string,
	provider?: string,
): AgentInstructionFileName | null {
	const filenames = provider
		? [instructionFileNameForProvider(provider)]
		: AGENT_INSTRUCTION_FILE_NAMES;
	for (const filename of filenames) {
		if (existsSync(join(agentPath, filename))) return filename;
	}
	return null;
}

export async function findAgentInstructionFileAsync(
	agentPath: string,
	provider?: string,
): Promise<AgentInstructionFileName | null> {
	const filenames = provider
		? [instructionFileNameForProvider(provider)]
		: AGENT_INSTRUCTION_FILE_NAMES;
	for (const filename of filenames) {
		try {
			await access(join(agentPath, filename));
			return filename;
		} catch {
			// Try the legacy fallback when the caller did not supply a provider.
		}
	}
	return null;
}

export function readAgentInstructions(
	agentPath: string,
	provider?: string,
): AgentInstructions | null {
	const filename = findAgentInstructionFile(agentPath, provider);
	if (!filename) return null;
	return {
		filename,
		content: readFileSync(join(agentPath, filename), "utf-8"),
	};
}
