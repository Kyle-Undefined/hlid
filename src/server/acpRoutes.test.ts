import { beforeEach, describe, expect, it, vi } from "vitest";
import { HlidConfigSchema } from "../config";
import {
	AcpSessionImportUnsupportedError,
	AcpSessionListUnsupportedError,
} from "./acpProvider";
import { createAcpRouteHandler } from "./acpRoutes";
import {
	OpenCodeConfigOverlayError,
	resolveAcpWorkspaceRuntime,
} from "./acpRuntime";
import { acpExecutionTargetId } from "./acpTargets";

const mutationRevision = "a".repeat(64);
const hostTarget = {
	targetId: "host",
	target: { kind: "host" as const },
	label: "Host",
	recommended: true,
	selected: true,
	platformTarget: "linux-x86_64",
	provenance: "external" as const,
	available: true,
	canEnable: true,
	canInstall: true,
	canUpdate: false,
	canRemove: false,
	registryVersion: "1",
	mutationRevision,
	resolvedExecutable: "/usr/bin/opencode",
	command: "opencode",
	args: ["acp"],
	env: { BASE: "registry", TARGET_SECRET: "redacted" },
	installGuidance: "install",
};
const { env: _hostTargetEnvironment, ...publicHostTarget } = hostTarget;
const wslWorkspace = "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\workspace";
const wslTargetDescriptor = {
	kind: "wsl" as const,
	distro: "Ubuntu-24.04",
};
const wslTargetId = acpExecutionTargetId(wslTargetDescriptor);
const wslTarget = {
	...hostTarget,
	targetId: wslTargetId,
	target: wslTargetDescriptor,
	label: "WSL · Ubuntu-24.04",
	recommended: false,
	selected: false,
	platformTarget: "linux-x86_64",
	resolvedExecutable: "/opt/hlid/opencode",
	command: "/opt/hlid/opencode",
	env: { BASE: "wsl-registry", RUNTIME_TARGET: "wsl" },
};
const orphanTarget = { kind: "wsl" as const, distro: "Ubuntu-24.04" };
const orphanTargetId = acpExecutionTargetId(orphanTarget);
const orphanClaim = {
	agentId: "opencode",
	target: orphanTarget,
	targetId: orphanTargetId,
	hostCwd: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\removed",
};
const secondOrphanTarget = { kind: "wsl" as const, distro: "Debian" };
const secondOrphanTargetId = acpExecutionTargetId(secondOrphanTarget);
const secondOrphanClaim = {
	agentId: "opencode",
	target: secondOrphanTarget,
	targetId: secondOrphanTargetId,
	hostCwd: "\\\\wsl.localhost\\Debian\\home\\kyle\\removed",
};
const orphanTargetStatus = {
	targetId: orphanTargetId,
	target: orphanTarget,
	label: "WSL · Ubuntu-24.04",
	recommended: false,
	selected: false,
	platformTarget: "linux-unknown",
	provenance: "managed" as const,
	available: false,
	canEnable: false,
	canInstall: false,
	canUpdate: false,
	canRemove: true,
	cleanupOnly: true,
	registryVersion: "1",
	installedVersion: "1",
	mutationRevision,
	command: "/mnt/c/Hlid/opencode",
	args: ["acp"],
	env: {},
	installGuidance: "Remove the retained managed installation",
	blockedReason: "The original WSL workspace is no longer configured",
};
const secondOrphanTargetStatus = {
	...orphanTargetStatus,
	targetId: secondOrphanTargetId,
	target: secondOrphanTarget,
	label: "WSL · Debian",
	command: "/mnt/c/Hlid/opencode-debian",
};

const enabledAgent = {
	id: "opencode",
	name: "OpenCode",
	version: "1",
	description: "Agent",
	distribution: {},
	providerId: "acp:opencode",
	enabled: true,
	available: true,
	command: "opencode",
	args: ["acp"],
	env: { BASE: "registry" },
	installGuidance: "install",
	targets: [hostTarget],
};

const catalog = vi.fn();
const loadConfig = vi.fn();
const inspectAgent = vi.fn();
const inspectModels = vi.fn();
const resolveEnvironment = vi.fn();
const listSessions = vi.fn();
const findSession = vi.fn();
const importSession = vi.fn();
const logModelDiscoveryFailure = vi.fn();
const logSessionListFailure = vi.fn();
const logSessionImportFailure = vi.fn();
const syncRuntime = vi.fn();
const handle = createAcpRouteHandler({
	registry: { catalog },
	loadConfig,
	inspectAgent,
	inspectModels,
	resolveEnvironment,
	listSessions,
	findSession,
	importSession,
	logModelDiscoveryFailure,
	logSessionListFailure,
	logSessionImportFailure,
	syncRuntime,
});

