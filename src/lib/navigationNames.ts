export const NAVIGATION_IDS = [
	"watch",
	"vault",
	"relics",
	"raven",
	"einherjar",
	"ledger",
	"forge",
] as const;

export type NavigationId = (typeof NAVIGATION_IDS)[number];

export const NAVIGATION_NAME_PRESETS = ["hlid", "plain"] as const;

export type NavigationNamePreset = (typeof NAVIGATION_NAME_PRESETS)[number];

export type NavigationNamesConfig = {
	preset: NavigationNamePreset;
	labels: Partial<Record<NavigationId, string>>;
};

export type NavigationNameDefinition = {
	id: NavigationId;
	hlidLabel: string;
	plainLabel: string;
	meaning: string;
};

export const NAVIGATION_NAME_DEFINITIONS = [
	{
		id: "watch",
		hlidLabel: "WATCH",
		plainLabel: "HOME",
		meaning: "System overview and live activity",
	},
	{
		id: "vault",
		hlidLabel: "VAULT",
		plainLabel: "KNOWLEDGE",
		meaning: "Indexed knowledge and reference material",
	},
	{
		id: "relics",
		hlidLabel: "RELICS",
		plainLabel: "LIBRARY",
		meaning: "Saved artifacts and deliverables",
	},
	{
		id: "raven",
		hlidLabel: "RAVEN",
		plainLabel: "CHAT",
		meaning: "Conversations and active sessions",
	},
	{
		id: "einherjar",
		hlidLabel: "EINHERJAR",
		plainLabel: "AGENTS",
		meaning: "Agent profiles and instructions",
	},
	{
		id: "ledger",
		hlidLabel: "LEDGER",
		plainLabel: "HISTORY",
		meaning: "Session history, usage, and accounting",
	},
	{
		id: "forge",
		hlidLabel: "FORGE",
		plainLabel: "SETTINGS",
		meaning: "Hlid configuration and integrations",
	},
] as const satisfies readonly NavigationNameDefinition[];

export const DEFAULT_NAVIGATION_NAMES_CONFIG: NavigationNamesConfig = {
	preset: "hlid",
	labels: {},
};

export const NAVIGATION_LABEL_MAX_GRAPHEMES = 24;

const graphemeSegmenter = new Intl.Segmenter(undefined, {
	granularity: "grapheme",
});

/** Normalize stored/displayed labels without changing their chosen casing. */
export function normalizeNavigationLabel(value: string): string {
	return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

/** Control and bidirectional formatting characters are unsafe in navigation UI. */
export function hasForbiddenNavigationLabelCharacters(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint === undefined) continue;

		const isControl =
			codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
		const isBidirectionalControl =
			codePoint === 0x061c ||
			(codePoint >= 0x200e && codePoint <= 0x200f) ||
			(codePoint >= 0x202a && codePoint <= 0x202e) ||
			(codePoint >= 0x2066 && codePoint <= 0x2069);
		const isInvisibleFormat =
			/\p{Cf}/u.test(character) && codePoint !== 0x200c && codePoint !== 0x200d;

		if (isControl || isBidirectionalControl || isInvisibleFormat) return true;
	}

	return false;
}

/** Require a visible base character while allowing joiners inside real words. */
export function hasVisibleNavigationLabelCharacters(value: string): boolean {
	return /[\p{L}\p{N}\p{P}\p{S}]/u.test(normalizeNavigationLabel(value));
}

export function navigationLabelGraphemeCount(value: string): number {
	return Array.from(graphemeSegmenter.segment(value)).length;
}

function presetLabel(
	definition: NavigationNameDefinition,
	preset: NavigationNamePreset | undefined,
): string {
	return preset === "plain" ? definition.plainLabel : definition.hlidLabel;
}

function usableOverride(value: string | undefined): string | undefined {
	if (value === undefined || hasForbiddenNavigationLabelCharacters(value)) {
		return undefined;
	}

	const normalized = normalizeNavigationLabel(value);
	if (
		!hasVisibleNavigationLabelCharacters(normalized) ||
		navigationLabelGraphemeCount(normalized) > NAVIGATION_LABEL_MAX_GRAPHEMES
	) {
		return undefined;
	}

	return normalized;
}

export function resolveNavigationLabel(
	id: NavigationId,
	config?: NavigationNamesConfig,
): string {
	const definition = NAVIGATION_NAME_DEFINITIONS.find(
		(candidate) => candidate.id === id,
	);
	if (!definition) return id;

	return (
		usableOverride(config?.labels[id]) ??
		presetLabel(definition, config?.preset)
	);
}

export function resolveNavigationLabels(
	config?: NavigationNamesConfig,
): Record<NavigationId, string> {
	return Object.fromEntries(
		NAVIGATION_IDS.map((id) => [id, resolveNavigationLabel(id, config)]),
	) as Record<NavigationId, string>;
}

/** Return every item involved in an effective-label collision, in menu order. */
export function duplicateEffectiveNavigationLabelIds(
	config?: NavigationNamesConfig,
): NavigationId[] {
	const labels = resolveNavigationLabels(config);
	const idsByComparableLabel = new Map<string, NavigationId[]>();

	for (const id of NAVIGATION_IDS) {
		const comparableLabel = labels[id].toLowerCase().normalize("NFC");
		const matchingIds = idsByComparableLabel.get(comparableLabel) ?? [];
		matchingIds.push(id);
		idsByComparableLabel.set(comparableLabel, matchingIds);
	}

	const duplicateIds = new Set(
		Array.from(idsByComparableLabel.values())
			.filter((ids) => ids.length > 1)
			.flat(),
	);
	return NAVIGATION_IDS.filter((id) => duplicateIds.has(id));
}
