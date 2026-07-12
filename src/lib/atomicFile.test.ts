import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFileAtomicSync } from "./atomicFile";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function root(): string {
	const path = mkdtempSync(join(tmpdir(), "hlid-atomic-"));
	roots.push(path);
	return path;
}

describe("writeFileAtomicSync", () => {
	it("creates parent directories and replaces a complete file", () => {
		const target = join(root(), "nested", "settings.json");
		writeFileAtomicSync(target, "first", {
			createParent: true,
			mode: 0o600,
		});
		writeFileAtomicSync(target, "second", { mode: 0o600 });

		expect(readFileSync(target, "utf8")).toBe("second");
		if (process.platform !== "win32") {
			expect(statSync(target).mode & 0o777).toBe(0o600);
		}
	});

	it("removes its temporary file when replacement fails", () => {
		const directory = root();
		const target = join(directory, "existing-directory");
		mkdirSync(target);

		expect(() => writeFileAtomicSync(target, "cannot replace")).toThrow();
		expect(readdirSync(directory)).toEqual(["existing-directory"]);
	});
});
