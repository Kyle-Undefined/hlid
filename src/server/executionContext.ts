import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, posix, resolve, win32 } from "node:path";
import { parseWslUncSyntax, pathStartsWith, samePath } from "../lib/paths";
import { artifactsDirectory, managedSkillsDirectory } from "./libraryStore";
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
	/** Exact Hlid-owned files referenced by the prompt (artifacts or skills). */
	resourcePaths?: string[];
};

type ExecutionContextDependencies = {
	platform: string;
	resolveWindowsWslHostPath: (path: string) => string | null;
	existsSync: typeof existsSync;
	wrapperPathForAgent: typeof wrapperPathForAgent;
	writeWrapper: typeof writeWrapper;
};

let cachedDefaultWslUncRoot: string | null | undefined;

/**
 * Convert a POSIX path to a host-visible UNC path rooted in the default WSL
 * distro. Keeping the UNC form is important: it gives the Windows SDK a valid
 * spawn cwd while retaining enough distro identity for provider path mapping.
 */
export function windowsWslHostPathFromRoot(
	path: string,
	defaultWslUncRoot: string,
): string | null {
	if (
		!posix.isAbsolute(path) ||
		path.startsWith("//") ||
		/["\r\n\0]/.test(path)
	) {
		return null;
	}
	const parsedRoot = parseWslUncSyntax(defaultWslUncRoot);
	if (!parsedRoot || parsedRoot.posixPath !== "/") return null;
	const normalized = posix.normalize(path);
	const root = `\\\\wsl.localhost\\${parsedRoot.distro}`;
	return normalized === "/"
		? `${root}\\`
		: `${root}${normalized.replaceAll("/", "\\")}`;
}

/**
 * Resolve a bare POSIX path through the default WSL distro on Windows. The
 * probe is lazy and cached because waking a cold distro can be comparatively
 * expensive. It runs only for paths whose syntax cannot be native Windows.
 */
export function resolveWindowsWslHostPath(path: string): string | null {
	if (process.platform !== "win32") return null;
	if (
		!posix.isAbsolute(path) ||
		path.startsWith("//") ||
		/["\r\n\0]/.test(path)
	) {
		return null;
	}
	if (cachedDefaultWslUncRoot === undefined) {
		try {
			const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
			const output = execFileSync(
				win32.join(systemRoot, "System32", "wsl.exe"),
				["--exec", "wslpath", "-w", "/"],
				{
					encoding: "utf-8",
					timeout: 5_000,
					windowsHide: true,
				},
			)
				.replaceAll("\0", "")
				.trim();
			const parsed = parseWslUncSyntax(output);
			cachedDefaultWslUncRoot =
				parsed?.posixPath === "/"
					? `\\\\wsl.localhost\\${parsed.distro}\\`
					: null;
		} catch {
			cachedDefaultWslUncRoot = null;
		}
	}
	return cachedDefaultWslUncRoot
		? windowsWslHostPathFromRoot(path, cachedDefaultWslUncRoot)
		: null;
}

function executionContextDependencies(
	overrides: Partial<ExecutionContextDependencies> = {},
): ExecutionContextDependencies {
	return {
		platform: process.platform,
		resolveWindowsWslHostPath,
		existsSync,
		wrapperPathForAgent,
		writeWrapper,
		...overrides,
	};
}

/** Normalize only unambiguously POSIX paths when Hlid itself runs on Windows. */
export function normalizeProviderCwd(
	path: string,
	dependencies: Pick<
		ExecutionContextDependencies,
		"platform" | "resolveWindowsWslHostPath"
	> = executionContextDependencies(),
): string {
	if (
		dependencies.platform !== "win32" ||
		!posix.isAbsolute(path) ||
		path.startsWith("//")
	) {
		return path;
	}
	return dependencies.resolveWindowsWslHostPath(path) ?? path;
}

/** Resolve the native or per-WSL wrapper executable that owns a provider cwd. */
export function resolveProviderExecutableForCwd(
	activeCwd: string,
	executable: string | undefined,
	wrapperCommand: "claude" | "codex",
	dependencyOverrides: Partial<ExecutionContextDependencies> = {},
): string | undefined {
	const dependencies = executionContextDependencies(dependencyOverrides);
	if (dependencies.platform !== "win32" || !parseWslUncSyntax(activeCwd)) {
		return executable;
	}
	const wrapper = dependencies.wrapperPathForAgent(activeCwd, wrapperCommand);
	if (dependencies.existsSync(wrapper)) return wrapper;
	return dependencies.writeWrapper(activeCwd, wrapperCommand) ?? executable;
}

/**
 * Resolves the working directory, extra readable directories, and Claude
 * executable path for the current query.
 * Handles agent-cwd vs context modes, vault cross-references for attachments,
 * and WSL wrapper generation.
 */
export function resolveExecutionContext(
	opts: ResolveExecutionContextOptions,
	dependencyOverrides: Partial<ExecutionContextDependencies> = {},
): {
	activeCwd: string;
	extraDirs: Set<string>;
	executable: string | undefined;
} {
	const dependencies = executionContextDependencies(dependencyOverrides);
	const {
		agentMode,
		agentCwd,
		vaultPath,
		allowedAgentRealPaths,
		claudeExecutable,
		wrapperCommand = "claude",
		safeAttachments,
		resourcePaths = [],
	} = opts;

	const normalizePath = (path: string) =>
		normalizeProviderCwd(path, dependencies);
	const hostResolve =
		dependencies.platform === "win32" ? win32.resolve : resolve;
	const hostDirname =
		dependencies.platform === "win32" ? win32.dirname : dirname;
	const declaredActiveCwd =
		agentMode === "cwd" && agentCwd ? agentCwd : vaultPath;
	const activeCwd = normalizePath(declaredActiveCwd);
	// Build additionalDirectories so Claude can read attachments stored
	// under agents other than the current cwd. Include vault when agent
	// cwd is set (existing behavior) plus any registered agent root that
	// has an attachment referenced this turn. Context mode also needs the
	// agent dir on this list so CLAUDE.md is readable from the vault cwd.
	const extraDirs = new Set<string>();
	if (agentMode === "cwd" && agentCwd)
		extraDirs.add(hostResolve(normalizePath(vaultPath)));
	if (agentMode === "context" && agentCwd)
		extraDirs.add(hostResolve(normalizePath(agentCwd)));
	const activeCwdReal = hostResolve(activeCwd);
	for (const a of safeAttachments) {
		const p = hostResolve(normalizePath(a.path));
		if (pathStartsWith(artifactsDirectory(), p)) {
			// Grant only the immutable artifact directory, never the whole library.
			extraDirs.add(hostDirname(p));
			continue;
		}
		for (const root of allowedAgentRealPaths) {
			const normalizedRoot = hostResolve(normalizePath(root));
			if (
				!samePath(normalizedRoot, activeCwdReal) &&
				pathStartsWith(normalizedRoot, p)
			) {
				extraDirs.add(normalizedRoot);
			}
		}
	}
	for (const resourcePath of resourcePaths) {
		const p = hostResolve(normalizePath(resourcePath));
		if (
			pathStartsWith(artifactsDirectory(), p) ||
			pathStartsWith(managedSkillsDirectory(), p)
		) {
			extraDirs.add(hostDirname(p));
		}
	}
	// WSL agents run the selected CLI inside Linux via a generated wrapper .cmd that
	// invokes `wsl.exe -d <distro> --cd <posix> -- <command>`. Native paths use
	// the standard Windows-side resolution. Selection is per-session based
	// on the active cwd's form.
	const executable = resolveProviderExecutableForCwd(
		activeCwd,
		claudeExecutable,
		wrapperCommand,
		dependencies,
	);
	return { activeCwd, extraDirs, executable };
}
