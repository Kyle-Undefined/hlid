import { createHash } from "node:crypto";
import {
	lstat,
	readdir,
	readFile,
	realpath,
	stat,
	unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { writeFileAtomic } from "../lib/atomicFile";
import {
	expandTilde,
	parseWslUnc,
	toHostRuntimePath,
	toProviderRuntimePath,
} from "../lib/paths";
import { runBoundedProcess } from "../lib/process";
import type {
	ProviderSavedWorkflow,
	ProviderWorkflowCatalog,
	ProviderWorkflowDeleteInput,
	ProviderWorkflowSaveInput,
	ProviderWorkflowSaveLocation,
	ProviderWorkflowSaveScope,
	ProviderWorkflowSourceInput,
} from "./agentProvider";

const MAX_WORKFLOW_SCRIPT_BYTES = 1024 * 1024;
const WSL_CLAUDE_CONFIG_DIR_MARKER = "__HLID_FORK_CLAUDE_CONFIG_DIR__";
const WSL_CLAUDE_CONFIG_DIR_TIMEOUT_MS = 4_000;
const WORKFLOW_FILENAME_RE = /\.js$/i;
const WORKFLOW_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

type WorkflowMeta = {
	name: string;
	description: string;
};

type WorkflowRuntimeContext = {
	runtimeCwd: string;
	hostCwd: string;
	configDir: string;
	explicitConfigDir?: string;
};

export class ClaudeWorkflowSaveError extends Error {
	constructor(
		message: string,
		readonly code:
			| "exists"
			| "invalid-script"
			| "location-unavailable"
			| "unsafe-path",
	) {
		super(message);
		this.name = "ClaudeWorkflowSaveError";
	}
}

export class ClaudeWorkflowDeleteError extends Error {
	constructor(
		message: string,
		readonly code: "not-found" | "location-unavailable" | "unsafe-path",
	) {
		super(message);
		this.name = "ClaudeWorkflowDeleteError";
	}
}

export class ClaudeWorkflowSourceError extends Error {
	constructor(
		message: string,
		readonly code:
			| "not-found"
			| "invalid-script"
			| "location-unavailable"
			| "unsafe-path",
	) {
		super(message);
		this.name = "ClaudeWorkflowSourceError";
	}
}

function isWithin(root: string, candidate: string): boolean {
	const value = relative(root, candidate);
	return (
		value === "" ||
		(!value.startsWith("..") &&
			!value.startsWith("/") &&
			!value.startsWith("\\"))
	);
}

function unescapeJsString(value: string): string {
	return value.replace(
		/\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(.))/g,
		(_match, unicode: string | undefined, hex: string | undefined, escaped) => {
			if (unicode) return String.fromCharCode(Number.parseInt(unicode, 16));
			if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
			switch (escaped) {
				case "n":
					return "\n";
				case "r":
					return "\r";
				case "t":
					return "\t";
				case "b":
					return "\b";
				case "f":
					return "\f";
				case "v":
					return "\v";
				case "0":
					return "\0";
				default:
					return escaped ?? "";
			}
		},
	);
}

function metaString(source: string, property: "name" | "description"): string {
	const metaStart = source.search(/\bexport\s+const\s+meta\s*=/);
	if (metaStart < 0) return "";
	const prefix = source.slice(metaStart, metaStart + 64 * 1024);
	const pattern = new RegExp(
		`\\b${property}\\s*:\\s*(['"])((?:\\\\.|[^\\\\])*?)\\1`,
	);
	const match = prefix.match(pattern);
	return match?.[2] ? unescapeJsString(match[2]).trim() : "";
}

function parseWorkflowMeta(source: string): WorkflowMeta {
	const name = metaString(source, "name");
	if (!WORKFLOW_NAME_RE.test(name) || name === "." || name === "..") {
		throw new ClaudeWorkflowSaveError(
			"The workflow script does not contain a safe literal meta.name.",
			"invalid-script",
		);
	}
	return {
		name,
		description: metaString(source, "description") || `Run ${name}`,
	};
}

