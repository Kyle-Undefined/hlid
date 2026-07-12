import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
