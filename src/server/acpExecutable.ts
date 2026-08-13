import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, posix, resolve, win32 } from "node:path";

let pathIndexKey = "";
let pathIndexRead: Promise<Map<string, string[]>> | null = null;
let pathIndexBuildCountForTests = 0;
let candidateValidationCountForTests = 0;

export function acpExecutableNames(
	command: string,
	pathExt: string | undefined,
	platform: NodeJS.Platform = process.platform,
): string[] {
	if (platform !== "win32") return [command];
	const extensions = (pathExt ?? ".COM;.EXE;.BAT;.CMD")
		.split(";")
		.map((extension) => extension.trim().toLowerCase())
		.filter(Boolean)
		.map((extension) =>
			extension.startsWith(".") ? extension : `.${extension}`,
		)
		.filter((extension, index, values) => values.indexOf(extension) === index);
	const lower = command.toLowerCase();
	const explicitExtension = extensions.find((extension) =>
		lower.endsWith(extension),
	);
	if (explicitExtension) return [lower];
	// npm installs an extensionless POSIX shell shim next to its Windows .cmd
	// shim. Windows command discovery must honor PATHEXT instead of trying to
	// execute that extensionless file directly.
	if (!/[\\/][^\\/]*\.[^\\/]+$/.test(`/${lower}`)) {
		return extensions.map((extension) => `${lower}${extension}`);
	}
	return [lower];
}

export function acpExecutablePathCandidates(
	command: string,
	directories: string[],
	pathExt: string | undefined,
	platform: NodeJS.Platform = process.platform,
): string[] {
	const path = platform === "win32" ? win32 : posix;
	const names = acpExecutableNames(command, pathExt, platform);
	return directories.flatMap((directory) =>
		names.map((name) => path.join(directory, name)),
	);
}

const PATH_IO_TIMEOUT_MS = 500;

async function withinPathIoBudget<T>(operation: Promise<T>): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		operation,
		new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), PATH_IO_TIMEOUT_MS);
		}),
	]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

async function canAccess(candidate: string): Promise<boolean> {
	candidateValidationCountForTests += 1;
	const [accessible, metadata] = await Promise.all([
		withinPathIoBudget(
			access(
				candidate,
				process.platform === "win32" ? constants.F_OK : constants.X_OK,
			).then(
				() => true,
				() => false,
			),
		),
		withinPathIoBudget(stat(candidate).catch(() => null)),
	]);
	return accessible === true && metadata?.isFile() === true;
}

function environmentValue(
	env: Record<string, string | undefined> | undefined,
	name: string,
): string | undefined {
	if (!env) return undefined;
	if (process.platform !== "win32") return env[name];
	let value: string | undefined;
	for (const [key, candidate] of Object.entries(env)) {
		if (key.toLowerCase() === name.toLowerCase()) value = candidate;
	}
	return value;
}

function pathDirectories(pathValue: string | undefined, cwd: string): string[] {
	return (pathValue ?? "")
		.split(delimiter)
		.filter(Boolean)
		.map((directory) =>
			isAbsolute(directory) ? directory : resolve(cwd, directory),
		);
}

async function buildPathIndex(
	directories: string[],
): Promise<Map<string, string[]>> {
	pathIndexBuildCountForTests += 1;
	const listings = await Promise.all(
		directories.map(async (directory) => {
			const entries = await withinPathIoBudget(
				readdir(directory, { withFileTypes: true }).catch(() => null),
			);
			if (entries) {
				return {
					directory,
					entries,
				};
			}
			return null;
		}),
	);
	const index = new Map<string, string[]>();
	for (const listing of listings) {
		if (!listing) continue;
		for (const entry of listing.entries) {
			if (!entry.isFile() && !entry.isSymbolicLink()) continue;
			const key =
				process.platform === "win32" ? entry.name.toLowerCase() : entry.name;
			const candidates = index.get(key) ?? [];
			candidates.push(join(listing.directory, entry.name));
			index.set(key, candidates);
		}
	}
	return index;
}