async function readWorkflowScript(path: string): Promise<{
	content: string;
	meta: WorkflowMeta;
}> {
	const info = await lstat(path).catch(() => null);
	if (!info?.isFile() || info.isSymbolicLink()) {
		throw new ClaudeWorkflowSaveError(
			"The persisted workflow script is unavailable.",
			"invalid-script",
		);
	}
	if (info.size > MAX_WORKFLOW_SCRIPT_BYTES) {
		throw new ClaudeWorkflowSaveError(
			"The workflow script is larger than 1 MiB.",
			"invalid-script",
		);
	}
	const content = await readFile(path, "utf8");
	return { content, meta: parseWorkflowMeta(content) };
}

/** Resolve the WSL user's native Claude config directory onto the Windows host. */
export async function resolveWslClaudeConfigDir(
	cwd: string | undefined,
): Promise<string | undefined> {
	const parsed = cwd ? parseWslUnc(cwd) : null;
	if (!parsed) return undefined;
	try {
		const result = await runBoundedProcess(
			"wsl.exe",
			[
				"-d",
				parsed.distro,
				"--",
				"sh",
				"-lc",
				`printf '${WSL_CLAUDE_CONFIG_DIR_MARKER}%s' "$HOME/.claude"`,
			],
			{
				timeoutMs: WSL_CLAUDE_CONFIG_DIR_TIMEOUT_MS,
				timeoutError: "WSL $HOME/.claude probe timed out",
			},
		);
		if (result.code !== 0) return undefined;
		const markerIndex = result.output.lastIndexOf(WSL_CLAUDE_CONFIG_DIR_MARKER);
		if (markerIndex < 0) return undefined;
		const posixPath = result.output
			.slice(markerIndex + WSL_CLAUDE_CONFIG_DIR_MARKER.length)
			.trim();
		if (!posixPath.startsWith("/") || /[\r\n]/.test(posixPath)) {
			return undefined;
		}
		return toHostRuntimePath(cwd ?? "", posixPath);
	} catch {
		return undefined;
	}
}

async function runtimeContext(
	runtimeCwd: string,
	explicitConfigDir?: string,
): Promise<WorkflowRuntimeContext> {
	const hostCwd = await realpath(runtimeCwd).catch(async () => {
		const hostPath = toHostRuntimePath(runtimeCwd, runtimeCwd);
		return realpath(hostPath);
	});
	let configDir: string | undefined;
	if (explicitConfigDir?.trim()) {
		const expanded = parseWslUnc(runtimeCwd)
			? explicitConfigDir
			: expandTilde(explicitConfigDir);
		configDir = toHostRuntimePath(runtimeCwd, expanded);
	}
	configDir ??= await resolveWslClaudeConfigDir(runtimeCwd);
	configDir ??= resolve(homedir(), ".claude");
	return {
		runtimeCwd,
		hostCwd,
		configDir,
		...(explicitConfigDir ? { explicitConfigDir } : {}),
	};
}

async function findRepositoryRoot(start: string): Promise<string> {
	let current = start;
	while (true) {
		if (await stat(join(current, ".git")).catch(() => null)) return current;
		const parent = dirname(current);
		if (parent === current) return start;
		current = parent;
	}
}

function directoriesToRoot(start: string, root: string): string[] {
	const directories: string[] = [];
	let current = start;
	while (true) {
		directories.push(current);
		if (current === root) break;
		const parent = dirname(current);
		if (parent === current || !isWithin(root, parent)) break;
		current = parent;
	}
	return directories;
}

async function projectWorkflowDirectories(
	hostCwd: string,
): Promise<{ root: string; existing: string[]; saveDirectory: string }> {
	const root = await findRepositoryRoot(hostCwd);
	const candidates = directoriesToRoot(hostCwd, root).map((directory) =>
		join(directory, ".claude", "workflows"),
	);
	const existing: string[] = [];
	for (const candidate of candidates) {
		const info = await lstat(candidate).catch(() => null);
		if (info) existing.push(candidate);
	}
	return {
		root,
		existing,
		saveDirectory: existing[0] ?? join(root, ".claude", "workflows"),
	};
}