function request(path: string, method = "GET", body?: unknown): Request {
	return new Request(`http://localhost${path}`, {
		method,
		headers: body ? { "content-type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	loadConfig.mockReturnValue(
		HlidConfigSchema.parse({
			acp_agents: [
				{ id: "opencode", env: { BASE: "configured", TOKEN: "secret" } },
			],
		}),
	);
	catalog.mockResolvedValue([enabledAgent]);
	inspectAgent.mockResolvedValue({
		authMethods: [{ id: "login", name: "Login" }],
		agentInfo: { name: "OpenCode", version: "1" },
	});
	inspectModels.mockResolvedValue([
		{ value: "opencode/model-a", label: "Model A", isDefault: true },
		{ value: "opencode/model-b", label: "Model B" },
	]);
	resolveEnvironment.mockImplementation(async ({ environment }) => ({
		environment: { ...environment },
		release: () => {},
	}));
	listSessions.mockResolvedValue({
		sessions: [
			{
				sessionId: "provider-session-1",
				title: "Provider session",
				updatedAt: "2026-08-12T12:00:00.000Z",
			},
		],
		canImportSessions: true,
	});
	findSession.mockResolvedValue({
		sessionId: "provider-session-1",
		title: "Provider session",
		updatedAt: "2026-08-12T12:00:00.000Z",
	});
	importSession.mockResolvedValue({
		sessionId: "hlid-session-1",
		created: true,
		rebound: false,
	});
	syncRuntime.mockResolvedValue({
		added: ["acp:opencode"],
		removed: [],
		replaced: [],
	});
});

describe("ACP internal HTTP routes", () => {
	it("preflights model filters against the resolved registry environment", async () => {
		const filteredConfig = HlidConfigSchema.parse({
			acp_agents: [
				{
					id: "opencode",
					model_filter: {
						mode: "only",
						models: ["opencode/model-a"],
					},
				},
			],
		});
		catalog.mockResolvedValueOnce([
			{
				...enabledAgent,
				env: { OPENCODE_CONFIG_CONTENT: "{" },
				targets: [
					{
						...hostTarget,
						env: { OPENCODE_CONFIG_CONTENT: "{" },
					},
				],
			},
		]);

		const conflict = await handle(
			new URL("http://localhost/acp/preflight"),
			request("/acp/preflight", "POST", filteredConfig),
		);

		expect(conflict?.status).toBe(409);
		expect(await conflict?.json()).toEqual({
			error: expect.stringContaining("OPENCODE_CONFIG_CONTENT is invalid"),
		});
		expect(catalog).toHaveBeenLastCalledWith(filteredConfig, false, false, {
			agentIds: ["opencode"],
		});

		catalog.mockResolvedValueOnce([enabledAgent]);
		const accepted = await handle(
			new URL("http://localhost/acp/preflight"),
			request("/acp/preflight", "POST", filteredConfig),
		);
		expect(accepted?.status).toBe(200);
		expect(await accepted?.json()).toEqual({ ok: true });
		expect(catalog).toHaveBeenLastCalledWith(filteredConfig, false, false, {
			agentIds: ["opencode"],
		});
	});

	it("preflights an Ollama-only overlay against the resolved target environment", async () => {
		const ollamaConfig = HlidConfigSchema.parse({
			ollama: { models: ["qwen3-coder:30b"] },
			acp_agents: [{ id: "opencode" }],
		});
		catalog.mockResolvedValueOnce([
			{
				...enabledAgent,
				targets: [
					{
						...hostTarget,
						env: {
							OPENCODE_CONFIG_CONTENT: JSON.stringify({
								provider: {
									"hlid-ollama": { npm: "@manual/provider" },
								},
							}),
						},
					},
				],
			},
		]);

		const conflict = await handle(
			new URL("http://localhost/acp/preflight"),
			request("/acp/preflight", "POST", ollamaConfig),
		);

		expect(conflict?.status).toBe(409);
		expect(await conflict?.json()).toEqual({
			error: expect.stringContaining("hlid-ollama is reserved by Hlid"),
		});
		expect(catalog).toHaveBeenLastCalledWith(ollamaConfig, false, false, {
			agentIds: ["opencode"],
		});
	});

	it("preflights Ollama against every runnable Windows and WSL target", async () => {
		const ollamaConfig = HlidConfigSchema.parse({
			ollama: { models: ["qwen3-coder:30b"] },
			acp_agents: [{ id: "opencode" }],
		});
		catalog.mockResolvedValueOnce([
			{
				...enabledAgent,
				targets: [
					hostTarget,
					{
						...wslTarget,
						available: true,
						env: {
							OPENCODE_CONFIG_CONTENT: JSON.stringify({
								disabled_providers: ["hlid-ollama"],
							}),
						},
					},
				],
			},
		]);

		const conflict = await handle(
			new URL("http://localhost/acp/preflight"),
			request("/acp/preflight", "POST", ollamaConfig),
		);

		expect(conflict?.status).toBe(409);
		expect(await conflict?.json()).toEqual({
			error: expect.stringContaining("disable Hlid's Ollama provider"),
		});
	});

	it("discovers the exact target's raw models without Hlid's visibility overlay", async () => {
		const inlineConfig = '{"instructions":["existing.md"]}';
		loadConfig.mockReturnValue(
			HlidConfigSchema.parse({
				vault: { name: "Vault", path: "/vault" },
				acp_agents: [
					{
						id: "opencode",
						env: { OPENCODE_CONFIG_CONTENT: inlineConfig },
						model_filter: {
							mode: "only",
							models: ["opencode/model-a"],
						},
					},
				],
			}),
		);
		catalog.mockResolvedValueOnce([
			{
				...enabledAgent,
				env: { OPENCODE_CONFIG_CONTENT: inlineConfig },
				targets: [
					{
						...hostTarget,
						env: { OPENCODE_CONFIG_CONTENT: inlineConfig },
					},
				],
			},
		]);

		const response = await handle(
			new URL("http://localhost/acp/models?id=opencode"),
			request("/acp/models?id=opencode"),
		);

		expect(response?.status).toBe(200);
		expect(loadConfig).toHaveBeenCalledOnce();
		expect(catalog).toHaveBeenCalledWith(
			loadConfig.mock.results[0]?.value,
			false,
			false,
			{ agentIds: ["opencode"] },
		);
		expect(inspectModels).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "acp:opencode",
				command: "opencode",
				args: ["acp"],
				env: { OPENCODE_CONFIG_CONTENT: inlineConfig },
				discoveryCwd: "/vault",
			}),
			"/vault",
		);
		expect(await response?.json()).toEqual({
			models: [
				{
					value: "opencode/model-a",
					label: "Model A",
					isDefault: true,
				},
				{ value: "opencode/model-b", label: "Model B" },
			],
		});
	});

	it("applies the Ollama integration while leaving Forge model discovery unfiltered", async () => {
		const config = HlidConfigSchema.parse({
			vault: { name: "Vault", path: "/vault" },
			ollama: { models: ["qwen3.5:4b"] },
			acp_agents: [
				{
					id: "opencode",
					model_filter: {
						mode: "only",
						models: ["hlid-ollama/qwen3.5:4b"],
					},
				},
			],
		});
		loadConfig.mockReturnValue(config);
		const release = vi.fn();
		resolveEnvironment.mockImplementationOnce(async (input) => ({
			environment: {
				...input.environment,
				OPENCODE_CONFIG_CONTENT: JSON.stringify({
					provider: { "hlid-ollama": { models: { "qwen3.5:4b": {} } } },
				}),
			},
			release,
		}));
		inspectModels.mockImplementationOnce(async (options, cwd) => {
			const receipt = await options.processEnvironment?.({
				environment: { ...(options.env as Record<string, string>) },
			});
			expect(cwd).toBe("/vault");
			expect(receipt?.environment.OPENCODE_CONFIG_CONTENT).toContain(
				'"hlid-ollama"',
			);
			await receipt?.release();
			return [
				{ value: "opencode/model-a", label: "Model A", isDefault: true },
				{
					value: "hlid-ollama/qwen3.5:4b",
					label: "Ollama on Windows/qwen3.5:4b",
				},
			];
		});

		const response = await handle(
			new URL("http://localhost/acp/models?id=opencode"),
			request("/acp/models?id=opencode"),
		);

		expect(response?.status).toBe(200);
		expect(resolveEnvironment).toHaveBeenCalledWith(
			expect.objectContaining({
				item: enabledAgent,
				config,
				target: { kind: "host" },
				cwd: "/vault",
			}),
		);
		expect(release).toHaveBeenCalledOnce();
		expect(await response?.json()).toEqual({
			models: [
				{ value: "opencode/model-a", label: "Model A", isDefault: true },
				{
					value: "hlid-ollama/qwen3.5:4b",
					label: "Ollama on Windows/qwen3.5:4b",
				},
			],
		});
	});

	it("bounds raw model catalogs before serializing provider output", async () => {
		inspectModels.mockResolvedValueOnce(
			Array.from({ length: 2_001 }, (_, index) => ({
				value: `opencode/model-${index}`,
				label: `Model ${index}`,
			})),
		);

		const tooMany = await handle(
			new URL("http://localhost/acp/models?id=opencode"),
			request("/acp/models?id=opencode"),
		);
		expect(tooMany?.status).toBe(502);
		expect(await tooMany?.json()).toEqual({
			error: "ACP model discovery failed",
		});

		inspectModels.mockResolvedValueOnce([
			{ value: `opencode/${"x".repeat(512)}`, label: "Oversized" },
		]);
		const oversized = await handle(
			new URL("http://localhost/acp/models?id=opencode"),
			request("/acp/models?id=opencode"),
		);
		expect(oversized?.status).toBe(502);
		expect(logModelDiscoveryFailure).toHaveBeenCalledTimes(2);
	});

	it("redacts provider diagnostics when raw model discovery fails", async () => {
		const secret = "super-secret-config-value";
		inspectModels.mockRejectedValueOnce(
			new Error(`OPENCODE_CONFIG_CONTENT=${secret}`),
		);

		const response = await handle(
			new URL("http://localhost/acp/models?id=opencode"),
			request("/acp/models?id=opencode"),
		);
		const body = JSON.stringify(await response?.json());
		const logs = JSON.stringify(logModelDiscoveryFailure.mock.calls);

		expect(response?.status).toBe(502);
		expect(body).toBe('{"error":"ACP model discovery failed"}');
		expect(body).not.toContain(secret);
		expect(logs).not.toContain(secret);
		expect(logs).not.toContain("OPENCODE_CONFIG_CONTENT");
	});

	it("validates model discovery before starting an ACP inspection", async () => {
		expect(
			(
				await handle(
					new URL("http://localhost/acp/models"),
					request("/acp/models"),
				)
			)?.status,
		).toBe(400);

		catalog.mockResolvedValueOnce([]);
		expect(
			(
				await handle(
					new URL("http://localhost/acp/models?id=missing"),
					request("/acp/models?id=missing"),
				)
			)?.status,
		).toBe(404);

		catalog.mockResolvedValueOnce([
			{
				...enabledAgent,
				available: false,
				unavailableReason: "not installed",
				targets: [
					{
						...hostTarget,
						available: false,
						blockedReason: "not installed",
					},
				],
			},
		]);
		expect(
			(
				await handle(
					new URL("http://localhost/acp/models?id=opencode"),
					request("/acp/models?id=opencode"),
				)
			)?.status,
		).toBe(409);
		expect(inspectModels).not.toHaveBeenCalled();
	});

	it("uses an available Windows runtime even when the Forge-selected WSL runtime is unavailable", async () => {
		const windowsWorkspace = "C:\\Users\\kyle\\Vault";
		const config = HlidConfigSchema.parse({
			vault: { name: "Vault", path: windowsWorkspace },
			agents: [{ path: wslWorkspace }],
			acp_agents: [
				{
					id: "opencode",
					target: wslTargetDescriptor,
				},
			],
		});
		loadConfig.mockReturnValue(config);
		catalog.mockResolvedValue([
			{
				...enabledAgent,
				available: false,
				unavailableReason: "OpenCode is unavailable in WSL",
				targets: [
					{ ...hostTarget, selected: false },
					{
						...wslTarget,
						selected: true,
						available: false,
						blockedReason: "OpenCode is unavailable in WSL",
					},
				],
			},
		]);
		const query = new URLSearchParams({
			id: "opencode",
			cwd: windowsWorkspace,
		});

		const models = await handle(
			new URL(`http://localhost/acp/models?${query}`),
			request(`/acp/models?${query}`),
		);
		const authenticated = await handle(
			new URL("http://localhost/acp/authenticate"),
			request("/acp/authenticate", "POST", {
				id: "opencode",
				cwd: windowsWorkspace,
			}),
		);

		expect(models?.status).toBe(200);
		expect(authenticated?.status).toBe(200);
		expect(inspectModels).toHaveBeenCalledWith(
			expect.objectContaining({
				command: "opencode",
				target: { kind: "host" },
				discoveryCwd: windowsWorkspace,
			}),
			windowsWorkspace,
		);
		expect(inspectAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				command: "opencode",
				target: { kind: "host" },
				discoveryCwd: windowsWorkspace,
			}),
			undefined,
		);
	});

	it("fails closed when the requested WSL runtime is unavailable instead of using selected Windows", async () => {
		const windowsWorkspace = "C:\\Users\\kyle\\Vault";
		loadConfig.mockReturnValue(
			HlidConfigSchema.parse({
				vault: { name: "Vault", path: windowsWorkspace },
				agents: [{ path: wslWorkspace }],
				acp_agents: [{ id: "opencode" }],
			}),
		);
		catalog.mockResolvedValueOnce([
			{
				...enabledAgent,
				targets: [
					{ ...hostTarget, selected: true },
					{
						...wslTarget,
						available: false,
						blockedReason: "OpenCode is not installed in WSL",
					},
				],
			},
		]);

		const response = await handle(
			new URL("http://localhost/acp/authenticate"),
			request("/acp/authenticate", "POST", {
				id: "opencode",
				cwd: wslWorkspace,
			}),
		);

		expect(response?.status).toBe(409);
		expect(await response?.json()).toEqual({
			error: "OpenCode is not installed in WSL",
		});
		expect(inspectAgent).not.toHaveBeenCalled();
	});

	it("rejects an unregistered workspace before launching an ACP process", async () => {
		const response = await handle(
			new URL("http://localhost/acp/models?id=opencode&cwd=%2Funregistered"),
			request("/acp/models?id=opencode&cwd=%2Funregistered"),
		);

		expect(response?.status).toBe(400);
		expect(await response?.json()).toEqual({
			error: "cwd must be an exact configured workspace path",
		});
		expect(inspectModels).not.toHaveBeenCalled();
	});

	it("lists bounded provider-native metadata for the exact configured workspace", async () => {
		loadConfig.mockReturnValue(
			HlidConfigSchema.parse({
				vault: { name: "Vault", path: "/vault" },
				acp_agents: [
					{
						id: "opencode",
						env: { TOKEN: "configured-secret" },
					},
				],
			}),
		);
		listSessions.mockResolvedValueOnce({
			sessions: [
				{
					sessionId: "native-1",
					title: "First native session",
					updatedAt: "2026-08-12T12:00:00.000Z",
				},
			],
			nextCursor: "provider-cursor",
		});

		const query = new URLSearchParams({
			id: "opencode",
			cursor: "page-1",
			cwd: "/vault",
		});
		const response = await handle(
			new URL(`http://localhost/acp/sessions?${query}`),
			request(`/acp/sessions?${query}`),
		);

		expect(response?.status).toBe(200);
		expect(catalog).toHaveBeenCalledWith(
			loadConfig.mock.results[0]?.value,
			false,
			false,
			{ agentIds: ["opencode"] },
		);
		expect(listSessions).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "acp:opencode",
				env: {
					BASE: "registry",
					TARGET_SECRET: "redacted",
					TOKEN: "configured-secret",
				},
				discoveryCwd: "/vault",
			}),
			"/vault",
			"page-1",
		);
		expect(await response?.json()).toEqual({
			sessions: [
				{
					sessionId: "native-1",
					title: "First native session",
					updatedAt: "2026-08-12T12:00:00.000Z",
				},
			],
			nextCursor: "provider-cursor",
		});
	});

	it("lists provider sessions through the exact WSL runtime for a WSL workspace", async () => {
		const config = HlidConfigSchema.parse({
			vault: { name: "Vault", path: "C:\\Users\\kyle\\Vault" },
			agents: [{ path: wslWorkspace }],
			acp_agents: [{ id: "opencode" }],
		});
		loadConfig.mockReturnValue(config);
		catalog.mockResolvedValueOnce([
			{
				...enabledAgent,
				targets: [hostTarget, wslTarget],
			},
		]);
		const query = new URLSearchParams({ id: "opencode", cwd: wslWorkspace });

		const response = await handle(
			new URL(`http://localhost/acp/sessions?${query}`),
			request(`/acp/sessions?${query}`),
		);

		expect(response?.status).toBe(200);
		expect(listSessions).toHaveBeenCalledWith(
			expect.objectContaining({
				command: "/opt/hlid/opencode",
				target: wslTargetDescriptor,
				env: { BASE: "wsl-registry", RUNTIME_TARGET: "wsl" },
				discoveryCwd: wslWorkspace,
			}),
			wslWorkspace,
			undefined,
		);
	});

	it("rejects invalid provider session list requests before inspection", async () => {
		expect(
			(
				await handle(
					new URL("http://localhost/acp/sessions"),
					request("/acp/sessions"),
				)
			)?.status,
		).toBe(400);
		expect(
			(
				await handle(
					new URL("http://localhost/acp/sessions?id=opencode&cursor="),
					request("/acp/sessions?id=opencode&cursor="),
				)
			)?.status,
		).toBe(400);
		expect(listSessions).not.toHaveBeenCalled();
	});

	it("reports unsupported provider session listing without leaking diagnostics", async () => {
		listSessions.mockRejectedValueOnce(new AcpSessionListUnsupportedError());
		const unsupported = await handle(
			new URL("http://localhost/acp/sessions?id=opencode"),
			request("/acp/sessions?id=opencode"),
		);
		expect(unsupported?.status).toBe(409);
		expect(await unsupported?.json()).toEqual({
			error: "The ACP agent does not advertise provider session listing",
		});

		listSessions.mockRejectedValueOnce(new Error("TOKEN=secret"));
		const failed = await handle(
			new URL("http://localhost/acp/sessions?id=opencode"),
			request("/acp/sessions?id=opencode"),
		);
		expect(failed?.status).toBe(502);
		expect(JSON.stringify(await failed?.json())).not.toContain("secret");
		expect(logSessionListFailure).toHaveBeenCalledWith(
			"[acp] Provider session listing failed; provider diagnostics were redacted.",
		);
	});

	it("re-lists provider metadata before importing native continuity", async () => {
		loadConfig.mockReturnValue(
			HlidConfigSchema.parse({
				vault: { name: "Vault", path: "/vault" },
				acp_agents: [{ id: "opencode", env: { TOKEN: "configured-secret" } }],
			}),
		);
		findSession.mockResolvedValueOnce({
			sessionId: "native-2",
			title: "Canonical provider title",
			updatedAt: "2026-08-12T13:00:00.000Z",
		});

		const response = await handle(
			new URL("http://localhost/acp/sessions/import"),
			request("/acp/sessions/import", "POST", {
				id: "opencode",
				providerSessionId: "native-2",
				title: "untrusted title",
				cwd: "/vault",
			}),
		);

		expect(response?.status).toBe(200);
		expect(catalog.mock.calls[0]?.slice(1)).toEqual([
			false,
			true,
			{ agentIds: ["opencode"] },
		]);
		expect(syncRuntime).toHaveBeenCalledOnce();
		expect(catalog.mock.calls[1]?.slice(1)).toEqual([
			false,
			false,
			{ agentIds: ["opencode"] },
		]);
		expect(findSession).toHaveBeenCalledWith(
			expect.objectContaining({
				env: {
					BASE: "registry",
					TARGET_SECRET: "redacted",
					TOKEN: "configured-secret",
				},
			}),
			"/vault",
			"native-2",
		);
		expect(importSession).toHaveBeenCalledWith({
			agentId: "opencode",
			providerId: "acp:opencode",
			providerLabel: "OpenCode",
			providerSession: {
				sessionId: "native-2",
				title: "Canonical provider title",
				updatedAt: "2026-08-12T13:00:00.000Z",
			},
			cwd: "/vault",
			providerRuntimeIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(
			importSession.mock.calls[0]?.[0].providerRuntimeIdentity,
		).not.toContain("configured-secret");
		expect(importSession.mock.calls[0]?.[0].providerRuntimeIdentity).toBe(
			resolveAcpWorkspaceRuntime(
				enabledAgent,
				loadConfig.mock.results[0]?.value,
				"/vault",
			).sessionContinuityIdentity,
		);
		expect(await response?.json()).toEqual({
			sessionId: "hlid-session-1",
			created: true,
		});
	});

	it("imports native continuity with the exact WSL runtime identity", async () => {
		const windowsWorkspace = "C:\\Users\\kyle\\Vault";
		const config = HlidConfigSchema.parse({
			vault: { name: "Vault", path: windowsWorkspace },
			agents: [{ path: wslWorkspace }],
			acp_agents: [{ id: "opencode" }],
		});
		const mixedAgent = {
			...enabledAgent,
			targets: [hostTarget, wslTarget],
		};
		loadConfig.mockReturnValue(config);
		catalog.mockResolvedValue([mixedAgent]);

		const response = await handle(
			new URL("http://localhost/acp/sessions/import"),
			request("/acp/sessions/import", "POST", {
				id: "opencode",
				providerSessionId: "provider-session-1",
				cwd: wslWorkspace,
			}),
		);

		expect(response?.status).toBe(200);
		expect(findSession).toHaveBeenCalledWith(
			expect.objectContaining({
				command: "/opt/hlid/opencode",
				target: wslTargetDescriptor,
			}),
			wslWorkspace,
			"provider-session-1",
		);
		const imported = importSession.mock.calls[0]?.[0];
		expect(imported).toMatchObject({ cwd: wslWorkspace });
		expect(imported.providerRuntimeIdentity).toBe(
			resolveAcpWorkspaceRuntime(mixedAgent, config, wslWorkspace)
				.sessionContinuityIdentity,
		);
		expect(imported.providerRuntimeIdentity).not.toBe(
			resolveAcpWorkspaceRuntime(mixedAgent, config, windowsWorkspace)
				.sessionContinuityIdentity,
		);
	});

	it("fails closed when a requested native session is no longer listed", async () => {
		findSession.mockResolvedValueOnce(undefined);
		const response = await handle(
			new URL("http://localhost/acp/sessions/import"),
			request("/acp/sessions/import", "POST", {
				id: "opencode",
				providerSessionId: "missing-native-session",
			}),
		);
		expect(response?.status).toBe(404);
		expect(importSession).not.toHaveBeenCalled();
	});

	it("keeps provider session import unavailable without a storage dependency", async () => {
		const withoutImport = createAcpRouteHandler({
			registry: { catalog },
			loadConfig,
			findSession,
		});
		const response = await withoutImport(
			new URL("http://localhost/acp/sessions/import"),
			request("/acp/sessions/import", "POST", {
				id: "opencode",
				providerSessionId: "native-1",
			}),
		);
		expect(response?.status).toBe(503);
		expect(await response?.json()).toEqual({
			error: "ACP provider session import is unavailable",
		});
		expect(findSession).not.toHaveBeenCalled();
	});

	it("lists the registry with an explicit refresh flag", async () => {
		catalog.mockResolvedValueOnce([
			{
				...enabledAgent,
				runtimeExecutableEvidence: {
					launcher: {
						pathKey: "native:/private/opencode",
						size: "123",
						mtimeNs: "456",
					},
				},
			},
		]);
		const response = await handle(
			new URL("http://localhost/acp/registry?refresh=1"),
			request("/acp/registry?refresh=1"),
		);

		expect(response?.status).toBe(200);
		expect(catalog).toHaveBeenCalledWith(
			loadConfig.mock.results[0]?.value,
			true,
			false,
			{},
		);
		expect(syncRuntime).toHaveBeenCalledWith({
			config: loadConfig.mock.results[0]?.value,
			catalog: [expect.objectContaining({ id: "opencode" })],
		});
		const body = (await response?.json()) as { agents: unknown[] };
		expect(body).toEqual({
			agents: [
				{
					...enabledAgent,
					env: {},
					targets: [publicHostTarget],
				},
			],
		});
		expect(body.agents[0]).not.toHaveProperty("runtimeExecutableEvidence");
	});

	it("starts a managed mutation only from server-resolved catalog data", async () => {
		const completion = Promise.resolve();
		const mutate = vi.fn(() => ({
			operation: {
				id: "operation-1",
				action: "install" as const,
				phase: "queued" as const,
				cancelable: true,
			},
			completion,
		}));
		const managedHandle = createAcpRouteHandler({
			registry: { catalog },
			loadConfig,
			managedInstaller: { mutate },
			managedMutationAuthorized: () => true,
		});
		const response = await managedHandle(
			new URL("http://localhost/acp/managed/mutate"),
			request("/acp/managed/mutate", "POST", {
				action: "install",
				agentId: "opencode",
				targetId: "host",
				revision: mutationRevision,
			}),
		);

		expect(response?.status).toBe(202);
		expect(catalog).toHaveBeenCalledWith(
			loadConfig.mock.results[0]?.value,
			false,
			false,
			{ agentIds: ["opencode"] },
		);
		expect(mutate).toHaveBeenCalledWith({
			action: "install",
			agent: enabledAgent,
			targetDescriptor: expect.objectContaining({
				targetId: "host",
				target: { kind: "host" },
			}),
			platformTarget: "linux-x86_64",
			enabled: true,
		});
		expect(await response?.json()).toEqual({
			ok: true,
			data: {
				id: "operation-1",
				action: "install",
				phase: "queued",
				cancelable: true,
			},
		});
	});

	it("updates an inactive managed target without switching the active runtime", async () => {
		const mutate = vi.fn(() => ({
			operation: {
				id: "operation-update-wsl",
				action: "update" as const,
				phase: "queued" as const,
				cancelable: true,
			},
			completion: Promise.resolve(),
		}));
		const managedHostTarget = {
			...hostTarget,
			selected: false,
			provenance: "managed" as const,
			canInstall: false,
			canUpdate: true,
			canRemove: true,
			installedVersion: "0.9.0",
		};
		const dualTargetAgent = {
			...enabledAgent,
			targets: [managedHostTarget, { ...wslTarget, selected: true }],
		};
		const stableConfig = HlidConfigSchema.parse({
			vault: { path: "/workspace" },
			agents: [{ name: "WSL", path: wslWorkspace }],
			acp_agents: [{ id: "opencode", target: wslTargetDescriptor }],
		});
		loadConfig.mockReturnValue(stableConfig);
		catalog.mockResolvedValue([dualTargetAgent]);
		const managedHandle = createAcpRouteHandler({
			registry: { catalog },
			loadConfig,
			managedInstaller: { mutate },
			managedMutationAuthorized: () => true,
		});

		const response = await managedHandle(
			new URL("http://localhost/acp/managed/mutate"),
			request("/acp/managed/mutate", "POST", {
				action: "update",
				agentId: "opencode",
				targetId: "host",
				revision: mutationRevision,
			}),
		);

		expect(response?.status).toBe(202);
		expect(mutate).toHaveBeenCalledWith({
			action: "update",
			agent: dualTargetAgent,
			targetDescriptor: expect.objectContaining({
				targetId: "host",
				target: { kind: "host" },
			}),
			platformTarget: "linux-x86_64",
			enabled: false,
		});
		expect(stableConfig.acp_agents?.[0]?.target).toEqual(wslTargetDescriptor);
	});

	it.each([
		{
			action: "install" as const,
			target: {
				...hostTarget,
				selected: false,
				provenance: "missing" as const,
				available: false,
				canEnable: false,
				canInstall: true,
				canRemove: false,
				resolvedExecutable: undefined,
			},
		},
		{
			action: "remove" as const,
			target: {
				...hostTarget,
				selected: false,
				provenance: "managed" as const,
				canInstall: false,
				canRemove: true,
				installedVersion: "1.0.0",
			},
		},
	])("still rejects inactive-target $action", async ({ action, target }) => {
		const mutate = vi.fn();
		const activeWsl = { ...wslTarget, selected: true };
		loadConfig.mockReturnValue(
			HlidConfigSchema.parse({
				vault: { path: "/workspace" },
				agents: [{ name: "WSL", path: wslWorkspace }],
				acp_agents: [{ id: "opencode", target: wslTargetDescriptor }],
			}),
		);
		catalog.mockResolvedValue([
			{ ...enabledAgent, targets: [target, activeWsl] },
		]);
		const managedHandle = createAcpRouteHandler({
			registry: { catalog },
			loadConfig,
			managedInstaller: { mutate },
			managedMutationAuthorized: () => true,
		});

		const response = await managedHandle(
			new URL("http://localhost/acp/managed/mutate"),
			request("/acp/managed/mutate", "POST", {
				action,
				agentId: "opencode",
				targetId: "host",
				revision: mutationRevision,
			}),
		);

		expect(response?.status).toBe(409);
		expect(await response?.json()).toEqual({
			ok: false,
			error:
				"ACP configuration changed. Wait for the save to finish and confirm again.",
		});
		expect(mutate).not.toHaveBeenCalled();
	});

	it("limits update refreshes to configured harnesses", async () => {
		const response = await handle(
			new URL("http://localhost/acp/registry?refresh=1&configured=1"),
			request("/acp/registry?refresh=1&configured=1"),
		);

		expect(response?.status).toBe(200);
		expect(catalog).toHaveBeenCalledWith(
			loadConfig.mock.results[0]?.value,
			true,
			false,
			{ agentIds: ["opencode"] },
		);
	});

	it("removes a receipt-backed managed target after its workspace disappears", async () => {
		const mutate = vi.fn(() => ({
			operation: {
				id: "operation-remove",
				action: "remove" as const,
				phase: "queued" as const,
				cancelable: false,
			},
			completion: Promise.resolve(),
		}));
		const orphanAgent = {
			...enabledAgent,
			enabled: false,
			available: false,
			command: orphanTargetStatus.command,
			args: orphanTargetStatus.args,
			env: {},
			targets: [orphanTargetStatus, secondOrphanTargetStatus],
		};
		loadConfig.mockReturnValue(HlidConfigSchema.parse({}));
		catalog.mockResolvedValue([orphanAgent]);
		const managedHandle = createAcpRouteHandler({
			registry: { catalog },
			loadConfig,
			managedInstaller: {
				mutate,
				claimedTargets: () => [orphanClaim, secondOrphanClaim],
			},
			managedMutationAuthorized: () => true,
		});

		const response = await managedHandle(
			new URL("http://localhost/acp/managed/mutate"),
			request("/acp/managed/mutate", "POST", {
				action: "remove",
				agentId: "opencode",
				targetId: secondOrphanTargetId,
				revision: mutationRevision,
			}),
		);

		expect(response?.status).toBe(202);
		expect(mutate).toHaveBeenCalledWith({
			action: "remove",
			agent: orphanAgent,
			targetDescriptor: {
				targetId: secondOrphanTargetId,
				target: secondOrphanTarget,
				label: "WSL · Debian",
				cwd: secondOrphanClaim.hostCwd,
				recommended: false,
			},
			platformTarget: "linux-unknown",
			enabled: false,
		});
	});

	it.each([
		"install",
		"update",
	] as const)("does not allow %s through an orphaned managed-target claim", async (action) => {
		const mutate = vi.fn();
		loadConfig.mockReturnValue(HlidConfigSchema.parse({}));
		const managedHandle = createAcpRouteHandler({
			registry: { catalog },
			loadConfig,
			managedInstaller: {
				mutate,
				claimedTargets: () => [orphanClaim],
			},
			managedMutationAuthorized: () => true,
		});

		const response = await managedHandle(
			new URL("http://localhost/acp/managed/mutate"),
			request("/acp/managed/mutate", "POST", {
				action,
				agentId: "opencode",
				targetId: orphanTargetId,
				revision: mutationRevision,
			}),
		);

		expect(response?.status).toBe(404);
		expect(catalog).not.toHaveBeenCalled();
		expect(mutate).not.toHaveBeenCalled();
	});

	it("requires the internal managed-mutation authorization boundary", async () => {
		const mutate = vi.fn();
		const managedHandle = createAcpRouteHandler({
			registry: { catalog },
			loadConfig,
			managedInstaller: { mutate },
			managedMutationAuthorized: () => false,
		});
		const response = await managedHandle(
			new URL("http://localhost/acp/managed/mutate"),
			request("/acp/managed/mutate", "POST", {
				action: "install",
				agentId: "opencode",
				targetId: "host",
			}),
		);
		expect(response?.status).toBe(403);
		expect(mutate).not.toHaveBeenCalled();
	});

	it("requires reconfirmation when registry or install state changes", async () => {
		const mutate = vi.fn();
		const managedHandle = createAcpRouteHandler({
			registry: { catalog },
			loadConfig,
			managedInstaller: { mutate },
			managedMutationAuthorized: () => true,
		});
		const response = await managedHandle(
			new URL("http://localhost/acp/managed/mutate"),
			request("/acp/managed/mutate", "POST", {
				action: "install",
				agentId: "opencode",
				targetId: "host",
				revision: "b".repeat(64),
			}),
		);

		expect(response?.status).toBe(409);
		expect(mutate).not.toHaveBeenCalled();
	});

	it("rechecks configuration after asynchronous catalog resolution", async () => {
		const mutate = vi.fn();
		loadConfig
			.mockReturnValueOnce(
				HlidConfigSchema.parse({ acp_agents: [{ id: "opencode" }] }),
			)
			.mockReturnValueOnce(HlidConfigSchema.parse({ acp_agents: [] }));
		const managedHandle = createAcpRouteHandler({
			registry: { catalog },
			loadConfig,
			managedInstaller: { mutate },
			managedMutationAuthorized: () => true,
		});
		const response = await managedHandle(
			new URL("http://localhost/acp/managed/mutate"),
			request("/acp/managed/mutate", "POST", {
				action: "install",
				agentId: "opencode",
				targetId: "host",
				revision: mutationRevision,
			}),
		);

		expect(response?.status).toBe(409);
		expect(mutate).not.toHaveBeenCalled();
	});

	it("rejects a managed mutation when invocation overrides change during catalog resolution", async () => {
		const mutate = vi.fn();
		loadConfig
			.mockReturnValueOnce(
				HlidConfigSchema.parse({ acp_agents: [{ id: "opencode" }] }),
			)
			.mockReturnValueOnce(
				HlidConfigSchema.parse({
					acp_agents: [
						{ id: "opencode", executable: "custom-opencode", args: ["serve"] },
					],
				}),
			);
		const managedHandle = createAcpRouteHandler({
			registry: { catalog },
			loadConfig,
			managedInstaller: { mutate },
			managedMutationAuthorized: () => true,
		});

		const response = await managedHandle(
			new URL("http://localhost/acp/managed/mutate"),
			request("/acp/managed/mutate", "POST", {
				action: "install",
				agentId: "opencode",
				targetId: "host",
				revision: mutationRevision,
			}),
		);

		expect(response?.status).toBe(409);
		expect(mutate).not.toHaveBeenCalled();
	});

	it("validates authentication requests before inspecting an agent", async () => {
		expect(
			(
				await handle(
					new URL("http://localhost/acp/authenticate"),
					request("/acp/authenticate", "POST", {}),
				)
			)?.status,
		).toBe(400);
		expect(inspectAgent).not.toHaveBeenCalled();
	});

	it("distinguishes disabled and unavailable agents", async () => {
		catalog.mockResolvedValueOnce([]);
		expect(
			(
				await handle(
					new URL("http://localhost/acp/authenticate"),
					request("/acp/authenticate", "POST", { id: "missing" }),
				)
			)?.status,
		).toBe(404);

		catalog.mockResolvedValueOnce([
			{
				...enabledAgent,
				available: false,
				unavailableReason: "not installed",
				targets: [
					{
						...hostTarget,
						available: false,
						blockedReason: "not installed",
					},
				],
			},
		]);
		expect(
			(
				await handle(
					new URL("http://localhost/acp/authenticate"),
					request("/acp/authenticate", "POST", { id: "opencode" }),
				)
			)?.status,
		).toBe(409);
	});

	it("uses one config snapshot and merges configured environment overrides", async () => {
		const response = await handle(
			new URL("http://localhost/acp/authenticate"),
			request("/acp/authenticate", "POST", {
				id: "opencode",
				methodId: "login",
			}),
		);

		expect(loadConfig).toHaveBeenCalledOnce();
		expect(catalog).toHaveBeenCalledWith(
			loadConfig.mock.results[0]?.value,
			false,
			false,
			{ agentIds: ["opencode"] },
		);
		expect(inspectAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "acp:opencode",
				env: {
					BASE: "configured",
					TARGET_SECRET: "redacted",
					TOKEN: "secret",
				},
			}),
			"login",
		);
		expect(await response?.json()).toEqual({
			authMethods: [{ id: "login", name: "Login" }],
			agentInfo: { name: "OpenCode", version: "1" },
			canListSessions: false,
			canImportSessions: false,
		});
	});

	it("reports provider-native session listing only when advertised", async () => {
		inspectAgent.mockResolvedValueOnce({
			authMethods: [],
			agentInfo: { name: "OpenCode", version: "1" },
			agentCapabilities: { sessionCapabilities: { list: {} } },
		});
		const response = await handle(
			new URL("http://localhost/acp/authenticate"),
			request("/acp/authenticate", "POST", { id: "opencode" }),
		);
		expect(await response?.json()).toMatchObject({ canListSessions: true });
	});

	it("reports list-only provider sessions as metadata-only", async () => {
		inspectAgent.mockResolvedValueOnce({
			authMethods: [],
			agentInfo: { name: "Metadata Agent", version: "1" },
			agentCapabilities: { sessionCapabilities: { list: {} } },
		});
		const inspected = await handle(
			new URL("http://localhost/acp/authenticate"),
			request("/acp/authenticate", "POST", { id: "opencode" }),
		);
		expect(await inspected?.json()).toMatchObject({
			canListSessions: true,
			canImportSessions: false,
		});

		findSession.mockRejectedValueOnce(new AcpSessionImportUnsupportedError());
		const imported = await handle(
			new URL("http://localhost/acp/sessions/import"),
			request("/acp/sessions/import", "POST", {
				id: "opencode",
				providerSessionId: "native-1",
			}),
		);
		expect(imported?.status).toBe(409);
		expect(await imported?.json()).toEqual({
			error:
				"The ACP agent can list provider sessions but cannot load or resume them",
		});
		expect(importSession).not.toHaveBeenCalled();
	});

	it("uses the effective OpenCode model filter during authentication", async () => {
		loadConfig.mockReturnValueOnce(
			HlidConfigSchema.parse({
				acp_agents: [
					{
						id: "opencode",
						env: {
							OPENCODE_CONFIG_CONTENT: '{"instructions":["existing.md"]}',
						},
						model_filter: {
							mode: "only",
							models: ["opencode/model-a"],
						},
					},
				],
			}),
		);

		const response = await handle(
			new URL("http://localhost/acp/authenticate"),
			request("/acp/authenticate", "POST", { id: "opencode" }),
		);

		expect(response?.status).toBe(200);
		const options = inspectAgent.mock.calls[0]?.[0];
		const content = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
		expect(content).toMatchObject({
			instructions: ["existing.md"],
			enabled_providers: ["opencode"],
			provider: { opencode: { whitelist: ["model-a"] } },
		});
	});

	it("reports an OpenCode overlay conflict without inspecting the agent", async () => {
		loadConfig.mockReturnValueOnce(
			HlidConfigSchema.parse({
				acp_agents: [
					{
						id: "opencode",
						env: { OPENCODE_CONFIG_CONTENT: "{" },
						model_filter: {
							mode: "hide",
							models: ["opencode/model-a"],
						},
					},
				],
			}),
		);

		const response = await handle(
			new URL("http://localhost/acp/authenticate"),
			request("/acp/authenticate", "POST", { id: "opencode" }),
		);

		expect(response?.status).toBe(409);
		expect(await response?.json()).toEqual({
			error: expect.stringContaining("OPENCODE_CONFIG_CONTENT is invalid"),
		});
		expect(inspectAgent).not.toHaveBeenCalled();
	});

	it("synchronizes enabled ACP providers without restarting Hlid", async () => {
		const response = await handle(
			new URL("http://localhost/acp/sync"),
			request("/acp/sync", "POST"),
		);

		expect(response?.status).toBe(200);
		expect(syncRuntime).toHaveBeenCalledOnce();
		expect(await response?.json()).toEqual({
			added: ["acp:opencode"],
			removed: [],
			replaced: [],
		});
	});

	it("returns an actionable conflict from runtime synchronization", async () => {
		syncRuntime.mockRejectedValueOnce(
			new OpenCodeConfigOverlayError("the inline filter conflicts"),
		);

		const response = await handle(
			new URL("http://localhost/acp/sync"),
			request("/acp/sync", "POST"),
		);

		expect(response?.status).toBe(409);
		expect(await response?.json()).toEqual({
			error:
				"Cannot apply Hlid's OpenCode configuration overlay: the inline filter conflicts",
		});
	});

	it("returns null for unrelated methods and paths", async () => {
		expect(
			await handle(
				new URL("http://localhost/acp/registry"),
				request("/acp/registry", "POST"),
			),
		).toBeNull();
		expect(
			await handle(new URL("http://localhost/other"), request("/other")),
		).toBeNull();
	});
});
