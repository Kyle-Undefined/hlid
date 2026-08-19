import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { HlidConfigSchema } from "#/config";
import type { AcpCatalogItem } from "./acpRegistry";
import { HLID_OLLAMA_RELAY_TOKEN_ENV } from "./acpRuntime";
import type { OllamaWslRelayProbeSpawner } from "./ollamaIntegration";
import {
	createOllamaWslRelayProbe,
	OllamaIntegration,
} from "./ollamaIntegration";
import {
	type OllamaLoadedModel,
	type OllamaLocalModel,
	OllamaManager,
	type OllamaModelDetails,
} from "./ollamaManager";
import type { OllamaWindowsFirewallStatus } from "./ollamaWindowsFirewall";
import type {
	OllamaWindowsSetupController,
	OllamaWindowsSetupState,
} from "./ollamaWindowsSetup";

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function firewallStatus(
	overrides: Partial<OllamaWindowsFirewallStatus> = {},
): OllamaWindowsFirewallStatus {
	return {
		supported: true,
		installed: true,
		exact: true,
		ruleName: "Hlid-Ollama-WSL",
		port: 11435,
		...overrides,
	};
}

function exactFirewallResolver() {
	return vi.fn(async () => firewallStatus());
}

function fakeProbeChild() {
	const child = new EventEmitter();
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	const stdin = new EventEmitter() as EventEmitter & {
		end: ReturnType<typeof vi.fn>;
	};
	stdin.end = vi.fn();
	const kill = vi.fn(() => true);
	Object.assign(child, { stdout, stderr, stdin, kill });
	return {
		child: child as unknown as ReturnType<OllamaWslRelayProbeSpawner>,
		stdout,
		stderr,
		stdin,
		kill,
	};
}

function localModel(model: string): OllamaLocalModel {
	return {
		capabilities: ["completion", "tools"],
		details: {
			contextLength: 65_536,
			families: ["qwen3"],
			family: "qwen3",
			format: "gguf",
			parameterSize: "30B",
			parentModel: null,
			quantizationLevel: "Q4_K_M",
		},
		digest: "a".repeat(64),
		model,
		modifiedAt: "2026-08-18T00:00:00Z",
		name: model,
		size: 1,
	};
}

function loadedModel(model: string): OllamaLoadedModel {
	return {
		contextLength: 65_536,
		details: localModel(model).details,
		digest: "a".repeat(64),
		expiresAt: null,
		model,
		name: model,
		size: 1,
		sizeVram: 1,
	};
}

function manager(models: string[]): OllamaManager {
	const localModels = models.map(localModel);
	let loadedModels = models.map(loadedModel);
	return {
		baseUrl: "http://127.0.0.1:11434",
		getStatus: vi.fn(async () => ({
			available: true as const,
			checkedAt: Date.now(),
			version: "0.12.0",
		})),
		listLocalModels: vi.fn(async () => [...localModels]),
		listLoadedModels: vi.fn(async () => [...loadedModels]),
		createContextModel: vi.fn(async (model: string) => {
			if (!localModels.some((candidate) => candidate.model === model)) {
				localModels.push(localModel(model));
			}
		}),
		loadModel: vi.fn(async (model: string, options = {}) => {
			loadedModels = [loadedModel(model)];
			return {
				keepAlive: options.keepAlive ?? -1,
				model,
				...(options.numCtx === undefined ? {} : { numCtx: options.numCtx }),
			};
		}),
		pullModel: vi.fn(async (model: string) => ({
			completed: 1,
			completedAt: Date.now(),
			events: 1,
			model,
			total: 1,
		})),
		unloadModel: vi.fn(async (model: string) => {
			loadedModels = loadedModels.filter(
				(candidate) => candidate.model !== model && candidate.name !== model,
			);
			return { keepAlive: 0, model };
		}),
		deleteModel: vi.fn(async () => {}),
		showModel: vi.fn(
			async (model: string): Promise<OllamaModelDetails> => ({
				capabilities: ["completion", "tools"],
				contextLength: 65_536,
				details: localModel(model).details,
				model,
				modifiedAt: "2026-08-18T00:00:00Z",
				requires: null,
			}),
		),
	} as unknown as OllamaManager;
}

function setupController(initial: OllamaWindowsSetupState = { phase: "idle" }) {
	let state = initial;
	const controller: OllamaWindowsSetupController = {
		status: vi.fn(() => ({ ...state })),
		startDownload: vi.fn(() => {
			state = { phase: "resolving", startedAt: 100 };
			return { ...state };
		}),
		cancelDownload: vi.fn(async () => {
			state = { phase: "canceled", startedAt: 100, completedAt: 200 };
			return { ...state };
		}),
		launch: vi.fn(async () => {
			state = {
				phase: "launched",
				startedAt: 100,
				launchedAt: 200,
				version: "0.32.14",
				bytes: 1,
			};
			return { ...state };
		}),
		markDetected: vi.fn(async (version) => {
			if (state.phase !== "idle") {
				state = { phase: "complete", version, detectedAt: 300 };
			}
			return { ...state };
		}),
		close: vi.fn(async () => {}),
	};
	return controller;
}

function config(models: string[], keepWarm: "5m" | "30m" | "session" = "5m") {
	return HlidConfigSchema.parse({
		vault: { name: "Vault", path: "C:\\Vault" },
		ollama: { models, keep_warm: keepWarm },
		acp_agents: [{ id: "opencode" }],
	});
}

const item: AcpCatalogItem = {
	id: "opencode",
	name: "OpenCode",
	version: "1.18.18",
	description: "OpenCode ACP",
	distribution: {},
	providerId: "acp:opencode",
	enabled: true,
	available: true,
	command: "opencode",
	args: ["acp"],
	env: {},
	installGuidance: "Install OpenCode",
	targets: [],
};

describe("production WSL Ollama relay probe", () => {
	it("uses fixed argv for the exact distro and sends the capability only over stdin", async () => {
		const process = fakeProbeChild();
		const spawnProcess = vi.fn(() => process.child);
		const probe = createOllamaWslRelayProbe({
			spawnProcess: spawnProcess as unknown as OllamaWslRelayProbeSpawner,
			timeoutMs: 100,
		});
		const token = "a".repeat(43);
		const controller = new AbortController();
		const pending = probe({
			distro: "Ubuntu-24.04",
			url: "http://172.29.176.1:11435/v1/models",
			token,
			signal: controller.signal,
		});

		expect(spawnProcess).toHaveBeenCalledWith(
			"wsl.exe",
			[
				"-d",
				"Ubuntu-24.04",
				"--exec",
				"/usr/bin/curl",
				"--silent",
				"--show-error",
				"--connect-timeout",
				"3",
				"--max-time",
				"5",
				"--header",
				"@-",
				"--output",
				"/dev/null",
				"--write-out",
				"%{http_code}",
				"http://172.29.176.1:11435/v1/models",
			],
			{
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
				shell: false,
			},
		);
		const spawnArgs = (
			spawnProcess.mock.calls[0] as unknown as [string, string[]]
		)[1];
		expect(JSON.stringify(spawnArgs)).not.toContain(token);
		expect(process.stdin.end).toHaveBeenCalledWith(
			`Authorization: Bearer ${token}\nAccept: application/json\n`,
		);

		process.stdout.emit("data", Buffer.from("200"));
		process.child.emit("close", 0);
		await pending;
		controller.abort();
		expect(process.kill).not.toHaveBeenCalled();
		expect(process.child.listenerCount("close")).toBe(0);
		expect(process.stdout.listenerCount("data")).toBe(0);
	});

	it("rejects unsafe probe inputs before spawning", async () => {
		const spawnProcess = vi.fn();
		const probe = createOllamaWslRelayProbe({
			spawnProcess: spawnProcess as unknown as OllamaWslRelayProbeSpawner,
		});
		for (const input of [
			{
				distro: "Ubuntu; whoami",
				url: "http://172.29.176.1:11435/v1/models",
				token: "a".repeat(43),
			},
			{
				distro: "Ubuntu",
				url: "http://user:password@172.29.176.1:11435/v1/models",
				token: "a".repeat(43),
			},
			{
				distro: "Ubuntu",
				url: "http://172.29.176.1:11435/v1/models",
				token: `valid${"a".repeat(38)}\nInjected: yes`,
			},
		]) {
			await expect(probe(input)).rejects.toThrow("probe target is invalid");
		}
		expect(spawnProcess).not.toHaveBeenCalled();
	});

	it("kills and cleans up the bounded child on timeout", async () => {
		const process = fakeProbeChild();
		const probe = createOllamaWslRelayProbe({
			spawnProcess: vi.fn(
				() => process.child,
			) as unknown as OllamaWslRelayProbeSpawner,
			timeoutMs: 5,
		});
		await expect(
			probe({
				distro: "Ubuntu",
				url: "http://172.29.176.1:11435/v1/models",
				token: "a".repeat(43),
			}),
		).rejects.toThrow("probe timed out");
		expect(process.kill).toHaveBeenCalledOnce();
		expect(process.child.listenerCount("close")).toBe(0);
		expect(process.stdin.listenerCount("error")).toBe(0);
	});

	it("kills and cleans up the child on cancellation and process errors", async () => {
		const canceled = fakeProbeChild();
		const controller = new AbortController();
		const canceledProbe = createOllamaWslRelayProbe({
			spawnProcess: vi.fn(
				() => canceled.child,
			) as unknown as OllamaWslRelayProbeSpawner,
		});
		const canceledResult = expect(
			canceledProbe({
				distro: "Ubuntu",
				url: "http://172.29.176.1:11435/v1/models",
				token: "a".repeat(43),
				signal: controller.signal,
			}),
		).rejects.toThrow("probe was canceled");
		controller.abort();
		await canceledResult;
		expect(canceled.kill).toHaveBeenCalledOnce();
		expect(canceled.child.listenerCount("error")).toBe(0);

		const failed = fakeProbeChild();
		const failedProbe = createOllamaWslRelayProbe({
			spawnProcess: vi.fn(
				() => failed.child,
			) as unknown as OllamaWslRelayProbeSpawner,
		});
		const failedResult = expect(
			failedProbe({
				distro: "Ubuntu",
				url: "http://172.29.176.1:11435/v1/models",
				token: "b".repeat(43),
			}),
		).rejects.toThrow("could not start");
		failed.child.emit("error", new Error("must-not-leak"));
		await failedResult;
		expect(failed.kill).toHaveBeenCalledOnce();
		expect(failed.child.listenerCount("close")).toBe(0);
	});
});