async function inspectSaveLocation(
	context: WorkflowRuntimeContext,
	scope: ProviderWorkflowSaveScope,
): Promise<ProviderWorkflowSaveLocation> {
	const scopeLabel = scope === "project" ? "Project" : "Personal";
	try {
		const directory =
			scope === "project"
				? (await projectWorkflowDirectories(context.hostCwd)).saveDirectory
				: join(context.configDir, "workflows");
		if (scope === "project") {
			const claudeDir = dirname(directory);
			for (const path of [claudeDir, directory]) {
				const info = await lstat(path).catch(() => null);
				if (info?.isSymbolicLink()) {
					return {
						scope,
						scopeLabel,
						path: toProviderRuntimePath(context.runtimeCwd, directory),
						available: false,
						error: `${path === claudeDir ? ".claude" : ".claude/workflows"} is a symbolic link`,
					};
				}
			}
		}
		return {
			scope,
			scopeLabel,
			path: toProviderRuntimePath(context.runtimeCwd, directory),
			available: true,
		};
	} catch (error) {
		return {
			scope,
			scopeLabel,
			path: "",
			available: false,
			error:
				error instanceof Error
					? error.message
					: "Workflow location unavailable",
		};
	}
}

async function workflowsInDirectory(
	context: WorkflowRuntimeContext,
	directory: string,
	scope: ProviderWorkflowSaveScope,
): Promise<ProviderSavedWorkflow[]> {
	if (scope === "project") {
		const info = await lstat(directory).catch(() => null);
		if (!info?.isDirectory() || info.isSymbolicLink()) return [];
	}
	const entries = await readdir(directory, { withFileTypes: true }).catch(
		() => [],
	);
	const workflows: ProviderSavedWorkflow[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !WORKFLOW_FILENAME_RE.test(entry.name)) continue;
		const hostPath = join(directory, entry.name);
		try {
			const { meta } = await readWorkflowScript(hostPath);
			const scriptPath = toProviderRuntimePath(context.runtimeCwd, hostPath);
			workflows.push({
				id: `claude-workflow:${createHash("sha256")
					.update(`${scope}\0${scriptPath}`)
					.digest("hex")
					.slice(0, 24)}`,
				name: meta.name,
				description: meta.description,
				argumentHint: "[input]",
				scriptPath,
				scope,
				scopeLabel: scope === "project" ? "Project" : "Personal",
				availableAsCommand: true,
			});
		} catch {
			// Claude ignores invalid workflow scripts; keep Hlid's catalog aligned.
		}
	}
	return workflows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listClaudeWorkflows(
	runtimeCwd: string,
	explicitConfigDir?: string,
): Promise<ProviderWorkflowCatalog> {
	const context = await runtimeContext(runtimeCwd, explicitConfigDir);
	const project = await projectWorkflowDirectories(context.hostCwd);
	const projectWorkflows = (
		await Promise.all(
			project.existing.map((directory) =>
				workflowsInDirectory(context, directory, "project"),
			),
		)
	).flat();
	const personalWorkflows = await workflowsInDirectory(
		context,
		join(context.configDir, "workflows"),
		"personal",
	);
	const seen = new Set<string>();
	const workflows = [...projectWorkflows, ...personalWorkflows].map(
		(workflow) => {
			const key = workflow.name.toLowerCase();
			const availableAsCommand = !seen.has(key);
			seen.add(key);
			return { ...workflow, availableAsCommand };
		},
	);
	const locations = await Promise.all([
		inspectSaveLocation(context, "project"),
		inspectSaveLocation(context, "personal"),
	]);
	return { workflows, locations };
}

async function authorizeSource(
	context: WorkflowRuntimeContext,
	sourceScriptPath: string,
): Promise<string> {
	const source = toHostRuntimePath(context.runtimeCwd, sourceScriptPath);
	const projectsRoot = await realpath(
		join(context.configDir, "projects"),
	).catch(() => null);
	const sourceReal = await realpath(source).catch(() => null);
	if (!projectsRoot || !sourceReal || !isWithin(projectsRoot, sourceReal)) {
		throw new ClaudeWorkflowSaveError(
			"Only scripts persisted by this Claude runtime can be saved.",
			"unsafe-path",
		);
	}
	return sourceReal;
}

