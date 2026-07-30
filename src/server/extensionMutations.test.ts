import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HlidConfig } from "../config";
import type {
	AvailableExtension,
	ExtensionInventory,
	ExtensionReview,
	ProviderExtension,
	ProviderExtensionHome,
	ProviderMarketplace,
} from "./extensionInventory";
import { extensionEnvironmentId } from "./extensionInventory";
import {
	mutateProviderExtension,
	setCodexPluginEnabled,
} from "./extensionMutations";

const home: ProviderExtensionHome = {
	path: "/home/test",
	environment: "host",
	environmentLabel: "Host",
};
const available: AvailableExtension = {
	id: "a".repeat(24),
	providerId: "claude",
	providerLabel: "Claude",
	environment: "host",
	environmentLabel: "Host",
	pluginId: "reviewer@official",
	name: "reviewer",
	displayName: "Reviewer",
	marketplace: "official",
	version: "1.2.3",
	description: "Reviews changes",
	author: "Example",
	category: "Development",
	source: "./plugins/reviewer",
	homepage: "",
	installed: false,
	enabled: null,
	reviewLevel: "package",
};
const installed: ProviderExtension = {
	id: "b".repeat(24),
	providerId: "claude",
	providerLabel: "Claude",
	environment: "host",
	environmentLabel: "Host",
	pluginId: "reviewer@official",
	name: "reviewer",
	displayName: "Reviewer",
	marketplace: "official",
	version: "1.2.3",
	description: "Reviews changes",
	author: "Example",
	homepage: "",
	repository: "",
	license: "",
	scope: "user",
	enabled: true,
	installPath: "/home/test/.claude/plugins/reviewer",
	source: "official",
	installedAt: "",
	lastUpdated: "",
	capabilities: [],
	components: [],
	skillFiles: [],
	manifestPath: "/plugin.json",
	manifestText: "{}",
	errors: [],
	nativeUpdate: { available: true },
};
const review: ExtensionReview = {
	...available,
	reviewMessage: "Complete package review",
	reviewToken: "f".repeat(64),
	manifestPath: "/plugin.json",
	manifestText: "{}",
	capabilities: [],
	components: [],
	skillFiles: [],
	errors: [],
};
const config = {
	vault: { name: "Test", path: "/vault" },
	agents: [],
	codex: {},
} as unknown as HlidConfig;

function inventory(input: {
	available?: AvailableExtension[];
	extensions?: ProviderExtension[];
	marketplaces?: ProviderMarketplace[];
	errors?: ExtensionInventory["errors"];
}): ExtensionInventory {
	return {
		generatedAt: "2026-07-23T00:00:00.000Z",
		environments: [],
		available: input.available ?? [],
		extensions: input.extensions ?? [],
		marketplaces: input.marketplaces ?? [],
		errors: input.errors ?? [],
	};
}

function marketplace(
	overrides: Partial<ProviderMarketplace> = {},
): ProviderMarketplace {
	return {
		id: "9".repeat(24),
		providerId: "claude",
		environment: "host",
		environmentLabel: "Host",
		name: "team-tools",
		source: "github · example/team-tools",
		path: "/home/test/.claude/plugins/marketplaces/team-tools",
		pluginCount: 2,
		lastUpdated: "2026-07-23T00:00:00.000Z",
		canManage: true,
		...overrides,
	};
}

