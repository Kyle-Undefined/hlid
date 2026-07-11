import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

let _cached: string | undefined;
let _resolved = false;

function standaloneCandidates(): string[] {
	const executableNames =
		process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
	const candidates = (process.env.PATH ?? "")
		.split(delimiter)
		.filter(Boolean)
		.flatMap((directory) =>
			executableNames.map((name) => join(directory, name)),
		);
	const home =
		process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
	if (home) {
		candidates.push(
			...executableNames.map((name) => join(home, ".local", "bin", name)),
		);
	}
	return candidates;
}

function firstExisting(paths: string[]): string | undefined {
	return paths.find((path) => existsSync(path));
}

function resolveLinuxGlibcFallback(): string | undefined {
	if (process.platform !== "linux" || process.arch !== "x64") return undefined;
	if (existsSync("/lib/ld-musl-x86_64.so.1")) return undefined;
	const executable = resolve(
		import.meta.dirname,
		"../../node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
	);
	return existsSync(executable) ? executable : undefined;
}

function resolveUncached(): string | undefined {
	const override = process.env.HLID_CLAUDE_EXE;
	if (override && existsSync(override)) return override;
	return firstExisting(standaloneCandidates()) ?? resolveLinuxGlibcFallback();
}

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
	_cached = resolveUncached();
	_resolved = true;
	return _cached;
}

/** @internal — resets cache to initial state; for testing only. */
export function __resetCacheForTesting(): void {
	_cached = undefined;
	_resolved = false;
}