async function pathIndex(
	directories: string[],
	pathExt: string | undefined,
	fresh = false,
): Promise<Map<string, string[]>> {
	const key = `${directories.join("\0")}\0${pathExt ?? ""}`;
	if (fresh || !pathIndexRead || pathIndexKey !== key) {
		pathIndexKey = key;
		pathIndexRead = buildPathIndex(directories);
	}
	return pathIndexRead;
}

async function probePathCandidates(
	command: string,
	directories: string[],
	pathExt: string | undefined,
): Promise<string | null> {
	const candidates = acpExecutablePathCandidates(command, directories, pathExt);
	const accessible = await Promise.all(candidates.map(canAccess));
	return (
		candidates.find((_candidate, index) => accessible[index] === true) ?? null
	);
}

function executablePathKey(candidate: string): string {
	return process.platform === "win32" ? candidate.toLowerCase() : candidate;
}

function rememberIndexedCandidate(
	index: Map<string, string[]>,
	discovered: string,
): void {
	const key =
		process.platform === "win32"
			? discovered.split(/[\\/]/).at(-1)?.toLowerCase()
			: discovered.split("/").at(-1);
	if (!key) return;
	const candidates = index.get(key) ?? [];
	if (!candidates.includes(discovered)) candidates.push(discovered);
	index.set(key, candidates);
}

function indexedAcpExecutableCandidates(
	command: string,
	directories: string[],
	pathExt: string | undefined,
	index: Map<string, string[]>,
): {
	indexed: Map<string, string>;
	orderedCandidates: string[];
	orderedIndexed: string[];
} {
	const indexed = new Map<string, string>();
	for (const name of acpExecutableNames(command, pathExt)) {
		const candidates = index.get(
			process.platform === "win32" ? name.toLowerCase() : name,
		);
		for (const candidate of candidates ?? []) {
			indexed.set(executablePathKey(candidate), candidate);
		}
	}
	const orderedCandidates = acpExecutablePathCandidates(
		command,
		directories,
		pathExt,
	);
	const orderedIndexed = orderedCandidates
		.map((candidate) => indexed.get(executablePathKey(candidate)))
		.filter((candidate): candidate is string => Boolean(candidate));
	return { indexed, orderedCandidates, orderedIndexed };
}

/** Resolve an ACP executable without synchronous PATH filesystem work. */
async function resolveIndexedAcpExecutable(
	command: string,
	directories: string[],
	pathExt: string | undefined,
	index: Map<string, string[]>,
): Promise<string | null> {
	const { orderedIndexed } = indexedAcpExecutableCandidates(
		command,
		directories,
		pathExt,
		index,
	);
	for (const candidate of orderedIndexed) {
		if (await canAccess(candidate)) return candidate;
	}
	return null;
}

export type FindAcpExecutablesOptions = {
	cwd?: string;
	env?: Record<string, string | undefined>;
};

function acpExecutableSearchContext(options: FindAcpExecutablesOptions): {
	cwd: string;
	pathExt: string | undefined;
	directories: string[];
} {
	const cwd = options.cwd ?? process.cwd();
	const pathValue =
		environmentValue(options.env, "PATH") ??
		environmentValue(process.env, "PATH");
	const pathExt =
		environmentValue(options.env, "PATHEXT") ??
		environmentValue(process.env, "PATHEXT");
	return {
		cwd,
		pathExt,
		directories: pathDirectories(pathValue, cwd),
	};
}

/**
 * Resolve ACP executables against one exact cwd/environment group. PATH
 * directories are freshly indexed once for the batch, preserving discovery
 * freshness without a PATH x PATHEXT filesystem-probe fanout for misses.
 */
