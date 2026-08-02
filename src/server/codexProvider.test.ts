import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs/promises", () => ({
	readFile: vi.fn(),
	realpath: vi.fn(async (path: string) => path),
	lstat: vi.fn(async (path: string) => {
		const isFile = /(?:SKILL\.md|render\.py)$/i.test(path);
		return {
			isSymbolicLink: () => false,
			isFile: () => isFile,
			isDirectory: () => !isFile,
		};
	}),
}));
vi.mock("../lib/codexPath", () => ({ resolveCodexExecutable: vi.fn() }));
vi.mock("../lib/process", () => ({ runBoundedProcess: vi.fn() }));
vi.mock("./attachments", () => ({ ingestVisualizationHtml: vi.fn() }));
vi.mock("./libraryStore", () => ({
	prepareLibrary: vi.fn().mockResolvedValue(undefined),
	visualizationStagingJobDirectory: vi.fn(() => "/tmp/hlid-visualization-job"),
}));
vi.mock("./windowsVisualizeArtifact", () => ({
	createWindowsVisualizeRenderInput: vi.fn(),
	extractWindowsVisualizeArtifact: vi.fn(),
}));
vi.mock("./obsidianAgentTools", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./obsidianAgentTools")>();
	return { ...actual, executeObsidianAgentTool: vi.fn() };
});
vi.mock("./hlidAgentTools", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./hlidAgentTools")>();
	return { ...actual, executeHlidAgentToolRich: vi.fn() };
});

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolveCodexExecutable } from "../lib/codexPath";
import { HLID_AGENT_TOOL_COUNT } from "../lib/hlidContext";
import { runBoundedProcess } from "../lib/process";
import type {
	AgentEvent,
	AgentQueryParams,
	AgentSession,
} from "./agentProvider";
import { ingestVisualizationHtml } from "./attachments";
import {
	__resetCodexAppServersForTesting,
	acquireCodexAppServer,
} from "./codexAppServer";
import type { SandboxPolicy } from "./codexProtocol";
import {
	__resetCodexHostCapabilitiesForTesting,
	CodexProvider,
	codexChildStep,
	codexLaunchConfig,
	codexRealtimeErrorMessage,
	codexRealtimeOutputModality,
	codexRealtimeVersion,
	codexReasoningText,
	codexSandboxPolicy,
	codexSubagentStatus,
	computerUseApprovalDetails,
	fetchCodexModels,
	invalidateCodexHostCapabilities,
	mapCodexModels,
	refreshCodexHostCapabilities,
	resolveWindowsComputerUseSettings,
	sandboxMode,
	windowsComputerUseHostAvailable,
	windowsComputerUseModel,
} from "./codexProvider";
import { executeHlidAgentToolRich } from "./hlidAgentTools";
import { HLID_HELP_TOPICS } from "./hlidHelp";
import { executeObsidianAgentTool } from "./obsidianAgentTools";
import {
	createWindowsVisualizeRenderInput,
	extractWindowsVisualizeArtifact,
} from "./windowsVisualizeArtifact";

// ── fetchCodexModels test helpers ──────────────────────────────────────────

/** Live-verified codex-cli 0.145.0 `model/list` RPC response shape. */
const MODEL_LIST_FIXTURE = {
	data: [
		{
			id: "gpt-5.5",
			model: "gpt-5.5",
			displayName: "GPT-5.5",
			description:
				"Frontier model for complex coding, research, and real-world work.",
			hidden: false,
			isDefault: true,
			inputModalities: ["text", "image"],
			supportedReasoningEfforts: [
				{
					reasoningEffort: "low",
					description: "Fast responses with lighter reasoning",
				},
				{
					reasoningEffort: "medium",
					description: "Balances speed and reasoning depth for everyday tasks",
				},
				{
					reasoningEffort: "high",
					description: "Greater reasoning depth for complex problems",
				},
				{
					reasoningEffort: "xhigh",
					description: "Extra high reasoning depth for complex problems",
				},
			],
			defaultReasoningEffort: "medium",
			serviceTiers: [
				{
					id: "fast",
					name: "Fast",
					description: "Priority processing",
				},
				{
					id: "standard",
					name: "Standard",
					description: "Standard processing",
				},
			],
			defaultServiceTier: "standard",
		},
	],
};

type FakeProc = InstanceType<typeof EventEmitter> & {
	stdin: { write: ReturnType<typeof vi.fn> };
	stdout: InstanceType<typeof EventEmitter>;
	stderr: InstanceType<typeof EventEmitter>;
	kill: ReturnType<typeof vi.fn>;
};

/**
 * Fake app-server process. `write` synchronously schedules a microtask that
 * replies on stdout for "initialize" and "model/list" requests, driving the
 * handshake without needing to poll — `modelListResult` is what the
 * model/list RPC resolves with (defaults to the live-verified fixture).
 * Pass `silent: true` to never respond (for timeout tests).
 */
function makeFakeProc(
	opts: { modelListResult?: unknown; silent?: boolean } = {},
): { proc: FakeProc; writes: string[] } {
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	const proc = new EventEmitter() as FakeProc;
	const writes: string[] = [];
	proc.stdin = {
		write: vi.fn((data: string) => {
			writes.push(data);
			if (opts.silent) return;
			const msg = JSON.parse(data) as { id?: number; method?: string };
			queueMicrotask(() => {
				if (msg.method === "initialize") {
					stdout.emit(
						"data",
						Buffer.from(`${JSON.stringify({ id: msg.id, result: {} })}\n`),
					);
				} else if (msg.method === "model/list") {
					stdout.emit(
						"data",
						Buffer.from(
							`${JSON.stringify({
								id: msg.id,
								result: opts.modelListResult ?? MODEL_LIST_FIXTURE,
							})}\n`,
						),
					);
				}
			});
		}),
	};
	proc.stdout = stdout;
	proc.stderr = stderr;
	proc.kill = vi.fn();
	return { proc, writes };
}

function writeMethods(writes: string[]): (string | undefined)[] {
	return writes.map((w) => (JSON.parse(w) as { method?: string }).method);
}

describe("codexReasoningText", () => {
	it("extracts text from reasoning summary arrays", () => {
		expect(
			codexReasoningText({
				type: "reasoning",
				summary: [{ type: "summary_text", text: "Checked the config." }],
			}),
		).toBe("Checked the config.");
	});

	it("falls back across common Codex reasoning fields", () => {
		expect(codexReasoningText({ reasoning: { text: "Planning edits." } })).toBe(
			"Planning edits.",
		);
		expect(codexReasoningText({ content: "Reviewing output." })).toBe(
			"Reviewing output.",
		);
	});

	it("returns empty text when Codex does not expose reasoning", () => {
		expect(codexReasoningText({ encrypted_content: "opaque" })).toBe("");
	});
});

describe("CodexProvider capability declarations", () => {
	beforeEach(() => {
		__resetCodexAppServersForTesting();
	});

	it("exposes codex model options for UI selectors", () => {
		const p = new CodexProvider();
		const models = p.models ?? [];
		expect(models.length).toBeGreaterThan(0);
		expect(models.map((m) => m.value)).toEqual([
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-luna",
			"gpt-5.5",
			"gpt-5.4",
		]);
		for (const m of models) {
			expect(typeof m.value).toBe("string");
			expect(typeof m.label).toBe("string");
		}
	});

	it("declares exact whole-session and per-turn fork support", () => {
		expect(new CodexProvider().forkCapability).toEqual({
			kind: "exact",
			cutoff: "turn",
			wholeSession: true,
			throughMessage: true,
		});
	});

	it("declares structured goals, activities, and realtime transport", () => {
		expect(new CodexProvider().capabilities).toEqual({
			goalControl: true,
			structuredActivities: ["compact", "review"],
			realtime: true,
		});
	});

	it("forks a Codex thread through the captured turn without auto-continuing its goal", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const result = await new CodexProvider().forkSession?.({
			sessionId: "thread-source",
			cwd: "/work/project",
			cutoff: { kind: "turn", id: "turn-7" },
		});

		expect(result).toEqual({ sessionId: "thread-fork" });
		const fork = writes
			.map(
				(value) => JSON.parse(value) as { method?: string; params?: unknown },
			)
			.find((message) => message.method === "thread/fork");
		expect(fork?.params).toEqual({
			threadId: "thread-source",
			lastTurnId: "turn-7",
			cwd: "/work/project",
			excludeTurns: true,
			deferGoalContinuation: true,
		});
	});

	it("omits the turn boundary for a whole-session Codex fork", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		await new CodexProvider().forkSession?.({ sessionId: "thread-source" });

		const fork = writes
			.map(
				(value) => JSON.parse(value) as { method?: string; params?: unknown },
			)
			.find((message) => message.method === "thread/fork");
		expect(fork?.params).toEqual({
			threadId: "thread-source",
			excludeTurns: true,
			deferGoalContinuation: true,
		});
	});

	it("rejects a message cutoff for a Codex fork", async () => {
		await expect(
			new CodexProvider().forkSession?.({
				sessionId: "thread-source",
				cutoff: { kind: "message", id: "message-1" },
			}),
		).rejects.toThrow("native turn cutoff");
	});

	it("only enables Windows Computer Use on a Windows host with native Codex", () => {
		expect(windowsComputerUseHostAvailable("win32", "C:\\bin\\codex.exe")).toBe(
			true,
		);
		vi.mocked(resolveCodexExecutable).mockReturnValue(undefined);
		expect(windowsComputerUseHostAvailable("win32", undefined)).toBe(false);
		expect(windowsComputerUseHostAvailable("linux", "/usr/bin/codex")).toBe(
			false,
		);
	});

	it("uses the native Computer Use model unless explicitly overridden", () => {
		expect(windowsComputerUseModel(undefined)).toBe("gpt-5.4");
		expect(windowsComputerUseModel(" gpt-5.5 ")).toBe("gpt-5.5");
	});

	it("inherits a supported session model and keeps medium effort by default", () => {
		expect(
			resolveWindowsComputerUseSettings({
				configured: { model: "inherit", effort: "medium" },
				sessionModel: "gpt-5.5",
				sessionEffort: "high",
				nativeModels: [
					{
						value: "gpt-5.5",
						label: "GPT-5.5",
						efforts: [
							{ value: "medium", label: "Medium" },
							{ value: "high", label: "High" },
						],
					},
				],
			}),
		).toEqual({ model: "gpt-5.5", effort: "medium" });
	});

	it("can inherit both the active session model and effort", () => {
		expect(
			resolveWindowsComputerUseSettings({
				configured: { model: "inherit", effort: "inherit" },
				sessionModel: "gpt-5.5",
				sessionEffort: "high",
				nativeModels: [
					{
						value: "gpt-5.5",
						label: "GPT-5.5",
						efforts: [{ value: "high", label: "High" }],
					},
				],
			}),
		).toEqual({ model: "gpt-5.5", effort: "high" });
	});

	it("uses a visible safe fallback for unavailable native settings", () => {
		const resolved = resolveWindowsComputerUseSettings({
			configured: { model: "wsl-only", effort: "xhigh" },
			sessionModel: "gpt-5.5",
			nativeModels: [
				{
					value: "gpt-5.4",
					label: "GPT-5.4",
					efforts: [{ value: "medium", label: "Medium" }],
				},
			],
		});
		expect(resolved).toEqual({
			model: "gpt-5.4",
			effort: "medium",
			notice:
				"Configured model wsl-only is unavailable in Windows-native Codex; using gpt-5.4. Effort xhigh is unsupported by gpt-5.4; using medium.",
		});
	});

	it("extracts per-app approval identity from nested Computer Use metadata", () => {
		expect(
			computerUseApprovalDetails({
				_meta: {
					computerUse: {
						app: {
							appId: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
							displayName: "Calculator",
						},
						riskLevel: "medium",
					},
				},
			}),
		).toEqual({
			appId: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
			displayName: "Calculator",
			riskLevel: "medium",
		});
	});

	it("extracts app identity from the native Computer Use elicitation payload", () => {
		expect(
			computerUseApprovalDetails({
				_meta: {
					connector_id: "computer-use",
					riskLevel: "low",
					tool_params: { app: "Docker.DockerForWindows.Settings" },
					tool_params_display: [
						{ display_name: "App", name: "app", value: "Docker Desktop" },
					],
				},
			}),
		).toEqual({
			appId: "Docker.DockerForWindows.Settings",
			displayName: "Docker Desktop",
			riskLevel: "low",
		});
	});
});

describe("CodexProvider host capabilities", () => {
	beforeEach(() => {
		__resetCodexAppServersForTesting();
		__resetCodexHostCapabilitiesForTesting();
		vi.mocked(spawn).mockReset();
		vi.mocked(spawn).mockClear();
		vi.mocked(readFile).mockResolvedValue(
			'[plugins."computer-use@openai-bundled"]\nenabled = true\n',
		);
	});

	it("reports the native Computer Use plugin as ready on Windows", async () => {
		const platform = vi
			.spyOn(process, "platform", "get")
			.mockReturnValue("win32");
		const previousCwd = process.env.HLID_WINDOWS_COMPUTER_USE_CWD;
		process.env.HLID_WINDOWS_COMPUTER_USE_CWD = "/tmp/hlid-computer-use-test";
		try {
			vi.mocked(resolveCodexExecutable).mockReturnValue("C:\\bin\\codex.exe");

			expect(await refreshCodexHostCapabilities()).toEqual({
				windowsComputerUse: {
					label: "Windows Computer Use",
					available: true,
				},
				windowsVisualize: {
					label: "Windows Visualize",
					available: false,
					reason: "Visualize plugin is not installed or enabled",
				},
			});
			expect(await new CodexProvider().hostCapabilities()).toEqual({
				windowsComputerUse: {
					label: "Windows Computer Use",
					available: true,
				},
				windowsVisualize: {
					label: "Windows Visualize",
					available: false,
					reason: "Visualize plugin is not installed or enabled",
				},
			});
			expect(spawn).not.toHaveBeenCalled();
		} finally {
			if (previousCwd === undefined)
				delete process.env.HLID_WINDOWS_COMPUTER_USE_CWD;
			else process.env.HLID_WINDOWS_COMPUTER_USE_CWD = previousCwd;
			platform.mockRestore();
		}
	});

	it("proves Visualize readiness through a fresh native skills list", async () => {
		const platform = vi
			.spyOn(process, "platform", "get")
			.mockReturnValue("win32");
		try {
			vi.mocked(readFile).mockResolvedValue(
				[
					'[plugins."computer-use@openai-bundled"]',
					"enabled = true",
					'[plugins."visualize@openai-bundled"]',
					"enabled = true",
				].join("\n"),
			);
			vi.mocked(resolveCodexExecutable).mockReturnValue("C:\\bin\\codex.exe");
			vi.stubEnv("CODEX_HOME", "C:\\Users\\test\\.codex");
			const native = makeFakeSessionProc({
				skills: [
					{
						name: "visualize:visualize",
						enabled: true,
						path: "C:\\Users\\test\\.codex\\plugins\\cache\\openai-bundled\\visualize\\1.0.16\\skills\\visualize\\SKILL.md",
					},
				],
			});
			vi.mocked(spawn).mockReturnValue(native.proc as never);

			await expect(refreshCodexHostCapabilities()).resolves.toEqual({
				windowsComputerUse: {
					label: "Windows Computer Use",
					available: true,
				},
				windowsVisualize: {
					label: "Windows Visualize",
					available: true,
				},
			});
			const skillsCall = native.writes
				.map((line) => JSON.parse(line))
				.find((message) => message.method === "skills/list");
			expect(skillsCall?.params).toMatchObject({ forceReload: true });
			expect(native.proc.kill).toHaveBeenCalledOnce();
		} finally {
			vi.unstubAllEnvs();
			platform.mockRestore();
		}
	});

	it("shares one fresh Visualize probe across concurrent explicit refreshes", async () => {
		const platform = vi
			.spyOn(process, "platform", "get")
			.mockReturnValue("win32");
		try {
			vi.stubEnv("CODEX_HOME", "C:\\Users\\test\\.codex");
			vi.mocked(readFile).mockResolvedValue(
				'[plugins."visualize@openai-bundled"]\nenabled = true\n',
			);
			vi.mocked(resolveCodexExecutable).mockReturnValue("C:\\bin\\codex.exe");
			const skillPath =
				"C:\\Users\\test\\.codex\\plugins\\cache\\openai-bundled\\visualize\\1.0.16\\skills\\visualize\\SKILL.md";
			const native = makeFakeSessionProc({ deferSkills: true });
			vi.mocked(spawn).mockReturnValue(native.proc as never);

			const first = refreshCodexHostCapabilities();
			await vi.waitFor(() =>
				expect(writeMethods(native.writes)).toContain("skills/list"),
			);
			const second = refreshCodexHostCapabilities();
			expect(spawn).toHaveBeenCalledTimes(1);

			const request = native.writes
				.map((line) => JSON.parse(line) as { id?: number; method?: string })
				.find((message) => message.method === "skills/list");
			emitSessionResponse(native.proc, request?.id ?? -1, {
				data: [
					{
						cwd: "/tmp/codex-test",
						skills: [
							{
								name: "visualize:visualize",
								enabled: true,
								path: skillPath,
							},
						],
					},
				],
			});

			await expect(Promise.all([first, second])).resolves.toEqual([
				expect.objectContaining({
					windowsVisualize: { label: "Windows Visualize", available: true },
				}),
				expect.objectContaining({
					windowsVisualize: { label: "Windows Visualize", available: true },
				}),
			]);
			expect(native.proc.kill).toHaveBeenCalledOnce();
		} finally {
			vi.unstubAllEnvs();
			platform.mockRestore();
		}
	});

	it("does not trust a Visualize plugin from another marketplace", async () => {
		const platform = vi
			.spyOn(process, "platform", "get")
			.mockReturnValue("win32");
		try {
			vi.mocked(readFile).mockResolvedValue(
				[
					'[plugins."computer-use@openai-bundled"]',
					"enabled = true",
					'[plugins."visualize@third-party"]',
					"enabled = true",
				].join("\n"),
			);
			vi.mocked(resolveCodexExecutable).mockReturnValue("C:\\bin\\codex.exe");

			const capability = await refreshCodexHostCapabilities();

			expect(capability.windowsVisualize).toEqual({
				label: "Windows Visualize",
				available: false,
				reason: "Visualize plugin is not installed or enabled",
			});
			expect(spawn).not.toHaveBeenCalled();
		} finally {
			platform.mockRestore();
		}
	});

	it("rejects a loaded Visualize skill outside the bundled cache", async () => {
		const platform = vi
			.spyOn(process, "platform", "get")
			.mockReturnValue("win32");
		try {
			vi.stubEnv("CODEX_HOME", "C:\\Users\\test\\.codex");
			vi.mocked(readFile).mockResolvedValue(
				'[plugins."visualize@openai-bundled"]\nenabled = true\n',
			);
			vi.mocked(resolveCodexExecutable).mockReturnValue("C:\\bin\\codex.exe");
			const native = makeFakeSessionProc({
				skills: [
					{
						name: "visualize:visualize",
						enabled: true,
						path: "C:\\tmp\\visualize\\skills\\visualize\\SKILL.md",
					},
				],
			});
			vi.mocked(spawn).mockReturnValue(native.proc as never);

			const capability = await refreshCodexHostCapabilities();

			expect(capability.windowsVisualize).toEqual({
				label: "Windows Visualize",
				available: false,
				reason: "Native Codex did not load the trusted Visualize skill",
			});
			expect(native.proc.kill).toHaveBeenCalledOnce();
		} finally {
			vi.unstubAllEnvs();
			platform.mockRestore();
		}
	});

	it("does not let a stale Visualize probe overwrite a post-mutation refresh", async () => {
		const platform = vi
			.spyOn(process, "platform", "get")
			.mockReturnValue("win32");
		try {
			vi.stubEnv("CODEX_HOME", "C:\\Users\\test\\.codex");
			vi.mocked(readFile).mockResolvedValue(
				'[plugins."visualize@openai-bundled"]\nenabled = true\n',
			);
			vi.mocked(resolveCodexExecutable).mockReturnValue("C:\\bin\\codex.exe");
			const skillPath =
				"C:\\Users\\test\\.codex\\plugins\\cache\\openai-bundled\\visualize\\1.0.16\\skills\\visualize\\SKILL.md";
			const stale = makeFakeSessionProc({ deferSkills: true });
			const current = makeFakeSessionProc({
				skills: [
					{
						name: "visualize:visualize",
						enabled: true,
						path: skillPath,
					},
				],
			});
			vi.mocked(spawn)
				.mockReturnValueOnce(stale.proc as never)
				.mockReturnValueOnce(current.proc as never);

			const staleRefresh = refreshCodexHostCapabilities();
			await vi.waitFor(() =>
				expect(writeMethods(stale.writes)).toContain("skills/list"),
			);
			invalidateCodexHostCapabilities();
			await expect(refreshCodexHostCapabilities()).resolves.toMatchObject({
				windowsVisualize: { available: true },
			});

			const staleRequest = stale.writes
				.map((line) => JSON.parse(line) as { id?: number; method?: string })
				.find((message) => message.method === "skills/list");
			emitSessionResponse(stale.proc, staleRequest?.id ?? -1, {
				data: [{ cwd: "/tmp/codex-test", skills: [] }],
			});
			await staleRefresh;

			await expect(
				new CodexProvider().hostCapabilities(),
			).resolves.toMatchObject({
				windowsVisualize: { available: true },
			});
		} finally {
			vi.unstubAllEnvs();
			platform.mockRestore();
		}
	});

	it("returns an immediate snapshot while a bounded probe runs in the background", async () => {
		vi.useFakeTimers();
		const platform = vi
			.spyOn(process, "platform", "get")
			.mockReturnValue("win32");
		const previousCwd = process.env.HLID_WINDOWS_COMPUTER_USE_CWD;
		process.env.HLID_WINDOWS_COMPUTER_USE_CWD =
			"/tmp/hlid-computer-use-background-test";
		try {
			vi.mocked(readFile).mockReturnValue(new Promise<never>(() => {}));
			vi.mocked(resolveCodexExecutable).mockReturnValue("C:\\bin\\codex.exe");

			await expect(new CodexProvider().hostCapabilities()).resolves.toEqual({
				windowsComputerUse: {
					label: "Windows Computer Use",
					available: false,
					reason: "Capability status is refreshing",
				},
				windowsVisualize: {
					label: "Windows Visualize",
					available: false,
					reason: "Capability status is refreshing",
				},
			});
			expect(spawn).not.toHaveBeenCalled();
			const refresh = refreshCodexHostCapabilities();
			await vi.advanceTimersByTimeAsync(5_001);
			await expect(refresh).resolves.toEqual({
				windowsComputerUse: {
					label: "Windows Computer Use",
					available: false,
					reason: "Capability check timed out",
				},
				windowsVisualize: {
					label: "Windows Visualize",
					available: false,
					reason: "Visualize capability check timed out",
				},
			});
		} finally {
			if (previousCwd === undefined)
				delete process.env.HLID_WINDOWS_COMPUTER_USE_CWD;
			else process.env.HLID_WINDOWS_COMPUTER_USE_CWD = previousCwd;
			vi.useRealTimers();
			platform.mockRestore();
		}
	});
});

