import { existsSync } from "node:fs";
import { delimiter, join, win32 } from "node:path";

let _cached: string | undefined;
let _resolved = false;

export function findCodexExecutable(input: {
	platform: string;
	override?: string;
	path?: string;
	pathDelimiter?: string;
	exists: (path: string) => boolean;
}): string | undefined {
	if (input.override && input.exists(input.override)) return input.override;

	const windows = input.platform === "win32";
	const exeNames = windows ? ["codex.exe", "codex.cmd"] : ["codex"];
	const pathDelimiter = input.pathDelimiter ?? (windows ? ";" : ":");
	const joinPath = windows ? win32.join : join;
	for (const dir of (input.path ?? "").split(pathDelimiter)) {
		if (!dir) continue;
		for (const exeName of exeNames) {
			const candidate = joinPath(dir, exeName);
			if (input.exists(candidate)) return candidate;
		}
	}
	return undefined;
}

export function resolveCodexExecutable(): string | undefined {
	if (_resolved) return _cached;
	_cached = findCodexExecutable({
		platform: process.platform,
		override: process.env.HLID_CODEX_EXE,
		path: process.env.PATH,
		pathDelimiter: delimiter,
		exists: existsSync,
	});
	_resolved = true;
	return _cached;
}

export function __resetCacheForTesting(): void {
	_cached = undefined;
	_resolved = false;
}
