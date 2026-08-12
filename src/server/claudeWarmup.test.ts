import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));

import { query } from "@anthropic-ai/claude-agent-sdk";
import {
	getClaudeWarmupSnapshot,
	prewarmClaudeCli,
	waitForClaudeWarmupSnapshot,
} from "./claudeWarmup";

const readRuntimeVersion = vi.fn(async () => "2.1.228");

function sdkQuery(options?: {
	commands?: Array<{
		name: string;
		description: string;
		argumentHint?: string;
	}>;
	mcp?: Array<{ name: string; status: string; error?: string; scope?: string }>;
	models?: Array<{
		value: string;
		resolvedModel?: string;
		supportsAutoMode?: boolean;
	}>;
	settings?: { effective: { disableAutoMode?: "disable" } };
}) {
	return {
		interrupt: vi.fn(),
		rewindFiles: vi.fn(),
		getSettings: vi
			.fn<() => Promise<{ effective: { disableAutoMode?: "disable" } }>>()
			.mockResolvedValue(options?.settings ?? { effective: {} }),
		setModel: vi
			.fn<(model?: string) => Promise<void>>()
			.mockResolvedValue(undefined),
		setPermissionMode: vi
			.fn<(mode: string) => Promise<void>>()
			.mockResolvedValue(undefined),
		initializationResult: vi.fn().mockResolvedValue({
			commands: options?.commands ?? [],
			agents: [{ name: "reviewer" }],
			models: options?.models ?? [{ value: "sonnet" }],
		}),
		mcpServerStatus: vi.fn().mockResolvedValue(options?.mcp ?? []),
	};
}

