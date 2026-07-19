import { createHash, randomUUID } from "node:crypto";
import {
	lstat,
	mkdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, relative, resolve, win32 } from "node:path";
import type { HlidConfig } from "../config";
import type {
	InstructionFileDocument,
	InstructionFileEnvironment,
	InstructionFileOwner,
	InstructionFileProvider,
	InstructionFileTarget,
} from "../lib/instructionFileTypes";
import { expandTilde, parseWslUncSyntax } from "../lib/paths";

const MAX_INSTRUCTION_FILE_BYTES = 1024 * 1024;

type TargetDefinition = {
	id: string;
	owner: InstructionFileOwner;
	provider: InstructionFileProvider;
	filename: "AGENTS.md" | "CLAUDE.md";
	scopeLabel: string;
	environment: InstructionFileEnvironment;
	environmentLabel: string;
	path: string;
	baseRoot: string;
	agentPath?: string;
};

export type InstructionDiscoveryOptions = {
	home?: string;
	platform?: NodeJS.Platform;
	wslDistro?: string;
};

function isWindowsPath(path: string): boolean {
	return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(path);
}

function joinFilesystemPath(base: string, ...parts: string[]): string {
	return isWindowsPath(base)
		? win32.join(base, ...parts)
		: resolve(base, ...parts);
}

function environmentForPath(
	path: string,
	options: InstructionDiscoveryOptions,
): Pick<TargetDefinition, "environment" | "environmentLabel"> {
	const wsl = parseWslUncSyntax(path);
	if (wsl) {
		return {
			environment: "wsl",
			environmentLabel: `WSL · ${wsl.distro}`,
		};
	}
	if (
		(options.platform ?? process.platform) === "win32" ||
		isWindowsPath(path)
	) {
		return { environment: "windows", environmentLabel: "Windows" };
	}
	const distro = options.wslDistro ?? process.env.WSL_DISTRO_NAME;
	if (distro) {
		return {
			environment: "wsl",
			environmentLabel: `WSL · ${distro}`,
		};
	}
	return { environment: "host", environmentLabel: "Host" };
}

function definitionId(
	owner: InstructionFileOwner,
	baseRoot: string,
	filename: string,
): string {
	return `instructions:${createHash("sha256")
		.update(`${owner}\0${baseRoot}\0${filename}`)
		.digest("hex")
		.slice(0, 24)}`;
}

function definitionsForRoot(args: {
	owner: InstructionFileOwner;
	baseRoot: string;
	scopeLabel: string;
	environment: InstructionFileEnvironment;
	environmentLabel: string;
	agentPath?: string;
	global?: boolean;
}): TargetDefinition[] {
	const providers = [
		{
			provider: "codex" as const,
			filename: "AGENTS.md" as const,
			parts: args.global ? [".codex", "AGENTS.md"] : ["AGENTS.md"],
		},
		{
			provider: "claude" as const,
			filename: "CLAUDE.md" as const,
			parts: args.global ? [".claude", "CLAUDE.md"] : ["CLAUDE.md"],
		},
	];
	return providers.map(({ provider, filename, parts }) => ({
		id: definitionId(args.owner, args.baseRoot, filename),
		owner: args.owner,
		provider,
		filename,
		scopeLabel: args.scopeLabel,
		environment: args.environment,
		environmentLabel: args.environmentLabel,
		path: joinFilesystemPath(args.baseRoot, ...parts),
		baseRoot: args.baseRoot,
		...(args.agentPath ? { agentPath: args.agentPath } : {}),
	}));
}

function wslProviderHomes(config: HlidConfig): Array<{
	path: string;
	distro: string;
}> {
	const homes = new Map<string, { path: string; distro: string }>();
	const workspacePaths = [
		config.vault.path,
		...(config.agents ?? []).map((agent) => agent.path),
	].filter(Boolean);
	for (const workspacePath of workspacePaths) {
		const wsl = parseWslUncSyntax(workspacePath);
		const share = workspacePath.match(
			/^(\\\\(?:wsl\$|wsl\.localhost)\\[^\\]+)/i,
		)?.[1];
		const home = wsl?.posixPath.match(/^\/(home\/[^/]+|root)(?:\/|$)/)?.[1];
		if (!wsl || !share || !home) continue;
		const path = `${share}\\${home.replaceAll("/", "\\")}`;
		homes.set(path.toLowerCase(), { path, distro: wsl.distro });
	}
	return [...homes.values()];
}

function targetDefinitions(
	config: HlidConfig,
	options: InstructionDiscoveryOptions = {},
): TargetDefinition[] {
	const definitions: TargetDefinition[] = [];
	if (config.vault.path) {
		const baseRoot = expandTilde(config.vault.path);
		definitions.push(
			...definitionsForRoot({
				owner: "vault",
				baseRoot,
				scopeLabel: config.vault.name || "Vault",
				...environmentForPath(baseRoot, options),
			}),
		);
	}

	const hostHome = options.home ?? homedir();
	definitions.push(
		...definitionsForRoot({
			owner: "global",
			baseRoot: hostHome,
			scopeLabel: "User",
			...environmentForPath(hostHome, options),
			global: true,
		}),
	);

	for (const home of wslProviderHomes(config)) {
		if (home.path.toLowerCase() === hostHome.toLowerCase()) continue;
		definitions.push(
			...definitionsForRoot({
				owner: "global",
				baseRoot: home.path,
				scopeLabel: "User",
				environment: "wsl",
				environmentLabel: `WSL · ${home.distro}`,
				global: true,
			}),
		);
	}

	for (const agent of config.agents ?? []) {
		const baseRoot = expandTilde(agent.path);
		definitions.push(
			...definitionsForRoot({
				owner: "agent",
				baseRoot,
				scopeLabel: agent.name || "Agent",
				...environmentForPath(baseRoot, options),
				agentPath: agent.path,
			}),
		);
	}
	return definitions;
}

