import { renameSync, rmSync } from "node:fs";

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