describe("Claude startup metadata cache", () => {
	beforeEach(() => {
		vi.mocked(query).mockReset();
		readRuntimeVersion.mockReset().mockResolvedValue("2.1.228");
	});

	it("caches commands, skills, and MCP status without sending a chat turn", async () => {
		const sdk = sdkQuery({
			commands: [
				{
					name: "review",
					description: "Review changes",
					argumentHint: "[instructions]",
				},
			],
			mcp: [
				{ name: "github", status: "connected" },
				{ name: "figma", status: "notLoggedIn" },
			],
		});
		vi.mocked(query).mockReturnValueOnce(sdk as never);

		await expect(
			prewarmClaudeCli({
				executable: "/usr/bin/claude",
				cwd: "/tmp/project",
				additionalDirectories: ["/tmp/vault"],
				readRuntimeVersion,
			}),
		).resolves.toBe(true);
		expect(readRuntimeVersion).toHaveBeenCalledWith("/usr/bin/claude");

		const call = vi.mocked(query).mock.calls[0]?.[0];
		expect(call?.prompt).not.toEqual(expect.any(String));
		expect(call?.options).toEqual(
			expect.objectContaining({
				cwd: "/tmp/project",
				persistSession: false,
				settings: {
					crossSessionInbound: "refuse",
					dialogExpiry: "never",
				},
				maxTurns: 1,
				additionalDirectories: ["/tmp/vault"],
			}),
		);
		expect(call?.options?.env).toBeUndefined();
		expect(call?.options).not.toHaveProperty("agentProgressSummaries");
		expect(call?.options?.abortController?.signal.aborted).toBe(true);
		expect(getClaudeWarmupSnapshot("/tmp/project")).toEqual(
			expect.objectContaining({
				commands: [
					{
						name: "review",
						description: "Review changes",
						argumentHint: "[instructions]",
					},
				],
				agents: [{ name: "reviewer" }],
				mcpServers: [
					{ name: "github", status: "connected" },
					{ name: "figma", status: "needs-auth" },
				],
				modelCount: 1,
				runtimeVersion: "2.1.228",
				controlMethods: expect.arrayContaining(["interrupt", "rewindFiles"]),
				cwd: "/tmp/project",
			}),
		);
	});

	it("keeps discovery available when exact executable version inspection fails", async () => {
		const sdk = sdkQuery({
			commands: [{ name: "help", description: "Help" }],
		});
		readRuntimeVersion.mockRejectedValueOnce(
			new Error("version command unavailable"),
		);
		vi.mocked(query).mockReturnValueOnce(sdk as never);

		await expect(
			prewarmClaudeCli({
				executable: "/opt/claude/bin/claude",
				cwd: "/tmp/runtime-version-unavailable",
				readRuntimeVersion,
			}),
		).resolves.toBe(true);

		expect(readRuntimeVersion).toHaveBeenCalledWith("/opt/claude/bin/claude");
		expect(getClaudeWarmupSnapshot("/tmp/runtime-version-unavailable")).toEqual(
			expect.objectContaining({
				commands: [{ name: "help", description: "Help", argumentHint: "" }],
			}),
		);
		expect(
			getClaudeWarmupSnapshot("/tmp/runtime-version-unavailable"),
		).not.toHaveProperty("runtimeVersion");
	});

	it("keeps independent metadata snapshots for separate provider scopes", async () => {
		vi.mocked(query)
			.mockReturnValueOnce(
				sdkQuery({
					commands: [{ name: "vault", description: "Vault" }],
				}) as never,
			)
			.mockReturnValueOnce(
				sdkQuery({
					commands: [{ name: "agent", description: "Agent" }],
				}) as never,
			);

		await prewarmClaudeCli({ executable: undefined, cwd: "/tmp/vault" });
		await prewarmClaudeCli({
			executable: undefined,
			cwd: "/tmp/vault",
			cacheCwd: "/tmp/agent",
		});

		expect(getClaudeWarmupSnapshot("/tmp/vault")?.commands[0]?.name).toBe(
			"vault",
		);
		expect(getClaudeWarmupSnapshot("/tmp/agent")?.commands[0]?.name).toBe(
			"agent",
		);
	});

	it("uses the exact Claude discovery cwd, settings, executable, and base environment", async () => {
		const sdk = sdkQuery();
		const baseEnv = {
			PATH: "/opt/claude/bin",
			CLAUDE_CONFIG_DIR: "/tmp/claude-warmup-config",
			ANTHROPIC_BASE_URL: "https://api.example.test",
		};
		vi.mocked(query).mockReturnValueOnce(sdk as never);

		await prewarmClaudeCli({
			executable: "/opt/claude/bin/claude",
			cwd: "/tmp/exact-auto-discovery",
			additionalDirectories: ["/tmp/exact-auto-vault"],
			env: baseEnv,
			readRuntimeVersion,
		});

		const call = vi.mocked(query).mock.calls[0]?.[0];
		expect(call?.options).toEqual(
			expect.objectContaining({
				cwd: "/tmp/exact-auto-discovery",
				settingSources: ["user", "project", "local"],
				settings: {
					crossSessionInbound: "refuse",
					dialogExpiry: "never",
				},
				pathToClaudeCodeExecutable: "/opt/claude/bin/claude",
				additionalDirectories: ["/tmp/exact-auto-vault"],
			}),
		);
		expect(call?.options?.env).toBe(baseEnv);
		expect(call?.options?.env).not.toHaveProperty(
			"CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS",
		);
	});

	it("probes raw Auto-capable model IDs and snapshots only affirmative enabled models", async () => {
		const sdk = sdkQuery({
			models: [
				{
					value: "sonnet-raw",
					resolvedModel: "claude-sonnet-5-20260801",
					supportsAutoMode: true,
				},
				{
					value: "opus-raw",
					resolvedModel: "claude-opus-5-20260801",
					supportsAutoMode: true,
				},
				{
					value: "haiku-raw",
					resolvedModel: "claude-haiku-5-20260801",
					supportsAutoMode: false,
				},
				{
					value: "legacy-raw",
					resolvedModel: "claude-legacy-20250101",
				},
			],
		});
		let selectedModel: string | undefined;
		sdk.setModel.mockImplementation(async (model) => {
			selectedModel = model;
		});
		sdk.setPermissionMode.mockImplementation(async (mode) => {
			if (mode === "auto" && selectedModel === "opus-raw") {
				throw new Error("Auto disabled for exact model");
			}
		});
		vi.mocked(query).mockReturnValueOnce(sdk as never);

		await prewarmClaudeCli({
			executable: "/usr/bin/claude",
			cwd: "/tmp/auto-model-readiness",
			readRuntimeVersion,
		});

		expect(sdk.getSettings).toHaveBeenCalledOnce();
		expect(sdk.setModel.mock.calls.map(([model]) => model)).toEqual([
			"sonnet-raw",
			"opus-raw",
			undefined,
		]);
		expect(sdk.setPermissionMode.mock.calls.map(([mode]) => mode)).toEqual([
			"auto",
			"default",
			"auto",
			"default",
		]);
		expect(
			getClaudeWarmupSnapshot("/tmp/auto-model-readiness")?.autoModeModels,
		).toEqual(["sonnet-raw", "claude-sonnet-5-20260801"]);
	});

	it("fails Auto readiness closed when effective settings disable Auto", async () => {
		const sdk = sdkQuery({
			models: [
				{
					value: "sonnet-raw",
					resolvedModel: "claude-sonnet-5-20260801",
					supportsAutoMode: true,
				},
			],
			settings: { effective: { disableAutoMode: "disable" } },
		});
		vi.mocked(query).mockReturnValueOnce(sdk as never);

		await prewarmClaudeCli({
			executable: "/usr/bin/claude",
			cwd: "/tmp/auto-disabled-settings",
			readRuntimeVersion,
		});

		expect(sdk.getSettings).toHaveBeenCalledOnce();
		expect(sdk.setModel).not.toHaveBeenCalled();
		expect(sdk.setPermissionMode).not.toHaveBeenCalled();
		expect(
			getClaudeWarmupSnapshot("/tmp/auto-disabled-settings")?.autoModeModels,
		).toEqual([]);
	});

	it("fails Auto readiness closed when effective settings cannot be read", async () => {
		const sdk = sdkQuery({
			models: [{ value: "sonnet-raw", supportsAutoMode: true }],
		});
		sdk.getSettings.mockRejectedValueOnce(new Error("settings unavailable"));
		vi.mocked(query).mockReturnValueOnce(sdk as never);

		await prewarmClaudeCli({
			executable: "/usr/bin/claude",
			cwd: "/tmp/auto-unreadable-settings",
			readRuntimeVersion,
		});

		expect(sdk.setModel).not.toHaveBeenCalled();
		expect(sdk.setPermissionMode).not.toHaveBeenCalled();
		expect(
			getClaudeWarmupSnapshot("/tmp/auto-unreadable-settings")?.autoModeModels,
		).toEqual([]);
	});

	it("bounds a stuck Auto readiness discovery and cleans up its abort and timer", async () => {
		vi.useFakeTimers();
		try {
			const sdk = sdkQuery({
				models: [{ value: "sonnet-raw", supportsAutoMode: true }],
			});
			sdk.getSettings.mockImplementation(() => new Promise<never>(() => {}));
			sdk.setPermissionMode.mockImplementation(
				() => new Promise<never>(() => {}),
			);
			vi.mocked(query).mockReturnValueOnce(sdk as never);

			let settled = false;
			const warming = prewarmClaudeCli({
				executable: "/usr/bin/claude",
				cwd: "/tmp/auto-readiness-timeout",
				readRuntimeVersion,
			}).then((result) => {
				settled = true;
				return result;
			});
			await vi.advanceTimersByTimeAsync(0);

			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(9_999);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await expect(warming).resolves.toBe(true);

			const call = vi.mocked(query).mock.calls[0]?.[0];
			expect(call?.options?.abortController?.signal.aborted).toBe(true);
			expect(
				getClaudeWarmupSnapshot("/tmp/auto-readiness-timeout")?.autoModeModels,
			).toEqual([]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("shares a filesystem-free cache key across equivalent WSL aliases", async () => {
		const configured =
			"\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\development\\repos\\hlid";
		const alias =
			"\\\\wsl$\\ubuntu-24.04\\home\\kyle\\development\\repos\\hlid\\.";
		vi.mocked(query).mockReturnValueOnce(
			sdkQuery({
				commands: [{ name: "wsl-command", description: "WSL" }],
			}) as never,
		);

		await prewarmClaudeCli({
			executable: undefined,
			cwd: "/tmp/wsl-runtime",
			cacheCwd: configured,
		});

		expect(getClaudeWarmupSnapshot(alias)?.commands[0]?.name).toBe(
			"wsl-command",
		);
		expect(
			getClaudeWarmupSnapshot(
				"\\\\wsl.localhost\\Other\\home\\kyle\\development\\repos\\hlid",
			),
		).toBeNull();
	});

	it("shares provider-wide MCPs with an archived scope without leaking project MCPs", async () => {
		vi.mocked(query)
			.mockReturnValueOnce(
				sdkQuery({
					mcp: [
						{
							name: "claude.ai Excalidraw",
							status: "connected",
							scope: "claudeai",
						},
						{
							name: "project-only",
							status: "connected",
							scope: "project",
						},
					],
				}) as never,
			)
			.mockReturnValueOnce(sdkQuery({ mcp: [] }) as never);

		await prewarmClaudeCli({
			executable: undefined,
			cwd: "/tmp/shared-source",
		});
		await prewarmClaudeCli({
			executable: undefined,
			cwd: "/tmp/archived-scope",
		});

		await expect(
			waitForClaudeWarmupSnapshot("/tmp/archived-scope"),
		).resolves.toEqual(
			expect.objectContaining({
				mcpServers: [
					{
						name: "claude.ai Excalidraw",
						status: "connected",
						scope: "claudeai",
					},
				],
			}),
		);
	});

	it("waits for a transient pending MCP connection to settle", async () => {
		vi.useFakeTimers();
		try {
			const sdk = sdkQuery();
			sdk.mcpServerStatus
				.mockResolvedValueOnce([
					{ name: "claude.ai Excalidraw", status: "pending" },
				])
				.mockResolvedValueOnce([
					{ name: "claude.ai Excalidraw", status: "connected" },
				]);
			vi.mocked(query).mockReturnValueOnce(sdk as never);

			const warming = prewarmClaudeCli({
				executable: "/usr/bin/claude",
				cwd: "/tmp/settled-mcp",
				readRuntimeVersion,
			});
			await vi.advanceTimersByTimeAsync(500);
			await warming;

			expect(sdk.mcpServerStatus).toHaveBeenCalledTimes(2);
			expect(getClaudeWarmupSnapshot("/tmp/settled-mcp")?.mcpServers).toEqual([
				{ name: "claude.ai Excalidraw", status: "connected" },
			]);
		} finally {
			vi.useRealTimers();
		}
	});
});
