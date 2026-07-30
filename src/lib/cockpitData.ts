import type { Project, Skill } from "#/lib/vault";

export function assembleCockpitData(options: {
	inboxCount: number;
	projects: Project[];
	vaultSkills: Skill[];
	sectionOrder: string[];
	claudeSkills: Skill[];
	managedSkills?: Skill[];
}) {
	const {
		inboxCount,
		projects,
		vaultSkills,
		sectionOrder,
		claudeSkills: rawClaudeSkills,
		managedSkills: rawManagedSkills = [],
	} = options;
	const vaultSkillNames = new Set(
		vaultSkills.map((skill) => skill.name.toLowerCase()),
	);
	const managedSkills = rawManagedSkills
		.filter((skill) => !vaultSkillNames.has(skill.name.toLowerCase()))
		.map((skill) => ({ ...skill, section: "hlid", source: "hlid" as const }));
	const occupiedNames = new Set(
		[...vaultSkills, ...managedSkills].map((skill) => skill.name.toLowerCase()),
	);
	const claudeSkills = rawClaudeSkills
		.filter((skill) => !occupiedNames.has(skill.name.toLowerCase()))
		.map((skill) => ({
			...skill,
			section: "claude",
			providerId: "claude",
		}));
	const namedSections = [...sectionOrder];
	if (managedSkills.length > 0 && !namedSections.includes("hlid")) {
		namedSections.push("hlid");
	}
	if (claudeSkills.length > 0 && !namedSections.includes("claude")) {
		namedSections.push("claude");
	}

	return {
		inboxCount,
		activeCount: projects.filter((project) => project.status === "active")
			.length,
		totalCount: projects.length,
		skills: [...vaultSkills, ...managedSkills, ...claudeSkills],
		sectionOrder: namedSections,
	};
}
