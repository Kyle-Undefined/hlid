import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HlidConfig, HlidConfigSchema } from "../config";
import {
	OLLAMA_OPENCODE_ACP_INSPECTION_TIMEOUT_MS,
	OLLAMA_OPENCODE_ACP_PREPARATION_TIMEOUT_MS,
} from "../lib/ollama";
import { AcpProvider } from "./acpProvider";
import type { AcpCatalogItem } from "./acpRegistry";
import {
	acpExecutionTargetForWorkspace,
	acpRuntimeFingerprint,
	createConfiguredAcpProvider,
	effectiveAcpEnvironment,
	HLID_OLLAMA_OPEN_CODE_PROVIDER_ID,
	HLID_OLLAMA_RELAY_TOKEN_ENV,
	OpenCodeConfigOverlayError,
	preflightOpenCodeConfiguration,
	resolveAcpWorkspaceRuntime,
	syncAcpRuntimeProviders,
	withOpenCodeOllamaProvider,
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
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
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
			ollama: { models: ["qwen3-coder:30b"] },
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

	it("carries only inherited host inline config into an Ollama spawn runtime", () => {
		vi.stubEnv(
			"OPENCODE_CONFIG_CONTENT",
			'{"instructions":["windows-inherited.md"],"theme":"system"}',
		);
		vi.stubEnv("HOST_ONLY_SECRET", "must-not-be-forwarded-by-the-resolver");
		const runtimeConfig = HlidConfigSchema.parse({
			vault: { name: "Vault", path: "C:\\Users\\kyle\\Vault" },
			ollama: { models: ["qwen3-coder:30b"] },
			agents: [
				{
					path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\workspace",
				},
			],
			acp_agents: [{ id: "opencode" }],
		});
		const catalogItem = item("opencode", {
			targets: [
				target("host", { selected: true }),
				target("wsl", { selected: false }),
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

		expect(JSON.parse(windows.env.OPENCODE_CONFIG_CONTENT)).toMatchObject({
			instructions: ["windows-inherited.md"],
			theme: "system",
		});
		expect(windows.env).not.toHaveProperty("HOST_ONLY_SECRET");
		expect(wsl.env).not.toHaveProperty("OPENCODE_CONFIG_CONTENT");
		expect(wsl.env).not.toHaveProperty("HOST_ONLY_SECRET");
	});

	it("does not apply the top-level Ollama overlay without configured OpenCode", () => {
		const runtimeConfig = HlidConfigSchema.parse({
			ollama: { models: ["qwen3-coder:30b"] },
		});

		expect(
			effectiveAcpEnvironment(
				item("opencode", { env: { BASE: "registry" } }),
				runtimeConfig,
				{},
				"win32",
			),
		).toEqual({ BASE: "registry" });
		expect(() =>
			preflightOpenCodeConfiguration(runtimeConfig, {}, "win32"),
		).not.toThrow();
	});

	it("keeps the OpenCode Go usage key out of runtime identity and subprocess env", () => {
		const catalogItem = item("opencode");
		const withoutUsage = config([
			{ id: "opencode", env: { RUNTIME_SETTING: "kept" } },
		]);
		const withUsage = config([
			{
				id: "opencode",
				env: { RUNTIME_SETTING: "kept" },
				opencode_go_usage: { api_key: "go-usage-secret" },
			},
		]);

		expect(acpRuntimeFingerprint(catalogItem, withUsage)).toBe(
			acpRuntimeFingerprint(catalogItem, withoutUsage),
		);
		const prior = resolveAcpWorkspaceRuntime(
			catalogItem,
			withoutUsage,
			"/workspace",
		);
		const next = resolveAcpWorkspaceRuntime(
			catalogItem,
			withUsage,
			"/workspace",
		);
		expect(next.env).toEqual(prior.env);
		expect(next.env.OPENCODE_API_KEY).toBeUndefined();
	});

	it("exposes OpenCode Go usage metadata only when its dedicated key exists", () => {
		const catalogItem = item("opencode");
		const withoutUsage = createConfiguredAcpProvider(
			catalogItem,
			config([{ id: "opencode" }]),
		);
		const withUsage = createConfiguredAcpProvider(
			catalogItem,
			config([
				{
					id: "opencode",
					opencode_go_usage: { api_key: "go-usage-secret" },
				},
			]),
		);

		expect(withoutUsage.usageLabel).toBeUndefined();
		expect(withoutUsage.usageWindows).toBeUndefined();
		expect(withUsage.usageLabel).toBe("OpenCode Go");
		expect(withUsage.usageWindows?.map((window) => window.windowId)).toEqual([
			"opencode_go_rolling",
			"opencode_go_weekly",
			"opencode_go_monthly",
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
			preflightOpenCodeConfiguration(runtimeConfig, {}, "linux");
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
			preflightOpenCodeConfiguration(runtimeConfig, {}, "win32"),
		).toThrow("at or below 24,000 characters");
	});

	it("preflights the conservative Ollama launch payload size", () => {
		const models = Array.from(
			{ length: 64 },
			(_, index) => `model-${String(index).padStart(2, "0")}:latest`,
		);
		const inline = JSON.stringify({ instructions: ["x".repeat(20_200)] });
		const runtimeConfig = HlidConfigSchema.parse({
			ollama: { models },
			acp_agents: [
				{
					id: "opencode",
					env: { OPENCODE_CONFIG_CONTENT: inline },
				},
			],
		});

		expect(() =>
			preflightOpenCodeConfiguration(runtimeConfig, {}, "win32"),
		).toThrow("at or below 24,000 characters");
		expect(() =>
			withOpenCodeOllamaProvider(
				{ OPENCODE_CONFIG_CONTENT: inline },
				{
					baseUrl: "http://127.0.0.1:11435/v1",
					apiKeyEnvironmentVariable: HLID_OLLAMA_RELAY_TOKEN_ENV,
					models: models.map((id) => ({ id, contextLength: 65_536 })),
				},
				"win32",
			),
		).toThrow("at or below 24,000 characters");
	});

	it("adds explicit Windows Ollama models without replacing the OpenCode overlay", () => {
		const environment = withOpenCodeOllamaProvider(
			{
				KEEP: "yes",
				OPENCODE_CONFIG_CONTENT: JSON.stringify({
					instructions: ["AGENTS.md"],
					provider: {
						[HLID_OLLAMA_OPEN_CODE_PROVIDER_ID]: {
							whitelist: ["qwen3-coder:30b", "deepseek-r1:14b"],
						},
					},
				}),
			},
			{
				baseUrl: "http://172.29.176.1:11435/v1",
				apiKeyEnvironmentVariable: HLID_OLLAMA_RELAY_TOKEN_ENV,
				models: [
					{ id: "qwen3-coder:30b", contextLength: 65_536 },
					{ id: "deepseek-r1:14b", name: "DeepSeek R1" },
				],
			},
			"linux",
		);
		const content = JSON.parse(environment.OPENCODE_CONFIG_CONTENT);

		expect(environment.KEEP).toBe("yes");
		expect(content.instructions).toEqual(["AGENTS.md"]);
		expect(content.provider[HLID_OLLAMA_OPEN_CODE_PROVIDER_ID]).toEqual({
			whitelist: ["deepseek-r1:14b", "qwen3-coder:30b"],
			npm: "@ai-sdk/openai-compatible",
			name: "Ollama on Windows",
			options: {
				baseURL: "http://172.29.176.1:11435/v1",
				apiKey: `{env:${HLID_OLLAMA_RELAY_TOKEN_ENV}}`,
			},
			models: {
				"deepseek-r1:14b": { name: "DeepSeek R1" },
				"qwen3-coder:30b": {
					name: "qwen3-coder:30b",
					limit: { context: 65_536, output: 8_192 },
				},
			},
		});
	});

	it("emits a complete OpenCode limit when only context is supplied", () => {
		const environment = withOpenCodeOllamaProvider(
			{},
			{
				baseUrl: "http://127.0.0.1:11434/v1",
				models: [{ id: "llama3.2:1b", contextLength: 65_536 }],
			},
			"win32",
		);
		const content = JSON.parse(environment.OPENCODE_CONFIG_CONTENT);

		expect(
			content.provider[HLID_OLLAMA_OPEN_CODE_PROVIDER_ID].models["llama3.2:1b"]
				.limit,
		).toEqual({ context: 65_536, output: 8_192 });
	});

	it("rejects an OpenCode output limit without a context limit", () => {
		expect(() =>
			withOpenCodeOllamaProvider(
				{},
				{
					baseUrl: "http://127.0.0.1:11434/v1",
					models: [{ id: "llama3.2:1b", outputLength: 8_192 }],
				},
				"win32",
			),
		).toThrow(
			"cannot declare an OpenCode output limit without a context limit",
		);
	});

	it("uses direct Windows Ollama without putting a credential in config", () => {
		const environment = withOpenCodeOllamaProvider(
			{ opencode_config_content: '{"theme":"system"}' },
			{
				baseUrl: "http://127.0.0.1:11434/v1",
				models: [{ id: "qwen3:8b" }],
			},
			"win32",
		);
		const matchingKeys = Object.keys(environment).filter(
			(key) => key.toUpperCase() === "OPENCODE_CONFIG_CONTENT",
		);
		const content = JSON.parse(environment.OPENCODE_CONFIG_CONTENT);

		expect(matchingKeys).toEqual(["OPENCODE_CONFIG_CONTENT"]);
		expect(content.theme).toBe("system");
		expect(content.provider[HLID_OLLAMA_OPEN_CODE_PROVIDER_ID].options).toEqual(
			{ baseURL: "http://127.0.0.1:11434/v1" },
		);
		expect(environment).not.toHaveProperty(HLID_OLLAMA_RELAY_TOKEN_ENV);
	});

	it.each([
		[
			"disabled provider",
			{ disabled_providers: [HLID_OLLAMA_OPEN_CODE_PROVIDER_ID] },
		],
		["provider allowlist", { enabled_providers: ["opencode"] }],
		[
			"model blacklist",
			{
				provider: {
					[HLID_OLLAMA_OPEN_CODE_PROVIDER_ID]: {
						blacklist: ["qwen3:8b"],
					},
				},
			},
		],
		[
			"model allowlist",
			{
				provider: {
					[HLID_OLLAMA_OPEN_CODE_PROVIDER_ID]: {
						whitelist: ["another:latest"],
					},
				},
			},
		],
	] as const)("rejects an Ollama-only overlay blocked by %s", (_label, content) => {
		expect(() =>
			withOpenCodeOllamaProvider(
				{ OPENCODE_CONFIG_CONTENT: JSON.stringify(content) },
				{
					baseUrl: "http://127.0.0.1:11434/v1",
					models: [{ id: "qwen3:8b" }],
				},
				"win32",
			),
		).toThrow(/restrictions (?:disable|exclude)/);
	});

	it.each([
		["an exact deny", "hlid-ollama"],
		["a star wildcard deny", "hlid-*"],
		["a question-mark wildcard deny", "hlid-ollam?"],
		["a global deny", "*"],
	] as const)("rejects an Ollama provider policy with %s", (_label, resource) => {
		expect(() =>
			withOpenCodeOllamaProvider(
				{
					OPENCODE_CONFIG_CONTENT: JSON.stringify({
						experimental: {
							policies: [
								{
									effect: "deny",
									action: "provider.use",
									resource,
								},
							],
						},
					}),
				},
				{
					baseUrl: "http://127.0.0.1:11434/v1",
					models: [{ id: "qwen3:8b" }],
				},
				"win32",
			),
		).toThrow("inline provider restrictions disable Hlid's Ollama provider");
	});

	it("uses the last matching provider policy and preserves the policy array", () => {
		const policies = [
			{ effect: "deny", action: "provider.use", resource: "*" },
			{
				effect: "allow",
				action: "provider.use",
				resource: "hlid-ollam?",
			},
		] as const;
		const environment = withOpenCodeOllamaProvider(
			{
				OPENCODE_CONFIG_CONTENT: JSON.stringify({
					experimental: { policies },
				}),
			},
			{
				baseUrl: "http://127.0.0.1:11434/v1",
				models: [{ id: "qwen3:8b" }],
			},
			"win32",
		);

		expect(
			JSON.parse(environment.OPENCODE_CONFIG_CONTENT).experimental.policies,
		).toEqual(policies);
	});

	it("allows the Ollama provider by default when no policy matches", () => {
		expect(() =>
			withOpenCodeOllamaProvider(
				{
					OPENCODE_CONFIG_CONTENT: JSON.stringify({
						experimental: {
							policies: [
								{
									effect: "deny",
									action: "provider.use",
									resource: "company-*",
								},
							],
						},
					}),
				},
				{
					baseUrl: "http://127.0.0.1:11434/v1",
					models: [{ id: "qwen3:8b" }],
				},
				"win32",
			),
		).not.toThrow();
	});

	it.each([
		[
			"experimental",
			{ experimental: [] },
			"OPENCODE_CONFIG_CONTENT.experimental must be a JSON object",
		],
		[
			"policies",
			{ experimental: { policies: {} } },
			"OPENCODE_CONFIG_CONTENT.experimental.policies must be an array",
		],
		[
			"policy statement",
			{ experimental: { policies: ["deny"] } },
			"OPENCODE_CONFIG_CONTENT.experimental.policies[0] must be a JSON object",
		],
		[
			"policy action",
			{
				experimental: {
					policies: [
						{
							effect: "deny",
							action: "provider.read",
							resource: "*",
						},
					],
				},
			},
			'OPENCODE_CONFIG_CONTENT.experimental.policies[0].action must be "provider.use"',
		],
	] as const)("rejects an invalid inline %s schema", (_label, content, message) => {
		expect(() =>
			withOpenCodeOllamaProvider(
				{ OPENCODE_CONFIG_CONTENT: JSON.stringify(content) },
				{
					baseUrl: "http://127.0.0.1:11434/v1",
					models: [{ id: "qwen3:8b" }],
				},
				"win32",
			),
		).toThrow(message);
	});

	it("rejects a partial only-filter overlay that excludes connected Ollama", () => {
		const runtimeConfig = HlidConfigSchema.parse({
			ollama: { models: ["qwen3:8b"] },
			acp_agents: [
				{
					id: "opencode",
					model_filter: {
						mode: "only",
						models: ["hlid-ollama/qwen3:8b", "opencode/other"],
					},
				},
			],
		});

		expect(() =>
			preflightOpenCodeConfiguration(
				runtimeConfig,
				{
					OPENCODE_CONFIG_CONTENT: JSON.stringify({
						disabled_providers: [HLID_OLLAMA_OPEN_CODE_PROVIDER_ID],
					}),
				},
				"win32",
			),
		).toThrow("disable Hlid's Ollama provider");
	});

	it("rejects a manually configured reserved Ollama provider without leaking it", () => {
		const secret = "must-not-leak";
		let thrown: unknown;
		try {
			withOpenCodeOllamaProvider(
				{
					OPENCODE_CONFIG_CONTENT: JSON.stringify({
						secret,
						provider: {
							[HLID_OLLAMA_OPEN_CODE_PROVIDER_ID]: {
								options: { apiKey: secret },
							},
						},
					}),
				},
				{
					baseUrl: "http://127.0.0.1:11434/v1",
					models: [{ id: "qwen3:8b" }],
				},
				"linux",
			);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(OpenCodeConfigOverlayError);
		expect((thrown as Error).message).not.toContain(secret);
	});

	it("extends lifecycle budgets only for Ollama-connected OpenCode children", () => {
		const wslCwd = "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\workspace";
		const query = vi
			.spyOn(AcpProvider.prototype, "query")
			.mockImplementation(() => ({}) as never);
		const ollamaConfig = HlidConfigSchema.parse({
			vault: { name: "Vault", path: wslCwd },
			ollama: { models: ["qwen3:8b"] },
			acp_agents: [
				{ id: "opencode", target: { kind: "wsl", distro: "Ubuntu-24.04" } },
			],
		});
		const openCode = createConfiguredAcpProvider(
			item("opencode", {
				targets: [target("wsl", { selected: true })],
			}),
			ollamaConfig,
		);

		openCode.query({ cwd: wslCwd } as never);
		expect((query.mock.instances[0] as AcpProvider).options.timeouts).toEqual({
			preparationMs: OLLAMA_OPENCODE_ACP_PREPARATION_TIMEOUT_MS,
			inspectionMs: OLLAMA_OPENCODE_ACP_INSPECTION_TIMEOUT_MS,
		});

		const generic = createConfiguredAcpProvider(
			item("pi", { targets: [target("host", { selected: true })] }),
			config([{ id: "pi" }]),
		);
		generic.query({ cwd: "/workspace" } as never);
		expect(
			(query.mock.instances[1] as AcpProvider).options.timeouts,
		).toBeUndefined();
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

	it("keys only configured OpenCode runtimes to the top-level Ollama models", () => {
		const openCode = item("opencode");
		const first = HlidConfigSchema.parse({
			acp_agents: [{ id: "opencode" }],
			ollama: { models: ["qwen3-coder:30b", "devstral:24b"] },
		});
		const reordered = HlidConfigSchema.parse({
			acp_agents: [{ id: "opencode" }],
			ollama: { models: ["devstral:24b", "qwen3-coder:30b"] },
		});
		const changed = HlidConfigSchema.parse({
			acp_agents: [{ id: "opencode" }],
			ollama: { models: ["qwen3-coder:30b"] },
		});
		const changedWarmPeriod = HlidConfigSchema.parse({
			acp_agents: [{ id: "opencode" }],
			ollama: {
				models: ["qwen3-coder:30b", "devstral:24b"],
				keep_warm: "30m",
			},
		});

		expect(acpRuntimeFingerprint(openCode, first)).toBe(
			acpRuntimeFingerprint(openCode, reordered),
		);
		expect(acpRuntimeFingerprint(openCode, first)).not.toBe(
			acpRuntimeFingerprint(openCode, changed),
		);
		expect(acpRuntimeFingerprint(openCode, first)).not.toBe(
			acpRuntimeFingerprint(openCode, changedWarmPeriod),
		);

		const other = item("other");
		const otherConfigured = HlidConfigSchema.parse({
			acp_agents: [{ id: "other" }],
			ollama: { models: ["qwen3-coder:30b"] },
		});
		const otherWithoutOllama = HlidConfigSchema.parse({
			acp_agents: [{ id: "other" }],
		});
		expect(acpRuntimeFingerprint(other, otherConfigured)).toBe(
			acpRuntimeFingerprint(other, otherWithoutOllama),
		);
	});

	it("does not resolve or include a launch receipt in continuity identity", () => {
		const runtimeConfig = HlidConfigSchema.parse({
			vault: {
				name: "Vault",
				path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\workspace",
			},
		});
		const catalogItem = item("opencode", { targets: [target("wsl")] });
		const token = "launch-secret-that-must-not-be-persisted";
		const resolveEnvironment = vi.fn(async ({ environment }) => ({
			environment: { ...environment, [HLID_OLLAMA_RELAY_TOKEN_ENV]: token },
			release: () => {},
		}));
		const provider = createConfiguredAcpProvider(catalogItem, runtimeConfig, {
			resolveEnvironment,
		});

		const identity = provider.sessionContinuityIdentityFor(
			"\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\workspace",
		);

		expect(identity).toMatch(/^[a-f0-9]{64}$/);
		expect(identity).not.toContain(token);
		expect(resolveEnvironment).not.toHaveBeenCalled();
	});

	it("keeps the active workspace identity stable when only another target updates", () => {
		const runtimeConfig = HlidConfigSchema.parse({
			vault: { name: "Vault", path: "C:\\Users\\kyle\\Vault" },
			agents: [
				{
					name: "Workspace",
					path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\workspace",
				},
			],
			acp_agents: [{ id: "opencode" }],
		});
		const host = target("host", { selected: true });
		const priorWsl = target("wsl", {
			selected: false,
			command: "/managed/opencode-v1",
		});
		const updatedWsl = {
			...priorWsl,
			command: "/managed/opencode-v2",
			resolvedExecutable: "/managed/opencode-v2",
			installedVersion: "2.0.0",
		};
		const before = item("opencode", { targets: [host, priorWsl] });
		const after = item("opencode", { targets: [host, updatedWsl] });
		const activeCwd = "C:\\Users\\kyle\\Vault";

		expect(
			resolveAcpWorkspaceRuntime(before, runtimeConfig, activeCwd, "win32")
				.metadataCacheIdentity,
		).toBe(
			resolveAcpWorkspaceRuntime(after, runtimeConfig, activeCwd, "win32")
				.metadataCacheIdentity,
		);
		// The aggregate fingerprint still changes so the routed provider can reconcile
		// the one changed child while leaving this active workspace untouched.
		expect(acpRuntimeFingerprint(before, runtimeConfig)).not.toBe(
			acpRuntimeFingerprint(after, runtimeConfig),
		);
	});

	it("reconciles only the updated WSL child while preserving the live Windows child", async () => {
		const windowsCwd = "C:\\Users\\kyle\\Vault";
		const wslCwd = "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\workspace";
		const runtimeConfig = HlidConfigSchema.parse({
			vault: { name: "Vault", path: windowsCwd },
			agents: [{ name: "Workspace", path: wslCwd }],
			acp_agents: [{ id: "opencode", target: { kind: "host" } }],
		});
		const host = target("host", {
			selected: true,
			command: "C:\\managed\\opencode.exe",
		});
		const priorWsl = target("wsl", {
			selected: false,
			command: "/managed/opencode-v1",
		});
		const updatedWsl = {
			...priorWsl,
			command: "/managed/opencode-v2",
			resolvedExecutable: "/managed/opencode-v2",
			installedVersion: "2.0.0",
		};
		const before = item("opencode", { targets: [host, priorWsl] });
		const after = item("opencode", { targets: [host, updatedWsl] });
		const provider = createConfiguredAcpProvider(before, runtimeConfig);
		const providers = new Map<string, AgentProvider>([
			[provider.providerId, provider],
		]);
		const fingerprints = new Map([
			[provider.providerId, acpRuntimeFingerprint(before, runtimeConfig)],
		]);
		const query = vi
			.spyOn(AcpProvider.prototype, "query")
			.mockImplementation(() => ({}) as never);
		const retireRuntime = vi.spyOn(AcpProvider.prototype, "retireRuntime");
		const retireAll = vi.fn();
		const retireTarget = vi.fn();
		const register = vi.fn();

		provider.query({ cwd: windowsCwd } as never);
		provider.query({ cwd: wslCwd } as never);
		const windowsChild = query.mock.instances[0] as AcpProvider;
		const wslChild = query.mock.instances[1] as AcpProvider;
		const windowsIdentity = provider.runtimeIdentityFor(windowsCwd);
		const wslIdentity = provider.runtimeIdentityFor(wslCwd);

		expect(
			await syncAcpRuntimeProviders({
				config: runtimeConfig,
				catalog: [after],
				providers,
				fingerprints,
				retireProviderSessions: retireAll,
				retireProviderTargetSessions: retireTarget,
				registerProvider: register,
			}),
		).toEqual({
			added: [],
			removed: [],
			replaced: [],
			availabilityUpdated: ["acp:opencode"],
		});

		expect(providers.get("acp:opencode")).toBe(provider);
		expect(retireAll).not.toHaveBeenCalled();
		expect(retireTarget).toHaveBeenCalledOnce();
		expect(retireTarget).toHaveBeenCalledWith("acp:opencode", {
			kind: "wsl",
			distro: "Ubuntu-24.04",
		});
		expect(retireRuntime).toHaveBeenCalledOnce();
		expect(retireRuntime.mock.instances[0]).toBe(wslChild);
		expect(register).toHaveBeenCalledWith(provider, true);
		expect(provider.runtimeIdentityFor(windowsCwd)).toBe(windowsIdentity);
		expect(provider.runtimeIdentityFor(wslCwd)).not.toBe(wslIdentity);

		provider.query({ cwd: windowsCwd } as never);
		provider.query({ cwd: wslCwd } as never);
		expect(query.mock.instances[2]).toBe(windowsChild);
		expect(query.mock.instances[3]).not.toBe(wslChild);
		expect((query.mock.instances[2] as AcpProvider).options.command).toBe(
			"C:\\managed\\opencode.exe",
		);
		expect((query.mock.instances[3] as AcpProvider).options.command).toBe(
			"/managed/opencode-v2",
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

		expect(provider.cachedAvailability({ cwd: "/workspace" })).toEqual({
			available: false,
			reason: expect.stringContaining("OPENCODE_CONFIG_CONTENT is invalid"),
		});
	});

	it("rotates the dedicated Go usage client without retiring the ACP runtime", async () => {
		const catalogItem = item("opencode");
		const initialConfig = config([{ id: "opencode" }]);
		const provider = createConfiguredAcpProvider(catalogItem, initialConfig);
		const providers = new Map<string, AgentProvider>([
			[provider.providerId, provider],
		]);
		const fingerprints = new Map([
			[provider.providerId, acpRuntimeFingerprint(catalogItem, initialConfig)],
		]);
		const retireAll = vi.fn();
		const retireTarget = vi.fn();
		const register = vi.fn();
		const usageFetch = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 401 }));
		vi.stubGlobal("fetch", usageFetch);
		const enabledConfig = config([
			{
				id: "opencode",
				opencode_go_usage: { api_key: "first-go-key" },
			},
		]);

		expect(
			await syncAcpRuntimeProviders({
				config: enabledConfig,
				catalog: [catalogItem],
				providers,
				fingerprints,
				retireProviderSessions: retireAll,
				retireProviderTargetSessions: retireTarget,
				registerProvider: register,
			}),
		).toEqual({
			added: [],
			removed: [],
			replaced: [],
			availabilityUpdated: ["acp:opencode"],
		});
		expect(providers.get("acp:opencode")).toBe(provider);
		expect(retireAll).not.toHaveBeenCalled();
		expect(retireTarget).not.toHaveBeenCalled();
		expect(register).toHaveBeenCalledWith(provider, false);
		expect(provider.usageLabel).toBe("OpenCode Go");
		await provider.readUsageWindows();
		expect(usageFetch.mock.calls[0]?.[1]?.headers).toMatchObject({
			authorization: "Bearer first-go-key",
		});

		register.mockClear();
		const rotatedConfig = config([
			{
				id: "opencode",
				opencode_go_usage: { api_key: "second-go-key" },
			},
		]);
		expect(
			await syncAcpRuntimeProviders({
				config: rotatedConfig,
				catalog: [catalogItem],
				providers,
				fingerprints,
				retireProviderSessions: retireAll,
				retireProviderTargetSessions: retireTarget,
				registerProvider: register,
			}),
		).toEqual({
			added: [],
			removed: [],
			replaced: [],
			availabilityUpdated: ["acp:opencode"],
		});
		expect(register).toHaveBeenCalledWith(provider, false);
		expect(retireAll).not.toHaveBeenCalled();
		expect(retireTarget).not.toHaveBeenCalled();
		await provider.readUsageWindows();
		expect(usageFetch.mock.calls[1]?.[1]?.headers).toMatchObject({
			authorization: "Bearer second-go-key",
		});
	});

	it("never returns an old account reading after its key is replaced in flight", async () => {
		const oldRequest = Promise.withResolvers<Response>();
		const usageResponse = (percent: number) =>
			Response.json({
				usage: {
					rolling: {
						status: "ok",
						percent,
						resetsAt: "2030-01-01T01:00:00.000Z",
					},
					weekly: {
						status: "ok",
						percent,
						resetsAt: "2030-01-07T00:00:00.000Z",
					},
					monthly: {
						status: "ok",
						percent,
						resetsAt: "2030-02-01T00:00:00.000Z",
					},
				},
			});
		const usageFetch = vi.fn(
			(_input: string | URL | Request, init?: RequestInit) =>
				new Headers(init?.headers).get("authorization") === "Bearer old-key"
					? oldRequest.promise
					: Promise.resolve(usageResponse(82)),
		);
		vi.stubGlobal("fetch", usageFetch);
		const provider = createConfiguredAcpProvider(
			item("opencode"),
			config([
				{
					id: "opencode",
					opencode_go_usage: { api_key: "old-key" },
				},
			]),
		);

		const pending = provider.readUsageWindows();
		expect(usageFetch).toHaveBeenCalledOnce();
		provider.updateOpenCodeGoUsage(
			config([
				{
					id: "opencode",
					opencode_go_usage: { api_key: "new-key" },
				},
			]),
		);
		oldRequest.resolve(usageResponse(12));

		const readings = await pending;

		expect(readings[0]?.utilization).toBe(0.82);
		expect(usageFetch).toHaveBeenCalledTimes(2);
		expect(usageFetch.mock.calls[1]?.[1]?.headers).toMatchObject({
			authorization: "Bearer new-key",
		});
	});

	it("adds, reconciles, and removes only managed ACP providers", async () => {
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
				retireProviderTargetSessions: vi.fn(),
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
		const managed = providers.get("acp:opencode");
		retire.mockClear();
		register.mockClear();

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
				retireProviderTargetSessions: vi.fn(),
				registerProvider: register,
			}),
		).toEqual({
			added: [],
			removed: [],
			replaced: [],
			availabilityUpdated: ["acp:opencode"],
		});
		expect(providers.get("acp:opencode")).toBe(managed);
		expect(retire).not.toHaveBeenCalled();
		expect(register).toHaveBeenCalledWith(managed, true);

		expect(
			await syncAcpRuntimeProviders({
				config: config(),
				catalog: [item("opencode", { enabled: false })],
				providers,
				fingerprints,
				retireProviderSessions: retire,
				retireProviderTargetSessions: vi.fn(),
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
				retireProviderTargetSessions: vi.fn(),
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
				retireProviderTargetSessions: vi.fn(),
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
				retireProviderTargetSessions: vi.fn(),
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
				retireProviderTargetSessions: vi.fn(),
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

	it("cancels and awaits a hanging child inspection before reconciling its target", async () => {
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
			const retireTarget = vi.fn();
			const register = vi.fn();

			await expect(
				syncAcpRuntimeProviders({
					config: activeConfig,
					catalog: [replacement],
					providers,
					fingerprints,
					retireProviderSessions: vi.fn(),
					retireProviderTargetSessions: retireTarget,
					registerProvider: register,
				}),
			).resolves.toEqual({
				added: [],
				removed: [],
				replaced: [],
				availabilityUpdated: ["acp:opencode"],
			});
			await expect(models).rejects.toThrow("runtime is updating in");
			expect(providers.get("acp:opencode")).toBe(provider);
			expect(retireTarget).toHaveBeenCalledWith("acp:opencode", {
				kind: "host",
			});
			expect(register).toHaveBeenCalledWith(provider, true);
		} finally {
			await provider.retireRuntime();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves fail-closed replacement behavior for a generic managed provider", async () => {
		const activeConfig = config([{ id: "opencode" }]);
		const activeItem = item("opencode");
		let retirementReason: string | undefined;
		const provider = {
			providerId: "acp:opencode",
			label: "OpenCode",
			query: vi.fn(() => {
				if (retirementReason) throw new Error(retirementReason);
				return {} as never;
			}),
			retireRuntime: vi.fn((reason?: string) => {
				retirementReason = reason;
				return Promise.resolve();
			}),
		} as AgentProvider;
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
			retireProviderTargetSessions: vi.fn(),
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
