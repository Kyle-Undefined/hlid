import type { Skill } from "./skills";

/**
 * Pure helper that resolves the effective `text` and optional `skillContext`
 * for a chat submission.
 *
 * Three cases:
 *  1. `activeSkill` is set — format as a slash command; vault skills also
 *     attach a skillContext so the server can inject the file.
 *  2. `typed` starts with "/" — resolve against the skill list; vault skills
 *     strip the "/name: " prefix from text and attach skillContext; claude
 *     skills keep the full typed text.
 *  3. Plain text — pass through unchanged.
 */
export function resolveSkillPrompt(
	activeSkill: { name: string; section?: string; filePath: string } | null,
	typed: string,
	allSkills: Skill[],
): { text: string; skillContext: string | undefined } {
	if (activeSkill) {
		const text = typed
			? `/${activeSkill.name}: ${typed}`
			: `/${activeSkill.name}`;
		const skillContext =
			activeSkill.section !== "claude" ? activeSkill.filePath : undefined;
		return { text, skillContext };
	}

	if (typed.startsWith("/")) {
		const slashName = typed.slice(1).split(/[:\s]/)[0].toLowerCase();
		const match = allSkills.find((s) => s.name.toLowerCase() === slashName);
		if (match) {
			if (match.section !== "claude") {
				// Vault skill: strip "/name: " prefix so only the user suffix is sent
				const text = typed.slice(match.name.length + 2).trim();
				return { text, skillContext: match.filePath };
			}
			// Claude skill: keep full slash command, CLI handles it natively
			return { text: typed, skillContext: undefined };
		}
	}

	return { text: typed, skillContext: undefined };
}
