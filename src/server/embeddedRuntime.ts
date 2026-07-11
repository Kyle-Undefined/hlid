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
		rmSync(runtimeDir, { recursive: true, force: true });
		renameSync(tempDir, runtimeDir);
	}
}
