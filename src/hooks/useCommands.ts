import { useMemo } from "react";
import { mergeCommands, type ProviderCommand } from "#/lib/commands";
import type { Skill } from "#/lib/skills";

export function useCommands(
	vaultSkills: Skill[],
	providerCommands: ProviderCommand[],
	providerId?: string,
	surface: "raven" | "watch" = "raven",
) {
	return useMemo(
		() => mergeCommands(vaultSkills, providerCommands, providerId, surface),
		[vaultSkills, providerCommands, providerId, surface],
	);
}
