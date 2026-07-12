/**
 * resolveShell — picks the executable + argv for a real (non-Claude) login
 * shell, for the Raven dev-terminal toggle. Always a login shell so profile
 * scripts (.bashrc, PowerShell $PROFILE — oh-my-posh/starship init usually
 * lives there) actually source.
 *
 * Three cases:
 * 1. Windows host, cwd is a `\\wsl$\<distro>\...` path → bridge into WSL via
 *    wsl.exe directly (not the .cmd-wrapper approach in wrappers.ts, which is
 *    file-based and built for launching the fixed `claude` command — this
 *    needs a plain argv for node-pty).
 * 2. Windows host, native cwd → PowerShell with no args, so $PROFILE loads.
 * 3. Non-Windows host (native Linux/macOS, or the server itself running
 *    inside WSL) → $SHELL as a login shell.
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { parseWslUnc } from "../lib/paths";

const isWindows = process.platform === "win32";

export interface ResolvedShell {
	executable: string;
	args: string[];
}

function resolvePwshOnPath(): string | undefined {
	const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
	for (const dir of dirs) {
		const candidate = join(dir, "pwsh.exe");
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

export function resolveShell(cwd: string): ResolvedShell {
	const wsl = parseWslUnc(cwd);
	if (wsl) {
		const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
		return {
			executable: join(systemRoot, "System32", "wsl.exe"),
			args: ["-d", wsl.distro, "--cd", wsl.posixPath, "--", "bash", "-l"],
		};
	}

	if (isWindows) {
		return { executable: resolvePwshOnPath() ?? "powershell.exe", args: [] };
	}

	return { executable: process.env.SHELL || "/bin/bash", args: ["-l"] };
}
