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
 * 2. Standalone Claude Code CLI on PATH / common per-user install locations
 * 3. Linux x64: fall back to SDK glibc variant when musl libc is absent
 * 4. Undefined → SDK picks its own bundled binary
 */
export function resolveClaudeExecutable(): string | undefined {
	if (_resolved) return _cached;

	let result: string | undefined;

	// Explicit override always wins
	const env = process.env.HLID_CLAUDE_EXE;
	if (env && existsSync(env)) {
		result = env;
	} else {
		const candidates: string[] = [];
		const exeNames =
			process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
		const pathDirs = (process.env.PATH ?? "").split(delimiter);
		for (const dir of pathDirs) {
			if (!dir) continue;
			for (const exeName of exeNames) candidates.push(join(dir, exeName));
		}
		const home =
			process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
		if (home) {
			for (const exeName of exeNames) {
				candidates.push(join(home, ".local", "bin", exeName));
			}
		}
		for (const candidate of candidates) {
			if (existsSync(candidate)) {
				result = candidate;
				break;
			}
		}
	}

	if (!result && process.platform === "linux" && process.arch === "x64") {
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