describe("mutateProviderExtension", () => {
	const run = vi.fn();
	const discover = vi.fn();
	const inspectReview = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		run.mockResolvedValue({ output: "ok", code: 0 });
		inspectReview.mockResolvedValue(review);
	});

	it("installs a reviewed Claude package through the native CLI", async () => {
		discover
			.mockResolvedValueOnce(inventory({ available: [available] }))
			.mockResolvedValueOnce(inventory({ available: [available] }))
			.mockResolvedValueOnce(inventory({ extensions: [installed] }));

		await expect(
			mutateProviderExtension(
				config,
				{
					action: "install",
					id: available.id,
					reviewToken: review.reviewToken,
				},
				{
					homes: () => [home],
					discover,
					review: inspectReview,
					run,
					resolveClaude: () => "/usr/bin/claude",
				},
			),
		).resolves.toMatchObject({
			action: "install",
			pluginId: "reviewer@official",
			output: "ok",
		});
		expect(run).toHaveBeenCalledWith(
			"/usr/bin/claude",
			["plugin", "install", "reviewer@official", "--scope", "user"],
			expect.objectContaining({
				cwd: "/home/test",
				shell: false,
				timeoutError: "Plugin installation timed out",
			}),
		);
	});

	it("matches refreshed installs only in the target provider, environment, and scope", async () => {
		const wrongProvider = {
			...installed,
			id: "c".repeat(24),
			providerId: "codex" as const,
			providerLabel: "Codex",
			version: "9.0.0",
		};
		const wrongEnvironment = {
			...installed,
			id: "d".repeat(24),
			environmentLabel: "Other host",
			version: "9.0.0",
		};
		const wrongScope = {
			...installed,
			id: "e".repeat(24),
			scope: "project",
			version: "9.0.0",
		};
		const otherIdentities = [wrongProvider, wrongEnvironment, wrongScope];
		discover
			.mockResolvedValueOnce(inventory({ available: [available] }))
			.mockResolvedValueOnce(inventory({ extensions: otherIdentities }))
			.mockResolvedValueOnce(
				inventory({ extensions: [...otherIdentities, installed] }),
			);

		await expect(
			mutateProviderExtension(
				config,
				{
					action: "install",
					id: available.id,
					reviewToken: review.reviewToken,
				},
				{
					homes: () => [home],
					discover,
					review: inspectReview,
					run,
					resolveClaude: () => "/usr/bin/claude",
				},
			),
		).resolves.toMatchObject({ action: "install" });
		expect(run).toHaveBeenCalledOnce();
	});

	it("verifies an install against the token-reviewed version", async () => {
		const refreshed = { ...installed, version: "1.2.4" };
		inspectReview.mockResolvedValueOnce({ ...review, version: "1.2.4" });
		discover
			.mockResolvedValueOnce(inventory({ available: [available] }))
			.mockResolvedValueOnce(inventory({ available: [available] }))
			.mockResolvedValueOnce(inventory({ extensions: [refreshed] }));

		await expect(
			mutateProviderExtension(
				config,
				{
					action: "install",
					id: available.id,
					reviewToken: review.reviewToken,
				},
				{
					homes: () => [home],
					discover,
					review: inspectReview,
					run,
					resolveClaude: () => "/usr/bin/claude",
				},
			),
		).resolves.toMatchObject({ action: "install" });
		expect(run).toHaveBeenCalledOnce();
	});

	it("rolls back a brand-new install when post-install verification fails", async () => {
		const mismatched = { ...installed, version: "9.0.0" };
		discover
			.mockResolvedValueOnce(inventory({ available: [available] }))
			.mockResolvedValueOnce(inventory({ available: [available] }))
			.mockResolvedValueOnce(inventory({ extensions: [mismatched] }))
			.mockResolvedValueOnce(inventory({}));

		await expect(
			mutateProviderExtension(
				config,
				{
					action: "install",
					id: available.id,
					reviewToken: review.reviewToken,
				},
				{
					homes: () => [home],
					discover,
					review: inspectReview,
					run,
					resolveClaude: () => "/usr/bin/claude",
				},
			),
		).rejects.toMatchObject({
			message: expect.stringContaining("plugin is no longer installed"),
			stateChanged: false,
			refreshRequired: true,
		});
		expect(run).toHaveBeenNthCalledWith(
			1,
			"/usr/bin/claude",
			["plugin", "install", "reviewer@official", "--scope", "user"],
			expect.any(Object),
		);
		expect(run).toHaveBeenNthCalledWith(
			2,
			"/usr/bin/claude",
			[
				"plugin",
				"uninstall",
				"reviewer@official",
				"--scope",
				"user",
				"--yes",
				"--keep-data",
			],
			expect.objectContaining({ timeoutError: "Plugin rollback timed out" }),
		);
	});

	it("preserves reconcile-and-warn when a fresh-install rollback is inconclusive", async () => {
		const mismatched = { ...installed, version: "9.0.0" };
		discover
			.mockResolvedValueOnce(inventory({ available: [available] }))
			.mockResolvedValueOnce(inventory({ available: [available] }))
			.mockResolvedValueOnce(inventory({ extensions: [mismatched] }))
			.mockResolvedValueOnce(inventory({ extensions: [mismatched] }));
		run
			.mockResolvedValueOnce({ output: "installed", code: 0 })
			.mockResolvedValueOnce({ output: "cache remained busy", code: 1 });

		await expect(
			mutateProviderExtension(
				config,
				{
					action: "install",
					id: available.id,
					reviewToken: review.reviewToken,
				},
				{
					homes: () => [home],
					discover,
					review: inspectReview,
					run,
					resolveClaude: () => "/usr/bin/claude",
				},
			),
		).rejects.toMatchObject({
			message: expect.stringContaining("plugin remains installed"),
			stateChanged: true,
		});
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("rolls back a fresh install when post-mutation inventory is incomplete after a nonzero exit", async () => {
		const partialInventoryError = {
			providerId: "claude" as const,
			environment: "host" as const,
			environmentLabel: "Host",
			message: "Installed plugin registry is temporarily unreadable",
		};
		discover
			.mockResolvedValueOnce(inventory({ available: [available] }))
			.mockResolvedValueOnce(inventory({ available: [available] }))
			.mockResolvedValueOnce(
				inventory({
					extensions: [installed],
					errors: [partialInventoryError],
				}),
			)
			.mockResolvedValueOnce(inventory({}));
		run
			.mockResolvedValueOnce({ output: "metadata cleanup failed", code: 1 })
			.mockResolvedValueOnce({ output: "removed", code: 0 });

		await expect(
			mutateProviderExtension(
				config,
				{
					action: "install",
					id: available.id,
					reviewToken: review.reviewToken,
				},
				{
					homes: () => [home],
					discover,
					review: inspectReview,
					run,
					resolveClaude: () => "/usr/bin/claude",
				},
			),
		).rejects.toMatchObject({
			message: expect.stringContaining(
				"refreshed provider inventory was incomplete",
			),
			stateChanged: false,
			refreshRequired: true,
		});
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("does not infer uninstall success from incomplete target inventory", async () => {
		discover
			.mockResolvedValueOnce(inventory({ extensions: [installed] }))
			.mockResolvedValueOnce(
				inventory({
					errors: [
						{
							providerId: "claude",
							environment: "host",
							environmentLabel: "Host",
							message: "Installed plugin registry is temporarily unreadable",
						},
					],
				}),
			);

		await expect(
			mutateProviderExtension(
				config,
				{
					action: "uninstall",
					id: installed.id,
					expectedVersion: installed.version,
				},
				{
					homes: () => [home],
					discover,
					run,
					resolveClaude: () => "/usr/bin/claude",
				},
			),
		).rejects.toMatchObject({
			message: expect.stringContaining(
				"refreshed provider inventory was incomplete",
			),
			stateChanged: true,
			refreshRequired: true,
		});
	});

	it("rolls back a brand-new install with a corrupt provider cache", async () => {
		const corrupt = {
			...installed,
			errors: ["Manifest JSON is invalid: Unexpected token"],
			cacheRecovery: {
				issue: "corrupt" as const,
				action: "native_update" as const,
			},
		};
		discover
			.mockResolvedValueOnce(inventory({ available: [available] }))
			.mockResolvedValueOnce(inventory({ available: [available] }))
			.mockResolvedValueOnce(inventory({ extensions: [corrupt] }))
			.mockResolvedValueOnce(inventory({}));

		await expect(
			mutateProviderExtension(
				config,
				{
					action: "install",
					id: available.id,
					reviewToken: review.reviewToken,
				},
				{
					homes: () => [home],
					discover,
					review: inspectReview,
					run,
					resolveClaude: () => "/usr/bin/claude",
				},
			),
		).rejects.toMatchObject({
			message: expect.stringContaining("package cache could not be verified"),
			stateChanged: false,
			refreshRequired: true,
		});
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("rolls back every fresh install whose review health is damaged", async () => {
		const damaged = {
			...installed,
			reviewHealth: "damaged" as const,
			errors: ["The installed manifest could not be parsed"],
		};
		discover
			.mockResolvedValueOnce(inventory({ available: [available] }))
			.mockResolvedValueOnce(inventory({ available: [available] }))
			.mockResolvedValueOnce(inventory({ extensions: [damaged] }))
			.mockResolvedValueOnce(inventory({}));

		await expect(
			mutateProviderExtension(
				config,
				{
					action: "install",
					id: available.id,
					reviewToken: review.reviewToken,
				},
				{
					homes: () => [home],
					discover,
					review: inspectReview,
					run,
					resolveClaude: () => "/usr/bin/claude",
				},
			),
		).rejects.toMatchObject({
			message: expect.stringContaining("package cache could not be verified"),
			stateChanged: false,
			refreshRequired: true,
		});
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("keeps metadata-only fresh installs as an intentional review state", async () => {
		const metadataOnly = {
			...installed,
			reviewHealth: "metadata_only" as const,
		};
		discover
			.mockResolvedValueOnce(inventory({ available: [available] }))
			.mockResolvedValueOnce(inventory({ available: [available] }))
			.mockResolvedValueOnce(inventory({ extensions: [metadataOnly] }));

		await expect(
			mutateProviderExtension(
				config,
				{
					action: "install",
					id: available.id,
					reviewToken: review.reviewToken,
				},
				{
					homes: () => [home],
					discover,
					review: inspectReview,
					run,
					resolveClaude: () => "/usr/bin/claude",
				},
			),
		).resolves.toMatchObject({ action: "install" });
		expect(run).toHaveBeenCalledOnce();
	});

	it("does not accept a bad partial install after a nonzero provider exit", async () => {
		const mismatched = { ...installed, version: "9.0.0" };
		discover
			.mockResolvedValueOnce(inventory({ available: [available] }))
			.mockResolvedValueOnce(inventory({ available: [available] }))
			.mockResolvedValueOnce(inventory({ extensions: [mismatched] }))
			.mockResolvedValueOnce(inventory({}));
		run
			.mockResolvedValueOnce({ output: "metadata cleanup failed", code: 1 })
			.mockResolvedValueOnce({ output: "removed", code: 0 });

		await expect(
			mutateProviderExtension(
				config,
				{
					action: "install",
					id: available.id,
					reviewToken: review.reviewToken,
				},
				{
					homes: () => [home],
					discover,
					review: inspectReview,
					run,
					resolveClaude: () => "/usr/bin/claude",
				},
			),
		).rejects.toMatchObject({
			message: expect.stringContaining(
				"installed version 9.0.0, but the reviewed marketplace version was 1.2.3",
			),
			stateChanged: false,
			refreshRequired: true,
		});
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("does not claim rollback success from an incomplete provider inventory", async () => {
		const mismatched = { ...installed, version: "9.0.0" };
		discover
			.mockResolvedValueOnce(inventory({ available: [available] }))
			.mockResolvedValueOnce(inventory({ available: [available] }))
			.mockResolvedValueOnce(inventory({ extensions: [mismatched] }))
			.mockResolvedValueOnce(
				inventory({
					errors: [
						{
							providerId: "claude",
							environment: "host",
							environmentLabel: "Host",
							message: "Installed plugin registry is invalid: malformed JSON",
						},
					],
				}),
			);

		await expect(
			mutateProviderExtension(
				config,
				{
					action: "install",
					id: available.id,
					reviewToken: review.reviewToken,
				},
				{
					homes: () => [home],
					discover,
					review: inspectReview,
					run,
					resolveClaude: () => "/usr/bin/claude",
				},
			),
		).rejects.toMatchObject({
			message: expect.stringContaining(
				"refreshed provider inventory was incomplete",
			),
			stateChanged: true,
			refreshRequired: true,
		});
	});

	it("does not roll back when the locked pre-install inventory was incomplete", async () => {
		const mismatched = { ...installed, version: "9.0.0" };
		const partialInventoryError = {
			providerId: "claude" as const,
			environment: "host" as const,
			environmentLabel: "Host",
			message: "Installed plugin registry is invalid: malformed JSON",
		};
		discover
			.mockResolvedValueOnce(inventory({ available: [available] }))
			.mockResolvedValueOnce(
				inventory({
					available: [available],
					errors: [partialInventoryError],
				}),
			)
			.mockResolvedValueOnce(inventory({ extensions: [mismatched] }));

		await expect(
			mutateProviderExtension(
				config,
				{
					action: "install",
					id: available.id,
					reviewToken: review.reviewToken,
				},
				{
					homes: () => [home],
					discover,
					review: inspectReview,
					run,
					resolveClaude: () => "/usr/bin/claude",
				},
			),
		).rejects.toMatchObject({
			message: expect.stringContaining("did not attempt automatic rollback"),
			stateChanged: true,
			refreshRequired: true,
		});
		expect(run).toHaveBeenCalledOnce();
	});

	it("keeps normal explicit Claude uninstall semantics separate from rollback", async () => {
		discover
			.mockResolvedValueOnce(inventory({ extensions: [installed] }))
			.mockResolvedValueOnce(inventory({}));

		await mutateProviderExtension(
			config,
			{
				action: "uninstall",
				id: installed.id,
				expectedVersion: installed.version,
			},
			{
				homes: () => [home],
				discover,
				run,
				resolveClaude: () => "/usr/bin/claude",
			},
		);

		expect(run).toHaveBeenCalledWith(
			"/usr/bin/claude",
			["plugin", "uninstall", "reviewer@official", "--scope", "user", "--yes"],
			expect.objectContaining({ timeoutError: "Plugin removal timed out" }),
		);
	});

	it("removes an exact Codex extension through plugin remove", async () => {
		const codexInstalled: ProviderExtension = {
			...installed,
			id: "c".repeat(24),
			providerId: "codex",
			providerLabel: "Codex",
			pluginId: "github@curated",
			name: "github",
			marketplace: "curated",
		};
		discover
			.mockResolvedValueOnce(inventory({ extensions: [codexInstalled] }))
			.mockResolvedValueOnce(inventory({}));

		await mutateProviderExtension(
			config,
			{
				action: "uninstall",
				id: codexInstalled.id,
				expectedVersion: "1.2.3",
			},
			{
				homes: () => [home],
				discover,
				run,
				resolveCodex: () => "/usr/bin/codex",
			},
		);
		expect(run).toHaveBeenCalledWith(
			"/usr/bin/codex",
			["plugin", "remove", "github@curated", "--json"],
			expect.objectContaining({
				timeoutError: "Plugin removal timed out",
			}),
		);
	});

	it("updates an installed Claude extension through the native CLI", async () => {
		discover
			.mockResolvedValueOnce(inventory({ extensions: [installed] }))
			.mockResolvedValueOnce(
				inventory({
					extensions: [{ ...installed, version: "1.2.4" }],
				}),
			);

		await expect(
			mutateProviderExtension(
				config,
				{
					action: "update",
					id: installed.id,
					expectedVersion: installed.version,
				},
				{
					homes: () => [home],
					discover,
					run,
					resolveClaude: () => "/usr/bin/claude",
				},
			),
		).resolves.toMatchObject({
			action: "update",
			pluginId: "reviewer@official",
		});
		expect(run).toHaveBeenCalledWith(
			"/usr/bin/claude",
			["plugin", "update", "reviewer@official", "--scope", "user"],
			expect.objectContaining({
				timeoutError: "Plugin update timed out",
			}),
		);
	});

	it("enables and disables Claude plugins through the exact installed scope", async () => {
		discover
			.mockResolvedValueOnce(inventory({ extensions: [installed] }))
			.mockResolvedValueOnce(
				inventory({
					extensions: [{ ...installed, enabled: false }],
				}),
			);
		await mutateProviderExtension(
			config,
			{
				action: "set_enabled",
				id: installed.id,
				expectedVersion: installed.version,
				expectedEnabled: true,
				enabled: false,
			},
			{
				homes: () => [home],
				discover,
				run,
				resolveClaude: () => "/usr/bin/claude",
			},
		);
		expect(run).toHaveBeenCalledWith(
			"/usr/bin/claude",
			["plugin", "disable", "reviewer@official", "--scope", "user"],
			expect.objectContaining({
				timeoutError: "Plugin disable timed out",
			}),
		);
	});

	it("updates Codex plugin status through its guarded persistent config", async () => {
		const codexInstalled: ProviderExtension = {
			...installed,
			id: "6".repeat(24),
			providerId: "codex",
			providerLabel: "Codex",
			pluginId: "github@curated",
			name: "github",
			marketplace: "curated",
			enabled: false,
		};
		discover
			.mockResolvedValueOnce(inventory({ extensions: [codexInstalled] }))
			.mockResolvedValueOnce(
				inventory({
					extensions: [{ ...codexInstalled, enabled: true }],
				}),
			);
		const updateConfig = vi.fn();
		await mutateProviderExtension(
			config,
			{
				action: "set_enabled",
				id: codexInstalled.id,
				expectedVersion: codexInstalled.version,
				expectedEnabled: false,
				enabled: true,
			},
			{
				homes: () => [home],
				discover,
				setCodexPluginEnabled: updateConfig,
			},
		);
		expect(updateConfig).toHaveBeenCalledWith(
			"/home/test/.codex/config.toml",
			"github@curated",
			false,
			true,
		);
		expect(run).not.toHaveBeenCalled();
	});

	it("atomically preserves unrelated Codex config while changing one plugin", () => {
		const root = mkdtempSync(join(tmpdir(), "hlid-codex-plugin-toggle-"));
		const path = join(root, "config.toml");
		try {
			writeFileSync(
				path,
				`model = "gpt-5"

[plugins."github@curated"]
enabled = false # keep this comment

[plugins."other@curated"]
enabled = true
`,
			);
			setCodexPluginEnabled(path, "github@curated", false, true);
			const updated = readFileSync(path, "utf8");
			expect(updated).toContain("enabled = true # keep this comment");
			expect(updated).toContain('[plugins."other@curated"]\nenabled = true');
			expect(updated).toContain('model = "gpt-5"');
			expect(() =>
				setCodexPluginEnabled(path, "github@curated", false, true),
			).toThrow("status changed");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses the matching WSL provider wrapper", async () => {
		const wslHome: ProviderExtensionHome = {
			path: "\\\\wsl.localhost\\Ubuntu\\home\\test",
			environment: "wsl",
			environmentLabel: "WSL · Ubuntu",
		};
		const wslAvailable = {
			...available,
			id: "d".repeat(24),
			environment: "wsl" as const,
			environmentLabel: "WSL · Ubuntu",
		};
		const wslInstalled = {
			...installed,
			id: "e".repeat(24),
			environment: "wsl" as const,
			environmentLabel: "WSL · Ubuntu",
		};
		discover
			.mockResolvedValueOnce(inventory({ available: [wslAvailable] }))
			.mockResolvedValueOnce(inventory({ available: [wslAvailable] }))
			.mockResolvedValueOnce(inventory({ extensions: [wslInstalled] }));

		await mutateProviderExtension(
			config,
			{
				action: "install",
				id: wslAvailable.id,
				reviewToken: review.reviewToken,
			},
			{
				homes: () => [wslHome],
				discover,
				review: vi.fn().mockResolvedValue({
					...review,
					id: wslAvailable.id,
				}),
				run,
				writeProviderWrapper: () => "C:\\Hlid\\wrappers\\claude.cmd",
			},
		);
		expect(run).toHaveBeenCalledWith(
			"C:\\Hlid\\wrappers\\claude.cmd",
			expect.arrayContaining(["reviewer@official"]),
			expect.objectContaining({ shell: true, cwd: undefined }),
		);
	});

	it("allows a token-bound metadata-only install through the native provider", async () => {
		discover
			.mockResolvedValueOnce(inventory({ available: [available] }))
			.mockResolvedValueOnce(inventory({ available: [available] }))
			.mockResolvedValueOnce(inventory({ extensions: [installed] }));
		inspectReview.mockResolvedValue({ ...review, reviewLevel: "marketplace" });
		await mutateProviderExtension(
			config,
			{
				action: "install",
				id: available.id,
				reviewToken: review.reviewToken,
			},
			{
				homes: () => [home],
				discover,
				review: inspectReview,
				run,
				resolveClaude: () => "/usr/bin/claude",
			},
		);
		expect(run).toHaveBeenCalledWith(
			"/usr/bin/claude",
			expect.arrayContaining(["plugin", "install", "reviewer@official"]),
			expect.any(Object),
		);
	});

	it("requires the exact package review token selected by the user", async () => {
		discover
			.mockResolvedValueOnce(inventory({ available: [available] }))
			.mockResolvedValueOnce(inventory({ available: [available] }));
		await expect(
			mutateProviderExtension(
				config,
				{
					action: "install",
					id: available.id,
					reviewToken: "0".repeat(64),
				},
				{
					homes: () => [home],
					discover,
					review: inspectReview,
					run,
				},
			),
		).rejects.toThrow("changed after review");
		expect(run).not.toHaveBeenCalled();
	});

	it("requires the installed version selected by the user", async () => {
		discover.mockResolvedValueOnce(inventory({ extensions: [installed] }));
		await expect(
			mutateProviderExtension(
				config,
				{
					action: "uninstall",
					id: installed.id,
					expectedVersion: "0.9.0",
				},
				{ homes: () => [home], discover, run },
			),
		).rejects.toThrow(
			"requested installed version was 0.9.0, but the provider now reports 1.2.3",
		);
		expect(run).not.toHaveBeenCalled();
	});

	it("returns bounded native CLI failures without claiming success", async () => {
		discover.mockResolvedValueOnce(inventory({ extensions: [installed] }));
		run.mockResolvedValue({
			output: "first line\npermission denied",
			code: 1,
		});
		await expect(
			mutateProviderExtension(
				config,
				{
					action: "uninstall",
					id: installed.id,
					expectedVersion: installed.version,
				},
				{
					homes: () => [home],
					discover,
					run,
					resolveClaude: () => "/usr/bin/claude",
				},
			),
		).rejects.toThrow("permission denied");
	});

	it("accepts a nonzero removal when refreshed state confirms completion", async () => {
		discover
			.mockResolvedValueOnce(inventory({ extensions: [installed] }))
			.mockResolvedValueOnce(inventory({}));
		run.mockResolvedValue({
			output: "provider metadata cleanup failed",
			code: 1,
		});

		await expect(
			mutateProviderExtension(
				config,
				{
					action: "uninstall",
					id: installed.id,
					expectedVersion: installed.version,
				},
				{
					homes: () => [home],
					discover,
					run,
					resolveClaude: () => "/usr/bin/claude",
				},
			),
		).resolves.toMatchObject({
			action: "uninstall",
			warning: expect.stringContaining("refreshed state confirms"),
		});
	});

	it("reports unexpected partial provider state instead of suggesting a blind retry", async () => {
		discover
			.mockResolvedValueOnce(inventory({ extensions: [installed] }))
			.mockResolvedValueOnce(
				inventory({
					extensions: [{ ...installed, version: "1.2.4" }],
				}),
			);
		run.mockResolvedValue({ output: "removal failed", code: 1 });

		await expect(
			mutateProviderExtension(
				config,
				{
					action: "uninstall",
					id: installed.id,
					expectedVersion: installed.version,
				},
				{
					homes: () => [home],
					discover,
					run,
					resolveClaude: () => "/usr/bin/claude",
				},
			),
		).rejects.toMatchObject({
			message: expect.stringContaining("state changed unexpectedly"),
			stateChanged: true,
		});
	});

	it("adds a Claude marketplace to one exact provider environment", async () => {
		const added = marketplace();
		discover
			.mockResolvedValueOnce(inventory({}))
			.mockResolvedValueOnce(inventory({ marketplaces: [added] }));

		await expect(
			mutateProviderExtension(
				config,
				{
					action: "add_marketplace",
					providerId: "claude",
					environmentId: extensionEnvironmentId("claude", home),
					source: "example/team-tools",
					sparse: [".claude-plugin", "plugins"],
				},
				{
					homes: () => [home],
					discover,
					run,
					resolveClaude: () => "/usr/bin/claude",
				},
			),
		).resolves.toMatchObject({
			action: "add_marketplace",
			subject: "team-tools",
			environmentLabel: "Host",
		});
		expect(run).toHaveBeenCalledWith(
			"/usr/bin/claude",
			[
				"plugin",
				"marketplace",
				"add",
				"example/team-tools",
				"--scope",
				"user",
				"--sparse",
				".claude-plugin",
				"plugins",
			],
			expect.objectContaining({
				cwd: "/home/test",
				timeoutError: "Marketplace addition timed out",
			}),
		);
	});

	it("passes Codex Git ref and sparse paths through its native marketplace command", async () => {
		const added = marketplace({
			id: "8".repeat(24),
			providerId: "codex",
		});
		discover
			.mockResolvedValueOnce(inventory({}))
			.mockResolvedValueOnce(inventory({ marketplaces: [added] }));

		await mutateProviderExtension(
			config,
			{
				action: "add_marketplace",
				providerId: "codex",
				environmentId: extensionEnvironmentId("codex", home),
				source: "https://github.com/example/team-tools",
				ref: "release/v2",
				sparse: ["plugins/reviewer", "plugins/linter"],
			},
			{
				homes: () => [home],
				discover,
				run,
				resolveCodex: () => "/usr/bin/codex",
			},
		);
		expect(run).toHaveBeenCalledWith(
			"/usr/bin/codex",
			[
				"plugin",
				"marketplace",
				"add",
				"https://github.com/example/team-tools",
				"--ref",
				"release/v2",
				"--sparse",
				"plugins/reviewer",
				"--sparse",
				"plugins/linter",
				"--json",
			],
			expect.any(Object),
		);
	});

	it("refreshes and removes a guarded marketplace source", async () => {
		const current = marketplace();
		discover
			.mockResolvedValueOnce(inventory({ marketplaces: [current] }))
			.mockResolvedValueOnce(inventory({ marketplaces: [current] }))
			.mockResolvedValueOnce(inventory({ marketplaces: [current] }));
		await mutateProviderExtension(
			config,
			{
				action: "upgrade_marketplace",
				id: current.id,
				expectedSource: current.source,
			},
			{
				homes: () => [home],
				discover,
				run,
				resolveClaude: () => "/usr/bin/claude",
			},
		);
		expect(run).toHaveBeenLastCalledWith(
			"/usr/bin/claude",
			["plugin", "marketplace", "update", "team-tools"],
			expect.objectContaining({
				timeoutError: "Marketplace update timed out",
			}),
		);

		discover.mockReset();
		discover
			.mockResolvedValueOnce(inventory({ marketplaces: [current] }))
			.mockResolvedValueOnce(inventory({ marketplaces: [current] }))
			.mockResolvedValueOnce(
				inventory({
					marketplaces: [
						{
							...current,
							source: "",
							canManage: false,
						},
					],
				}),
			);
		await mutateProviderExtension(
			config,
			{
				action: "remove_marketplace",
				id: current.id,
				expectedSource: current.source,
			},
			{
				homes: () => [home],
				discover,
				run,
				resolveClaude: () => "/usr/bin/claude",
			},
		);
		expect(run).toHaveBeenLastCalledWith(
			"/usr/bin/claude",
			["plugin", "marketplace", "remove", "team-tools"],
			expect.objectContaining({
				timeoutError: "Marketplace removal timed out",
			}),
		);
	});

	it("treats a nonzero marketplace removal as complete when the source is gone", async () => {
		const current = marketplace();
		discover
			.mockResolvedValueOnce(inventory({ marketplaces: [current] }))
			.mockResolvedValueOnce(inventory({ marketplaces: [current] }))
			.mockResolvedValueOnce(inventory({}));
		run.mockResolvedValue({
			output: "marketplace is not declared in user settings",
			code: 1,
		});

		await expect(
			mutateProviderExtension(
				config,
				{
					action: "remove_marketplace",
					id: current.id,
					expectedSource: current.source,
				},
				{
					homes: () => [home],
					discover,
					run,
					resolveClaude: () => "/usr/bin/claude",
				},
			),
		).resolves.toMatchObject({
			action: "remove_marketplace",
			warning: expect.stringContaining("refreshed state confirms"),
		});
	});

	it("recognizes provider-native marketplace repair from restored health", async () => {
		const unhealthy = marketplace({
			health: "invalid",
			diagnostic: "The local snapshot is invalid.",
		});
		const healthy = marketplace();
		discover
			.mockResolvedValueOnce(inventory({ marketplaces: [unhealthy] }))
			.mockResolvedValueOnce(inventory({ marketplaces: [unhealthy] }))
			.mockResolvedValueOnce(inventory({ marketplaces: [healthy] }));
		run.mockResolvedValue({
			output: "metadata cleanup failed after refreshing the snapshot",
			code: 1,
		});

		await expect(
			mutateProviderExtension(
				config,
				{
					action: "upgrade_marketplace",
					id: unhealthy.id,
					expectedSource: unhealthy.source,
				},
				{
					homes: () => [home],
					discover,
					run,
					resolveClaude: () => "/usr/bin/claude",
				},
			),
		).resolves.toMatchObject({
			action: "upgrade_marketplace",
			warning: expect.stringContaining("refreshed state confirms"),
		});
	});

	it.each([
		["invalid", "Repair source"],
		["missing", "Refresh source"],
		["unavailable", "Retry inspection"],
	] as const)("rejects a marketplace refresh that leaves a source %s", async (health, recoveryAction) => {
		const current = marketplace();
		const degraded = {
			...current,
			health,
			diagnostic: `The refreshed marketplace snapshot is ${health}.`,
		};
		discover
			.mockResolvedValueOnce(inventory({ marketplaces: [current] }))
			.mockResolvedValueOnce(inventory({ marketplaces: [current] }))
			.mockResolvedValueOnce(inventory({ marketplaces: [degraded] }));

		await expect(
			mutateProviderExtension(
				config,
				{
					action: "upgrade_marketplace",
					id: current.id,
					expectedSource: current.source,
				},
				{
					homes: () => [home],
					discover,
					run,
					resolveClaude: () => "/usr/bin/claude",
				},
			),
		).rejects.toMatchObject({
			message: expect.stringContaining(`Choose ${recoveryAction}`),
			stateChanged: true,
			refreshRequired: true,
		});
	});

	it("retries one transient marketplace update network failure", async () => {
		const current = marketplace({
			providerId: "codex",
			source:
				"git · https://github.com/hashgraph-online/awesome-codex-plugins.git",
		});
		discover
			.mockResolvedValueOnce(inventory({ marketplaces: [current] }))
			.mockResolvedValueOnce(inventory({ marketplaces: [current] }))
			.mockResolvedValueOnce(inventory({ marketplaces: [current] }));
		run
			.mockResolvedValueOnce({
				output:
					"git ls-remote marketplace source failed: Recv failure: Connection was reset",
				code: 1,
			})
			.mockResolvedValueOnce({ output: "updated", code: 0 });
		const wait = vi.fn().mockResolvedValue(undefined);

		await expect(
			mutateProviderExtension(
				config,
				{
					action: "upgrade_marketplace",
					id: current.id,
					expectedSource: current.source,
				},
				{
					homes: () => [home],
					discover,
					run,
					wait,
					resolveCodex: () => "/usr/bin/codex",
				},
			),
		).resolves.toMatchObject({
			action: "upgrade_marketplace",
			subject: "team-tools",
			output: "updated",
		});
		expect(wait).toHaveBeenCalledWith(750);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it.each([
		"Marketplace update timed out",
		"connect ETIMEDOUT 140.82.112.3:443",
	])("retries the transient marketplace failure %s", async (output) => {
		const current = marketplace({ providerId: "codex" });
		discover
			.mockResolvedValueOnce(inventory({ marketplaces: [current] }))
			.mockResolvedValueOnce(inventory({ marketplaces: [current] }))
			.mockResolvedValueOnce(inventory({ marketplaces: [current] }));
		run
			.mockResolvedValueOnce({ output, code: 1 })
			.mockResolvedValueOnce({ output: "updated", code: 0 });
		const wait = vi.fn().mockResolvedValue(undefined);

		await expect(
			mutateProviderExtension(
				config,
				{
					action: "upgrade_marketplace",
					id: current.id,
					expectedSource: current.source,
				},
				{
					homes: () => [home],
					discover,
					run,
					wait,
					resolveCodex: () => "/usr/bin/codex",
				},
			),
		).resolves.toMatchObject({ action: "upgrade_marketplace" });
		expect(wait).toHaveBeenCalledWith(750);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("guides a retry when a marketplace remains offline", async () => {
		const current = marketplace({ providerId: "codex" });
		discover
			.mockResolvedValueOnce(inventory({ marketplaces: [current] }))
			.mockResolvedValueOnce(inventory({ marketplaces: [current] }))
			.mockResolvedValueOnce(inventory({ marketplaces: [current] }));
		run
			.mockResolvedValueOnce({
				output: "Recv failure: Connection was reset",
				code: 1,
			})
			.mockResolvedValueOnce({
				output: "Could not resolve host: github.com",
				code: 1,
			});
		const wait = vi.fn().mockResolvedValue(undefined);

		await expect(
			mutateProviderExtension(
				config,
				{
					action: "upgrade_marketplace",
					id: current.id,
					expectedSource: current.source,
				},
				{
					homes: () => [home],
					discover,
					run,
					wait,
					resolveCodex: () => "/usr/bin/codex",
				},
			),
		).rejects.toThrow(
			"Choose Refresh source or Repair source when connectivity returns",
		);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("does not retry permanent marketplace update failures", async () => {
		const current = marketplace({ providerId: "codex" });
		discover
			.mockResolvedValueOnce(inventory({ marketplaces: [current] }))
			.mockResolvedValueOnce(inventory({ marketplaces: [current] }));
		run.mockResolvedValueOnce({
			output: "fatal: repository not found",
			code: 1,
		});
		const wait = vi.fn().mockResolvedValue(undefined);

		await expect(
			mutateProviderExtension(
				config,
				{
					action: "upgrade_marketplace",
					id: current.id,
					expectedSource: current.source,
				},
				{
					homes: () => [home],
					discover,
					run,
					wait,
					resolveCodex: () => "/usr/bin/codex",
				},
			),
		).rejects.toThrow("repository not found");
		expect(wait).not.toHaveBeenCalled();
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("explains when a configured marketplace source disappeared", async () => {
		discover.mockResolvedValueOnce(inventory({}));

		await expect(
			mutateProviderExtension(
				config,
				{
					action: "upgrade_marketplace",
					id: "5".repeat(24),
					expectedSource: "github · example/team-tools",
				},
				{ homes: () => [home], discover, run },
			),
		).rejects.toThrow("configured marketplace source is no longer present");
		expect(run).not.toHaveBeenCalled();
	});

	it("refuses stale or built-in marketplace mutations", async () => {
		const current = marketplace();
		discover.mockResolvedValueOnce(inventory({ marketplaces: [current] }));
		await expect(
			mutateProviderExtension(
				config,
				{
					action: "remove_marketplace",
					id: current.id,
					expectedSource: "old source",
				},
				{ homes: () => [home], discover, run },
			),
		).rejects.toThrow("source changed");

		const builtIn = marketplace({ id: "7".repeat(24), canManage: false });
		discover.mockReset();
		discover.mockResolvedValueOnce(inventory({ marketplaces: [builtIn] }));
		await expect(
			mutateProviderExtension(
				config,
				{
					action: "upgrade_marketplace",
					id: builtIn.id,
					expectedSource: builtIn.source,
				},
				{ homes: () => [home], discover, run },
			),
		).rejects.toThrow("built-in marketplace");
		expect(run).not.toHaveBeenCalled();
	});
});
