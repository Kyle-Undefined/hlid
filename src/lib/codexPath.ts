import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

let _cached: string | undefined;
let _resolved = false;

export function resolveCodexExecutable(): string | undefined {
	if (_resolved) return _cached;

	const env = process.env.HLID_CODEX_EXE;
	if (env && existsSync(env)) {
		_cached = env;
		_resolved = true;
		return _cached;
	}

	const exeNames =
		process.platform === "win32" ? ["codex.exe", "codex.cmd"] : ["codex"];
	const pathDirs = (process.env.PATH ?? "").split(delimiter);
	for (const dir of pathDirs) {
		if (!dir) continue;
		for (const exeName of exeNames) {
			const candidate = join(dir, exeName);
			if (existsSync(candidate)) {
				_cached = candidate;
				_resolved = true;
				return _cached;
			}
		}
	}

	_cached = undefined;
	_resolved = true;
	return _cached;
}

export function __resetCacheForTesting(): void {
	_cached = undefined;
	_resolved = false;
}
