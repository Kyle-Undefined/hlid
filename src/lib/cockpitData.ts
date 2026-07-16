import type { HlidConfig } from "#/config";
import type { Project, Skill } from "#/lib/vault";

type SkillScan = { skills: Skill[]; sectionOrder: string[] };

type CockpitDataDependencies = {
	readDirectory: (path: string) => string[];
	scanProjects: (
		vaultPath: string,
		projectsFolder: string,
		vocabulary: HlidConfig["status_vocabulary"],
	) => Project[];
	scanSkills: (
		vaultPath: string,
		skillsFolder: string,
		hideIndex?: boolean,
	) => SkillScan;
	joinPath: (...parts: string[]) => string;
	claudeSkillsDir: string;
};

export function assembleCockpitData(options: {
	inboxCount: number;
	projects: Project[];
	vaultSkills: Skill[];
	sectionOrder: string[];
	claudeSkills: Skill[];
}) {
	const {
		inboxCount,
		projects,
		vaultSkills,
		sectionOrder,
		claudeSkills: rawClaudeSkills,
	} = options;
	const vaultSkillNames = new Set(
		vaultSkills.map((skill) => skill.name.toLowerCase()),
	);
	const claudeSkills = rawClaudeSkills
		.filter((skill) => !vaultSkillNames.has(skill.name.toLowerCase()))
		.map((skill) => ({
			...skill,
			section: "claude",
			providerId: "claude",
		}));

	return {
		inboxCount,
		activeCount: projects.filter((project) => project.status === "active")
			.length,
		totalCount: projects.length,
		skills: [...vaultSkills, ...claudeSkills],
		sectionOrder:
			claudeSkills.length > 0 ? [...sectionOrder, "claude"] : sectionOrder,
	};
}

export function collectCockpitData(
	config: HlidConfig,
	dependencies: CockpitDataDependencies,
) {
	const { vault, status_vocabulary } = config;
	let inboxCount = 0;
	if (vault.path && vault.inbox) {
		try {
			inboxCount = dependencies
				.readDirectory(dependencies.joinPath(vault.path, vault.inbox))
				.filter((file) => file.endsWith(".md")).length;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				console.warn("Failed to read inbox directory:", error);
			}
		}
	}

	const projects =
		vault.path && vault.projects
			? dependencies.scanProjects(vault.path, vault.projects, status_vocabulary)
			: [];
	const { skills: vaultSkills, sectionOrder } =
		vault.path && vault.skills
			? dependencies.scanSkills(
					vault.path,
					vault.skills,
					config.ui.hide_skills_index,
				)
			: { skills: [], sectionOrder: [] };
	const { skills: rawClaudeSkills } = dependencies.scanSkills(
		dependencies.claudeSkillsDir,
		".",
		false,
	);
	return assembleCockpitData({
		inboxCount,
		projects,
		vaultSkills,
		sectionOrder,
		claudeSkills: rawClaudeSkills,
	});
}
