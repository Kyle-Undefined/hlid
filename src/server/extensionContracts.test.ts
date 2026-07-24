import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HlidConfig } from "../config";
import {
	discoverExtensionInventory,
	type ProviderExtensionHome,
	parseCodexMarketplaceList,
} from "./extensionInventory";

const FIXTURE_ROOT = join(
	process.cwd(),
	"src",
	"server",
	"fixtures",
	"extensions",
);

let root: string;
let home: ProviderExtensionHome;

function config(): HlidConfig {
	return {
		vault: { path: "", name: "Contract test" },
		agents: [],
	} as unknown as HlidConfig;
}

function fixture(providerVersion: string, name: string): string {
	return readFileSync(join(FIXTURE_ROOT, providerVersion, name), "utf8");
}

function jsonReplacement(value: string): string {
	return JSON.stringify(value).slice(1, -1);
}

function writeFixture(
	path: string,
	providerVersion: string,
	name: string,
	replacements: Record<string, string> = {},
): void {
	let content = fixture(providerVersion, name);
	for (const [marker, value] of Object.entries(replacements)) {
		content = content.replaceAll(`{{${marker}}}`, jsonReplacement(value));
	}
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "hlid-extension-contracts-"));
	home = {
		path: root,
		environment: "host",
		environmentLabel: "Contract host",
	};
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("provider extension contract fixtures", () => {
	it("discovers Claude Code 2.1.218 and Codex CLI 0.145.0 formats", async () => {
		const claudeVersion = "claude-code-2.1.218";
		const claudePluginRoot = join(
			root,
			".claude",
			"plugins",
			"cache",
			"official",
			"reviewer",
			"1.2.3",
		);
		const claudeMarketplaceRoot = join(
			root,
			".claude",
			"plugins",
			"marketplaces",
			"official",
		);
		writeFixture(
			join(root, ".claude", "plugins", "installed_plugins.json"),
			claudeVersion,
			"installed_plugins.json",
			{ CLAUDE_INSTALL_PATH: claudePluginRoot },
		);
		writeFixture(
			join(root, ".claude", "plugins", "known_marketplaces.json"),
			claudeVersion,
			"known_marketplaces.json",
			{ CLAUDE_MARKETPLACE_ROOT: claudeMarketplaceRoot },
		);
		writeFixture(
			join(root, ".claude", "settings.json"),
			claudeVersion,
			"settings.json",
		);
		writeFixture(
			join(claudeMarketplaceRoot, ".claude-plugin", "marketplace.json"),
			claudeVersion,
			"marketplace.json",
		);
		writeFixture(
			join(claudePluginRoot, ".claude-plugin", "plugin.json"),
			claudeVersion,
			"plugin.json",
		);
		writeFixture(
			join(
				claudeMarketplaceRoot,
				"plugins",
				"reviewer",
				".claude-plugin",
				"plugin.json",
			),
			claudeVersion,
			"plugin.json",
		);

		const codexVersion = "codex-cli-0.145.0";
		const codexMarketplaceRoot = join(root, "codex-marketplace");
		const codexCacheRoot = join(
			root,
			".codex",
			"plugins",
			"cache",
			"openai-curated",
			"reviewer",
			"0.4.0",
		);
		writeFixture(
			join(root, ".codex", "config.toml"),
			codexVersion,
			"config.toml",
		);
		writeFixture(
			join(codexMarketplaceRoot, ".agents", "plugins", "marketplace.json"),
			codexVersion,
			"marketplace.json",
		);
		writeFixture(
			join(codexCacheRoot, ".codex-plugin", "plugin.json"),
			codexVersion,
			"plugin.json",
		);
		writeFixture(
			join(
				codexMarketplaceRoot,
				"plugins",
				"reviewer",
				".codex-plugin",
				"plugin.json",
			),
			codexVersion,
			"plugin.json",
		);

		const marketplaceOutput = fixture(
			codexVersion,
			"marketplace-list.stdout",
		).replaceAll(
			"{{CODEX_MARKETPLACE_ROOT}}",
			jsonReplacement(codexMarketplaceRoot),
		);
		const codexMarketplaces = parseCodexMarketplaceList(marketplaceOutput);
		expect(codexMarketplaces).toEqual([
			{
				name: "openai-curated",
				root: codexMarketplaceRoot,
				source: "",
			},
		]);

		const inventory = await discoverExtensionInventory(config(), [home], {
			listCodexMarketplaces: async () => codexMarketplaces,
		});

		expect(inventory.errors).toEqual([]);
		expect(inventory.extensions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					providerId: "claude",
					pluginId: "reviewer@official",
					displayName: "Reviewer",
					version: "1.2.3",
					scope: "user",
					enabled: true,
					source: "./plugins/reviewer",
					capabilities: ["Read", "Review"],
				}),
				expect.objectContaining({
					providerId: "codex",
					pluginId: "reviewer@openai-curated",
					displayName: "Codex Reviewer",
					version: "0.4.0",
					enabled: false,
					capabilities: ["Read", "Review"],
				}),
			]),
		);
		expect(inventory.marketplaces).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					providerId: "claude",
					name: "official",
					source: "github · example/extensions",
					pluginCount: 2,
					canManage: true,
				}),
				expect.objectContaining({
					providerId: "codex",
					name: "openai-curated",
					source: "OpenAI curated",
					pluginCount: 1,
					canManage: false,
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
					pluginId: "reviewer@openai-curated",
					installed: true,
					enabled: false,
				}),
			]),
		);
	});

	it("keeps malformed Claude registry failures bounded and provider-specific", async () => {
		writeFixture(
			join(root, ".claude", "plugins", "installed_plugins.json"),
			"claude-code-2.1.218",
			"installed_plugins.invalid.txt",
		);
		const inventory = await discoverExtensionInventory(config(), [home], {
			listCodexMarketplaces: async () => [],
		});

		expect(inventory.errors).toEqual([
			expect.objectContaining({
				providerId: "claude",
				environmentLabel: "Contract host",
				message: expect.stringContaining(
					"Installed plugin registry is invalid",
				),
			}),
		]);
		expect(inventory.extensions).toEqual([]);
	});
});
