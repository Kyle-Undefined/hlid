import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

let _cached: string | undefined;
let _resolved = false;

/**
 * Resolve the path to the Claude Code CLI executable.
 * Result is cached after first call — PATH scanning on Windows is expensive
 * (synchronous existsSync over many directories blocks the event loop).
 *
 * Priority:
 * 1. HLID_CLAUDE_EXE env override (any platform)
 * 2. Linux x64: fall back to glibc variant when musl libc is absent
 * 3. Windows: search PATH + common per-user install location
 * 4. Undefined → SDK picks its own bundled binary
 */
export function resolveClaudeExecutable(): string | undefined {
	if (_resolved) return _cached;

	let result: string | undefined;

	// Explicit override always wins
	const env = process.env.HLID_CLAUDE_EXE;
	if (env && existsSync(env)) {
		result = env;
	} else if (process.platform === "linux" && process.arch === "x64") {
		// On linux x64, SDK prefers musl binary but WSL2/glibc systems can't run it.
		// Fall back to glibc variant if musl libc is absent.
		const muslLib = "/lib/ld-musl-x86_64.so.1";
		if (!existsSync(muslLib)) {
			const glibcBin = resolve(
				import.meta.dirname,
				"../../node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
			);
			if (existsSync(glibcBin)) result = glibcBin;
		}
	} else if (process.platform === "win32") {
		// On Windows the SDK has no native binary package on npm. Find the standalone
		// Claude Code CLI on PATH (or in the common per-user install dir).
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
			if (existsSync(c)) {
				result = c;
				break;
			}
		}
	}

	_cached = result;
	_resolved = true;
	return _cached;
}

/** @internal — resets cache to initial state; for testing only. */
export function __resetCacheForTesting(): void {
	_cached = undefined;
	_resolved = false;
}
