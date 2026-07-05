/**
 * ClaudeProvider unit tests — SDK event mapping, canUseTool pass-through,
 * session resume, retry-on-failure, and cancel.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));
vi.mock("../lib/claudePath", () => ({
	resolveClaudeExecutable: vi.fn(),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveClaudeExecutable } from "../lib/claudePath";
import type { AgentEvent, AgentQueryParams, CanUseTool } from "./agentProvider";
import { ClaudeProvider, mapClaudeModels } from "./claudeProvider";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal async-iterable SDK query response with mcpServerStatus(). */
function sdkGen(events: unknown[], mcpStatuses: unknown[] = []) {
	const gen = (async function* () {
		for (const e of events) yield e;
	})();
	Object.assign(gen, {
		mcpServerStatus: vi.fn().mockResolvedValue(mcpStatuses),
	});
	// Cast to the SDK's Query type: our generator satisfies the async-iterable
	// contract; the extra SDK-internal methods (interrupt, setPendingMessageId)
	// are never called in tests.
	// biome-ignore lint/suspicious/noExplicitAny: test mock
	return gen as any;
}

function baseParams(
	overrides: Partial<AgentQueryParams> = {},
): AgentQueryParams {
	return {
		cwd: "/tmp/test",
		canUseTool: vi.fn().mockResolvedValue({ behavior: "allow" }),
		...overrides,
	};
}

async function collectEvents(params: AgentQueryParams): Promise<AgentEvent[]> {
	const provider = new ClaudeProvider();
	const events: AgentEvent[] = [];
	for await (const e of provider.query(params)) {
		events.push(e);
	}
	return events;
}

// ── event mapping ─────────────────────────────────────────────────────────────