async function authorizeDestination(
	context: WorkflowRuntimeContext,
	scope: ProviderWorkflowSaveScope,
	name: string,
	overwrite: boolean,
): Promise<string> {
	const directory =
		scope === "project"
			? (await projectWorkflowDirectories(context.hostCwd)).saveDirectory
			: join(context.configDir, "workflows");
	if (scope === "project") {
		const root = await realpath(
			(await projectWorkflowDirectories(context.hostCwd)).root,
		).catch(() => null);
		if (!root) {
			throw new ClaudeWorkflowSaveError(
				"The project workflow location is unavailable.",
				"location-unavailable",
			);
		}
		for (const path of [dirname(directory), directory]) {
			const info = await lstat(path).catch(() => null);
			if (info?.isSymbolicLink()) {
				throw new ClaudeWorkflowSaveError(
					"Claude refuses to save through a project workflow symlink.",
					"unsafe-path",
				);
			}
			if (info) {
				const real = await realpath(path);
				if (!isWithin(root, real)) {
					throw new ClaudeWorkflowSaveError(
						"The project workflow location resolves outside the repository.",
						"unsafe-path",
					);
				}
			}
		}
	}
	const target = join(directory, `${name}.js`);
	const existing = await lstat(target).catch(() => null);
	if (existing?.isSymbolicLink()) {
		throw new ClaudeWorkflowSaveError(
			"Claude refuses to replace a saved workflow symbolic link.",
			"unsafe-path",
		);
	}
	if (existing && !existing.isFile()) {
		throw new ClaudeWorkflowSaveError(
			"The saved workflow target is not a file.",
			"unsafe-path",
		);
	}
	if (existing && !overwrite) {
		throw new ClaudeWorkflowSaveError(
			`/${name} already exists in the ${scope} workflow location.`,
			"exists",
		);
	}
	return target;
}

export async function saveClaudeWorkflow(
	input: ProviderWorkflowSaveInput,
	explicitConfigDir?: string,
): Promise<ProviderSavedWorkflow> {
	const context = await runtimeContext(input.cwd, explicitConfigDir);
	const source = await authorizeSource(context, input.sourceScriptPath);
	const { content, meta } = await readWorkflowScript(source);
	const target = await authorizeDestination(
		context,
		input.scope,
		meta.name,
		input.overwrite === true,
	);
	await writeFileAtomic(target, content, { mode: 0o600 });
	const targetProviderPath = toProviderRuntimePath(input.cwd, target);
	const catalog = await listClaudeWorkflows(input.cwd, explicitConfigDir);
	const saved = catalog.workflows.find(
		(workflow) => workflow.scriptPath === targetProviderPath,
	);
	if (!saved) {
		throw new ClaudeWorkflowSaveError(
			"The workflow was saved but could not be rediscovered.",
			"location-unavailable",
		);
	}
	return saved;
}

async function deletionDirectories(
	context: WorkflowRuntimeContext,
	scope: ProviderWorkflowSaveScope,
): Promise<string[]> {
	if (scope === "personal") {
		const directory = join(context.configDir, "workflows");
		const resolved = await realpath(directory).catch(() => null);
		return resolved ? [resolved] : [];
	}

	const project = await projectWorkflowDirectories(context.hostCwd);
	const root = await realpath(project.root).catch(() => null);
	if (!root) return [];
	const directories: string[] = [];
	for (const directory of project.existing) {
		const claudeDirectory = dirname(directory);
		const [claudeInfo, workflowInfo] = await Promise.all([
			lstat(claudeDirectory).catch(() => null),
			lstat(directory).catch(() => null),
		]);
		if (
			!claudeInfo?.isDirectory() ||
			claudeInfo.isSymbolicLink() ||
			!workflowInfo?.isDirectory() ||
			workflowInfo.isSymbolicLink()
		) {
			continue;
		}
		const resolved = await realpath(directory).catch(() => null);
		if (resolved && isWithin(root, resolved)) directories.push(resolved);
	}
	return directories;
}

