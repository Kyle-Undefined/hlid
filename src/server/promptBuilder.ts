import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathStartsWith, toLogical } from "../lib/paths";
import type { ChatAttachment } from "./protocol";

export type BuildPromptOptions = {
	vaultPath: string;
	allowedAgentRealPaths: string[];
	agentMode: "cwd" | "context";
	agentCwd: string | undefined;
	claudeSessionId: string | null;
	userMessage: string;
	skillContext: string | undefined;
	attachments: ChatAttachment[] | undefined;
};

/**
 * Validates and builds the prompt string for the SDK query.
 * Filters skill context and attachments to safe paths within vault/agent roots.
 * Returns the final prompt text and the filtered attachment list.
 */
export function buildPrompt(opts: BuildPromptOptions): {
	prompt: string;
	safeAttachments: ChatAttachment[];
} {
	const {
		vaultPath,
		allowedAgentRealPaths,
		agentMode,
		agentCwd,
		claudeSessionId,
		userMessage,
		skillContext,
		attachments,
	} = opts;

	// For vault skills: skillContext is the absolute file path.
	// Validate it stays within the vault before interpolating into the prompt.
	// For Claude skills (skillContext absent): message starts with '/' and CLI handles
	// the slash command natively from ~/.claude/skills/. Keep the slash intact.
	const vaultRoot = resolve(vaultPath);
	let vaultRootReal: string;
	try {
		vaultRootReal = realpathSync(vaultRoot);
	} catch {
		vaultRootReal = vaultRoot;
	}
	const safeSkillContext = (() => {
		if (!skillContext) return undefined;
		// Use realpath for consistency with safeAttachments: both must compare
		// against vaultRootReal so symlinked paths resolve to the same base.
		let real: string;
		try {
			real = realpathSync(resolve(skillContext));
		} catch {
			return undefined;
		}
		return pathStartsWith(vaultRootReal, real) ? skillContext : undefined;
	})();
	const safeAttachments = (attachments ?? []).filter((a) => {
		let real: string;
		try {
			real = realpathSync(resolve(a.path));
		} catch {
			return false;
		}
		if (pathStartsWith(vaultRootReal, real)) return true;
		for (const root of allowedAgentRealPaths) {
			if (pathStartsWith(root, real)) return true;
		}
		return false;
	});
	const attachmentBlock =
		safeAttachments.length > 0
			? `Attachments (read with the Read tool when relevant):\n${safeAttachments
					.map((a) => `- ${toLogical(a.path)} (${a.mime})`)
					.join("\n")}\n\n`
			: "";
	// Context-mode persona preamble: inject whenever there is no captured
	// SDK session to resume — i.e. on the first turn of a brand-new chat
	// AND on the first turn of any pre-resume-migration chat (where
	// messageSeq > 0 but claudeSessionId is still null). This guarantees
	// the persona lands on the very turn that establishes the CLI-side
	// session that subsequent turns will resume.
	const personaBlock =
		agentMode === "context" &&
		agentCwd &&
		claudeSessionId === null &&
		existsSync(join(agentCwd, "CLAUDE.md"))
			? `Please read \`${toLogical(agentCwd)}/CLAUDE.md\` and adopt its persona/instructions for this conversation.\n\n`
			: "";
	const prompt = safeSkillContext
		? `${personaBlock}${attachmentBlock}Please read the skill file at \`${toLogical(safeSkillContext)}\` and follow its instructions.\n\nUser: ${userMessage || "(no additional input)"}`
		: `${personaBlock}${attachmentBlock}${userMessage}`;
	return { prompt, safeAttachments };
}
