import { afterEach, describe, expect, it, vi } from "vitest";
import { type HlidConfig, HlidConfigSchema } from "../config";
import type { AcpCatalogItem } from "./acpRegistry";
import {
	acpRuntimeFingerprint,
	createConfiguredAcpProvider,
	effectiveAcpEnvironment,
	OpenCodeConfigOverlayError,
	preflightOpenCodeModelFilter,
	syncAcpRuntimeProviders,
} from "./acpRuntime";
import type { AgentProvider } from "./agentProvider";

function config(
	agents: NonNullable<HlidConfig["acp_agents"]> = [],
): HlidConfig {
	return HlidConfigSchema.parse({
		vault: { name: "Vault", path: "/workspace" },
		acp_agents: agents,
	});
}

function item(
	id: string,
	options: Partial<AcpCatalogItem> = {},
): AcpCatalogItem {
	return {
		id,
		name: id === "opencode" ? "OpenCode" : id,
		version: "1.0.0",
		description: "agent",
		distribution: {},
		providerId: `acp:${id}`,
		enabled: true,
		available: true,
		command: id,
		args: ["acp"],
		env: {},
		installGuidance: "install it",
		targets: [],
		...options,
	};
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("ACP runtime synchronization", () => {
	it("merges a hide filter into JSONC without discarding existing config", () => {
		const runtimeConfig = config([
			{
				id: "opencode",
				env: {
					TOKEN: "configured",
					OPENCODE_CONFIG_CONTENT: `{
						// Existing inline settings remain effective.
						"instructions": ["AGENTS.md"],
						"provider": {
							"opencode": {
								"options": { "timeout": 1000 },
								"whitelist": ["model-a", "model-b"],
								"blacklist": ["model-old"],
							},
						},
					}`,
				},
				model_filter: {
					mode: "hide",
					models: [
						"opencode/model-z",
						"opencode/model-a",
						"openrouter/google/gemini-2.5-pro",
					],
				},
			},
		]);

		const environment = effectiveAcpEnvironment(
			item("opencode", { env: { BASE: "registry" } }),
			runtimeConfig,
			{},
			"linux",
		);
		const content = JSON.parse(environment.OPENCODE_CONFIG_CONTENT);

		expect(environment).toMatchObject({
			BASE: "registry",
			TOKEN: "configured",
		});
		expect(content.instructions).toEqual(["AGENTS.md"]);
		expect(content.provider.opencode).toEqual({
			options: { timeout: 1000 },
			whitelist: ["model-a", "model-b"],
			blacklist: ["model-a", "model-old", "model-z"],
		});
		expect(content.provider.openrouter.blacklist).toEqual([
			"google/gemini-2.5-pro",
		]);
	});

	it("intersects an only filter with existing provider restrictions", () => {
		const runtimeConfig = config([
			{
				id: "opencode",
				env: {
					OPENCODE_CONFIG_CONTENT: JSON.stringify({
						enabled_providers: ["opencode", "anthropic", "other"],
						disabled_providers: ["anthropic"],
						provider: {
							opencode: {
								whitelist: ["gpt", "not-selected"],
								blacklist: ["blocked"],
							},
						},
					}),
				},
				model_filter: {
					mode: "only",
					models: ["opencode/gpt", "opencode/blocked", "anthropic/claude"],
				},
			},
		]);

		const environment = effectiveAcpEnvironment(
			item("opencode"),
			runtimeConfig,
			{},
			"linux",
		);
		const content = JSON.parse(environment.OPENCODE_CONFIG_CONTENT);

		expect(content.enabled_providers).toEqual(["anthropic", "opencode"]);
		expect(content.disabled_providers).toEqual(["anthropic"]);
		expect(content.provider.opencode).toEqual({
			whitelist: ["gpt"],
			blacklist: ["blocked"],
		});
		expect(content.provider.anthropic.whitelist).toEqual(["claude"]);
	});

	it("rejects an only filter when inline restrictions exclude every selection", () => {
		const runtimeConfig = config([
			{
				id: "opencode",
				env: {
					OPENCODE_CONFIG_CONTENT: JSON.stringify({
						disabled_providers: ["opencode"],
						secret: "must-not-leak",
					}),
				},
				model_filter: { mode: "only", models: ["opencode/gpt"] },
			},
		]);

		expect(() =>
			effectiveAcpEnvironment(item("opencode"), runtimeConfig, {}, "linux"),
		).toThrowError(
			expect.objectContaining({
				message: expect.not.stringContaining("must-not-leak"),
			}),
		);
	});

	it("rejects prototype-special provider IDs at the runtime boundary", () => {
		for (const providerId of ["__proto__", "constructor", "prototype"]) {
			const runtimeConfig = {
				...config(),
				acp_agents: [
					{
						id: "opencode",
						model_filter: {
							mode: "hide" as const,
							models: [`${providerId}/model-a`],
						},
					},
				],
			} as HlidConfig;

			expect(() =>
				effectiveAcpEnvironment(item("opencode"), runtimeConfig, {}, "linux"),
			).toThrow(`provider ID ${JSON.stringify(providerId)} is reserved`);
		}
	});

	it("normalizes case-insensitive OpenCode config keys on Windows", () => {
		const runtimeConfig = config([
			{
				id: "opencode",
				env: {
					opencode_config_content: '{"instructions":["configured.md"]}',
				},
				model_filter: { mode: "hide", models: ["opencode/model-a"] },
			},
		]);

		const environment = effectiveAcpEnvironment(
			item("opencode", {
				env: { OPENCODE_CONFIG_CONTENT: '{"instructions":["registry.md"]}' },
			}),
			runtimeConfig,
			{ OpEnCoDe_CoNfIg_CoNtEnT: '{"instructions":["inherited.md"]}' },
			"win32",
		);

		expect(
			Object.keys(environment).filter(
				(key) => key.toUpperCase() === "OPENCODE_CONFIG_CONTENT",
			),
		).toEqual(["OPENCODE_CONFIG_CONTENT"]);
		expect(
			JSON.parse(environment.OPENCODE_CONFIG_CONTENT).instructions,
		).toEqual(["configured.md"]);
	});

	it("preflights invalid inline content without echoing it", () => {
		const runtimeConfig = config([
			{
				id: "opencode",
				env: { OPENCODE_CONFIG_CONTENT: '{"secret":"do-not-echo",' },
				model_filter: { mode: "hide", models: ["opencode/model-a"] },
			},
		]);

		let thrown: unknown;
		try {
			preflightOpenCodeModelFilter(runtimeConfig, {}, "linux");
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(OpenCodeConfigOverlayError);
		expect((thrown as Error).message).not.toContain("do-not-echo");
	});

	it("bounds the serialized runtime overlay below the Windows env limit", () => {
		const models = Array.from(
			{ length: 130 },
			(_, index) =>
				`opencode/model-${String(index).padStart(3, "0")}-${"x".repeat(180)}`,
		);
		const runtimeConfig = config([
			{
				id: "opencode",
				model_filter: { mode: "only", models },
			},
		]);

		expect(() =>
			preflightOpenCodeModelFilter(runtimeConfig, {}, "win32"),
		).toThrow("at or below 24,000 characters");
	});

	it("creates a provider from the resolved catalog invocation", () => {
		const provider = createConfiguredAcpProvider(
			item("opencode", { command: "opencode.cmd" }),
			config([{ id: "opencode", executable: "opencode.cmd" }]),
		);
		expect(provider.providerId).toBe("acp:opencode");
		expect(provider.label).toBe("OpenCode");
		expect(provider.modelCatalogScope).toBe("workspace");
		expect(provider.metadataCacheIdentity).toBe(
			acpRuntimeFingerprint(
				item("opencode", { command: "opencode.cmd" }),
				config([{ id: "opencode", executable: "opencode.cmd" }]),
			),
		);
	});

	it("keys continuity to local runtime evidence and stable roots, not registry labels", () => {
		vi.stubEnv("XDG_CONFIG_HOME", "/runtime/config-one");
		vi.stubEnv("OPENCODE_PURE", "TRUE");
		const runtimeConfig = config([{ id: "opencode" }]);
		const runtimeExecutableEvidence = {
			launcher: {
				pathKey: "native:/usr/bin/opencode",
				size: "100",
				mtimeNs: "1000",
			},
			packageManifest: {
				pathKey: "native:/usr/lib/node_modules/opencode-ai/package.json",
				size: "200",
				mtimeNs: "2000",
			},
		};
		const base = item("opencode", {
			name: "Registry label one",
			version: "registry-latest-one",
			runtimeExecutableEvidence,
		});
		const identity = acpRuntimeFingerprint(base, runtimeConfig);

		expect(
			acpRuntimeFingerprint(
				{ ...base, name: "Renamed by registry", version: "latest-two" },
				runtimeConfig,
			),
		).toBe(identity);
		expect(
			acpRuntimeFingerprint(
				{
					...base,
					runtimeExecutableEvidence: {
						...runtimeExecutableEvidence,
						packageManifest: {
							...runtimeExecutableEvidence.packageManifest,
							size: "201",
						},
					},
				},
				runtimeConfig,
			),
		).not.toBe(identity);
		vi.stubEnv("XDG_CONFIG_HOME", "/runtime/config-two");
		expect(acpRuntimeFingerprint(base, runtimeConfig)).not.toBe(identity);
		vi.stubEnv("XDG_CONFIG_HOME", "/runtime/config-one");
		vi.stubEnv("OPENCODE_PURE", "false");
		expect(acpRuntimeFingerprint(base, runtimeConfig)).not.toBe(identity);
	});

	it("changes runtime identity and provider launch ownership with the execution target", () => {
		const hostConfig = config([{ id: "opencode" }]);
		const wslConfig = HlidConfigSchema.parse({
			vault: {
				name: "Vault",
				path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\workspace",
			},
			acp_agents: [
				{
					id: "opencode",
					target: { kind: "wsl", distro: "Ubuntu-24.04" },
				},
			],
		});
		const catalogItem = item("opencode");

		expect(acpRuntimeFingerprint(catalogItem, hostConfig)).not.toBe(
			acpRuntimeFingerprint(catalogItem, wslConfig),
		);
		const provider = createConfiguredAcpProvider(catalogItem, wslConfig);
		expect(provider.options.target).toEqual({
			kind: "wsl",
			distro: "Ubuntu-24.04",
		});
		expect(provider.options.discoveryCwd).toBe(
			"\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\workspace",
		);
	});

	it("marks a manually persisted invalid filter unavailable without crashing startup", () => {
		const provider = createConfiguredAcpProvider(
			item("opencode"),
			config([
				{
					id: "opencode",
					env: { OPENCODE_CONFIG_CONTENT: "{" },
					model_filter: { mode: "hide", models: ["opencode/model-a"] },
				},
			]),
		);

		expect(provider.cachedAvailability()).toEqual({
			available: false,
			reason: expect.stringContaining("OPENCODE_CONFIG_CONTENT is invalid"),
		});
	});

	it("adds, replaces, and removes only managed ACP providers", async () => {
		const native = { providerId: "codex", query: vi.fn() } as AgentProvider;
		const providers = new Map<string, AgentProvider>([["codex", native]]);
		const fingerprints = new Map<string, string>();
		const retire = vi.fn();
		const register = vi.fn();
		const firstConfig = config([{ id: "opencode" }]);
		const firstItem = item("opencode");

		expect(
			await syncAcpRuntimeProviders({
				config: firstConfig,
				catalog: [firstItem],
				providers,
				fingerprints,
				retireProviderSessions: retire,
				registerProvider: register,
			}),
		).toEqual({ added: ["acp:opencode"], removed: [], replaced: [] });
		expect(providers.get("codex")).toBe(native);
		expect(register).toHaveBeenCalledWith(
			expect.objectContaining({ providerId: "acp:opencode" }),
			false,
		);

		const changedConfig = config([
			{ id: "opencode", executable: "C:/tools/opencode.cmd" },
		]);
		const changedItem = item("opencode", {
			command: "C:/tools/opencode.cmd",
		});
		expect(
			await syncAcpRuntimeProviders({
				config: changedConfig,
				catalog: [changedItem],
				providers,
				fingerprints,
				retireProviderSessions: retire,
				registerProvider: register,
			}),
		).toEqual({ added: [], removed: [], replaced: ["acp:opencode"] });
		expect(retire).toHaveBeenLastCalledWith(["acp:opencode"], {
			preserveSelection: true,
		});

		expect(
			await syncAcpRuntimeProviders({
				config: config(),
				catalog: [item("opencode", { enabled: false })],
				providers,
				fingerprints,
				retireProviderSessions: retire,
				registerProvider: register,
			}),
		).toEqual({ added: [], removed: ["acp:opencode"], replaced: [] });
		expect(retire).toHaveBeenLastCalledWith(["acp:opencode"]);
		expect(providers.get("codex")).toBe(native);
		expect(providers.has("acp:opencode")).toBe(false);
	});

	it("does not replace an unchanged provider", async () => {
		const activeConfig = config([{ id: "opencode" }]);
		const activeItem = item("opencode");
		const provider = createConfiguredAcpProvider(activeItem, activeConfig);
		const providers = new Map<string, AgentProvider>([
			[provider.providerId, provider],
		]);
		const fingerprints = new Map([
			[provider.providerId, acpRuntimeFingerprint(activeItem, activeConfig)],
		]);
		const register = vi.fn();

		expect(
			await syncAcpRuntimeProviders({
				config: activeConfig,
				catalog: [activeItem],
				providers,
				fingerprints,
				retireProviderSessions: vi.fn(),
				registerProvider: register,
			}),
		).toEqual({ added: [], removed: [], replaced: [] });
		expect(providers.get(provider.providerId)).toBe(provider);
		expect(register).not.toHaveBeenCalled();
	});

	it("preflights a replacement before retiring the live provider", async () => {
		const activeConfig = config([{ id: "opencode" }]);
		const activeItem = item("opencode");
		const provider = createConfiguredAcpProvider(activeItem, activeConfig);
		const providers = new Map<string, AgentProvider>([
			[provider.providerId, provider],
		]);
		const fingerprints = new Map([
			[provider.providerId, acpRuntimeFingerprint(activeItem, activeConfig)],
		]);
		const retire = vi.fn();

		await expect(
			syncAcpRuntimeProviders({
				config: config([
					{
						id: "opencode",
						env: { OPENCODE_CONFIG_CONTENT: "{" },
						model_filter: {
							mode: "hide",
							models: ["opencode/model-a"],
						},
					},
				]),
				catalog: [activeItem],
				providers,
				fingerprints,
				retireProviderSessions: retire,
				registerProvider: vi.fn(),
			}),
		).rejects.toBeInstanceOf(OpenCodeConfigOverlayError);
		expect(providers.get(provider.providerId)).toBe(provider);
		expect(retire).not.toHaveBeenCalled();
	});

	it("does not replace a live provider only because registry availability changed", async () => {
		const activeConfig = config([{ id: "opencode" }]);
		const availableItem = item("opencode");
		const provider = createConfiguredAcpProvider(availableItem, activeConfig);
		const providers = new Map<string, AgentProvider>([
			[provider.providerId, provider],
		]);
		const fingerprints = new Map([
			[provider.providerId, acpRuntimeFingerprint(availableItem, activeConfig)],
		]);
		const retire = vi.fn();

		expect(
			await syncAcpRuntimeProviders({
				config: activeConfig,
				catalog: [
					item("opencode", {
						available: false,
						unavailableReason: "temporary PATH lookup timeout",
					}),
				],
				providers,
				fingerprints,
				retireProviderSessions: retire,
				registerProvider: vi.fn(),
			}),
		).toEqual({ added: [], removed: [], replaced: [] });
		expect(retire).not.toHaveBeenCalled();
		expect(providers.get(provider.providerId)).toBe(provider);
	});

	it("waits for retired runtime cleanup before registering its replacement", async () => {
		const activeConfig = config([{ id: "opencode" }]);
		const activeItem = item("opencode");
		const provider = createConfiguredAcpProvider(activeItem, activeConfig);
		const providers = new Map<string, AgentProvider>([
			[provider.providerId, provider],
		]);
		const fingerprints = new Map([
			[provider.providerId, acpRuntimeFingerprint(activeItem, activeConfig)],
		]);
		let finishCleanup: () => void = () => {};
		const cleanup = new Promise<void>((resolve) => {
			finishCleanup = resolve;
		});
		const register = vi.fn();
		const changedConfig = config([
			{ id: "opencode", executable: "/new/opencode" },
		]);

		const pending = syncAcpRuntimeProviders({
			config: changedConfig,
			catalog: [item("opencode", { command: "/new/opencode" })],
			providers,
			fingerprints,
			retireProviderSessions: () => cleanup,
			registerProvider: register,
		});
		await Promise.resolve();
		expect(register).not.toHaveBeenCalled();
		expect(providers.has("acp:opencode")).toBe(false);

		finishCleanup();
		await expect(pending).resolves.toEqual({
			added: [],
			removed: [],
			replaced: ["acp:opencode"],
		});
		expect(register).toHaveBeenCalledOnce();
		expect(providers.has("acp:opencode")).toBe(true);
	});
});