describe("ClaudeProvider — event mapping", () => {
	it("yields session_start with sessionId from system/init", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{ type: "system", subtype: "init", session_id: "sid-abc", tools: [] },
				{
					type: "result",
					subtype: "success",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 100,
					usage: { input_tokens: 10, output_tokens: 5 },
				},
			]),
		);

		const events = await collectEvents(baseParams());
		expect(events[0]).toEqual({ type: "session_start", sessionId: "sid-abc" });
	});

	it("yields text_delta for assistant text content blocks", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "assistant",
					message: {
						content: [{ type: "text", text: "Hello world" }],
						usage: { input_tokens: 10, output_tokens: 5 },
					},
				},
				{
					type: "result",
					subtype: "success",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 100,
					usage: { input_tokens: 10, output_tokens: 5 },
				},
			]),
		);

		const events = await collectEvents(baseParams());
		const textEvents = events.filter((e) => e.type === "text_delta");
		expect(textEvents).toEqual([{ type: "text_delta", text: "Hello world" }]);
	});

	it("yields tool_start for assistant tool_use content blocks", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "assistant",
					message: {
						content: [
							{
								type: "tool_use",
								id: "t-1",
								name: "Bash",
								input: { command: "ls" },
							},
						],
						usage: { input_tokens: 10, output_tokens: 5 },
					},
				},
				{
					type: "result",
					subtype: "success",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 100,
					usage: { input_tokens: 10, output_tokens: 5 },
				},
			]),
		);

		const events = await collectEvents(baseParams());
		const toolEvents = events.filter((e) => e.type === "tool_start");
		expect(toolEvents).toEqual([
			{
				type: "tool_start",
				toolId: "t-1",
				name: "Bash",
				input: { command: "ls" },
			},
		]);
	});

	it("yields tool_result for user tool_result content blocks (string)", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "user",
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: "t-1",
								content: "file1\nfile2",
							},
						],
					},
				},
				{
					type: "result",
					subtype: "success",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 100,
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			]),
		);
		const events = await collectEvents(baseParams());
		const trs = events.filter((e) => e.type === "tool_result");
		expect(trs).toEqual([
			{ type: "tool_result", toolId: "t-1", content: "file1\nfile2" },
		]);
	});

	it("yields tool_result with isError=true and concatenates text array content", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "user",
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: "t-2",
								is_error: true,
								content: [
									{ type: "text", text: "line1\n" },
									{ type: "text", text: "line2" },
								],
							},
						],
					},
				},
				{
					type: "result",
					subtype: "success",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 100,
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			]),
		);
		const events = await collectEvents(baseParams());
		const trs = events.filter((e) => e.type === "tool_result");
		expect(trs).toEqual([
			{
				type: "tool_result",
				toolId: "t-2",
				content: "line1\nline2",
				isError: true,
			},
		]);
	});

	it("truncates tool_result content past 8KB", async () => {
		const big = "x".repeat(10_000);
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "user",
					message: {
						content: [
							{ type: "tool_result", tool_use_id: "t-3", content: big },
						],
					},
				},
				{
					type: "result",
					subtype: "success",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 100,
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			]),
		);
		const events = await collectEvents(baseParams());
		const tr = events.find((e) => e.type === "tool_result");
		if (!tr || tr.type !== "tool_result") throw new Error("missing");
		expect(tr.content.length).toBeLessThanOrEqual(8192 + 64);
		expect(tr.content).toContain("[truncated");
	});

	it("yields usage from assistant message usage data", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "assistant",
					message: {
						content: [],
						model: "claude-sonnet-4-6",
						usage: {
							input_tokens: 100,
							output_tokens: 50,
							cache_read_input_tokens: 20,
							cache_creation_input_tokens: 10,
						},
					},
				},
				{
					type: "result",
					subtype: "success",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 100,
					usage: { input_tokens: 100, output_tokens: 50 },
				},
			]),
		);

		const events = await collectEvents(baseParams());
		const usageEvent = events.find((e) => e.type === "usage");
		expect(usageEvent).toMatchObject({
			type: "usage",
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 20,
			cacheCreationTokens: 10,
			model: "claude-sonnet-4-6",
		});
	});

	it("yields summary from tool_use_summary event", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "tool_use_summary",
					summary: "Ran lint and fixed 2 warnings.",
					preceding_tool_use_ids: [],
					uuid: "u1",
					session_id: "s1",
				},
				{
					type: "result",
					subtype: "success",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 100,
					usage: { input_tokens: 10, output_tokens: 5 },
				},
			]),
		);

		const events = await collectEvents(baseParams());
		const summaryEvent = events.find((e) => e.type === "summary");
		expect(summaryEvent).toEqual({
			type: "summary",
			text: "Ran lint and fixed 2 warnings.",
		});
	});

	it("yields rate_limit from rate_limit_event", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "rate_limit_event",
					rate_limit_info: {
						status: "warn",
						rateLimitType: "five_hour",
						utilization: 0.8,
						resetsAt: "2025-01-01T00:00:00Z",
					},
				},
				{
					type: "result",
					subtype: "success",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 100,
					usage: { input_tokens: 10, output_tokens: 5 },
				},
			]),
		);

		const events = await collectEvents(baseParams());
		const rlEvent = events.find((e) => e.type === "rate_limit");
		expect(rlEvent).toMatchObject({
			type: "rate_limit",
			status: "warn",
			rateLimitType: "five_hour",
			utilization: 0.8,
		});
	});

	it("yields done with cost, turns, stopReason from result event", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "result",
					subtype: "success",
					total_cost_usd: 1.23,
					num_turns: 3,
					duration_ms: 5000,
					stop_reason: "end_turn",
					usage: { input_tokens: 10, output_tokens: 5 },
				},
			]),
		);

		const events = await collectEvents(baseParams());
		const doneEvent = events.find((e) => e.type === "done");
		expect(doneEvent).toMatchObject({
			type: "done",
			cost: 1.23,
			turns: 3,
			durationMs: 5000,
			stopReason: "end_turn",
		});
	});

	it("done includes aggregated usage from result event", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "result",
					subtype: "success",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 100,
					usage: {
						input_tokens: 200,
						output_tokens: 100,
						cache_read_input_tokens: 50,
						cache_creation_input_tokens: 25,
					},
				},
			]),
		);

		const events = await collectEvents(baseParams());
		const doneEvent = events.find((e) => e.type === "done") as Extract<
			AgentEvent,
			{ type: "done" }
		>;
		expect(doneEvent?.usage).toEqual({
			inputTokens: 200,
			outputTokens: 100,
			cacheReadTokens: 50,
			cacheCreationTokens: 25,
		});
	});

	it("yields text_delta from result.result when no prior text emitted (slash command fallback)", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "result",
					subtype: "success",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 100,
					result: "Slash command output",
					usage: { input_tokens: 10, output_tokens: 5 },
				},
			]),
		);

		const events = await collectEvents(baseParams());
		const textEvents = events.filter((e) => e.type === "text_delta");
		expect(textEvents).toEqual([
			{ type: "text_delta", text: "Slash command output" },
		]);
	});

	it("does NOT yield text_delta from result.result when prior text was already emitted", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "assistant",
					message: {
						content: [{ type: "text", text: "regular text" }],
						usage: { input_tokens: 10, output_tokens: 5 },
					},
				},
				{
					type: "result",
					subtype: "success",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 100,
					result: "should not appear",
					usage: { input_tokens: 10, output_tokens: 5 },
				},
			]),
		);

		const events = await collectEvents(baseParams());
		const textEvents = events.filter((e) => e.type === "text_delta");
		expect(textEvents).toHaveLength(1);
		expect(textEvents[0]).toEqual({ type: "text_delta", text: "regular text" });
	});
});

// ── canUseTool pass-through ────────────────────────────────────────────────────

