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
import { ClaudeProvider } from "./claudeProvider";

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
		prompt: "hello",
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
