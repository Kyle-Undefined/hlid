import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));

import { query } from "@anthropic-ai/claude-agent-sdk";
import {
	getClaudeWarmupSnapshot,
	prewarmClaudeCli,
	waitForClaudeWarmupSnapshot,
} from "./claudeWarmup";

function sdkQuery(options?: {
	commands?: Array<{
		name: string;
		description: string;
		argumentHint?: string;
	}>;
	mcp?: Array<{ name: string; status: string; error?: string; scope?: string }>;
}) {
	return {
		initializationResult: vi.fn().mockResolvedValue({
			commands: options?.commands ?? [],
			agents: [{ name: "reviewer" }],
			models: [{ value: "sonnet" }],
		}),
		mcpServerStatus: vi.fn().mockResolvedValue(options?.mcp ?? []),
	};
}

describe("Claude startup metadata cache", () => {
	beforeEach(() => {
		vi.mocked(query).mockReset();
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
			}),
		).resolves.toBe(true);

		const call = vi.mocked(query).mock.calls[0]?.[0];
		expect(call?.prompt).not.toEqual(expect.any(String));
		expect(call?.options).toEqual(
			expect.objectContaining({
				cwd: "/tmp/project",
				persistSession: false,
				maxTurns: 1,
				additionalDirectories: ["/tmp/vault"],
			}),
		);
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
				cwd: "/tmp/project",
			}),
		);
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