describe("codexLaunchConfig", () => {
	it("uses the provided executable and passes the cwd through as rpcCwd", () => {
		const cfg = codexLaunchConfig({
			cwd: "/home/kyle/development/repos/hlid",
			executable: "/home/kyle/.bun/bin/codex",
		});

		expect(cfg).toEqual({
			executable: "/home/kyle/.bun/bin/codex",
			rpcCwd: "/home/kyle/development/repos/hlid",
			appServer: {
				executable: "/home/kyle/.bun/bin/codex",
				args: [],
			},
		});
	});

	it("enables realtime conversation only for an explicit preview session", () => {
		const cfg = codexLaunchConfig({
			cwd: "/home/kyle/development/repos/hlid",
			executable: "/home/kyle/.bun/bin/codex",
			enableRealtime: true,
		});

		expect(cfg.appServer.args).toEqual(["--enable", "realtime_conversation"]);
	});

	it("translates a WSL UNC cwd to the POSIX rpcCwd", () => {
		const cfg = codexLaunchConfig({
			cwd: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\x",
			executable: "/home/kyle/.bun/bin/codex",
		});

		// parseWslUnc/toLogical only rewrite WSL UNC paths on win32 — on
		// Linux/macOS CI this cwd passes through unchanged.
		// Match the guarding style used in src/lib/paths.test.ts.
		if (process.platform === "win32") {
			expect(cfg.rpcCwd).toBe("/home/kyle/x");
		} else {
			expect(cfg.rpcCwd).toBe("\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\x");
		}
	});

	it("keeps a plain Windows or POSIX cwd unchanged", () => {
		const cfg = codexLaunchConfig({
			cwd: "C:\\Users\\kyle\\project",
			executable: "codex.exe",
		});
		expect(cfg.rpcCwd).toBe("C:\\Users\\kyle\\project");

		const posixCfg = codexLaunchConfig({
			cwd: "/home/kyle/project",
			executable: "/home/kyle/.bun/bin/codex",
		});
		expect(posixCfg.rpcCwd).toBe("/home/kyle/project");
	});
});

describe("codexRealtimeVersion", () => {
	it("uses AVAS-compatible v3 for every WebRTC voice mode", () => {
		expect(codexRealtimeVersion("dictation")).toBe("v3");
		expect(codexRealtimeVersion("live")).toBe("v3");
		expect(codexRealtimeVersion("read-aloud")).toBe("v3");
		expect(codexRealtimeOutputModality()).toBe("audio");
	});

	it("turns an account-gated ChatGPT call endpoint into an actionable message", () => {
		expect(
			codexRealtimeErrorMessage(
				new Error(
					'unexpected status 404 Not Found: {"detail":"Not Found"}, url: https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas',
				),
			),
		).toBe(
			"Codex realtime voice is not available for this ChatGPT account yet.",
		);
	});
});

describe("sandboxMode", () => {
	it("maps bypassPermissions to danger-full-access", () => {
		expect(sandboxMode("bypassPermissions")).toBe("danger-full-access");
	});

	it("maps plan to read-only", () => {
		expect(sandboxMode("plan")).toBe("read-only");
	});

	it("maps default and acceptEdits to workspace-write", () => {
		expect(sandboxMode("default")).toBe("workspace-write");
		expect(sandboxMode("acceptEdits")).toBe("workspace-write");
	});

	it("maps undefined to workspace-write", () => {
		expect(sandboxMode(undefined)).toBe("workspace-write");
	});
});

describe("codexSandboxPolicy", () => {
	it("maps bypassPermissions to dangerFullAccess", () => {
		expect(codexSandboxPolicy("bypassPermissions", ["/extra"])).toEqual({
			type: "dangerFullAccess",
		});
	});

	it("maps plan to readOnly with network disabled", () => {
		expect(codexSandboxPolicy("plan", ["/extra"])).toEqual({
			type: "readOnly",
			networkAccess: false,
		});
	});

	it("makes only the HTML plan directory an explicit writable root", () => {
		expect(
			codexSandboxPolicy(
				"plan",
				["/unrelated"],
				"/vault/.hlid/plans/plan-session.html",
			),
		).toEqual({
			type: "workspaceWrite",
			writableRoots: ["/vault/.hlid/plans"],
			networkAccess: false,
			excludeTmpdirEnvVar: true,
			excludeSlashTmp: true,
		});
	});

	it("maps default/acceptEdits to workspaceWrite, passing through writableRoots", () => {
		expect(codexSandboxPolicy("default", ["/vault", "/agent"])).toEqual({
			type: "workspaceWrite",
			writableRoots: ["/vault", "/agent"],
			networkAccess: false,
			excludeTmpdirEnvVar: false,
			excludeSlashTmp: false,
		});
		expect(codexSandboxPolicy("acceptEdits", [])).toEqual({
			type: "workspaceWrite",
			writableRoots: [],
			networkAccess: false,
			excludeTmpdirEnvVar: false,
			excludeSlashTmp: false,
		});
	});

	it("returns values assignable to the vendored codex-cli SandboxPolicy type", () => {
		// Compile-time check: if codex-cli's generated SandboxPolicy shape ever
		// drifts (see src/server/codexProtocol/v2/SandboxPolicy.ts), `satisfies`
		// below fails to typecheck rather than silently going stale.
		expect(
			codexSandboxPolicy("bypassPermissions", []) satisfies SandboxPolicy,
		).toEqual({ type: "dangerFullAccess" });
		expect(codexSandboxPolicy("plan", []) satisfies SandboxPolicy).toEqual({
			type: "readOnly",
			networkAccess: false,
		});
		expect(
			codexSandboxPolicy("default", ["/vault"]) satisfies SandboxPolicy,
		).toEqual({
			type: "workspaceWrite",
			writableRoots: ["/vault"],
			networkAccess: false,
			excludeTmpdirEnvVar: false,
			excludeSlashTmp: false,
		});
	});
});

describe("mapCodexModels", () => {
	it("maps the live-verified fixture: label, description, efforts with isDefault on medium", () => {
		const models = mapCodexModels(MODEL_LIST_FIXTURE);
		expect(models).toEqual([
			{
				value: "gpt-5.5",
				label: "GPT-5.5",
				description:
					"Frontier model for complex coding, research, and real-world work.",
				isDefault: true,
				hidden: undefined,
				inputModalities: ["text", "image"],
				efforts: [
					{
						value: "low",
						label: "Low",
						desc: "Fast responses with lighter reasoning",
						isDefault: false,
					},
					{
						value: "medium",
						label: "Medium",
						desc: "Balances speed and reasoning depth for everyday tasks",
						isDefault: true,
					},
					{
						value: "high",
						label: "High",
						desc: "Greater reasoning depth for complex problems",
						isDefault: false,
					},
					{
						value: "xhigh",
						label: "Xhigh",
						desc: "Extra high reasoning depth for complex problems",
						isDefault: false,
					},
				],
				serviceTiers: [
					{
						value: "fast",
						label: "Fast",
						desc: "Priority processing",
						isDefault: false,
					},
					{
						value: "standard",
						label: "Standard",
						desc: "Standard processing",
						isDefault: true,
					},
				],
			},
		]);
	});

	it("preserves the hidden flag on entries (filtering happens in fetchCodexModels, not here)", () => {
		const models = mapCodexModels({
			data: [{ id: "secret-model", model: "secret-model", hidden: true }],
		});
		expect(models).toEqual([
			{
				value: "secret-model",
				label: "secret-model",
				description: undefined,
				isDefault: undefined,
				hidden: true,
				efforts: undefined,
			},
		]);
	});

	it("skips entries with no model/id string", () => {
		const models = mapCodexModels({
			data: [{ displayName: "No id here" }, { id: 42 }, { model: null }],
		});
		expect(models).toEqual([]);
	});

	it("tolerates missing supportedReasoningEfforts", () => {
		const models = mapCodexModels({
			data: [{ id: "gpt-5.4", model: "gpt-5.4", displayName: "GPT-5.4" }],
		});
		expect(models).toEqual([
			{
				value: "gpt-5.4",
				label: "GPT-5.4",
				description: undefined,
				isDefault: undefined,
				hidden: undefined,
				efforts: undefined,
			},
		]);
	});

	it("returns [] for garbage input", () => {
		expect(mapCodexModels(null)).toEqual([]);
		expect(mapCodexModels(undefined)).toEqual([]);
		expect(mapCodexModels("garbage")).toEqual([]);
		expect(mapCodexModels(42)).toEqual([]);
		expect(mapCodexModels({})).toEqual([]);
		expect(mapCodexModels({ data: "not an array" })).toEqual([]);
	});
});

describe("fetchCodexModels", () => {
	// The app-server connection registry is module-level state shared across
	// sessions by design — reset it so each test's fake proc is the one the
	// lazily-acquired connection binds to.
	beforeEach(() => {
		__resetCodexAppServersForTesting();
	});

	it("performs initialize -> initialized -> model/list handshake and maps the result", async () => {
		const { proc, writes } = makeFakeProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const models = await fetchCodexModels();

		expect(writeMethods(writes)).toEqual([
			"initialize",
			"initialized",
			"model/list",
		]);
		const initialize = writes
			.map((line) => JSON.parse(line))
			.find((message) => message.method === "initialize");
		expect(initialize?.params?.capabilities).toEqual({
			experimentalApi: true,
			mcpServerOpenaiFormElicitation: true,
		});
		expect(models).toEqual(mapCodexModels(MODEL_LIST_FIXTURE));
		// The shared app-server stays alive for reuse — never killed per call.
		expect(proc.kill).not.toHaveBeenCalled();
	});

	it("leaves realtime disabled for the catalog-only app server", async () => {
		const { proc } = makeFakeProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		await fetchCodexModels();

		expect(spawn).toHaveBeenCalledWith(
			"/usr/bin/codex",
			["app-server", "--listen", "stdio://"],
			expect.any(Object),
		);
	});

	it("passes includeHidden through to the model/list RPC params", async () => {
		const { proc, writes } = makeFakeProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		await fetchCodexModels({ includeHidden: true });

		const modelListWrite = writes.find(
			(w) => (JSON.parse(w) as { method?: string }).method === "model/list",
		);
		expect(
			(
				JSON.parse(modelListWrite ?? "{}") as {
					params?: { includeHidden?: boolean };
				}
			).params?.includeHidden,
		).toBe(true);
	});

	it("defaults includeHidden to false in the model/list RPC params", async () => {
		const { proc, writes } = makeFakeProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		await fetchCodexModels();

		const modelListWrite = writes.find(
			(w) => (JSON.parse(w) as { method?: string }).method === "model/list",
		);
		expect(
			(
				JSON.parse(modelListWrite ?? "{}") as {
					params?: { includeHidden?: boolean };
				}
			).params?.includeHidden,
		).toBe(false);
	});

	it("filters out hidden:true entries by default", async () => {
		const { proc } = makeFakeProc({
			modelListResult: {
				data: [
					{ id: "visible", model: "visible", hidden: false },
					{ id: "secret", model: "secret", hidden: true },
				],
			},
		});
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const models = await fetchCodexModels();
		expect(models.map((m) => m.value)).toEqual(["visible"]);
	});

	it("keeps hidden entries when includeHidden is true", async () => {
		const { proc } = makeFakeProc({
			modelListResult: {
				data: [
					{ id: "visible", model: "visible", hidden: false },
					{ id: "secret", model: "secret", hidden: true },
				],
			},
		});
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const models = await fetchCodexModels({ includeHidden: true });
		expect(models.map((m) => m.value).sort()).toEqual(["secret", "visible"]);
	});

	it("kills an unresponsive shared app-server so the next call can respawn", async () => {
		const spawnCount = vi.mocked(spawn).mock.calls.length;
		const { proc } = makeFakeProc({ silent: true });
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		await expect(fetchCodexModels({ timeoutMs: 20 })).rejects.toThrow(
			/timed out/i,
		);
		expect(proc.kill).toHaveBeenCalledOnce();

		const replacement = makeFakeProc();
		vi.mocked(spawn).mockReturnValue(replacement.proc as never);
		await expect(fetchCodexModels()).resolves.toEqual(
			mapCodexModels(MODEL_LIST_FIXTURE),
		);
		expect(spawn).toHaveBeenCalledTimes(spawnCount + 2);
	});

	it("rejects when the process emits an error event", async () => {
		const { proc } = makeFakeProc({ silent: true });
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const promise = fetchCodexModels({ timeoutMs: 5000 });
		proc.emit("error", new Error("spawn failed"));
		await expect(promise).rejects.toThrow("spawn failed");
	});

	it("rejects when the process exits unexpectedly", async () => {
		const { proc } = makeFakeProc({ silent: true });
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const promise = fetchCodexModels({ timeoutMs: 5000 });
		proc.emit("exit", 1);
		await expect(promise).rejects.toThrow(/exited/i);
	});
});

describe("Codex app-server request recovery", () => {
	beforeEach(() => {
		__resetCodexAppServersForTesting();
	});

	it("evicts an alive process that stops answering a session RPC", async () => {
		const { proc } = makeFakeProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		const conn = acquireCodexAppServer("/usr/bin/codex");
		await conn.ready;

		await expect(conn.request("thread/start", {}, 20)).rejects.toThrow(
			/thread\/start timed out/i,
		);
		expect(conn.alive).toBe(false);
		expect(proc.kill).toHaveBeenCalledOnce();

		const replacement = makeFakeProc();
		vi.mocked(spawn).mockReturnValue(replacement.proc as never);
		const next = acquireCodexAppServer("/usr/bin/codex");
		expect(next).not.toBe(conn);
		await expect(next.ready).resolves.toBeUndefined();
	});
});

describe("CodexProvider.listModels", () => {
	beforeEach(() => {
		__resetCodexAppServersForTesting();
	});

	it("delegates to fetchCodexModels", async () => {
		const { proc } = makeFakeProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const provider = new CodexProvider();
		const models = await provider.listModels?.();
		expect(models).toEqual(mapCodexModels(MODEL_LIST_FIXTURE));
	});
});

describe("CodexProvider.listSkills", () => {
	beforeEach(() => {
		__resetCodexAppServersForTesting();
	});

	it("maps native skills/list metadata including package paths", async () => {
		const skill = {
			name: "review",
			description: "Review the working tree",
			path: "/home/test/.codex/skills/review/SKILL.md",
			scope: "user",
			enabled: true,
		};
		const { proc } = makeFakeSessionProc({ skills: [skill] });
		vi.mocked(spawn).mockReturnValue(proc as never);

		await expect(
			new CodexProvider().listSkills?.({
				cwd: "/work/project",
				executable: "/usr/bin/codex",
			}),
		).resolves.toEqual([skill]);
	});
});

// ── CodexAgentSession mid-session model/permission switching ──────────────────

/**
 * Fake app-server process that drives a full initialize → thread/start →
 * turn/start handshake (unlike makeFakeProc above, which only answers
 * initialize/model-list for the one-off fetchCodexModels probe). Every
 * `turn/start` call gets a fresh turn id so CodexAgentSession.send() can be
 * called repeatedly.
 */
