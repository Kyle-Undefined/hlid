import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HlidConfig, HlidConfigSchema } from "../config";
import type { AcpCatalogItem } from "./acpRegistry";
import {
	acpExecutionTargetForWorkspace,
	acpRuntimeFingerprint,
	createConfiguredAcpProvider,
	effectiveAcpEnvironment,
	OpenCodeConfigOverlayError,
	preflightOpenCodeModelFilter,
	resolveAcpWorkspaceRuntime,
	syncAcpRuntimeProviders,
} from "./acpRuntime";
import type { AgentProvider } from "./agentProvider";

const fakeAcpFixture = resolve("src/server/fixtures/fake-acp-agent.mjs");

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

function target(
	kind: "host" | "wsl",
	options: {
		distro?: string;
		available?: boolean;
		command?: string;
		blockedReason?: string;
		selected?: boolean;
		env?: Record<string, string>;
	} = {},
): AcpCatalogItem["targets"][number] {
	const executionTarget =
		kind === "host"
			? ({ kind: "host" } as const)
			: ({ kind: "wsl", distro: options.distro ?? "Ubuntu-24.04" } as const);
	const label = kind === "host" ? "Windows" : `WSL · ${executionTarget.distro}`;
	const available = options.available ?? true;
	return {
		targetId: kind === "host" ? "host" : "wsl-ubuntu",
		target: executionTarget,
		label,
		recommended: false,
		selected: options.selected ?? kind === "wsl",
		platformTarget: kind === "host" ? "win32-x64" : "linux-x64",
		provenance: available ? "managed" : "missing",
		available,
		canEnable: available,
		canInstall: !available,
		canUpdate: false,
		canRemove: available,
		registryVersion: "1.0.0",
		mutationRevision: `${kind}-revision`,
		resolvedExecutable: available ? options.command : undefined,
		command:
			options.command ??
			(kind === "host" ? "C:\\managed\\opencode.exe" : "/managed/opencode"),
		args: ["acp"],
		env: { RUNTIME_TARGET: kind, ...options.env },
		installGuidance: `install for ${label}`,
		...(options.blockedReason ? { blockedReason: options.blockedReason } : {}),
	};
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("ACP runtime synchronization", () => {
	it("routes exact Windows and WSL workspace syntax without cross-environment fallback", () => {
		const runtimeConfig = HlidConfigSchema.parse({
			vault: { name: "Vault", path: "C:\\Users\\kyle\\Vault" },
			agents: [
				{
					name: "Hlid",
					path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\hlid",
				},
			],
		});

		expect(
			acpExecutionTargetForWorkspace(
				"C:\\Users\\kyle\\Vault",
				runtimeConfig,
				"win32",
			),
		).toEqual({ kind: "host" });
		expect(
			acpExecutionTargetForWorkspace(
				"\\\\wsl$\\ubuntu-24.04\\home\\kyle\\hlid",
				runtimeConfig,
				"win32",
			),
		).toEqual({ kind: "wsl", distro: "ubuntu-24.04" });
		expect(() =>
			acpExecutionTargetForWorkspace(
				"/home/kyle/hlid/src",
				runtimeConfig,
				"win32",
			),
		).toThrow("bare POSIX path on Windows");
		expect(() =>
			acpExecutionTargetForWorkspace(
				"\\\\wsl.localhost\\Ubuntu-24.04",
				runtimeConfig,
				"win32",
			),
		).toThrow("not a valid WSL UNC path");
		expect(
			acpExecutionTargetForWorkspace("/home/kyle/hlid", runtimeConfig, "linux"),
		).toEqual({ kind: "host" });
	});

	it("selects the exact target invocation and keys continuity to that runtime", () => {
		const runtimeConfig = HlidConfigSchema.parse({
			vault: { name: "Vault", path: "C:\\Users\\kyle\\Vault" },
			agents: [
				{
					name: "Hlid",
					path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\hlid",
				},
			],
			acp_agents: [
				{ id: "opencode", target: { kind: "wsl", distro: "Ubuntu-24.04" } },
			],
		});
		const catalogItem = item("opencode", {
			targets: [
				target("host", { command: "C:\\managed\\opencode.exe" }),
				target("wsl", { command: "/managed/opencode" }),
			],
		});

		const windows = resolveAcpWorkspaceRuntime(
			catalogItem,
			runtimeConfig,
			"C:\\Users\\kyle\\Vault",
			"win32",
		);
		const wsl = resolveAcpWorkspaceRuntime(
			catalogItem,
			runtimeConfig,
			"\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\hlid",
			"win32",
		);

		expect(windows).toMatchObject({
			target: { kind: "host" },
			command: "C:\\managed\\opencode.exe",
			env: { RUNTIME_TARGET: "host" },
		});
		expect(wsl).toMatchObject({
			target: { kind: "wsl", distro: "Ubuntu-24.04" },
			command: "/managed/opencode",
			env: { RUNTIME_TARGET: "wsl" },
		});
		expect(windows.sessionContinuityIdentity).not.toBe(
			wsl.sessionContinuityIdentity,
		);
		expect(windows.metadataCacheIdentity).not.toBe(wsl.metadataCacheIdentity);
	});

	it("keeps configured environment overrides in their selected execution target", () => {
		const runtimeConfig = HlidConfigSchema.parse({
			vault: { name: "Vault", path: "C:\\Users\\kyle\\Vault" },
			agents: [
				{
					path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\workspace",
				},
			],
			acp_agents: [
				{
					id: "opencode",
					target: { kind: "wsl", distro: "Ubuntu-24.04" },
					env: {
						PATH: "/opt/opencode/bin",
						OPENCODE_CONFIG_CONTENT: '{"instructions":["wsl.md"]}',
					},
					model_filter: {
						mode: "hide",
						models: ["opencode/hidden"],
					},
				},
			],
		});
		const catalogItem = item("opencode", {
			targets: [
				target("host", { selected: false }),
				target("wsl", {
					selected: true,
					env: {
						PATH: "/opt/opencode/bin",
						OPENCODE_CONFIG_CONTENT: '{"instructions":["wsl.md"]}',
					},
				}),
			],
		});

		const windows = resolveAcpWorkspaceRuntime(
			catalogItem,
			runtimeConfig,
			"C:\\Users\\kyle\\Vault",
			"win32",
		);
		const wsl = resolveAcpWorkspaceRuntime(
			catalogItem,
			runtimeConfig,
			"\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\workspace",
			"win32",
		);

		expect(windows.env.PATH).toBeUndefined();
		expect(
			JSON.parse(windows.env.OPENCODE_CONFIG_CONTENT).instructions,
		).toBeUndefined();
		expect(wsl.env.PATH).toBe("/opt/opencode/bin");
		expect(JSON.parse(wsl.env.OPENCODE_CONFIG_CONTENT).instructions).toEqual([
			"wsl.md",
		]);
	});

	it("does not merge the Windows host inline config into a WSL runtime", () => {
		const runtimeConfig = config([
			{
				id: "opencode",
				model_filter: { mode: "hide", models: ["opencode/hidden"] },
			},
		]);
		const environment = effectiveAcpEnvironment(
			item("opencode"),
			runtimeConfig,
			{ OPENCODE_CONFIG_CONTENT: '{"instructions":["windows.md"]}' },
			"linux",
			true,
			false,
			false,
		);

		expect(
			JSON.parse(environment.OPENCODE_CONFIG_CONTENT).instructions,
		).toBeUndefined();
	});

	it("keeps selected Windows executable evidence out of the WSL runtime identity", () => {
		const runtimeConfig = HlidConfigSchema.parse({
			vault: { name: "Vault", path: "C:\\Users\\kyle\\Vault" },
			agents: [
				{
					name: "Hlid",
					path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\hlid",
				},
			],
		});
		const targets = [
			{ ...target("host"), selected: true },
			{ ...target("wsl"), selected: false },
		];
		const withEvidence = (size: string) =>
			item("opencode", {
				targets,
				runtimeExecutableEvidence: {
					launcher: {
						pathKey: "native:C:/managed/opencode.exe",
						size,
						mtimeNs: "1",
					},
				},
			});
		const windowsCwd = "C:\\Users\\kyle\\Vault";
		const wslCwd = "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\hlid";

		expect(
			resolveAcpWorkspaceRuntime(
				withEvidence("1"),
				runtimeConfig,
				wslCwd,
				"win32",
			).sessionContinuityIdentity,
		).toBe(
			resolveAcpWorkspaceRuntime(
				withEvidence("2"),
				runtimeConfig,
				wslCwd,
				"win32",
			).sessionContinuityIdentity,
		);
		expect(
			resolveAcpWorkspaceRuntime(
				withEvidence("1"),
				runtimeConfig,
				windowsCwd,
				"win32",
			).sessionContinuityIdentity,
		).not.toBe(
			resolveAcpWorkspaceRuntime(
				withEvidence("2"),
				runtimeConfig,
				windowsCwd,
				"win32",
			).sessionContinuityIdentity,
		);
	});

	it("keeps Windows host config and roots out of the WSL runtime identity", () => {
		const runtimeConfig = HlidConfigSchema.parse({
			vault: { name: "Vault", path: "C:\\Users\\kyle\\Vault" },
			agents: [
				{
					path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\hlid",
				},
			],
		});
		const catalogItem = item("opencode", {
			targets: [
				{ ...target("host"), selected: true },
				{ ...target("wsl"), selected: false },
			],
		});
		const windowsCwd = "C:\\Users\\kyle\\Vault";
		const wslCwd = "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\hlid";
		const identityFor = (cwd: string) =>
			resolveAcpWorkspaceRuntime(catalogItem, runtimeConfig, cwd, "win32")
				.sessionContinuityIdentity;

		vi.stubEnv("XDG_CONFIG_HOME", "C:\\Users\\kyle\\config-one");
		vi.stubEnv(
			"OPENCODE_CONFIG_CONTENT",
			'{"instructions":["windows-one.md"]}',
		);
		const initialWindowsIdentity = identityFor(windowsCwd);
		const initialWslIdentity = identityFor(wslCwd);

		vi.stubEnv("XDG_CONFIG_HOME", "C:\\Users\\kyle\\config-two");
		vi.stubEnv(
			"OPENCODE_CONFIG_CONTENT",
			'{"instructions":["windows-two.md"]}',
		);

		expect(identityFor(wslCwd)).toBe(initialWslIdentity);
		expect(identityFor(windowsCwd)).not.toBe(initialWindowsIdentity);
	});

	it("reports the exact workspace target unavailable instead of using another install", () => {
		const runtimeConfig = HlidConfigSchema.parse({
			vault: { name: "Vault", path: "C:\\Users\\kyle\\Vault" },
			agents: [
				{
					name: "Hlid",
					path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\hlid",
				},
			],
		});
		const catalogItem = item("opencode", {
			targets: [
				target("host", {
					available: false,
					command: "opencode",
					blockedReason: "OpenCode is not installed for Windows",
				}),
				target("wsl", { command: "/managed/opencode" }),
			],
		});

		expect(
			resolveAcpWorkspaceRuntime(
				catalogItem,
				runtimeConfig,
				"C:\\Users\\kyle\\Vault",
				"win32",
			),
		).toMatchObject({
			target: { kind: "host" },
			available: false,
			reason: "OpenCode is not installed for Windows",
			command: "opencode",
		});
	});

	it("rejects an unconfigured exact WSL distro instead of falling back to Windows", () => {
		const runtimeConfig = HlidConfigSchema.parse({
			vault: { name: "Vault", path: "C:\\Users\\kyle\\Vault" },
		});
		const catalogItem = item("opencode", {
			targets: [target("host")],
		});

		expect(() =>
			resolveAcpWorkspaceRuntime(
				catalogItem,
				runtimeConfig,
				"\\\\wsl.localhost\\Debian\\home\\kyle\\repo",
				"win32",
			),
		).toThrow("has no WSL · Debian runtime configured");
	});

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
		expect(provider.effortScope).toBe("model");
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

	it("routes launch ownership independently of the Forge-selected target", () => {
		const runtimeConfig = HlidConfigSchema.parse({
			vault: {
				name: "Vault",
				path: "C:\\Users\\kyle\\Vault",
			},
			agents: [
				{
					name: "Workspace",
					path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\workspace",
				},
			],
			acp_agents: [
				{
					id: "opencode",
					target: { kind: "wsl", distro: "Ubuntu-24.04" },
				},
			],
		});
		const catalogItem = item("opencode", {
			targets: [target("host"), target("wsl")],
		});
		const hostSelectedConfig = {
			...runtimeConfig,
			acp_agents: [{ id: "opencode" }] as HlidConfig["acp_agents"],
		};

		expect(acpRuntimeFingerprint(catalogItem, hostSelectedConfig)).toBe(
			acpRuntimeFingerprint(catalogItem, runtimeConfig),
		);
		const provider = createConfiguredAcpProvider(catalogItem, runtimeConfig);
		const workspace = "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\workspace";
		expect(provider.sessionContinuityIdentityFor(workspace)).toBe(
			resolveAcpWorkspaceRuntime(catalogItem, runtimeConfig, workspace, "win32")
				.sessionContinuityIdentity,
		);
		expect(provider.metadataCacheIdentityFor(workspace)).toBe(
			resolveAcpWorkspaceRuntime(catalogItem, runtimeConfig, workspace, "win32")
				.metadataCacheIdentity,
		);
		expect(provider.sessionContinuityIdentity).toBeUndefined();
		expect(provider.cachedAvailability()).toEqual({
			available: false,
			reason: expect.stringContaining("requires an exact workspace cwd"),
		});
		expect(() =>
			provider.metadataCacheIdentityFor("\\\\wsl.localhost\\Ubuntu-24.04"),
		).toThrow("not a valid WSL UNC path");
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

		expect(provider.cachedAvailability({ cwd: "/workspace" })).toEqual({
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
		).toEqual({
			added: ["acp:opencode"],
			removed: [],
			replaced: [],
			availabilityUpdated: [],
		});
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
		).toEqual({
			added: [],
			removed: [],
			replaced: ["acp:opencode"],
			availabilityUpdated: [],
		});
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
		).toEqual({
			added: [],
			removed: ["acp:opencode"],
			replaced: [],
			availabilityUpdated: [],
		});
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
		).toEqual({
			added: [],
			removed: [],
			replaced: [],
			availabilityUpdated: [],
		});
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

	it("updates availability in place as WSL verification settles", async () => {
		const activeConfig = config([{ id: "opencode" }]);
		const pendingItem = item("opencode", {
			available: false,
			unavailableReason: "Verifying WSL availability",
		});
		const provider = createConfiguredAcpProvider(pendingItem, activeConfig);
		const providers = new Map<string, AgentProvider>([
			[provider.providerId, provider],
		]);
		const fingerprints = new Map([
			[provider.providerId, acpRuntimeFingerprint(pendingItem, activeConfig)],
		]);
		const retire = vi.fn();

		expect(
			await syncAcpRuntimeProviders({
				config: activeConfig,
				catalog: [item("opencode")],
				providers,
				fingerprints,
				retireProviderSessions: retire,
				registerProvider: vi.fn(),
			}),
		).toEqual({
			added: [],
			removed: [],
			replaced: [],
			availabilityUpdated: ["acp:opencode"],
		});
		expect(provider.cachedAvailability({ cwd: "/workspace" })).toEqual({
			available: true,
		});

		expect(
			await syncAcpRuntimeProviders({
				config: activeConfig,
				catalog: [
					item("opencode", {
						available: false,
						unavailableReason: "WSL timed out",
					}),
				],
				providers,
				fingerprints,
				retireProviderSessions: retire,
				registerProvider: vi.fn(),
			}),
		).toEqual({
			added: [],
			removed: [],
			replaced: [],
			availabilityUpdated: ["acp:opencode"],
		});
		expect(provider.cachedAvailability({ cwd: "/workspace" })).toEqual({
			available: false,
			reason: expect.stringContaining("WSL timed out"),
		});
		expect(retire).not.toHaveBeenCalled();
		expect(providers.get(provider.providerId)).toBe(provider);
	});

	it("cancels and awaits a hanging old inspection before swapping runtimes", async () => {
		const root = mkdtempSync(join(tmpdir(), "hlid-acp-runtime-replace-"));
		const initializeMarker = join(root, "initialize.log");
		const activeConfig = HlidConfigSchema.parse({
			vault: { name: "Vault", path: root },
			acp_agents: [{ id: "opencode" }],
		});
		const activeItem = item("opencode", {
			command: "bun",
			args: [fakeAcpFixture],
			env: {
				HLID_FAKE_ACP_BEHAVIOR: "hang-initialize",
				HLID_FAKE_ACP_INITIALIZE_MARKER: initializeMarker,
			},
		});
		const provider = createConfiguredAcpProvider(activeItem, activeConfig);
		const providers = new Map<string, AgentProvider>([
			[provider.providerId, provider],
		]);
		const fingerprints = new Map([
			[provider.providerId, acpRuntimeFingerprint(activeItem, activeConfig)],
		]);
		const models = provider.listModels({ cwd: root });
		void models.catch(() => {});

		try {
			await vi.waitFor(() => expect(existsSync(initializeMarker)).toBe(true));
			const replacement = item("opencode", {
				command: "bun",
				args: [fakeAcpFixture],
				env: { HLID_FAKE_ACP_BEHAVIOR: "" },
			});

			await expect(
				syncAcpRuntimeProviders({
					config: activeConfig,
					catalog: [replacement],
					providers,
					fingerprints,
					retireProviderSessions: vi.fn(),
					registerProvider: vi.fn(),
				}),
			).resolves.toEqual({
				added: [],
				removed: [],
				replaced: ["acp:opencode"],
				availabilityUpdated: [],
			});
			await expect(models).rejects.toThrow("runtime is updating");
			expect(providers.get("acp:opencode")).not.toBe(provider);
		} finally {
			await provider.retireRuntime();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps a fail-closed runtime registered until replacement cleanup settles", async () => {
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
		expect(providers.get("acp:opencode")).toBe(provider);
		expect(() => provider.query({ cwd: "/workspace" } as never)).toThrow(
			"runtime is updating",
		);

		finishCleanup();
		await expect(pending).resolves.toEqual({
			added: [],
			removed: [],
			replaced: ["acp:opencode"],
			availabilityUpdated: [],
		});
		expect(register).toHaveBeenCalledOnce();
		expect(providers.get("acp:opencode")).not.toBe(provider);
	});
});
