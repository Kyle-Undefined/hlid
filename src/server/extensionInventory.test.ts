import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HlidConfig } from "../config";
import {
	discoverExtensionInventory,
	type ProviderExtensionHome,
	parseCodexMarketplaceList,
	providerExtensionHomes,
	reviewAvailableExtension,
} from "./extensionInventory";

let root: string;
let home: ProviderExtensionHome;

function config(): HlidConfig {
	return {
		vault: { path: "", name: "Test" },
		agents: [],
	} as unknown as HlidConfig;
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2));
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "hlid-extension-inventory-"));
	home = {
		path: root,
		environment: "host",
		environmentLabel: "Test host",
	};
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	delete process.env.HLID_TEST_EXTENSIONS_HOME;
});

describe("discoverExtensionInventory", () => {
	it("parses native Codex marketplace roots with leading warnings", () => {
		expect(
			parseCodexMarketplaceList(`warning: stale cache
{
  "marketplaces": [
    {
      "name": "team-tools",
      "root": "/opt/team-tools",
      "marketplaceSource": {
        "sourceType": "git",
        "source": "example/team-tools"
      }
    },
    { "name": "invalid", "root": "relative/path" }
  ]
}`),
		).toEqual([
			{
				name: "team-tools",
				root: "/opt/team-tools",
				source: "git · example/team-tools",
			},
		]);
	});

	it("derives one provider home per configured WSL distro user", () => {
		process.env.HLID_TEST_EXTENSIONS_HOME = root;
		const homes = providerExtensionHomes({
			...config(),
			agents: [
				{
					name: "WSL",
					path: "\\\\wsl.localhost\\Ubuntu\\home\\kyle\\project",
					mode: "cwd",
					provider: "codex",
				},
				{
					name: "Same home",
					path: "\\\\wsl.localhost\\Ubuntu\\home\\kyle\\other",
					mode: "cwd",
					provider: "claude",
				},
			],
		});
		delete process.env.HLID_TEST_EXTENSIONS_HOME;

		expect(homes).toEqual([
			expect.objectContaining({ path: root, environmentLabel: "Host" }),
			{
				path: "\\\\wsl.localhost\\Ubuntu\\home\\kyle",
				environment: "wsl",
				environmentLabel: "WSL · Ubuntu",
			},
		]);
	});

	it("browses configured third-party Codex marketplace snapshots", async () => {
		const marketplaceRoot = join(root, "team-marketplace");
		const pluginRoot = join(marketplaceRoot, "plugins", "team-review");
		writeJson(join(marketplaceRoot, ".agents", "plugins", "marketplace.json"), {
			name: "team-tools",
			interface: { displayName: "Team tools" },
			plugins: [
				{
					name: "team-review",
					description: "Reviews team changes",
					source: { source: "local", path: "./plugins/team-review" },
				},
			],
		});
		writeJson(join(pluginRoot, ".codex-plugin", "plugin.json"), {
			name: "team-review",
			version: "2.0.0",
			description: "Reviews team changes",
		});
		mkdirSync(join(root, ".codex"), { recursive: true });
		writeFileSync(
			join(root, ".codex", "config.toml"),
			`[marketplaces.team-tools]
last_updated = "2026-07-23T00:00:00Z"
source_type = "git"
source = "example/team-tools"
`,
		);
		const listCodexMarketplaces = vi.fn().mockResolvedValue([
			{
				name: "team-tools",
				root: marketplaceRoot,
				source: "git · example/team-tools",
			},
		]);

		const inventory = await discoverExtensionInventory(config(), [home], {
			listCodexMarketplaces,
		});
		expect(listCodexMarketplaces).toHaveBeenCalledWith(config(), home);
		expect(inventory.marketplaces).toEqual([
			expect.objectContaining({
				providerId: "codex",
				name: "team-tools",
				source: "git · example/team-tools",
				path: marketplaceRoot,
				pluginCount: 1,
				lastUpdated: "2026-07-23T00:00:00Z",
			}),
		]);
		const available = inventory.available[0];
		expect(available).toEqual(
			expect.objectContaining({
				pluginId: "team-review@team-tools",
				reviewLevel: "package",
			}),
		);
		const review = await reviewAvailableExtension(
			config(),
			available?.id ?? "",
			[home],
			{ listCodexMarketplaces },
		);
		expect(review).toEqual(
			expect.objectContaining({
				pluginId: "team-review@team-tools",
				manifestText: expect.stringContaining('"version": "2.0.0"'),
			}),
		);
	});

	it("keeps Claude and Codex registries separate while reviewing components", async () => {
		const claudeRoot = join(
			root,
			".claude",
			"plugins",
			"cache",
			"official",
			"reviewer",
			"1.2.3",
		);
		writeJson(join(root, ".claude", "plugins", "installed_plugins.json"), {
			version: 2,
			plugins: {
				"reviewer@official": [
					{
						scope: "user",
						version: "1.2.3",
						installPath: claudeRoot,
						installedAt: "2026-07-20T00:00:00.000Z",
						lastUpdated: "2026-07-21T00:00:00.000Z",
					},
				],
			},
		});
		writeJson(join(root, ".claude", "settings.json"), {
			enabledPlugins: { "reviewer@official": true },
		});
		writeJson(join(claudeRoot, ".claude-plugin", "plugin.json"), {
			name: "reviewer",
			version: "1.2.3",
			description: "Reviews changes",
			author: { name: "Example" },
			hooks: "./hooks/hooks.json",
		});
		mkdirSync(join(claudeRoot, "skills", "review"), { recursive: true });
		writeFileSync(join(claudeRoot, "skills", "review", "SKILL.md"), "# Review");
		writeJson(join(claudeRoot, ".mcp.json"), {
			mcpServers: { reviewApi: { command: "review" } },
		});
		writeJson(join(claudeRoot, "hooks", "hooks.json"), {
			hooks: { PreToolUse: [] },
		});
		const claudeMarketplace = join(
			root,
			".claude",
			"plugins",
			"marketplaces",
			"official",
		);
		writeJson(join(root, ".claude", "plugins", "known_marketplaces.json"), {
			official: {
				source: { source: "github", repo: "example/plugins" },
				installLocation: claudeMarketplace,
				lastUpdated: "2026-07-21T00:00:00.000Z",
			},
		});
		writeJson(join(claudeMarketplace, ".claude-plugin", "marketplace.json"), {
			name: "official",
			plugins: [
				{
					name: "reviewer",
					description: "Reviews changes",
					category: "Development",
				},
				{
					name: "remote-helper",
					description: "Remote metadata only",
					source: {
						source: "url",
						url: "https://example.invalid/remote-helper.git",
					},
				},
			],
		});

		const codexRoot = join(
			root,
			".codex",
			"plugins",
			"cache",
			"curated",
			"github",
			"abc123",
		);
		mkdirSync(join(root, ".codex"), { recursive: true });
		writeFileSync(
			join(root, ".codex", "config.toml"),
			'[plugins."github@curated"]\nenabled = false\n',
		);
		writeJson(join(codexRoot, ".codex-plugin", "plugin.json"), {
			name: "github",
			version: "0.4.0",
			description: "GitHub workflows",
			interface: {
				displayName: "GitHub",
				capabilities: ["Interactive", "Write"],
			},
			skills: "./skills",
			apps: "./.app.json",
		});
		writeJson(join(codexRoot, ".app.json"), { apps: { github: {} } });
		mkdirSync(join(codexRoot, "scripts"), { recursive: true });
		writeFileSync(join(codexRoot, "scripts", "run.js"), "");
		writeJson(
			join(
				root,
				".codex",
				".tmp",
				"plugins",
				".agents",
				"plugins",
				"marketplace.json",
			),
			{
				name: "curated",
				interface: { displayName: "Codex official" },
				plugins: [{ name: "github" }],
			},
		);

		const inventory = await discoverExtensionInventory(config(), [home]);
		expect(inventory.errors).toEqual([]);
		expect(inventory.extensions).toHaveLength(2);
		expect(inventory.extensions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					providerId: "claude",
					pluginId: "reviewer@official",
					enabled: true,
					environmentLabel: "Test host",
					components: expect.arrayContaining([
						expect.objectContaining({ kind: "skills", count: 1 }),
						expect.objectContaining({ kind: "hooks", count: 1 }),
						expect.objectContaining({ kind: "mcp", count: 1 }),
					]),
					skillFiles: expect.arrayContaining([
						expect.objectContaining({
							path: "skills/review/SKILL.md",
							content: "# Review",
							truncated: false,
						}),
					]),
				}),
				expect.objectContaining({
					providerId: "codex",
					pluginId: "github@curated",
					enabled: false,
					version: "0.4.0",
					capabilities: ["Interactive", "Write"],
					components: expect.arrayContaining([
						expect.objectContaining({ kind: "apps", count: 1 }),
						expect.objectContaining({ kind: "scripts", count: 1 }),
					]),
				}),
			]),
		);
		expect(
			inventory.extensions.find((item) => item.providerId === "codex")
				?.manifestText,
		).toContain('"displayName": "GitHub"');
		expect(inventory.marketplaces).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					providerId: "claude",
					name: "official",
					source: "github · example/plugins",
					pluginCount: 2,
				}),
				expect.objectContaining({
					providerId: "codex",
					name: "curated",
					pluginCount: 1,
				}),
			]),
		);
		expect(inventory.available).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					providerId: "claude",
					pluginId: "reviewer@official",
					installed: true,
					enabled: true,
					reviewLevel: "package",
				}),
				expect.objectContaining({
					providerId: "claude",
					pluginId: "remote-helper@official",
					installed: false,
					enabled: null,
					reviewLevel: "marketplace",
				}),
				expect.objectContaining({
					providerId: "codex",
					pluginId: "github@curated",
					installed: true,
					reviewLevel: "package",
				}),
			]),
		);

		const reviewer = inventory.available.find(
			(item) => item.pluginId === "reviewer@official",
		);
		const reviewerReview = await reviewAvailableExtension(
			config(),
			reviewer?.id ?? "",
			[home],
		);
		expect(reviewerReview).toMatchObject({
			reviewLevel: "package",
			manifestPath: expect.stringContaining(".claude-plugin/plugin.json"),
			components: expect.arrayContaining([
				expect.objectContaining({ kind: "skills", count: 1 }),
			]),
			skillFiles: expect.arrayContaining([
				expect.objectContaining({
					path: "skills/review/SKILL.md",
					content: "# Review",
					truncated: false,
				}),
			]),
		});

		const remote = inventory.available.find(
			(item) => item.pluginId === "remote-helper@official",
		);
		const remoteReview = await reviewAvailableExtension(
			config(),
			remote?.id ?? "",
			[home],
		);
		expect(remoteReview).toMatchObject({
			reviewLevel: "marketplace",
			reviewMessage: expect.stringContaining("not present locally"),
			manifestPath: expect.stringContaining("plugins[remote-helper]"),
			components: [],
		});
		expect(remoteReview?.manifestText).toContain("Remote metadata only");
	});

	it("returns bounded provider errors without losing the other inventory", async () => {
		mkdirSync(join(root, ".claude", "plugins"), { recursive: true });
		writeFileSync(
			join(root, ".claude", "plugins", "installed_plugins.json"),
			"{bad json",
		);
		mkdirSync(join(root, ".codex"), { recursive: true });
		writeFileSync(
			join(root, ".codex", "config.toml"),
			'[plugins."missing@curated"]\nenabled = true\n',
		);

		const inventory = await discoverExtensionInventory(config(), [home]);
		expect(inventory.errors[0]).toMatchObject({
			providerId: "claude",
			environmentLabel: "Test host",
		});
		expect(inventory.extensions).toEqual([
			expect.objectContaining({
				providerId: "codex",
				pluginId: "missing@curated",
				errors: ["Plugin manifest is missing"],
			}),
		]);
	});

	it("does not follow a plugin-cache symlink outside the provider boundary", async () => {
		const outside = join(root, "outside");
		const linked = join(
			root,
			".claude",
			"plugins",
			"cache",
			"official",
			"unsafe",
			"1.0.0",
		);
		writeJson(join(outside, ".claude-plugin", "plugin.json"), {
			name: "unsafe",
			description: "Should not be exposed",
		});
		mkdirSync(join(linked, ".."), { recursive: true });
		symlinkSync(outside, linked, "dir");
		writeJson(join(root, ".claude", "plugins", "installed_plugins.json"), {
			plugins: {
				"unsafe@official": [
					{ scope: "user", version: "1.0.0", installPath: linked },
				],
			},
		});

		const inventory = await discoverExtensionInventory(config(), [home]);
		const extension = inventory.extensions[0];
		expect(extension?.errors).toContain(
			"Manifest resolves outside the provider plugin cache",
		);
		expect(extension?.manifestText).toBe("");
		expect(extension?.components).toEqual([]);
		expect(extension?.skillFiles).toEqual([]);
	});

	it("does not expose a skill file symlink outside an installed package", async () => {
		const pluginRoot = join(
			root,
			".claude",
			"plugins",
			"cache",
			"official",
			"safe-plugin",
			"1.0.0",
		);
		const outsideSkill = join(root, "outside-skill.md");
		writeFileSync(outsideSkill, "# Private outside file");
		writeJson(join(pluginRoot, ".claude-plugin", "plugin.json"), {
			name: "safe-plugin",
		});
		mkdirSync(join(pluginRoot, "skills", "linked"), { recursive: true });
		symlinkSync(
			outsideSkill,
			join(pluginRoot, "skills", "linked", "SKILL.md"),
			"file",
		);
		writeJson(join(root, ".claude", "plugins", "installed_plugins.json"), {
			plugins: {
				"safe-plugin@official": [
					{
						scope: "user",
						version: "1.0.0",
						installPath: pluginRoot,
					},
				],
			},
		});

		const inventory = await discoverExtensionInventory(config(), [home]);
		expect(
			inventory.extensions[0]?.skillFiles.some(
				(file) => file.path === "skills/outside/SKILL.md",
			),
		).toBe(false);
		expect(inventory.extensions[0]?.components).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ kind: "skills" })]),
		);
	});

	it("does not review a marketplace package symlink outside its snapshot", async () => {
		const marketplace = join(
			root,
			".claude",
			"plugins",
			"marketplaces",
			"official",
		);
		const outside = join(root, "outside-marketplace");
		writeJson(join(outside, ".claude-plugin", "plugin.json"), {
			name: "unsafe",
			description: "Should not be reviewed",
		});
		mkdirSync(join(marketplace, "plugins"), { recursive: true });
		symlinkSync(outside, join(marketplace, "plugins", "unsafe"), "dir");
		writeJson(join(root, ".claude", "plugins", "known_marketplaces.json"), {
			official: {
				installLocation: marketplace,
			},
		});
		writeJson(join(marketplace, ".claude-plugin", "marketplace.json"), {
			name: "official",
			plugins: [{ name: "unsafe", source: "./plugins/unsafe" }],
		});

		const inventory = await discoverExtensionInventory(config(), [home]);
		const available = inventory.available[0];
		expect(available?.reviewLevel).toBe("marketplace");
		const review = await reviewAvailableExtension(
			config(),
			available?.id ?? "",
			[home],
		);
		expect(review?.reviewLevel).toBe("marketplace");
		expect(review?.errors).toContain(
			"Manifest resolves outside the provider plugin cache",
		);
		expect(review?.manifestText).not.toContain("Should not be reviewed");
	});
});
