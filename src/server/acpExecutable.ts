import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, posix, resolve, win32 } from "node:path";

let pathIndexKey = "";
let pathIndexRead: Promise<Map<string, string[]>> | null = null;

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
): Promise<Map<string, string[]>> {
	const key = `${directories.join("\0")}\0${pathExt ?? ""}`;
	if (!pathIndexRead || pathIndexKey !== key) {
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

/** Resolve an ACP executable without synchronous PATH filesystem work. */
export async function findAcpExecutable(
	command: string,
	options: {
		cwd?: string;
		env?: Record<string, string | undefined>;
	} = {},
): Promise<string | null> {
	if (!command) return null;
	const cwd = options.cwd ?? process.cwd();
	const pathValue =
		environmentValue(options.env, "PATH") ??
		environmentValue(process.env, "PATH");
	const pathExt =
		environmentValue(options.env, "PATHEXT") ??
		environmentValue(process.env, "PATHEXT");
	if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
		const candidate = isAbsolute(command) ? command : resolve(cwd, command);
		return (await canAccess(candidate)) ? candidate : null;
	}
	const directories = pathDirectories(pathValue, cwd);
	const index = await pathIndex(directories, pathExt);
	const indexed = new Map<string, string>();
	for (const name of acpExecutableNames(command, pathExt)) {
		const candidates = index.get(
			process.platform === "win32" ? name.toLowerCase() : name,
		);
		for (const candidate of candidates ?? []) {
			indexed.set(
				process.platform === "win32" ? candidate.toLowerCase() : candidate,
				candidate,
			);
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
	// A miss must observe an executable installed after the directory index was
	// created.
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