describe("ClaudeProvider — canUseTool pass-through", () => {
	it("calls canUseTool when SDK fires it and passes allow decision to SDK", async () => {
		const canUseTool = vi.fn().mockResolvedValue({
			behavior: "allow",
			updatedInput: { command: "ls -la" },
		});

		vi.mocked(query).mockImplementation(() => {
			return sdkGen([
				{ type: "system", subtype: "init", session_id: "s1", tools: [] },
			]);
		});

		// Simpler: verify canUseTool is wired by checking the SDK receives it
		let capturedCanUseTool: CanUseTool | undefined;
		// biome-ignore lint/suspicious/noExplicitAny: test mock — SDK query type has extra internal methods
		const captureImpl1: any = ({
			options,
		}: {
			prompt: unknown;
			options?: { canUseTool: CanUseTool };
		}) => {
			capturedCanUseTool = options?.canUseTool;
			return sdkGen([
				{
					type: "result",
					subtype: "success",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 100,
					usage: { input_tokens: 10, output_tokens: 5 },
				},
			]);
		};
		vi.mocked(query).mockImplementationOnce(captureImpl1);

		const provider = new ClaudeProvider();
		for await (const _ of provider.query(baseParams({ canUseTool }))) {
			// drain
		}

		// canUseTool passed through to SDK
		expect(capturedCanUseTool).toBeDefined();

		// Call the captured function to verify it delegates to our canUseTool
		const signal = new AbortController().signal;
		const result = await capturedCanUseTool?.(
			"Bash",
			{ command: "ls" },
			{
				toolUseID: "t1",
				signal,
			},
		);
		expect(canUseTool).toHaveBeenCalledWith(
			"Bash",
			{ command: "ls" },
			{
				toolUseID: "t1",
				signal,
			},
		);
		expect(result).toEqual({
			behavior: "allow",
			updatedInput: { command: "ls -la" },
		});
	});

	it("passes deny decision from canUseTool back to SDK", async () => {
		const canUseTool = vi.fn().mockResolvedValue({
			behavior: "deny",
			message: "not allowed",
		});

		let capturedCanUseTool: CanUseTool | undefined;
		// biome-ignore lint/suspicious/noExplicitAny: test mock — SDK query type has extra internal methods
		const captureImpl2: any = ({
			options,
		}: {
			prompt: unknown;
			options?: { canUseTool: CanUseTool };
		}) => {
			capturedCanUseTool = options?.canUseTool;
			return sdkGen([
				{
					type: "result",
					subtype: "success",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 100,
					usage: { input_tokens: 10, output_tokens: 5 },
				},
			]);
		};
		vi.mocked(query).mockImplementationOnce(captureImpl2);

		const provider = new ClaudeProvider();
		for await (const _ of provider.query(baseParams({ canUseTool }))) {
			// drain
		}

		const signal = new AbortController().signal;
		const result = await capturedCanUseTool?.(
			"Read",
			{},
			{ toolUseID: "t2", signal },
		);
		expect(result).toEqual({ behavior: "deny", message: "not allowed" });
	});
});

// ── local_command_output ──────────────────────────────────────────────────────

describe("ClaudeProvider — local_command_output", () => {
	it("yields local_command_output event for system/local_command_output messages", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "system",
					subtype: "local_command_output",
					content: "Available commands: /help /usage",
					uuid: "uuid-1",
					session_id: "sid-abc",
				},
				{
					type: "result",
					subtype: "success",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 100,
					usage: { input_tokens: 10, output_tokens: 5 },
				},
			]),
		);

		const events = await collectEvents(baseParams());
		const cmdEvent = events.find((e) => e.type === "local_command_output");
		expect(cmdEvent).toEqual({
			type: "local_command_output",
			content: "Available commands: /help /usage",
		});
	});

	it("still yields done event after local_command_output", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "system",
					subtype: "local_command_output",
					content: "some output",
					uuid: "uuid-2",
					session_id: "sid-abc",
				},
				{
					type: "result",
					subtype: "success",
					total_cost_usd: 0.001,
					num_turns: 1,
					duration_ms: 50,
					usage: { input_tokens: 5, output_tokens: 2 },
				},
			]),
		);

		const events = await collectEvents(baseParams());
		const doneEvent = events.find((e) => e.type === "done");
		expect(doneEvent).toBeDefined();
	});
});

// ── supportedCommands ─────────────────────────────────────────────────────────

