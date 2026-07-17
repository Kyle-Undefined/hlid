import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { findAgentInstructionFile } from "../lib/agentInstructions";
import { pathStartsWith, toLogical } from "../lib/paths";
import type { ChatAttachment } from "./protocol";

export type BuildPromptOptions = {
	vaultPath: string;
	allowedAgentRealPaths: string[];
	agentMode: "cwd" | "context";
	agentCwd: string | undefined;
	claudeSessionId: string | null;
	userMessage: string;
	/** Legacy single-skill field retained for queued turns created by older clients. */
	skillContext?: string;
	skillContexts?: string | string[];
	attachments: ChatAttachment[] | undefined;
	/** Plan-mode HTML instructions (from buildPlanHtmlInstructions), appended after the user message. */
	planHtmlInstructions?: string;
};

/**
 * Instruction block asking the agent to render its plan as a self-contained
 * HTML document at a server-chosen path before presenting it for approval.
 * Injected per turn when plan mode + the HTML-plans toggle are both on.
 */
export function buildPlanHtmlInstructions(planHtmlPath: string): string {
	const logicalPlanHtmlPath = toLogical(planHtmlPath);
	return `## HTML plan documents

This is a planning-only turn. Explore and design the solution, but do not
implement it or modify project files. The single exception is the HTML plan
document described below.

When you are ready to present a plan for approval, FIRST write a single
self-contained HTML document of the plan to exactly this path:

  ${logicalPlanHtmlPath}

Requirements:
- One file, fully self-contained: inline <style> and (optional) inline
  <script> only. No external URLs, no CDN links, no remote images/fonts
  (use data: URIs if needed). The page renders in a sandboxed iframe with
  all network access blocked.
- Present the plan attractively: title, overview, ordered steps, files to
  change, risks. Light-background styling; readable at ~900px wide.
- Keep it under 2 MB.

THEN present the plan for approval as usual (e.g. call ExitPlanMode) with
the complete plan in markdown (it is the fallback if the HTML cannot be
shown). If writing the HTML file fails for any reason, skip it and present
the plan anyway. If the user requests revisions, overwrite the same file
with the revised plan before presenting again.`;
}

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
		skillContexts,
		skillContext,
		attachments,
		planHtmlInstructions,
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
	const requestedSkillContexts = skillContexts ?? skillContext;
	const safeSkillContexts = (
		Array.isArray(requestedSkillContexts)
			? requestedSkillContexts
			: requestedSkillContexts
				? [requestedSkillContexts]
				: []
	).flatMap((skillContext) => {
		// Use realpath for consistency with safeAttachments: both must compare
		// against vaultRootReal so symlinked paths resolve to the same base.
		let real: string;
		try {
			real = realpathSync(resolve(skillContext));
		} catch {
			return [];
		}
		return pathStartsWith(vaultRootReal, real) ? [skillContext] : [];
	});
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
	const instructionFile =
		agentMode === "context" && agentCwd && claudeSessionId === null
			? findAgentInstructionFile(agentCwd)
			: null;
	const personaBlock =
		agentCwd && instructionFile
			? `Please read \`${toLogical(agentCwd)}/${instructionFile}\` and adopt its persona/instructions for this conversation.\n\n`
			: "";
	const planHtmlBlock = planHtmlInstructions
		? `\n\n${planHtmlInstructions}`
		: "";
	const skillBlock =
		safeSkillContexts.length === 1
			? `Please read the skill file at \`${toLogical(safeSkillContexts[0])}\` and follow its instructions.\n\n`
			: safeSkillContexts.length > 1
				? `Please read the following skill files and follow all of their instructions:\n${safeSkillContexts.map((skillContext) => `- \`${toLogical(skillContext)}\``).join("\n")}\n\n`
				: "";
	const prompt = skillBlock
		? userMessage.startsWith("/")
			? `${userMessage}\n\n${personaBlock}${attachmentBlock}${skillBlock}${planHtmlBlock}`
			: `${personaBlock}${attachmentBlock}${skillBlock}User: ${userMessage || "(no additional input)"}${planHtmlBlock}`
		: `${personaBlock}${attachmentBlock}${userMessage}${planHtmlBlock}`;
	return { prompt, safeAttachments };
}
