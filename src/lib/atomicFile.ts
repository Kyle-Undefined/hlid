import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type AtomicWriteOptions = {
	encoding?: BufferEncoding;
	mode?: number;
	createParent?: boolean;
	parentMode?: number;
};

/** Write a complete file through a sibling temporary path and replace atomically. */
export function writeFileAtomicSync(
	path: string,
	contents: string | NodeJS.ArrayBufferView,
	options: AtomicWriteOptions = {},
): void {
	if (options.createParent) {
		mkdirSync(dirname(path), {
			recursive: true,
			...(options.parentMode === undefined ? {} : { mode: options.parentMode }),
		});
	}
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temporary, contents, {
			encoding: options.encoding ?? "utf8",
			...(options.mode === undefined ? {} : { mode: options.mode }),
		});
		renameSync(temporary, path);
	} catch (error) {
		try {
			rmSync(temporary, { force: true });
		} catch {
			// Preserve the original write/rename error.
		}
		throw error;
	}
}

/** Async variant: create the parent, write through a sibling temp path, replace atomically. */
export async function writeFileAtomic(
	path: string,
	contents: string,
	options: {
		mode?: number;
		validate?: (temporaryPath: string) => Promise<void>;
	} = {},
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, contents, {
			encoding: "utf8",
			...(options.mode === undefined ? {} : { mode: options.mode }),
		});
		await options.validate?.(temporary);
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => {});
		throw error;
	}
}