describe("ClaudeProvider — supportedCommands", () => {
	it("delegates supportedCommands() to the underlying SDK query", async () => {
		const mockCommands = [
			{ name: "help", description: "Show help", argumentHint: "" },
			{ name: "usage", description: "Show usage", argumentHint: "" },
		];
		const gen = sdkGen([
			{
				type: "result",
				subtype: "success",
				total_cost_usd: 0,
				num_turns: 1,
				duration_ms: 100,
				usage: { input_tokens: 10, output_tokens: 5 },
			},
		]);
		gen.supportedCommands = vi.fn().mockResolvedValue(mockCommands);
		vi.mocked(query).mockReturnValueOnce(gen);

		const provider = new ClaudeProvider();
		const session = provider.query(baseParams());

		const iter = session[Symbol.asyncIterator]();
		await iter.next();

		const commands = await session.supportedCommands?.();
		expect(commands).toEqual(mockCommands);
	});

	it("returns empty array when SDK query not yet initialized", async () => {
		const provider = new ClaudeProvider();
		const session = provider.query(baseParams());
		const commands = await session.supportedCommands?.();
		expect(commands).toEqual([]);
	});
});

// ── mcpServerStatus ───────────────────────────────────────────────────────────

describe("ClaudeProvider — mcpServerStatus", () => {
	it("delegates mcpServerStatus() to the underlying SDK query", async () => {
		const mockStatuses = [{ name: "my-server", status: "connected" }];
		const gen = sdkGen(
			[
				{
					type: "result",
					subtype: "success",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 100,
					usage: { input_tokens: 10, output_tokens: 5 },
				},
			],
			mockStatuses,
		);
		vi.mocked(query).mockReturnValueOnce(gen);

		const provider = new ClaudeProvider();
		const session = provider.query(baseParams());

		// Start iteration to initialize the SDK query
		const iter = session[Symbol.asyncIterator]();
		await iter.next();

		const statuses = await session.mcpServerStatus?.();
		expect(statuses).toEqual(mockStatuses);
	});
});

// ── cancel ────────────────────────────────────────────────────────────────────

describe("ClaudeProvider — cancel", () => {
	it("cancel() aborts the underlying AbortController", async () => {
		let capturedAbortController: AbortController | undefined;
		vi.mocked(query).mockImplementationOnce(
			({
				options,
			}: {
				prompt: unknown;
				options?: { abortController?: AbortController };
			}) => {
				capturedAbortController = options?.abortController;
				return sdkGen([
					{
						type: "result",
						subtype: "success",
						total_cost_usd: 0,
						num_turns: 1,
						duration_ms: 100,
						usage: { input_tokens: 10, output_tokens: 5 },
					},
				]);
			},
		);

		const provider = new ClaudeProvider();
		const session = provider.query(baseParams());
		const iter = session[Symbol.asyncIterator]();
		await iter.next();

		expect(capturedAbortController?.signal.aborted).toBe(false);
		session.cancel();
		expect(capturedAbortController?.signal.aborted).toBe(true);
	});
});

// ── session resume ─────────────────────────────────────────────────────────────

describe("ClaudeProvider — session resume", () => {
	it("passes sessionId as resume option to SDK query()", async () => {
		let capturedOptions: unknown;
		vi.mocked(query).mockImplementationOnce(
			({ options }: { prompt: unknown; options?: unknown }) => {
				capturedOptions = options;
				return sdkGen([
					{
						type: "result",
						subtype: "success",
						total_cost_usd: 0,
						num_turns: 1,
						duration_ms: 100,
						usage: { input_tokens: 10, output_tokens: 5 },
					},
				]);
			},
		);

		const provider = new ClaudeProvider();
		for await (const _ of provider.query(
			baseParams({ sessionId: "resume-id-123" }),
		)) {
			// drain
		}

		expect((capturedOptions as { resume?: string }).resume).toBe(
			"resume-id-123",
		);
	});

	it("does not pass resume option when sessionId is undefined", async () => {
		let capturedOptions: unknown;
		vi.mocked(query).mockImplementationOnce(
			({ options }: { prompt: unknown; options?: unknown }) => {
				capturedOptions = options;
				return sdkGen([
					{
						type: "result",
						subtype: "success",
						total_cost_usd: 0,
						num_turns: 1,
						duration_ms: 100,
						usage: { input_tokens: 10, output_tokens: 5 },
					},
				]);
			},
		);

		const provider = new ClaudeProvider();
		for await (const _ of provider.query(
			baseParams({ sessionId: undefined }),
		)) {
			// drain
		}

		expect("resume" in (capturedOptions as object)).toBe(false);
	});

	it("retries without sessionId when resume fails before any events received", async () => {
		const queryCalls: Array<{ options: unknown }> = [];

		vi.mocked(query).mockImplementation(
			({ options }: { prompt: unknown; options?: unknown }) => {
				queryCalls.push({ options });
				const callIndex = queryCalls.length;
				if (callIndex === 1) {
					// First call (with resume) — throws immediately, no events
					const gen = (async function* () {
						throw new Error("session not found");
						// biome-ignore lint/correctness/noUnreachable: satisfies AsyncGenerator contract
						yield;
					})();
					Object.assign(gen, { mcpServerStatus: () => Promise.resolve([]) });
					return gen;
				}
				// Second call (fresh) — succeeds
				return sdkGen([
					{ type: "system", subtype: "init", session_id: "new-sid", tools: [] },
					{
						type: "result",
						subtype: "success",
						total_cost_usd: 0,
						num_turns: 1,
						duration_ms: 100,
						usage: { input_tokens: 10, output_tokens: 5 },
					},
				]);
			},
		);

		const events: AgentEvent[] = [];
		const provider = new ClaudeProvider();
		for await (const e of provider.query(
			baseParams({ sessionId: "stale-id" }),
		)) {
			events.push(e);
		}

		expect(queryCalls).toHaveLength(2);
		expect((queryCalls[0].options as { resume?: string }).resume).toBe(
			"stale-id",
		);
		expect("resume" in (queryCalls[1].options as object)).toBe(false);
		// New session start from the fresh retry
		expect(
			events.some(
				(e) =>
					e.type === "session_start" &&
					(e as { sessionId: string }).sessionId === "new-sid",
			),
		).toBe(true);
	});

	it("does not retry when events were already received before error", async () => {
		let callCount = 0;
		// biome-ignore lint/suspicious/noExplicitAny: test mock — SDK query type has extra internal methods
		const midStreamImpl: any = () => {
			callCount++;
			const gen = (async function* () {
				yield {
					type: "system",
					subtype: "init",
					session_id: "s1",
					tools: [],
				};
				throw new Error("mid-stream error");
			})();
			Object.assign(gen, { mcpServerStatus: () => Promise.resolve([]) });
			return gen;
		};
		vi.mocked(query).mockImplementation(midStreamImpl);

		const provider = new ClaudeProvider();
		await expect(async () => {
			for await (const _ of provider.query(
				baseParams({ sessionId: "some-id" }),
			)) {
				// drain
			}
		}).rejects.toThrow("mid-stream error");

		expect(callCount).toBe(1);
	});
});

