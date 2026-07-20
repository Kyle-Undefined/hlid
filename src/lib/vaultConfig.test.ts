/**
 * buildVaultSection — pure function, no mocks needed.
 * Verifies para/wiki style field masking and passthrough fields.
 */
import { describe, expect, it } from "vitest";
import { buildVaultSection } from "./vaultConfig";

const BASE = {
	name: "My Vault",
	path: "/vault",
	inbox: "00-inbox",
	projects: "01-projects",
	areas: "02-areas",
	resources: "03-resources",
	archive: "04-archive",
	raw: "raw-notes",
	wikiFolder: "wiki",
	outputs: "outputs",
	skills: "skills",
	memory: "memory",
	saveToObsidianTemplate: "Capture",
};

// ── para style ────────────────────────────────────────────────────────────────

describe("buildVaultSection — para style", () => {
	it("includes para fields", () => {
		const s = buildVaultSection({ ...BASE, style: "para" });
		expect(s.inbox).toBe("00-inbox");
		expect(s.projects).toBe("01-projects");
		expect(s.areas).toBe("02-areas");
		expect(s.resources).toBe("03-resources");
		expect(s.archive).toBe("04-archive");
	});

	it("excludes wiki fields", () => {
		const s = buildVaultSection({ ...BASE, style: "para" });
		expect(s.raw).toBeUndefined();
		expect(s.wiki_folder).toBeUndefined();
		expect(s.outputs).toBeUndefined();
	});

	it("preserves name and path", () => {
		const s = buildVaultSection({ ...BASE, style: "para" });
		expect(s.name).toBe("My Vault");
		expect(s.path).toBe("/vault");
	});

	it("preserves skills and memory", () => {
		const s = buildVaultSection({ ...BASE, style: "para" });
		expect(s.skills).toBe("skills");
		expect(s.memory).toBe("memory");
	});

	it("preserves the optional Obsidian save template", () => {
		const s = buildVaultSection({ ...BASE, style: "para" });
		expect(s.save_to_obsidian_template).toBe("Capture");
	});

	it("omits an empty Obsidian save template", () => {
		const s = buildVaultSection({
			...BASE,
			style: "para",
			saveToObsidianTemplate: "",
		});
		expect(s.save_to_obsidian_template).toBeUndefined();
	});

	it("empty string para fields become undefined", () => {
		const s = buildVaultSection({ ...BASE, style: "para", inbox: "" });
		expect(s.inbox).toBeUndefined();
	});
});

// ── wiki style ────────────────────────────────────────────────────────────────

describe("buildVaultSection — wiki style", () => {
	it("includes wiki fields", () => {
		const s = buildVaultSection({ ...BASE, style: "wiki" });
		expect(s.raw).toBe("raw-notes");
		expect(s.wiki_folder).toBe("wiki");
		expect(s.outputs).toBe("outputs");
	});

	it("excludes para fields", () => {
		const s = buildVaultSection({ ...BASE, style: "wiki" });
		expect(s.inbox).toBeUndefined();
		expect(s.projects).toBeUndefined();
		expect(s.areas).toBeUndefined();
		expect(s.resources).toBeUndefined();
		expect(s.archive).toBeUndefined();
	});

	it("preserves skills and memory", () => {
		const s = buildVaultSection({ ...BASE, style: "wiki" });
		expect(s.skills).toBe("skills");
		expect(s.memory).toBe("memory");
	});

	it("empty string wiki fields become undefined", () => {
		const s = buildVaultSection({ ...BASE, style: "wiki", raw: "" });
		expect(s.raw).toBeUndefined();
	});
});

// ── no style ──────────────────────────────────────────────────────────────────

describe("buildVaultSection — no style", () => {
	it("masks both para and wiki fields when style undefined", () => {
		const s = buildVaultSection({ ...BASE, style: undefined });
		expect(s.inbox).toBeUndefined();
		expect(s.projects).toBeUndefined();
		expect(s.raw).toBeUndefined();
		expect(s.wiki_folder).toBeUndefined();
	});

	it("still preserves skills and memory", () => {
		const s = buildVaultSection({ ...BASE, style: undefined });
		expect(s.skills).toBe("skills");
		expect(s.memory).toBe("memory");
	});

	it("sets style field to undefined", () => {
		const s = buildVaultSection({ name: "V", path: "/v", style: undefined });
		expect(s.style).toBeUndefined();
	});
});
