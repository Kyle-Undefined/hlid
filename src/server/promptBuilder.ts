import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
	type AgentInstructionFileName,
	findAgentInstructionFileAsync,
} from "../lib/agentInstructions";
import {
	isPathAccessibleFromRuntime,
	pathStartsWith,
	toLogical,
	toProviderRuntimePath,
} from "../lib/paths";
import { artifactsDirectory, managedSkillsDirectory } from "./libraryStore";
import type { ChatAttachment } from "./protocol";
import {
	type ResolvedVaultReference,
	resolveVaultReferences,
} from "./vaultReferences";

export type BuildPromptOptions = {
	vaultPath: string;
	allowedAgentRealPaths: string[];
	agentMode: "cwd" | "context";
	agentCwd: string | undefined;
	/** Provider working directory used to translate host-owned resource paths. */
	runtimeCwd?: string;
	claudeSessionId: string | null;
	userMessage: string;
	/** Legacy single-skill field retained for queued turns created by older clients. */
	skillContext?: string;
	skillContexts?: string | string[];
	attachments: ChatAttachment[] | undefined;
	/** Vault-root-relative files selected by the user with the @ picker. */
	vaultReferences?: string[];
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
	safeVaultReferences: ResolvedVaultReference[],
	instructionFile: AgentInstructionFileName | null,
): {
	prompt: string;
	safeAttachments: ChatAttachment[];
	resourcePaths: string[];
	safeVaultReferences: ResolvedVaultReference[];
} {
	const { agentCwd, userMessage, planHtmlInstructions } = opts;
	const runtimePath = (path: string) =>
		opts.runtimeCwd
			? toProviderRuntimePath(opts.runtimeCwd, path)
			: toLogical(path);
	const attachmentBlock =
		safeAttachments.length > 0
			? `Attachments (read with the Read tool when relevant):\n${safeAttachments
					.map(
						(attachment) =>
							`- ${runtimePath(attachment.path)} (${attachment.mime})`,
					)
					.join("\n")}\n\n`
			: "";
	const vaultReferenceBlock =
		safeVaultReferences.length > 0
			? `Vault references (read or edit these exact files when relevant):\n${safeVaultReferences
					.map(
						(reference) =>
							`- \`${runtimePath(reference.path)}\` (Vault: ${reference.relativePath})`,
					)
					.join("\n")}\n\n`
			: "";
	const personaBlock =
		agentCwd && instructionFile
			? `Please read \`${runtimePath(agentCwd)}/${instructionFile}\` and adopt its persona/instructions for this conversation.\n\n`
			: "";
	const planHtmlBlock = planHtmlInstructions
		? `\n\n${planHtmlInstructions}`
		: "";
	const skillBlock =
		safeSkillContexts.length === 1
			? `Please read the skill file at \`${runtimePath(safeSkillContexts[0])}\` and follow its instructions.\n\n`
			: safeSkillContexts.length > 1
				? `Please read the following skill files and follow all of their instructions:\n${safeSkillContexts.map((skillContext) => `- \`${runtimePath(skillContext)}\``).join("\n")}\n\n`
				: "";
	const prompt = skillBlock
		? userMessage.startsWith("/")
			? `${userMessage}\n\n${personaBlock}${attachmentBlock}${vaultReferenceBlock}${skillBlock}${planHtmlBlock}`
			: `${personaBlock}${attachmentBlock}${vaultReferenceBlock}${skillBlock}User: ${userMessage || "(no additional input)"}${planHtmlBlock}`
		: `${personaBlock}${attachmentBlock}${vaultReferenceBlock}${userMessage || (safeVaultReferences.length > 0 ? "User: (no additional input)" : "")}${planHtmlBlock}`;
	return {
		prompt,
		safeAttachments,
		resourcePaths: [
			...safeSkillContexts,
			...safeAttachments.map((item) => item.path),
			...safeVaultReferences.map((item) => item.path),
		],
		safeVaultReferences,
	};
}

/** Async server path: keeps WSL/UNC canonicalization off the main event loop. */
export async function buildPromptAsync(opts: BuildPromptOptions): Promise<{
	prompt: string;
	safeAttachments: ChatAttachment[];
	resourcePaths: string[];
	safeVaultReferences: ResolvedVaultReference[];
}> {
	const vaultRoot = resolve(opts.vaultPath);
	const vaultRootReal = await realpath(vaultRoot).catch(() => vaultRoot);
	const managedSkillsRoot = managedSkillsDirectory();
	const managedSkillsRootReal = await realpath(managedSkillsRoot).catch(
		() => managedSkillsRoot,
	);
	const safeSkillContexts = (
		await Promise.all(
			requestedSkillContexts(opts).map(async (skillContext) => {
				const canonical = await realpath(resolve(skillContext)).catch(
					() => null,
				);
				return canonical &&
					(pathStartsWith(vaultRootReal, canonical) ||
						pathStartsWith(managedSkillsRootReal, canonical))
					? skillContext
					: null;
			}),
		)
	).filter((value): value is string => value !== null);
	const safeAttachments = (
		await Promise.all(
			(opts.attachments ?? []).map(async (attachment) => {
				if (
					opts.runtimeCwd &&
					!isPathAccessibleFromRuntime(opts.runtimeCwd, attachment.path)
				) {
					return null;
				}
				const canonical = await realpath(resolve(attachment.path)).catch(
					() => null,
				);
				if (!canonical) return null;
				if (pathStartsWith(vaultRootReal, canonical)) return attachment;
				if (pathStartsWith(artifactsDirectory(), canonical)) return attachment;
				return opts.allowedAgentRealPaths.some((root) =>
					pathStartsWith(root, canonical),
				)
					? attachment
					: null;
			}),
		)
	).filter((value): value is ChatAttachment => value !== null);
	const safeVaultReferences = await resolveVaultReferences({
		vaultPath: opts.vaultPath,
		references: opts.vaultReferences,
		runtimeCwd: opts.runtimeCwd,
	});
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
		safeVaultReferences,
		instructionFile,
	);
}
