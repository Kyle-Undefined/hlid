/**
 * groupSkills — pure function, no mocks needed.
 * Key invariants:
 *   1. "claude" section always sorts last among named sections
 *   2. Unsectioned skills land in a null group at the end
 *   3. Skills within a group are alpha-sorted by name
 *   4. Empty sections are omitted
 */
import { describe, expect, it } from "vitest";
import type { Skill } from "./skills";
import { groupSkills } from "./skills";

// ── helpers ───────────────────────────────────────────────────────────────────

function skill(name: string, section?: string): Skill {
	return {
		file: `${name}.md`,
		name,
		description: "",
		content: "",
		filePath: `/${name}.md`,
		section,
	};
}

// ── groupSkills ───────────────────────────────────────────────────────────────

describe("groupSkills", () => {
	it("returns empty array for no skills", () => {
		expect(groupSkills([], [])).toEqual([]);
	});

	it("places all skills in null group when no sectionOrder", () => {
		const result = groupSkills([skill("alpha"), skill("beta")], []);
		expect(result).toHaveLength(1);
		expect(result[0].section).toBeNull();
		expect(result[0].skills.map((s) => s.name)).toEqual(["alpha", "beta"]);
	});

	it("groups skills by section", () => {
		const skills = [
			skill("b", "writing"),
			skill("a", "writing"),
			skill("c", "coding"),
		];
		const result = groupSkills(skills, ["writing", "coding"]);
		expect(result).toHaveLength(2);
		expect(result[0].section).toBe("writing");
		expect(result[1].section).toBe("coding");
	});

	it("sorts skills within a group alphabetically", () => {
		const skills = [
			skill("zebra", "tools"),
			skill("alpha", "tools"),
			skill("mango", "tools"),
		];
		const result = groupSkills(skills, ["tools"]);
		expect(result[0].skills.map((s) => s.name)).toEqual([
			"alpha",
			"mango",
			"zebra",
		]);
	});

	it("claude section always sorts last among named sections", () => {
		const skills = [
			skill("deploy", "ops"),
			skill("review", "claude"),
			skill("format", "writing"),
		];
		// claude listed first in sectionOrder — must still end up last
		const result = groupSkills(skills, ["claude", "ops", "writing"]);
		const sections = result.map((g) => g.section);
		expect(sections[sections.length - 1]).toBe("claude");
		expect(sections).not.toContain(null);
	});

	it("claude sorts last even when it is the only named section", () => {
		const result = groupSkills([skill("x", "claude")], ["claude"]);
		expect(result).toHaveLength(1);
		expect(result[0].section).toBe("claude");
	});

	it("omits sections that have no matching skills", () => {
		const skills = [skill("a", "present")];
		const result = groupSkills(skills, ["present", "missing"]);
		expect(result).toHaveLength(1);
		expect(result[0].section).toBe("present");
	});

	it("unsectioned skills land in null group after named sections", () => {
		const skills = [skill("sectioned", "tools"), skill("floating")];
		const result = groupSkills(skills, ["tools"]);
		expect(result).toHaveLength(2);
		expect(result[0].section).toBe("tools");
		expect(result[1].section).toBeNull();
		expect(result[1].skills[0].name).toBe("floating");
	});

	it("unsectioned group is sorted alphabetically", () => {
		const skills = [skill("zebra"), skill("apple"), skill("mango")];
		const result = groupSkills(skills, []);
		expect(result[0].skills.map((s) => s.name)).toEqual([
			"apple",
			"mango",
			"zebra",
		]);
	});

	it("mixed: named sections + claude + unsectioned — correct order", () => {
		const skills = [
			skill("x", "claude"),
			skill("y", "tools"),
			skill("z"), // unsectioned
		];
		const result = groupSkills(skills, ["tools", "claude"]);
		expect(result.map((g) => g.section)).toEqual(["tools", "claude", null]);
	});

	it("skill with unknown section falls into null group", () => {
		const skills = [skill("orphan", "nonexistent-section")];
		const result = groupSkills(skills, ["known"]);
		expect(result).toHaveLength(1);
		expect(result[0].section).toBeNull();
		expect(result[0].skills[0].name).toBe("orphan");
	});

	it("preserves sectionOrder for non-claude sections", () => {
		const skills = [skill("a", "z-section"), skill("b", "a-section")];
		const result = groupSkills(skills, ["z-section", "a-section"]);
		expect(result[0].section).toBe("z-section");
		expect(result[1].section).toBe("a-section");
	});
});
