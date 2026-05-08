/**
 * Client-safe skill types and helpers.
 * No Node.js imports — safe to use in browser bundles.
 * vault.ts imports Skill from here; server code uses scanSkills from vault.ts.
 */

export type Skill = {
	file: string;
	name: string;
	description: string;
	content: string;
	filePath: string;
	section?: string;
};

export type SkillGroup = {
	section: string | null;
	skills: Skill[];
};

/**
 * Groups and sorts skills by section order.
 * Unsectioned skills fall into a null group at the end.
 * "claude" section always sorts last among named sections.
 */
export function groupSkills(
	skills: Skill[],
	sectionOrder: string[],
): SkillGroup[] {
	// Enforce: "claude" always last among named sections, regardless of input order.
	const orderedSections = [
		...sectionOrder.filter((s) => s !== "claude"),
		...(sectionOrder.includes("claude") ? ["claude"] : []),
	];

	const groups: SkillGroup[] = [];
	const seen = new Set<string>();
	for (const sec of orderedSections) {
		const members = skills.filter((s) => s.section === sec);
		if (members.length === 0) continue;
		groups.push({
			section: sec,
			skills: [...members].sort((a, b) => a.name.localeCompare(b.name)),
		});
		for (const s of members) seen.add(s.file);
	}
	const unsectioned = skills.filter((s) => !seen.has(s.file));
	if (unsectioned.length > 0)
		groups.push({
			section: null,
			skills: [...unsectioned].sort((a, b) => a.name.localeCompare(b.name)),
		});
	return groups;
}