export async function findAcpExecutables(
	commands: readonly string[],
	options: FindAcpExecutablesOptions = {},
): Promise<Map<string, string | null>> {
	const uniqueCommands = [...new Set(commands)];
	if (uniqueCommands.length === 0) return new Map();
	const { cwd, pathExt, directories } = acpExecutableSearchContext(options);
	const pathCommands = uniqueCommands.filter(
		(command) =>
			command.length > 0 &&
			!isAbsolute(command) &&
			!command.includes("/") &&
			!command.includes("\\"),
	);
	// One fresh listing pass makes the whole group current and bounds misses to
	// PATH directory reads rather than PATH x PATHEXT filesystem probes.
	const index =
		pathCommands.length > 0
			? await pathIndex(directories, pathExt, true)
			: null;
	const resolved = await Promise.all(
		uniqueCommands.map(async (command) => {
			if (!command) return [command, null] as const;
			if (
				isAbsolute(command) ||
				command.includes("/") ||
				command.includes("\\")
			) {
				const candidate = isAbsolute(command) ? command : resolve(cwd, command);
				return [
					command,
					(await canAccess(candidate)) ? candidate : null,
				] as const;
			}
			return [
				command,
				await resolveIndexedAcpExecutable(
					command,
					directories,
					pathExt,
					index as Map<string, string[]>,
				),
			] as const;
		}),
	);
	return new Map(resolved);
}

/** Resolve one ACP executable without synchronous PATH filesystem work. */
export async function findAcpExecutable(
	command: string,
	options: FindAcpExecutablesOptions = {},
): Promise<string | null> {
	if (!command) return null;
	const { cwd, pathExt, directories } = acpExecutableSearchContext(options);
	if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
		const candidate = isAbsolute(command) ? command : resolve(cwd, command);
		return (await canAccess(candidate)) ? candidate : null;
	}
	const index = await pathIndex(directories, pathExt);
	const { indexed, orderedCandidates, orderedIndexed } =
		indexedAcpExecutableCandidates(command, directories, pathExt, index);
	let indexedWinner: string | null = null;
	for (const candidate of orderedIndexed) {
		if (await canAccess(candidate)) {
			indexedWinner = candidate;
			break;
		}
	}
	if (indexedWinner) {
		const winnerIndex = orderedCandidates.findIndex(
			(candidate) =>
				executablePathKey(candidate) === executablePathKey(indexedWinner),
		);
		const newlyPossible = orderedCandidates
			.slice(0, Math.max(0, winnerIndex))
			.filter((candidate) => !indexed.has(executablePathKey(candidate)));
		if (newlyPossible.length > 0) {
			const accessible = await Promise.all(newlyPossible.map(canAccess));
			const higherPriority = newlyPossible.find(
				(_candidate, index) => accessible[index] === true,
			);
			if (higherPriority) {
				rememberIndexedCandidate(index, higherPriority);
				return higherPriority;
			}
		}
		return indexedWinner;
	}
	// A singleton miss must still observe a command installed after the cached
	// directory index was built. Full registry inventory uses the fresh batch
	// resolver above, while normal launches retain this cached fast path.
	const discovered = await probePathCandidates(command, directories, pathExt);
	if (discovered) rememberIndexedCandidate(index, discovered);
	return discovered;
}

export function acpLaunchUsesShell(
	resolvedExecutable: string,
	platform: NodeJS.Platform = process.platform,
): boolean {
	return platform === "win32" && /\.(?:bat|cmd)$/i.test(resolvedExecutable);
}

/**
 * Batch shims require cmd.exe, so reject characters that could escape the
 * command Node constructs for `shell: true`. Registry/config arguments are not
 * trusted shell source.
 */
export function assertSafeAcpCmdShimInvocation(
	resolvedExecutable: string,
	args: string[],
): void {
	const unsafe = /[\r\n"%!]/;
	if (unsafe.test(resolvedExecutable) || args.some((arg) => unsafe.test(arg))) {
		throw new Error(
			"Windows ACP .cmd/.bat launch contains unsupported shell metacharacters",
		);
	}
}

export function acpCmdShimCommand(
	resolvedExecutable: string,
	args: string[],
): string {
	assertSafeAcpCmdShimInvocation(resolvedExecutable, args);
	return [resolvedExecutable, ...args].map((value) => `"${value}"`).join(" ");
}

// fallow-ignore-next-line unused-export -- Vitest uses this seam to prove batch discovery bounds filesystem work.
export const acpExecutableInternals = {
	resetIoCounters: () => {
		pathIndexBuildCountForTests = 0;
		candidateValidationCountForTests = 0;
	},
	ioCounters: () => ({
		pathIndexBuildCount: pathIndexBuildCountForTests,
		candidateValidationCount: candidateValidationCountForTests,
	}),
};
