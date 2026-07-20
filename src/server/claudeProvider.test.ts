/**
 * ClaudeProvider unit tests — SDK event mapping, canUseTool pass-through,
 * session resume, retry-on-failure, and cancel.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(),
	forkSession: vi.fn(),
	getSessionMessages: vi.fn().mockResolvedValue([]),
	createSdkMcpServer: vi.fn((options) => ({
		type: "sdk",
		name: options.name,
		instance: { options },
	})),
	tool: vi.fn((name, description, inputSchema, handler, extras) => ({
		name,
		description,
		inputSchema,
		handler,
		...extras,
	})),
}));
vi.mock("../lib/claudePath", () => ({
	resolveClaudeExecutable: vi.fn(),
}));
vi.mock("../lib/paths", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/paths")>();
	return { ...actual, parseWslUnc: vi.fn().mockReturnValue(null) };
});
vi.mock("../lib/process", () => ({
	runBoundedProcess: vi.fn(),
}));
// Wrap (not replace) the real store — its shape is exercised by the
// "imported Claude resumes" test below and by forkSession's session-store
// path; both only need load/append to be present, never actually call them
// (so no getDb()/DB access happens), so the real factory is safe here.
vi.mock("./claudeHistorySessionStore", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("./claudeHistorySessionStore")>();
	return {
		...actual,
		createClaudeHistorySessionStore: vi.fn(
			actual.createClaudeHistorySessionStore,
		),
	};
});

import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import {
	getSessionMessages as getSdkSessionMessages,
	query,
	forkSession as sdkForkSession,
} from "@anthropic-ai/claude-agent-sdk";
import { resolveClaudeExecutable } from "../lib/claudePath";
import { parseWslUnc } from "../lib/paths";
import { runBoundedProcess } from "../lib/process";
import type { AgentEvent, AgentQueryParams, CanUseTool } from "./agentProvider";
import { createClaudeHistorySessionStore } from "./claudeHistorySessionStore";
import {
	ClaudeProvider,
	mapClaudeModels,
	mapClaudeUsageWindows,
} from "./claudeProvider";

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

function sdkStream(factory: () => AsyncGenerator<unknown>) {
	const gen = factory();
	Object.assign(gen, {
		mcpServerStatus: vi.fn().mockResolvedValue([]),
	});
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

	it("yields assistant_message_id with the SDK message's uuid before its content-block events", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "assistant",
					uuid: "sdk-msg-uuid-1",
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
		const idIndex = events.findIndex((e) => e.type === "assistant_message_id");
		const textIndex = events.findIndex((e) => e.type === "text_delta");
		expect(events[idIndex]).toEqual({
			type: "assistant_message_id",
			id: "sdk-msg-uuid-1",
		});
		expect(idIndex).toBeGreaterThanOrEqual(0);
		expect(idIndex).toBeLessThan(textIndex);
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

	it("merges Claude task lifecycle updates into the originating subagent tool", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "assistant",
					message: {
						content: [
							{
								type: "tool_use",
								id: "agent-tool-1",
								name: "Agent",
								input: {
									prompt: "Inspect auth",
									name: "auth-scout",
									model: "haiku",
								},
							},
						],
						usage: { input_tokens: 10, output_tokens: 5 },
					},
				},
				{
					type: "system",
					subtype: "task_started",
					task_id: "task-1",
					tool_use_id: "agent-tool-1",
					task_type: "subagent",
					subagent_type: "Explore",
					description: "Inspecting authentication",
					prompt: "Inspect auth",
					session_id: "sid",
					uuid: "u1",
				},
				{
					type: "system",
					subtype: "task_progress",
					task_id: "task-1",
					description: "Inspecting authentication",
					last_tool_name: "Read",
					usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 4200 },
					session_id: "sid",
					uuid: "u2",
				},
				{
					type: "system",
					subtype: "task_notification",
					task_id: "task-1",
					status: "completed",
					output_file: "/tmp/result",
					summary: "Authentication inspection complete",
					usage: { total_tokens: 1800, tool_uses: 5, duration_ms: 6500 },
					session_id: "sid",
					uuid: "u3",
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
		const lifecycle = events.filter(
			(event) => event.type === "tool_start" || event.type === "tool_update",
		);
		expect(lifecycle[0]).toMatchObject({
			type: "tool_start",
			toolId: "agent-tool-1",
			name: "Agent",
		});
		expect(lifecycle[1]).toMatchObject({
			type: "tool_update",
			toolId: "agent-tool-1",
			subagent: {
				provider: "claude",
				agentId: "task-1",
				name: "auth-scout",
				label: "Explore",
				model: "haiku",
				prompt: "Inspect auth",
				status: "running",
			},
		});
		expect(lifecycle[2]).toMatchObject({
			type: "tool_update",
			subagent: {
				currentStep: "Using Read",
				lastTool: "Read",
				usage: { totalTokens: 1200, toolUses: 3, durationMs: 4200 },
			},
		});
		expect(lifecycle[3]).toMatchObject({
			type: "tool_update",
			subagent: {
				status: "completed",
				currentStep: "Authentication inspection complete",
				usage: { totalTokens: 1800, toolUses: 5, durationMs: 6500 },
			},
		});
	});

	it("maps task_updated status, detail, error, and completion metadata", async () => {
		const endedAtMs = Date.now() - 1_000;
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "system",
					subtype: "task_started",
					task_id: "task-updated",
					tool_use_id: "agent-updated",
					task_type: "subagent",
					description: "Initial work",
					session_id: "sid",
					uuid: "u1",
				},
				...[
					["pending", "Waiting for capacity"],
					["paused", "Waiting for approval"],
					["unexpected", "Working again"],
				].map(([status, description], index) => ({
					type: "system",
					subtype: "task_updated",
					task_id: "task-updated",
					patch: { status, description },
					session_id: "sid",
					uuid: `u${index + 2}`,
				})),
				{
					type: "system",
					subtype: "task_updated",
					task_id: "task-updated",
					patch: {
						status: "completed",
						description: "Finished",
						end_time: endedAtMs,
					},
					session_id: "sid",
					uuid: "u5",
				},
				{
					type: "system",
					subtype: "task_updated",
					task_id: "task-updated",
					patch: { status: "killed", error: "Stopped by operator" },
					session_id: "sid",
					uuid: "u6",
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

		const updates = (await collectEvents(baseParams())).filter(
			(event) => event.type === "tool_update",
		);
		expect(updates.map((event) => event.subagent.status)).toEqual([
			"running",
			"pending",
			"paused",
			"running",
			"completed",
			"failed",
		]);
		expect(updates[4]).toMatchObject({
			subagent: {
				description: "Finished",
				currentStep: "Finished",
				endedAtMs,
			},
		});
		expect(updates[5]).toMatchObject({
			subagent: {
				status: "failed",
				currentStep: "Stopped by operator",
				endedAtMs: expect.any(Number),
			},
		});
	});

	it("decorates the tool start when task_started arrives first", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "system",
					subtype: "task_started",
					task_id: "task-early",
					tool_use_id: "agent-early",
					task_type: "subagent",
					description: "Starting early",
					prompt: "Inspect routing",
					session_id: "sid",
					uuid: "u1",
				},
				{
					type: "assistant",
					message: {
						content: [
							{
								type: "tool_use",
								id: "agent-early",
								name: "Agent",
								input: { prompt: "Inspect routing" },
							},
						],
						usage: { input_tokens: 1, output_tokens: 1 },
					},
				},
				{
					type: "result",
					subtype: "success",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 1,
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			]),
		);

		const events = await collectEvents(baseParams());
		expect(events.find((event) => event.type === "tool_start")).toMatchObject({
			type: "tool_start",
			toolId: "agent-early",
			subagent: {
				agentId: "task-early",
				prompt: "Inspect routing",
				status: "running",
			},
		});
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

	it("adds deduplicated child API usage when Claude result usage is root-only", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "assistant",
					parent_tool_use_id: null,
					message: {
						id: "msg-root",
						content: [],
						usage: {
							input_tokens: 10,
							output_tokens: 5,
							cache_read_input_tokens: 4,
							cache_creation_input_tokens: 3,
						},
					},
				},
				{
					type: "assistant",
					parent_tool_use_id: "agent-tool-1",
					message: {
						id: "msg-child",
						content: [],
						usage: {
							input_tokens: 2,
							output_tokens: 1,
							cache_read_input_tokens: 20,
							cache_creation_input_tokens: 7,
						},
					},
				},
				// Claude can stream a later, fuller snapshot for the same API id.
				{
					type: "assistant",
					parent_tool_use_id: "agent-tool-1",
					message: {
						id: "msg-child",
						content: [],
						usage: {
							input_tokens: 2,
							output_tokens: 6,
							cache_read_input_tokens: 20,
							cache_creation_input_tokens: 7,
						},
					},
				},
				{
					type: "result",
					subtype: "success",
					total_cost_usd: 0.1,
					num_turns: 1,
					duration_ms: 100,
					usage: {
						input_tokens: 10,
						output_tokens: 5,
						cache_read_input_tokens: 4,
						cache_creation_input_tokens: 3,
					},
				},
			]),
		);

		const events = await collectEvents(baseParams());
		expect(events.find((event) => event.type === "done")).toMatchObject({
			type: "done",
			usage: {
				inputTokens: 12,
				outputTokens: 11,
				cacheReadTokens: 24,
				cacheCreationTokens: 10,
			},
		});
	});

	it("does not double count children when Claude already reports the combined total", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "assistant",
					parent_tool_use_id: null,
					message: {
						id: "msg-root",
						content: [],
						usage: { input_tokens: 10, output_tokens: 5 },
					},
				},
				{
					type: "assistant",
					parent_tool_use_id: "agent-tool-1",
					message: {
						id: "msg-child",
						content: [],
						usage: { input_tokens: 2, output_tokens: 6 },
					},
				},
				{
					type: "result",
					subtype: "success",
					total_cost_usd: 0.1,
					num_turns: 1,
					duration_ms: 100,
					usage: { input_tokens: 12, output_tokens: 11 },
				},
			]),
		);

		const events = await collectEvents(baseParams());
		expect(events.find((event) => event.type === "done")).toMatchObject({
			usage: { inputTokens: 12, outputTokens: 11 },
		});
	});

	it("waits when the root result precedes task start and includes usage emitted after task terminal", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "assistant",
					parent_tool_use_id: null,
					message: {
						id: "msg-root-late",
						content: [
							{
								type: "tool_use",
								id: "agent-tool-late",
								name: "Agent",
								input: { prompt: "Inspect in the background" },
							},
						],
						usage: { input_tokens: 10, output_tokens: 5 },
					},
				},
				{
					type: "result",
					subtype: "success",
					terminal_reason: "background_requested",
					total_cost_usd: 0.1,
					num_turns: 1,
					duration_ms: 100,
					usage: { input_tokens: 10, output_tokens: 5 },
				},
				{
					type: "system",
					subtype: "task_started",
					task_id: "task-late",
					tool_use_id: "agent-tool-late",
					task_type: "subagent",
					subagent_type: "Explore",
				},
				{
					type: "system",
					subtype: "task_notification",
					task_id: "task-late",
					status: "completed",
				},
				{
					type: "assistant",
					parent_tool_use_id: "agent-tool-late",
					message: {
						id: "msg-child-late",
						content: [],
						usage: {
							input_tokens: 2,
							output_tokens: 6,
							cache_read_input_tokens: 20,
							cache_creation_input_tokens: 7,
						},
					},
				},
			]),
		);

		const events = await collectEvents(baseParams());
		expect(events.find((event) => event.type === "done")).toMatchObject({
			usage: {
				inputTokens: 12,
				outputTokens: 11,
				cacheReadTokens: 20,
				cacheCreationTokens: 7,
			},
		});
	});

	it("does not hold a background_requested result for skip_transcript tasks", async () => {
		let releaseTail = () => {};
		const tail = new Promise<void>((resolve) => {
			releaseTail = resolve;
		});
		vi.mocked(query).mockReturnValueOnce(
			sdkStream(async function* () {
				yield {
					type: "assistant",
					parent_tool_use_id: null,
					message: {
						id: "msg-root-skip",
						content: [
							{
								type: "tool_use",
								id: "agent-tool-skip",
								name: "Agent",
								input: {},
							},
						],
						usage: { input_tokens: 7, output_tokens: 3 },
					},
				};
				yield {
					type: "system",
					subtype: "task_started",
					task_id: "task-skip",
					tool_use_id: "agent-tool-skip",
					task_type: "subagent",
					skip_transcript: true,
				};
				yield {
					type: "result",
					subtype: "success",
					terminal_reason: "background_requested",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 50,
					usage: { input_tokens: 7, output_tokens: 3 },
				};
				await tail;
			}),
		);
		const provider = new ClaudeProvider();
		const session = provider.query(baseParams());
		await session.send("turn");
		const collected = (async () => {
			const events: AgentEvent[] = [];
			for await (const event of session) {
				events.push(event);
				if (event.type === "done") break;
			}
			return events;
		})();
		const outcome = await Promise.race([
			collected,
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
		]);
		releaseTail();
		session.cancel();
		expect(outcome).not.toBeNull();
		expect(outcome?.find((event) => event.type === "done")).toMatchObject({
			usage: { inputTokens: 7, outputTokens: 3 },
		});
	});

	it("preserves root usage when the SDK iterator errors while a background result is pending", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkStream(async function* () {
				yield {
					type: "assistant",
					parent_tool_use_id: null,
					message: {
						id: "msg-root-error",
						content: [],
						usage: { input_tokens: 9, output_tokens: 4 },
					},
				};
				yield {
					type: "system",
					subtype: "task_started",
					task_id: "task-error",
					tool_use_id: "agent-tool-error",
					task_type: "subagent",
				};
				yield {
					type: "result",
					subtype: "success",
					total_cost_usd: 0.1,
					num_turns: 1,
					duration_ms: 75,
					usage: { input_tokens: 9, output_tokens: 4 },
				};
				throw new Error("background transport failed");
			}),
		);

		const events = await collectEvents(baseParams());
		expect(events.find((event) => event.type === "done")).toMatchObject({
			usage: { inputTokens: 9, outputTokens: 4 },
		});
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "tool_update",
				subagent: expect.objectContaining({ status: "interrupted" }),
			}),
		);
	});

	it("times out, quarantines late child usage, and does not charge it to the next query", async () => {
		vi.useFakeTimers();
		try {
			let releaseLate = () => {};
			const late = new Promise<void>((resolve) => {
				releaseLate = resolve;
			});
			vi.mocked(query).mockReturnValueOnce(
				sdkStream(async function* () {
					yield {
						type: "assistant",
						parent_tool_use_id: null,
						message: {
							id: "msg-root-timeout",
							content: [
								{
									type: "tool_use",
									id: "agent-tool-timeout",
									name: "Agent",
									input: {},
								},
							],
							usage: { input_tokens: 10, output_tokens: 5 },
						},
					};
					yield {
						type: "system",
						subtype: "task_started",
						task_id: "task-timeout",
						tool_use_id: "agent-tool-timeout",
						task_type: "subagent",
					};
					yield {
						type: "result",
						subtype: "success",
						terminal_reason: "background_requested",
						total_cost_usd: 0.1,
						num_turns: 1,
						duration_ms: 100,
						usage: { input_tokens: 10, output_tokens: 5 },
					};
					await late;
					yield {
						type: "assistant",
						parent_tool_use_id: "agent-tool-timeout",
						message: {
							id: "msg-child-too-late",
							content: [],
							usage: { input_tokens: 100, output_tokens: 50 },
						},
					};
					yield {
						type: "system",
						subtype: "task_notification",
						task_id: "task-timeout",
						status: "completed",
					};
					yield {
						type: "assistant",
						parent_tool_use_id: null,
						message: {
							id: "msg-root-next",
							content: [],
							usage: { input_tokens: 20, output_tokens: 8 },
						},
					};
					yield {
						type: "result",
						subtype: "success",
						total_cost_usd: 0.2,
						num_turns: 1,
						duration_ms: 100,
						usage: { input_tokens: 20, output_tokens: 8 },
					};
				}),
			);
			const provider = new ClaudeProvider();
			const session = provider.query(baseParams());
			await session.send("first");
			const firstPromise = (async () => {
				const events: AgentEvent[] = [];
				for await (const event of session) {
					events.push(event);
					if (event.type === "done") break;
				}
				return events;
			})();
			await vi.advanceTimersByTimeAsync(10 * 60_000);
			const first = await firstPromise;
			expect(first.find((event) => event.type === "done")).toMatchObject({
				usage: { inputTokens: 10, outputTokens: 5 },
			});
			expect(first).toContainEqual(
				expect.objectContaining({
					type: "tool_update",
					subagent: expect.objectContaining({ status: "interrupted" }),
				}),
			);

			releaseLate();
			await session.send("second");
			const second: AgentEvent[] = [];
			for await (const event of session) {
				second.push(event);
				if (event.type === "done") break;
			}
			expect(second.find((event) => event.type === "done")).toMatchObject({
				usage: { inputTokens: 20, outputTokens: 8 },
			});
			session.cancel();
		} finally {
			vi.useRealTimers();
		}
	});

	it("preserves pending root usage when cancellation ends the SDK iterator", async () => {
		let failTail = (_error: Error) => {};
		let signalPending = () => {};
		const pending = new Promise<void>((resolve) => {
			signalPending = resolve;
		});
		const tail = new Promise<void>((_resolve, reject) => {
			failTail = reject;
		});
		vi.mocked(query).mockReturnValueOnce(
			sdkStream(async function* () {
				yield {
					type: "assistant",
					parent_tool_use_id: null,
					message: {
						id: "msg-root-cancel",
						content: [],
						usage: { input_tokens: 13, output_tokens: 6 },
					},
				};
				yield {
					type: "system",
					subtype: "task_started",
					task_id: "task-cancel",
					tool_use_id: "agent-tool-cancel",
					task_type: "subagent",
				};
				yield {
					type: "result",
					subtype: "success",
					total_cost_usd: 0.1,
					num_turns: 1,
					duration_ms: 100,
					usage: { input_tokens: 13, output_tokens: 6 },
				};
				signalPending();
				await tail;
			}),
		);
		const provider = new ClaudeProvider();
		const session = provider.query(baseParams());
		await session.send("turn");
		const collected = (async () => {
			const events: AgentEvent[] = [];
			for await (const event of session) events.push(event);
			return events;
		})();
		await pending;
		session.cancel();
		failTail(new Error("cancelled"));
		const events = await collected;
		expect(events.find((event) => event.type === "done")).toMatchObject({
			usage: { inputTokens: 13, outputTokens: 6 },
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

	it("normalizes percentage rate-limit events for the live usage bar", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "rate_limit_event",
					rate_limit_info: {
						status: "warn",
						rateLimitType: "five_hour",
						utilization: 73,
						resetsAt: "2026-07-12T00:00:00Z",
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
		expect(events.find((event) => event.type === "rate_limit")).toMatchObject({
			rateLimitType: "five_hour",
			utilization: 0.73,
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
			estimatedCost: 1.23,
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
	it("yields scoped command refreshes from commands_changed", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "system",
					subtype: "commands_changed",
					commands: [
						{
							name: "review",
							description: "Review changes",
							argumentHint: "",
						},
					],
					uuid: "uuid-commands",
					session_id: "sid-abc",
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
		expect(events.find((event) => event.type === "commands_changed")).toEqual({
			type: "commands_changed",
			commands: [
				{
					name: "review",
					description: "Review changes",
					argumentHint: "",
				},
			],
		});
	});

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

describe("ClaudeProvider — listSkills", () => {
	it("uses the SDK catalog without sending a prompt", async () => {
		const commands = [
			{
				name: "voice",
				description: "Apply voice rules",
				argumentHint: "",
			},
		];
		const gen = sdkGen([]);
		gen.supportedCommands = vi.fn().mockResolvedValue(commands);
		vi.mocked(query).mockReturnValueOnce(gen);

		await expect(
			new ClaudeProvider().listSkills?.({ cwd: "/work/project" }),
		).resolves.toEqual([{ name: "voice", description: "Apply voice rules" }]);
		expect(gen.supportedCommands).toHaveBeenCalledOnce();
	});
});

// ── forkSession ───────────────────────────────────────────────────────────────

describe("ClaudeProvider — forkSession", () => {
	it("forks via the SDK by session id alone — no dir, so lookup isn't tied to hlid's stored agent_cwd matching the on-disk indexed path", async () => {
		vi.mocked(sdkForkSession).mockResolvedValueOnce({
			sessionId: "forked-session-id",
		});

		const result = await new ClaudeProvider().forkSession?.({
			sessionId: "source-session-id",
			cwd: "/work/project",
			title: "My fork",
		});

		expect(result).toEqual({ sessionId: "forked-session-id", messages: [] });
		expect(sdkForkSession).toHaveBeenCalledWith("source-session-id", {
			title: "My fork",
		});
	});

	it("hydrates hlid's messages from the SDK's own getSessionMessages() read-back, since forkSession() only writes the native transcript file", async () => {
		vi.mocked(sdkForkSession).mockResolvedValueOnce({
			sessionId: "forked-session-id",
		});
		vi.mocked(getSdkSessionMessages).mockResolvedValueOnce([
			{
				type: "user",
				uuid: "u1",
				session_id: "forked-session-id",
				parent_tool_use_id: null,
				message: { content: "Hello" },
			},
			{
				type: "assistant",
				uuid: "u2",
				session_id: "forked-session-id",
				parent_tool_use_id: null,
				message: {
					content: [
						{ type: "text", text: "Hi " },
						{ type: "text", text: "there" },
						{ type: "tool_use", id: "t1", name: "Bash", input: {} },
					],
				},
			},
			// System messages and empty-text turns should be dropped.
			{
				type: "system",
				uuid: "u3",
				session_id: "forked-session-id",
				parent_tool_use_id: null,
				message: {},
			},
			{
				type: "user",
				uuid: "u4",
				session_id: "forked-session-id",
				parent_tool_use_id: null,
				message: { content: [{ type: "tool_use", id: "t2" }] },
			},
			// biome-ignore lint/suspicious/noExplicitAny: partial SDK SessionMessage fixture for this test
		] as any);

		const result = await new ClaudeProvider().forkSession?.({
			sessionId: "source-session-id",
			cwd: "/work/project",
		});

		expect(getSdkSessionMessages).toHaveBeenCalledWith("forked-session-id", {});
		expect(result?.messages).toEqual([
			{ role: "user", text: "Hello", uuid: "u1" },
			{ role: "assistant", text: "Hi \nthere", uuid: "u2" },
		]);
	});

	it("returns an empty messages array (not a thrown error) when the transcript read-back fails", async () => {
		vi.mocked(sdkForkSession).mockResolvedValueOnce({
			sessionId: "forked-session-id",
		});
		vi.mocked(getSdkSessionMessages).mockRejectedValueOnce(
			new Error("read failed"),
		);

		const result = await new ClaudeProvider().forkSession?.({
			sessionId: "source-session-id",
			cwd: "/work/project",
		});

		expect(result).toEqual({ sessionId: "forked-session-id", messages: [] });
	});

	it("forwards upToMessageId when branching from a specific message", async () => {
		vi.mocked(sdkForkSession).mockResolvedValueOnce({
			sessionId: "forked-session-id",
		});

		await new ClaudeProvider().forkSession?.({
			sessionId: "source-session-id",
			cwd: "/work/project",
			upToMessageId: "sdk-msg-uuid-1",
		});

		expect(sdkForkSession).toHaveBeenCalledWith("source-session-id", {
			title: undefined,
			upToMessageId: "sdk-msg-uuid-1",
		});
	});

	it("omits upToMessageId for a whole-session fork", async () => {
		vi.mocked(sdkForkSession).mockResolvedValueOnce({
			sessionId: "forked-session-id",
		});

		await new ClaudeProvider().forkSession?.({
			sessionId: "source-session-id",
			cwd: "/work/project",
		});

		const call = vi.mocked(sdkForkSession).mock.calls.at(-1);
		expect(call?.[1]?.upToMessageId).toBeUndefined();
	});

	it("passes the DB-backed sessionStore for session-store-resumed sessions", async () => {
		vi.mocked(sdkForkSession).mockResolvedValueOnce({
			sessionId: "forked-session-id",
		});

		await new ClaudeProvider().forkSession?.({
			sessionId: "source-session-id",
			cwd: "/work/project",
			historyResumeMode: "session-store",
		});

		// Once for the fork call itself, once more for the getSessionMessages()
		// read-back used to hydrate hlid's messages table — both need the
		// store option for a session-store-backed source session.
		expect(createClaudeHistorySessionStore).toHaveBeenCalledTimes(2);
		const call = vi.mocked(sdkForkSession).mock.calls.at(-1);
		expect(call?.[0]).toBe("source-session-id");
		expect(call?.[1]).toMatchObject({ title: undefined });
		expect(call?.[1]).not.toHaveProperty("dir");
		expect(typeof call?.[1]?.sessionStore?.load).toBe("function");
		const readBackCall = vi.mocked(getSdkSessionMessages).mock.calls.at(-1);
		expect(typeof readBackCall?.[1]?.sessionStore?.load).toBe("function");
	});

	it("points CLAUDE_CONFIG_DIR at the WSL distro's real $HOME/.claude for the duration of a WSL-project fork, then restores it", async () => {
		const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
		delete process.env.CLAUDE_CONFIG_DIR;
		try {
			vi.mocked(parseWslUnc).mockReturnValueOnce({
				distro: "Ubuntu-24.04",
				posixPath: "/home/kyle/dev/repo",
			});
			vi.mocked(runBoundedProcess).mockResolvedValueOnce({
				output: "__HLID_FORK_CLAUDE_CONFIG_DIR__/home/kyle/.claude",
				code: 0,
			});
			let configDirDuringCall: string | undefined;
			vi.mocked(sdkForkSession).mockImplementationOnce(async () => {
				configDirDuringCall = process.env.CLAUDE_CONFIG_DIR;
				return { sessionId: "forked-session-id" };
			});

			await new ClaudeProvider().forkSession?.({
				sessionId: "source-session-id",
				cwd: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\dev\\repo",
			});

			expect(runBoundedProcess).toHaveBeenCalledWith(
				"wsl.exe",
				expect.arrayContaining(["-d", "Ubuntu-24.04"]),
				expect.anything(),
			);
			expect(configDirDuringCall).toBe(
				"\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\.claude",
			);
			expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
		} finally {
			if (originalConfigDir === undefined) {
				delete process.env.CLAUDE_CONFIG_DIR;
			} else {
				process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
			}
		}
	});

	it("restores CLAUDE_CONFIG_DIR even when the SDK call throws", async () => {
		const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
		delete process.env.CLAUDE_CONFIG_DIR;
		try {
			vi.mocked(parseWslUnc).mockReturnValueOnce({
				distro: "Ubuntu-24.04",
				posixPath: "/home/kyle/dev/repo",
			});
			vi.mocked(runBoundedProcess).mockResolvedValueOnce({
				output: "__HLID_FORK_CLAUDE_CONFIG_DIR__/home/kyle/.claude",
				code: 0,
			});
			vi.mocked(sdkForkSession).mockRejectedValueOnce(
				new Error("Session not found"),
			);

			await expect(
				new ClaudeProvider().forkSession?.({
					sessionId: "source-session-id",
					cwd: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\dev\\repo",
				}),
			).rejects.toThrow("Session not found");

			expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
		} finally {
			if (originalConfigDir === undefined) {
				delete process.env.CLAUDE_CONFIG_DIR;
			} else {
				process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
			}
		}
	});

	it("skips the WSL probe entirely for a non-WSL cwd", async () => {
		// Earlier tests in this suite exercise the WSL branch and leave calls
		// on this mock's history — clear it so the assertion below reflects
		// only this test.
		vi.mocked(runBoundedProcess).mockClear();
		vi.mocked(sdkForkSession).mockResolvedValueOnce({
			sessionId: "forked-session-id",
		});

		await new ClaudeProvider().forkSession?.({
			sessionId: "source-session-id",
			cwd: "/work/project",
		});

		expect(runBoundedProcess).not.toHaveBeenCalled();
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

// ── setModel ──────────────────────────────────────────────────────────────────

describe("ClaudeProvider — setModel", () => {
	it("delegates setModel() to the underlying SDK query", async () => {
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
		gen.setModel = vi.fn().mockResolvedValue(undefined);
		vi.mocked(query).mockReturnValueOnce(gen);

		const provider = new ClaudeProvider();
		const session = provider.query(baseParams());
		const iter = session[Symbol.asyncIterator]();
		await iter.next();

		await session.setModel?.("claude-opus-4-8");
		expect(gen.setModel).toHaveBeenCalledWith("claude-opus-4-8");
	});

	it("passes undefined through to reset to the provider default", async () => {
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
		gen.setModel = vi.fn().mockResolvedValue(undefined);
		vi.mocked(query).mockReturnValueOnce(gen);

		const provider = new ClaudeProvider();
		const session = provider.query(baseParams());
		const iter = session[Symbol.asyncIterator]();
		await iter.next();

		await session.setModel?.(undefined);
		expect(gen.setModel).toHaveBeenCalledWith(undefined);
	});

	it("is a no-op when the SDK query hasn't been created yet", async () => {
		const provider = new ClaudeProvider();
		const session = provider.query(baseParams());
		await expect(session.setModel?.("whatever")).resolves.toBeUndefined();
	});
});

// ── setPermissionMode ─────────────────────────────────────────────────────────

describe("ClaudeProvider — setPermissionMode", () => {
	it("delegates setPermissionMode() to the underlying SDK query", async () => {
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
		gen.setPermissionMode = vi.fn().mockResolvedValue(undefined);
		vi.mocked(query).mockReturnValueOnce(gen);

		const provider = new ClaudeProvider();
		const session = provider.query(baseParams());
		const iter = session[Symbol.asyncIterator]();
		await iter.next();

		await session.setPermissionMode?.("acceptEdits");
		expect(gen.setPermissionMode).toHaveBeenCalledWith("acceptEdits");
	});

	it("rejects an unknown permission mode without calling the SDK", async () => {
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
		gen.setPermissionMode = vi.fn().mockResolvedValue(undefined);
		vi.mocked(query).mockReturnValueOnce(gen);

		const provider = new ClaudeProvider();
		const session = provider.query(baseParams());
		const iter = session[Symbol.asyncIterator]();
		await iter.next();

		await expect(session.setPermissionMode?.("bogus")).rejects.toThrow(
			"Unknown permission mode: bogus",
		);
		expect(gen.setPermissionMode).not.toHaveBeenCalled();
	});

	it("keeps Claude in default mode when Umbod owns bypass approvals", async () => {
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
		gen.setPermissionMode = vi.fn().mockResolvedValue(undefined);
		vi.mocked(query).mockReturnValueOnce(gen);

		const session = new ClaudeProvider().query(
			baseParams({
				permissionMode: "bypassPermissions",
				policyEnforced: true,
			}),
		);
		await session[Symbol.asyncIterator]().next();

		await session.setPermissionMode?.("bypassPermissions");
		expect(gen.setPermissionMode).toHaveBeenCalledWith("default");
	});

	it("is a no-op when the SDK query hasn't been created yet", async () => {
		const provider = new ClaudeProvider();
		const session = provider.query(baseParams());
		await expect(
			session.setPermissionMode?.("acceptEdits"),
		).resolves.toBeUndefined();
	});
});

// ── usageWindows ─────────────────────────────────────────────────────────────

describe("ClaudeProvider — usageWindows", () => {
	it("maps structured plan usage percentages into provider windows", async () => {
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
		gen.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = vi
			.fn()
			.mockResolvedValue({
				rate_limits_available: true,
				rate_limits: {
					five_hour: {
						utilization: 42.5,
						resets_at: "2026-07-12T00:00:00Z",
					},
					seven_day: { utilization: 7, resets_at: null },
				},
			});
		vi.mocked(query).mockReturnValueOnce(gen);

		const session = new ClaudeProvider().query(baseParams());
		await session[Symbol.asyncIterator]().next();

		await expect(session.usageWindows?.()).resolves.toEqual([
			{
				windowId: "five_hour",
				label: "5-HOUR",
				utilization: 0.425,
				remaining: null,
				limit: null,
				resetsAt: 1_783_814_400,
			},
			{
				windowId: "weekly",
				label: "7-DAY",
				utilization: 0.07,
				remaining: null,
				limit: null,
				resetsAt: null,
			},
		]);
	});

	it("returns no windows when plan rate limits are unavailable", () => {
		expect(
			mapClaudeUsageWindows({
				rate_limits_available: false,
				rate_limits: null,
			}),
		).toEqual([]);
	});

	it("ignores null utilization instead of erasing a prior reading", () => {
		expect(
			mapClaudeUsageWindows({
				rate_limits_available: true,
				rate_limits: {
					five_hour: { utilization: null, resets_at: null },
				},
			}),
		).toEqual([]);
	});

	it("falls back cleanly when the experimental SDK lookup fails", async () => {
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
		gen.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = vi
			.fn()
			.mockRejectedValue(new Error("not available"));
		vi.mocked(query).mockReturnValueOnce(gen);

		const session = new ClaudeProvider().query(baseParams());
		await session[Symbol.asyncIterator]().next();
		await expect(session.usageWindows?.()).resolves.toEqual([]);
	});
});

describe("ClaudeProvider — contextUsage", () => {
	it("uses the SDK raw model window and exact live occupancy", async () => {
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
		gen.getContextUsage = vi.fn().mockResolvedValue({
			totalTokens: 110_882,
			maxTokens: 900_000,
			rawMaxTokens: 1_000_000,
			model: "claude-fable-5",
		});
		vi.mocked(query).mockReturnValueOnce(gen);

		const session = new ClaudeProvider().query(baseParams());
		await session[Symbol.asyncIterator]().next();

		await expect(session.contextUsage?.()).resolves.toEqual({
			contextTokens: 110_882,
			contextWindow: 1_000_000,
			model: "claude-fable-5",
		});
	});
});

// ── accountInfo ───────────────────────────────────────────────────────────────

describe("ClaudeProvider — accountInfo", () => {
	it("maps the SDK's AccountInfo to the provider-agnostic shape", async () => {
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
		gen.accountInfo = vi.fn().mockResolvedValue({
			email: "kyle@example.com",
			organization: "Acme",
			subscriptionType: "max",
			tokenSource: "keychain",
			apiProvider: "firstParty",
		});
		vi.mocked(query).mockReturnValueOnce(gen);

		const provider = new ClaudeProvider();
		const session = provider.query(baseParams());
		const iter = session[Symbol.asyncIterator]();
		await iter.next();

		const info = await session.accountInfo?.();
		expect(info).toEqual({
			email: "kyle@example.com",
			organization: "Acme",
			subscriptionType: "max",
		});
	});

	it("returns null when the SDK query hasn't been created yet", async () => {
		const provider = new ClaudeProvider();
		const session = provider.query(baseParams());
		expect(await session.accountInfo?.()).toBeNull();
	});

	it("returns null when the SDK call fails", async () => {
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
		gen.accountInfo = vi.fn().mockRejectedValue(new Error("not logged in"));
		vi.mocked(query).mockReturnValueOnce(gen);

		const provider = new ClaudeProvider();
		const session = provider.query(baseParams());
		const iter = session[Symbol.asyncIterator]();
		await iter.next();

		expect(await session.accountInfo?.()).toBeNull();
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

	it("supplies Hlid's transcript store for imported Claude resumes", async () => {
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
			baseParams({
				sessionId: "imported-claude-id",
				historyResumeMode: "session-store",
			}),
		)) {
			// drain
		}

		const options = capturedOptions as {
			resume?: string;
			sessionStore?: { load?: unknown; append?: unknown };
		};
		expect(options.resume).toBe("imported-claude-id");
		expect(typeof options.sessionStore?.load).toBe("function");
		expect(typeof options.sessionStore?.append).toBe("function");
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

	it("parseHeaders accepts HTTP-date reset timestamps", () => {
		const provider = new ClaudeProvider();
		const headers = new Headers({
			"anthropic-ratelimit-unified-5h-utilization": "0.73",
			"anthropic-ratelimit-unified-5h-reset": "Sun, 12 Jul 2026 00:00:00 GMT",
		});
		const result = provider.proxyConfig.parseHeaders(headers);
		expect(result[0]?.resetsAt).toBe(1_783_814_400);
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
	it("registers Hlid's curated Obsidian MCP tools on user sessions", async () => {
		vi.mocked(query).mockReturnValueOnce(sdkGen([]));
		const session = new ClaudeProvider().query(baseParams());
		await session.send("inspect my vault");
		const options = vi.mocked(query).mock.calls.at(-1)?.[0].options;
		expect(options?.mcpServers).toMatchObject({
			hlid_obsidian: { type: "sdk", name: "hlid_obsidian" },
		});
		const server = options?.mcpServers?.hlid_obsidian as unknown as {
			instance: {
				options: {
					tools: Array<{
						name: string;
						inputSchema: Record<string, unknown>;
					}>;
				};
			};
		};
		expect(server.instance.options.tools.map((item) => item.name)).toEqual([
			"search",
			"current_note",
			"links",
			"tasks",
			"properties",
			"base_query",
			"history",
			"list_templates",
			"read_template",
			"create_note",
			"append_note",
			"prepend_note",
		]);
		const tasks = server.instance.options.tools.find(
			(item) => item.name === "tasks",
		);
		expect(tasks?.inputSchema).toMatchObject({
			limit: expect.anything(),
			countOnly: expect.anything(),
		});
		const createNote = server.instance.options.tools.find(
			(item) => item.name === "create_note",
		) as { annotations?: { readOnlyHint?: boolean } } | undefined;
		expect(createNote?.annotations?.readOnlyHint).toBe(false);
		session.cancel();
	});

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

	it("preserves filesystem hooks when internal policy enforcement is active", async () => {
		let capturedOptions: Record<string, unknown> | undefined;
		vi.mocked(query).mockImplementationOnce(
			({ options }: { prompt: unknown; options?: Record<string, unknown> }) => {
				capturedOptions = options;
				return sdkGen([]);
			},
		);

		const session = new ClaudeProvider().query(
			baseParams({ policyEnforced: true }),
		);
		for await (const _event of session) {
			// Drain the mock session so query() is initialized.
		}

		expect(capturedOptions).not.toHaveProperty("settings");
		expect(capturedOptions?.canUseTool).toBeTypeOf("function");
	});

	it("keeps hooks and canUseTool authoritative in bypassPermissions mode", async () => {
		let capturedOptions: Record<string, unknown> | undefined;
		const canUseTool = vi.fn().mockResolvedValue({ behavior: "allow" });
		vi.mocked(query).mockImplementationOnce(
			({ options }: { prompt: unknown; options?: Record<string, unknown> }) => {
				capturedOptions = options;
				return sdkGen([]);
			},
		);

		const session = new ClaudeProvider().query(
			baseParams({
				permissionMode: "bypassPermissions",
				policyEnforced: true,
				canUseTool,
			}),
		);
		for await (const _event of session) {
			// Drain the mock session so query() is initialized.
		}

		expect(capturedOptions).not.toHaveProperty("settings");
		expect(capturedOptions?.settingSources).toEqual([
			"user",
			"project",
			"local",
		]);
		expect(capturedOptions?.permissionMode).toBe("default");
		expect(capturedOptions?.allowDangerouslySkipPermissions).toBe(false);
		expect(capturedOptions?.canUseTool).toBe(canUseTool);
	});

	it("uses SDK PreToolUse as the auto-sleep fallback when Umbod is disabled", async () => {
		let capturedOptions: Record<string, unknown> | undefined;
		const canUseTool = vi.fn().mockResolvedValue({ behavior: "allow" });
		const beforeToolUse = vi.fn().mockResolvedValue("proceeded");
		vi.mocked(query).mockImplementationOnce(
			({ options }: { prompt: unknown; options?: Record<string, unknown> }) => {
				capturedOptions = options;
				return sdkGen([]);
			},
		);

		const session = new ClaudeProvider().query(
			baseParams({
				permissionMode: "bypassPermissions",
				usageGateEnforced: true,
				beforeToolUse,
				canUseTool,
			}),
		);
		for await (const _event of session) {
			// Drain the mock session so query() is initialized.
		}

		expect(capturedOptions?.permissionMode).toBe("bypassPermissions");
		expect(capturedOptions?.allowDangerouslySkipPermissions).toBe(true);
		expect(capturedOptions?.canUseTool).toBe(canUseTool);
		const hook = (
			capturedOptions?.hooks as {
				PreToolUse: Array<{ hooks: HookCallback[]; timeout: number }>;
			}
		).PreToolUse[0];
		expect(hook.timeout).toBe(86_460);
		const beforeToolHook = hook.hooks[0];
		const hookInput = {
			hook_event_name: "PreToolUse" as const,
			session_id: "sdk-session",
			transcript_path: "/tmp/transcript.jsonl",
			cwd: "/tmp/test",
			tool_name: "Bash",
			tool_input: { command: "pwd" },
			tool_use_id: "tool-sleep",
		};
		await beforeToolHook(hookInput, "tool-sleep", {
			signal: new AbortController().signal,
		});
		expect(beforeToolUse).toHaveBeenCalledWith(
			"Bash",
			{ command: "pwd" },
			{
				toolUseID: "tool-sleep",
				signal: expect.any(AbortSignal),
			},
		);

		beforeToolUse.mockResolvedValueOnce("aborted");
		await expect(
			beforeToolHook(hookInput, "tool-sleep", {
				signal: new AbortController().signal,
			}),
		).resolves.toEqual({
			continue: false,
			stopReason: "Aborted while sleeping on usage limit",
		});
	});

	it("leaves PreToolUse to embedded Umbod when policy enforcement is active", async () => {
		let capturedOptions: Record<string, unknown> | undefined;
		vi.mocked(query).mockImplementationOnce(
			({ options }: { prompt: unknown; options?: Record<string, unknown> }) => {
				capturedOptions = options;
				return sdkGen([]);
			},
		);

		const session = new ClaudeProvider().query(
			baseParams({
				policyEnforced: true,
				usageGateEnforced: true,
				beforeToolUse: vi.fn().mockResolvedValue("proceeded"),
			}),
		);
		for await (const _event of session) {
			// Drain the mock session so query() is initialized.
		}

		expect(capturedOptions).not.toHaveProperty("hooks");
		expect(capturedOptions?.settingSources).toEqual([
			"user",
			"project",
			"local",
		]);
	});

	it("preserves normal Claude hooks without internal policy enforcement", async () => {
		let capturedOptions: Record<string, unknown> | undefined;
		vi.mocked(query).mockImplementationOnce(
			({ options }: { prompt: unknown; options?: Record<string, unknown> }) => {
				capturedOptions = options;
				return sdkGen([]);
			},
		);

		const session = new ClaudeProvider().query(baseParams());
		for await (const _event of session) {
			// Drain the mock session so query() is initialized.
		}

		expect(capturedOptions).not.toHaveProperty("settings");
		expect(capturedOptions).not.toHaveProperty("hooks");
	});

	it("passes the selected effort into a fresh Claude SDK query", async () => {
		let capturedOptions: Record<string, unknown> | undefined;
		vi.mocked(query).mockImplementationOnce(
			({ options }: { prompt: unknown; options?: Record<string, unknown> }) => {
				capturedOptions = options;
				return sdkGen([]);
			},
		);

		const session = new ClaudeProvider().query(baseParams({ effort: "max" }));
		await session.send("use maximum effort");

		expect(capturedOptions?.effort).toBe("max");
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