function makeFakeSessionProc(
	opts: {
		rateLimits?: unknown;
		/** Result for `mcpServerStatus/list`; ignored when `mcpStatusError` set. */
		mcpStatusResult?: unknown;
		/** Reply to `mcpServerStatus/list` with a JSON-RPC error. */
		mcpStatusError?: boolean;
		skills?: unknown[];
		modelListResult?: unknown;
		uniqueThreadIds?: boolean;
		missingRolloutOnResume?: boolean;
		threadModel?: string | null;
		deferSkills?: boolean;
	} = {},
): {
	proc: FakeProc;
	writes: string[];
} {
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	const proc = new EventEmitter() as FakeProc;
	const writes: string[] = [];
	let turnCounter = 0;
	let threadCounter = 0;
	proc.stdin = {
		write: vi.fn((data: string) => {
			writes.push(data);
			const msg = JSON.parse(data) as {
				id?: number;
				method?: string;
				params?: Record<string, unknown>;
			};
			queueMicrotask(() => {
				if (msg.method === "initialize") {
					stdout.emit(
						"data",
						Buffer.from(`${JSON.stringify({ id: msg.id, result: {} })}\n`),
					);
				} else if (
					msg.method === "thread/resume" &&
					opts.missingRolloutOnResume
				) {
					stdout.emit(
						"data",
						Buffer.from(
							`${JSON.stringify({
								id: msg.id,
								error: {
									message: "no rollout found for thread id missing-thread",
								},
							})}\n`,
						),
					);
				} else if (
					msg.method === "thread/start" ||
					msg.method === "thread/resume"
				) {
					threadCounter++;
					stdout.emit(
						"data",
						Buffer.from(
							`${JSON.stringify({
								id: msg.id,
								result: {
									thread: {
										id: opts.uniqueThreadIds
											? `thread-${threadCounter}`
											: "thread-1",
										...(opts.threadModel === null
											? {}
											: { model: opts.threadModel ?? "gpt-5.4" }),
									},
								},
							})}\n`,
						),
					);
				} else if (msg.method === "thread/fork") {
					stdout.emit(
						"data",
						Buffer.from(
							`${JSON.stringify({
								id: msg.id,
								result: { thread: { id: "thread-fork" } },
							})}\n`,
						),
					);
				} else if (msg.method === "model/list") {
					stdout.emit(
						"data",
						Buffer.from(
							`${JSON.stringify({
								id: msg.id,
								result: opts.modelListResult ?? MODEL_LIST_FIXTURE,
							})}\n`,
						),
					);
				} else if (msg.method === "mcpServer/tool/call") {
					stdout.emit(
						"data",
						Buffer.from(
							`${JSON.stringify({
								id: msg.id,
								result: { content: [], isError: false },
							})}\n`,
						),
					);
				} else if (msg.method === "turn/start") {
					turnCounter++;
					stdout.emit(
						"data",
						Buffer.from(
							`${JSON.stringify({
								id: msg.id,
								result: { turn: { id: `turn-${turnCounter}` } },
							})}\n`,
						),
					);
				} else if (msg.method === "turn/steer") {
					stdout.emit(
						"data",
						Buffer.from(
							`${JSON.stringify({
								id: msg.id,
								result: { turnId: msg.params?.expectedTurnId },
							})}\n`,
						),
					);
				} else if (msg.method === "review/start") {
					turnCounter++;
					stdout.emit(
						"data",
						Buffer.from(
							`${JSON.stringify({
								id: msg.id,
								result: { turn: { id: `review-${turnCounter}` } },
							})}\n`,
						),
					);
				} else if (msg.method === "thread/compact/start") {
					stdout.emit(
						"data",
						Buffer.from(`${JSON.stringify({ id: msg.id, result: {} })}\n`),
					);
				} else if (msg.method === "thread/goal/get") {
					stdout.emit(
						"data",
						Buffer.from(
							`${JSON.stringify({ id: msg.id, result: { goal: null } })}\n`,
						),
					);
				} else if (msg.method === "thread/goal/set") {
					stdout.emit(
						"data",
						Buffer.from(
							`${JSON.stringify({
								id: msg.id,
								result: {
									goal: {
										threadId: "thread-1",
										objective: msg.params?.objective ?? "Existing goal",
										status: msg.params?.status ?? "active",
										tokenBudget: msg.params?.tokenBudget ?? null,
										tokensUsed: 0,
										timeUsedSeconds: 0,
										createdAt: 1,
										updatedAt: 1,
									},
								},
							})}\n`,
						),
					);
				} else if (msg.method === "thread/goal/clear") {
					stdout.emit(
						"data",
						Buffer.from(
							`${JSON.stringify({ id: msg.id, result: { cleared: true } })}\n`,
						),
					);
				} else if (msg.method === "skills/list" && !opts.deferSkills) {
					stdout.emit(
						"data",
						Buffer.from(
							`${JSON.stringify({
								id: msg.id,
								result: {
									data: [{ cwd: "/tmp/codex-test", skills: opts.skills ?? [] }],
								},
							})}\n`,
						),
					);
				} else if (msg.method === "mcpServerStatus/list") {
					stdout.emit(
						"data",
						Buffer.from(
							`${JSON.stringify(
								opts.mcpStatusError
									? { id: msg.id, error: { message: "unsupported" } }
									: { id: msg.id, result: opts.mcpStatusResult ?? {} },
							)}\n`,
						),
					);
				} else if (
					msg.method === "account/rateLimits/read" &&
					"rateLimits" in opts
				) {
					stdout.emit(
						"data",
						Buffer.from(
							`${JSON.stringify({
								id: msg.id,
								result: { rateLimits: opts.rateLimits },
							})}\n`,
						),
					);
				}
			});
		}),
	};
	proc.stdout = stdout;
	proc.stderr = stderr;
	proc.kill = vi.fn();
	return { proc, writes };
}

/** Extract every `turn/start` call's params from the recorded writes. */
function turnStartParams(writes: string[]): Array<Record<string, unknown>> {
	return writes
		.map((w) => JSON.parse(w) as { method?: string; params?: unknown })
		.filter((m) => m.method === "turn/start")
		.map((m) => m.params as Record<string, unknown>);
}

function threadStartParams(writes: string[]): Array<Record<string, unknown>> {
	return writes
		.map((w) => JSON.parse(w) as { method?: string; params?: unknown })
		.filter((m) => m.method === "thread/start")
		.map((m) => m.params as Record<string, unknown>);
}

function emitSessionNotification(
	proc: FakeProc,
	method: string,
	params: Record<string, unknown>,
): void {
	proc.stdout.emit(
		"data",
		Buffer.from(`${JSON.stringify({ method, params })}\n`),
	);
}

function emitSessionResponse(
	proc: FakeProc,
	id: number,
	result: Record<string, unknown>,
): void {
	proc.stdout.emit("data", Buffer.from(`${JSON.stringify({ id, result })}\n`));
}

function emitVisualizeToolRequest(
	proc: FakeProc,
	id: number,
	callId: string,
	request: string,
): void {
	emitSessionNotification(proc, "item/started", {
		threadId: "thread-1",
		item: {
			id: callId,
			type: "dynamicToolCall",
			tool: "create_visualization",
			arguments: { request },
		},
	});
	proc.stdout.emit(
		"data",
		Buffer.from(
			`${JSON.stringify({
				id,
				method: "item/tool/call",
				params: {
					threadId: "thread-1",
					callId,
					namespace: "hlid",
					tool: "create_visualization",
					arguments: { request },
				},
			})}\n`,
		),
	);
}

async function nextSessionEvent(
	iterator: AsyncIterator<AgentEvent>,
): Promise<AgentEvent> {
	const result = await iterator.next();
	if (result.done) throw new Error("Codex session event stream ended early");
	return result.value;
}

async function nextDoneEvent(
	iterator: AsyncIterator<AgentEvent>,
): Promise<Extract<AgentEvent, { type: "done" }>> {
	for (;;) {
		const event = await nextSessionEvent(iterator);
		if (event.type === "done") return event;
	}
}

function baseCodexParams(
	overrides: Partial<AgentQueryParams> = {},
): AgentQueryParams {
	return {
		cwd: "/tmp/codex-test",
		canUseTool: vi.fn().mockResolvedValue({ behavior: "allow" }),
		model: "gpt-5.4",
		permissionMode: "default",
		...overrides,
	};
}

function configureVisualizeBridgeProcesses(): {
	skillPath: string;
	parent: ReturnType<typeof makeFakeSessionProc>;
	readinessProbe: ReturnType<typeof makeFakeSessionProc>;
	invocationProbe: ReturnType<typeof makeFakeSessionProc>;
	modelCatalog: ReturnType<typeof makeFakeSessionProc>;
	child: ReturnType<typeof makeFakeSessionProc>;
} {
	vi.mocked(extractWindowsVisualizeArtifact).mockClear();
	vi.mocked(createWindowsVisualizeRenderInput).mockClear();
	vi.mocked(ingestVisualizationHtml).mockClear();
	vi.stubEnv("CODEX_HOME", "C:\\Users\\test\\.codex");
	vi.mocked(readFile).mockResolvedValue(
		'[plugins."visualize@openai-bundled"]\nenabled = true\n',
	);
	vi.mocked(resolveCodexExecutable).mockReturnValue("C:\\bin\\codex.exe");
	const skillPath =
		"C:\\Users\\test\\.codex\\plugins\\cache\\openai-bundled\\visualize\\1.0.16\\skills\\visualize\\SKILL.md";
	const parent = makeFakeSessionProc();
	const readinessProbe = makeFakeSessionProc({
		skills: [
			{
				name: "visualize:visualize",
				enabled: true,
				path: skillPath,
			},
		],
	});
	const invocationProbe = makeFakeSessionProc({
		skills: [
			{
				name: "visualize:visualize",
				enabled: true,
				path: skillPath,
			},
		],
	});
	const modelCatalog = makeFakeSessionProc();
	const child = makeFakeSessionProc();
	vi.mocked(spawn)
		.mockReturnValueOnce(parent.proc as never)
		.mockReturnValueOnce(readinessProbe.proc as never)
		.mockReturnValueOnce(invocationProbe.proc as never)
		.mockReturnValueOnce(modelCatalog.proc as never)
		.mockReturnValueOnce(child.proc as never);
	return {
		skillPath,
		parent,
		readinessProbe,
		invocationProbe,
		modelCatalog,
		child,
	};
}