function revisionFor(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

async function inspectDefinition(
	definition: TargetDefinition,
): Promise<InstructionFileTarget> {
	const publicTarget = {
		id: definition.id,
		owner: definition.owner,
		provider: definition.provider,
		filename: definition.filename,
		scopeLabel: definition.scopeLabel,
		environment: definition.environment,
		environmentLabel: definition.environmentLabel,
		path: definition.path,
		...(definition.agentPath ? { agentPath: definition.agentPath } : {}),
	};
	try {
		const info = await stat(definition.path);
		if (!info.isFile()) {
			return {
				...publicTarget,
				exists: true,
				size: info.size,
				revision: null,
				writable: false,
				error: "Path is not a file",
			};
		}
		if (info.size > MAX_INSTRUCTION_FILE_BYTES) {
			return {
				...publicTarget,
				exists: true,
				size: info.size,
				revision: null,
				writable: false,
				error: "File is larger than 1 MiB",
			};
		}
		const content = await readFile(definition.path, "utf8");
		return {
			...publicTarget,
			exists: true,
			size: info.size,
			revision: revisionFor(content),
			writable: true,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			try {
				await stat(definition.baseRoot);
				return {
					...publicTarget,
					exists: false,
					size: null,
					revision: null,
					writable: true,
				};
			} catch {
				return {
					...publicTarget,
					exists: false,
					size: null,
					revision: null,
					writable: false,
					error: "Location unavailable",
				};
			}
		}
		return {
			...publicTarget,
			exists: false,
			size: null,
			revision: null,
			writable: false,
			error: error instanceof Error ? error.message : "Unable to inspect file",
		};
	}
}

export async function discoverInstructionFileTargets(
	config: HlidConfig,
	options: InstructionDiscoveryOptions = {},
): Promise<InstructionFileTarget[]> {
	return Promise.all(
		targetDefinitions(config, options).map((definition) =>
			inspectDefinition(definition),
		),
	);
}

function findDefinition(
	config: HlidConfig,
	id: string,
	options: InstructionDiscoveryOptions = {},
): TargetDefinition {
	const definition = targetDefinitions(config, options).find(
		(candidate) => candidate.id === id,
	);
	if (!definition) throw new Error("Unknown instruction file target");
	return definition;
}

export async function readInstructionFile(
	config: HlidConfig,
	id: string,
	options: InstructionDiscoveryOptions = {},
): Promise<InstructionFileDocument> {
	const definition = findDefinition(config, id, options);
	const target = await inspectDefinition(definition);
	if (target.error) throw new Error(target.error);
	const content = target.exists ? await readFile(definition.path, "utf8") : "";
	return { ...target, content };
}

function relativePath(root: string, candidate: string): string {
	return isWindowsPath(root) || isWindowsPath(candidate)
		? win32.relative(root, candidate)
		: relative(resolve(root), resolve(candidate));
}

function pathIsWithin(root: string, candidate: string): boolean {
	const relative = relativePath(root, candidate);
	return (
		relative === "" ||
		(!relative.startsWith("..") &&
			!isWindowsPath(relative) &&
			!relative.startsWith("/"))
	);
}

async function authorizedWritePath(
	definition: TargetDefinition,
): Promise<{ path: string; mode?: number }> {
	const rootReal = await realpath(definition.baseRoot).catch(() => null);
	if (!rootReal) throw new Error("Instruction location is unavailable");
	try {
		const targetInfo = await lstat(definition.path);
		const targetReal = await realpath(definition.path);
		if (!pathIsWithin(rootReal, targetReal)) {
			throw new Error("Instruction file resolves outside its allowed location");
		}
		const followed = await stat(targetReal);
		if (!followed.isFile()) throw new Error("Instruction path is not a file");
		return {
			path: targetInfo.isSymbolicLink() ? targetReal : definition.path,
			mode: followed.mode,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		let parent = dirname(definition.path);
		while (true) {
			const parentReal = await realpath(parent).catch(() => null);
			if (parentReal) {
				if (!pathIsWithin(rootReal, parentReal)) {
					throw new Error(
						"Instruction directory resolves outside its allowed location",
					);
				}
				break;
			}
			const next = dirname(parent);
			if (next === parent)
				throw new Error("Instruction location is unavailable");
			parent = next;
		}
		return { path: definition.path };
	}
}

async function writeAtomic(
	path: string,
	content: string,
	mode?: number,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, content, {
			encoding: "utf8",
			...(mode === undefined ? {} : { mode }),
		});
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => {});
		throw error;
	}
}

export async function writeInstructionFile(
	config: HlidConfig,
	input: { id: string; content: string; expectedRevision: string | null },
	options: InstructionDiscoveryOptions = {},
): Promise<InstructionFileDocument> {
	if (Buffer.byteLength(input.content, "utf8") > MAX_INSTRUCTION_FILE_BYTES) {
		throw new Error("Instruction file must be 1 MiB or smaller");
	}
	const definition = findDefinition(config, input.id, options);
	const current = await inspectDefinition(definition);
	if (current.error && current.error !== "Location unavailable") {
		throw new Error(current.error);
	}
	if (current.revision !== input.expectedRevision) {
		throw new Error(
			"Instruction file changed since it was opened. Reload it and try again.",
		);
	}
	const authorized = await authorizedWritePath(definition);
	await writeAtomic(authorized.path, input.content, authorized.mode);
	return readInstructionFile(config, input.id, options);
}
