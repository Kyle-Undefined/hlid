import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));
vi.mock("../lib/claudePath", () => ({
	resolveClaudeExecutable: vi.fn(() => "C:\\claude.exe"),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { HlidConfigSchema } from "../config";
import type { AgentEvent } from "./agentProvider";
import {
	CliProxyCodexProvider,
	cliProxyCodexProfile,
	cliProxyModelWithEffort,
	cliProxyOpenCodeConfig,
	normalizeCliProxyBaseUrl,
	stripCliProxyThinkingSuffix,
} from "./cliproxyProvider";

function config() {
	return HlidConfigSchema.parse({
		cliproxy: {
			enabled: true,
			base_url: "http://127.0.0.1:8317/",
			api_key: "local-secret",
			model: "gpt-5.6-sol",
			effort: "xhigh",
		},
	}).cliproxy;
}

function sdkGen(events: unknown[]) {
	const gen = (async function* () {
		for (const event of events) yield event;
	})();
	Object.assign(gen, {
		mcpServerStatus: vi.fn().mockResolvedValue([]),
		supportedCommands: vi.fn().mockResolvedValue([]),
	});
	// biome-ignore lint/suspicious/noExplicitAny: minimal SDK test double
	return gen as any;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("CLIProxy model routing", () => {
	it("normalizes the endpoint and thinking suffix", () => {
		expect(normalizeCliProxyBaseUrl("http://127.0.0.1:8317/v1/")).toBe(
			"http://127.0.0.1:8317",
		);
		expect(cliProxyModelWithEffort("gpt-5.6-sol(high)", "xhigh")).toBe(
			"gpt-5.6-sol(xhigh)",
		);
		expect(stripCliProxyThinkingSuffix("gpt-5.6-sol(32000)")).toBe(
			"gpt-5.6-sol",
		);
	});

	it("routes Claude Code through the sidecar without forwarding SDK cost", async () => {
		let options: Record<string, unknown> | undefined;
		vi.mocked(query).mockImplementationOnce((input) => {
			options = input.options as unknown as Record<string, unknown>;
			return sdkGen([
				{
					type: "assistant",
					parent_tool_use_id: null,
					message: {
						model: "gpt-5.6-sol(xhigh)",
						usage: { input_tokens: 100, output_tokens: 20 },
						content: [{ type: "text", text: "done" }],
					},
				},
				{
					type: "result",
					subtype: "success",
					total_cost_usd: 99,
					num_turns: 1,
					duration_ms: 10,
					usage: { input_tokens: 100, output_tokens: 20 },
				},
			]);
		});

		const session = new CliProxyCodexProvider(config()).query({
			cwd: "/work",
			model: "gpt-5.6-sol",
			effort: "xhigh",
			canUseTool: vi.fn().mockResolvedValue({ behavior: "allow" }),
		});
		await session.send("hello");
		const events: AgentEvent[] = [];
		for await (const event of session) events.push(event);

		expect(options?.model).toBe("gpt-5.6-sol(xhigh)");
		expect(options).not.toHaveProperty("effort");
		expect(options?.env).toMatchObject({
			ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
			ANTHROPIC_AUTH_TOKEN: "local-secret",
		});
		expect(events).toContainEqual(
			expect.objectContaining({ type: "usage", model: "gpt-5.6-sol" }),
		);
		expect(events.find((event) => event.type === "done")).not.toHaveProperty(
			"estimatedCost",
		);
	});

	it("retains Claude Code transcript forking through CLIProxy", () => {
		const provider = new CliProxyCodexProvider(config());
		expect(typeof provider.forkSession).toBe("function");
	});

	it("reads every routed model and preserves its upstream owner", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(() =>
				Promise.resolve(
					new Response(
						JSON.stringify({
							data: [
								{ id: "gpt-5.6-sol", owned_by: "openai" },
								{ id: "claude-sonnet-4-6", owned_by: "anthropic" },
							],
						}),
						{ status: 200 },
					),
				),
			),
		);
		const provider = new CliProxyCodexProvider(config());
		expect(await provider.listModels()).toEqual([
			{ value: "claude-sonnet-4-6", label: "Claude-Sonnet-4-6 · Anthropic" },
			{ value: "gpt-5.6-sol", label: "GPT-5.6-Sol · OpenAI" },
		]);
		expect(await provider.check()).toEqual({ available: true });
		expect(fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:8317/v1/models",
			expect.objectContaining({
				headers: { Authorization: "Bearer local-secret" },
			}),
		);
	});

	it("isolates Codex provider overrides and keeps the key in the environment", () => {
		const profile = cliProxyCodexProfile(config());
		expect(profile.registryKey).toMatch(
			/^cliproxy:http:\/\/127\.0\.0\.1:8317:[a-f0-9]{12}$/,
		);
		expect(profile.args).toContain('model_provider="hlid_cliproxy"');
		expect(profile.args?.join(" ")).toContain(
			'model_providers.hlid_cliproxy.env_key="HLID_CLIPROXY_API_KEY"',
		);
		expect(profile.args?.join(" ")).not.toContain("local-secret");
		expect(profile.env).toEqual({ HLID_CLIPROXY_API_KEY: "local-secret" });
	});

	it("builds an inline OpenCode overlay without embedding the key", () => {
		const content = cliProxyOpenCodeConfig("http://127.0.0.1:8317", [
			{ value: "claude-sonnet-4-6", label: "Claude · Anthropic" },
		]);
		expect(content).toContain("@ai-sdk/openai-compatible");
		expect(content).toContain("{env:HLID_CLIPROXY_API_KEY}");
		expect(content).toContain("claude-sonnet-4-6");
		expect(content).not.toContain("local-secret");
	});
});
