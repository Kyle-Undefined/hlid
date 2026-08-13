import { describe, expect, it } from "vitest";
import {
	FORGE_CATEGORIES,
	forgeDestinationsForCategory,
	forgeSearchFromNavigation,
	getForgeCategory,
	getForgeNavigationFocusId,
	getForgeNavigationSettingLabel,
	normalizeForgeNavigation,
	parseForgeSearch,
	searchForgeDestinations,
	serializeForgeNavigation,
} from "./forgeNavigation";

describe("Forge navigation metadata", () => {
	it("exposes every category and section with stable unique ids", () => {
		expect(FORGE_CATEGORIES.map((category) => category.id)).toEqual([
			"overview",
			"workspace",
			"agents",
			"access",
			"experience",
			"integrations",
			"extensions",
			"developer",
			"advanced",
		]);
		for (const category of FORGE_CATEGORIES) {
			expect(new Set(category.sections.map((section) => section.id)).size).toBe(
				category.sections.length,
			);
		}
		expect(
			getForgeCategory("developer").sections.map((section) => section.label),
		).toEqual(["Event Log", "API Reference", "Pricing"]);
	});
});

describe("Forge route search", () => {
	it("keeps only recognized fields that belong to the selected category", () => {
		expect(
			parseForgeSearch({
				category: "developer",
				section: "pricing",
				view: "pricing",
				target: "mobile",
				extra: "ignored",
			}),
		).toEqual({
			category: "developer",
			section: "pricing",
			view: "pricing",
		});
		expect(
			parseForgeSearch({ category: "workspace", view: "pricing" }),
		).toEqual({ category: "workspace" });
		expect(parseForgeSearch({ category: "bogus", view: "api" })).toEqual({});
	});

	it("keeps section landings separate from explicit nested views", () => {
		expect(
			parseForgeSearch({
				category: "experience",
				section: "custom-theme",
				target: "mobile",
			}),
		).toEqual({
			category: "experience",
			section: "custom-theme",
		});
		expect(
			parseForgeSearch({
				category: "experience",
				section: "custom-theme",
				view: "theme",
				target: "mobile",
			}),
		).toEqual({
			category: "experience",
			section: "custom-theme",
			view: "theme",
			target: "mobile",
		});
		expect(
			parseForgeSearch({
				category: "integrations",
				section: "opencode-acp",
			}),
		).toEqual({ category: "integrations", section: "opencode-acp" });
		for (const section of ["apps-connectors", "umbod"] as const) {
			expect(parseForgeSearch({ category: "integrations", section })).toEqual({
				category: "integrations",
				section,
			});
		}
		expect(
			parseForgeSearch({
				category: "integrations",
				section: "mcp",
				target: "desktop",
			}),
		).toEqual({ category: "integrations", section: "mcp" });
	});

	it("canonicalizes view-only and mismatched nested URLs to their section", () => {
		expect(parseForgeSearch({ category: "experience", view: "theme" })).toEqual(
			{
				category: "experience",
				section: "custom-theme",
				view: "theme",
			},
		);
		expect(
			parseForgeSearch({
				category: "integrations",
				section: "mcp",
				view: "apps",
			}),
		).toEqual({
			category: "integrations",
			section: "apps-connectors",
			view: "apps",
		});
	});

	it("normalizes to Overview and serializes compact defaults", () => {
		expect(normalizeForgeNavigation({ category: 42 })).toEqual({
			category: "overview",
		});
		expect(serializeForgeNavigation({ category: "overview" })).toEqual({});
		expect(
			serializeForgeNavigation({
				category: "overview",
				section: "updates",
			}),
		).toEqual({ category: "overview", section: "updates" });
		expect(
			serializeForgeNavigation({
				category: "overview",
				setting: "check-for-updates",
			}),
		).toEqual({ category: "overview", setting: "check-for-updates" });
		expect(
			forgeSearchFromNavigation({ category: "developer", view: "events" }),
		).toEqual({ category: "developer" });
		expect(
			serializeForgeNavigation({
				category: "experience",
				view: "theme",
				target: "desktop",
			}),
		).toEqual({
			category: "experience",
			section: "custom-theme",
			view: "theme",
		});
	});

	it("whitelists exact setting anchors in URL state", () => {
		expect(
			parseForgeSearch({
				category: "experience",
				setting: "recording-hotkey",
			}),
		).toEqual({
			category: "experience",
			section: "voice-input",
			setting: "recording-hotkey",
		});
		expect(
			parseForgeSearch({
				category: "experience",
				setting: "user-supplied-id",
			}),
		).toEqual({ category: "experience" });
		expect(
			forgeSearchFromNavigation(
				normalizeForgeNavigation({
					category: "experience",
					setting: "recording-hotkey",
				}),
			),
		).toEqual({ category: "experience", setting: "recording-hotkey" });
	});

	it("resolves reload-safe navigation to a whitelisted DOM focus target", () => {
		expect(
			getForgeNavigationFocusId({
				category: "experience",
				setting: "recording-hotkey",
			}),
		).toBe("forge-setting-recording-hotkey");
		expect(
			getForgeNavigationFocusId({ category: "developer", view: "api" }),
		).toBe("forge-view-api");
		expect(
			getForgeNavigationFocusId({
				category: "developer",
				section: "api-reference",
				view: "api",
			}),
		).toBe("forge-view-api");
		expect(
			getForgeNavigationFocusId({
				category: "experience",
				section: "voice-input",
			}),
		).toBe("forge-section-voice-input");
		expect(
			getForgeNavigationFocusId({
				category: "experience",
				section: "custom-theme",
				view: "theme",
			}),
		).toBe("forge-view-theme");
		expect(
			getForgeNavigationFocusId({
				category: "integrations",
				section: "opencode-acp",
				view: "acp",
			}),
		).toBe("forge-view-acp");
		expect(
			getForgeNavigationFocusId({
				category: "agents",
				setting: "interactive-mode",
			}),
		).toBe("forge-section-vault-agent");
		expect(
			getForgeNavigationFocusId({
				category: "experience",
				setting: "whisper-threads",
			}),
		).toBe("forge-section-voice-input");
		expect(getForgeNavigationFocusId({ category: "workspace" })).toBe(
			"forge-category-workspace",
		);
		expect(
			getForgeNavigationSettingLabel({
				category: "workspace",
				setting: "memory-folder",
			}),
		).toBe("Memory folder");
	});
});