describe("CodexAgentSession — commands", () => {
	beforeEach(() => {
		__resetCodexAppServersForTesting();
		__resetCodexHostCapabilitiesForTesting();
		vi.mocked(spawn).mockReset();
		vi.mocked(readFile).mockResolvedValue(
			'[plugins."computer-use@openai-bundled"]\nenabled = true\n',
		);
		vi.mocked(runBoundedProcess).mockResolvedValue({ output: "", code: 0 });
		vi.mocked(extractWindowsVisualizeArtifact).mockResolvedValue({
			filename: "system-flow.html",
			sourcePath: "/tmp/hlid-visualization-job/system-flow.html",
			validatedSha256: "a".repeat(64),
		});
		vi.mocked(createWindowsVisualizeRenderInput).mockResolvedValue(
			"/tmp/hlid-visualization-job/.hlid-visualize-render-input.html",
		);
		vi.mocked(ingestVisualizationHtml).mockResolvedValue({
			id: "visualization-attachment-1",
			filename: "visualization.html",
		});
		vi.mocked(executeObsidianAgentTool).mockResolvedValue("obsidian result");
	});

	it("advertises Hlid review beside provider-discovered skills", async () => {
		const { proc, writes } = makeFakeSessionProc({
			skills: [{ name: "garden-check", description: "Check garden" }],
		});
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const session = new CodexProvider().query(baseCodexParams());
		expect(await session.supportedCommands?.()).toEqual([
			{
				name: "garden-check",
				description: "Check garden",
				argumentHint: "",
			},
			{
				name: "goal",
				description: "Set, inspect, pause, resume, or clear the Codex goal",
				argumentHint: "[objective | pause | resume | clear]",
				action: "goal",
			},
			{
				name: "compact",
				description: "Compact the active Codex conversation",
				argumentHint: "",
				action: "compact",
			},
			{
				name: "review",
				description: "Review the working tree",
				argumentHint: "[instructions]",
				action: "review",
			},
		]);
		expect(writeMethods(writes)).not.toContain("thread/start");
		session.cancel();
	});

	it("controls goals through native thread methods", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const session = new CodexProvider().query(baseCodexParams());
		await expect(
			session.controlGoal?.({
				action: "set",
				objective: "Finish the release gate",
				tokenBudget: 50_000,
			}),
		).resolves.toMatchObject({
			providerSessionId: "thread-1",
			goal: {
				objective: "Finish the release gate",
				status: "active",
				tokenBudget: 50_000,
			},
		});
		await session.controlGoal?.({ action: "pause" });
		await session.controlGoal?.({ action: "resume" });
		await session.controlGoal?.({ action: "clear" });
		const goalCalls = writes
			.map((value) => JSON.parse(value) as Record<string, unknown>)
			.filter((value) => String(value.method).startsWith("thread/goal/"));
		expect(goalCalls.map((value) => value.method)).toEqual([
			"thread/goal/set",
			"thread/goal/set",
			"thread/goal/set",
			"thread/goal/clear",
		]);
		expect(goalCalls[1]?.params).toMatchObject({ status: "paused" });
		expect(goalCalls[2]?.params).toMatchObject({ status: "active" });
		session.cancel();
	});

	it("executes review through review/start with a custom target", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const session = new CodexProvider().query(baseCodexParams());
		await session.executeCommand?.("review", "focus on auth");
		const request = writes
			.map((value) => JSON.parse(value) as Record<string, unknown>)
			.find((value) => value.method === "review/start");
		expect(request?.params).toEqual({
			threadId: "thread-1",
			target: { type: "custom", instructions: "focus on auth" },
			delivery: "inline",
		});
		session.cancel();
	});

	it("executes compact through the structured thread operation", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const session = new CodexProvider().query(baseCodexParams());
		await session.executeCommand?.("compact");
		const request = writes
			.map((value) => JSON.parse(value) as Record<string, unknown>)
			.find((value) => value.method === "thread/compact/start");
		expect(request?.params).toEqual({ threadId: "thread-1" });
		session.cancel();
	});

	it("forwards native usage from direct Computer Use commands", async () => {
		const platform = vi
			.spyOn(process, "platform", "get")
			.mockReturnValue("win32");
		vi.stubEnv("HLID_WINDOWS_COMPUTER_USE_CWD", "/tmp/hlid-computer-use-test");
		try {
			const parent = makeFakeSessionProc({
				skills: [{ name: "computer-use:computer-use" }],
			});
			const child = makeFakeSessionProc({
				skills: [{ name: "computer-use:computer-use" }],
			});
			vi.mocked(spawn)
				.mockReturnValueOnce(parent.proc as never)
				.mockReturnValueOnce(child.proc as never);
			vi.mocked(resolveCodexExecutable).mockReturnValue("C:\\bin\\codex.exe");

			const session = new CodexProvider().query(baseCodexParams());
			const events = session[Symbol.asyncIterator]();
			await session.executeCommand?.("computer-use", "Open Calculator");
			await vi.waitFor(() =>
				expect(threadStartParams(child.writes)).toHaveLength(1),
			);

			emitSessionNotification(child.proc, "item/agentMessage/delta", {
				threadId: "thread-1",
				itemId: "computer-use-result",
				delta: "Calculator op.",
			});
			emitSessionNotification(child.proc, "thread/tokenUsage/updated", {
				threadId: "thread-1",
				usage: {
					inputTokens: 120,
					cachedInputTokens: 40,
					outputTokens: 30,
				},
			});
			emitSessionNotification(child.proc, "turn/completed", {
				threadId: "thread-1",
				turn: { id: "turn-1", status: "completed" },
			});

			const done = await nextDoneEvent(events);
			expect(done).toMatchObject({
				type: "done",
				turns: 1,
				durationMs: 0,
				stopReason: "end_turn",
				usage: {
					inputTokens: 80,
					outputTokens: 30,
					cacheReadTokens: 40,
					cacheCreationTokens: 0,
				},
			});
			expect(done.estimatedCost).toBeGreaterThan(0);
			session.cancel();
		} finally {
			vi.unstubAllEnvs();
			platform.mockRestore();
		}
	});

	it("advertises the namespaced dynamic tool and slash command on Windows", async () => {
		const platform = vi
			.spyOn(process, "platform", "get")
			.mockReturnValue("win32");
		vi.stubEnv("HLID_WINDOWS_COMPUTER_USE_CWD", "/tmp/hlid-computer-use-test");
		try {
			const { proc, writes } = makeFakeSessionProc({
				skills: [
					{
						name: "computer-use:computer-use",
						description: "Control Windows apps from ChatGPT",
					},
				],
			});
			vi.mocked(spawn).mockReturnValue(proc as never);
			vi.mocked(resolveCodexExecutable).mockReturnValue("C:\\bin\\codex.exe");
			const provider = new CodexProvider();
			expect(provider.hlidToolLoading()).toContainEqual(
				expect.objectContaining({
					namespace: "hlid",
					total: HLID_AGENT_TOOL_COUNT + 1,
					deferred: HLID_AGENT_TOOL_COUNT,
					tools: expect.arrayContaining([
						{
							name: "windows_computer_use",
							delivery: "loaded",
						},
					]),
				}),
			);
			const session = provider.query(baseCodexParams());
			expect(await session.supportedCommands?.()).toContainEqual({
				name: "computer-use",
				description: "Run a task in a Windows-native Codex Computer Use thread",
				argumentHint: "<Windows desktop task>",
				action: "computer-use",
			});
			await session.send("hello");
			expect(threadStartParams(writes)[0].dynamicTools).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "namespace",
						name: "hlid",
						tools: expect.arrayContaining([
							expect.objectContaining({
								type: "function",
								name: "windows_computer_use",
							}),
						]),
					}),
				]),
			);
			session.cancel();
		} finally {
			vi.unstubAllEnvs();
			platform.mockRestore();
		}
	});

	it("bridges Visualize from a WSL-backed Codex session into an inline attachment", async () => {
		const platform = vi
			.spyOn(process, "platform", "get")
			.mockReturnValue("win32");
		try {
			const { skillPath, parent, modelCatalog, child } =
				configureVisualizeBridgeProcesses();

			const session = new CodexProvider().query(
				baseCodexParams({
					executable: "C:\\bin\\codex-wsl.cmd",
					hostSessionId: "hlid-session-1",
				}),
			);
			const events = session[Symbol.asyncIterator]();
			await session.send("Show me the system flow");
			expect(
				(
					threadStartParams(parent.writes)[0].dynamicTools as Array<{
						name: string;
						tools?: Array<{ name: string }>;
					}>
				)
					.find((namespace) => namespace.name === "hlid")
					?.tools?.map((tool) => tool.name),
			).toContain("create_visualization");
			expect(vi.mocked(spawn).mock.calls[0]?.[0]).toBe(
				"C:\\bin\\codex-wsl.cmd",
			);
			expect(vi.mocked(spawn).mock.calls[1]?.[0]).toBe("C:\\bin\\codex.exe");

			emitVisualizeToolRequest(
				parent.proc,
				96,
				"visualize-call-1",
				"Show the system flow",
			);

			await vi.waitFor(() =>
				expect(threadStartParams(child.writes)).toHaveLength(1),
			);
			expect(threadStartParams(child.writes)[0]).toMatchObject({
				cwd: "/tmp/hlid-visualization-job",
				ephemeral: true,
				runtimeWorkspaceRoots: ["/tmp/hlid-visualization-job"],
				approvalPolicy: "never",
				sandbox: "workspace-write",
				dynamicTools: [],
			});
			expect(turnStartParams(child.writes)[0]).toMatchObject({
				input: [
					{
						type: "skill",
						name: "visualize:visualize",
						path: skillPath,
					},
					expect.objectContaining({
						type: "text",
						text: expect.stringContaining("Show the system flow"),
					}),
				],
				runtimeWorkspaceRoots: ["/tmp/hlid-visualization-job"],
				approvalPolicy: "never",
				sandboxPolicy: {
					type: "workspaceWrite",
					writableRoots: ["/tmp/hlid-visualization-job"],
					networkAccess: false,
					excludeTmpdirEnvVar: true,
					excludeSlashTmp: true,
				},
			});
			const visualizeInput = turnStartParams(child.writes)[0]?.input as
				| Array<{ type?: string; text?: string }>
				| undefined;
			const visualizePrompt = visualizeInput?.find(
				(item) => item.type === "text",
			)?.text;
			expect(visualizePrompt).toContain("Never use touch-action: none");
			expect(visualizePrompt).toContain("down to 320px");
			expect(visualizePrompt).toContain(
				"Create the fragment directly with apply_patch",
			);
			expect(visualizePrompt).toContain("Do not call exec_command");

			child.proc.stdout.emit(
				"data",
				Buffer.from(
					`${JSON.stringify({
						id: 95,
						method: "item/permissions/requestApproval",
						params: {
							threadId: "thread-1",
							permissions: {
								network: true,
								writableRoots: ["C:\\Users\\test"],
							},
						},
					})}\n`,
				),
			);
			await vi.waitFor(() =>
				expect(
					child.writes
						.map((line) => JSON.parse(line))
						.find((message) => message.id === 95)?.result,
				).toEqual({ scope: "turn", permissions: {} }),
			);

			emitSessionNotification(child.proc, "item/agentMessage/delta", {
				threadId: "thread-1",
				itemId: "visualize-result",
				delta: '::codex-inline-vis{file="system-flow.html"}',
			});
			emitSessionNotification(child.proc, "thread/tokenUsage/updated", {
				threadId: "thread-1",
				usage: {
					inputTokens: 120,
					cachedInputTokens: 40,
					outputTokens: 30,
				},
			});
			emitSessionNotification(child.proc, "turn/completed", {
				threadId: "thread-1",
				turn: { id: "turn-1", status: "completed" },
			});

			let response:
				| {
						result?: {
							success?: boolean;
							contentItems?: Array<{ text?: string }>;
						};
				  }
				| undefined;
			await vi.waitFor(() => {
				response = parent.writes
					.map(
						(line) =>
							JSON.parse(line) as {
								id?: number;
								result?: {
									success?: boolean;
									contentItems?: Array<{ text?: string }>;
								};
							},
					)
					.find((message) => message.id === 96);
				expect(response?.result?.success).toBe(true);
			});
			const marker = response?.result?.contentItems?.[0]?.text as string;
			expect(marker.length).toBeLessThanOrEqual(256);
			expect(marker).not.toContain("codex-inline-vis");
			expect(JSON.parse(marker)).toEqual({
				type: "hlid_visualization",
				attachment_id: "visualization-attachment-1",
				filename: "visualization.html",
				title: "System Flow",
			});
			expect(extractWindowsVisualizeArtifact).toHaveBeenCalledWith({
				text: '::codex-inline-vis{file="system-flow.html"}',
				jobRoot: "/tmp/hlid-visualization-job",
			});
			expect(createWindowsVisualizeRenderInput).toHaveBeenCalledWith({
				sourcePath: "/tmp/hlid-visualization-job/system-flow.html",
				jobRoot: "/tmp/hlid-visualization-job",
				validatedSha256: "a".repeat(64),
			});
			expect(runBoundedProcess).toHaveBeenCalledWith(
				"python",
				expect.arrayContaining([
					"C:\\Users\\test\\.codex\\plugins\\cache\\openai-bundled\\visualize\\1.0.16\\skills\\visualize\\scripts\\render.py",
					"/tmp/hlid-visualization-job/.hlid-visualize-render-input.html",
					"/tmp/hlid-visualization-job/visualization-rendered.html",
				]),
				expect.objectContaining({ cwd: "/tmp/hlid-visualization-job" }),
			);
			expect(ingestVisualizationHtml).toHaveBeenCalledWith({
				sourcePath: "/tmp/hlid-visualization-job/visualization-rendered.html",
				sessionId: "hlid-session-1",
				title: "visualization",
				agentCwd: "/tmp/codex-test",
			});
			expect(child.proc.kill).toHaveBeenCalledOnce();
			expect(modelCatalog.proc.kill).toHaveBeenCalledOnce();

			emitSessionNotification(parent.proc, "item/completed", {
				threadId: "thread-1",
				item: {
					id: "visualize-call-1",
					type: "dynamicToolCall",
					tool: "create_visualization",
					status: "completed",
					contentItems: [{ type: "inputText", text: marker }],
					success: true,
				},
			});
			emitSessionNotification(parent.proc, "item/agentMessage/delta", {
				threadId: "thread-1",
				itemId: "parent-result",
				delta: "Here is the system flow.",
			});
			emitSessionNotification(parent.proc, "thread/tokenUsage/updated", {
				threadId: "thread-1",
				usage: {
					inputTokens: 50,
					cachedInputTokens: 20,
					outputTokens: 10,
				},
			});
			emitSessionNotification(parent.proc, "turn/completed", {
				threadId: "thread-1",
				turn: { id: "turn-1", status: "completed" },
			});
			expect(await nextDoneEvent(events)).toMatchObject({
				type: "done",
				turns: 2,
				usage: {
					inputTokens: 110,
					outputTokens: 40,
					cacheReadTokens: 60,
					cacheCreationTokens: 0,
				},
			});
			session.cancel();
		} finally {
			vi.unstubAllEnvs();
			platform.mockRestore();
		}
	});

	it("does not expose the Visualize bridge through another Codex-protocol provider", async () => {
		const platform = vi
			.spyOn(process, "platform", "get")
			.mockReturnValue("win32");
		try {
			vi.mocked(readFile).mockResolvedValue(
				'[plugins."visualize@openai-bundled"]\nenabled = true\n',
			);
			vi.mocked(resolveCodexExecutable).mockReturnValue("C:\\bin\\codex.exe");
			const parent = makeFakeSessionProc();
			vi.mocked(spawn).mockReturnValue(parent.proc as never);
			const provider = new CodexProvider({
				providerId: "cliproxy-codex",
				label: "Codex · CLIProxy",
			});

			await expect(provider.hostCapabilities()).resolves.toMatchObject({
				windowsVisualize: {
					available: false,
					reason: "The Hlid Visualize bridge is available only to Codex",
				},
			});
			expect(
				provider
					.hlidToolLoading()
					.flatMap((namespace) => namespace.tools)
					.map((tool) => tool?.name),
			).not.toContain("create_visualization");

			const session = provider.query(baseCodexParams());
			await session.send("hello");
			const hlidNamespace = (
				threadStartParams(parent.writes)[0].dynamicTools as Array<{
					name: string;
					tools?: Array<{ name: string }>;
				}>
			).find((namespace) => namespace.name === "hlid");
			expect(hlidNamespace?.tools?.map((tool) => tool.name)).not.toContain(
				"create_visualization",
			);
			expect(spawn).toHaveBeenCalledTimes(1);
			session.cancel();
		} finally {
			platform.mockRestore();
		}
	});

	it.each([
		"failed",
		"interrupted",
	] as const)("rejects a %s Visualize turn without returning its raw directive", async (status) => {
		const platform = vi
			.spyOn(process, "platform", "get")
			.mockReturnValue("win32");
		try {
			const { parent, child } = configureVisualizeBridgeProcesses();
			const session = new CodexProvider().query(
				baseCodexParams({
					executable: "C:\\bin\\codex-wsl.cmd",
					hostSessionId: "hlid-session-1",
				}),
			);
			await session.send("Show me the system flow");
			emitVisualizeToolRequest(
				parent.proc,
				98,
				`visualize-call-${status}`,
				"Show the system flow",
			);
			await vi.waitFor(() =>
				expect(turnStartParams(child.writes)).toHaveLength(1),
			);
			emitSessionNotification(child.proc, "item/agentMessage/delta", {
				threadId: "thread-1",
				itemId: "visualize-result",
				delta: '::codex-inline-vis{file="system-flow.html"}',
			});
			emitSessionNotification(child.proc, "turn/completed", {
				threadId: "thread-1",
				turn: { id: "turn-1", status },
			});

			let response:
				| {
						result?: {
							success?: boolean;
							contentItems?: Array<{ text?: string }>;
						};
				  }
				| undefined;
			await vi.waitFor(() => {
				response = parent.writes
					.map(
						(line) =>
							JSON.parse(line) as {
								id?: number;
								result?: {
									success?: boolean;
									contentItems?: Array<{ text?: string }>;
								};
							},
					)
					.find((message) => message.id === 98);
				expect(response?.result?.success).toBe(false);
			});
			expect(response?.result?.contentItems?.[0]?.text).toBe(
				"Hlid could not create the visualization.",
			);
			expect(response?.result?.contentItems?.[0]?.text).not.toContain(
				"codex-inline-vis",
			);
			expect(extractWindowsVisualizeArtifact).not.toHaveBeenCalled();
			expect(ingestVisualizationHtml).not.toHaveBeenCalled();
			session.cancel();
		} finally {
			vi.unstubAllEnvs();
			platform.mockRestore();
		}
	});

	it("settles a crashed Visualize worker and preserves its reported usage", async () => {
		const platform = vi
			.spyOn(process, "platform", "get")
			.mockReturnValue("win32");
		try {
			const { parent, child } = configureVisualizeBridgeProcesses();
			const session = new CodexProvider().query(
				baseCodexParams({
					executable: "C:\\bin\\codex-wsl.cmd",
					hostSessionId: "hlid-session-1",
				}),
			);
			const events = session[Symbol.asyncIterator]();
			await session.send("Show me the system flow");
			emitVisualizeToolRequest(
				parent.proc,
				97,
				"visualize-call-crash",
				"Show the system flow",
			);
			await vi.waitFor(() =>
				expect(turnStartParams(child.writes)).toHaveLength(1),
			);

			emitSessionNotification(child.proc, "thread/tokenUsage/updated", {
				threadId: "thread-1",
				usage: {
					inputTokens: 120,
					cachedInputTokens: 40,
					outputTokens: 30,
				},
			});
			child.proc.emit("exit", 1);

			let response:
				| {
						result?: {
							success?: boolean;
							contentItems?: Array<{ text?: string }>;
						};
				  }
				| undefined;
			await vi.waitFor(() => {
				response = parent.writes
					.map(
						(line) =>
							JSON.parse(line) as {
								id?: number;
								result?: {
									success?: boolean;
									contentItems?: Array<{ text?: string }>;
								};
							},
					)
					.find((message) => message.id === 97);
				expect(response?.result?.success).toBe(false);
			});
			expect(response?.result?.contentItems?.[0]?.text).toBe(
				"Hlid could not create the visualization.",
			);
			expect(extractWindowsVisualizeArtifact).not.toHaveBeenCalled();
			expect(ingestVisualizationHtml).not.toHaveBeenCalled();

			emitSessionNotification(parent.proc, "item/completed", {
				threadId: "thread-1",
				item: {
					id: "visualize-call-crash",
					type: "dynamicToolCall",
					tool: "create_visualization",
					status: "failed",
					contentItems: response?.result?.contentItems ?? [],
					success: false,
				},
			});
			emitSessionNotification(parent.proc, "thread/tokenUsage/updated", {
				threadId: "thread-1",
				usage: {
					inputTokens: 50,
					cachedInputTokens: 20,
					outputTokens: 10,
				},
			});
			emitSessionNotification(parent.proc, "turn/completed", {
				threadId: "thread-1",
				turn: { id: "turn-1", status: "completed" },
			});

			expect(await nextDoneEvent(events)).toMatchObject({
				type: "done",
				turns: 2,
				usage: {
					inputTokens: 110,
					outputTokens: 40,
					cacheReadTokens: 60,
					cacheCreationTokens: 0,
				},
			});
			session.cancel();
		} finally {
			vi.unstubAllEnvs();
			platform.mockRestore();
		}
	});

	it("executes an Obsidian dynamic tool through Hlid's shared handler", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const session = new CodexProvider().query(baseCodexParams());
		await session.send("inspect backlinks");
		expect(turnStartParams(writes)[0].additionalContext).toEqual({
			hlid: {
				kind: "application",
				value: expect.stringContaining("operating contract"),
			},
			hlid_obsidian: {
				kind: "application",
				value: expect.stringContaining(
					"Use these tools instead of shell or filesystem operations",
				),
			},
		});
		const obsidianNamespace = (
			threadStartParams(writes)[0].dynamicTools as Array<{
				name: string;
				description: string;
				tools: Array<{
					name: string;
					deferLoading?: boolean;
					inputSchema: { properties: Record<string, unknown> };
				}>;
			}>
		).find((tool) => tool.name === "hlid_obsidian");
		expect(obsidianNamespace?.description).toContain(
			"Use these tools instead of shell or filesystem operations",
		);
		expect(
			obsidianNamespace?.tools.find((tool) => tool.name === "tasks")
				?.inputSchema.properties,
		).toMatchObject({
			limit: { type: "integer", minimum: 1, maximum: 200 },
			countOnly: { type: "boolean" },
		});
		expect(
			obsidianNamespace?.tools.every((tool) => tool.deferLoading === true),
		).toBe(true);
		expect(
			obsidianNamespace?.tools.find((tool) => tool.name === "search")
				?.inputSchema.properties,
		).toMatchObject({
			query: { type: "string" },
			context: { type: "boolean" },
			limit: { type: "integer", minimum: 1, maximum: 200 },
			countOnly: { type: "boolean" },
		});
		expect(
			obsidianNamespace?.tools.find((tool) => tool.name === "create_note")
				?.inputSchema.properties,
		).toMatchObject({
			path: { type: "string" },
			template: { type: "string" },
			content: { type: "string" },
		});
		proc.stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					id: 92,
					method: "item/tool/call",
					params: {
						threadId: "thread-1",
						callId: "obsidian-1",
						namespace: "hlid_obsidian",
						tool: "links",
						arguments: { kind: "backlinks", path: "Notes/One.md" },
					},
				})}\n`,
			),
		);
		await vi.waitFor(() =>
			expect(
				writes
					.map((line) => JSON.parse(line))
					.find((message) => message.id === 92)?.result,
			).toMatchObject({
				success: true,
				contentItems: [{ type: "inputText", text: "obsidian result" }],
			}),
		);
		expect(executeObsidianAgentTool).toHaveBeenCalledWith("links", {
			kind: "backlinks",
			path: "Notes/One.md",
		});
		session.cancel();
	});

	it("publishes a generated Relic through the deferred Hlid tool", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		vi.mocked(executeHlidAgentToolRich).mockResolvedValueOnce({
			text: JSON.stringify({
				id: "relic-1",
				open_url: "/api/attachments/relic-1/raw",
			}),
		});
		const canUseTool = vi.fn().mockResolvedValue({ behavior: "allow" });
		const session = new CodexProvider().query(
			baseCodexParams({
				canUseTool,
				hostSessionId: "host-session-1",
			}),
		);
		await session.send("publish the report");
		const hlidNamespace = (
			threadStartParams(writes)[0].dynamicTools as Array<{
				name: string;
				tools: Array<{
					name: string;
					deferLoading?: boolean;
					inputSchema?: {
						properties?: { topic?: { enum?: string[] } };
					};
				}>;
			}>
		).find((tool) => tool.name === "hlid");
		const hlidHelp = hlidNamespace?.tools.find(
			(tool) => tool.name === "hlid_help",
		);
		expect(hlidHelp).toMatchObject({
			name: "hlid_help",
			deferLoading: true,
		});
		expect(hlidHelp?.inputSchema?.properties?.topic?.enum).toEqual([
			...HLID_HELP_TOPICS,
		]);
		expect(hlidHelp?.inputSchema?.properties?.topic?.enum).toContain(
			"orchestration",
		);
		expect(hlidNamespace?.tools).toContainEqual(
			expect.objectContaining({
				name: "publish_relic",
				deferLoading: true,
			}),
		);

		proc.stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					id: 96,
					method: "item/tool/call",
					params: {
						threadId: "thread-1",
						callId: "publish-1",
						namespace: "hlid",
						tool: "publish_relic",
						arguments: { source_path: "reports/review.pdf" },
					},
				})}\n`,
			),
		);
		await vi.waitFor(() =>
			expect(
				writes
					.map((line) => JSON.parse(line))
					.find((message) => message.id === 96)?.result,
			).toMatchObject({ success: true }),
		);
		expect(canUseTool).toHaveBeenCalledWith(
			"mcp__hlid__publish_relic",
			{ source_path: "reports/review.pdf" },
			expect.objectContaining({
				toolUseID: "publish-1",
				title: "Hlid publish Relic",
			}),
		);
		expect(executeHlidAgentToolRich).toHaveBeenCalledWith(
			"publish_relic",
			{ source_path: "reports/review.pdf" },
			expect.objectContaining({
				providerId: "codex",
				model: "gpt-5.4",
				permissionMode: "default",
				runtimeCwd: "/tmp/codex-test",
				sessionId: "host-session-1",
			}),
		);
		vi.mocked(executeHlidAgentToolRich).mockResolvedValueOnce({
			text: '{"viewport":"mobile"}',
			images: [{ data: "AQID", mimeType: "image/png" }],
		});
		proc.stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					id: 97,
					method: "item/tool/call",
					params: {
						threadId: "thread-1",
						callId: "capture-1",
						namespace: "hlid",
						tool: "capture_project_preview",
						arguments: { viewport: "mobile" },
					},
				})}\n`,
			),
		);
		await vi.waitFor(() =>
			expect(
				writes
					.map((line) => JSON.parse(line))
					.find((message) => message.id === 97)?.result,
			).toEqual({
				success: true,
				contentItems: [
					{ type: "inputText", text: '{"viewport":"mobile"}' },
					{ type: "inputImage", imageUrl: "data:image/png;base64,AQID" },
				],
			}),
		);
		expect(canUseTool).toHaveBeenCalledTimes(1);
		vi.mocked(executeHlidAgentToolRich).mockResolvedValueOnce({
			text: '{"last_action":"click"}',
			images: [{ data: "BAUG", mimeType: "image/png" }],
		});
		proc.stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					id: 98,
					method: "item/tool/call",
					params: {
						threadId: "thread-1",
						callId: "control-1",
						namespace: "hlid",
						tool: "control_project_preview",
						arguments: {
							action: "click",
							frame_id: "e16b1643-591f-4d67-8c22-9df105659385",
							ref: "e1",
						},
					},
				})}\n`,
			),
		);
		await vi.waitFor(() =>
			expect(
				writes
					.map((line) => JSON.parse(line))
					.find((message) => message.id === 98)?.result,
			).toEqual({
				success: true,
				contentItems: [
					{ type: "inputText", text: '{"last_action":"click"}' },
					{ type: "inputImage", imageUrl: "data:image/png;base64,BAUG" },
				],
			}),
		);
		expect(canUseTool).toHaveBeenLastCalledWith(
			"mcp__hlid__control_project_preview",
			expect.objectContaining({ action: "click", ref: "e1" }),
			expect.objectContaining({
				toolUseID: "control-1",
				title: "Hlid control Project Preview",
			}),
		);
		session.cancel();
	});

	it("routes Obsidian note writes through Hlid approval", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const canUseTool = vi.fn().mockResolvedValue({ behavior: "allow" });
		const session = new CodexProvider().query(baseCodexParams({ canUseTool }));
		await session.send("create a note");
		proc.stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					id: 93,
					method: "item/tool/call",
					params: {
						threadId: "thread-1",
						callId: "obsidian-write-1",
						namespace: "hlid_obsidian",
						tool: "create_note",
						arguments: {
							path: "0 Inbox/One.md",
							template: "New Note",
						},
					},
				})}\n`,
			),
		);
		await vi.waitFor(() =>
			expect(
				writes
					.map((line) => JSON.parse(line))
					.find((message) => message.id === 93)?.result,
			).toMatchObject({ success: true }),
		);
		expect(canUseTool).toHaveBeenCalledWith(
			"mcp__hlid_obsidian__create_note",
			{ path: "0 Inbox/One.md", template: "New Note" },
			expect.objectContaining({
				toolUseID: "obsidian-write-1",
				title: "Obsidian create note",
			}),
		);
		expect(executeObsidianAgentTool).toHaveBeenCalledWith("create_note", {
			path: "0 Inbox/One.md",
			template: "New Note",
		});
		session.cancel();
	});

	it("does not execute a denied Obsidian note write", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const canUseTool = vi.fn().mockResolvedValue({
			behavior: "deny",
			message: "Keep the vault unchanged",
		});
		const session = new CodexProvider().query(baseCodexParams({ canUseTool }));
		await session.send("create a note");
		vi.mocked(executeObsidianAgentTool).mockClear();
		proc.stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					id: 94,
					method: "item/tool/call",
					params: {
						threadId: "thread-1",
						callId: "obsidian-write-2",
						namespace: "hlid_obsidian",
						tool: "append_note",
						arguments: { target: "daily", content: "No" },
					},
				})}\n`,
			),
		);
		await vi.waitFor(() =>
			expect(
				writes
					.map((line) => JSON.parse(line))
					.find((message) => message.id === 94)?.result,
			).toMatchObject({
				success: false,
				contentItems: [{ type: "inputText", text: "Keep the vault unchanged" }],
			}),
		);
		expect(executeObsidianAgentTool).not.toHaveBeenCalled();
		session.cancel();
	});

	it("still requests exact Obsidian command approval in bypass mode", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const canUseTool = vi.fn().mockResolvedValue({
			behavior: "deny",
			message: "Command needs approval",
		});
		const session = new CodexProvider().query(
			baseCodexParams({
				canUseTool,
				permissionMode: "bypassPermissions",
			}),
		);
		await session.send("run an Obsidian command");
		vi.mocked(executeObsidianAgentTool).mockClear();
		proc.stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					id: 95,
					method: "item/tool/call",
					params: {
						threadId: "thread-1",
						callId: "obsidian-command-1",
						namespace: "hlid_obsidian",
						tool: "run_command",
						arguments: { id: "app:toggle-left-sidebar" },
					},
				})}\n`,
			),
		);
		await vi.waitFor(() =>
			expect(
				writes
					.map((line) => JSON.parse(line))
					.find((message) => message.id === 95)?.result,
			).toMatchObject({
				success: false,
				contentItems: [{ type: "inputText", text: "Command needs approval" }],
			}),
		);
		expect(canUseTool).toHaveBeenCalledWith(
			"mcp__hlid_obsidian__run_command",
			{ id: "app:toggle-left-sidebar" },
			expect.objectContaining({ toolUseID: "obsidian-command-1" }),
		);
		expect(executeObsidianAgentTool).not.toHaveBeenCalled();
		session.cancel();
	});

	it("runs Hlid-owned Computer Use workers as ephemeral native threads", async () => {
		const platform = vi
			.spyOn(process, "platform", "get")
			.mockReturnValue("win32");
		vi.stubEnv("HLID_WINDOWS_COMPUTER_USE_CWD", "/tmp/hlid-computer-use-test");
		try {
			const parent = makeFakeSessionProc({
				skills: [{ name: "computer-use:computer-use" }],
			});
			const child = makeFakeSessionProc({
				skills: [{ name: "computer-use:computer-use" }],
			});
			vi.mocked(spawn)
				.mockReturnValueOnce(parent.proc as never)
				.mockReturnValueOnce(child.proc as never);
			vi.mocked(resolveCodexExecutable).mockReturnValue("C:\\bin\\codex.exe");
			const canUseTool = vi
				.fn()
				.mockResolvedValue({ behavior: "allow", saveScope: "session" });
			const session = new CodexProvider().query(
				baseCodexParams({ canUseTool }),
			);
			const events = session[Symbol.asyncIterator]();
			await session.send("delegate to Computer Use");
			expect(await nextSessionEvent(events)).toMatchObject({
				type: "session_start",
				sessionId: "thread-1",
			});

			parent.proc.stdout.emit(
				"data",
				Buffer.from(
					`${JSON.stringify({
						id: 82,
						method: "item/tool/call",
						params: {
							threadId: "thread-1",
							callId: "computer-use-1",
							namespace: "hlid",
							tool: "windows_computer_use",
							arguments: { task: "Open Calculator" },
						},
					})}\n`,
				),
			);

			await vi.waitFor(() =>
				expect(threadStartParams(child.writes)).toHaveLength(1),
			);
			expect(threadStartParams(child.writes)[0]).toMatchObject({
				cwd: "/tmp/hlid-computer-use-test",
				ephemeral: true,
				threadSource: "user",
			});

			child.proc.stdout.emit(
				"data",
				Buffer.from(
					`${JSON.stringify({
						id: 83,
						method: "mcpServer/elicitation/request",
						params: {
							threadId: "thread-1",
							turnId: "turn-2",
							serverName: "node_repl",
							mode: "form",
							message: "Allow Codex to use Calculator?",
							requestedSchema: {},
							_meta: {
								connector_id: "computer-use",
								tool_params: { app: "Microsoft.WindowsCalculator" },
								tool_params_display: [
									{
										display_name: "App",
										name: "app",
										value: "Calculator",
									},
								],
							},
						},
					})}\n`,
				),
			);
			await vi.waitFor(() => {
				expect(canUseTool).toHaveBeenCalledWith(
					"hlid.windows_computer_use:Microsoft.WindowsCalculator",
					expect.objectContaining({
						task: "Open Calculator",
						appName: "Calculator",
					}),
					expect.objectContaining({
						description: expect.stringContaining(
							"Desktop task: Open Calculator",
						),
					}),
				);
				const response = child.writes
					.map((line) => JSON.parse(line))
					.find((message) => message.id === 83);
				expect(response?.result?._meta).toEqual({ persist: "session" });
			});

			emitSessionNotification(child.proc, "item/completed", {
				threadId: "thread-1",
				item: {
					id: "computer-use-result",
					type: "agentMessage",
					text: "Calculator opened.",
				},
			});
			emitSessionNotification(child.proc, "thread/tokenUsage/updated", {
				threadId: "thread-1",
				usage: {
					inputTokens: 120,
					cachedInputTokens: 40,
					outputTokens: 30,
				},
			});
			emitSessionNotification(child.proc, "turn/completed", {
				threadId: "thread-1",
				turn: {
					id: "turn-2",
					status: "completed",
					itemsView: "summary",
					items: [
						{
							id: "computer-use-result",
							type: "agentMessage",
							text: "Calculator opened.",
							phase: "final_answer",
						},
					],
				},
			});

			await vi.waitFor(() => {
				const response = parent.writes
					.map((line) => JSON.parse(line))
					.find((message) => message.id === 82);
				expect(response?.result).toMatchObject({
					success: true,
					contentItems: [
						{
							type: "inputText",
							text: expect.stringMatching(/Calculator opened\.$/),
						},
					],
				});
			});
			emitSessionNotification(parent.proc, "thread/tokenUsage/updated", {
				threadId: "thread-1",
				usage: {
					inputTokens: 50,
					cachedInputTokens: 20,
					outputTokens: 10,
				},
			});
			emitSessionNotification(parent.proc, "turn/completed", {
				threadId: "thread-1",
				turn: { id: "turn-1", status: "completed" },
			});
			expect(await nextDoneEvent(events)).toMatchObject({
				type: "done",
				turns: 2,
				usage: {
					inputTokens: 110,
					outputTokens: 40,
					cacheReadTokens: 60,
					cacheCreationTokens: 0,
				},
			});
			expect(
				child.writes
					.map((line) => JSON.parse(line))
					.find((message) => message.method === "mcpServer/tool/call")?.params,
			).toEqual({
				threadId: "thread-1",
				server: "node_repl",
				tool: "js_reset",
				arguments: {},
			});
			expect(child.proc.kill).toHaveBeenCalledOnce();
			expect(parent.proc.kill).not.toHaveBeenCalled();
			session.cancel();
		} finally {
			vi.unstubAllEnvs();
			platform.mockRestore();
		}
	});
});

describe("CodexAgentSession — usage windows", () => {
	beforeEach(() => {
		__resetCodexAppServersForTesting();
	});

	it("reads and maps both rolling Codex windows", async () => {
		const { proc } = makeFakeSessionProc({
			rateLimits: {
				primary: {
					usedPercent: 25,
					windowDurationMins: 300,
					resetsAt: 1_800_000_000,
				},
				secondary: {
					usedPercent: 15,
					windowDurationMins: 10_080,
					resetsAt: 1_800_600_000,
				},
			},
		});
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		expect(await session.usageWindows?.()).toEqual([
			{
				windowId: "five_hour",
				label: "5-HOUR",
				utilization: 0.25,
				resetsAt: 1_800_000_000,
				remaining: null,
				limit: null,
			},
			{
				windowId: "weekly",
				label: "7-DAY",
				utilization: 0.15,
				resetsAt: 1_800_600_000,
				remaining: null,
				limit: null,
			},
		]);
		session.cancel();
	});

	it("maps workspace spend control usage as its own provider window", async () => {
		const { proc } = makeFakeSessionProc({
			rateLimits: {
				individualLimit: {
					limit: "100",
					used: "75.5",
					remainingPercent: 24.5,
					resetsAt: 1_800_600_000_000,
				},
				spendControlReached: false,
			},
		});
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		expect(await session.usageWindows?.()).toEqual([
			{
				windowId: "spend_control",
				label: "SPEND",
				utilization: 0.755,
				remaining: 24.5,
				limit: 100,
				resetsAt: 1_800_600_000,
			},
		]);
		session.cancel();
	});

	it("uses the reported duration when Codex returns only a weekly primary", async () => {
		const { proc } = makeFakeSessionProc({
			rateLimits: {
				primary: {
					usedPercent: 15,
					windowDurationMins: 10_080,
					resetsAt: 1_800_600_000_000,
				},
				secondary: null,
			},
		});
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		expect(await session.usageWindows?.()).toEqual([
			{
				windowId: "weekly",
				label: "7-DAY",
				utilization: 0.15,
				resetsAt: 1_800_600_000,
				remaining: null,
				limit: null,
			},
		]);
		session.cancel();
	});

	it("does not surface a read superseded by a native rate-limit update", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		const events = session[Symbol.asyncIterator]();
		const reading = session.usageWindows?.();
		if (!reading) throw new Error("Codex usage windows unavailable");
		await vi.waitFor(() => {
			expect(
				writes
					.map((line) => JSON.parse(line) as { id?: number; method?: string })
					.filter((message) => message.method === "account/rateLimits/read"),
			).toHaveLength(1);
		});
		const request = writes
			.map((line) => JSON.parse(line) as { id?: number; method?: string })
			.filter((message) => message.method === "account/rateLimits/read")
			.at(-1);

		emitSessionNotification(proc, "account/rateLimits/updated", {
			rateLimits: {
				primary: {
					usedPercent: 34,
					windowDurationMins: 10_080,
					resetsAt: 1_800_600_000,
				},
			},
		});
		emitSessionResponse(proc, request?.id ?? 0, {
			rateLimits: {
				primary: {
					usedPercent: 27,
					windowDurationMins: 10_080,
					resetsAt: 1_800_600_000,
				},
			},
		});

		await expect(reading).resolves.toEqual([]);
		expect(await nextSessionEvent(events)).toEqual({
			type: "session_start",
			sessionId: "thread-1",
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "rate_limit",
			status: "ok",
			rateLimitType: "weekly",
			utilization: 0.34,
			resetsAt: 1_800_600_000,
		});
		session.cancel();
		await expect(events.next()).resolves.toEqual({
			value: undefined,
			done: true,
		});
	});
});

describe("CodexAgentSession — steering", () => {
	beforeEach(() => {
		__resetCodexAppServersForTesting();
	});

	it("appends input to the active turn through turn/steer", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const session = new CodexProvider().query(baseCodexParams());

		await session.send("start the work");
		await session.steer?.("focus on the parser");

		const request = writes
			.map((value) => JSON.parse(value) as Record<string, unknown>)
			.find((value) => value.method === "turn/steer");
		expect(request?.params).toEqual({
			threadId: "thread-1",
			expectedTurnId: "turn-1",
			input: [
				{
					type: "text",
					text: "focus on the parser",
					text_elements: [],
				},
			],
		});
		session.cancel();
	});
});

describe("CodexAgentSession — setModel", () => {
	beforeEach(() => {
		__resetCodexAppServersForTesting();
	});

	it("changes the model carried by the next turn/start call", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const provider = new CodexProvider();
		const session = provider.query(baseCodexParams());

		await session.send("hello");
		await session.setModel?.("gpt-5.5");
		await session.send("hello again");

		const turns = turnStartParams(writes);
		expect(turns).toHaveLength(2);
		expect(turns[0].model).toBe("gpt-5.4");
		expect(turns[1].model).toBe("gpt-5.5");
	});

	it("keeps model-less usage attributed to the active turn after selecting the next model", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		const events = session[Symbol.asyncIterator]();
		await session.send("use the current model");
		expect(await nextSessionEvent(events)).toEqual({
			type: "session_start",
			sessionId: "thread-1",
		});

		await session.setModel?.("gpt-5.5");
		emitSessionNotification(proc, "thread/tokenUsage/updated", {
			threadId: "thread-1",
			usage: {
				inputTokens: 12,
				outputTokens: 7,
				cacheReadTokens: 3,
			},
		});

		expect(await nextSessionEvent(events)).toMatchObject({
			type: "usage",
			model: "gpt-5.4",
		});

		session.closeInput?.();
		emitSessionNotification(proc, "turn/completed", {
			threadId: "thread-1",
			turn: { id: "turn-1", status: "completed" },
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "done",
			estimatedCost: 0.00012825,
		});
	});

	it("carries a catalog-selected service tier into the thread and turn", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(
			baseCodexParams({ serviceTier: "fast" }),
		);
		await session.send("Run with priority processing");

		expect(threadStartParams(writes)[0]?.serviceTier).toBe("fast");
		expect(turnStartParams(writes)[0]?.serviceTier).toBe("fast");
		session.cancel();
	});

	it("includes local audio paths as native Codex turn input", async () => {
		const { proc, writes } = makeFakeSessionProc({
			modelListResult: {
				data: [
					{
						id: "gpt-5.4",
						model: "gpt-5.4",
						displayName: "GPT-5.4",
						inputModalities: ["text", "image", "audio"],
					},
				],
			},
		});
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const session = new CodexProvider().query(baseCodexParams());

		await session.send("Voice message", {
			audioPaths: ["/tmp/voice-message.wav"],
		});

		expect(turnStartParams(writes)[0].input).toEqual([
			{ type: "text", text: "Voice message", text_elements: [] },
			{ type: "localAudio", path: "/tmp/voice-message.wav" },
		]);
		session.cancel();
	});

	it("rejects audio before turn/start when the active model is text-only", async () => {
		const { proc, writes } = makeFakeSessionProc({ threadModel: "gpt-5.5" });
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const session = new CodexProvider().query(baseCodexParams());

		await expect(
			session.send("Voice message", {
				audioPaths: ["/tmp/voice-message.wav"],
			}),
		).rejects.toThrow(
			"GPT-5.5 does not support audio input. Use Dictate with Whisper",
		);
		expect(turnStartParams(writes)).toEqual([]);
		session.cancel();
	});

	it("omits `model` from the next turn/start call when reset to undefined", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const provider = new CodexProvider();
		const session = provider.query(baseCodexParams());

		await session.send("hello");
		await session.setModel?.(undefined);
		await session.send("hello again");

		const turns = turnStartParams(writes);
		expect(turns[0].model).toBe("gpt-5.4");
		expect(turns[1].model).toBeUndefined();
	});

	it("does not send an empty collaboration model before one is resolved", async () => {
		const { proc, writes } = makeFakeSessionProc({ threadModel: null });
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const session = new CodexProvider().query(
			baseCodexParams({ model: undefined, effort: "medium" }),
		);

		await session.send("hello");

		const [turn] = turnStartParams(writes);
		expect(turn.model).toBeUndefined();
		expect(turn.effort).toBe("medium");
		expect(turn.collaborationMode).toBeUndefined();
	});
});

describe("CodexAgentSession — shared transport recovery", () => {
	beforeEach(() => {
		__resetCodexAppServersForTesting();
	});

	it("reacquires the app-server and resumes the thread after an idle process exit", async () => {
		const first = makeFakeSessionProc();
		const replacement = makeFakeSessionProc();
		vi.mocked(spawn)
			.mockReturnValueOnce(first.proc as never)
			.mockReturnValueOnce(replacement.proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const session = new CodexProvider().query(baseCodexParams());
		const events = session[Symbol.asyncIterator]();

		await session.send("first turn");
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "session_start",
			sessionId: "thread-1",
		});
		emitSessionNotification(first.proc, "turn/started", {
			threadId: "thread-1",
			turn: { id: "turn-1" },
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "provider_turn_id",
			id: "turn-1",
		});
		emitSessionNotification(first.proc, "turn/completed", {
			threadId: "thread-1",
			turn: { id: "turn-1", status: "completed" },
		});
		expect(await nextSessionEvent(events)).toMatchObject({ type: "done" });

		first.proc.emit("exit", 1);
		await session.send("second turn");

		const replacementMessages = replacement.writes.map(
			(value) => JSON.parse(value) as { method?: string; params?: unknown },
		);
		expect(replacementMessages.map((message) => message.method)).toContain(
			"thread/resume",
		);
		expect(
			replacementMessages.find((message) => message.method === "thread/resume")
				?.params,
		).toMatchObject({ threadId: "thread-1" });
		expect(turnStartParams(replacement.writes)).toHaveLength(1);
	});

	it("surfaces an active-turn app-server exit as a transport error", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const session = new CodexProvider().query(baseCodexParams());
		const events = session[Symbol.asyncIterator]();

		await session.send("working turn");
		await nextSessionEvent(events); // session_start
		emitSessionNotification(proc, "turn/started", {
			threadId: "thread-1",
			turn: { id: "turn-1" },
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "provider_turn_id",
			id: "turn-1",
		});
		proc.emit("exit", 1);

		expect(await nextSessionEvent(events)).toMatchObject({
			type: "transport_error",
			message: expect.stringContaining("disconnected during the active turn"),
		});
	});

	it("starts a fresh thread when the saved rollout no longer exists", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { proc, writes } = makeFakeSessionProc({
			missingRolloutOnResume: true,
			uniqueThreadIds: true,
		});
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const session = new CodexProvider().query({
			...baseCodexParams(),
			sessionId: "missing-thread",
		});
		const events = session[Symbol.asyncIterator]();

		await session.send("continue here");

		const methods = writes.map(
			(value) => (JSON.parse(value) as { method?: string }).method,
		);
		expect(methods).toContain("thread/resume");
		expect(methods).toContain("thread/start");
		expect(methods.indexOf("thread/resume")).toBeLessThan(
			methods.indexOf("thread/start"),
		);
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "session_start",
			sessionId: "thread-1",
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "local_command_output",
			content: expect.stringContaining("fresh provider thread"),
		});
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("starting a fresh thread"),
		);
	});
});

describe("CodexAgentSession — setPermissionMode", () => {
	beforeEach(() => {
		__resetCodexAppServersForTesting();
	});

	it("changes approvalPolicy and sandboxPolicy on the next turn/start call", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const provider = new CodexProvider();
		const session = provider.query(baseCodexParams());

		await session.send("hello");
		await session.setPermissionMode?.("bypassPermissions");
		await session.send("hello again");

		const turns = turnStartParams(writes);
		expect(turns[0].approvalPolicy).toBe("on-request");
		expect(turns[0].sandboxPolicy).toEqual(codexSandboxPolicy("default", []));
		expect(turns[1].approvalPolicy).toBe("never");
		expect(turns[1].sandboxPolicy).toEqual(
			codexSandboxPolicy("bypassPermissions", []),
		);
		expect(turns[0].collaborationMode).toMatchObject({ mode: "default" });
		expect(turns[1].collaborationMode).toMatchObject({ mode: "default" });
	});

	it("switches Codex collaboration mode into and out of plan mode", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const session = new CodexProvider().query(baseCodexParams());

		await session.setPermissionMode?.("plan");
		await session.send("plan this");
		await session.setPermissionMode?.("default");
		await session.send("implement this");

		const turns = turnStartParams(writes);
		expect(turns[0].collaborationMode).toEqual({
			mode: "plan",
			settings: {
				model: "gpt-5.4",
				reasoning_effort: null,
				developer_instructions: null,
			},
		});
		expect(turns[1].collaborationMode).toMatchObject({ mode: "default" });
	});

	it("carries xhigh effort into native Codex plan mode", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const session = new CodexProvider().query(baseCodexParams());

		await session.setEffort?.("xhigh");
		await session.setPermissionMode?.("plan");
		await session.send("plan this deeply");

		const [turn] = turnStartParams(writes);
		expect(turn).toMatchObject({
			effort: "xhigh",
			collaborationMode: {
				mode: "plan",
				settings: { reasoning_effort: "xhigh" },
			},
		});
	});
});

describe("CodexAgentSession — notifications", () => {
	beforeEach(() => {
		__resetCodexAppServersForTesting();
	});

	it("publishes goal updates through a replaceable session handler", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const initial = vi.fn();
		const replacement = vi.fn();
		const session = new CodexProvider().query(
			baseCodexParams({ onGoalChange: initial }),
		);
		await session.controlGoal?.({ action: "get" });
		session.setGoalChangeHandler?.(replacement);
		emitSessionNotification(proc, "thread/goal/updated", {
			threadId: "thread-1",
			turnId: null,
			goal: {
				threadId: "thread-1",
				objective: "Finish the release gate",
				status: "active",
				tokenBudget: null,
				tokensUsed: 10,
				timeUsedSeconds: 2,
				createdAt: 1,
				updatedAt: 2,
			},
		});
		emitSessionNotification(proc, "thread/goal/cleared", {
			threadId: "thread-1",
		});
		await vi.waitFor(() => {
			expect(replacement).toHaveBeenNthCalledWith(
				1,
				expect.objectContaining({ objective: "Finish the release gate" }),
			);
			expect(replacement).toHaveBeenNthCalledWith(2, null);
		});
		expect(initial).not.toHaveBeenCalled();
		session.cancel();
	});

	it("maps inbound notifications, preserves message boundaries, and deduplicates streamed content", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		const events = session[Symbol.asyncIterator]();
		await session.send("hello");

		expect(await nextSessionEvent(events)).toEqual({
			type: "session_start",
			sessionId: "thread-1",
		});

		emitSessionNotification(proc, "turn/started", {
			threadId: "thread-1",
			turn: { id: "turn-1" },
		});
		emitSessionNotification(proc, "item/agentMessage/delta", {
			threadId: "thread-1",
			itemId: "message-1",
			delta: "Streamed response",
		});
		emitSessionNotification(proc, "item/completed", {
			threadId: "thread-1",
			item: {
				id: "message-1",
				type: "agentMessage",
				text: "Streamed response",
			},
		});
		emitSessionNotification(proc, "item/completed", {
			threadId: "thread-1",
			item: {
				id: "message-2",
				type: "agentMessage",
				text: "Fallback response",
			},
		});
		emitSessionNotification(proc, "item/started", {
			threadId: "thread-1",
			item: { id: "reason-1", type: "reasoning", summary: "Checked state" },
		});
		emitSessionNotification(proc, "item/completed", {
			threadId: "thread-1",
			item: { id: "reason-1", type: "reasoning", summary: "Checked state" },
		});
		emitSessionNotification(proc, "item/commandExecution/outputDelta", {
			threadId: "thread-1",
			deltaBase64: Buffer.from("command output").toString("base64"),
		});
		emitSessionNotification(proc, "account/rateLimits/updated", {
			rateLimits: {
				primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 42 },
			},
		});
		emitSessionNotification(proc, "mcpServer/startupStatus/updated", {
			servers: [{ name: "filesystem" }, { status: "ignored-without-name" }],
		});
		emitSessionNotification(proc, "thread/tokenUsage/updated", {
			threadId: "thread-1",
			usage: {
				inputTokens: 12,
				outputTokens: 7,
				cacheReadTokens: 3,
				modelContextWindow: 128_000,
			},
		});
		session.closeInput?.();
		emitSessionNotification(proc, "turn/completed", {
			threadId: "thread-1",
			turn: { id: "turn-1", status: "completed" },
		});

		expect(await nextSessionEvent(events)).toEqual({
			type: "provider_turn_id",
			id: "turn-1",
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "text_delta",
			text: "Streamed response",
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "assistant_message_boundary",
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "text_delta",
			text: "Fallback response",
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "tool_start",
			toolId: "reason-1",
			name: "Reasoning",
			input: {},
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "tool_result",
			toolId: "reason-1",
			content: "Checked state",
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "local_command_output",
			content: "command output",
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "rate_limit",
			status: "ok",
			rateLimitType: "five_hour",
			utilization: 0.25,
			resetsAt: 42,
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "mcp_status",
			servers: [{ name: "filesystem", status: "pending" }],
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "usage",
			inputTokens: 9,
			outputTokens: 7,
			contextWindow: 128_000,
			cacheReadTokens: 3,
			cacheCreationTokens: undefined,
			queryUsage: {
				inputTokens: 9,
				outputTokens: 7,
				cacheReadTokens: 3,
				cacheCreationTokens: 0,
			},
			model: "gpt-5.4",
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "done",
			estimatedCost: 0.00012825,
			turns: 1,
			durationMs: 0,
			stopReason: "completed",
			usage: {
				inputTokens: 9,
				outputTokens: 7,
				cacheReadTokens: 3,
				cacheCreationTokens: 0,
			},
		});
		expect(await events.next()).toEqual({ value: undefined, done: true });
	});

	it("separates streamed assistant items without splitting chunks from one item", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		const events = session[Symbol.asyncIterator]();
		await session.send("hello");
		await nextSessionEvent(events); // session_start

		emitSessionNotification(proc, "turn/started", {
			threadId: "thread-1",
			turn: { id: "turn-1" },
		});
		emitSessionNotification(proc, "item/agentMessage/delta", {
			threadId: "thread-1",
			itemId: "message-1",
			delta: "First ",
		});
		emitSessionNotification(proc, "item/agentMessage/delta", {
			threadId: "thread-1",
			itemId: "message-1",
			delta: "update.",
		});
		emitSessionNotification(proc, "item/agentMessage/delta", {
			threadId: "thread-1",
			itemId: "message-2",
			delta: "Second update.",
		});
		emitSessionNotification(proc, "turn/completed", {
			threadId: "thread-1",
			turn: { id: "turn-1", status: "completed" },
		});

		expect(await nextSessionEvent(events)).toEqual({
			type: "provider_turn_id",
			id: "turn-1",
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "text_delta",
			text: "First ",
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "text_delta",
			text: "update.",
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "assistant_message_boundary",
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "text_delta",
			text: "Second update.",
		});
		expect(await nextSessionEvent(events)).toMatchObject({ type: "done" });
		session.cancel();
	});

	it("repairs a dropped streamed suffix from the completed-turn summary", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		const events = session[Symbol.asyncIterator]();
		await session.send("hello");
		await nextSessionEvent(events); // session_start

		emitSessionNotification(proc, "turn/started", {
			threadId: "thread-1",
			turn: { id: "turn-1" },
		});
		emitSessionNotification(proc, "item/agentMessage/delta", {
			threadId: "thread-1",
			itemId: "message-1",
			delta: "The transport kept this.",
		});
		emitSessionNotification(proc, "turn/completed", {
			threadId: "thread-1",
			turn: {
				id: "turn-1",
				status: "completed",
				itemsView: "summary",
				items: [
					{
						id: "message-1",
						type: "agentMessage",
						text: "The transport kept this. And recovered this.",
						phase: "final_answer",
					},
				],
			},
		});

		expect(await nextSessionEvent(events)).toEqual({
			type: "provider_turn_id",
			id: "turn-1",
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "text_delta",
			text: "The transport kept this.",
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "text_delta",
			text: " And recovered this.",
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "done",
			stopReason: "completed",
		});
		session.cancel();
	});

	it("replaces corrupted streamed text from the completed-turn summary", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		const events = session[Symbol.asyncIterator]();
		await session.send("hello");
		await nextSessionEvent(events); // session_start

		emitSessionNotification(proc, "turn/started", {
			threadId: "thread-1",
			turn: { id: "turn-1" },
		});
		emitSessionNotification(proc, "item/agentMessage/delta", {
			threadId: "thread-1",
			itemId: "message-1",
			delta: "The transport kept this.",
		});
		emitSessionNotification(proc, "item/agentMessage/delta", {
			threadId: "thread-1",
			itemId: "message-1",
			delta: " And this ending.",
		});
		emitSessionNotification(proc, "turn/completed", {
			threadId: "thread-1",
			turn: {
				id: "turn-1",
				status: "completed",
				itemsView: "summary",
				items: [
					{
						id: "message-1",
						type: "agentMessage",
						text: "The transport kept this. Restored the middle. And this ending.",
						phase: "final_answer",
					},
				],
			},
		});

		expect(await nextSessionEvent(events)).toEqual({
			type: "provider_turn_id",
			id: "turn-1",
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "text_delta",
			text: "The transport kept this.",
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "text_delta",
			text: " And this ending.",
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "text_replace",
			text: "The transport kept this. Restored the middle. And this ending.",
			previousText: "The transport kept this. And this ending.",
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "done",
			stopReason: "completed",
		});
		session.cancel();
	});

	it("does not duplicate a complete message repeated in turn/completed", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		const events = session[Symbol.asyncIterator]();
		await session.send("hello");
		await nextSessionEvent(events); // session_start

		emitSessionNotification(proc, "turn/started", {
			threadId: "thread-1",
			turn: { id: "turn-1" },
		});
		emitSessionNotification(proc, "item/agentMessage/delta", {
			threadId: "thread-1",
			itemId: "message-1",
			delta: "Complete response.",
		});
		emitSessionNotification(proc, "item/completed", {
			threadId: "thread-1",
			item: {
				id: "message-1",
				type: "agentMessage",
				text: "Complete response.",
			},
		});
		emitSessionNotification(proc, "turn/completed", {
			threadId: "thread-1",
			turn: {
				id: "turn-1",
				status: "completed",
				itemsView: "summary",
				items: [
					{
						id: "message-1",
						type: "agentMessage",
						text: "Complete response.",
						phase: null,
					},
				],
			},
		});

		expect(await nextSessionEvent(events)).toEqual({
			type: "provider_turn_id",
			id: "turn-1",
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "text_delta",
			text: "Complete response.",
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "done",
			stopReason: "completed",
		});
		session.cancel();
	});

	it("preserves plugin command provenance in the generic tool event", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		const events = session[Symbol.asyncIterator]();
		await session.send("run the plugin command");
		await nextSessionEvent(events); // session_start

		emitSessionNotification(proc, "item/started", {
			threadId: "thread-1",
			item: {
				id: "command-1",
				type: "commandExecution",
				command: "node scripts/review.js",
				cwd: "/tmp/project",
				pluginId: "reviewer@official",
				scriptPath: "scripts/review.js",
			},
		});

		expect(await nextSessionEvent(events)).toMatchObject({
			type: "tool_start",
			toolId: "command-1",
			input: {
				pluginId: "reviewer@official",
				scriptPath: "scripts/review.js",
			},
		});
		session.cancel();
	});

	it("marks failed completed tool items as errors", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		const events = session[Symbol.asyncIterator]();
		await session.send("move a vault note");
		await nextSessionEvent(events); // session_start

		emitSessionNotification(proc, "item/started", {
			threadId: "thread-1",
			item: {
				id: "move-1",
				type: "dynamicToolCall",
				tool: "mcp__hlid_obsidian__move_file",
				arguments: { path: "Notes/Old.md", to: "Archive/Old.md" },
			},
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "tool_start",
			toolId: "move-1",
		});

		emitSessionNotification(proc, "item/completed", {
			threadId: "thread-1",
			item: {
				id: "move-1",
				type: "dynamicToolCall",
				tool: "mcp__hlid_obsidian__move_file",
				status: "failed",
				success: false,
			},
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "tool_result",
			toolId: "move-1",
			isError: true,
		});
		session.cancel();
	});

	it("unwraps dynamic tool text results without duplicating long arguments", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		const events = session[Symbol.asyncIterator]();
		await session.send("append a long vault update");
		await nextSessionEvent(events); // session_start

		emitSessionNotification(proc, "item/started", {
			threadId: "thread-1",
			item: {
				id: "append-1",
				type: "dynamicToolCall",
				namespace: "hlid_obsidian",
				tool: "append_note",
				arguments: {
					target: "path",
					path: "Projects/Hlid.md",
					content: "x".repeat(2_000),
				},
			},
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "tool_start",
			toolId: "append-1",
		});

		emitSessionNotification(proc, "item/completed", {
			threadId: "thread-1",
			item: {
				id: "append-1",
				type: "dynamicToolCall",
				namespace: "hlid_obsidian",
				tool: "append_note",
				arguments: {
					target: "path",
					path: "Projects/Hlid.md",
					content: "x".repeat(2_000),
				},
				status: "completed",
				success: true,
				contentItems: [
					{
						type: "inputText",
						text: '{"path":"Projects/Hlid.md"}',
					},
				],
			},
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "tool_result",
			toolId: "append-1",
			content: '{"path":"Projects/Hlid.md"}',
		});
		session.cancel();
	});

	it("accounts every cumulative model-call delta while emitting last-call context", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const session = new CodexProvider().query(baseCodexParams());
		const events = session[Symbol.asyncIterator]();
		await session.send("use a couple of tools");
		await nextSessionEvent(events); // session_start

		emitSessionNotification(proc, "thread/tokenUsage/updated", {
			threadId: "thread-1",
			tokenUsage: {
				total: {
					inputTokens: 120,
					cachedInputTokens: 40,
					outputTokens: 30,
				},
				last: {
					inputTokens: 120,
					cachedInputTokens: 40,
					outputTokens: 30,
				},
				modelContextWindow: 258_400,
			},
		});
		emitSessionNotification(proc, "thread/tokenUsage/updated", {
			threadId: "thread-1",
			tokenUsage: {
				total: {
					inputTokens: 300,
					cachedInputTokens: 180,
					outputTokens: 70,
				},
				last: {
					inputTokens: 180,
					cachedInputTokens: 140,
					outputTokens: 40,
				},
				modelContextWindow: 258_400,
			},
		});
		emitSessionNotification(proc, "turn/completed", {
			threadId: "thread-1",
			turn: { id: "turn-1", status: "completed" },
		});

		expect(await nextSessionEvent(events)).toMatchObject({
			type: "usage",
			inputTokens: 80,
			outputTokens: 30,
			cacheReadTokens: 40,
			contextWindow: 258_400,
			queryUsage: {
				inputTokens: 80,
				outputTokens: 30,
				cacheReadTokens: 40,
				cacheCreationTokens: 0,
			},
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "usage",
			inputTokens: 40,
			outputTokens: 40,
			cacheReadTokens: 140,
			contextWindow: 258_400,
			queryUsage: {
				inputTokens: 120,
				outputTokens: 70,
				cacheReadTokens: 180,
				cacheCreationTokens: 0,
			},
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "done",
			usage: {
				inputTokens: 120,
				outputTokens: 70,
				cacheReadTokens: 180,
				cacheCreationTokens: 0,
			},
		});
		session.cancel();
	});

	it("accounts snake- and camel-case cache-write input token fields", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const session = new CodexProvider().query(baseCodexParams());
		const events = session[Symbol.asyncIterator]();
		await session.send("use prompt caching");
		await nextSessionEvent(events); // session_start

		emitSessionNotification(proc, "thread/tokenUsage/updated", {
			threadId: "thread-1",
			tokenUsage: {
				total: {
					inputTokens: 120,
					cachedInputTokens: 40,
					cache_write_input_tokens: 5,
					outputTokens: 10,
				},
				last: {
					inputTokens: 120,
					cachedInputTokens: 40,
					cache_write_input_tokens: 5,
					outputTokens: 10,
				},
			},
		});
		emitSessionNotification(proc, "thread/tokenUsage/updated", {
			threadId: "thread-1",
			tokenUsage: {
				total: {
					inputTokens: 300,
					cachedInputTokens: 180,
					cacheWriteInputTokens: 8,
					outputTokens: 50,
				},
				last: {
					inputTokens: 180,
					cachedInputTokens: 140,
					cacheWriteInputTokens: 3,
					outputTokens: 40,
				},
			},
		});
		emitSessionNotification(proc, "turn/completed", {
			threadId: "thread-1",
			turn: { id: "turn-1", status: "completed" },
		});

		expect(await nextSessionEvent(events)).toMatchObject({
			type: "usage",
			inputTokens: 75,
			outputTokens: 10,
			cacheReadTokens: 40,
			cacheCreationTokens: 5,
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "usage",
			inputTokens: 37,
			outputTokens: 40,
			cacheReadTokens: 140,
			cacheCreationTokens: 3,
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "done",
			usage: {
				inputTokens: 112,
				outputTokens: 50,
				cacheReadTokens: 180,
				cacheCreationTokens: 8,
			},
		});
		session.cancel();
	});

	it("uses last-call usage as the first baseline for a resumed thread", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const session = new CodexProvider().query(
			baseCodexParams({ sessionId: "existing-thread" }),
		);
		const events = session[Symbol.asyncIterator]();
		await session.send("continue");
		await nextSessionEvent(events); // session_start

		emitSessionNotification(proc, "thread/tokenUsage/updated", {
			threadId: "thread-1",
			tokenUsage: {
				total: {
					inputTokens: 1_000,
					cachedInputTokens: 800,
					outputTokens: 100,
				},
				last: {
					inputTokens: 100,
					cachedInputTokens: 80,
					outputTokens: 10,
				},
			},
		});
		emitSessionNotification(proc, "turn/completed", {
			threadId: "thread-1",
			turn: { id: "turn-1", status: "completed" },
		});

		expect(await nextDoneEvent(events)).toMatchObject({
			usage: {
				inputTokens: 20,
				outputTokens: 10,
				cacheReadTokens: 80,
				cacheCreationTokens: 0,
			},
		});
		session.cancel();
	});

	it("seeds idle resumed usage without billing the prior turn", async () => {
		const { proc } = makeFakeSessionProc({ rateLimits: {} });
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const session = new CodexProvider().query(
			baseCodexParams({ sessionId: "existing-thread" }),
		);
		const events = session[Symbol.asyncIterator]();

		await expect(session.usageWindows?.()).resolves.toEqual([]);
		expect(await nextSessionEvent(events)).toEqual({
			type: "session_start",
			sessionId: "thread-1",
		});
		emitSessionNotification(proc, "thread/tokenUsage/updated", {
			threadId: "thread-1",
			tokenUsage: {
				total: {
					inputTokens: 206_785,
					cachedInputTokens: 167_424,
					outputTokens: 1_828,
				},
				last: {
					inputTokens: 34_743,
					cachedInputTokens: 31_488,
					outputTokens: 231,
				},
			},
		});

		await session.send("continue");
		emitSessionNotification(proc, "thread/tokenUsage/updated", {
			threadId: "thread-1",
			tokenUsage: {
				total: {
					inputTokens: 243_296,
					cachedInputTokens: 167_424,
					outputTokens: 2_193,
				},
				last: {
					inputTokens: 36_511,
					cachedInputTokens: 0,
					outputTokens: 365,
				},
			},
		});
		emitSessionNotification(proc, "turn/completed", {
			threadId: "thread-1",
			turn: { id: "turn-1", status: "completed" },
		});

		expect(await nextSessionEvent(events)).toMatchObject({
			type: "usage",
			inputTokens: 36_511,
			outputTokens: 365,
			queryUsage: {
				inputTokens: 36_511,
				outputTokens: 365,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
			},
		});
		expect(await nextDoneEvent(events)).toMatchObject({
			usage: {
				inputTokens: 36_511,
				outputTokens: 365,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
			},
		});
		session.cancel();
	});

	it("keeps a spawn card live through child-thread activity and completion", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		const events = session[Symbol.asyncIterator]();
		await session.send("delegate this");
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "session_start",
			sessionId: "thread-1",
		});

		emitSessionNotification(proc, "item/started", {
			threadId: "thread-1",
			startedAtMs: 1000,
			item: {
				id: "spawn-1",
				type: "collabAgentToolCall",
				tool: "spawnAgent",
				prompt: "Inspect auth",
				model: "gpt-5.4",
				reasoningEffort: "medium",
			},
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "tool_start",
			toolId: "spawn-1",
			name: "spawn_agent",
			subagent: {
				agentId: "spawn-1",
				prompt: "Inspect auth",
				model: "gpt-5.4",
				effort: "medium",
				status: "pending",
				startedAtMs: 1000,
			},
		});

		emitSessionNotification(proc, "item/completed", {
			threadId: "thread-1",
			item: {
				id: "spawn-1",
				type: "collabAgentToolCall",
				tool: "spawnAgent",
				receiverThreadIds: ["child-1"],
				agentsStates: { "child-1": { status: "running", message: null } },
			},
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "tool_update",
			toolId: "spawn-1",
			subagent: { agentId: "child-1", status: "running" },
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "tool_result",
			toolId: "spawn-1",
		});

		emitSessionNotification(proc, "item/started", {
			threadId: "thread-1",
			item: {
				id: "activity-1",
				type: "subAgentActivity",
				agentThreadId: "child-1",
				agentPath: "/root/auth_scout",
				kind: "started",
			},
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "tool_update",
			toolId: "spawn-1",
			subagent: {
				name: "auth_scout",
				label: "/root/auth_scout",
				status: "running",
			},
		});

		emitSessionNotification(proc, "item/started", {
			threadId: "child-1",
			item: {
				id: "command-1",
				type: "commandExecution",
				command: "rg auth src",
			},
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "tool_update",
			toolId: "spawn-1",
			subagent: { status: "running", currentStep: "Running rg auth src" },
		});

		emitSessionNotification(proc, "thread/tokenUsage/updated", {
			threadId: "child-1",
			tokenUsage: {
				total: {
					inputTokens: 20,
					outputTokens: 5,
					cachedInputTokens: 4,
				},
				last: {
					inputTokens: 20,
					outputTokens: 5,
					cachedInputTokens: 4,
				},
			},
		});
		emitSessionNotification(proc, "thread/tokenUsage/updated", {
			threadId: "child-1",
			tokenUsage: {
				total: {
					inputTokens: 45,
					outputTokens: 12,
					cachedInputTokens: 14,
				},
				last: {
					inputTokens: 25,
					outputTokens: 7,
					cachedInputTokens: 10,
				},
			},
		});
		emitSessionNotification(proc, "turn/completed", {
			threadId: "child-1",
			completedAtMs: 7000,
			turn: { id: "child-turn", status: "completed" },
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "tool_update",
			toolId: "spawn-1",
			subagent: { status: "completed", endedAtMs: 7000 },
		});

		emitSessionNotification(proc, "thread/tokenUsage/updated", {
			threadId: "thread-1",
			tokenUsage: {
				total: {
					inputTokens: 10,
					outputTokens: 2,
					cachedInputTokens: 2,
				},
				last: {
					inputTokens: 10,
					outputTokens: 2,
					cachedInputTokens: 2,
				},
			},
		});
		emitSessionNotification(proc, "turn/completed", {
			threadId: "thread-1",
			turn: { id: "parent-turn", status: "completed" },
		});
		expect(await nextSessionEvent(events)).toMatchObject({ type: "usage" });
		expect(await nextSessionEvent(events)).toEqual({
			type: "done",
			estimatedCost: 0.0003115,
			turns: 2,
			durationMs: 0,
			stopReason: "completed",
			usage: {
				inputTokens: 39,
				outputTokens: 14,
				cacheReadTokens: 16,
				cacheCreationTokens: 0,
			},
		});
		session.cancel();
	});

	it("reuses a pending spawn card when activity precedes spawn completion", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		const events = session[Symbol.asyncIterator]();
		await session.send("delegate this");
		await nextSessionEvent(events); // session_start

		emitSessionNotification(proc, "item/started", {
			threadId: "thread-1",
			item: {
				id: "spawn-1",
				type: "collabAgentToolCall",
				tool: "spawnAgent",
				prompt: "Inspect auth",
			},
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "tool_start",
			toolId: "spawn-1",
			subagent: { status: "pending" },
		});

		// Some Codex versions emit this activity before the collab item supplies
		// receiverThreadIds, and the activity id may differ from the spawn item id.
		emitSessionNotification(proc, "item/started", {
			threadId: "thread-1",
			item: {
				id: "activity-1",
				type: "subAgentActivity",
				agentThreadId: "child-1",
				agentPath: "/root/auth_scout",
				kind: "started",
			},
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "tool_update",
			toolId: "spawn-1",
			subagent: {
				agentId: "child-1",
				name: "auth_scout",
				status: "running",
			},
		});

		emitSessionNotification(proc, "item/completed", {
			threadId: "thread-1",
			item: {
				id: "spawn-1",
				type: "collabAgentToolCall",
				tool: "spawnAgent",
				receiverThreadIds: ["child-1"],
				agentsStates: { "child-1": { status: "running" } },
			},
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "tool_update",
			toolId: "spawn-1",
			subagent: { agentId: "child-1", status: "running" },
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "tool_result",
			toolId: "spawn-1",
		});
		session.cancel();
	});

	it("keeps collab wait bookkeeping out of the generic tool timeline", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		const events = session[Symbol.asyncIterator]();
		await session.send("delegate this");
		await nextSessionEvent(events); // session_start

		const waitItem = {
			id: "wait-1",
			type: "collabAgentToolCall",
			tool: "wait",
			receiverThreadIds: [],
			agentsStates: {},
		};
		emitSessionNotification(proc, "item/started", {
			threadId: "thread-1",
			item: waitItem,
		});
		emitSessionNotification(proc, "item/completed", {
			threadId: "thread-1",
			item: { ...waitItem, status: "completed" },
		});
		emitSessionNotification(proc, "item/completed", {
			threadId: "thread-1",
			item: { id: "reply-1", type: "agentMessage", text: "Finished" },
		});

		expect(await nextSessionEvent(events)).toEqual({
			type: "text_delta",
			text: "Finished",
		});
	});

	it("creates a live card when subAgentActivity is the first spawn event", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(
			baseCodexParams({ effort: "high" }),
		);
		const events = session[Symbol.asyncIterator]();
		await session.send("delegate this");
		await nextSessionEvent(events); // session_start

		// Captured Codex 0.144 shape: the rollout contains a function_call named
		// spawn_agent, while app-server exposes only this activity item.
		emitSessionNotification(proc, "item/started", {
			threadId: "thread-1",
			item: {
				id: "call-spawn-1",
				type: "subAgentActivity",
				agentThreadId: "child-1",
				agentPath: "/root/ui_scout",
				kind: "started",
			},
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "tool_start",
			toolId: "call-spawn-1",
			name: "spawn_agent",
			subagent: {
				agentId: "child-1",
				name: "ui_scout",
				label: "/root/ui_scout",
				model: "gpt-5.4",
				effort: "high",
				status: "running",
			},
		});

		// The activity-only path must attach the child thread so its work and
		// terminal state keep updating the synthesized card.
		emitSessionNotification(proc, "item/started", {
			threadId: "child-1",
			item: {
				id: "command-1",
				type: "commandExecution",
				command: "rg auth src",
			},
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "tool_update",
			toolId: "call-spawn-1",
			subagent: { currentStep: "Running rg auth src", status: "running" },
		});

		emitSessionNotification(proc, "turn/completed", {
			threadId: "child-1",
			completedAtMs: 7000,
			turn: { id: "child-turn", status: "completed" },
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "tool_update",
			toolId: "call-spawn-1",
			subagent: { status: "completed", endedAtMs: 7000 },
		});
	});

	it("waits for a child that reports usage after its parent completes", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		const events = session[Symbol.asyncIterator]();
		await session.send("delegate this");
		await nextSessionEvent(events); // session_start

		emitSessionNotification(proc, "item/started", {
			threadId: "thread-1",
			item: {
				id: "call-spawn-1",
				type: "subAgentActivity",
				agentThreadId: "child-1",
				kind: "started",
			},
		});
		await nextSessionEvent(events); // synthesized spawn_agent card

		emitSessionNotification(proc, "thread/tokenUsage/updated", {
			threadId: "thread-1",
			tokenUsage: {
				total: {
					inputTokens: 10,
					cachedInputTokens: 2,
					outputTokens: 2,
				},
				last: {
					inputTokens: 10,
					cachedInputTokens: 2,
					outputTokens: 2,
				},
			},
		});
		emitSessionNotification(proc, "turn/completed", {
			threadId: "thread-1",
			turn: { id: "parent-turn", status: "completed" },
		});
		expect(await nextSessionEvent(events)).toMatchObject({ type: "usage" });

		let doneResolved = false;
		const donePromise = nextDoneEvent(events).then((event) => {
			doneResolved = true;
			return event;
		});
		await Promise.resolve();
		expect(doneResolved).toBe(false);

		emitSessionNotification(proc, "thread/tokenUsage/updated", {
			threadId: "child-1",
			tokenUsage: {
				total: {
					inputTokens: 20,
					cachedInputTokens: 4,
					outputTokens: 5,
				},
				last: {
					inputTokens: 20,
					cachedInputTokens: 4,
					outputTokens: 5,
				},
			},
		});
		emitSessionNotification(proc, "turn/completed", {
			threadId: "child-1",
			turn: { id: "child-turn", status: "completed" },
		});

		expect(await donePromise).toMatchObject({
			turns: 2,
			usage: {
				inputTokens: 24,
				outputTokens: 7,
				cacheReadTokens: 6,
				cacheCreationTokens: 0,
			},
		});
		session.cancel();
	});

	it("bounds completion when an attached child never reports a terminal turn", async () => {
		vi.useFakeTimers();
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const session = new CodexProvider().query(baseCodexParams());
		try {
			const events = session[Symbol.asyncIterator]();
			await session.send("delegate this");
			await nextSessionEvent(events); // session_start

			emitSessionNotification(proc, "item/started", {
				threadId: "thread-1",
				item: {
					id: "call-spawn-1",
					type: "subAgentActivity",
					agentThreadId: "child-1",
					kind: "started",
				},
			});
			await nextSessionEvent(events); // synthesized spawn_agent card

			emitSessionNotification(proc, "turn/completed", {
				threadId: "thread-1",
				turn: {
					id: "parent-turn",
					status: "completed",
					usage: { inputTokens: 12, outputTokens: 3 },
				},
			});
			const donePromise = nextDoneEvent(events);
			await vi.advanceTimersByTimeAsync(10 * 60_000);
			expect(await donePromise).toMatchObject({
				turns: 1,
				usage: {
					inputTokens: 12,
					outputTokens: 3,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
				},
			});
			const conn = acquireCodexAppServer("/usr/bin/codex");
			expect(conn.threadCount).toBeLessThan(2);
		} finally {
			session.cancel();
			vi.useRealTimers();
		}
	});

	it("detaches parent and child threads after normal input closure", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		const events = session[Symbol.asyncIterator]();
		await session.send("delegate this");
		await nextSessionEvent(events); // session_start

		emitSessionNotification(proc, "item/started", {
			threadId: "thread-1",
			item: {
				id: "call-spawn-1",
				type: "subAgentActivity",
				agentThreadId: "child-1",
				kind: "started",
			},
		});
		await nextSessionEvent(events); // synthesized spawn_agent card

		const conn = acquireCodexAppServer("/usr/bin/codex");
		expect(conn.threadCount).toBe(2);
		session.closeInput?.();
		emitSessionNotification(proc, "turn/completed", {
			threadId: "thread-1",
			turn: { id: "turn-1", status: "completed" },
		});
		emitSessionNotification(proc, "turn/completed", {
			threadId: "child-1",
			turn: { id: "child-turn", status: "completed" },
		});

		expect(await nextDoneEvent(events)).toMatchObject({ type: "done" });
		expect(await events.next()).toEqual({ value: undefined, done: true });
		expect(conn.threadCount).toBe(0);
	});

	it("attributes rateLimitReachedType to the most-utilized window", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		const events = session[Symbol.asyncIterator]();
		await session.send("hello");
		await nextSessionEvent(events); // session_start

		// five_hour most utilized → it gets the rejection; weekly stays ok.
		emitSessionNotification(proc, "account/rateLimits/updated", {
			rateLimits: {
				rateLimitReachedType: "rate_limit_reached",
				primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 42 },
				secondary: {
					usedPercent: 30,
					windowDurationMins: 10_080,
					resetsAt: 99,
				},
			},
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "rate_limit",
			status: "rejected",
			rateLimitType: "five_hour",
			utilization: 1,
			resetsAt: 42,
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "rate_limit",
			status: "ok",
			rateLimitType: "weekly",
			utilization: 0.3,
			resetsAt: 99,
		});

		// weekly most utilized → rejection lands there, not on five_hour.
		emitSessionNotification(proc, "account/rateLimits/updated", {
			rateLimits: {
				rateLimitReachedType: "workspace_owner_usage_limit_reached",
				primary: { usedPercent: 60, windowDurationMins: 300, resetsAt: 42 },
				secondary: {
					usedPercent: 100,
					windowDurationMins: 10_080,
					resetsAt: 99,
				},
			},
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			rateLimitType: "five_hour",
			status: "ok",
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			rateLimitType: "weekly",
			status: "rejected",
		});
		session.cancel();
	});

	it("keeps credits-depleted snapshots ok and emits despite missing usedPercent", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		const events = session[Symbol.asyncIterator]();
		await session.send("hello");
		await nextSessionEvent(events); // session_start

		// Credits don't reset with the window — no rejection.
		emitSessionNotification(proc, "account/rateLimits/updated", {
			rateLimits: {
				rateLimitReachedType: "workspace_owner_credits_depleted",
				primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 42 },
			},
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			rateLimitType: "five_hour",
			status: "ok",
		});

		// Hard limit with no usedPercent reading still surfaces the rejection.
		emitSessionNotification(proc, "account/rateLimits/updated", {
			rateLimits: {
				rateLimitReachedType: "rate_limit_reached",
				primary: { windowDurationMins: 300, resetsAt: 42 },
			},
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "rate_limit",
			status: "rejected",
			rateLimitType: "five_hour",
			resetsAt: 42,
		});
		session.cancel();
	});

	it("surfaces a reached workspace spend control as a hard limit", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		const events = session[Symbol.asyncIterator]();
		await session.send("hello");
		await nextSessionEvent(events); // session_start

		emitSessionNotification(proc, "account/rateLimits/updated", {
			rateLimits: {
				spendControlReached: true,
				individualLimit: {
					limit: "100",
					used: "100",
					remainingPercent: 0,
					resetsAt: 1_800_600_000,
				},
			},
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "rate_limit",
			status: "rejected",
			rateLimitType: "spend_control",
			utilization: 1,
			resetsAt: 1_800_600_000,
		});
		session.cancel();
	});

	it("uses Codex item tool metadata instead of the generic item type", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		const events = session[Symbol.asyncIterator]();
		await session.send("hello");
		await nextSessionEvent(events);
		emitSessionNotification(proc, "item/started", {
			threadId: "thread-1",
			item: {
				id: "mcp-1",
				type: "mcpToolCall",
				tool: "update_plan",
				arguments: { plan: [{ step: "Research", status: "in_progress" }] },
			},
		});

		expect(await nextSessionEvent(events)).toEqual({
			type: "tool_start",
			toolId: "mcp-1",
			name: "update_plan",
			input: { plan: [{ step: "Research", status: "in_progress" }] },
		});
		session.cancel();
	});

	it("keeps inherited hooks enabled under internal policy enforcement", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(
			baseCodexParams({ policyEnforced: true }),
		);
		await session.send("hello");

		expect(spawn).toHaveBeenCalledWith(
			"/usr/bin/codex",
			["app-server", "--listen", "stdio://"],
			expect.any(Object),
		);
		session.cancel();
	});

	it("routes request_user_input through the shared question UI and maps answers", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const canUseTool = vi.fn().mockResolvedValue({
			behavior: "allow",
			updatedInput: {
				answers: { "Choose a database": "SQLite" },
			},
		});
		const session = new CodexProvider().query(baseCodexParams({ canUseTool }));
		await session.send("ask me");

		proc.stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					id: 78,
					method: "item/tool/requestUserInput",
					params: {
						threadId: "thread-1",
						turnId: "turn-1",
						itemId: "ask-1",
						questions: [
							{
								id: "database",
								header: "Database",
								question: "Choose a database",
								options: [
									{ label: "SQLite", description: "Local" },
									{ label: "Postgres", description: "Server" },
								],
							},
						],
					},
				})}\n`,
			),
		);

		await vi.waitFor(() => {
			expect(canUseTool).toHaveBeenCalledWith(
				"AskUserQuestion",
				expect.objectContaining({ itemId: "ask-1" }),
				expect.objectContaining({
					toolUseID: "ask-1",
					displayName: "request_user_input",
				}),
			);
			const response = writes
				.map((line) => JSON.parse(line))
				.find((message) => message.id === 78);
			expect(response?.result).toEqual({
				answers: { database: { answers: ["SQLite"] } },
			});
		});
		session.cancel();
	});

	it("finishes a question-only plan turn without manufacturing a plan or implementation turn", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const canUseTool = vi.fn().mockImplementation(async (name: string) =>
			name === "AskUserQuestion"
				? {
						behavior: "allow" as const,
						updatedInput: {
							answers: { "Acceptance choice?": "Beta" },
						},
					}
				: { behavior: "allow" as const },
		);
		const session = new CodexProvider().query(
			baseCodexParams({ permissionMode: "plan", canUseTool }),
		);
		const events = session[Symbol.asyncIterator]();
		await session.send("ask me");
		await nextSessionEvent(events);

		emitSessionNotification(proc, "turn/started", {
			threadId: "thread-1",
			turn: { id: "question-turn" },
		});
		proc.stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					id: 79,
					method: "item/tool/requestUserInput",
					params: {
						threadId: "thread-1",
						turnId: "question-turn",
						itemId: "question-1",
						questions: [
							{
								id: "choice",
								header: "Choice",
								question: "Acceptance choice?",
								options: [
									{ label: "Alpha", description: "First" },
									{ label: "Beta", description: "Second" },
								],
							},
						],
					},
				})}\n`,
			),
		);
		await vi.waitFor(() => {
			const response = writes
				.map((line) => JSON.parse(line))
				.find((message) => message.id === 79);
			expect(response?.result).toEqual({
				answers: { choice: { answers: ["Beta"] } },
			});
		});
		emitSessionNotification(proc, "item/completed", {
			threadId: "thread-1",
			item: {
				id: "answer-1",
				type: "agentMessage",
				text: "QUESTION_OK:Beta",
			},
		});
		emitSessionNotification(proc, "turn/completed", {
			threadId: "thread-1",
			turn: { id: "question-turn", status: "completed" },
		});

		expect(await nextSessionEvent(events)).toMatchObject({
			type: "provider_turn_id",
			id: "question-turn",
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "text_delta",
			text: "QUESTION_OK:Beta",
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "done",
			turns: 1,
		});
		expect(canUseTool).not.toHaveBeenCalledWith(
			"ExitPlanMode",
			expect.anything(),
			expect.anything(),
		);
		expect(turnStartParams(writes)).toHaveLength(1);
		session.cancel();
	});

	it.each([
		{
			label: "once",
			decision: { behavior: "allow" as const },
			result: { action: "accept", content: null, _meta: null },
		},
		{
			label: "session",
			decision: { behavior: "allow" as const, saveScope: "session" as const },
			result: {
				action: "accept",
				content: null,
				_meta: { persist: "session" },
			},
		},
		{
			label: "always",
			decision: { behavior: "allow" as const, saveScope: "local" as const },
			result: {
				action: "accept",
				content: null,
				_meta: { persist: "always" },
			},
		},
		{
			label: "deny",
			decision: { behavior: "deny" as const },
			result: { action: "decline", content: null, _meta: null },
		},
	])("routes Computer Use app approval through Hlid for $label", async ({
		decision,
		result,
	}) => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const canUseTool = vi.fn().mockResolvedValue(decision);
		const session = new CodexProvider().query(
			baseCodexParams({
				permissionMode: "bypassPermissions",
				canUseTool,
			}),
		);
		await session.send("use calculator");

		proc.stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					id: 81,
					method: "mcpServer/elicitation/request",
					params: {
						threadId: "thread-1",
						turnId: "turn-1",
						serverName: "node_repl",
						mode: "form",
						message: "Allow Codex to use Docker Desktop?",
						requestedSchema: {},
						_meta: {
							connector_id: "computer-use",
							riskLevel: "low",
							tool_params: { app: "Docker.DockerForWindows.Settings" },
							tool_params_display: [
								{
									display_name: "App",
									name: "app",
									value: "Docker Desktop",
								},
							],
						},
					},
				})}\n`,
			),
		);

		await vi.waitFor(() => {
			expect(canUseTool).toHaveBeenCalledWith(
				"hlid.windows_computer_use:Docker.DockerForWindows.Settings",
				expect.objectContaining({
					appId: "Docker.DockerForWindows.Settings",
					appName: "Docker Desktop",
				}),
				expect.objectContaining({
					title: "Allow Codex to use Docker Desktop?",
					displayName: "Windows Computer Use · Docker Desktop",
				}),
			);
			const response = writes
				.map((line) => JSON.parse(line))
				.find((message) => message.id === 81);
			expect(response?.result).toEqual(result);
		});
		session.cancel();
	});

	it("auto-approves app-server requests while a bypassPermissions session is planning", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const canUseTool = vi.fn();
		const session = new CodexProvider().query(
			baseCodexParams({
				permissionMode: "plan",
				implementationPermissionMode: "bypassPermissions",
				canUseTool,
			}),
		);
		await session.send("run it");
		expect(turnStartParams(writes)[0]).toMatchObject({
			approvalPolicy: "never",
			sandboxPolicy: { type: "readOnly", networkAccess: false },
		});
		proc.stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					id: 77,
					method: "item/commandExecution/requestApproval",
					params: { threadId: "thread-1", itemId: "command-1" },
				})}\n`,
			),
		);
		await vi.waitFor(() => {
			const response = writes
				.map((line) => JSON.parse(line))
				.find((message) => message.id === 77);
			expect(response?.result).toEqual({ decision: "accept" });
		});
		expect(canUseTool).not.toHaveBeenCalled();
		session.cancel();
	});

	it("routes command approvals through canonical bash inputs", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const canUseTool = vi.fn().mockResolvedValue({ behavior: "allow" });
		const session = new CodexProvider().query(baseCodexParams({ canUseTool }));
		await session.send("inspect it");

		emitSessionNotification(proc, "item/started", {
			threadId: "thread-1",
			item: {
				id: "command-from-item",
				type: "commandExecution",
				command: "git status",
			},
		});
		proc.stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					id: 78,
					method: "item/commandExecution/requestApproval",
					params: { threadId: "thread-1", itemId: "command-from-item" },
				})}\n`,
			),
		);
		proc.stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					id: 79,
					method: "execCommandApproval",
					params: {
						threadId: "thread-1",
						approvalId: "legacy-command",
						request: { cmd: "git diff --stat" },
					},
				})}\n`,
			),
		);

		await vi.waitFor(() => expect(canUseTool).toHaveBeenCalledTimes(2));
		expect(canUseTool).toHaveBeenNthCalledWith(
			1,
			"bash",
			{ command: "git status" },
			expect.objectContaining({ toolUseID: "command-from-item" }),
		);
		expect(canUseTool).toHaveBeenNthCalledWith(
			2,
			"bash",
			{ command: "git diff --stat" },
			expect.objectContaining({ toolUseID: "legacy-command" }),
		);
		await vi.waitFor(() => {
			const responses = writes
				.map((line) => JSON.parse(line))
				.filter((message) => message.id === 78 || message.id === 79);
			expect(responses).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						id: 78,
						result: { decision: "accept" },
					}),
					expect.objectContaining({
						id: 79,
						result: { decision: "accept" },
					}),
				]),
			);
		});
		session.cancel();
	});

	it("uses approval boundaries as the auto-sleep fallback when Umbod is disabled", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const canUseTool = vi.fn().mockResolvedValue({ behavior: "allow" });
		const session = new CodexProvider().query(
			baseCodexParams({
				permissionMode: "bypassPermissions",
				usageGateEnforced: true,
				canUseTool,
			}),
		);
		await session.send("run it");
		expect(turnStartParams(writes)[0]).toMatchObject({
			approvalPolicy: "on-request",
			sandboxPolicy: { type: "dangerFullAccess" },
		});

		proc.stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					id: 79,
					method: "item/commandExecution/requestApproval",
					params: { threadId: "thread-1", itemId: "command-sleep" },
				})}\n`,
			),
		);
		await vi.waitFor(() => {
			expect(canUseTool).toHaveBeenCalledWith(
				"item/commandExecution/requestApproval",
				expect.objectContaining({ itemId: "command-sleep" }),
				expect.objectContaining({ toolUseID: "command-sleep" }),
			);
		});
		session.cancel();
	});

	it("leaves bypass approval policy intact when embedded Umbod owns PreToolUse", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const session = new CodexProvider().query(
			baseCodexParams({
				permissionMode: "bypassPermissions",
				policyEnforced: true,
				usageGateEnforced: true,
			}),
		);

		await session.send("run it");

		expect(turnStartParams(writes)[0]).toMatchObject({
			approvalPolicy: "never",
			sandboxPolicy: { type: "dangerFullAccess" },
		});
		session.cancel();
	});

	it("presents an HTML-enabled plan even when no file approval was requested", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const canUseTool = vi.fn().mockResolvedValue({
			behavior: "deny",
			message: "Plan was cancelled by the user.",
		});
		const session = new CodexProvider().query(
			baseCodexParams({
				permissionMode: "plan",
				implementationPermissionMode: "bypassPermissions",
				planHtmlPath: "/vault/.hlid/plans/plan-session.html",
				canUseTool,
			}),
		);
		const events = session[Symbol.asyncIterator]();
		await session.send("make a plan");
		expect(turnStartParams(writes)[0].collaborationMode).toMatchObject({
			mode: "default",
		});
		expect(turnStartParams(writes)[0].sandboxPolicy).toEqual(
			codexSandboxPolicy("plan", [], "/vault/.hlid/plans/plan-session.html"),
		);
		await nextSessionEvent(events);
		emitSessionNotification(proc, "turn/started", {
			threadId: "thread-1",
			turn: { id: "turn-1" },
		});
		emitSessionNotification(proc, "turn/completed", {
			threadId: "thread-1",
			turn: { id: "turn-1", status: "completed" },
		});
		await vi.waitFor(() => {
			expect(canUseTool).toHaveBeenCalledWith(
				"ExitPlanMode",
				{ plan: "HTML plan ready for review." },
				expect.objectContaining({ toolUseID: "codex-plan-turn-1" }),
			);
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "provider_turn_id",
			id: "turn-1",
		});
		expect(await nextSessionEvent(events)).toMatchObject({ type: "done" });
		session.cancel();
	});

	it("presents the native Codex plan when HTML plans are disabled", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const canUseTool = vi.fn().mockResolvedValue({
			behavior: "deny",
			message: "Plan was cancelled by the user.",
		});
		const session = new CodexProvider().query(
			baseCodexParams({
				permissionMode: "plan",
				canUseTool,
			}),
		);
		const events = session[Symbol.asyncIterator]();
		await session.send("make a plan");
		await nextSessionEvent(events);
		emitSessionNotification(proc, "turn/started", {
			threadId: "thread-1",
			turn: { id: "turn-native" },
		});
		emitSessionNotification(proc, "item/completed", {
			threadId: "thread-1",
			item: {
				id: "plan-1",
				type: "plan",
				text: "## Native plan\n\n1. Implement it.",
			},
		});
		emitSessionNotification(proc, "turn/completed", {
			threadId: "thread-1",
			turn: { id: "turn-native", status: "completed" },
		});

		await vi.waitFor(() => {
			expect(canUseTool).toHaveBeenCalledWith(
				"ExitPlanMode",
				{ plan: "## Native plan\n\n1. Implement it." },
				expect.objectContaining({
					toolUseID: "codex-plan-turn-native",
				}),
			);
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "provider_turn_id",
			id: "turn-native",
		});
		expect(await nextSessionEvent(events)).toMatchObject({ type: "done" });
		session.cancel();
	});

	it("starts implementation outside read-only mode after plan approval", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const canUseTool = vi.fn().mockResolvedValue({ behavior: "allow" });
		const session = new CodexProvider().query(
			baseCodexParams({
				permissionMode: "plan",
				planHtmlPath: "/vault/.hlid/plans/plan-session.html",
				canUseTool,
			}),
		);
		const events = session[Symbol.asyncIterator]();
		await session.send("make a plan");
		await nextSessionEvent(events);

		emitSessionNotification(proc, "turn/started", {
			threadId: "thread-1",
			turn: { id: "turn-1" },
		});
		emitSessionNotification(proc, "item/started", {
			threadId: "thread-1",
			item: {
				id: "change-1",
				type: "fileChange",
				changes: [{ path: "/vault/.hlid/plans/plan-session.html" }],
			},
		});
		await nextSessionEvent(events);
		proc.stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					id: 99,
					method: "item/fileChange/requestApproval",
					params: {
						threadId: "thread-1",
						itemId: "change-1",
						reason: "write plan",
					},
				})}\n`,
			),
		);
		await vi.waitFor(() => {
			expect(canUseTool).toHaveBeenCalledWith(
				"Write",
				{ file_path: "/vault/.hlid/plans/plan-session.html" },
				expect.objectContaining({ toolUseID: "change-1" }),
			);
			expect(writes.some((line) => JSON.parse(line).id === 99)).toBe(true);
		});

		emitSessionNotification(proc, "item/completed", {
			threadId: "thread-1",
			item: { id: "change-1", type: "fileChange" },
		});
		await nextSessionEvent(events);
		emitSessionNotification(proc, "turn/completed", {
			threadId: "thread-1",
			turn: { id: "turn-1", status: "completed" },
		});
		await vi.waitFor(() => {
			expect(canUseTool).toHaveBeenCalledWith(
				"ExitPlanMode",
				{ plan: "HTML plan ready for review." },
				expect.objectContaining({ toolUseID: "codex-plan-turn-1" }),
			);
		});
		await vi.waitFor(() => expect(turnStartParams(writes)).toHaveLength(2));
		const implementationTurn = turnStartParams(writes)[1];
		expect(implementationTurn).toMatchObject({
			approvalPolicy: "on-request",
			collaborationMode: { mode: "default" },
			sandboxPolicy: codexSandboxPolicy("default", []),
		});
		expect(implementationTurn.input).toEqual([
			expect.objectContaining({
				type: "text",
				text: expect.stringContaining("approved the plan"),
			}),
		]);
		session.cancel();
	});

	it("accumulates plan and implementation usage with hosted web-search fees", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const canUseTool = vi.fn().mockResolvedValue({ behavior: "allow" });
		const session = new CodexProvider().query(
			baseCodexParams({ permissionMode: "plan", canUseTool }),
		);
		const events = session[Symbol.asyncIterator]();
		await session.send("make and implement a plan");
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "session_start",
		});

		emitSessionNotification(proc, "turn/started", {
			threadId: "thread-1",
			turn: { id: "plan-turn" },
		});
		emitSessionNotification(proc, "thread/tokenUsage/updated", {
			threadId: "thread-1",
			usage: { inputTokens: 10, outputTokens: 2 },
		});
		emitSessionNotification(proc, "item/completed", {
			threadId: "thread-1",
			item: {
				id: "plan-1",
				type: "plan",
				text: "## Plan\n\n1. Implement it.",
			},
		});
		emitSessionNotification(proc, "turn/completed", {
			threadId: "thread-1",
			turn: { id: "plan-turn", status: "completed" },
		});
		await vi.waitFor(() => expect(turnStartParams(writes)).toHaveLength(2));

		emitSessionNotification(proc, "turn/started", {
			threadId: "thread-1",
			turn: { id: "implementation-turn" },
		});
		emitSessionNotification(proc, "item/started", {
			threadId: "thread-1",
			item: {
				id: "web-1",
				type: "webSearch",
				action: { type: "openPage", url: "https://example.com" },
			},
		});
		emitSessionNotification(proc, "item/completed", {
			threadId: "thread-1",
			item: {
				id: "web-1",
				type: "webSearch",
				action: { type: "openPage", url: "https://example.com" },
			},
		});
		emitSessionNotification(proc, "thread/tokenUsage/updated", {
			threadId: "thread-1",
			usage: {
				inputTokens: 20,
				outputTokens: 3,
				cacheReadTokens: 4,
			},
		});
		emitSessionNotification(proc, "turn/completed", {
			threadId: "thread-1",
			turn: { id: "implementation-turn", status: "completed" },
		});

		expect(await nextSessionEvent(events)).toMatchObject({
			type: "provider_turn_id",
			id: "plan-turn",
		});
		expect(await nextSessionEvent(events)).toMatchObject({ type: "usage" });
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "provider_turn_id",
			id: "implementation-turn",
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "tool_start",
			name: "webSearch",
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "tool_result",
		});
		expect(await nextSessionEvent(events)).toMatchObject({ type: "usage" });
		expect(await nextSessionEvent(events)).toEqual({
			type: "done",
			estimatedCost: 0.010141,
			turns: 2,
			durationMs: 0,
			stopReason: "completed",
			usage: {
				inputTokens: 26,
				outputTokens: 5,
				cacheReadTokens: 4,
				cacheCreationTokens: 0,
			},
		});
		session.cancel();
	});

	it("starts another plan turn with revision feedback", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const canUseTool = vi.fn(async (name: string) =>
			name === "ExitPlanMode"
				? {
						behavior: "deny" as const,
						message:
							"User requested changes to the plan:\n\nAdd a validation step.",
					}
				: { behavior: "allow" as const },
		);
		const session = new CodexProvider().query(
			baseCodexParams({ permissionMode: "plan", canUseTool }),
		);
		const events = session[Symbol.asyncIterator]();
		await session.send("make a plan");
		await nextSessionEvent(events);
		emitSessionNotification(proc, "turn/started", {
			threadId: "thread-1",
			turn: { id: "turn-1" },
		});
		emitSessionNotification(proc, "item/started", {
			threadId: "thread-1",
			item: {
				id: "change-1",
				type: "fileChange",
				changes: [{ path: "/vault/.hlid/plans/plan-session.html" }],
			},
		});
		await nextSessionEvent(events);
		proc.stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					id: 100,
					method: "item/fileChange/requestApproval",
					params: { threadId: "thread-1", itemId: "change-1" },
				})}\n`,
			),
		);
		await vi.waitFor(() =>
			expect(canUseTool).toHaveBeenCalledWith(
				"Write",
				expect.anything(),
				expect.anything(),
			),
		);
		emitSessionNotification(proc, "item/completed", {
			threadId: "thread-1",
			item: { id: "change-1", type: "fileChange" },
		});
		await nextSessionEvent(events);
		emitSessionNotification(proc, "item/completed", {
			threadId: "thread-1",
			item: {
				id: "plan-1",
				type: "plan",
				text: "## Plan\n\n1. Implement it.",
			},
		});
		emitSessionNotification(proc, "turn/completed", {
			threadId: "thread-1",
			turn: { id: "turn-1", status: "completed" },
		});

		await vi.waitFor(() => expect(turnStartParams(writes)).toHaveLength(2));
		const revisionTurn = turnStartParams(writes)[1];
		expect(revisionTurn.input).toEqual([
			expect.objectContaining({
				type: "text",
				text: expect.stringContaining("Add a validation step."),
			}),
		]);
		session.cancel();
	});
});

