import { describe, expect, it } from "vitest";
import { assembleCockpitData } from "./cockpitData";

function skill(name: string) {
	return {
		file: `${name}.md`,
		name,
		description: name,
		content: "",
		filePath: `/skills/${name}.md`,
	};
}

function project(status: "active" | "done") {
	return {
		file: `${status}.md`,
		title: status,
		status,
		rawStatus: status,
		tags: [],
		isFolder: false,
	};
}

describe("assembleCockpitData", () => {
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
		const result = assembleCockpitData({
			inboxCount: 2,
			projects: [project("active"), project("done")],
			vaultSkills: [skill("Shared"), skill("Vault")],
			sectionOrder: ["core"],
			claudeSkills: [skill("shared"), skill("Claude")],
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
});
