import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureUmbodManifest } from "./umbodManifest";

describe("ensureUmbodManifest", () => {
	test("creates and validates the starter manifest when the path is missing", async () => {
		const root = mkdtempSync(join(tmpdir(), "hlid-umbod-"));
		const path = join(root, "nested", "umbod.toml");
		try {
			await ensureUmbodManifest(path);
			const source = readFileSync(path, "utf8");
			expect(source).toContain('name = "hlid"');
			expect(source).toContain('default_unknown = "approve"');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("never overwrites an existing manifest", async () => {
		const root = mkdtempSync(join(tmpdir(), "hlid-umbod-"));
		const path = join(root, "umbod.toml");
		const source = `[env]\nname = "custom"\nversion = "1"\ntimeout = 30\n\n[policy]\ndefault_unknown = "block"\napproval_method = "cli"\n`;
		writeFileSync(path, source);
		try {
			await ensureUmbodManifest(path);
			expect(readFileSync(path, "utf8")).toBe(source);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
