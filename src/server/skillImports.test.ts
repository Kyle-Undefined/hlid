import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HlidConfig } from "../config";

vi.mock("./libraryStore", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./libraryStore")>();
	return {
		...actual,
		managedSkillsDirectory: () =>
			process.env.HLID_TEST_SKILLS_LIBRARY as string,
		prepareLibrary: async () => {
			mkdirSync(process.env.HLID_TEST_SKILLS_LIBRARY as string, {
				recursive: true,
			});
		},
	};
});

import type { AgentProvider } from "./agentProvider";
import {
	discoverSkillPackages,
	importDiscoveredSkillPackages,
	importSkillPackage,
	readDiscoveredSkillDocument,
	removeManagedSkill,
} from "./skillImports";

let root: string;
let agent: string;
let source: string;

function config(): HlidConfig {
	return {
		vault: { path: "", name: "Test" },
		agents: [{ path: agent, name: "Agent", mode: "cwd", provider: "codex" }],
	} as HlidConfig;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "hlid-skill-import-"));
	agent = join(root, "agent");
	source = join(agent, ".codex", "skills", "review");
	process.env.HLID_TEST_SKILLS_LIBRARY = join(root, "library", "skills");
	process.env.HLID_TEST_SKILLS_HOME = join(root, "home");
	mkdirSync(source, { recursive: true });
	writeFileSync(
		join(source, "SKILL.md"),
		"---\nname: review\ndescription: Review code\n---\nDo the review.\n",
	);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	delete process.env.HLID_TEST_SKILLS_LIBRARY;
	delete process.env.HLID_TEST_SKILLS_HOME;
});