describe("codexSubagentStatus", () => {
	it("maps each known collab status onto the snapshot status", () => {
		expect(codexSubagentStatus("pendingInit")).toBe("pending");
		expect(codexSubagentStatus("running")).toBe("running");
		expect(codexSubagentStatus("completed")).toBe("completed");
		expect(codexSubagentStatus("errored")).toBe("failed");
		expect(codexSubagentStatus("notFound")).toBe("failed");
		expect(codexSubagentStatus("interrupted")).toBe("interrupted");
	});

	it("treats shutdown as completed only when the agent already completed", () => {
		expect(codexSubagentStatus("shutdown", "completed")).toBe("completed");
		expect(codexSubagentStatus("shutdown", "running")).toBe("interrupted");
		expect(codexSubagentStatus("shutdown")).toBe("interrupted");
	});

	it("keeps the previous status for unknown or missing values", () => {
		expect(codexSubagentStatus(null, "pending")).toBe("pending");
		expect(codexSubagentStatus(undefined, "failed")).toBe("failed");
		expect(codexSubagentStatus(null)).toBe("running");
		expect(codexSubagentStatus(undefined)).toBe("running");
	});
});

describe("codexChildStep", () => {
	it("summarizes command executions with the truncated command line", () => {
		expect(
			codexChildStep({ type: "commandExecution", command: "rg auth src" }),
		).toBe("Running rg auth src");
		const long = "x".repeat(200);
		expect(codexChildStep({ type: "commandExecution", command: long })).toBe(
			`Running ${"x".repeat(120)}`,
		);
		expect(codexChildStep({ type: "commandExecution" })).toBe(
			"Running command",
		);
	});

	it("maps the known activity item types to fixed labels", () => {
		expect(codexChildStep({ type: "fileChange" })).toBe(
			"Applying file changes",
		);
		expect(codexChildStep({ type: "mcpToolCall", tool: "search" })).toBe(
			"Calling search",
		);
		expect(codexChildStep({ type: "mcpToolCall", server: "linear" })).toBe(
			"Calling linear",
		);
		expect(codexChildStep({ type: "mcpToolCall" })).toBe("Calling MCP tool");
		expect(codexChildStep({ type: "webSearch" })).toBe("Searching the web");
		expect(codexChildStep({ type: "reasoning" })).toBe("Reasoning");
	});

	it("falls back to a humanized camelCase type", () => {
		expect(codexChildStep({ type: "customToolThing" })).toBe(
			"Working on custom tool thing",
		);
		expect(codexChildStep({})).toBe("Working on activity");
	});
});

