import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

/**
 * Resolve the path to the Claude Code CLI executable.
 *
 * Priority:
 * 1. HLID_CLAUDE_EXE env override (any platform)
 * 2. Linux x64: fall back to glibc variant when musl libc is absent
 * 3. Windows: search PATH + common per-user install location
 * 4. Undefined → SDK picks its own bundled binary
 */
export function resolveClaudeExecutable(): string | undefined {
	// Explicit override always wins
	const env = process.env.HLID_CLAUDE_EXE;
	if (env && existsSync(env)) return env;

	// On linux x64, SDK prefers musl binary but WSL2/glibc systems can't run it.
	// Fall back to glibc variant if musl libc is absent.
	if (process.platform === "linux" && process.arch === "x64") {
		const muslLib = "/lib/ld-musl-x86_64.so.1";
		if (!existsSync(muslLib)) {
			const glibcBin = resolve(
				import.meta.dirname,
				"../../node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
			);
			if (existsSync(glibcBin)) return glibcBin;
		}
	}

	// On Windows the SDK has no native binary package on npm. Find the standalone
	// Claude Code CLI on PATH (or in the common per-user install dir).
	if (process.platform === "win32") {
		const candidates: string[] = [];
		const pathDirs = (process.env.PATH ?? "").split(delimiter);
		for (const dir of pathDirs) {
			if (!dir) continue;
			candidates.push(join(dir, "claude.exe"));
			candidates.push(join(dir, "claude.cmd"));
		}
		const home = process.env.USERPROFILE;
		if (home) {
			candidates.push(join(home, ".local", "bin", "claude.exe"));
			candidates.push(join(home, ".local", "bin", "claude.cmd"));
		}
		for (const c of candidates) {
			if (existsSync(c)) return c;
		}
	}

	return undefined;
}
