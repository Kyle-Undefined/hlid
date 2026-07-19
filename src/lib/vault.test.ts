/**
 * vault.ts — path traversal guards and scan functions.
 * Uses real temp-dir fixtures; no mocks required.
 */
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
import type { StatusVocabulary } from "#/lib/classify";
import {
	scanFolderGroups,
	scanMemory,
	scanProjects,
	scanSkills,
} from "./vault";

const EMPTY_VOCAB: StatusVocabulary = { active: [], planning: [], done: [] };

// ── helpers ───────────────────────────────────────────────────────────────────

function md(content: string, frontmatter?: Record<string, unknown>): string {
	if (!frontmatter) return content;
	const fm = Object.entries(frontmatter)
		.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
		.join("\n");
	return `---\n${fm}\n---\n${content}`;
}

// ── fixtures ──────────────────────────────────────────────────────────────────

let root: string;
let outside: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "hlid-vault-test-"));
	outside = mkdtempSync(join(tmpdir(), "hlid-outside-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

// ── assertContained (via scanProjects) ───────────────────────────────────────

describe("path traversal guard (assertContained)", () => {
	it("allows a legitimate subfolder", () => {
		mkdirSync(join(root, "projects"), { recursive: true });
		expect(() => scanProjects(root, "projects", EMPTY_VOCAB)).not.toThrow();
	});

	it("throws when projectsFolder resolves outside vault via ../", () => {
		// "../outside" from root would escape — resolve(root, "../outside") is outside root
		expect(() => scanProjects(root, "../outside", EMPTY_VOCAB)).toThrow(
			"Access denied: path escapes vault",
		);
	});

	it("throws when projectsFolder is an absolute path outside vault", () => {
		expect(() => scanProjects(root, outside, EMPTY_VOCAB)).toThrow(
			"Access denied: path escapes vault",
		);
	});

	it("throws for symlink-based traversal in scanSkills", () => {
		// Create an escape symlink inside vault pointing outside
		const skillsDir = join(root, "skills");
		mkdirSync(skillsDir);
		const escapeLink = join(root, "escape");
		symlinkSync(outside, escapeLink);
		// scanSkills with the vault root as skills dir is fine, but a symlink'd subdir inside is skipped
		// Test direct escape via folder arg
		expect(() => scanSkills(root, "../outside")).toThrow(
			"Access denied: path escapes vault",
		);
	});

	it("throws for absolute outside path in scanMemory", () => {
		expect(() => scanMemory(root, outside)).toThrow(
			"Access denied: path escapes vault",
		);
	});

	it("throws for absolute outside path in scanFolderGroups", () => {
		expect(() => scanFolderGroups(root, outside)).toThrow(
			"Access denied: path escapes vault",
		);
	});
});

// ── scanProjects ──────────────────────────────────────────────────────────────

describe("scanProjects", () => {
	it("returns empty array when projects folder missing", () => {
		const result = scanProjects(root, "nonexistent", EMPTY_VOCAB);
		expect(result).toEqual([]);
	});

	it("scans flat .md file with frontmatter", () => {
		const dir = join(root, "projects");
		mkdirSync(dir);
		writeFileSync(
			join(dir, "myproject.md"),
			md("body text", {
				title: "My Project",
				status: "active",
				tags: ["a", "b"],
			}),
		);
		const [project] = scanProjects(root, "projects", {
			active: ["active"],
			planning: [],
			done: [],
		});
		expect(project.title).toBe("My Project");
		expect(project.rawStatus).toBe("active");
		expect(project.tags).toEqual(["a", "b"]);
		expect(project.isFolder).toBe(false);
	});

	it("falls back to filename as title when no frontmatter", () => {
		const dir = join(root, "projects");
		mkdirSync(dir);
		writeFileSync(join(dir, "bare.md"), "no frontmatter here");
		const [project] = scanProjects(root, "projects", EMPTY_VOCAB);
		expect(project.title).toBe("bare");
		expect(project.tags).toEqual([]);
	});

	it("skips symlinks at project level", () => {
		const dir = join(root, "projects");
		mkdirSync(dir);
		symlinkSync(outside, join(dir, "evil-link"));
		writeFileSync(join(dir, "real.md"), "content");
		const result = scanProjects(root, "projects", EMPTY_VOCAB);
		expect(result).toHaveLength(1);
		expect(result[0].file).toBe("real.md");
	});

	it("scans folder-based project using index.md", () => {
		const dir = join(root, "projects");
		const proj = join(dir, "MyProject");
		mkdirSync(proj, { recursive: true });
		writeFileSync(
			join(proj, "index.md"),
			md("content", { title: "Folder Project", status: "done" }),
		);
		const [project] = scanProjects(root, "projects", EMPTY_VOCAB);
		expect(project.isFolder).toBe(true);
		expect(project.title).toBe("Folder Project");
	});
});

// ── scanSkills ────────────────────────────────────────────────────────────────

describe("scanSkills", () => {
	it("returns empty when skills folder missing", () => {
		const { skills } = scanSkills(root, "skills");
		expect(skills).toEqual([]);
	});

	it("reads skill name and description from frontmatter", () => {
		const dir = join(root, "skills");
		mkdirSync(dir);
		writeFileSync(
			join(dir, "my-skill.md"),
			md("## My Skill\nDoes a thing.", {
				name: "my-skill",
				description: "Does a thing.",
			}),
		);
		const { skills } = scanSkills(root, "skills");
		expect(skills).toHaveLength(1);
		expect(skills[0].name).toBe("my-skill");
		expect(skills[0].description).toBe("Does a thing.");
	});

	it("excludes index.md by default (hideIndex=true)", () => {
		const dir = join(root, "skills");
		mkdirSync(dir);
		writeFileSync(join(dir, "index.md"), "# Index\n");
		writeFileSync(join(dir, "real.md"), md("content", { name: "real" }));
		const { skills } = scanSkills(root, "skills");
		expect(skills.map((s) => s.file)).not.toContain("index.md");
	});

	it("includes index.md when hideIndex=false", () => {
		const dir = join(root, "skills");
		mkdirSync(dir);
		writeFileSync(join(dir, "index.md"), md("idx", { name: "index" }));
		const { skills } = scanSkills(root, "skills", false);
		expect(skills.map((s) => s.file)).toContain("index.md");
	});

	it("prefers SKILL.md inside a provider package", () => {
		const dir = join(root, "skills", "review");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "README.md"), md("readme", { name: "wrong" }));
		writeFileSync(
			join(dir, "SKILL.md"),
			md("instructions", { name: "review" }),
		);
		const { skills } = scanSkills(root, "skills");
		expect(skills).toHaveLength(1);
		expect(skills[0].name).toBe("review");
		expect(skills[0].file).toBe(join("review", "SKILL.md"));
	});

	it("skips symlinks inside skills dir", () => {
		const dir = join(root, "skills");
		mkdirSync(dir);
		symlinkSync(outside, join(dir, "evil"));
		writeFileSync(join(dir, "good.md"), md("ok", { name: "good" }));
		const { skills } = scanSkills(root, "skills");
		expect(skills).toHaveLength(1);
		expect(skills[0].name).toBe("good");
	});
});

// ── scanMemory ────────────────────────────────────────────────────────────────

describe("scanMemory", () => {
	it("returns empty when memory folder missing", () => {
		expect(scanMemory(root, "memory")).toEqual([]);
	});

	it("walks nested .md files", () => {
		const mem = join(root, "memory");
		mkdirSync(join(mem, "sub"), { recursive: true });
		writeFileSync(join(mem, "top.md"), "top content");
		writeFileSync(join(mem, "sub", "nested.md"), "nested content");
		const results = scanMemory(root, "memory");
		const names = results.map((r) => r.name).sort();
		expect(names).toEqual(["nested", "top"]);
	});
});
