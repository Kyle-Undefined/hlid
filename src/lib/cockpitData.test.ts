import { describe, expect, it, vi } from "vitest";
import { HlidConfigSchema } from "#/config";
import { assembleCockpitData, collectCockpitData } from "./cockpitData";

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
	it("merges Hlid-managed skills without coupling them to a provider", () => {
		const result = assembleCockpitData({
			inboxCount: 0,
			projects: [],
			vaultSkills: [skill("Vault")],
			sectionOrder: [],
			managedSkills: [skill("Managed")],
			claudeSkills: [],
		});
		expect(result.sectionOrder).toEqual(["hlid"]);
		expect(result.skills[1]).toMatchObject({
			name: "Managed",
			section: "hlid",
			source: "hlid",
		});
	});

	it("prefers an imported Hlid copy over a same-named provider skill", () => {
		const result = assembleCockpitData({
			inboxCount: 0,
			projects: [],
			vaultSkills: [],
			sectionOrder: [],
			managedSkills: [skill("Shared")],
			claudeSkills: [skill("Shared")],
		});
		expect(result.skills).toHaveLength(1);
		expect(result.skills[0]).toMatchObject({
			name: "Shared",
			section: "hlid",
			source: "hlid",
		});
		expect(result.skills[0]).not.toHaveProperty("providerId");
	});

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
		expect(
			result.skills.find((entry) => entry.name === "Claude"),
		).toMatchObject({
			providerId: "claude",
			section: "claude",
		});
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