describe("CodexAgentSession — mcpServerStatus", () => {
	beforeEach(() => {
		__resetCodexAppServersForTesting();
	});

	function sessionWith(
		opts: Parameters<typeof makeFakeSessionProc>[0],
	): AgentSession {
		const { proc } = makeFakeSessionProc(opts);
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		return new CodexProvider().query(baseCodexParams());
	}

	it("reads app-server inventory without creating an ephemeral thread", async () => {
		const { proc, writes } = makeFakeSessionProc({
			mcpStatusResult: {
				data: [{ name: "github", authStatus: "bearerToken" }],
			},
		});
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const session = new CodexProvider().query(baseCodexParams());

		expect(await session.mcpServerStatus?.()).toEqual([
			{ name: "github", status: "connected" },
		]);
		expect(writeMethods(writes)).not.toContain("thread/start");
		session.cancel();
	});

	it("maps app-server statuses onto the UI status vocabulary", async () => {
		const session = sessionWith({
			mcpStatusResult: {
				data: [
					{ name: "linear", status: "notLoggedIn" },
					{ name: "sentry", status: "failed" },
					{ name: "grafana", status: "disabled" },
					{ name: "chrome", status: "pending" },
					{ name: "github", status: "running" },
					{ serverName: "playwright", authStatus: "notLoggedIn" },
					{ status: "running" }, // nameless — dropped
					{ name: "bare" }, // no status — defaults to pending
				],
			},
		});
		expect(await session.mcpServerStatus?.()).toEqual([
			{ name: "linear", status: "needs-auth" },
			{ name: "sentry", status: "failed" },
			{ name: "grafana", status: "disabled" },
			{ name: "chrome", status: "pending" },
			{ name: "github", status: "connected" },
			{ name: "playwright", status: "needs-auth" },
			{ name: "bare", status: "pending" },
		]);
		session.cancel();
	});

	it("reads the legacy `servers` array when `data` is absent", async () => {
		const session = sessionWith({
			mcpStatusResult: {
				servers: [{ name: "linear", status: "running" }],
			},
		});
		expect(await session.mcpServerStatus?.()).toEqual([
			{ name: "linear", status: "connected" },
		]);
		session.cancel();
	});

	it("returns an empty list when the shape is unrecognized", async () => {
		const session = sessionWith({ mcpStatusResult: { nope: true } });
		expect(await session.mcpServerStatus?.()).toEqual([]);
		session.cancel();
	});

	it("returns an empty list when the RPC errors", async () => {
		const session = sessionWith({ mcpStatusError: true });
		expect(await session.mcpServerStatus?.()).toEqual([]);
		session.cancel();
	});
});
