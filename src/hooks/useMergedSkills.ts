import { useMemo } from "react";
import type { Skill } from "#/lib/skills";

type SdkCommand = {
	name: string;
	description: string;
	argumentHint: string;
	aliases?: string[];
};

/**
 * Merges vault skills (from server scan) with SDK slash commands (from probe_slash_commands).
 *
 * Rules:
 *  - SDK commands with a "(user)" suffix are skipped — they are user-defined skills
 *    the SDK echoes back, already present in vaultSkills from the file scan.
 *  - Deduplication by normalized name (case-insensitive, "(user)" suffix stripped).
 *    Vault skills take priority over SDK skills of the same name.
 *
 * TODO: SDK commands expose `aliases` not yet in the Skill shape.
 *       Wire aliases into prefix matching once Skill gains that field.
 */
export function useMergedSkills(
	vaultSkills: Skill[],
	sdkCommands: SdkCommand[],
): Skill[] {
	return useMemo(() => {
		const sdkSkills: Skill[] = sdkCommands
			.filter((cmd) => !/\(user\)/i.test(cmd.name))
			.map((cmd) => ({
				file: `__sdk__/${cmd.name}`,
				name: cmd.name,
				description: cmd.description,
				content: "",
				filePath: "",
				section: "claude",
			}));

		const seen = new Set<string>();
		const result: Skill[] = [];
		for (const s of [...vaultSkills, ...sdkSkills]) {
			const key = s.name.toLowerCase().replace(/\s*\(user\)\s*$/i, "");
			if (!seen.has(key)) {
				seen.add(key);
				result.push(s);
			}
		}
		return result;
	}, [vaultSkills, sdkCommands]);
}