// ── persistSession ────────────────────────────────────────────────────────────

describe("ClaudeProvider — persistSession", () => {
	it("passes persistSession: false to SDK options when specified", async () => {
		let capturedOptions: unknown;
		vi.mocked(query).mockImplementationOnce(
			({ options }: { prompt: unknown; options?: unknown }) => {
				capturedOptions = options;
				return sdkGen([
					{
						type: "result",
						subtype: "success",
						total_cost_usd: 0,
						num_turns: 1,
						duration_ms: 100,
						usage: { input_tokens: 10, output_tokens: 5 },
					},
				]);
			},
		);

		const provider = new ClaudeProvider();
		for await (const _ of provider.query(
			baseParams({ persistSession: false }),
		)) {
			// drain
		}

		expect(
			(capturedOptions as { persistSession?: boolean }).persistSession,
		).toBe(false);
	});
});

// ── providerId + proxyConfig ───────────────────────────────────────────────────

describe("ClaudeProvider — providerId + proxyConfig", () => {
	it("has providerId = 'claude'", () => {
		const provider = new ClaudeProvider();
		expect(provider.providerId).toBe("claude");
	});

	it("proxyConfig.envVar is ANTHROPIC_BASE_URL", () => {
		const provider = new ClaudeProvider();
		expect(provider.proxyConfig.envVar).toBe("ANTHROPIC_BASE_URL");
	});

	it("proxyConfig.windowIds contains all three Anthropic windows", () => {
		const provider = new ClaudeProvider();
		expect(provider.proxyConfig.windowIds).toEqual(
			expect.arrayContaining(["five_hour", "weekly", "weekly_sonnet"]),
		);
	});

	it("parseHeaders returns empty array when no Anthropic headers present", () => {
		const provider = new ClaudeProvider();
		const result = provider.proxyConfig.parseHeaders(new Headers());
		expect(result).toEqual([]);
	});

	it("parseHeaders extracts 5-hour utilization", () => {
		const provider = new ClaudeProvider();
		const headers = new Headers({
			"anthropic-ratelimit-unified-5h-utilization": "0.73",
			"anthropic-ratelimit-unified-5h-reset": "1700000000",
		});
		const result = provider.proxyConfig.parseHeaders(headers);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			windowId: "five_hour",
			label: "5-HOUR",
			utilization: 0.73,
			remaining: null,
			resetsAt: 1700000000,
		});
	});

	it("parseHeaders converts percentage (>= 1) to 0–1 fraction", () => {
		const provider = new ClaudeProvider();
		const headers = new Headers({
			"anthropic-ratelimit-unified-5h-utilization": "73",
		});
		const result = provider.proxyConfig.parseHeaders(headers);
		expect(result[0]?.utilization).toBeCloseTo(0.73);
	});

	it("parseHeaders extracts 7-day and sonnet windows when present", () => {
		const provider = new ClaudeProvider();
		const headers = new Headers({
			"anthropic-ratelimit-unified-7d-utilization": "0.5",
			"anthropic-ratelimit-unified-7d_sonnet-utilization": "0.2",
		});
		const result = provider.proxyConfig.parseHeaders(headers);
		const ids = result.map((r) => r.windowId);
		expect(ids).toContain("weekly");
		expect(ids).toContain("weekly_sonnet");
	});

	it("parseHeaders skips windows with non-finite utilization", () => {
		const provider = new ClaudeProvider();
		const headers = new Headers({
			"anthropic-ratelimit-unified-5h-utilization": "nan",
		});
		const result = provider.proxyConfig.parseHeaders(headers);
		expect(result).toEqual([]);
	});
});

