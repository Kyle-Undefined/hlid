import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	resetVaultReferenceIndexForTesting,
	resolveVaultReferences,
	searchVaultReferences,
} from "./vaultReferences";

let vault: string;

beforeEach(() => {
	vault = mkdtempSync(join(tmpdir(), "hlid-vault-refs-"));
	mkdirSync(join(vault, "Projects"), { recursive: true });
	mkdirSync(join(vault, ".obsidian"), { recursive: true });
	writeFileSync(join(vault, "Root.md"), "root");
	writeFileSync(join(vault, "Projects", "Hlið Plan.md"), "plan");
	writeFileSync(join(vault, ".obsidian", "workspace.json"), "{}");
	resetVaultReferenceIndexForTesting();
});

afterEach(() => {
	rmSync(vault, { recursive: true, force: true });
	resetVaultReferenceIndexForTesting();
});

describe("searchVaultReferences", () => {
	it("shows files from the root while ignoring Obsidian internals", async () => {
		const result = await searchVaultReferences({
			vaultPath: vault,
			vaultName: "Fornbok",
		});
		expect(result.rootLabel).toBe("Fornbok");
		expect(result.items.map((item) => item.relativePath)).toEqual([
			"Root.md",
			"Projects/Hlið Plan.md",
		]);
	});

	it("matches paths without accents", async () => {
		const result = await searchVaultReferences({
			vaultPath: vault,
			query: "hlid plan",
		});
		expect(result.items.map((item) => item.relativePath)).toEqual([
			"Projects/Hlið Plan.md",
		]);
	});
});

describe("resolveVaultReferences", () => {
	it("resolves existing files but rejects escapes and directories", async () => {
		const result = await resolveVaultReferences({
			vaultPath: vault,
			references: ["Projects/Hlið Plan.md", "../outside.md", "Projects"],
		});
		expect(result).toEqual([
			{
				relativePath: "Projects/Hlið Plan.md",
				path: join(vault, "Projects", "Hlið Plan.md"),
			},
		]);
	});

	it("rejects symlinks that escape the vault", async () => {
		const outside = mkdtempSync(join(tmpdir(), "hlid-vault-outside-"));
		writeFileSync(join(outside, "secret.md"), "secret");
		symlinkSync(join(outside, "secret.md"), join(vault, "linked.md"));
		try {
			expect(
				await resolveVaultReferences({
					vaultPath: vault,
					references: ["linked.md"],
				}),
			).toEqual([]);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});
