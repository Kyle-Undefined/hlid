import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFileAtomic, writeFileAtomicSync } from "./atomicFile";

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

describe("writeFileAtomic", () => {
	it("validates the complete temporary file before replacing the target", async () => {
		const target = join(root(), "settings.json");
		writeFileSync(target, "first");

		await writeFileAtomic(target, "second", {
			validate: (temporary) => {
				expect(readFileSync(temporary, "utf8")).toBe("second");
				expect(readFileSync(target, "utf8")).toBe("first");
				return Promise.resolve();
			},
		});

		expect(readFileSync(target, "utf8")).toBe("second");
	});

	it("preserves the target when validation rejects the replacement", async () => {
		const target = join(root(), "settings.json");
		writeFileSync(target, "first");

		await expect(
			writeFileAtomic(target, "invalid", {
				validate: () => Promise.reject(new Error("invalid replacement")),
			}),
		).rejects.toThrow("invalid replacement");

		expect(readFileSync(target, "utf8")).toBe("first");
	});

	it("removes its temporary file when validation fails", async () => {
		const directory = root();
		const target = join(directory, "settings.json");

		await expect(
			writeFileAtomic(target, "invalid", {
				validate: () => Promise.reject(new Error("invalid replacement")),
			}),
		).rejects.toThrow("invalid replacement");

		expect(readdirSync(directory)).toEqual([]);
	});
});
