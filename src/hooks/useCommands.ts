import { useMemo } from "react";
import { mergeCommands, type ProviderCommand } from "#/lib/commands";
import type { Skill } from "#/lib/skills";

export function useCommands(
	vaultSkills: Skill[],
	providerCommands: ProviderCommand[],
	providerId?: string,
) {
	return useMemo(
		() => mergeCommands(vaultSkills, providerCommands, providerId),
		[vaultSkills, providerCommands, providerId],
	);
}