describe("Ollama OpenCode integration", () => {
	it("reports setup state and marks a launched installer detected", async () => {
		const setup = setupController({
			phase: "launched",
			startedAt: 100,
			launchedAt: 200,
			version: "0.32.14",
			bytes: 1,
		});
		const integration = new OllamaIntegration({
			manager: manager([]),
			platform: "win32",
			setup,
			getWindowsFirewallStatus: exactFirewallResolver(),
		});

		const result = await integration.info(HlidConfigSchema.parse({}));

		expect(setup.markDetected).toHaveBeenCalledWith("0.12.0");
		expect(result.setup).toEqual({
			phase: "complete",
			version: "0.12.0",
			detectedAt: 300,
		});
	});

	it("owns download, cancellation, launch, and shutdown through the setup controller", async () => {
		const setup = setupController();
		const ollama = manager([]);
		vi.mocked(ollama.getStatus).mockResolvedValue({
			available: false,
			checkedAt: 1,
			reason: "unavailable",
			version: null,
		});
		const integration = new OllamaIntegration({
			manager: ollama,
			platform: "win32",
			setup,
		});

		expect(await integration.startWindowsSetupDownload()).toEqual({
			phase: "resolving",
			startedAt: 100,
		});
		expect(await integration.cancelWindowsSetupDownload()).toMatchObject({
			phase: "canceled",
		});
		expect(await integration.launchWindowsSetup()).toMatchObject({
			phase: "launched",
		});
		await integration.close();

		expect(setup.startDownload).toHaveBeenCalledOnce();
		expect(setup.cancelDownload).toHaveBeenCalledOnce();
		expect(setup.launch).toHaveBeenCalledOnce();
		expect(setup.close).toHaveBeenCalledOnce();
	});

	it("polls setup without repeating firewall or WSL discovery", async () => {
		const setup = setupController({ phase: "resolving", startedAt: 100 });
		const ollama = manager([]);
		vi.mocked(ollama.getStatus).mockResolvedValue({
			available: false,
			checkedAt: 1,
			reason: "unavailable",
			version: null,
		});
		const firewall = exactFirewallResolver();
		const resolveWslNetwork = vi.fn();
		const integration = new OllamaIntegration({
			manager: ollama,
			platform: "win32",
			setup,
			getWindowsFirewallStatus: firewall,
			resolveWslNetwork,
		});

		expect(await integration.windowsSetupInfo()).toEqual({
			status: {
				available: false,
				checkedAt: 1,
				reason: "unavailable",
				version: null,
			},
			setup: { phase: "resolving", startedAt: 100 },
		});
		expect(firewall).not.toHaveBeenCalled();
		expect(resolveWslNetwork).not.toHaveBeenCalled();
	});

	it("reports top-level selections without requiring OpenCode", async () => {
		const integration = new OllamaIntegration({
			manager: manager(["qwen3-coder:30b"]),
			platform: "win32",
			getWindowsFirewallStatus: exactFirewallResolver(),
		});
		const standalone = HlidConfigSchema.parse({
			ollama: { models: ["qwen3-coder:30b"] },
		});

		const result = await integration.info(standalone);

		expect(result.selectedModels).toEqual(["qwen3-coder:30b"]);
	});

	it("enriches the official minimal tags inventory while isolating show failures", async () => {
		const successfulModel = "qwen3-coder:30b";
		const unknownModel = "unknown-coder:7b";
		const showRequests: string[] = [];
		const ollama = new OllamaManager({
			fetch: vi.fn(async (input, init) => {
				const path = new URL(String(input)).pathname;
				if (path === "/api/version") {
					return jsonResponse({ version: "0.12.0" });
				}
				if (path === "/api/tags") {
					return jsonResponse({
						models: [
							{
								details: {
									families: ["qwen3"],
									family: "qwen3",
									format: "gguf",
									parameter_size: "30B",
									quantization_level: "Q4_K_M",
								},
								digest: "a".repeat(64),
								model: successfulModel,
								modified_at: "2026-08-18T00:00:00Z",
								name: successfulModel,
								size: 1,
							},
							{
								details: {
									families: ["unknown"],
									family: "unknown",
									format: "gguf",
									parameter_size: "7B",
									quantization_level: "Q4_K_M",
								},
								digest: "b".repeat(64),
								model: unknownModel,
								modified_at: "2026-08-18T00:00:00Z",
								name: unknownModel,
								size: 1,
							},
						],
					});
				}
				if (path === "/api/ps") {
					return jsonResponse({
						models: [
							{
								context_length: 32_768,
								details: { family: "qwen3" },
								digest: "a".repeat(64),
								expires_at: null,
								model: successfulModel,
								name: successfulModel,
								size: 1,
								size_vram: 1,
							},
						],
					});
				}
				if (path === "/api/show") {
					const model = String(
						(JSON.parse(String(init?.body)) as { model?: unknown }).model,
					);
					showRequests.push(model);
					if (model === unknownModel) {
						return jsonResponse({ error: "must not escape" }, 500);
					}
					return jsonResponse({
						capabilities: ["completion", "tools"],
						details: { family: "qwen3" },
						model_info: { "qwen3.context_length": 131_072 },
					});
				}
				return jsonResponse({}, 404);
			}),
		});
		const integration = new OllamaIntegration({
			manager: ollama,
			platform: "win32",
			getWindowsFirewallStatus: exactFirewallResolver(),
		});

		const result = await integration.info(HlidConfigSchema.parse({}));

		expect(showRequests).toEqual([successfulModel, unknownModel]);
		expect(result.models).toEqual([
			expect.objectContaining({
				capabilities: ["completion", "tools"],
				compatibilityInspection: expect.objectContaining({
					status: "verified",
				}),
				details: expect.objectContaining({ contextLength: 131_072 }),
				model: successfulModel,
			}),
			expect.objectContaining({
				capabilities: [],
				compatibilityInspection: {
					status: "unknown",
					reason: "inspection-failed",
				},
				details: expect.objectContaining({ contextLength: null }),
				model: unknownModel,
			}),
		]);
		expect(result.loadedModels).toEqual([
			expect.objectContaining({
				contextLength: 32_768,
				model: successfulModel,
			}),
		]);

		await integration.info(HlidConfigSchema.parse({}));
		expect(showRequests).toEqual([successfulModel, unknownModel]);
	});

	it("bounds concurrent model detail inspection", async () => {
		const modelNames = Array.from(
			{ length: 9 },
			(_, index) => `model-${index}`,
		);
		const ollama = manager(modelNames);
		vi.mocked(ollama.listLocalModels).mockResolvedValue(
			modelNames.map((model, index) => ({
				...localModel(model),
				digest: index.toString(16).padStart(64, "0"),
			})),
		);
		vi.mocked(ollama.listLoadedModels).mockResolvedValue([]);
		let active = 0;
		let maximumActive = 0;
		vi.mocked(ollama.showModel).mockImplementation(async (model) => {
			active += 1;
			maximumActive = Math.max(maximumActive, active);
			await Promise.resolve();
			active -= 1;
			return {
				capabilities: ["completion", "tools"],
				contextLength: 65_536,
				details: localModel(model).details,
				model,
				modifiedAt: null,
				requires: null,
			};
		});
		const integration = new OllamaIntegration({
			manager: ollama,
			platform: "win32",
			getWindowsFirewallStatus: exactFirewallResolver(),
		});

		const result = await integration.info(HlidConfigSchema.parse({}));

		expect(ollama.showModel).toHaveBeenCalledTimes(modelNames.length);
		expect(maximumActive).toBe(4);
		expect(result.models).toHaveLength(modelNames.length);
	});

	it("shares successful compatibility evidence across aliases with one digest", async () => {
		const ollama = manager(["first:latest", "second:latest"]);
		vi.mocked(ollama.listLoadedModels).mockResolvedValue([]);
		const integration = new OllamaIntegration({
			manager: ollama,
			platform: "win32",
			getWindowsFirewallStatus: exactFirewallResolver(),
		});

		const first = await integration.info(HlidConfigSchema.parse({}));
		const second = await integration.info(HlidConfigSchema.parse({}));

		expect(ollama.showModel).toHaveBeenCalledOnce();
		expect(
			[...first.models, ...second.models].every(
				(model) => model.compatibilityInspection.status === "verified",
			),
		).toBe(true);
	});

	it("returns at the inspection budget when show calls do not settle", async () => {
		const modelNames = Array.from(
			{ length: 8 },
			(_, index) => `stalled-${index}`,
		);
		const ollama = manager(modelNames);
		vi.mocked(ollama.listLocalModels).mockResolvedValue(
			modelNames.map((model, index) => ({
				...localModel(model),
				digest: index.toString(16).padStart(64, "0"),
			})),
		);
		vi.mocked(ollama.listLoadedModels).mockResolvedValue([]);
		vi.mocked(ollama.showModel).mockImplementation(
			() => new Promise<OllamaModelDetails>(() => {}),
		);
		const integration = new OllamaIntegration({
			manager: ollama,
			platform: "win32",
			inventoryInspectionBudgetMs: 5,
			getWindowsFirewallStatus: exactFirewallResolver(),
		});

		const result = await integration.info(HlidConfigSchema.parse({}));

		expect(ollama.showModel).toHaveBeenCalledTimes(4);
		expect(result.models).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					compatibilityInspection: {
						status: "unknown",
						reason: "inspection-failed",
					},
				}),
			]),
		);

		const second = await integration.info(HlidConfigSchema.parse({}));
		expect(ollama.showModel).toHaveBeenCalledTimes(modelNames.length);
		expect(
			second.models.every(
				(model) =>
					model.compatibilityInspection.status === "unknown" &&
					model.compatibilityInspection.reason === "inspection-failed",
			),
		).toBe(true);
	});

	it("prioritizes selected models and advances past failures on refresh", async () => {
		const modelNames = Array.from(
			{ length: 70 },
			(_, index) => `failing-${index}`,
		);
		const selectedModel = modelNames.at(-1);
		if (!selectedModel) throw new Error("missing selected model fixture");
		const ollama = manager(modelNames);
		vi.mocked(ollama.listLocalModels).mockResolvedValue(
			modelNames.map((model, index) => ({
				...localModel(model),
				digest: index.toString(16).padStart(64, "0"),
			})),
		);
		vi.mocked(ollama.listLoadedModels).mockResolvedValue([]);
		vi.mocked(ollama.showModel).mockRejectedValue(new Error("show failed"));
		const integration = new OllamaIntegration({
			manager: ollama,
			platform: "win32",
			getWindowsFirewallStatus: exactFirewallResolver(),
		});
		const configured = HlidConfigSchema.parse({
			ollama: { models: [selectedModel] },
		});

		await integration.info(configured);
		expect(ollama.showModel).toHaveBeenCalledTimes(64);
		expect(ollama.showModel).toHaveBeenNthCalledWith(
			1,
			selectedModel,
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);

		const second = await integration.info(configured);
		expect(ollama.showModel).toHaveBeenCalledTimes(modelNames.length);
		expect(
			second.models.every(
				(model) =>
					model.compatibilityInspection.status === "unknown" &&
					model.compatibilityInspection.reason === "inspection-failed",
			),
		).toBe(true);
	});

	it("keeps standalone top-level Ollama config out of unconfigured OpenCode", async () => {
		const ollama = manager(["qwen3-coder:30b"]);
		const integration = new OllamaIntegration({
			manager: ollama,
			platform: "win32",
		});
		const standalone = HlidConfigSchema.parse({
			ollama: { models: ["qwen3-coder:30b"] },
		});

		const receipt = await integration.resolveOpenCodeEnvironment({
			item,
			config: standalone,
			target: { kind: "host" },
			cwd: "C:\\Vault",
			environment: { KEEP: "yes" },
		});

		expect(receipt.environment).toEqual({ KEEP: "yes" });
		expect(ollama.listLocalModels).not.toHaveBeenCalled();
		await receipt.release();
	});

	it("uses an authenticated Windows loopback relay for a Windows OpenCode runtime", async () => {
		const ollama = manager(["qwen3-coder:30b"]);
		vi.mocked(ollama.listLoadedModels).mockResolvedValue([
			{ ...loadedModel("qwen3-coder:30b"), contextLength: 131_072 },
		]);
		const stop = vi.fn(async () => {});
		const serve = vi.fn((options: { port: number }) => ({
			port: options.port,
			stop,
		}));
		const integration = new OllamaIntegration({
			manager: ollama,
			platform: "win32",
			serve,
		});
		const receipt = await integration.resolveOpenCodeEnvironment({
			item,
			config: config(["qwen3-coder:30b"]),
			target: { kind: "host" },
			cwd: "C:\\Vault",
			environment: { KEEP: "yes" },
		});
		const environment = receipt.environment;
		const content = JSON.parse(environment.OPENCODE_CONFIG_CONTENT);

		expect(environment.KEEP).toBe("yes");
		expect(environment[HLID_OLLAMA_RELAY_TOKEN_ENV]).toEqual(
			expect.any(String),
		);
		expect(serve).toHaveBeenCalledWith(
			expect.objectContaining({ hostname: "127.0.0.1", port: 11435 }),
		);
		expect(content.provider["hlid-ollama"].options).toEqual({
			baseURL: "http://127.0.0.1:11435/v1",
			apiKey: `{env:${HLID_OLLAMA_RELAY_TOKEN_ENV}}`,
		});
		expect(content.provider["hlid-ollama"].models["qwen3-coder:30b"]).toEqual({
			name: "qwen3-coder:30b",
			limit: { context: 65_536, output: 8_192 },
		});
		await receipt.release();
		expect(stop).toHaveBeenCalledOnce();
	});

	it("recovers host OpenCode on an ephemeral loopback port when 11435 remains occupied", async () => {
		const stop = vi.fn(async () => {});
		const serve = vi.fn((options: { port: number }) => {
			if (options.port === 11_435) {
				const error = new Error(
					"Failed to start server. Is port 11435 in use?",
				);
				Object.assign(error, { code: "EADDRINUSE" });
				throw error;
			}
			return { port: 43_123, stop };
		});
		const integration = new OllamaIntegration({
			manager: manager(["qwen3.5:4b"]),
			platform: "win32",
			serve,
		});

		const receipt = await integration.resolveOpenCodeEnvironment({
			item,
			config: config(["qwen3.5:4b"]),
			target: { kind: "host" },
			cwd: "C:\\Vault",
			environment: {},
		});
		const content = JSON.parse(receipt.environment.OPENCODE_CONFIG_CONTENT);

		expect(serve.mock.calls.map(([options]) => options.port)).toEqual([
			11_435, 0,
		]);
		expect(content.provider["hlid-ollama"].options.baseURL).toBe(
			"http://127.0.0.1:43123/v1",
		);
		expect(
			(await integration.info(config(["qwen3.5:4b"]))).relay.listeners,
		).toEqual([{ address: "127.0.0.1", port: 43_123 }]);

		await receipt.release();
		expect(stop).toHaveBeenCalledOnce();
	});

	it("does not bypass the fixed WSL NAT firewall port when 11435 is occupied", async () => {
		const serve = vi.fn((options: { port: number }) => {
			const error = new Error(
				`Failed to start server. Is port ${options.port} in use?`,
			);
			Object.assign(error, { code: "EADDRINUSE" });
			throw error;
		});
		const integration = new OllamaIntegration({
			manager: manager(["qwen3.5:4b"]),
			platform: "win32",
			getWindowsFirewallStatus: exactFirewallResolver(),
			resolveWslNetwork: vi.fn(async (distro) => ({
				ready: true as const,
				distro,
				mode: "nat" as const,
				windowsHostAddress: "172.29.176.1",
				addressSource: "default_ipv4_gateway" as const,
			})),
			serve,
		});

		await expect(
			integration.resolveOpenCodeEnvironment({
				item,
				config: config(["qwen3.5:4b"]),
				target: { kind: "wsl", distro: "Ubuntu-24.04" },
				cwd: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\repo",
				environment: {},
			}),
		).rejects.toThrow("port 11435 in use");
		expect(serve).toHaveBeenCalledOnce();
		expect(serve.mock.calls[0]?.[0].port).toBe(11_435);
	});

	it("discovers selected models without loading them and prepares only the requested chat model", async () => {
		const modelNames = ["qwen3-coder:30b", "second:latest"];
		const ollama = manager(modelNames);
		let loadedModels: OllamaLoadedModel[] = [];
		vi.mocked(ollama.listLoadedModels).mockImplementation(
			async () => loadedModels,
		);
		vi.mocked(ollama.loadModel).mockImplementation(
			async (model, options = {}) => {
				loadedModels = [loadedModel(model)];
				return {
					keepAlive: options.keepAlive ?? -1,
					model,
					...(options.numCtx === undefined ? {} : { numCtx: options.numCtx }),
				};
			},
		);
		const upstreamFetch = vi.fn(async (url: string, _init: RequestInit) =>
			url.endsWith("/v1/models")
				? jsonResponse({
						object: "list",
						data: modelNames.map((id) => ({ id, object: "model" })),
					})
				: jsonResponse({ choices: [], id: "chatcmpl-local" }),
		);
		let relayFetch: ((request: Request) => Promise<Response>) | undefined;
		const integration = new OllamaIntegration({
			manager: ollama,
			platform: "win32",
			upstreamFetch,
			serve: (options) => {
				relayFetch = options.fetch;
				return { port: options.port, stop: vi.fn(async () => {}) };
			},
		});
		const receipt = await integration.resolveOpenCodeEnvironment({
			item,
			config: config(modelNames),
			target: { kind: "host" },
			cwd: "C:\\Vault",
			environment: {},
		});
		const token = receipt.environment[HLID_OLLAMA_RELAY_TOKEN_ENV];
		vi.mocked(ollama.showModel).mockClear();

		const discovery = await relayFetch?.(
			new Request("http://127.0.0.1:11435/v1/models", {
				headers: { authorization: `Bearer ${token}` },
			}),
		);
		expect(discovery?.status).toBe(200);
		expect(ollama.loadModel).not.toHaveBeenCalled();
		expect(ollama.showModel).not.toHaveBeenCalled();

		const chat = await relayFetch?.(
			new Request("http://127.0.0.1:11435/v1/chat/completions", {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ messages: [], model: "second:latest" }),
			}),
		);
		expect(chat?.status).toBe(200);
		expect(await chat?.json()).toEqual({ choices: [], id: "chatcmpl-local" });
		const variant = vi.mocked(ollama.createContextModel).mock.calls[0]?.[0];
		expect(variant).toMatch(/^hlid-opencode\/[a-f0-9]{64}:ctx65536$/);
		expect(ollama.createContextModel).toHaveBeenCalledWith(
			variant,
			"second:latest",
			65_536,
			{ signal: expect.any(AbortSignal) },
		);
		expect(ollama.loadModel).toHaveBeenCalledTimes(2);
		expect(ollama.loadModel).toHaveBeenNthCalledWith(1, variant, {
			keepAlive: "5m",
			signal: expect.any(AbortSignal),
		});
		expect(ollama.loadModel).toHaveBeenNthCalledWith(2, variant, {
			keepAlive: "5m",
		});
		expect(loadedModels).toEqual([loadedModel(variant ?? "")]);
		const chatCall = upstreamFetch.mock.calls.find(([url]) =>
			url.endsWith("/v1/chat/completions"),
		);
		expect(
			JSON.parse(new TextDecoder().decode(chatCall?.[1].body as ArrayBuffer)),
		).toEqual({ messages: [], model: variant });
		await receipt.release();
	});

	it("refreshes the configured 30-minute warm period after inference", async () => {
		const ollama = manager(["qwen3-coder:30b"]);
		let relayFetch: ((request: Request) => Promise<Response>) | undefined;
		const integration = new OllamaIntegration({
			manager: ollama,
			platform: "win32",
			upstreamFetch: vi.fn(async () =>
				jsonResponse({ choices: [], id: "chatcmpl-local" }),
			),
			serve: (options) => {
				relayFetch = options.fetch;
				return { port: options.port, stop: vi.fn(async () => {}) };
			},
		});
		const receipt = await integration.resolveOpenCodeEnvironment({
			item,
			config: config(["qwen3-coder:30b"], "30m"),
			target: { kind: "host" },
			cwd: "C:\\Vault",
			environment: {},
		});
		const token = receipt.environment[HLID_OLLAMA_RELAY_TOKEN_ENV];

		const response = await relayFetch?.(
			new Request("http://127.0.0.1:11435/v1/chat/completions", {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					messages: [],
					model: "qwen3-coder:30b",
				}),
			}),
		);
		expect(response?.status).toBe(200);
		await response?.json();

		await vi.waitFor(() => {
			expect(ollama.loadModel).toHaveBeenLastCalledWith(
				expect.stringMatching(/^hlid-opencode\//),
				{ keepAlive: "30m" },
			);
		});
		await receipt.release();
	});

	it("keeps a session-warm model loaded until the last using runtime stops", async () => {
		const ollama = manager(["qwen3-coder:30b"]);
		let relayFetch: ((request: Request) => Promise<Response>) | undefined;
		const integration = new OllamaIntegration({
			manager: ollama,
			platform: "win32",
			upstreamFetch: vi.fn(async () =>
				jsonResponse({ choices: [], id: "chatcmpl-local" }),
			),
			serve: (options) => {
				relayFetch = options.fetch;
				return { port: options.port, stop: vi.fn(async () => {}) };
			},
		});
		const input = {
			item,
			config: config(["qwen3-coder:30b"], "session"),
			target: { kind: "host" as const },
			cwd: "C:\\Vault",
			environment: {},
		};
		const first = await integration.resolveOpenCodeEnvironment(input);
		const second = await integration.resolveOpenCodeEnvironment(input);
		const useModel = async (token: string) => {
			const response = await relayFetch?.(
				new Request("http://127.0.0.1:11435/v1/chat/completions", {
					method: "POST",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						messages: [],
						model: "qwen3-coder:30b",
					}),
				}),
			);
			expect(response?.status).toBe(200);
			await response?.json();
		};

		await useModel(first.environment[HLID_OLLAMA_RELAY_TOKEN_ENV] ?? "");
		await useModel(second.environment[HLID_OLLAMA_RELAY_TOKEN_ENV] ?? "");
		await vi.waitFor(() => {
			expect(ollama.loadModel).toHaveBeenLastCalledWith(
				expect.stringMatching(/^hlid-opencode\//),
				{ keepAlive: -1 },
			);
		});

		await first.release();
		expect(ollama.unloadModel).not.toHaveBeenCalled();
		await second.release();
		expect(ollama.unloadModel).toHaveBeenCalledOnce();
		expect(ollama.unloadModel).toHaveBeenCalledWith(
			expect.stringMatching(/^hlid-opencode\//),
		);
	});

	it("keeps model validation and streamed inference in one context-safe lane", async () => {
		const modelNames = ["qwen3-coder:30b", "second:latest"];
		const ollama = manager(modelNames);
		let loadedModels = [loadedModel("qwen3-coder:30b")];
		vi.mocked(ollama.listLoadedModels).mockImplementation(
			async () => loadedModels,
		);
		vi.mocked(ollama.loadModel).mockImplementation(
			async (model, options = {}) => {
				loadedModels = [loadedModel(model)];
				return {
					keepAlive: options.keepAlive ?? -1,
					model,
					...(options.numCtx === undefined ? {} : { numCtx: options.numCtx }),
				};
			},
		);
		const upstreamFetch = vi.fn(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						pull: () => new Promise<void>(() => {}),
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
		);
		let relayFetch: ((request: Request) => Promise<Response>) | undefined;
		const integration = new OllamaIntegration({
			manager: ollama,
			platform: "win32",
			upstreamFetch,
			serve: (options) => {
				relayFetch = options.fetch;
				return { port: options.port, stop: vi.fn(async () => {}) };
			},
		});
		const receipt = await integration.resolveOpenCodeEnvironment({
			item,
			config: config(modelNames),
			target: { kind: "host" },
			cwd: "C:\\Vault",
			environment: {},
		});
		const token = receipt.environment[HLID_OLLAMA_RELAY_TOKEN_ENV];
		const chatRequest = (model: string) =>
			new Request("http://127.0.0.1:11435/v1/chat/completions", {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ messages: [], model }),
			});

		const first = await relayFetch?.(chatRequest("qwen3-coder:30b"));
		expect(first?.status).toBe(200);
		expect(ollama.loadModel).toHaveBeenCalledTimes(1);
		let competingSettled = false;
		const competingRead = relayFetch?.(chatRequest("second:latest")).then(
			(response) => {
				competingSettled = true;
				return response;
			},
		);
		await Promise.resolve();
		await Promise.resolve();
		expect(competingSettled).toBe(false);
		expect(ollama.loadModel).toHaveBeenCalledTimes(1);

		await first?.body?.cancel();
		const competing = await competingRead;
		expect(competing?.status).toBe(200);
		const secondVariant = vi.mocked(ollama.createContextModel).mock
			.calls[1]?.[0];
		expect(secondVariant).toMatch(/^hlid-opencode\/[a-f0-9]{64}:ctx65536$/);
		expect(ollama.loadModel).toHaveBeenCalledWith(secondVariant, {
			keepAlive: "5m",
			signal: expect.any(AbortSignal),
		});
		await competing?.body?.cancel();
		await receipt.release();
	});

	it("blocks manual load and unload while a managed OpenCode runtime is active", async () => {
		const model = "qwen3-coder:30b";
		const ollama = manager([model]);
		const integration = new OllamaIntegration({
			manager: ollama,
			platform: "win32",
			serve: (options) => ({
				port: options.port,
				stop: vi.fn(async () => {}),
			}),
		});
		const receipt = await integration.resolveOpenCodeEnvironment({
			item,
			config: config([model]),
			target: { kind: "host" },
			cwd: "C:\\Vault",
			environment: {},
		});

		await expect(integration.loadModel(model)).rejects.toThrow(
			"Stop the Hlid-managed OpenCode runtime",
		);
		await expect(integration.unloadModel(model)).rejects.toThrow(
			"Stop the Hlid-managed OpenCode runtime",
		);
		expect(ollama.loadModel).not.toHaveBeenCalled();
		expect(ollama.unloadModel).not.toHaveBeenCalled();
		await receipt.release();
	});

	it("proves exact WSL discovery with multiple selected models still unloaded", async () => {
		const modelNames = ["qwen3-coder:30b", "second:latest"];
		const ollama = manager(modelNames);
		vi.mocked(ollama.listLoadedModels).mockResolvedValue([]);
		const upstreamFetch = vi.fn(async () =>
			jsonResponse({
				object: "list",
				data: modelNames.map((id) => ({ id, object: "model" })),
			}),
		);
		let relayFetch: ((request: Request) => Promise<Response>) | undefined;
		const probeWslRelay = vi.fn(async ({ token, url }) => {
			const response = await relayFetch?.(
				new Request(url, {
					headers: { authorization: `Bearer ${token}` },
				}),
			);
			if (response?.status !== 200) {
				throw new Error(`Unexpected WSL relay status ${response?.status}.`);
			}
			await response.body?.cancel();
		});
		const integration = new OllamaIntegration({
			manager: ollama,
			platform: "win32",
			getWindowsFirewallStatus: exactFirewallResolver(),
			probeWslRelay,
			resolveWslNetwork: vi.fn(async (distro) => ({
				ready: true as const,
				distro,
				mode: "nat" as const,
				windowsHostAddress: "172.29.176.1",
				addressSource: "default_ipv4_gateway" as const,
			})),
			upstreamFetch,
			serve: (options) => {
				relayFetch = options.fetch;
				return { port: options.port, stop: vi.fn(async () => {}) };
			},
		});
		const receipt = await integration.resolveOpenCodeEnvironment({
			item,
			config: config(modelNames),
			target: { kind: "wsl", distro: "Ubuntu-24.04" },
			cwd: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\repo",
			environment: {
				hlid_ollama_relay_token: "caller-value-must-not-survive",
			},
		});

		expect(probeWslRelay).toHaveBeenCalledOnce();
		expect(ollama.loadModel).not.toHaveBeenCalled();
		expect(ollama.showModel).toHaveBeenCalledTimes(modelNames.length);
		expect(
			Object.keys(receipt.environment).filter(
				(name) =>
					name.toUpperCase() === HLID_OLLAMA_RELAY_TOKEN_ENV.toUpperCase(),
			),
		).toEqual([HLID_OLLAMA_RELAY_TOKEN_ENV]);
		expect(receipt.environment[HLID_OLLAMA_RELAY_TOKEN_ENV]).not.toBe(
			"caller-value-must-not-survive",
		);
		await receipt.release();
	});

	it("issues a unique launch receipt and proves the exact WSL distro can use it", async () => {
		const listeners: Array<{
			hostname: string;
			port: number;
			maxRequestBodySize: number;
			fetch: (request: Request) => Promise<Response>;
		}> = [];
		const stop = vi.fn(async () => {});
		const probeWslRelay = vi.fn(async () => {});
		const integration = new OllamaIntegration({
			manager: manager(["qwen3-coder:30b"]),
			platform: "win32",
			getWindowsFirewallStatus: exactFirewallResolver(),
			probeWslRelay,
			resolveWslNetwork: vi.fn(async (distro) => ({
				ready: true as const,
				distro,
				mode: "nat" as const,
				windowsHostAddress: "172.29.176.1",
				addressSource: "default_ipv4_gateway" as const,
			})),
			serve: (options) => {
				listeners.push(options);
				return { port: options.port, stop };
			},
		});
		const input = {
			item,
			config: config(["qwen3-coder:30b"]),
			target: { kind: "wsl" as const, distro: "Ubuntu-24.04" },
			cwd: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\repo",
			environment: { KEEP: "yes" },
		};
		const [first, second] = await Promise.all([
			integration.resolveOpenCodeEnvironment(input),
			integration.resolveOpenCodeEnvironment(input),
		]);
		const content = JSON.parse(first.environment.OPENCODE_CONFIG_CONTENT);

		expect(listeners).toHaveLength(1);
		expect(listeners[0]).toMatchObject({
			hostname: "172.29.176.1",
			port: 11435,
			maxRequestBodySize: 16 * 1024 * 1024,
		});
		const firstToken = first.environment[HLID_OLLAMA_RELAY_TOKEN_ENV];
		const secondToken = second.environment[HLID_OLLAMA_RELAY_TOKEN_ENV];
		expect(firstToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(secondToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(secondToken).not.toBe(firstToken);
		expect(content.provider["hlid-ollama"].options).toEqual({
			baseURL: "http://172.29.176.1:11435/v1",
			apiKey: `{env:${HLID_OLLAMA_RELAY_TOKEN_ENV}}`,
		});
		expect(first.environment.OPENCODE_CONFIG_CONTENT).not.toContain(firstToken);
		expect(probeWslRelay).toHaveBeenNthCalledWith(1, {
			distro: "Ubuntu-24.04",
			url: "http://172.29.176.1:11435/v1/models",
			token: firstToken,
			signal: undefined,
		});

		await first.release();
		const revoked = await listeners[0]?.fetch(
			new Request("http://172.29.176.1:11435/v1/models", {
				headers: { authorization: `Bearer ${firstToken}` },
			}),
		);
		expect(revoked?.status).toBe(401);
		expect(stop).not.toHaveBeenCalled();
		await second.release();
		expect(stop).toHaveBeenCalledOnce();
		await integration.close();
		expect(stop).toHaveBeenCalledOnce();
	});

	it.each([
		[
			"an absent rule",
			firewallStatus({ installed: false, exact: false }),
			"WSL NAT requires Hlid's exact inbound TCP 11435",
		],
		[
			"a broader nonexact rule",
			firewallStatus({
				exact: false,
				blockedReason: "The existing rule is broader than TCP 11435.",
			}),
			"broader than TCP 11435",
		],
		[
			"duplicate same-name rules",
			firewallStatus({
				exact: false,
				blockedReason: "The Hlid firewall rule inventory is duplicated.",
			}),
			"inventory is duplicated",
		],
		[
			"an inspection conflict",
			firewallStatus({
				installed: false,
				exact: false,
				blockedReason: "Hlid could not inspect the Windows WSL firewall rule.",
			}),
			"could not inspect",
		],
	] as const)("fails closed before binding a NAT relay with %s", async (_label, status, expected) => {
		const getWindowsFirewallStatus = vi.fn(async () => status);
		const serve = vi.fn();
		const probeWslRelay = vi.fn(async () => {});
		const integration = new OllamaIntegration({
			manager: manager(["qwen3-coder:30b"]),
			platform: "win32",
			getWindowsFirewallStatus,
			probeWslRelay,
			resolveWslNetwork: vi.fn(async (distro) => ({
				ready: true as const,
				distro,
				mode: "nat" as const,
				windowsHostAddress: "172.29.176.1",
				addressSource: "default_ipv4_gateway" as const,
			})),
			serve,
		});

		await expect(
			integration.resolveOpenCodeEnvironment({
				item,
				config: config(["qwen3-coder:30b"]),
				target: { kind: "wsl", distro: "Ubuntu-24.04" },
				cwd: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\repo",
				environment: {},
			}),
		).rejects.toThrow(expected);
		expect(getWindowsFirewallStatus).toHaveBeenCalledWith({
			platform: "win32",
		});
		expect(serve).not.toHaveBeenCalled();
		expect(probeWslRelay).not.toHaveBeenCalled();
	});

	it("keeps mirrored WSL loopback exempt from the Hyper-V firewall gate", async () => {
		const getWindowsFirewallStatus = vi.fn(async () =>
			firewallStatus({ installed: false, exact: false }),
		);
		const stop = vi.fn(async () => {});
		const serve = vi.fn((options) => ({ port: options.port, stop }));
		const integration = new OllamaIntegration({
			manager: manager(["qwen3-coder:30b"]),
			platform: "win32",
			getWindowsFirewallStatus,
			probeWslRelay: vi.fn(async () => {}),
			resolveWslNetwork: vi.fn(async (distro) => ({
				ready: true as const,
				distro,
				mode: "mirrored" as const,
				windowsHostAddress: "127.0.0.1",
				addressSource: "loopback" as const,
			})),
			serve,
		});

		const receipt = await integration.resolveOpenCodeEnvironment({
			item,
			config: config(["qwen3-coder:30b"]),
			target: { kind: "wsl", distro: "Ubuntu-24.04" },
			cwd: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\repo",
			environment: {},
		});

		expect(getWindowsFirewallStatus).not.toHaveBeenCalled();
		expect(serve).toHaveBeenCalledWith(
			expect.objectContaining({ hostname: "127.0.0.1", port: 11435 }),
		);
		await receipt.release();
		expect(stop).toHaveBeenCalledOnce();
	});

	it("fails closed when an allowed tag no longer has the verified local digest", async () => {
		const ollama = manager(["qwen3-coder:30b"]);
		let relayFetch: ((request: Request) => Promise<Response>) | undefined;
		const integration = new OllamaIntegration({
			manager: ollama,
			platform: "win32",
			getWindowsFirewallStatus: exactFirewallResolver(),
			probeWslRelay: vi.fn(async () => {}),
			resolveWslNetwork: vi.fn(async (distro) => ({
				ready: true as const,
				distro,
				mode: "nat" as const,
				windowsHostAddress: "172.29.176.1",
				addressSource: "default_ipv4_gateway" as const,
			})),
			serve: (options) => {
				relayFetch = options.fetch;
				return { port: options.port, stop: vi.fn(async () => {}) };
			},
		});
		const receipt = await integration.resolveOpenCodeEnvironment({
			item,
			config: config(["qwen3-coder:30b"]),
			target: { kind: "wsl", distro: "Ubuntu-24.04" },
			cwd: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\repo",
			environment: {},
		});
		vi.mocked(ollama.listLocalModels).mockResolvedValue([]);

		const response = await relayFetch?.(
			new Request("http://172.29.176.1:11435/v1/models", {
				headers: {
					authorization: `Bearer ${receipt.environment[HLID_OLLAMA_RELAY_TOKEN_ENV]}`,
				},
			}),
		);

		expect(response?.status).toBe(409);
		expect(await response?.json()).toEqual({
			error: "local_model_evidence_changed",
		});
		await receipt.release();
		await integration.close();
	});

	it("revokes the attempted child capability when the exact-distro probe fails", async () => {
		let relayFetch: ((request: Request) => Promise<Response>) | undefined;
		let attemptedToken = "";
		const stop = vi.fn(async () => {});
		const integration = new OllamaIntegration({
			manager: manager(["qwen3-coder:30b"]),
			platform: "win32",
			getWindowsFirewallStatus: exactFirewallResolver(),
			probeWslRelay: vi.fn(async ({ token }) => {
				attemptedToken = token;
				throw new Error("relay unreachable");
			}),
			resolveWslNetwork: vi.fn(async (distro) => ({
				ready: true as const,
				distro,
				mode: "nat" as const,
				windowsHostAddress: "172.29.176.1",
				addressSource: "default_ipv4_gateway" as const,
			})),
			serve: (options) => {
				relayFetch = options.fetch;
				return { port: options.port, stop };
			},
		});

		await expect(
			integration.resolveOpenCodeEnvironment({
				item,
				config: config(["qwen3-coder:30b"]),
				target: { kind: "wsl", distro: "Ubuntu-24.04" },
				cwd: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\repo",
				environment: {},
			}),
		).rejects.toThrow("relay unreachable");
		const response = await relayFetch?.(
			new Request("http://172.29.176.1:11435/v1/models", {
				headers: { authorization: `Bearer ${attemptedToken}` },
			}),
		);
		expect(response?.status).toBe(401);
		expect(stop).toHaveBeenCalledOnce();
		await integration.close();
		expect(stop).toHaveBeenCalledOnce();
	});

	it("closes a listener and revokes its token while the first spawn probe is pending", async () => {
		let finishProbe: () => void = () => {};
		let attemptedToken = "";
		let relayFetch: ((request: Request) => Promise<Response>) | undefined;
		const stop = vi.fn(async () => {});
		const probeWslRelay = vi.fn(
			({ token }: { token: string }) =>
				new Promise<void>((resolve) => {
					attemptedToken = token;
					finishProbe = resolve;
				}),
		);
		const integration = new OllamaIntegration({
			manager: manager(["qwen3-coder:30b"]),
			platform: "win32",
			getWindowsFirewallStatus: exactFirewallResolver(),
			probeWslRelay,
			resolveWslNetwork: vi.fn(async (distro) => ({
				ready: true as const,
				distro,
				mode: "nat" as const,
				windowsHostAddress: "172.29.176.1",
				addressSource: "default_ipv4_gateway" as const,
			})),
			serve: (options) => {
				relayFetch = options.fetch;
				return { port: options.port, stop };
			},
		});
		const pending = integration.resolveOpenCodeEnvironment({
			item,
			config: config(["qwen3-coder:30b"]),
			target: { kind: "wsl", distro: "Ubuntu-24.04" },
			cwd: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\repo",
			environment: {},
		});
		const rejected = expect(pending).rejects.toThrow("shutting down");
		await vi.waitFor(() => expect(probeWslRelay).toHaveBeenCalledOnce());

		await integration.close();
		finishProbe();
		await rejected;

		expect(stop).toHaveBeenCalledOnce();
		const response = await relayFetch?.(
			new Request("http://172.29.176.1:11435/v1/models", {
				headers: { authorization: `Bearer ${attemptedToken}` },
			}),
		);
		expect(response?.status).toBe(401);
	});

	it("fails closed when a configured model is not local on Windows", async () => {
		const integration = new OllamaIntegration({
			manager: manager([]),
			platform: "win32",
		});

		await expect(
			integration.resolveOpenCodeEnvironment({
				item,
				config: config(["missing:latest"]),
				target: { kind: "host" },
				cwd: "C:\\Vault",
				environment: {},
			}),
		).rejects.toThrow(
			'does not have the selected local model "missing:latest"',
		);
	});

	it("rejects a local model that cannot meet OpenCode's context floor", async () => {
		const small = manager(["small:latest"]);
		vi.mocked(small.showModel).mockResolvedValue({
			capabilities: ["completion", "tools"],
			contextLength: 32_768,
			details: localModel("small:latest").details,
			model: "small:latest",
			modifiedAt: null,
			requires: null,
		});
		const integration = new OllamaIntegration({
			manager: small,
			platform: "win32",
		});

		await expect(
			integration.resolveOpenCodeEnvironment({
				item,
				config: config(["small:latest"]),
				target: { kind: "host" },
				cwd: "C:\\Vault",
				environment: {},
			}),
		).rejects.toThrow("require at least 65,536");
	});

	it("requires tool calling before OpenCode starts", async () => {
		const noTools = manager(["qwen3-coder:30b"]);
		vi.mocked(noTools.showModel).mockResolvedValue({
			capabilities: ["completion"],
			contextLength: 65_536,
			details: localModel("qwen3-coder:30b").details,
			model: "qwen3-coder:30b",
			modifiedAt: null,
			requires: null,
		});
		const noToolsIntegration = new OllamaIntegration({
			manager: noTools,
			platform: "win32",
		});
		await expect(
			noToolsIntegration.resolveOpenCodeEnvironment({
				item,
				config: config(["qwen3-coder:30b"]),
				target: { kind: "host" },
				cwd: "C:\\Vault",
				environment: {},
			}),
		).rejects.toThrow("does not advertise tool calling");
	});

	it("does not require every selected model to be loaded at launch", async () => {
		const ollama = manager(["qwen3-coder:30b", "second:latest"]);
		vi.mocked(ollama.listLoadedModels).mockResolvedValue([]);
		const stop = vi.fn(async () => {});
		const integration = new OllamaIntegration({
			manager: ollama,
			platform: "win32",
			serve: (options) => ({ port: options.port, stop }),
		});

		const receipt = await integration.resolveOpenCodeEnvironment({
			item,
			config: config(["qwen3-coder:30b", "second:latest"]),
			target: { kind: "host" },
			cwd: "C:\\Vault",
			environment: {},
		});
		const content = JSON.parse(receipt.environment.OPENCODE_CONFIG_CONTENT);

		expect(Object.keys(content.provider["hlid-ollama"].models)).toEqual([
			"qwen3-coder:30b",
			"second:latest",
		]);
		expect(ollama.listLoadedModels).not.toHaveBeenCalled();
		await receipt.release();
		expect(stop).toHaveBeenCalledOnce();
	});

	it("loads with the OpenCode context floor and verifies the resulting process", async () => {
		const ollama = manager(["qwen3-coder:30b"]);
		const integration = new OllamaIntegration({
			manager: ollama,
			platform: "win32",
		});

		await integration.loadModel("qwen3-coder:30b");

		const variant = vi.mocked(ollama.createContextModel).mock.calls[0]?.[0];
		expect(variant).toMatch(/^hlid-opencode\/[a-f0-9]{64}:ctx65536$/);
		expect(ollama.createContextModel).toHaveBeenCalledWith(
			variant,
			"qwen3-coder:30b",
			65_536,
			{ signal: undefined },
		);
		expect(ollama.loadModel).toHaveBeenCalledWith(variant, {
			keepAlive: "5m",
			signal: undefined,
		});
		expect(ollama.listLoadedModels).toHaveBeenCalled();

		vi.mocked(ollama.listLoadedModels).mockResolvedValue([
			{ ...loadedModel(variant ?? ""), contextLength: 32_768 },
		]);
		await expect(integration.loadModel("qwen3-coder:30b")).rejects.toThrow(
			"actual allocation of at least 65,536",
		);
	});

	it("removes an obsolete fixed-context variant after its base tag changes", async () => {
		const model = "qwen3-coder:latest";
		const ollama = manager([model]);
		const integration = new OllamaIntegration({
			manager: ollama,
			platform: "win32",
		});
		await integration.loadModel(model);
		const variant = vi.mocked(ollama.createContextModel).mock.calls[0]?.[0];
		if (!variant) throw new Error("missing fixed-context variant");
		const oldVariant = localModel(variant);
		const updatedBase = { ...localModel(model), digest: "b".repeat(64) };
		vi.mocked(ollama.pullModel).mockImplementation(async () => {
			vi.mocked(ollama.listLocalModels).mockResolvedValue([
				updatedBase,
				oldVariant,
			]);
			return {
				completed: 1,
				completedAt: Date.now(),
				events: 1,
				model,
				total: 1,
			};
		});

		integration.startPull(model);
		await vi.waitFor(() => {
			expect(ollama.deleteModel).toHaveBeenCalledWith(variant);
		});

		expect(ollama.unloadModel).toHaveBeenCalledWith(variant);
	});

	it("serializes manual preparation against model pulls", async () => {
		const model = "qwen3-coder:30b";
		const ollama = manager([model]);
		let releaseDetails: (details: OllamaModelDetails) => void = () => {};
		vi.mocked(ollama.showModel).mockImplementationOnce(
			() =>
				new Promise<OllamaModelDetails>((resolve) => {
					releaseDetails = resolve;
				}),
		);
		const integration = new OllamaIntegration({
			manager: ollama,
			platform: "win32",
		});
		const pending = integration.loadModel(model);
		await vi.waitFor(() => expect(ollama.showModel).toHaveBeenCalledOnce());

		expect(() => integration.startPull(model)).toThrow(
			"model change to finish before pulling",
		);
		releaseDetails({
			capabilities: ["completion", "tools"],
			contextLength: 65_536,
			details: localModel(model).details,
			model,
			modifiedAt: "2026-08-18T00:00:00Z",
			requires: null,
		});
		await pending;
		expect(ollama.pullModel).not.toHaveBeenCalled();
	});

	it("keeps Hlid's fixed-context variants out of general inventory", async () => {
		const model = "qwen3-coder:30b";
		const ollama = manager([model]);
		const integration = new OllamaIntegration({
			manager: ollama,
			platform: "win32",
		});

		await integration.loadModel(model);
		const info = await integration.info(config([model]));

		expect(info.models.map((candidate) => candidate.model)).toEqual([model]);
		expect(info.loadedModels).toEqual([]);
		expect(info.preparedModels).toEqual([
			expect.objectContaining({
				contextLength: 65_536,
				digest: localModel(model).digest,
				model,
				name: model,
			}),
		]);
	});

	it("does not claim or delete a user model that only shares Hlid's prefix", async () => {
		const userModel = "hlid-opencode/user-model";
		const ollama = manager([userModel]);
		const integration = new OllamaIntegration({
			manager: ollama,
			platform: "win32",
		});
		const emptyConfig = HlidConfigSchema.parse({
			vault: { name: "Vault", path: "C:\\Vault" },
		});

		await integration.reconcileManagedVariants(emptyConfig);
		const info = await integration.info(emptyConfig);

		expect(info.models.map((candidate) => candidate.model)).toEqual([
			userModel,
		]);
		expect(ollama.deleteModel).not.toHaveBeenCalled();
	});

	it("removes a managed variant after its model is disconnected", async () => {
		const model = "qwen3-coder:30b";
		const ollama = manager([model]);
		const integration = new OllamaIntegration({
			manager: ollama,
			platform: "win32",
		});
		await integration.loadModel(model);
		const variant = vi.mocked(ollama.createContextModel).mock.calls[0]?.[0];
		if (!variant) throw new Error("missing fixed-context variant");

		await integration.reconcileManagedVariants(
			HlidConfigSchema.parse({
				vault: { name: "Vault", path: "C:\\Vault" },
			}),
		);

		expect(ollama.unloadModel).toHaveBeenCalledWith(variant);
		expect(ollama.deleteModel).toHaveBeenCalledWith(variant);
	});

	it("does not let a model pull overtake an OpenCode launch acquisition", async () => {
		const model = "qwen3-coder:30b";
		const ollama = manager([model]);
		let releaseInventory: (models: OllamaLocalModel[]) => void = () => {};
		vi.mocked(ollama.listLocalModels).mockImplementationOnce(
			() =>
				new Promise<OllamaLocalModel[]>((resolve) => {
					releaseInventory = resolve;
				}),
		);
		const integration = new OllamaIntegration({
			manager: ollama,
			platform: "win32",
			serve: (options) => ({
				port: options.port,
				stop: vi.fn(async () => {}),
			}),
		});
		const pending = integration.resolveOpenCodeEnvironment({
			item,
			config: config([model]),
			target: { kind: "host" },
			cwd: "C:\\Vault",
			environment: {},
		});
		await vi.waitFor(() => {
			expect(ollama.listLocalModels).toHaveBeenCalledOnce();
		});

		expect(() => integration.startPull(model)).toThrow(
			"finish starting before pulling",
		);
		expect(ollama.pullModel).not.toHaveBeenCalled();
		releaseInventory([localModel(model)]);
		const receipt = await pending;
		await receipt.release();
	});

	it("removes active WSL relay access with the Hlid firewall rule", async () => {
		const model = "qwen3-coder:30b";
		let relayFetch: ((request: Request) => Promise<Response>) | undefined;
		const stop = vi.fn(async () => {});
		const onOpenCodeRuntimeInvalidated = vi.fn(async () => {});
		const removeWindowsFirewallRule = vi.fn(async () =>
			firewallStatus({ installed: false, exact: false }),
		);
		const integration = new OllamaIntegration({
			manager: manager([model]),
			platform: "win32",
			getWindowsFirewallStatus: exactFirewallResolver(),
			onOpenCodeRuntimeInvalidated,
			probeWslRelay: vi.fn(async () => {}),
			removeWindowsFirewallRule,
			resolveWslNetwork: vi.fn(async (distro) => ({
				ready: true as const,
				distro,
				mode: "nat" as const,
				windowsHostAddress: "172.29.176.1",
				addressSource: "default_ipv4_gateway" as const,
			})),
			serve: (options) => {
				relayFetch = options.fetch;
				return { port: options.port, stop };
			},
		});
		const receipt = await integration.resolveOpenCodeEnvironment({
			item,
			config: config([model]),
			target: { kind: "wsl", distro: "Ubuntu-24.04" },
			cwd: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\repo",
			environment: {},
		});
		const token = receipt.environment[HLID_OLLAMA_RELAY_TOKEN_ENV];

		const status = await integration.removeWslFirewallRule();
		const revoked = await relayFetch?.(
			new Request("http://172.29.176.1:11435/v1/models", {
				headers: { authorization: `Bearer ${token}` },
			}),
		);

		expect(status).toMatchObject({ installed: false, exact: false });
		expect(removeWindowsFirewallRule).toHaveBeenCalledOnce();
		expect(revoked?.status).toBe(401);
		expect(stop).toHaveBeenCalledOnce();
		expect(onOpenCodeRuntimeInvalidated).toHaveBeenCalledOnce();
		await receipt.release();
	});

	it("does not let firewall removal be overtaken by a WSL launch acquisition", async () => {
		const model = "qwen3-coder:30b";
		const ollama = manager([model]);
		let releaseInventory: (models: OllamaLocalModel[]) => void = () => {};
		vi.mocked(ollama.listLocalModels).mockImplementationOnce(
			() =>
				new Promise<OllamaLocalModel[]>((resolve) => {
					releaseInventory = resolve;
				}),
		);
		const serve = vi.fn(() => ({
			port: 11435,
			stop: vi.fn(async () => {}),
		}));
		const integration = new OllamaIntegration({
			manager: ollama,
			platform: "win32",
			getWindowsFirewallStatus: exactFirewallResolver(),
			probeWslRelay: vi.fn(async () => {}),
			removeWindowsFirewallRule: vi.fn(async () =>
				firewallStatus({ installed: false, exact: false }),
			),
			resolveWslNetwork: vi.fn(async (distro) => ({
				ready: true as const,
				distro,
				mode: "nat" as const,
				windowsHostAddress: "172.29.176.1",
				addressSource: "default_ipv4_gateway" as const,
			})),
			serve,
		});
		const pending = integration.resolveOpenCodeEnvironment({
			item,
			config: config([model]),
			target: { kind: "wsl", distro: "Ubuntu-24.04" },
			cwd: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\repo",
			environment: {},
		});
		const rejected = expect(pending).rejects.toThrow(
			"WSL Ollama access changed",
		);
		await vi.waitFor(() => {
			expect(ollama.listLocalModels).toHaveBeenCalledOnce();
		});

		await integration.removeWslFirewallRule();
		releaseInventory([localModel(model)]);
		await rejected;
		expect(serve).not.toHaveBeenCalled();
	});

	it("rejects a WSL receipt when firewall removal begins during acquisition cleanup", async () => {
		const model = "qwen3-coder:30b";
		let releaseProbe: () => void = () => {};
		const probeWslRelay = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					releaseProbe = resolve;
				}),
		);
		const stop = vi.fn(async () => {});
		const integration = new OllamaIntegration({
			manager: manager([model]),
			platform: "win32",
			getWindowsFirewallStatus: exactFirewallResolver(),
			probeWslRelay,
			removeWindowsFirewallRule: vi.fn(async () =>
				firewallStatus({ installed: false, exact: false }),
			),
			resolveWslNetwork: vi.fn(async (distro) => ({
				ready: true as const,
				distro,
				mode: "nat" as const,
				windowsHostAddress: "172.29.176.1",
				addressSource: "default_ipv4_gateway" as const,
			})),
			serve: (options) => ({ port: options.port, stop }),
		});
		const pending = integration.resolveOpenCodeEnvironment({
			item,
			config: config([model]),
			target: { kind: "wsl", distro: "Ubuntu-24.04" },
			cwd: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\repo",
			environment: {},
		});
		const rejected = expect(pending).rejects.toThrow(
			"WSL Ollama access changed",
		);
		await vi.waitFor(() => {
			expect(probeWslRelay).toHaveBeenCalledOnce();
		});

		releaseProbe();
		const removal = Promise.resolve().then(() =>
			integration.removeWslFirewallRule(),
		);
		await rejected;
		await removal;
		expect(stop).toHaveBeenCalledOnce();
	});

	it("retires active OpenCode relay receipts when a shorthand pull changes a selected tag", async () => {
		const model = "qwen3-coder:latest";
		const pullName = "qwen3-coder";
		const ollama = manager([model]);
		const updated = { ...localModel(model), digest: "b".repeat(64) };
		vi.mocked(ollama.pullModel).mockImplementation(async () => {
			vi.mocked(ollama.listLocalModels).mockResolvedValue([updated]);
			return {
				completed: 1,
				completedAt: Date.now(),
				events: 1,
				model,
				total: 1,
			};
		});
		const onOpenCodeRuntimeInvalidated = vi.fn(async () => {});
		const relayFetches: Array<(request: Request) => Promise<Response>> = [];
		const integration = new OllamaIntegration({
			manager: ollama,
			platform: "win32",
			onOpenCodeRuntimeInvalidated,
			upstreamFetch: async () => jsonResponse({ data: [] }),
			serve: (options) => {
				relayFetches.push(options.fetch);
				return { port: options.port, stop: vi.fn(async () => {}) };
			},
		});
		const first = await integration.resolveOpenCodeEnvironment({
			item,
			config: config([model]),
			target: { kind: "host" },
			cwd: "C:\\Vault",
			environment: {},
		});
		const firstToken = first.environment[HLID_OLLAMA_RELAY_TOKEN_ENV];
		const firstRelay = relayFetches[0];

		integration.startPull(pullName);
		await vi.waitFor(() => {
			expect(onOpenCodeRuntimeInvalidated).toHaveBeenCalledOnce();
		});

		const revoked = await firstRelay?.(
			new Request("http://127.0.0.1:11435/v1/models", {
				headers: { authorization: `Bearer ${firstToken}` },
			}),
		);
		expect(revoked?.status).toBe(401);

		const second = await integration.resolveOpenCodeEnvironment({
			item,
			config: config([model]),
			target: { kind: "host" },
			cwd: "C:\\Vault",
			environment: {},
		});
		expect(second.environment[HLID_OLLAMA_RELAY_TOKEN_ENV]).not.toBe(
			firstToken,
		);
		await second.release();
	});

	it("rejects model mutations outside the Windows host boundary", async () => {
		const integration = new OllamaIntegration({
			manager: manager([]),
			platform: "linux",
		});

		await expect(integration.loadModel("qwen3:8b")).rejects.toThrow(
			"requires Windows",
		);
		await expect(integration.unloadModel("qwen3:8b")).rejects.toThrow(
			"requires Windows",
		);
		await expect(
			integration.deleteModel(
				"qwen3:8b",
				HlidConfigSchema.parse({ vault: { name: "Vault", path: "C:\\Vault" } }),
			),
		).rejects.toThrow("requires Windows");
	});

	it("blocks deletion when either Ollama identity is selected", async () => {
		const ollama = manager(["canonical:latest"]);
		vi.mocked(ollama.listLocalModels).mockResolvedValue([
			{
				...localModel("canonical:latest"),
				name: "friendly:latest",
			},
		]);
		const integration = new OllamaIntegration({
			manager: ollama,
			platform: "win32",
		});

		await expect(
			integration.deleteModel("canonical:latest", config(["friendly:latest"])),
		).rejects.toThrow("Ollama integration selection");
		expect(ollama.deleteModel).not.toHaveBeenCalled();
	});
});