// ── ClaudeProvider — check() ──────────────────────────────────────────────────

describe("ClaudeProvider — check()", () => {
	it("returns available: true when resolveClaudeExecutable returns a path", async () => {
		vi.mocked(resolveClaudeExecutable).mockReturnValueOnce(
			"/usr/local/bin/claude",
		);
		const provider = new ClaudeProvider();
		const result = await provider.check();
		expect(result).toEqual({ available: true });
	});

	it("returns available: false with reason when resolveClaudeExecutable returns undefined", async () => {
		vi.mocked(resolveClaudeExecutable).mockReturnValueOnce(undefined);
		const provider = new ClaudeProvider();
		const result = await provider.check();
		expect(result).toEqual({
			available: false,
			reason: "Claude Code CLI not found",
		});
	});
});

// ── Slice B: streaming-input mode ─────────────────────────────────────────────

describe("ClaudeProvider — Slice B streaming-input", () => {
	it("opens SDK query with AsyncIterable prompt (not a string)", async () => {
		let capturedPrompt: unknown;
		vi.mocked(query).mockImplementationOnce(
			({ prompt }: { prompt: unknown; options?: unknown }) => {
				capturedPrompt = prompt;
				return sdkGen([]);
			},
		);
		const provider = new ClaudeProvider();
		const session = provider.query(baseParams());
		// The SDK query is opened lazily on first send.
		await session.send("hi");
		expect(typeof capturedPrompt).toBe("object");
		expect(capturedPrompt).not.toBeNull();
		expect(
			typeof (capturedPrompt as { [Symbol.asyncIterator]?: unknown })[
				Symbol.asyncIterator
			],
		).toBe("function");
		session.cancel();
	});

	it("send() pushes a SDKUserMessage onto the prompt stream", async () => {
		let capturedPrompt: AsyncIterable<unknown> | undefined;
		vi.mocked(query).mockImplementationOnce(
			({ prompt }: { prompt: unknown; options?: unknown }) => {
				capturedPrompt = prompt as AsyncIterable<unknown>;
				return sdkGen([]);
			},
		);
		const provider = new ClaudeProvider();
		const session = provider.query(baseParams());
		await session.send("hello world");

		// Pull the first SDKUserMessage out of the captured stream.
		const iter = (capturedPrompt as AsyncIterable<unknown>)[
			Symbol.asyncIterator
		]();
		const result = await Promise.race([
			iter.next(),
			new Promise<never>((_, rej) =>
				setTimeout(() => rej(new Error("send didn't push within 200ms")), 200),
			),
		]);
		expect((result as IteratorResult<unknown>).done).toBe(false);
		const sdkMsg = (
			result as IteratorResult<{
				type: string;
				message: { content: Array<{ type: string; text: string }> };
			}>
		).value;
		expect(sdkMsg.type).toBe("user");
		expect(sdkMsg.message.content[0].text).toBe("hello world");
	});

	it("multiple send() calls in one session result in a single SDK query() invocation", async () => {
		vi.mocked(query).mockClear();
		vi.mocked(query).mockImplementation(() =>
			sdkGen([
				{
					type: "system",
					subtype: "init",
					session_id: "sid-1",
					tools: [],
				},
			]),
		);
		const provider = new ClaudeProvider();
		const session = provider.query(baseParams());
		await session.send("first");
		await session.send("second");
		expect(vi.mocked(query)).toHaveBeenCalledTimes(1);
		session.cancel();
	});

	it("send() with priority='now' tags the SDKUserMessage", async () => {
		let capturedPrompt: AsyncIterable<unknown> | undefined;
		vi.mocked(query).mockImplementationOnce(
			({ prompt }: { prompt: unknown; options?: unknown }) => {
				capturedPrompt = prompt as AsyncIterable<unknown>;
				return sdkGen([]);
			},
		);
		const provider = new ClaudeProvider();
		const session = provider.query(baseParams());
		await session.send("urgent", { priority: "now" });

		const iter = (capturedPrompt as AsyncIterable<unknown>)[
			Symbol.asyncIterator
		]();
		const result = await iter.next();
		expect((result.value as { priority?: string }).priority).toBe("now");
	});

	it("regression: for-await `return` from consumer does not close the cached iterator", async () => {
		// Real-world bug observed in raven: after turn 1's `done` event,
		// iterateConversation does an early `return` from the for-await loop.
		// Without the wrapper, that calls iter.return() and closes the
		// AsyncGenerator — turn 2 then hangs with no events ever emitted.
		const events: Array<Record<string, unknown>> = [
			{ type: "system", subtype: "init", session_id: "sid-1", tools: [] },
			{
				type: "result",
				subtype: "success",
				total_cost_usd: 0,
				num_turns: 1,
				duration_ms: 100,
				usage: { input_tokens: 1, output_tokens: 1 },
			},
			{
				type: "assistant",
				message: {
					content: [{ type: "text", text: "second-turn-marker" }],
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			},
			{
				type: "result",
				subtype: "success",
				total_cost_usd: 0,
				num_turns: 1,
				duration_ms: 100,
				usage: { input_tokens: 1, output_tokens: 1 },
			},
		];
		vi.mocked(query).mockReturnValueOnce(sdkGen(events));
		const provider = new ClaudeProvider();
		const session = provider.query(baseParams());
		await session.send("turn 1");

		// Drain turn 1's events — break out as iterateConversation does.
		const collected1: AgentEvent[] = [];
		for await (const e of session) {
			collected1.push(e);
			if (e.type === "done") break;
		}
		expect(collected1.some((e) => e.type === "done")).toBe(true);

		await session.send("turn 2");
		// Without the wrapper fix, this for-await yields nothing and the
		// loop exits immediately (cached iter is closed).
		const collected2: AgentEvent[] = [];
		for await (const e of session) {
			collected2.push(e);
			if (e.type === "done") break;
		}
		expect(collected2.some((e) => e.type === "done")).toBe(true);
		expect(
			collected2.some(
				(e) => e.type === "text_delta" && e.text === "second-turn-marker",
			),
		).toBe(true);
		session.cancel();
	});

	it("send() defaults priority to 'next' when no opts given", async () => {
		let capturedPrompt: AsyncIterable<unknown> | undefined;
		vi.mocked(query).mockImplementationOnce(
			({ prompt }: { prompt: unknown; options?: unknown }) => {
				capturedPrompt = prompt as AsyncIterable<unknown>;
				return sdkGen([]);
			},
		);
		const provider = new ClaudeProvider();
		const session = provider.query(baseParams());
		await session.send("regular");

		const iter = (capturedPrompt as AsyncIterable<unknown>)[
			Symbol.asyncIterator
		]();
		const result = await iter.next();
		expect((result.value as { priority?: string }).priority).toBe("next");
	});
});

// ── Provider capability declarations ─────────────────────────────────────────

describe("ClaudeProvider capability declarations", () => {
	it("exposes a non-empty models array", () => {
		const p = new ClaudeProvider();
		const models = p.models ?? [];
		expect(models.length).toBeGreaterThan(0);
		// All entries must have value + label strings
		for (const m of models) {
			expect(typeof m.value).toBe("string");
			expect(typeof m.label).toBe("string");
		}
	});

	it("exposes a non-empty effortLevels array", () => {
		const p = new ClaudeProvider();
		const effortLevels = p.effortLevels ?? [];
		expect(effortLevels.length).toBeGreaterThan(0);
		const values = effortLevels.map((e) => e.value);
		expect(values).toContain("low");
		expect(values).toContain("high");
		expect(values).toContain("max");
	});

	it("exposes a non-empty permissionModes array", () => {
		const p = new ClaudeProvider();
		const permissionModes = p.permissionModes ?? [];
		expect(permissionModes.length).toBeGreaterThan(0);
		const values = permissionModes.map((m) => m.value);
		expect(values).toContain("default");
		expect(values).toContain("acceptEdits");
		expect(values).toContain("bypassPermissions");
	});

	it("includes desc on effortLevels entries", () => {
		const p = new ClaudeProvider();
		const effortLevels = p.effortLevels ?? [];
		for (const e of effortLevels) {
			expect(typeof e.desc).toBe("string");
			expect((e.desc ?? "").length).toBeGreaterThan(0);
		}
	});
});

// ── mapClaudeModels ───────────────────────────────────────────────────────────

describe("mapClaudeModels", () => {
	it("maps value/displayName/description and per-model efforts when supportsEffort is true", () => {
		const result = mapClaudeModels([
			{
				value: "claude-opus-4-8",
				displayName: "Opus 4.8",
				description: "Most capable model",
				supportsEffort: true,
				supportedEffortLevels: ["low", "high", "max"],
			},
		]);
		expect(result).toEqual([
			{
				value: "claude-opus-4-8",
				label: "Opus 4.8",
				description: "Most capable model",
				efforts: [
					{
						value: "low",
						label: "Low",
						desc: "minimal thinking, quick turnaround",
					},
					{
						value: "high",
						label: "High",
						desc: "solid reasoning, this is the default",
					},
					{
						value: "max",
						label: "Max",
						desc: "everything Claude has, Opus only",
					},
				],
			},
		]);
	});

	it("omits efforts when supportsEffort is false, even if supportedEffortLevels is present", () => {
		const result = mapClaudeModels([
			{
				value: "claude-haiku-4-5",
				displayName: "Haiku 4.5",
				description: "Fast model",
				supportsEffort: false,
				supportedEffortLevels: ["low", "high"],
			},
		]);
		expect(result).toEqual([
			{
				value: "claude-haiku-4-5",
				label: "Haiku 4.5",
				description: "Fast model",
				efforts: undefined,
			},
		]);
	});

	it("omits efforts when supportsEffort is missing", () => {
		const result = mapClaudeModels([
			{
				value: "claude-sonnet-4-6",
				displayName: "Sonnet 4.6",
				description: "Balanced model",
			},
		]);
		expect(result[0]?.efforts).toBeUndefined();
	});

	it("falls back to value when displayName is missing/empty", () => {
		const result = mapClaudeModels([
			{ value: "claude-x", displayName: "", description: "" },
		]);
		expect(result[0]?.label).toBe("claude-x");
	});

	it("never sets isDefault (SDK has no default-model marker)", () => {
		const result = mapClaudeModels([
			{ value: "claude-opus-4-8", displayName: "Opus 4.8", description: "" },
		]);
		expect(result[0]).not.toHaveProperty("isDefault");
	});
});

// ── listModels ─────────────────────────────────────────────────────────────────

describe("ClaudeProvider — listModels", () => {
	it("calls supportedModels() on a throwaway query and maps the result", async () => {
		const sdkModels = [
			{
				value: "claude-opus-4-8",
				displayName: "Opus 4.8",
				description: "desc",
				supportsEffort: true,
				supportedEffortLevels: ["low", "high"],
			},
		];
		let capturedOptions: Record<string, unknown> | undefined;
		vi.mocked(query).mockImplementationOnce(
			({ options }: { prompt: unknown; options?: Record<string, unknown> }) => {
				capturedOptions = options;
				const gen = sdkGen([]);
				gen.supportedModels = vi.fn().mockResolvedValue(sdkModels);
				return gen;
			},
		);

		const provider = new ClaudeProvider();
		const models = await provider.listModels();

		expect(models).toEqual([
			{
				value: "claude-opus-4-8",
				label: "Opus 4.8",
				description: "desc",
				efforts: [
					{
						value: "low",
						label: "Low",
						desc: "minimal thinking, quick turnaround",
					},
					{
						value: "high",
						label: "High",
						desc: "solid reasoning, this is the default",
					},
				],
			},
		]);
		// Throwaway-query shape: ephemeral, no persistence, single turn, denies tools.
		expect(capturedOptions?.persistSession).toBe(false);
		expect(capturedOptions?.settingSources).toEqual([]);
		expect(capturedOptions?.maxTurns).toBe(1);
		const canUseTool = capturedOptions?.canUseTool as CanUseTool;
		await expect(
			canUseTool(
				"Bash",
				{},
				{ toolUseID: "t", signal: new AbortController().signal },
			),
		).resolves.toEqual({ behavior: "deny", message: "catalog probe" });
	});

	it("aborts the throwaway query's AbortController when done", async () => {
		let capturedAbortController: AbortController | undefined;
		vi.mocked(query).mockImplementationOnce(
			({
				options,
			}: {
				prompt: unknown;
				options?: { abortController?: AbortController };
			}) => {
				capturedAbortController = options?.abortController;
				const gen = sdkGen([]);
				gen.supportedModels = vi.fn().mockResolvedValue([]);
				return gen;
			},
		);

		const provider = new ClaudeProvider();
		await provider.listModels();
		expect(capturedAbortController?.signal.aborted).toBe(true);
	});

	it("rejects (does not swallow) when supportedModels() times out", async () => {
		vi.useFakeTimers();
		try {
			vi.mocked(query).mockImplementationOnce(() => {
				const gen = sdkGen([]);
				gen.supportedModels = vi.fn(() => new Promise(() => {}));
				return gen;
			});
			const provider = new ClaudeProvider();
			const promise = provider.listModels();
			const assertion = expect(promise).rejects.toThrow(/timed out/i);
			await vi.advanceTimersByTimeAsync(10_000);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});
});
