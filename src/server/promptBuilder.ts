import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
	type AgentInstructionFileName,
	findAgentInstructionFileAsync,
} from "../lib/agentInstructions";
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

function requestedSkillContexts(opts: BuildPromptOptions): string[] {
	const requested = opts.skillContexts ?? opts.skillContext;
	return Array.isArray(requested) ? requested : requested ? [requested] : [];
}

function assemblePrompt(
	opts: BuildPromptOptions,
	safeSkillContexts: string[],
	safeAttachments: ChatAttachment[],
	instructionFile: AgentInstructionFileName | null,
): { prompt: string; safeAttachments: ChatAttachment[] } {
	const { agentCwd, userMessage, planHtmlInstructions } = opts;
	const attachmentBlock =
		safeAttachments.length > 0
			? `Attachments (read with the Read tool when relevant):\n${safeAttachments
					.map(
						(attachment) =>
							`- ${toLogical(attachment.path)} (${attachment.mime})`,
					)
					.join("\n")}\n\n`
			: "";
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

/** Async server path: keeps WSL/UNC canonicalization off the main event loop. */
export async function buildPromptAsync(
	opts: BuildPromptOptions,
): Promise<{ prompt: string; safeAttachments: ChatAttachment[] }> {
	const vaultRoot = resolve(opts.vaultPath);
	const vaultRootReal = await realpath(vaultRoot).catch(() => vaultRoot);
	const safeSkillContexts = (
		await Promise.all(
			requestedSkillContexts(opts).map(async (skillContext) => {
				const canonical = await realpath(resolve(skillContext)).catch(
					() => null,
				);
				return canonical && pathStartsWith(vaultRootReal, canonical)
					? skillContext
					: null;
			}),
		)
	).filter((value): value is string => value !== null);
	const safeAttachments = (
		await Promise.all(
			(opts.attachments ?? []).map(async (attachment) => {
				const canonical = await realpath(resolve(attachment.path)).catch(
					() => null,
				);
				if (!canonical) return null;
				if (pathStartsWith(vaultRootReal, canonical)) return attachment;
				return opts.allowedAgentRealPaths.some((root) =>
					pathStartsWith(root, canonical),
				)
					? attachment
					: null;
			}),
		)
	).filter((value): value is ChatAttachment => value !== null);
	const instructionFile =
		opts.agentMode === "context" &&
		opts.agentCwd &&
		opts.claudeSessionId === null
			? await findAgentInstructionFileAsync(opts.agentCwd)
			: null;
	return assemblePrompt(
		opts,
		safeSkillContexts,
		safeAttachments,
		instructionFile,
	);
}
