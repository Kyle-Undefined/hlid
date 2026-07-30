import {
	chmodSync,
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
	extensionEnvironmentId,
	type ProviderExtensionHome,
	parseCodexMarketplaceList,
	providerExtensionHomes,
	reviewAvailableExtension,
} from "./extensionInventory";

let root: string;
let home: ProviderExtensionHome;
const AGENT_PLUGIN_SCHEMA =
	"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

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
					path: "\\\\wsl$\\ubuntu\\home\\kyle\\other",
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

	it("uses one opaque provider environment identity for WSL share aliases", () => {
		const localhostHome: ProviderExtensionHome = {
			path: "\\\\wsl.localhost\\Ubuntu\\home\\kyle",
			environment: "wsl",
			environmentLabel: "WSL · Ubuntu",
		};
		const dollarHome: ProviderExtensionHome = {
			...localhostHome,
			path: "\\\\wsl$\\ubuntu\\home\\kyle\\",
		};

		expect(extensionEnvironmentId("claude", localhostHome)).toBe(
			extensionEnvironmentId("claude", dollarHome),
		);
		expect(extensionEnvironmentId("codex", localhostHome)).not.toBe(
			extensionEnvironmentId("claude", localhostHome),
		);
	});

	it("canonicalizes explicitly supplied homes once at the inventory boundary", async () => {
		const declaredHome: ProviderExtensionHome = {
			path: "\\\\wsl.localhost\\Ubuntu\\home\\kyle",
			environment: "wsl",
			environmentLabel: "WSL · Ubuntu",
		};
		const aliasHome: ProviderExtensionHome = {
			...declaredHome,
			path: "\\\\wsl$\\ubuntu\\home\\kyle\\",
		};
		const listCodexMarketplaces = vi.fn().mockResolvedValue([]);

		const inventory = await discoverExtensionInventory(
			config(),
			[declaredHome, aliasHome],
			{ listCodexMarketplaces },
		);

		expect(listCodexMarketplaces).toHaveBeenCalledOnce();
		expect(inventory.environments).toHaveLength(2);
		expect(inventory.environments.map((item) => item.id)).toEqual([
			extensionEnvironmentId("claude", declaredHome),
			extensionEnvironmentId("codex", declaredHome),
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

	it("preserves configured Codex marketplaces when snapshots are missing or invalid", async () => {
		const missingRoot = join(root, "missing-marketplace");
		const invalidRoot = join(root, "invalid-marketplace");
		const invalidShapeRoot = join(root, "invalid-shape-marketplace");
		const readOnlyRoot = join(root, "read-only-marketplace");
		const invalidSnapshot = join(
			invalidRoot,
			".agents",
			"plugins",
			"marketplace.json",
		);
		mkdirSync(join(invalidRoot, ".agents", "plugins"), { recursive: true });
		writeFileSync(invalidSnapshot, "{not json");
		writeJson(
			join(invalidShapeRoot, ".agents", "plugins", "marketplace.json"),
			[],
		);

		const inventory = await discoverExtensionInventory(config(), [home], {
			listCodexMarketplaces: vi.fn().mockResolvedValue([
				{
					name: "missing-tools",
					root: missingRoot,
					source: "git · example/missing-tools",
				},
				{
					name: "invalid-tools",
					root: invalidRoot,
					source: "git · example/invalid-tools",
				},
				{
					name: "invalid-shape-tools",
					root: invalidShapeRoot,
					source: "git · example/invalid-shape-tools",
				},
				{
					name: "read-only-tools",
					root: readOnlyRoot,
					source: "",
				},
			]),
		});

		expect(inventory.marketplaces).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "missing-tools",
					source: "git · example/missing-tools",
					canManage: true,
					health: "missing",
					diagnostic: expect.stringContaining("local snapshot is missing"),
				}),
				expect.objectContaining({
					name: "invalid-tools",
					source: "git · example/invalid-tools",
					canManage: true,
					health: "invalid",
					diagnostic: expect.stringContaining("snapshot is invalid"),
				}),
				expect.objectContaining({
					name: "invalid-shape-tools",
					canManage: true,
					health: "invalid",
					diagnostic: expect.stringContaining("snapshot root is not an object"),
				}),
				expect.objectContaining({
					name: "read-only-tools",
					canManage: false,
					health: "missing",
					diagnostic: expect.stringContaining(
						"read-only built-in marketplace snapshot is missing",
					),
				}),
			]),
		);
		expect(inventory.errors).toHaveLength(2);
		expect(inventory.errors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					providerId: "codex",
					message: expect.stringContaining("snapshot is invalid"),
				}),
				expect.objectContaining({
					providerId: "codex",
					message: expect.stringContaining("snapshot root is not an object"),
				}),
			]),
		);
		expect(inventory.errors.every((error) => !error.recovery)).toBe(true);
	});

	it("marks unreadable configured Claude snapshots as inspection failures", async () => {
		const marketplaceRoot = join(root, "unreadable-claude-marketplace");
		const snapshotPath = join(
			marketplaceRoot,
			".claude-plugin",
			"marketplace.json",
		);
		writeJson(snapshotPath, { name: "official", plugins: [] });
		chmodSync(snapshotPath, 0);
		writeJson(join(root, ".claude", "plugins", "known_marketplaces.json"), {
			official: {
				source: { source: "github", repo: "example/extensions" },
				installLocation: marketplaceRoot,
			},
		});

		try {
			const inventory = await discoverExtensionInventory(config(), [home], {
				listCodexMarketplaces: vi.fn().mockResolvedValue([]),
			});

			expect(inventory.marketplaces).toContainEqual(
				expect.objectContaining({
					providerId: "claude",
					name: "official",
					canManage: true,
					health: "unavailable",
					diagnostic: expect.stringContaining("Retry inspection"),
				}),
			);
			expect(inventory.errors).toContainEqual(
				expect.objectContaining({
					providerId: "claude",
					message: expect.stringContaining("could not inspect"),
					recovery: "retry_inventory",
				}),
			);
		} finally {
			chmodSync(snapshotPath, 0o600);
		}
	});

	it("marks unreadable configured Codex snapshots as inspection failures", async () => {
		const marketplaceRoot = join(root, "unreadable-codex-marketplace");
		const snapshotPath = join(
			marketplaceRoot,
			".agents",
			"plugins",
			"marketplace.json",
		);
		writeJson(snapshotPath, { name: "team-tools", plugins: [] });
		chmodSync(snapshotPath, 0);

		try {
			const inventory = await discoverExtensionInventory(config(), [home], {
				listCodexMarketplaces: vi.fn().mockResolvedValue([
					{
						name: "team-tools",
						root: marketplaceRoot,
						source: "git · example/team-tools",
					},
				]),
			});

			expect(inventory.marketplaces).toContainEqual(
				expect.objectContaining({
					providerId: "codex",
					name: "team-tools",
					canManage: true,
					health: "unavailable",
					diagnostic: expect.stringContaining("Retry inspection"),
				}),
			);
			expect(inventory.errors).toContainEqual(
				expect.objectContaining({
					providerId: "codex",
					message: expect.stringContaining("could not inspect"),
					recovery: "retry_inventory",
				}),
			);
		} finally {
			chmodSync(snapshotPath, 0o600);
		}
	});

	it("keeps unavailable opportunistic Codex probes silent", async () => {
		const snapshotPath = join(
			root,
			".codex",
			".tmp",
			"plugins",
			".agents",
			"plugins",
			"marketplace.json",
		);
		writeJson(snapshotPath, { name: "openai-curated", plugins: [] });
		chmodSync(snapshotPath, 0);

		try {
			const inventory = await discoverExtensionInventory(config(), [home], {
				listCodexMarketplaces: vi.fn().mockResolvedValue([]),
			});

			expect(
				inventory.marketplaces.some(
					(marketplace) => marketplace.name === "openai-curated",
				),
			).toBe(false);
			expect(inventory.errors).toEqual([]);
		} finally {
			chmodSync(snapshotPath, 0o600);
		}
	});

	it("diagnoses a configured Claude marketplace whose snapshot disappeared", async () => {
		const marketplaceRoot = join(root, "missing-claude-marketplace");
		writeJson(join(root, ".claude", "plugins", "known_marketplaces.json"), {
			official: {
				source: {
					source: "github",
					repo: "example/extensions",
				},
				installLocation: marketplaceRoot,
			},
		});

		const inventory = await discoverExtensionInventory(config(), [home], {
			listCodexMarketplaces: vi.fn().mockResolvedValue([]),
		});

		expect(inventory.marketplaces).toContainEqual(
			expect.objectContaining({
				providerId: "claude",
				name: "official",
				health: "missing",
				diagnostic: expect.stringContaining("local snapshot is missing"),
			}),
		);
	});

	it("reviews root-only Agent Plugins packages from Codex marketplaces", async () => {
		const marketplaceRoot = join(root, "portable-marketplace");
		const pluginRoot = join(marketplaceRoot, "plugins", "portable-review");
		writeJson(join(marketplaceRoot, ".agents", "plugins", "marketplace.json"), {
			name: "portable-tools",
			plugins: [
				{
					name: "portable-review",
					source: { source: "local", path: "./plugins/portable-review" },
				},
			],
		});
		writeJson(join(pluginRoot, "plugin.json"), {
			$schema: AGENT_PLUGIN_SCHEMA,
			name: "portable-review",
			version: "1.2.0",
			description: "Portable review tools",
			author: { name: "Example" },
		});
		writeJson(join(pluginRoot, "mcp.json"), {
			mcpServers: { portableApi: { command: "portable-api" } },
		});
		mkdirSync(join(pluginRoot, "skills", "review"), { recursive: true });
		writeFileSync(
			join(pluginRoot, "skills", "review", "SKILL.md"),
			"# Portable review",
		);
		mkdirSync(join(pluginRoot, "skills", "group", "nested"), {
			recursive: true,
		});
		writeFileSync(
			join(pluginRoot, "skills", "group", "nested", "SKILL.md"),
			"# Nested skill Codex does not load",
		);
		const listCodexMarketplaces = vi.fn().mockResolvedValue([
			{
				name: "portable-tools",
				root: marketplaceRoot,
				source: "git · example/portable-tools",
			},
		]);

		const inventory = await discoverExtensionInventory(config(), [home], {
			listCodexMarketplaces,
		});
		const available = inventory.available.find(
			(item) => item.pluginId === "portable-review@portable-tools",
		);
		expect(available).toMatchObject({
			displayName: "portable-review",
			reviewLevel: "package",
		});

		const review = await reviewAvailableExtension(
			config(),
			available?.id ?? "",
			[home],
			{ listCodexMarketplaces },
		);
		expect(review).toMatchObject({
			reviewLevel: "package",
			manifestPath: join(pluginRoot, "plugin.json"),
			version: "1.2.0",
			description: "Portable review tools",
			author: "Example",
			components: expect.arrayContaining([
				expect.objectContaining({ kind: "skills", count: 1 }),
				expect.objectContaining({
					kind: "mcp",
					count: 1,
					names: ["portableApi"],
				}),
			]),
			skillFiles: expect.arrayContaining([
				expect.objectContaining({
					path: "skills/review/SKILL.md",
					content: "# Portable review",
				}),
			]),
			errors: [],
		});
		expect(review?.manifestText).toContain(AGENT_PLUGIN_SCHEMA);
	});

	it("surfaces Agent Plugins manifests that Codex rejects", async () => {
		const cacheRoot = join(root, ".codex", "plugins", "cache", "team-tools");
		const invalid = [
			{
				name: "invalid-name",
				manifest: {
					$schema: AGENT_PLUGIN_SCHEMA,
					name: "Invalid Name",
				},
				error: "Agent Plugins name must use",
			},
			{
				name: "invalid-metadata",
				manifest: {
					$schema: AGENT_PLUGIN_SCHEMA,
					name: "invalid-metadata",
					description: null,
				},
				error: "Agent Plugins description must be a string",
			},
			{
				name: "invalid-extension",
				manifest: {
					$schema: AGENT_PLUGIN_SCHEMA,
					name: "invalid-extension",
					extensions: { "com.openai": { apps: [] } },
				},
				error: "Codex plugin apps must be a string path",
			},
		];
		for (const item of invalid) {
			writeJson(join(cacheRoot, item.name, "v1", "plugin.json"), item.manifest);
		}
		mkdirSync(join(root, ".codex"), { recursive: true });
		writeFileSync(
			join(root, ".codex", "config.toml"),
			invalid
				.map((item) => `[plugins."${item.name}@team-tools"]\nenabled = true\n`)
				.join(""),
		);

		const inventory = await discoverExtensionInventory(config(), [home], {
			listCodexMarketplaces: vi.fn().mockResolvedValue([]),
		});
		for (const item of invalid) {
			const extension = inventory.extensions.find(
				(extension) => extension.name === item.name,
			);
			expect(extension?.errors).toEqual([expect.stringContaining(item.error)]);
			expect(extension?.cacheRecovery).toBeUndefined();
		}
	});

	it("keeps portable component inspection inside the plugin root", async () => {
		const outside = join(root, "outside-app.json");
		writeJson(outside, { apps: { outsideSecret: {} } });
		const cacheRoot = join(root, ".codex", "plugins", "cache", "team-tools");
		const cases = [
			{ name: "traversal", apps: "../../../../outside-app.json" },
			{ name: "absolute", apps: outside },
			{ name: "symlink", apps: "./linked-app.json" },
		];
		for (const item of cases) {
			const pluginRoot = join(cacheRoot, item.name, "v1");
			writeJson(join(pluginRoot, "plugin.json"), {
				$schema: AGENT_PLUGIN_SCHEMA,
				name: item.name,
				extensions: { "com.openai": { apps: item.apps } },
			});
			if (item.name === "symlink") {
				symlinkSync(outside, join(pluginRoot, "linked-app.json"));
			}
		}
		mkdirSync(join(root, ".codex"), { recursive: true });
		writeFileSync(
			join(root, ".codex", "config.toml"),
			cases
				.map((item) => `[plugins."${item.name}@team-tools"]\nenabled = true\n`)
				.join(""),
		);
		const dependencies = {
			listCodexMarketplaces: vi.fn().mockResolvedValue([]),
		};

		const inventory = await discoverExtensionInventory(
			config(),
			[home],
			dependencies,
		);
		for (const item of cases) {
			const extension = inventory.extensions.find(
				(candidate) => candidate.name === item.name,
			);
			const review = await reviewAvailableExtension(
				config(),
				extension?.id ?? "",
				[home],
				dependencies,
			);
			expect(review?.components).not.toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: "apps",
						names: expect.arrayContaining(["outsideSecret"]),
					}),
				]),
			);
		}
	});

	it("uses a legacy Codex manifest only as the portable fallback overlay", async () => {
		const pluginRoot = join(
			root,
			".codex",
			"plugins",
			"cache",
			"team-tools",
			"portable-installed",
			"cache-v1",
		);
		writeJson(join(pluginRoot, "plugin.json"), {
			$schema: AGENT_PLUGIN_SCHEMA,
			name: "portable-installed",
			version: "2.3.0",
			description: "Portable metadata wins",
			author: { name: "Portable Author" },
		});
		writeJson(join(pluginRoot, ".codex-plugin", "plugin.json"), {
			name: "legacy-name",
			version: "9.9.9",
			description: "Legacy metadata must not replace portable metadata",
			author: "Legacy Author",
			interface: {
				displayName: "Codex Portable",
				capabilities: ["Write"],
			},
			hooks: "./hooks/hooks.json",
		});
		writeJson(join(pluginRoot, "hooks", "hooks.json"), {
			hooks: { PreToolUse: [] },
		});
		mkdirSync(join(root, ".codex"), { recursive: true });
		writeFileSync(
			join(root, ".codex", "config.toml"),
			'[plugins."portable-installed@team-tools"]\nenabled = true\n',
		);
		const dependencies = {
			listCodexMarketplaces: vi.fn().mockResolvedValue([]),
		};

		const inventory = await discoverExtensionInventory(
			config(),
			[home],
			dependencies,
		);
		const extension = inventory.extensions.find(
			(item) => item.pluginId === "portable-installed@team-tools",
		);
		expect(extension).toMatchObject({
			displayName: "Codex Portable",
			version: "2.3.0",
			description: "Portable metadata wins",
			author: "Portable Author",
			capabilities: ["Write"],
			enabled: true,
			errors: [],
		});
		expect(extension?.manifestPath).toContain(join(pluginRoot, "plugin.json"));
		expect(extension?.manifestPath).toContain(
			join(pluginRoot, ".codex-plugin", "plugin.json"),
		);
		expect(extension?.manifestText).toContain("Fallback Codex overlay");

		const review = await reviewAvailableExtension(
			config(),
			extension?.id ?? "",
			[home],
			dependencies,
		);
		expect(review).toMatchObject({
			displayName: "Codex Portable",
			version: "2.3.0",
			components: expect.arrayContaining([
				expect.objectContaining({
					kind: "hooks",
					count: 1,
					names: ["PreToolUse"],
				}),
			]),
			errors: [],
		});
	});

	it("matches Codex precedence for inline, unrelated, and unsupported root manifests", async () => {
		const cacheRoot = join(root, ".codex", "plugins", "cache", "team-tools");
		const inlineRoot = join(cacheRoot, "inline", "v1");
		writeJson(join(inlineRoot, "plugin.json"), {
			$schema: AGENT_PLUGIN_SCHEMA,
			name: "inline",
			extensions: {
				"com.openai": {
					interface: { displayName: "Inline Codex settings" },
				},
			},
		});
		writeJson(join(inlineRoot, ".codex-plugin", "plugin.json"), {
			name: "inline",
			interface: { displayName: "Ignored fallback overlay" },
		});

		const unrelatedRoot = join(cacheRoot, "unrelated", "v1");
		writeJson(join(unrelatedRoot, "plugin.json"), {
			name: "unrelated-package-file",
		});
		writeJson(join(unrelatedRoot, ".codex-plugin", "plugin.json"), {
			name: "unrelated",
			version: "4.0.0",
			interface: { displayName: "Legacy Codex manifest" },
		});

		const unsupportedRoot = join(cacheRoot, "unsupported", "v1");
		writeJson(join(unsupportedRoot, "plugin.json"), {
			$schema: "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json",
			name: "unsupported",
		});
		writeJson(join(unsupportedRoot, ".codex-plugin", "plugin.json"), {
			name: "unsupported",
			interface: { displayName: "Must not mask unsupported schema" },
		});

		mkdirSync(join(root, ".codex"), { recursive: true });
		writeFileSync(
			join(root, ".codex", "config.toml"),
			`[plugins."inline@team-tools"]
enabled = true
[plugins."unrelated@team-tools"]
enabled = true
[plugins."unsupported@team-tools"]
enabled = true
`,
		);

		const inventory = await discoverExtensionInventory(config(), [home], {
			listCodexMarketplaces: vi.fn().mockResolvedValue([]),
		});
		const byName = new Map(
			inventory.extensions.map((extension) => [extension.name, extension]),
		);
		expect(byName.get("inline")).toMatchObject({
			displayName: "Inline Codex settings",
			errors: [],
		});
		expect(byName.get("inline")?.manifestText).not.toContain(
			"Ignored fallback overlay",
		);
		expect(byName.get("unrelated")).toMatchObject({
			displayName: "Legacy Codex manifest",
			version: "4.0.0",
			errors: [],
		});
		expect(byName.get("unrelated")?.manifestPath).toBe(
			join(unrelatedRoot, ".codex-plugin", "plugin.json"),
		);
		expect(byName.get("unsupported")).toMatchObject({
			displayName: "unsupported",
			errors: [
				"Unsupported Agent Plugins schema: https://agent-plugins.org/schemas/2.0.0/plugin.schema.json",
			],
		});
		expect(byName.get("unsupported")?.manifestText).not.toContain(
			"Must not mask unsupported schema",
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
					components: [],
					skillFiles: [],
				}),
				expect.objectContaining({
					providerId: "codex",
					pluginId: "github@curated",
					enabled: false,
					version: "0.4.0",
					capabilities: ["Interactive", "Write"],
					components: [],
				}),
			]),
		);
		expect(
			inventory.extensions.find((item) => item.providerId === "codex")
				?.manifestText,
		).toContain('"displayName": "GitHub"');
		const installedReviewer = inventory.extensions.find(
			(item) => item.pluginId === "reviewer@official",
		);
		const installedReview = await reviewAvailableExtension(
			config(),
			installedReviewer?.id ?? "",
			[home],
		);
		expect(installedReview).toMatchObject({
			installed: true,
			reviewLevel: "package",
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
		});
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

	it("offers only provider-native repair for a corrupt Claude cache", async () => {
		const pluginRoot = join(
			root,
			".claude",
			"plugins",
			"cache",
			"official",
			"broken",
			"1.0.0",
		);
		mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
		writeFileSync(
			join(pluginRoot, ".claude-plugin", "plugin.json"),
			"{not json",
		);
		writeJson(join(root, ".claude", "plugins", "installed_plugins.json"), {
			plugins: {
				"broken@official": [
					{ scope: "user", version: "1.0.0", installPath: pluginRoot },
				],
			},
		});

		const inventory = await discoverExtensionInventory(config(), [home], {
			listCodexMarketplaces: vi.fn().mockResolvedValue([]),
		});

		expect(inventory.extensions).toContainEqual(
			expect.objectContaining({
				providerId: "claude",
				pluginId: "broken@official",
				nativeUpdate: { available: true },
				reviewHealth: "damaged",
				cacheRecovery: {
					issue: "corrupt",
					action: "native_update",
				},
			}),
		);
		const extension = inventory.extensions.find(
			(item) => item.pluginId === "broken@official",
		);
		const review = await reviewAvailableExtension(
			config(),
			extension?.id ?? "",
			[home],
			{ listCodexMarketplaces: vi.fn().mockResolvedValue([]) },
		);
		expect(review).toMatchObject({
			reviewLevel: "unavailable",
			reviewMessage: expect.stringContaining("review is incomplete"),
		});
		expect(review?.reviewMessage).not.toContain("Complete package review");
	});

	it("uses Claude marketplace metadata without treating a missing cache as repairable", async () => {
		const marketplaceRoot = join(root, "claude-marketplace-metadata");
		writeJson(join(root, ".claude", "plugins", "known_marketplaces.json"), {
			official: {
				source: { source: "github", repo: "example/extensions" },
				installLocation: marketplaceRoot,
			},
		});
		writeJson(join(marketplaceRoot, ".claude-plugin", "marketplace.json"), {
			name: "official",
			plugins: [
				{
					name: "metadata-only",
					description: "Marketplace metadata",
				},
			],
		});
		const missingInstall = join(
			root,
			".claude",
			"plugins",
			"cache",
			"official",
			"metadata-only",
			"1.0.0",
		);
		writeJson(join(root, ".claude", "plugins", "installed_plugins.json"), {
			plugins: {
				"metadata-only@official": [
					{
						scope: "user",
						version: "1.0.0",
						installPath: missingInstall,
					},
				],
			},
		});

		const inventory = await discoverExtensionInventory(config(), [home], {
			listCodexMarketplaces: vi.fn().mockResolvedValue([]),
		});
		const extension = inventory.extensions.find(
			(item) => item.pluginId === "metadata-only@official",
		);

		expect(extension).toMatchObject({
			description: "Marketplace metadata",
			errors: [],
			reviewHealth: "metadata_only",
		});
		expect(extension?.cacheRecovery).toBeUndefined();
	});

	it("classifies invalid manifest bytes as corrupt provider cache", async () => {
		const pluginRoot = join(
			root,
			".claude",
			"plugins",
			"cache",
			"official",
			"invalid-bytes",
			"1.0.0",
		);
		mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
		writeFileSync(
			join(pluginRoot, ".claude-plugin", "plugin.json"),
			Buffer.from([0xff, 0xfe, 0xfd]),
		);
		writeJson(join(root, ".claude", "plugins", "installed_plugins.json"), {
			plugins: {
				"invalid-bytes@official": [
					{ scope: "user", version: "1.0.0", installPath: pluginRoot },
				],
			},
		});

		const inventory = await discoverExtensionInventory(config(), [home], {
			listCodexMarketplaces: vi.fn().mockResolvedValue([]),
		});

		expect(inventory.extensions[0]).toMatchObject({
			errors: ["Manifest is not valid UTF-8"],
			reviewHealth: "damaged",
			cacheRecovery: {
				issue: "corrupt",
				action: "native_update",
			},
		});
	});

	it("does not classify a manifest permission failure as corrupt cache", async () => {
		const pluginRoot = join(
			root,
			".claude",
			"plugins",
			"cache",
			"official",
			"unreadable",
			"1.0.0",
		);
		const manifestPath = join(pluginRoot, ".claude-plugin", "plugin.json");
		writeJson(manifestPath, { name: "unreadable" });
		chmodSync(manifestPath, 0);
		writeJson(join(root, ".claude", "plugins", "installed_plugins.json"), {
			plugins: {
				"unreadable@official": [
					{ scope: "user", version: "1.0.0", installPath: pluginRoot },
				],
			},
		});

		try {
			const inventory = await discoverExtensionInventory(config(), [home], {
				listCodexMarketplaces: vi.fn().mockResolvedValue([]),
			});
			const extension = inventory.extensions[0];
			expect(extension?.errors).toEqual([
				expect.stringContaining("Manifest could not be read"),
			]);
			expect(extension?.reviewHealth).toBe("damaged");
			expect(extension?.cacheRecovery).toBeUndefined();
		} finally {
			chmodSync(manifestPath, 0o600);
		}
	});

	it("offers Codex reinstall recovery only with a manageable reviewed source", async () => {
		const installedRoot = join(
			root,
			".codex",
			"plugins",
			"cache",
			"team-tools",
			"reviewer",
		);
		mkdirSync(join(installedRoot, ".codex-plugin"), { recursive: true });
		writeFileSync(
			join(installedRoot, ".codex-plugin", "plugin.json"),
			"{not json",
		);
		mkdirSync(join(root, ".codex"), { recursive: true });
		writeFileSync(
			join(root, ".codex", "config.toml"),
			'[plugins."reviewer@team-tools"]\nenabled = true\n',
		);

		const marketplaceRoot = join(root, "team-tools-marketplace");
		const replacementRoot = join(marketplaceRoot, "plugins", "reviewer");
		writeJson(join(marketplaceRoot, ".agents", "plugins", "marketplace.json"), {
			name: "team-tools",
			plugins: [
				{
					name: "reviewer",
					source: { source: "local", path: "./plugins/reviewer" },
				},
			],
		});
		writeJson(join(replacementRoot, ".codex-plugin", "plugin.json"), {
			name: "reviewer",
			version: "2.0.0",
		});
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

		expect(
			inventory.extensions.find(
				(extension) => extension.pluginId === "reviewer@team-tools",
			),
		).toMatchObject({
			reviewHealth: "damaged",
			cacheRecovery: {
				issue: "corrupt",
				action: "marketplace_refresh_reinstall",
			},
		});
		expect(
			inventory.available.find(
				(extension) => extension.pluginId === "reviewer@team-tools",
			),
		).toMatchObject({ reviewLevel: "package" });
	});

	it("marks offline marketplace inspection as safe to retry", async () => {
		const inventory = await discoverExtensionInventory(config(), [home], {
			listCodexMarketplaces: vi
				.fn()
				.mockRejectedValue(
					new Error("failed to connect: network is unreachable"),
				),
		});

		expect(inventory.errors).toContainEqual(
			expect.objectContaining({
				providerId: "codex",
				message: expect.stringContaining("failed to connect"),
				recovery: "retry_inventory",
			}),
		);
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
				nativeUpdate: {
					available: false,
					reason: "Codex does not expose a native per-plugin update command.",
				},
				cacheRecovery: {
					issue: "missing",
					action: "restore_source",
				},
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
		expect(extension?.cacheRecovery).toBeUndefined();
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
