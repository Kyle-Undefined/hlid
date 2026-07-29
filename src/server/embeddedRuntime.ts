import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";

/** Copy one embedded asset from its bundled source path to its runtime destination. */
export async function materializeEmbeddedFile(
	source: string,
	destination: string,
): Promise<void> {
	await Bun.write(destination, Bun.file(source));
}

export async function stageRuntimeDirectory(
	runtimeDir: string,
	runtimeHash: string,
	populate: (temporaryDir: string) => Promise<void>,
): Promise<void> {
	const temporaryDir = `${runtimeDir}.tmp`;
	rmSync(temporaryDir, { recursive: true, force: true });
	mkdirSync(temporaryDir, { recursive: true });
	await populate(temporaryDir);
	writeFileSync(join(temporaryDir, ".hash"), runtimeHash, "utf8");
	replaceRuntimeDirectory(temporaryDir, runtimeDir);
}

export function verifyRuntimeDirectory(
	directory: string,
	runtimeHash: string,
	requiredFiles: readonly string[],
	options: { requireContainedRegularFiles?: boolean } = {},
): string | null {
	try {
		if (readFileSync(join(directory, ".hash"), "utf8").trim() !== runtimeHash)
			return null;
		const canonicalDirectory = options.requireContainedRegularFiles
			? realpathSync(directory)
			: directory;
		for (const name of requiredFiles) {
			const candidate = join(directory, name);
			if (!options.requireContainedRegularFiles) {
				if (!existsSync(candidate)) return null;
				continue;
			}
			if (!lstatSync(candidate).isFile()) return null;
			const canonical = realpathSync(candidate);
			const pathFromDirectory = relative(canonicalDirectory, canonical);
			if (pathFromDirectory.startsWith("..") || isAbsolute(pathFromDirectory))
				return null;
		}
		return canonicalDirectory;
	} catch {
		return null;
	}
}

export function replaceRuntimeDirectory(
	tempDir: string,
	runtimeDir: string,
): void {
	try {
		renameSync(tempDir, runtimeDir);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOTEMPTY" && code !== "EPERM" && code !== "EEXIST")
			throw error;
		const backupDir = `${runtimeDir}.bak`;
		rmSync(backupDir, { recursive: true, force: true });
		renameSync(runtimeDir, backupDir);
		try {
			renameSync(tempDir, runtimeDir);
		} catch (replacementError) {
			try {
				renameSync(backupDir, runtimeDir);
			} catch (rollbackError) {
				throw new AggregateError(
					[replacementError, rollbackError],
					"runtime replacement and rollback failed",
				);
			}
			throw replacementError;
		}
		rmSync(backupDir, { recursive: true, force: true });
	}
}