describe("Forge setting search", () => {
	it("indexes the static Forge controls without duplicate setting ids or labels", () => {
		const settings = FORGE_CATEGORIES.flatMap((category) =>
			forgeDestinationsForCategory(category.id),
		).filter((destination) => destination.kind === "setting");
		expect(settings.length).toBeGreaterThanOrEqual(250);
		expect(new Set(settings.map((destination) => destination.id)).size).toBe(
			settings.length,
		);
		expect(
			new Set(settings.map((destination) => destination.label.toLowerCase()))
				.size,
		).toBe(settings.length);
	});

	it.each([
		[
			"Recording hotkey",
			"setting:recording-hotkey",
			"experience",
			"voice-input",
		],
		["Whisper threads", "setting:whisper-threads", "experience", "voice-input"],
		["Privacy mode", "setting:privacy-mode", "experience", "privacy"],
		["HTML plans", "setting:html-plans", "experience", "ui"],
		[
			"Navigation names",
			"setting:navigation-names",
			"experience",
			"navigation-names",
		],
		[
			"Allow External Agents",
			"setting:allow-external-agents",
			"access",
			"network",
		],
		["TLS Cert Path", "setting:tls-cert-path", "access", "network"],
		[
			"Save to Obsidian Template",
			"setting:save-to-obsidian-template",
			"workspace",
			"vault",
		],
		["Interactive mode", "setting:interactive-mode", "agents", "vault-agent"],
		["Claude peer inbox", "setting:claude-peer-inbox", "agents", "vault-agent"],
		["Pricing", "setting:pricing", "developer", "pricing"],
		["API Reference", "setting:api-reference", "developer", "api-reference"],
		["MCP", "setting:mcp", "integrations", "mcp"],
		["Apps", "setting:apps-connectors", "integrations", "apps-connectors"],
		["Umbod", "setting:umbod", "integrations", "umbod"],
		["ACP", "setting:opencode-acp", "integrations", "opencode-acp"],
		["Custom Theme", "setting:custom-theme", "experience", "custom-theme"],
		[
			"Work finished",
			"setting:notifications-work-finished",
			"experience",
			"notifications",
		],
		[
			"Requests",
			"setting:notifications-requests",
			"experience",
			"notifications",
		],
		[
			"blocked errors",
			"setting:notifications-problems",
			"experience",
			"notifications",
		],
		[
			"completion threshold",
			"setting:notifications-completion-runtime",
			"experience",
			"notifications",
		],
		[
			"pause 8 am",
			"setting:notifications-pause",
			"experience",
			"notifications",
		],
		["send test", "setting:notifications-test", "experience", "notifications"],
		[
			"revoke phone",
			"setting:notifications-devices",
			"experience",
			"notifications",
		],
		["restart", "setting:restart", "advanced", "danger-zone"],
		["reclaim", "setting:reclaim-database-space", "advanced", "danger-zone"],
		["neural", "setting:neural-voice-model", "experience", "voice-models"],
		["template", "setting:save-to-obsidian-template", "workspace", "vault"],
	])("routes %s to a precise destination", (query, id, category, section) => {
		const match = searchForgeDestinations(query).find(
			(destination) => destination.id === id,
		);
		expect(match).toMatchObject({
			id,
			navigation: {
				category,
				section,
				setting: id.replace("setting:", ""),
			},
		});
		expect(match?.breadcrumbs.at(-1)).toBe(match?.label);
	});

	it("supports forgiving multi-token search, ranking exact settings first", () => {
		const results = searchForgeDestinations("  pricing   override ");
		expect(results[0]).toMatchObject({
			id: "setting:pricing",
			breadcrumbs: ["Developer", "Pricing", "Pricing"],
			navigation: {
				category: "developer",
				section: "pricing",
				setting: "pricing",
				view: "pricing",
			},
		});
	});

	it("does not show duplicate setting and section landings", () => {
		const results = searchForgeDestinations("API Reference");
		expect(
			results.filter((destination) => destination.label === "API Reference"),
		).toHaveLength(1);
		expect(results[0]?.id).toBe("setting:api-reference");
	});

	it.each([
		[
			"Custom theme",
			"section:experience:custom-theme",
			"Custom theme",
			"setting:custom-theme",
			"Custom theme editor",
		],
		[
			"OpenCode and ACP agents",
			"section:integrations:opencode-acp",
			"OpenCode and ACP agents",
			"setting:opencode-acp",
			"OpenCode and ACP catalog",
		],
		[
			"Apps and Connectors",
			"section:integrations:apps-connectors",
			"Apps and Connectors",
			"setting:apps-connectors",
			"Apps and Connectors catalog",
		],
	])("distinguishes the %s landing from its nested editor", (query, landingId, landingLabel, editorId, editorLabel) => {
		const results = searchForgeDestinations(query);
		expect(results.find((result) => result.id === landingId)).toMatchObject({
			label: landingLabel,
			navigation: expect.not.objectContaining({ view: expect.anything() }),
		});
		expect(results.find((result) => result.id === editorId)).toMatchObject({
			label: editorLabel,
			navigation: expect.objectContaining({
				view:
					editorId === "setting:custom-theme"
						? "theme"
						: editorId === "setting:apps-connectors"
							? "apps"
							: "acp",
			}),
		});
		expect(new Set(results.map((result) => result.label)).size).toBe(
			results.length,
		);
	});

	it.each([
		["Check for updates", "setting:check-for-updates", "overview", "updates"],
		["Launch installer", "setting:launch-installer", "overview", "updates"],
		["Memory folder", "setting:memory-folder", "workspace", "vault"],
		[
			"Remembered command approvals",
			"setting:remembered-command-approvals",
			"workspace",
			"obsidian-desktop",
		],
		[
			"Vault Agent effort",
			"setting:vault-agent-effort",
			"agents",
			"vault-agent",
		],
		["Resume buffer", "setting:resume-buffer", "agents", "auto-sleep"],
		["TLS Key Path", "setting:tls-key-path", "access", "network"],
		[
			"Mobile theme override",
			"setting:mobile-theme-override",
			"experience",
			"ui",
		],
		["Reading speed", "setting:reading-speed", "experience", "read-aloud"],
		[
			"Microphone action",
			"setting:microphone-action",
			"experience",
			"voice-input",
		],
		[
			"Connect OpenAI Codex account",
			"setting:cliproxy-openai-account",
			"integrations",
			"cli-proxy",
		],
		[
			"Umbod call explorer",
			"setting:umbod-call-explorer",
			"integrations",
			"umbod",
		],
		[
			"Marketplace sparse paths",
			"setting:marketplace-sparse-paths",
			"extensions",
			"provider-extensions",
		],
		[
			"Event Log persistence",
			"setting:event-log-persistence",
			"developer",
			"event-log",
		],
		["Clear Event Log", "setting:clear-event-log", "developer", "event-log"],
		[
			"Pricing overrides TOML",
			"setting:pricing-overrides-toml",
			"developer",
			"pricing",
		],
		[
			"Reload session",
			"setting:reload-session",
			"advanced",
			"session-lifecycle",
		],
	])("finds the indexed %s control", (query, id, category, section) => {
		expect(searchForgeDestinations(query)[0]).toMatchObject({
			id,
			navigation: { category, section },
		});
	});

	it("returns category destinations with broad and exact anchor ids", () => {
		const destinations = forgeDestinationsForCategory("integrations");
		expect(destinations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "section:integrations:mcp",
					anchorId: "forge-section-mcp",
				}),
				expect.objectContaining({
					id: "setting:mcp",
					anchorId: "forge-section-mcp",
				}),
			]),
		);
	});

	it("publishes on-page anchors separately from nested view anchors", () => {
		const expected = new Map([
			["section:experience:custom-theme", "forge-section-custom-theme"],
			["section:integrations:apps-connectors", "forge-section-apps-connectors"],
			["section:integrations:umbod", "forge-section-umbod"],
			["section:integrations:opencode-acp", "forge-section-opencode-acp"],
			["section:developer:event-log", "forge-view-events"],
			["section:developer:api-reference", "forge-view-api"],
			["section:developer:pricing", "forge-view-pricing"],
		]);
		const sections = FORGE_CATEGORIES.flatMap((category) =>
			forgeDestinationsForCategory(category.id),
		).filter((destination) => destination.kind === "section");
		for (const [id, anchorId] of expected) {
			expect(
				sections.find((destination) => destination.id === id),
			).toMatchObject({
				anchorId,
			});
		}
	});

	it("opens the desktop-to-mobile copy action on its rendered target", () => {
		const destination = searchForgeDestinations(
			"Copy desktop custom theme",
		).find(
			(destination) => destination.id === "setting:copy-desktop-custom-theme",
		);
		expect(destination).toBeDefined();
		if (!destination) throw new Error("Missing custom theme copy destination");
		expect(destination?.navigation).toEqual({
			category: "experience",
			section: "custom-theme",
			setting: "copy-desktop-custom-theme",
			view: "theme",
			target: "mobile",
		});
		expect(serializeForgeNavigation(destination.navigation)).toEqual({
			category: "experience",
			setting: "copy-desktop-custom-theme",
			target: "mobile",
		});
	});

	it("publishes exact focus ids only for settings with matching DOM anchors", () => {
		const expected = [
			"save-to-obsidian-template",
			"allow-external-agents",
			"tls-cert-path",
			"html-plans",
			"recording-hotkey",
			"privacy-mode",
			"reclaim-database-space",
			"restart",
		];
		const exactDestinations = FORGE_CATEGORIES.flatMap((category) =>
			forgeDestinationsForCategory(category.id),
		).filter((destination) => destination.focusId);
		expect(
			exactDestinations.map((destination) => destination.navigation.setting),
		).toEqual(expected);
		expect(exactDestinations.map((destination) => destination.focusId)).toEqual(
			expected.map((setting) => `forge-setting-${setting}`),
		);
	});

	it("returns no destinations for an empty query or zero limit", () => {
		expect(searchForgeDestinations("   ")).toEqual([]);
		expect(searchForgeDestinations("pricing", 0)).toEqual([]);
	});
});
