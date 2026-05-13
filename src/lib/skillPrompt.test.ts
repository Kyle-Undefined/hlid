/**
 * Tests for resolveSkillPrompt — pure helper that extracts text and optional
 * skill context from a user submission given an active skill state and skill list.
 */
import { describe, expect, it } from "vitest";
import { resolveSkillPrompt } from "./skillPrompt";
import type { Skill } from "./skills";

function makeSkill(name: string, section?: string): Skill {
	return {
		file: `${name}.md`,
		name,
		description: `${name} description`,
		content: `content of ${name}`,
		filePath: `/vault/.claude/skills/${name}.md`,
		section,
	};
}

describe("resolveSkillPrompt", () => {
	describe("activeSkill set (claude section)", () => {
		it("formats slash command with typed suffix", () => {
			const skill = { name: "review", section: "claude", filePath: "" };
			const result = resolveSkillPrompt(skill, "some extra text", []);
			expect(result).toEqual({
				text: "/review: some extra text",
				skillContext: undefined,
			});
		});

		it("formats bare slash command when no typed text", () => {
			const skill = { name: "review", section: "claude", filePath: "" };
			const result = resolveSkillPrompt(skill, "", []);
			expect(result).toEqual({ text: "/review", skillContext: undefined });
		});
	});

	describe("activeSkill set (vault section)", () => {
		it("includes skill context and slash command with typed suffix", () => {
			const skill = {
				name: "analyze",
				section: "vault",
				filePath: "/vault/.claude/skills/analyze.md",
			};
			const result = resolveSkillPrompt(skill, "my prompt", []);
			expect(result).toEqual({
				text: "/analyze: my prompt",
				skillContext: "/vault/.claude/skills/analyze.md",
			});
		});

		it("includes skill context and bare slash command when no typed text", () => {
			const skill = {
				name: "analyze",
				section: "vault",
				filePath: "/vault/.claude/skills/analyze.md",
			};
			const result = resolveSkillPrompt(skill, "", []);
			expect(result).toEqual({
				text: "/analyze",
				skillContext: "/vault/.claude/skills/analyze.md",
			});
		});
	});

	describe("no activeSkill, typed starts with slash", () => {
		it("resolves vault skill from slash and returns file context + stripped text", () => {
			const skills = [
				makeSkill("analyze", "vault"),
				makeSkill("review", "claude"),
			];
			const result = resolveSkillPrompt(null, "/analyze: do this", skills);
			expect(result).toEqual({
				text: "do this",
				skillContext: "/vault/.claude/skills/analyze.md",
			});
		});

		it("keeps full typed text for a claude skill", () => {
			const skills = [makeSkill("review", "claude")];
			const result = resolveSkillPrompt(null, "/review: something", skills);
			expect(result).toEqual({
				text: "/review: something",
				skillContext: undefined,
			});
		});

		it("returns typed text unchanged when slash name has no match", () => {
			const skills = [makeSkill("analyze", "vault")];
			const result = resolveSkillPrompt(null, "/unknown: text", skills);
			expect(result).toEqual({
				text: "/unknown: text",
				skillContext: undefined,
			});
		});
	});

	describe("no activeSkill, plain text", () => {
		it("returns text unchanged with no skill context", () => {
			const result = resolveSkillPrompt(null, "just ask claude", []);
			expect(result).toEqual({
				text: "just ask claude",
				skillContext: undefined,
			});
		});
	});
});
