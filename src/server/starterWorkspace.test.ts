import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	bootstrapStarterWorkspace,
	STARTER_WORKSPACE_NAME,
} from "./starterWorkspace";

const roots: string[] = [];

function root() {
	const value = mkdtempSync(join(tmpdir(), "hlid-starter-workspace-"));
	roots.push(value);
	return value;
}

afterEach(() => {
	for (const value of roots.splice(0))
		rmSync(value, { recursive: true, force: true });
});

describe("starter workspace bootstrap", () => {
	it("creates only the documented starter shape", async () => {
		const parent = root();
		const result = await bootstrapStarterWorkspace(parent);
		expect(result).toMatchObject({ created: true, recovered: false });
		expect(
			readFileSync(join(result.path, "Welcome to Hlid.md"), "utf8"),
		).toContain("Welcome to Hlid");
		expect(
			readFileSync(join(result.path, ".hlid-starter.json"), "utf8"),
		).toContain("hlid-starter-workspace");
		for (const directory of [
			"00 Inbox",
			"10 Projects",
			"20 Areas",
			"30 Resources",
			"40 Archive",
			"_munin/skills",
			"_munin/memory",
		]) {
			expect(existsSync(join(result.path, directory))).toBe(true);
		}
	});

	it("retries a completed marked workspace without rewriting it", async () => {
		const parent = root();
		const first = await bootstrapStarterWorkspace(parent);
		const second = await bootstrapStarterWorkspace(parent);
		expect(second).toEqual({
			path: first.path,
			created: false,
			recovered: true,
		});
	});

	it("does not change an unmarked existing folder", async () => {
		const parent = root();
		const target = join(parent, STARTER_WORKSPACE_NAME);
		writeFileSync(target, "occupied");
		await expect(bootstrapStarterWorkspace(parent)).rejects.toThrow(
			"A file already uses",
		);
		expect(readFileSync(target, "utf8")).toBe("occupied");
	});

	it("rejects a linked starter path outside the selected folder", async () => {
		const parent = root();
		const outside = root();
		symlinkSync(outside, join(parent, STARTER_WORKSPACE_NAME), "dir");
		await expect(bootstrapStarterWorkspace(parent)).rejects.toThrow("escaped");
	});
});
