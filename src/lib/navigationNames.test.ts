import { describe, expect, it } from "vitest";
import {
	DEFAULT_NAVIGATION_NAMES_CONFIG,
	duplicateEffectiveNavigationLabelIds,
	hasForbiddenNavigationLabelCharacters,
	hasVisibleNavigationLabelCharacters,
	NAVIGATION_IDS,
	NAVIGATION_LABEL_MAX_GRAPHEMES,
	NAVIGATION_NAME_DEFINITIONS,
	NAVIGATION_NAME_PRESETS,
	type NavigationNamesConfig,
	navigationLabelGraphemeCount,
	normalizeNavigationLabel,
	resolveNavigationLabel,
	resolveNavigationLabels,
} from "./navigationNames";

describe("navigation name definitions", () => {
	it("keeps stable IDs and the Hlid vocabulary in menu order", () => {
		expect(NAVIGATION_IDS).toEqual([
			"watch",
			"vault",
			"relics",
			"raven",
			"einherjar",
			"ledger",
			"forge",
		]);
		expect(NAVIGATION_NAME_DEFINITIONS.map(({ id }) => id)).toEqual(
			NAVIGATION_IDS,
		);
		expect(
			NAVIGATION_NAME_DEFINITIONS.map(({ hlidLabel }) => hlidLabel),
		).toEqual([
			"WATCH",
			"VAULT",
			"RELICS",
			"RAVEN",
			"EINHERJAR",
			"LEDGER",
			"FORGE",
		]);
	});

	it("defines the plain default and Hlid option", () => {
		expect(NAVIGATION_NAME_PRESETS).toEqual(["plain", "hlid"]);
		expect(DEFAULT_NAVIGATION_NAMES_CONFIG).toEqual({
			preset: "plain",
			labels: {},
		});
	});
});

describe("navigation label normalization and safety", () => {
	it("normalizes to NFC, trims, and collapses whitespace", () => {
		expect(normalizeNavigationLabel("  Cafe\u0301\t  tools  ")).toBe(
			"Café tools",
		);
	});

	it("detects control and bidirectional formatting characters", () => {
		for (const unsafeLabel of [
			"line\nbreak",
			"null\u0000byte",
			"delete\u007fcharacter",
			"right\u202eto-left",
			"isolate\u2066text",
			"zero\u200bwidth",
			"word\u2060joiner",
			"soft\u00adhyphen",
			"byte\ufefforder",
		]) {
			expect(hasForbiddenNavigationLabelCharacters(unsafeLabel)).toBe(true);
		}
	});

	it("allows ordinary Unicode and emoji shaping characters", () => {
		expect(hasForbiddenNavigationLabelCharacters("Bókasafn 📚")).toBe(false);
		expect(hasForbiddenNavigationLabelCharacters("צ'אט")).toBe(false);
		expect(hasForbiddenNavigationLabelCharacters("TEAM 👩‍💻")).toBe(false);
		expect(hasForbiddenNavigationLabelCharacters("کتابخانه")).toBe(false);
	});

	it("requires a visible character in labels that use shaping joiners", () => {
		expect(hasVisibleNavigationLabelCharacters("\u200c")).toBe(false);
		expect(hasVisibleNavigationLabelCharacters("\u200d")).toBe(false);
		expect(hasVisibleNavigationLabelCharacters("\u200c\u200d")).toBe(false);
		expect(hasVisibleNavigationLabelCharacters("👩‍💻")).toBe(true);
		expect(hasVisibleNavigationLabelCharacters("کتابخانه")).toBe(true);
	});

	it("enforces the limit by user-perceived graphemes", () => {
		expect(navigationLabelGraphemeCount("e\u0301")).toBe(1);
		expect(navigationLabelGraphemeCount("👨‍👩‍👧‍👦")).toBe(1);
		expect(
			navigationLabelGraphemeCount("🧭".repeat(NAVIGATION_LABEL_MAX_GRAPHEMES)),
		).toBe(NAVIGATION_LABEL_MAX_GRAPHEMES);
	});
});

describe("resolveNavigationLabels", () => {
	it("uses plain-language names with no configuration", () => {
		expect(resolveNavigationLabels()).toEqual({
			watch: "HOME",
			vault: "KNOWLEDGE",
			relics: "LIBRARY",
			raven: "CHAT",
			einherjar: "AGENTS",
			ledger: "HISTORY",
			forge: "SETTINGS",
		});
	});

	it("resolves the complete plain-language preset", () => {
		expect(resolveNavigationLabels({ preset: "plain", labels: {} })).toEqual({
			watch: "HOME",
			vault: "KNOWLEDGE",
			relics: "LIBRARY",
			raven: "CHAT",
			einherjar: "AGENTS",
			ledger: "HISTORY",
			forge: "SETTINGS",
		});
	});

	it("places a normalized override ahead of the selected preset", () => {
		const config: NavigationNamesConfig = {
			preset: "plain",
			labels: { einherjar: "  Wo\u0308rk   space  " },
		};

		expect(resolveNavigationLabel("einherjar", config)).toBe("Wörk space");
		expect(resolveNavigationLabel("raven", config)).toBe("CHAT");
	});

	it("falls back to the preset for unusable overrides", () => {
		const config: NavigationNamesConfig = {
			preset: "plain",
			labels: {
				watch: "   ",
				vault: "unsafe\u202ename",
				relics: "\u200d",
				raven: "x".repeat(NAVIGATION_LABEL_MAX_GRAPHEMES + 1),
			},
		};

		expect(resolveNavigationLabel("watch", config)).toBe("HOME");
		expect(resolveNavigationLabel("vault", config)).toBe("KNOWLEDGE");
		expect(resolveNavigationLabel("relics", config)).toBe("LIBRARY");
		expect(resolveNavigationLabel("raven", config)).toBe("CHAT");
	});
});

describe("duplicateEffectiveNavigationLabelIds", () => {
	it("reports no collisions for either built-in preset", () => {
		expect(duplicateEffectiveNavigationLabelIds()).toEqual([]);
		expect(
			duplicateEffectiveNavigationLabelIds({ preset: "plain", labels: {} }),
		).toEqual([]);
	});

	it("reports every colliding ID in menu order after normalization", () => {
		const config: NavigationNamesConfig = {
			preset: "hlid",
			labels: {
				watch: "  Shared   Space ",
				raven: "shared space",
				forge: "SHARED SPACE",
			},
		};

		expect(duplicateEffectiveNavigationLabelIds(config)).toEqual([
			"watch",
			"raven",
			"forge",
		]);
	});

	it("detects an override that collides with a preset label", () => {
		expect(
			duplicateEffectiveNavigationLabelIds({
				preset: "plain",
				labels: { vault: " chat " },
			}),
		).toEqual(["vault", "raven"]);
	});
});
