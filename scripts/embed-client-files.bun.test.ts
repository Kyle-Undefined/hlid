import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanEmbeddedFiles } from "./embed-client-files";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("scanEmbeddedFiles", () => {
	it("returns sorted relative POSIX file paths, including dotfiles", () => {
		const root = mkdtempSync(join(tmpdir(), "hlid-embedded-files-"));
		roots.push(root);
		mkdirSync(join(root, "nested", "empty"), { recursive: true });
		writeFileSync(join(root, "z.txt"), "z");
		writeFileSync(join(root, ".root"), "root");
		writeFileSync(join(root, "nested", "a.js"), "a");
		writeFileSync(join(root, "nested", ".hidden"), "hidden");

		expect(scanEmbeddedFiles(root)).toEqual([
			".root",
			"nested/.hidden",
			"nested/a.js",
			"z.txt",
		]);
	});
});