describe("importSkillPackage", () => {
	it("copies an authorized provider package and records provenance", async () => {
		const imported = await importSkillPackage({
			sourcePath: join(source, "SKILL.md"),
			source: "codex",
			config: config(),
		});
		expect(imported.name).toBe("review");
		expect(readFileSync(join(imported.path, "SKILL.md"), "utf8")).toContain(
			"Do the review",
		);
		expect(
			JSON.parse(
				readFileSync(join(imported.path, ".hlid-source.json"), "utf8"),
			),
		).toMatchObject({ source: "codex", sourcePath: source });
	});

	it("discovers provider packages without starting the provider process", async () => {
		const provider = {
			providerId: "codex",
			label: "Codex",
			listSkills: vi.fn().mockResolvedValue([
				{
					name: "review",
					description: "SDK description",
					path: join(source, "SKILL.md"),
					scope: "workspace",
					enabled: true,
				},
			]),
		} as unknown as AgentProvider;
		const catalog = await discoverSkillPackages(
			config(),
			new Map([["codex", provider]]),
		);
		expect(catalog).toHaveLength(1);
		expect(catalog[0]).toMatchObject({
			name: "review",
			description: "Review code",
			providerId: "codex",
			environment: "host",
			environmentLabel: "Host",
			scope: "workspace",
			enabled: null,
			alreadyImported: false,
		});
		expect(catalog[0]).not.toHaveProperty("sourcePath");
		expect(provider.listSkills).not.toHaveBeenCalled();
	});

	it("returns filesystem skills when provider metadata discovery stalls", async () => {
		const provider = {
			providerId: "codex",
			label: "Codex",
			listSkills: vi.fn().mockImplementation(() => new Promise(() => {})),
		} as unknown as AgentProvider;
		const started = Date.now();
		const catalog = await discoverSkillPackages(
			config(),
			new Map([["codex", provider]]),
		);
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(catalog).toEqual([
			expect.objectContaining({
				name: "review",
				description: "Review code",
				providerId: "codex",
			}),
		]);
		expect(provider.listSkills).not.toHaveBeenCalled();
	});

	it("imports selected discovery IDs and reports them as managed", async () => {
		const catalog = await discoverSkillPackages(config());
		expect(catalog).toHaveLength(1);
		const result = await importDiscoveredSkillPackages({
			ids: [catalog[0].id],
			config: config(),
		});
		expect(result.failed).toEqual([]);
		expect(result.imported).toEqual([
			{ id: catalog[0].id, name: "review", source: "codex" },
		]);
		const managed = (await discoverSkillPackages(config()))[0];
		expect(managed.alreadyImported).toBe(true);
		expect(managed.managedId).toMatch(/^[0-9a-f]{24}$/);
	});

	it("removes only Hlid-managed packages by opaque ID", async () => {
		await importSkillPackage({
			sourcePath: source,
			source: "codex",
			config: config(),
		});
		const catalog = await discoverSkillPackages(config());
		const managedId = catalog[0].managedId as string;
		expect(await removeManagedSkill(managedId)).toEqual({
			id: managedId,
			name: "review",
		});
		expect((await discoverSkillPackages(config()))[0]).toMatchObject({
			alreadyImported: false,
			managedId: null,
		});
		expect(await removeManagedSkill(managedId)).toBeNull();
	});

	it("reads SKILL.md through an opaque discovery ID", async () => {
		const catalog = await discoverSkillPackages(config());
		const document = await readDiscoveredSkillDocument({
			id: catalog[0].id,
			config: config(),
		});
		expect(document).toEqual({
			id: catalog[0].id,
			name: "review",
			content:
				"---\nname: review\ndescription: Review code\n---\nDo the review.\n",
		});
		expect(
			await readDiscoveredSkillDocument({
				id: "f".repeat(24),
				config: config(),
			}),
		).toBeNull();
	});

	it("discovers Claude plugin skills from the installed plugin registry", async () => {
		const plugin = join(
			process.env.HLID_TEST_SKILLS_HOME as string,
			".claude",
			"plugins",
			"cache",
			"voice-plugin",
			"skills",
			"plugin-voice",
		);
		mkdirSync(plugin, { recursive: true });
		writeFileSync(
			join(plugin, "SKILL.md"),
			"---\nname: plugin-voice\ndescription: Filesystem description\n---\nVoice.\n",
		);
		writeFileSync(
			join(
				process.env.HLID_TEST_SKILLS_HOME as string,
				".claude",
				"plugins",
				"installed_plugins.json",
			),
			JSON.stringify({
				version: 2,
				plugins: {
					"voice-plugin@test": [
						{ installPath: join(plugin, "..", ".."), scope: "user" },
					],
				},
			}),
		);
		const provider = {
			providerId: "claude",
			label: "Claude",
			listSkills: vi.fn().mockResolvedValue([
				{
					name: "voice-plugin:plugin-voice",
					description: "SDK plugin description",
				},
			]),
		} as unknown as AgentProvider;
		const catalog = await discoverSkillPackages(
			config(),
			new Map([["claude", provider]]),
		);
		expect(catalog).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "plugin-voice",
					description: "Filesystem description",
					providerId: "claude",
					scope: "plugin",
					enabled: true,
				}),
			]),
		);
		expect(provider.listSkills).not.toHaveBeenCalled();
	});

	it("discovers only enabled Codex plugin skills", async () => {
		const home = process.env.HLID_TEST_SKILLS_HOME as string;
		const browser = join(
			home,
			".codex",
			"plugins",
			"cache",
			"openai-bundled",
			"browser",
			"1.0.0",
			"skills",
			"browse",
		);
		const sites = join(
			home,
			".codex",
			"plugins",
			"cache",
			"openai-bundled",
			"sites",
			"1.0.0",
			"skills",
			"host",
		);
		mkdirSync(browser, { recursive: true });
		mkdirSync(sites, { recursive: true });
		writeFileSync(
			join(browser, "SKILL.md"),
			"---\nname: browse\ndescription: Browse sites\n---\n",
		);
		writeFileSync(
			join(sites, "SKILL.md"),
			"---\nname: host\ndescription: Host sites\n---\n",
		);
		writeFileSync(
			join(home, ".codex", "config.toml"),
			'[plugins."browser@openai-bundled"]\nenabled = true\n\n[plugins."sites@openai-bundled"]\nenabled = false\n',
		);
		const catalog = await discoverSkillPackages(config());
		expect(catalog).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "browse",
					providerId: "codex",
					scope: "plugin",
					enabled: true,
				}),
			]),
		);
		expect(catalog).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "host", providerId: "codex" }),
			]),
		);
	});

	it("does not overwrite an existing managed package", async () => {
		await importSkillPackage({
			sourcePath: source,
			source: "codex",
			config: config(),
		});
		await expect(
			importSkillPackage({
				sourcePath: source,
				source: "codex",
				config: config(),
			}),
		).rejects.toMatchObject({ code: "EEXIST" });
	});

	it("rejects packages containing symbolic links", async () => {
		writeFileSync(join(root, "outside.txt"), "secret");
		symlinkSync(join(root, "outside.txt"), join(source, "linked.txt"));
		await expect(
			importSkillPackage({
				sourcePath: source,
				source: "codex",
				config: config(),
			}),
		).rejects.toThrow("symbolic links");
	});

	it("rejects paths outside configured provider and agent roots", async () => {
		const outside = join(root, "outside-skill");
		mkdirSync(outside);
		writeFileSync(join(outside, "SKILL.md"), "outside");
		await expect(
			importSkillPackage({
				sourcePath: outside,
				source: "agent",
				config: config(),
			}),
		).rejects.toThrow("configured provider or agent root");
	});

	it("requires the declared adapter to own the source path", async () => {
		await expect(
			importSkillPackage({
				sourcePath: source,
				source: "claude",
				config: config(),
			}),
		).rejects.toThrow("configured provider or agent root");
	});
});
