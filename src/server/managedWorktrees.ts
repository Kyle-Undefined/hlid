import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename, dirname, join, posix, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { parseWslUncSyntax } from "../lib/paths";

const execFileAsync = promisify(execFile);
const MANAGED_WORKTREE_PARENT = ".hlid-worktrees";

export class ManagedWorktreeUnavailableError extends Error {}

export type ManagedWorktreeReceipt = {
	sourceWorkspace: string;
	executionWorkspace: string;
	worktreeRoot: string;
	branch: string;
	baseCommit: string;
	environment: "windows" | "wsl" | "native";
	dirtySource: boolean;
};

type GitContext = {
	environment: ManagedWorktreeReceipt["environment"];
	sourceWorkspace: string;
	sourceRuntimePath: string;
	toHostPath(path: string): string;
	run(cwd: string, args: string[]): Promise<string>;
};

function commandError(error: unknown): string {
	if (!error || typeof error !== "object") return String(error);
	const value = error as { message?: string; stderr?: string; stdout?: string };
	return (
		value.stderr ||
		value.stdout ||
		value.message ||
		String(error)
	).trim();
}

async function runExecutable(
	executable: string,
	args: string[],
): Promise<string> {
	const result = await execFileAsync(executable, args, {
		windowsHide: true,
		maxBuffer: 4 * 1024 * 1024,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	return result.stdout.trim();
}

async function gitContext(sourceWorkspace: string): Promise<GitContext> {
	const source = await realpath(resolve(sourceWorkspace));
	const wsl = parseWslUncSyntax(source);
	if (process.platform === "win32" && wsl) {
		const share = source.match(/^(\\\\(?:wsl\$|wsl\.localhost)\\[^\\]+)/i)?.[1];
		if (!share) {
			throw new ManagedWorktreeUnavailableError(
				"The WSL workspace share could not be resolved.",
			);
		}
		return {
			environment: "wsl",
			sourceWorkspace: source,
			sourceRuntimePath: wsl.posixPath,
			toHostPath: (path) =>
				`${share}\\${path.replace(/^\/+/, "").replaceAll("/", "\\")}`,
			run: (cwd, args) =>
				runExecutable("wsl.exe", [
					"-d",
					wsl.distro,
					"--exec",
					"git",
					"-C",
					cwd,
					...args,
				]),
		};
	}
	return {
		environment: process.platform === "win32" ? "windows" : "native",
		sourceWorkspace: source,
		sourceRuntimePath: source,
		toHostPath: (path) => path,
		run: (cwd, args) => runExecutable("git", ["-C", cwd, ...args]),
	};
}

async function requireGitRoot(context: GitContext): Promise<string> {
	try {
		const bare = await context.run(context.sourceRuntimePath, [
			"rev-parse",
			"--is-bare-repository",
		]);
		if (bare === "true") {
			throw new ManagedWorktreeUnavailableError(
				"Bare repositories cannot host delegated worktrees.",
			);
		}
		return await context.run(context.sourceRuntimePath, [
			"rev-parse",
			"--show-toplevel",
		]);
	} catch (error) {
		if (error instanceof ManagedWorktreeUnavailableError) throw error;
		throw new ManagedWorktreeUnavailableError(
			`The selected workspace is not an available Git worktree: ${commandError(error)}`,
		);
	}
}

function runtimeRelative(context: GitContext, root: string): string {
	const value =
		context.environment === "wsl"
			? posix.relative(root, context.sourceRuntimePath)
			: relative(root, context.sourceRuntimePath);
	if (value === "" || value === ".") return "";
	if (value === ".." || value.startsWith("../") || value.startsWith("..\\")) {
		throw new ManagedWorktreeUnavailableError(
			"The selected workspace is outside its reported Git root.",
		);
	}
	return value;
}

export async function createManagedWorktree(
	sourceWorkspace: string,
	delegationId: string,
	options: { explicit: boolean },
): Promise<ManagedWorktreeReceipt> {
	const context = await gitContext(sourceWorkspace);
	const root = await requireGitRoot(context);
	const sourceRelative = runtimeRelative(context, root);
	const [baseCommit, status] = await Promise.all([
		context.run(root, ["rev-parse", "HEAD"]),
		context.run(root, ["status", "--porcelain=v1", "--untracked-files=normal"]),
	]);
	const dirtySource = status.length > 0;
	if (dirtySource && !options.explicit) {
		throw new Error(
			"The selected workspace has uncommitted or untracked changes. Choose workspace_mode=shared to include them, or workspace_mode=worktree to explicitly start from HEAD without them.",
		);
	}
	const shortId = delegationId.replaceAll("-", "").slice(0, 16);
	const branch = `hlid/delegation-${shortId}`;
	const targetRoot =
		context.environment === "wsl"
			? posix.join(
					posix.dirname(root),
					MANAGED_WORKTREE_PARENT,
					posix.basename(root),
					shortId,
				)
			: join(dirname(root), MANAGED_WORKTREE_PARENT, basename(root), shortId);
	try {
		await context.run(root, [
			"worktree",
			"add",
			"-b",
			branch,
			targetRoot,
			baseCommit,
		]);
	} catch (error) {
		throw new Error(
			`Could not create the delegated Git worktree: ${commandError(error)}`,
		);
	}
	const executionRuntimePath = sourceRelative
		? context.environment === "wsl"
			? posix.join(targetRoot, sourceRelative)
			: join(targetRoot, sourceRelative)
		: targetRoot;
	return {
		sourceWorkspace: context.sourceWorkspace,
		executionWorkspace: context.toHostPath(executionRuntimePath),
		worktreeRoot: context.toHostPath(targetRoot),
		branch,
		baseCommit,
		environment: context.environment,
		dirtySource,
	};
}

export type ManagedWorktreeCleanupInspection = {
	dirty: boolean;
	uniqueCommits: number;
	worktreeRoot: string;
};

export async function inspectManagedWorktreeCleanup(
	executionWorkspace: string,
	baseCommit: string,
): Promise<ManagedWorktreeCleanupInspection> {
	const context = await gitContext(executionWorkspace);
	const root = await requireGitRoot(context);
	const [status, uniqueRaw] = await Promise.all([
		context.run(root, ["status", "--porcelain=v1", "--untracked-files=normal"]),
		context.run(root, ["rev-list", "--count", `${baseCommit}..HEAD`]),
	]);
	return {
		dirty: status.length > 0,
		uniqueCommits: Number.parseInt(uniqueRaw, 10) || 0,
		worktreeRoot: context.toHostPath(root),
	};
}

export async function removeManagedWorktree(input: {
	sourceWorkspace: string;
	executionWorkspace: string;
	branch: string;
	baseCommit: string;
}): Promise<ManagedWorktreeCleanupInspection> {
	const inspection = await inspectManagedWorktreeCleanup(
		input.executionWorkspace,
		input.baseCommit,
	);
	if (inspection.dirty || inspection.uniqueCommits > 0) return inspection;
	const source = await gitContext(input.sourceWorkspace);
	const sourceRoot = await requireGitRoot(source);
	const worktree = await gitContext(input.executionWorkspace);
	const worktreeRootRuntime = await requireGitRoot(worktree);
	await source.run(sourceRoot, ["worktree", "remove", worktreeRootRuntime]);
	await source.run(sourceRoot, ["branch", "-D", input.branch]);
	return inspection;
}
