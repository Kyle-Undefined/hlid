import { describe, expect, it, vi } from "vitest";
import { HlidConfigSchema } from "#/config";
import { collectCockpitData } from "./cockpitData";

function skill(name: string) {
	return {
		file: `${name}.md`,
		name,
		description: name,
		content: "",
		filePath: `/skills/${name}.md`,
	};
}

describe("collectCockpitData", () => {
	it("aggregates projects and merges Claude skills without duplicates", () => {
		const readDirectory = vi.fn(() => ["one.md", "two.txt", "three.md"]);
		const scanProjects = vi.fn(() => [
			{ status: "active" },
			{ status: "done" },
		]);
		const scanSkills = vi
			.fn()
			.mockReturnValueOnce({
				skills: [skill("Shared"), skill("Vault")],
				sectionOrder: ["core"],
			})
			.mockReturnValueOnce({
				skills: [skill("shared"), skill("Claude")],
				sectionOrder: [],
			});
		const config = HlidConfigSchema.parse({
			vault: {
				path: "/vault",
				inbox: "Inbox",
				projects: "Projects",
				skills: "Skills",
			},
		});

		const result = collectCockpitData(config, {
			readDirectory,
			scanProjects: scanProjects as never,
			scanSkills,
			joinPath: (...parts) => parts.join("/"),
			claudeSkillsDir: "/home/.claude/skills",
		});

		expect(result).toMatchObject({
			inboxCount: 2,
			activeCount: 1,
			totalCount: 2,
			sectionOrder: ["core", "claude"],
		});
		expect(result.skills.map((entry) => entry.name)).toEqual([
			"Shared",
			"Vault",
			"Claude",
		]);
	});

	it("treats a missing inbox as empty without hiding other data", () => {
		const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
		const config = HlidConfigSchema.parse({ vault: { path: "/vault" } });
		const result = collectCockpitData(config, {
			readDirectory: () => {
				throw missing;
			},
			scanProjects: () => [],
			scanSkills: () => ({ skills: [], sectionOrder: [] }),
			joinPath: (...parts) => parts.join("/"),
			claudeSkillsDir: "/home/.claude/skills",
		});

		expect(result.inboxCount).toBe(0);
		expect(result.skills).toEqual([]);
	});
});
