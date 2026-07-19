import { existsSync, readFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

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
): AgentInstructionFileName | null {
	for (const filename of AGENT_INSTRUCTION_FILE_NAMES) {
		if (existsSync(join(agentPath, filename))) return filename;
	}
	return null;
}

export async function findAgentInstructionFileAsync(
	agentPath: string,
): Promise<AgentInstructionFileName | null> {
	for (const filename of AGENT_INSTRUCTION_FILE_NAMES) {
		try {
			await access(join(agentPath, filename));
			return filename;
		} catch {
			// Try the compatibility fallback.
		}
	}
	return null;
}

export function readAgentInstructions(
	agentPath: string,
): AgentInstructions | null {
	const filename = findAgentInstructionFile(agentPath);
	if (!filename) return null;
	return {
		filename,
		content: readFileSync(join(agentPath, filename), "utf-8"),
	};
}

/** Read instructions without putting network/WSL filesystem latency on the JS thread. */
export async function readAgentInstructionsAsync(
	agentPath: string,
): Promise<AgentInstructions | null> {
	const filename = await findAgentInstructionFileAsync(agentPath);
	if (!filename) return null;
	return {
		filename,
		content: await readFile(join(agentPath, filename), "utf-8"),
	};
}
