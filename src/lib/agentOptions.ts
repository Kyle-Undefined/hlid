/**
 * Shared UI-level option arrays that live at the hlid application layer,
 * not on any specific agent provider.
 *
 * Provider-specific options (models, effort levels, permission modes) are
 * declared on each AgentProvider implementation and flow through ProviderInfo
 * so adding a new provider requires zero changes here.
 */

/** Theme choices for the hlid UI. */
export const THEME_OPTIONS = [
	{
		value: "dark" as const,
		label: "Dark",
		desc: "neutral dark with sky blue accent, the default",
	},
	{
		value: "tan" as const,
		label: "Tan",
		desc: "warm parchment with terracotta accent, easy on the eyes",
	},
] satisfies ReadonlyArray<{
	value: "dark" | "tan";
	label: string;
	desc: string;
}>;