type WorkflowAccessErrorCode =
	| "not-found"
	| "location-unavailable"
	| "unsafe-path";

async function authorizeCatalogWorkflow(
	context: WorkflowRuntimeContext,
	input: Pick<ProviderWorkflowDeleteInput, "scriptPath" | "scope">,
	explicitConfigDir: string | undefined,
	errorFor: (message: string, code: WorkflowAccessErrorCode) => Error,
): Promise<string> {
	const catalog = await listClaudeWorkflows(
		context.runtimeCwd,
		explicitConfigDir,
	);
	const workflow = catalog.workflows.find(
		(candidate) =>
			candidate.scriptPath === input.scriptPath &&
			candidate.scope === input.scope,
	);
	if (!workflow) {
		throw errorFor(
			"This saved workflow could not be found in the current Claude catalog.",
			"not-found",
		);
	}

	const target = toHostRuntimePath(context.runtimeCwd, workflow.scriptPath);
	const info = await lstat(target).catch(() => null);
	if (!info?.isFile()) {
		throw errorFor(
			"The saved workflow file is no longer available.",
			"not-found",
		);
	}
	if (info.isSymbolicLink()) {
		throw errorFor(
			"Claude refuses to access a saved workflow symbolic link.",
			"unsafe-path",
		);
	}
	const targetReal = await realpath(target).catch(() => null);
	if (!targetReal) {
		throw errorFor(
			"The saved workflow file is no longer available.",
			"not-found",
		);
	}
	const directories = await deletionDirectories(context, input.scope);
	if (!directories.includes(dirname(targetReal))) {
		throw errorFor(
			"The saved workflow resolves outside its native Claude location.",
			"unsafe-path",
		);
	}
	return targetReal;
}

/**
 * Delete only an exact, currently cataloged native workflow file. Resolving the
 * final file and directory before unlinking prevents a caller-controlled path
 * from escaping the provider's workflow locations.
 */
export async function deleteClaudeWorkflow(
	input: ProviderWorkflowDeleteInput,
	explicitConfigDir?: string,
): Promise<void> {
	const context = await runtimeContext(input.cwd, explicitConfigDir);
	const targetReal = await authorizeCatalogWorkflow(
		context,
		input,
		explicitConfigDir,
		(message, code) => new ClaudeWorkflowDeleteError(message, code),
	);
	try {
		await unlink(targetReal);
	} catch (error) {
		throw new ClaudeWorkflowDeleteError(
			error instanceof Error
				? `The saved workflow could not be deleted: ${error.message}`
				: "The saved workflow could not be deleted.",
			"location-unavailable",
		);
	}
}

/**
 * Read workflow source only from Claude's persisted run-script area or an
 * exact current catalog entry. The browser never supplies an unrestricted
 * filesystem path for preview.
 */
export async function readClaudeWorkflowSource(
	input: ProviderWorkflowSourceInput,
	explicitConfigDir?: string,
): Promise<string> {
	try {
		const context = await runtimeContext(input.cwd, explicitConfigDir);
		const source =
			input.scope === undefined
				? await authorizeSource(context, input.scriptPath)
				: await authorizeCatalogWorkflow(
						context,
						{ scriptPath: input.scriptPath, scope: input.scope },
						explicitConfigDir,
						(message, code) => new ClaudeWorkflowSourceError(message, code),
					);
		return (await readWorkflowScript(source)).content;
	} catch (error) {
		if (error instanceof ClaudeWorkflowSourceError) throw error;
		if (error instanceof ClaudeWorkflowSaveError) {
			throw new ClaudeWorkflowSourceError(
				error.message,
				error.code === "unsafe-path"
					? "unsafe-path"
					: error.code === "location-unavailable"
						? "location-unavailable"
						: "invalid-script",
			);
		}
		throw new ClaudeWorkflowSourceError(
			error instanceof Error
				? `The workflow definition could not be read: ${error.message}`
				: "The workflow definition could not be read.",
			"location-unavailable",
		);
	}
}
