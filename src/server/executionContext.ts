import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseWslUnc, pathStartsWith, samePath } from "../lib/paths";
import type { ChatAttachment } from "./protocol";
import { wrapperPathForAgent, writeWrapper } from "./wrappers";

export type ResolveExecutionContextOptions = {
	agentMode: "cwd" | "context";
	agentCwd: string | undefined;
	vaultPath: string;
	allowedAgentRealPaths: string[];
	claudeExecutable: string | undefined;
	wrapperCommand?: "claude" | "codex";
	safeAttachments: ChatAttachment[];
};

/**
 * Resolves the working directory, extra readable directories, and Claude
 * executable path for the current query.
 * Handles agent-cwd vs context modes, vault cross-references for attachments,
 * and WSL wrapper generation.
 */
export function resolveExecutionContext(opts: ResolveExecutionContextOptions): {
	activeCwd: string;
	extraDirs: Set<string>;
	executable: string | undefined;
} {
	const {
		agentMode,
		agentCwd,
		vaultPath,
		allowedAgentRealPaths,
		claudeExecutable,
		wrapperCommand = "claude",
		safeAttachments,
	} = opts;

	const activeCwd = agentMode === "cwd" && agentCwd ? agentCwd : vaultPath;
	// Build additionalDirectories so Claude can read attachments stored
	// under agents other than the current cwd. Include vault when agent
	// cwd is set (existing behavior) plus any registered agent root that
	// has an attachment referenced this turn. Context mode also needs the
	// agent dir on this list so CLAUDE.md is readable from the vault cwd.
	const extraDirs = new Set<string>();
	if (agentMode === "cwd" && agentCwd) extraDirs.add(resolve(vaultPath));
	if (agentMode === "context" && agentCwd) extraDirs.add(resolve(agentCwd));
	const activeCwdReal = resolve(activeCwd);
	for (const a of safeAttachments) {
		const p = resolve(a.path);
		for (const root of allowedAgentRealPaths) {
			if (!samePath(root, activeCwdReal) && pathStartsWith(root, p)) {
				extraDirs.add(root);
			}
		}
	}
	// WSL agents run the selected CLI inside Linux via a generated wrapper .cmd that
	// invokes `wsl.exe -d <distro> --cd <posix> -- <command>`. Native paths use
	// the standard Windows-side resolution. Selection is per-session based
	// on the active cwd's form.
	const wslParsed = parseWslUnc(activeCwd);
	let executable = claudeExecutable;
	if (wslParsed) {
		const wrapper = wrapperPathForAgent(activeCwd, wrapperCommand);
		if (existsSync(wrapper)) {
			executable = wrapper;
		} else {
			// Defensive: regenerate if config-writer never ran or file was
			// removed manually. Falls back to default exe on failure.
			const written = writeWrapper(activeCwd, wrapperCommand);
			if (written) executable = written;
		}
	}
	return { activeCwd, extraDirs, executable };
}
