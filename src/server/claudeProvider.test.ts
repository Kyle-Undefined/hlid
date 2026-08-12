/**
 * ClaudeProvider unit tests — SDK event mapping, canUseTool pass-through,
 * session resume, retry-on-failure, and cancel.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("./obsidianAgentTools", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./obsidianAgentTools")>();
	return { ...actual, executeObsidianAgentTool: vi.fn() };
});
vi.mock("./hlidAgentTools", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./hlidAgentTools")>();
	return { ...actual, executeHlidAgentToolRich: vi.fn() };
});
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
import type {
	AgentEvent,
	AgentInputOrigin,
	AgentQueryParams,
	CanUseTool,
	SubagentSnapshot,
} from "./agentProvider";
import { ClaudeBackgroundActivityTracker } from "./claudeBackgroundActivities";
import { createClaudeHistorySessionStore } from "./claudeHistorySessionStore";
import {
	ClaudeProvider,
	mapClaudeModels,
	mapClaudeUsageWindows,
} from "./claudeProvider";
import { CliProxyCodexProvider } from "./cliproxyProvider";
import { executeHlidAgentToolRich } from "./hlidAgentTools";
import { executeObsidianAgentTool } from "./obsidianAgentTools";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal async-iterable SDK query response with mcpServerStatus(). */
function sdkGen(events: unknown[], mcpStatuses: unknown[] = []) {
	const gen = (async function* () {
		for (const e of events) yield e;
	})();
	Object.assign(gen, {
		initializationResult: vi.fn().mockResolvedValue({ models: [] }),
		setPermissionMode: vi.fn().mockResolvedValue(undefined),
		setModel: vi.fn().mockResolvedValue(undefined),
		mcpServerStatus: vi.fn().mockResolvedValue(mcpStatuses),
		reconnectMcpServer: vi.fn().mockResolvedValue(undefined),
		toggleMcpServer: vi.fn().mockResolvedValue(undefined),
		setMcpPermissionModeOverride: vi.fn().mockResolvedValue({}),
		setMcpServers: vi.fn().mockResolvedValue({
			added: [],
			removed: [],
			errors: {},
		}),
		reloadSkills: vi.fn().mockResolvedValue({ skills: [] }),
		rewindFiles: vi.fn().mockResolvedValue({
			canRewind: true,
			filesChanged: ["src/example.ts"],
			insertions: 2,
			deletions: 1,
		}),
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
		initializationResult: vi.fn().mockResolvedValue({ models: [] }),
		setPermissionMode: vi.fn().mockResolvedValue(undefined),
		setModel: vi.fn().mockResolvedValue(undefined),
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

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function collectEvents(
	params: AgentQueryParams,
	options: NonNullable<ConstructorParameters<typeof ClaudeProvider>[0]> = {},
): Promise<AgentEvent[]> {
	const provider = new ClaudeProvider(options);
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

	it("yields a provider context reset with Claude's replacement conversation id", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{ type: "system", subtype: "init", session_id: "sid-old", tools: [] },
				{
					type: "conversation_reset",
					new_conversation_id: "sid-new",
					uuid: "reset-uuid",
					session_id: "sid-old",
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
		expect(events).toContainEqual({
			type: "provider_context_reset",
			sessionId: "sid-new",
		});
	});

	it("surfaces a nonfatal history warning and continues through completion", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "system",
					subtype: "mirror_error",
					error: "SessionStore.append timed out",
					key: {
						projectKey: "project-key",
						sessionId: "native-session",
						subpath: "agent-child",
					},
					uuid: "11111111-1111-4111-8111-111111111111",
					session_id: "native-session",
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
		expect(events).toContainEqual({
			type: "provider_history_warning",
			code: "history_mirror_failed",
			reason: "timeout",
			providerSessionId: "native-session",
			providerEventId: "11111111-1111-4111-8111-111111111111",
			scope: "subagent",
		});
		expect(events.some((event) => event.type === "transport_error")).toBe(
			false,
		);
		expect(events.at(-1)?.type).toBe("done");
	});

	it("classifies history failures and bounds only useful correlation metadata", async () => {
		const oversized = "x".repeat(5_000);
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "system",
					subtype: "mirror_error",
					error: oversized,
					key: {
						projectKey: oversized,
						sessionId: oversized,
						subpath: oversized,
						unknown: oversized,
					},
					uuid: oversized,
					session_id: oversized,
					unknown: oversized,
				},
				{
					type: "system",
					subtype: "mirror_error",
					error: null,
					key: "not-an-object",
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

		const warnings = (await collectEvents(baseParams())).filter(
			(
				event,
			): event is Extract<AgentEvent, { type: "provider_history_warning" }> =>
				event.type === "provider_history_warning",
		);
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toMatchObject({
			reason: "append_rejected",
			scope: "subagent",
		});
		expect(warnings[0]).not.toHaveProperty("providerSessionId");
		expect(warnings[0]).not.toHaveProperty("providerEventId");
		expect(warnings[0]).not.toHaveProperty("projectKey");
		expect(warnings[0]).not.toHaveProperty("error");
		expect(warnings[0]).not.toHaveProperty("detail");
		expect(warnings[0]).not.toHaveProperty("unknown");
		expect(warnings[1]).toEqual({
			type: "provider_history_warning",
			code: "history_mirror_failed",
			reason: "unknown",
			scope: "main",
		});
	});

	it("surfaces a root replayed user message as a file checkpoint", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "user",
					uuid: "checkpoint-user-id",
					session_id: "native-claude-session",
					parent_tool_use_id: null,
					origin: { kind: "human" },
					message: {
						role: "user",
						content: [{ type: "text", text: "change the file" }],
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
		expect(events).toContainEqual({
			type: "file_checkpoint",
			id: "checkpoint-user-id",
			providerSessionId: "native-claude-session",
		});
	});

	it.each([
		{
			label: "scheduled task",
			origin: { kind: "task-notification", subkind: "scheduled-trigger" },
		},
		{ label: "coordinator", origin: { kind: "coordinator" } },
		{ label: "background task", origin: { kind: "task-notification" } },
		{ label: "automatic continuation", origin: { kind: "auto-continuation" } },
		{ label: "unclassified input", origin: { kind: "unclassified" } },
	])("does not checkpoint $label input", async ({ origin }) => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "user",
					uuid: "non-human-user-id",
					session_id: "native-claude-session",
					parent_tool_use_id: null,
					origin,
					message: {
						role: "user",
						content: [{ type: "text", text: "automated input" }],
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
		expect(events.some((event) => event.type === "file_checkpoint")).toBe(
			false,
		);
	});

	it("surfaces peer-origin input without treating it as a file checkpoint", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "user",
					uuid: "peer-user-id",
					session_id: "native-claude-session",
					parent_tool_use_id: null,
					origin: {
						kind: "peer",
						from: "peer-release",
						name: "Release helper",
						fromSession: "peer-session-id",
						body: "Coordinate the release",
						verifiedPeerPid: 7312,
					},
					message: {
						role: "user",
						content: [{ type: "text", text: "Coordinate the release" }],
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
		expect(events).toContainEqual({
			type: "provider_peer_message",
			body: "Coordinate the release",
			fromAddress: "peer-release",
			claimedName: "Release helper",
			fromSession: "peer-session-id",
			verifiedPeerPid: 7312,
		});
		expect(events.some((event) => event.type === "file_checkpoint")).toBe(
			false,
		);
	});

	it("surfaces peer-origin input when Claude emits string content", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "user",
					uuid: "peer-string-user-id",
					session_id: "native-claude-session",
					parent_tool_use_id: null,
					origin: {
						kind: "peer",
						from: "peer-release",
						name: "Release helper",
						fromSession: "peer-session-id",
						body: "Coordinate the release",
						verifiedPeerPid: 7312,
					},
					message: {
						role: "user",
						content: "Coordinate the release",
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
		expect(events).toContainEqual({
			type: "provider_peer_message",
			body: "Coordinate the release",
			fromAddress: "peer-release",
			claimedName: "Release helper",
			fromSession: "peer-session-id",
			verifiedPeerPid: 7312,
		});
		expect(events.some((event) => event.type === "file_checkpoint")).toBe(
			false,
		);
	});

	it("preserves Claude's peer-send task-notification classification", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "user",
					uuid: "peer-notification-user-id",
					session_id: "native-claude-session",
					parent_tool_use_id: null,
					origin: {
						kind: "task-notification",
						subkind: "peer-send-message",
					},
					message: {
						role: "user",
						content: "Coordinate the release",
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
		expect(events).toContainEqual({ type: "provider_peer_message" });
		expect(events.some((event) => event.type === "file_checkpoint")).toBe(
			false,
		);
	});

	it("keeps in-process agent-team peer messages inside the active provider turn", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "user",
					uuid: "internal-peer-user-id",
					session_id: "native-claude-session",
					parent_tool_use_id: null,
					origin: {
						kind: "peer",
						from: "researcher",
						senderTaskId: "task-agent-team-1",
						body: "Internal teammate result",
					},
					message: {
						role: "user",
						content: [{ type: "text", text: "Internal teammate result" }],
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
		expect(events.some((event) => event.type === "provider_peer_message")).toBe(
			false,
		);
		expect(events.some((event) => event.type === "file_checkpoint")).toBe(
			false,
		);
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

	it("surfaces native task tools as normalized task activity", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "assistant",
					uuid: "task-list-message",
					parent_tool_use_id: null,
					message: {
						content: [
							{
								type: "tool_use",
								id: "task-list-1",
								name: "TaskList",
								input: {},
							},
						],
						usage: { input_tokens: 10, output_tokens: 5 },
					},
				},
				{
					type: "user",
					tool_use_result: {
						tasks: [
							{
								id: "7",
								subject: "Render Raven card",
								status: "in_progress",
								blockedBy: ["3"],
							},
						],
					},
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: "task-list-1",
								content: "1 task",
							},
						],
					},
				},
				{
					type: "user",
					tool_use_result: {
						tasks: [
							{
								id: "8",
								subject: "Duplicate replay",
								status: "pending",
							},
						],
					},
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: "task-list-1",
								content: "duplicate result",
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
					usage: { input_tokens: 10, output_tokens: 5 },
				},
			]),
		);

		const events = await collectEvents(baseParams());
		expect(events).toContainEqual({
			type: "tool_start",
			toolId: "task-list-1",
			name: "TaskList",
			input: {},
			taskActivity: {
				kind: "tasks",
				source: "claude-task-store",
				operation: "list",
				items: [],
			},
		});
		expect(events).toContainEqual({
			type: "tool_activity_update",
			toolId: "task-list-1",
			taskActivity: {
				kind: "tasks",
				source: "claude-task-store",
				operation: "list",
				items: [
					{
						id: "7",
						subject: "Render Raven card",
						status: "in_progress",
						blockedBy: ["3"],
					},
				],
			},
		});
		expect(
			events.filter((event) => event.type === "tool_activity_update"),
		).toHaveLength(1);
	});

	it("surfaces structured Claude assistant failures as terminal provider errors", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "assistant",
					error: "authentication_failed",
					message: {
						content: [
							{
								type: "text",
								text: "Failed to authenticate: OAuth session expired.",
							},
						],
						usage: { input_tokens: 0, output_tokens: 0 },
					},
				},
				{
					type: "result",
					subtype: "success",
					is_error: true,
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 100,
					result: "Failed to authenticate: OAuth session expired.",
					usage: { input_tokens: 0, output_tokens: 0 },
				},
			]),
		);

		const events = await collectEvents(baseParams());
		const textEvent = {
			type: "text_delta",
			text: "Failed to authenticate: OAuth session expired.",
		} as const;
		const errorEvent = {
			type: "transport_error",
			message: "Failed to authenticate: OAuth session expired.",
		} as const;
		expect(events).toContainEqual(textEvent);
		expect(events).toContainEqual(errorEvent);
		expect(
			events.findIndex((event) => event.type === "transport_error"),
		).toBeGreaterThan(
			events.findIndex(
				(event) =>
					event.type === "text_delta" &&
					event.text === "Failed to authenticate: OAuth session expired.",
			),
		);
	});

	it("does not fail the root turn for a structured Claude subagent error", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "assistant",
					parent_tool_use_id: "agent-tool-1",
					error: "authentication_failed",
					message: {
						content: [
							{ type: "text", text: "Subagent authentication failed." },
						],
						usage: { input_tokens: 0, output_tokens: 0 },
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
		expect(events.some((event) => event.type === "transport_error")).toBe(
			false,
		);
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

	it("tracks a native workflow, retains resume metadata, and links its child agents", async () => {
		const probes = [
			{
				type: "workflow_agent",
				agentId: "probe-vault",
				label: "probe:vault-info",
				phaseTitle: "Probe",
				model: "claude-opus-5",
				state: "running",
				startedAt: 1_000,
			},
			{
				type: "workflow_agent",
				agentId: "probe-search",
				label: "probe:search",
				phaseTitle: "Probe",
				state: "running",
				startedAt: 1_001,
			},
			{
				type: "workflow_agent",
				agentId: "probe-daily",
				label: "probe:daily-note",
				phaseTitle: "Probe",
				state: "running",
				startedAt: 1_002,
			},
		];
		let stateReads = 0;
		const workflowProgressReader = vi.fn(
			async (_runtimeCwd: string, providerPath: string) => {
				if (providerPath === "/tmp/workflow-result") {
					return {
						workflowProgress: [
							...probes.map((probe) => ({
								...probe,
								state: "done",
								lastProgressAt: 2_000,
								durationMs: 1_000,
							})),
							{
								type: "workflow_agent",
								agentId: "synthesize",
								label: "synthesize",
								phaseTitle: "Synthesize",
								state: "done",
								startedAt: 2_000,
								lastProgressAt: 2_500,
								durationMs: 500,
								tokens: 300,
							},
						],
					};
				}
				if (providerPath !== "/tmp/workflow/workflow-run-1.json") {
					return null;
				}
				stateReads++;
				return {
					workflowProgress:
						stateReads === 1
							? probes
							: [
									...probes.map((probe) => ({
										...probe,
										state: "done",
										lastProgressAt: 2_000,
										durationMs: 1_000,
										toolCalls: 2,
									})),
									{
										type: "workflow_agent",
										agentId: "synthesize",
										label: "synthesize",
										phaseTitle: "Synthesize",
										state: "running",
										startedAt: 2_000,
										lastToolName: "Read",
										lastToolSummary: "Combining probe results",
									},
								],
				};
			},
		);
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "assistant",
					parent_tool_use_id: null,
					message: {
						content: [
							{
								type: "tool_use",
								id: "workflow-tool-1",
								name: "Workflow",
								input: { name: "repository-audit" },
							},
						],
						usage: { input_tokens: 10, output_tokens: 5 },
					},
				},
				{
					type: "system",
					subtype: "task_started",
					task_id: "workflow-task-1",
					tool_use_id: "workflow-tool-1",
					task_type: "local_workflow",
					workflow_name: "repository-audit",
					description: "Auditing repository",
					session_id: "sid",
					uuid: "u1",
				},
				{
					type: "user",
					tool_use_result: {
						status: "async_launched",
						taskId: "workflow-task-1",
						taskType: "local_workflow",
						workflowName: "repository-audit",
						runId: "workflow-run-1",
						transcriptDir: "/tmp/workflow/transcripts",
						scriptPath:
							"/tmp/workflow/scripts/repository-audit-workflow-run-1.js",
					},
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: "workflow-tool-1",
								content: "Workflow launched in the background.",
							},
						],
					},
				},
				{
					type: "system",
					subtype: "task_progress",
					task_id: "workflow-task-1",
					description: "Synthesize: combining results",
					usage: { total_tokens: 500, tool_uses: 6, duration_ms: 1200 },
					session_id: "sid",
					uuid: "u2",
				},
				{
					type: "system",
					subtype: "task_notification",
					task_id: "workflow-task-1",
					status: "completed",
					output_file: "/tmp/workflow-result",
					summary: "Repository audit complete",
					usage: { total_tokens: 700, tool_uses: 3, duration_ms: 1500 },
					session_id: "sid",
					uuid: "u4",
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

		const events = await collectEvents(baseParams(), {
			workflowProgressReader,
		});
		expect(
			events.find(
				(event) =>
					event.type === "tool_update" &&
					event.toolId === "workflow-tool-1" &&
					event.subagent.workflowRunId === "workflow-run-1",
			),
		).toMatchObject({
			type: "tool_update",
			toolId: "workflow-tool-1",
			subagent: {
				kind: "workflow",
				activityType: "local_workflow",
				name: "repository-audit",
				workflowRunId: "workflow-run-1",
				workflowTranscriptDir: "/tmp/workflow/transcripts",
				workflowScriptPath:
					"/tmp/workflow/scripts/repository-audit-workflow-run-1.js",
			},
		});
		const childStarts = events.filter(
			(event) =>
				event.type === "tool_start" &&
				event.subagent?.parentActivityId === "workflow-task-1",
		);
		expect(
			childStarts.map((event) =>
				event.type === "tool_start" ? event.subagent?.name : undefined,
			),
		).toEqual([
			"probe:vault-info",
			"probe:search",
			"probe:daily-note",
			"synthesize",
		]);
		expect(childStarts[0]).toMatchObject({
			type: "tool_start",
			name: "Subagent",
			subagent: {
				kind: "agent",
				activityType: "workflow_agent",
				parentActivityId: "workflow-task-1",
				status: "running",
			},
		});
		expect(
			events.find(
				(event) =>
					event.type === "tool_update" &&
					event.subagent.agentId === "synthesize" &&
					event.subagent.status === "completed",
			),
		).toMatchObject({
			subagent: {
				parentActivityId: "workflow-task-1",
				usage: { totalTokens: 300, durationMs: 500 },
			},
		});
		expect(
			events.find(
				(event) =>
					event.type === "tool_update" &&
					event.toolId === "workflow-tool-1" &&
					event.subagent.status === "completed",
			),
		).toMatchObject({
			subagent: {
				currentStep: "Repository audit complete",
			},
		});
		expect(workflowProgressReader).toHaveBeenCalledWith(
			"/tmp/test",
			"/tmp/workflow/workflow-run-1.json",
		);
		expect(workflowProgressReader).not.toHaveBeenCalledWith(
			"/tmp/test",
			"/tmp/subagents/workflows/workflow-run-1/journal.jsonl",
		);
		expect(workflowProgressReader).toHaveBeenCalledWith(
			"/tmp/test",
			"/tmp/workflow-result",
		);
	});

	it("reads native workflow progress from the provider-owned state file", async () => {
		const workflowDir = await mkdtemp(
			join(tmpdir(), "hlid-claude-workflow-progress-"),
		);
		try {
			const scriptsDir = join(workflowDir, "scripts");
			const runId = "workflow-run-native";
			const scriptPath = join(scriptsDir, `smoke-${runId}.js`);
			const statePath = join(workflowDir, `${runId}.json`);
			await mkdir(scriptsDir);
			await writeFile(
				statePath,
				JSON.stringify({
					workflowProgress: [
						{ type: "workflow_phase", index: 1, title: "Probe" },
						{
							type: "workflow_agent",
							agentId: "native-agent-1",
							label: "probe:native",
							phaseTitle: "Probe",
							model: "claude-opus-5",
							effort: "high",
							attempt: 2,
							state: "done",
							startedAt: 1_000,
							lastProgressAt: 1_250,
							durationMs: 250,
							tokens: 42,
							toolCalls: 2,
							lastToolName: "StructuredOutput",
							lastToolSummary: "Summarizing native probe",
							promptPreview: "Inspect native workflow metadata",
							resultPreview: '{"summary":"Native probe complete"}',
						},
					],
				}),
				"utf8",
			);
			vi.mocked(query).mockReturnValueOnce(
				sdkGen([
					{
						type: "assistant",
						parent_tool_use_id: null,
						message: {
							content: [
								{
									type: "tool_use",
									id: "workflow-tool-native",
									name: "Workflow",
									input: { name: "native-smoke" },
								},
							],
							usage: { input_tokens: 1, output_tokens: 1 },
						},
					},
					{
						type: "system",
						subtype: "task_started",
						task_id: "workflow-task-native",
						tool_use_id: "workflow-tool-native",
						task_type: "local_workflow",
						description: "Running native smoke",
					},
					{
						type: "user",
						tool_use_result: {
							status: "async_launched",
							taskId: "workflow-task-native",
							taskType: "local_workflow",
							runId,
							scriptPath,
						},
						message: {
							content: [
								{
									type: "tool_result",
									tool_use_id: "workflow-tool-native",
									content: "Workflow launched in background.",
								},
							],
						},
					},
					{
						type: "system",
						subtype: "task_notification",
						task_id: "workflow-task-native",
						status: "completed",
						output_file: statePath,
						summary: "Native smoke complete",
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

			const child = (await collectEvents(baseParams())).find(
				(event) =>
					event.type === "tool_start" &&
					event.subagent?.agentId === "native-agent-1",
			);
			expect(child).toMatchObject({
				type: "tool_start",
				subagent: {
					name: "probe:native",
					parentActivityId: "workflow-task-native",
					phase: "Probe",
					model: "claude-opus-5",
					effort: "high",
					attempt: 2,
					status: "completed",
					currentStep: "Summarizing native probe",
					lastTool: "StructuredOutput",
					prompt: "Inspect native workflow metadata",
					resultPreview: '{"summary":"Native probe complete"}',
					usage: { totalTokens: 42, toolUses: 2, durationMs: 250 },
				},
			});
		} finally {
			await rm(workflowDir, { recursive: true, force: true });
		}
	});

	it("discovers live workflow children from Claude's append-only journal", async () => {
		const sessionDir = await mkdtemp(
			join(tmpdir(), "hlid-claude-workflow-journal-"),
		);
		try {
			const runId = "workflow-run-live-journal";
			const scriptsDir = join(sessionDir, "workflows", "scripts");
			const scriptPath = join(scriptsDir, `smoke-${runId}.js`);
			const journalDir = join(sessionDir, "subagents", "workflows", runId);
			const journalPath = join(journalDir, "journal.jsonl");
			const statePath = join(sessionDir, "workflows", `${runId}.json`);
			await mkdir(scriptsDir, { recursive: true });
			await mkdir(journalDir, { recursive: true });
			await writeFile(
				statePath,
				JSON.stringify({
					taskId: "stopped-workflow-task",
					workflowProgress: [
						{
							type: "workflow_agent",
							agentId: "stale-state-agent",
							state: "running",
						},
					],
				}),
				"utf8",
			);

			vi.mocked(query).mockReturnValueOnce(
				sdkStream(async function* () {
					yield {
						type: "assistant",
						parent_tool_use_id: null,
						message: {
							content: [
								{
									type: "tool_use",
									id: "workflow-tool-journal",
									name: "Workflow",
									input: { name: "journal-smoke" },
								},
							],
							usage: { input_tokens: 1, output_tokens: 1 },
						},
					};
					yield {
						type: "system",
						subtype: "task_started",
						task_id: "workflow-task-journal",
						tool_use_id: "workflow-tool-journal",
						task_type: "local_workflow",
						description: "Running journal smoke",
					};
					await writeFile(
						journalPath,
						[
							JSON.stringify({
								type: "started",
								key: "logical-agent-1",
								agentId: "stopped-attempt-agent",
							}),
							JSON.stringify({
								type: "started",
								key: "logical-agent-1",
								agentId: "journal-agent-1",
								phaseTitle: "Probe",
								model: "claude-opus-5",
								effort: "high",
								attempt: 2,
								lastToolName: "Read",
								lastToolSummary: "Inspecting workflow metadata",
								promptPreview: "Inspect the live workflow journal",
								tokens: 12,
								toolCalls: 1,
							}),
							"",
						].join("\n"),
						"utf8",
					);
					yield {
						type: "user",
						tool_use_result: {
							status: "async_launched",
							taskId: "workflow-task-journal",
							taskType: "local_workflow",
							runId,
							scriptPath,
						},
						message: {
							content: [
								{
									type: "tool_result",
									tool_use_id: "workflow-tool-journal",
									content: "Workflow launched in background.",
								},
							],
						},
					};
					await writeFile(
						journalPath,
						[
							JSON.stringify({
								type: "started",
								key: "logical-agent-1",
								agentId: "stopped-attempt-agent",
							}),
							JSON.stringify({
								type: "started",
								key: "logical-agent-1",
								agentId: "journal-agent-1",
							}),
							JSON.stringify({
								type: "result",
								key: "logical-agent-1",
								agentId: "journal-agent-1",
								result: "done",
								resultPreview: '{"summary":"Journal probe complete"}',
							}),
							"",
						].join("\n"),
						"utf8",
					);
					yield {
						type: "system",
						subtype: "task_progress",
						task_id: "workflow-task-journal",
						description: "Finishing journal smoke",
						usage: { total_tokens: 1, tool_uses: 1, duration_ms: 10 },
					};
					yield {
						type: "system",
						subtype: "task_notification",
						task_id: "workflow-task-journal",
						status: "completed",
						output_file: statePath,
						summary: "Journal smoke complete",
					};
					yield {
						type: "result",
						subtype: "success",
						total_cost_usd: 0,
						num_turns: 1,
						duration_ms: 1,
						usage: { input_tokens: 1, output_tokens: 1 },
					};
				}),
			);

			const events = await collectEvents(baseParams());
			const childStart = events.find(
				(event) =>
					event.type === "tool_start" &&
					event.subagent?.agentId === "journal-agent-1",
			);
			expect(childStart).toMatchObject({
				type: "tool_start",
				subagent: {
					name: "Workflow agent 1",
					parentActivityId: "workflow-task-journal",
					status: "running",
				},
			});
			expect(
				events.some(
					(event) =>
						(event.type === "tool_start" || event.type === "tool_update") &&
						["stopped-attempt-agent", "stale-state-agent"].includes(
							event.subagent?.agentId ?? "",
						),
				),
			).toBe(false);
			expect(
				events.find(
					(event) =>
						event.type === "tool_update" &&
						event.subagent.agentId === "journal-agent-1" &&
						event.subagent.status === "completed" &&
						event.subagent.currentStep === "Completed",
				),
			).toMatchObject({
				subagent: {
					phase: "Probe",
					model: "claude-opus-5",
					effort: "high",
					attempt: 2,
					lastTool: "Read",
					prompt: "Inspect the live workflow journal",
					resultPreview: '{"summary":"Journal probe complete"}',
					usage: { totalTokens: 12, toolUses: 1 },
				},
			});
		} finally {
			await rm(sessionDir, { recursive: true, force: true });
		}
	});

	it("refreshes live workflow children while the Claude SDK stream is quiet", async () => {
		const runId = "workflow-run-background-refresh";
		const statePath = `/tmp/workflows/${runId}.json`;
		let stateReads = 0;
		let resolveProgressRead: (() => void) | undefined;
		const progressRead = new Promise<void>((resolve) => {
			resolveProgressRead = resolve;
		});
		let releaseWorkflow: (() => void) | undefined;
		const workflowReleased = new Promise<void>((resolve) => {
			releaseWorkflow = resolve;
		});
		const workflowProgressReader = vi.fn(
			async (_runtimeCwd: string, providerPath: string) => {
				if (providerPath !== statePath) return null;
				stateReads++;
				if (stateReads === 1) return null;
				resolveProgressRead?.();
				return {
					workflowProgress: [
						{
							type: "workflow_agent",
							agentId: "background-agent",
							label: "background probe",
							phaseTitle: "Probe",
							model: "claude-opus-5",
							state: "running",
							lastToolName: "Read",
							lastToolSummary: "Inspecting in the background",
							promptPreview: "Inspect live workflow progress",
						},
					],
				};
			},
		);
		vi.mocked(query).mockReturnValueOnce(
			sdkStream(async function* () {
				yield {
					type: "assistant",
					parent_tool_use_id: null,
					message: {
						content: [
							{
								type: "tool_use",
								id: "workflow-tool-background-refresh",
								name: "Workflow",
								input: { name: "background-refresh" },
							},
						],
						usage: { input_tokens: 1, output_tokens: 1 },
					},
				};
				yield {
					type: "system",
					subtype: "task_started",
					task_id: "workflow-task-background-refresh",
					tool_use_id: "workflow-tool-background-refresh",
					task_type: "local_workflow",
					description: "Running background refresh",
				};
				yield {
					type: "user",
					tool_use_result: {
						status: "async_launched",
						taskId: "workflow-task-background-refresh",
						taskType: "local_workflow",
						runId,
						scriptPath: `/tmp/workflows/scripts/smoke-${runId}.js`,
					},
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: "workflow-tool-background-refresh",
								content: "Workflow launched in background.",
							},
						],
					},
				};
				yield {
					type: "result",
					subtype: "success",
					terminal_reason: "background_requested",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 1,
					usage: { input_tokens: 1, output_tokens: 1 },
				};
				await workflowReleased;
				yield {
					type: "system",
					subtype: "task_notification",
					task_id: "workflow-task-background-refresh",
					status: "stopped",
					summary: "Stopped after background refresh",
				};
			}),
		);

		const eventsPromise = collectEvents(baseParams(), {
			workflowProgressReader,
		});
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("workflow progress was not refreshed")),
				4_000,
			);
			progressRead.then(
				() => {
					clearTimeout(timer);
					resolve();
				},
				(error) => {
					clearTimeout(timer);
					reject(error);
				},
			);
		});
		releaseWorkflow?.();
		const events = await eventsPromise;

		expect(stateReads).toBeGreaterThanOrEqual(2);
		expect(
			events.find(
				(event) =>
					event.type === "tool_start" &&
					event.subagent?.agentId === "background-agent" &&
					event.subagent.status === "running",
			),
		).toMatchObject({
			subagent: {
				parentActivityId: "workflow-task-background-refresh",
				model: "claude-opus-5",
				currentStep: "Inspecting in the background",
				lastTool: "Read",
				prompt: "Inspect live workflow progress",
			},
		});
	});

	it("interrupts active workflow children as soon as Claude confirms a stop", async () => {
		const staleProgress = {
			workflowProgress: [
				{
					type: "workflow_agent",
					agentId: "already-done",
					label: "already done",
					state: "done",
					startedAt: 1_000,
					lastProgressAt: 1_100,
				},
				{
					type: "workflow_agent",
					agentId: "still-running",
					label: "still running",
					state: "running",
					startedAt: 1_000,
				},
				{
					type: "workflow_agent",
					agentId: "still-pending",
					label: "still pending",
					state: "pending",
					queuedAt: 1_000,
				},
			],
		};
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "assistant",
					parent_tool_use_id: null,
					message: {
						content: [
							{
								type: "tool_use",
								id: "workflow-tool-stop",
								name: "Workflow",
								input: { name: "stop-smoke" },
							},
						],
						usage: { input_tokens: 1, output_tokens: 1 },
					},
				},
				{
					type: "system",
					subtype: "task_started",
					task_id: "workflow-task-stop",
					tool_use_id: "workflow-tool-stop",
					task_type: "local_workflow",
					description: "Running stop smoke",
				},
				{
					type: "user",
					tool_use_result: {
						status: "async_launched",
						taskId: "workflow-task-stop",
						taskType: "local_workflow",
						runId: "workflow-run-stop",
						scriptPath: "/tmp/workflow/scripts/stop-smoke-workflow-run-stop.js",
					},
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: "workflow-tool-stop",
								content: "Workflow launched in background.",
							},
						],
					},
				},
				{
					type: "system",
					subtype: "task_notification",
					task_id: "workflow-task-stop",
					status: "stopped",
					summary: "Stopped by user",
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

		const events = await collectEvents(baseParams(), {
			// Claude's final state snapshot can still say "running" for children
			// even though its native stop has already interrupted their transcripts.
			workflowProgressReader: async () => staleProgress,
		});
		const finalChildren = new Map<string, SubagentSnapshot>();
		for (const event of events) {
			if (
				(event.type === "tool_start" || event.type === "tool_update") &&
				event.subagent?.parentActivityId === "workflow-task-stop"
			) {
				finalChildren.set(event.subagent.agentId, event.subagent);
			}
		}
		expect(finalChildren.get("already-done")?.status).toBe("completed");
		expect(finalChildren.get("still-running")).toMatchObject({
			status: "interrupted",
			currentStep: "Workflow stopped",
			endedAtMs: expect.any(Number),
		});
		expect(finalChildren.get("still-pending")).toMatchObject({
			status: "interrupted",
			currentStep: "Workflow stopped",
			endedAtMs: expect.any(Number),
		});
		expect(
			events.find(
				(event) =>
					event.type === "tool_update" &&
					event.toolId === "workflow-tool-stop" &&
					event.subagent.status === "interrupted",
			),
		).toMatchObject({
			subagent: {
				workflowStopConfirmed: true,
				currentStep: "Stopped by user",
			},
		});
	});

	it("keeps a root Agent tool flat while a workflow is running", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "assistant",
					parent_tool_use_id: null,
					message: {
						content: [
							{
								type: "tool_use",
								id: "workflow-tool",
								name: "Workflow",
								input: { name: "audit" },
							},
						],
						usage: { input_tokens: 1, output_tokens: 1 },
					},
				},
				{
					type: "system",
					subtype: "task_started",
					task_id: "workflow-task",
					tool_use_id: "workflow-tool",
					task_type: "local_workflow",
					description: "Running workflow",
					session_id: "sid",
					uuid: "u1",
				},
				{
					type: "assistant",
					parent_tool_use_id: null,
					message: {
						content: [
							{
								type: "tool_use",
								id: "root-agent-tool",
								name: "Agent",
								input: { prompt: "Independent work" },
							},
						],
						usage: { input_tokens: 1, output_tokens: 1 },
					},
				},
				{
					type: "system",
					subtype: "task_started",
					task_id: "root-agent-task",
					tool_use_id: "root-agent-tool",
					task_type: "subagent",
					description: "Independent work",
					session_id: "sid",
					uuid: "u2",
				},
				{
					type: "system",
					subtype: "task_notification",
					task_id: "root-agent-task",
					status: "completed",
					output_file: "/tmp/root-result",
					summary: "Independent work complete",
					session_id: "sid",
					uuid: "u3",
				},
				{
					type: "system",
					subtype: "task_notification",
					task_id: "workflow-task",
					status: "completed",
					output_file: "/tmp/workflow-result",
					summary: "Workflow complete",
					session_id: "sid",
					uuid: "u4",
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

		const update = (await collectEvents(baseParams())).find(
			(event) =>
				event.type === "tool_update" &&
				event.subagent.agentId === "root-agent-task" &&
				event.subagent.status === "running",
		);
		expect(update).toMatchObject({
			subagent: {
				kind: "agent",
				agentId: "root-agent-task",
			},
		});
		expect(
			update?.type === "tool_update"
				? update.subagent.parentActivityId
				: undefined,
		).toBeUndefined();
	});

	it("keeps an unparented child flat when workflow lineage is ambiguous", async () => {
		const workflowEvents = ["one", "two"].flatMap((suffix) => [
			{
				type: "assistant",
				parent_tool_use_id: null,
				message: {
					content: [
						{
							type: "tool_use",
							id: `workflow-tool-${suffix}`,
							name: "Workflow",
							input: { name: `workflow-${suffix}` },
						},
					],
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			},
			{
				type: "system",
				subtype: "task_started",
				task_id: `workflow-task-${suffix}`,
				tool_use_id: `workflow-tool-${suffix}`,
				task_type: "local_workflow",
				description: `Running workflow ${suffix}`,
				session_id: "sid",
				uuid: `workflow-${suffix}`,
			},
		]);
		const completions = ["one", "two"].map((suffix) => ({
			type: "system",
			subtype: "task_notification",
			task_id: `workflow-task-${suffix}`,
			status: "completed",
			output_file: `/tmp/workflow-${suffix}`,
			summary: `Workflow ${suffix} complete`,
			session_id: "sid",
			uuid: `done-${suffix}`,
		}));
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				...workflowEvents,
				{
					type: "system",
					subtype: "task_started",
					task_id: "ambiguous-child",
					task_type: "subagent",
					description: "Unparented child",
					session_id: "sid",
					uuid: "child",
				},
				...completions,
				{
					type: "system",
					subtype: "task_notification",
					task_id: "ambiguous-child",
					status: "completed",
					output_file: "/tmp/child",
					summary: "Child complete",
					session_id: "sid",
					uuid: "child-done",
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

		const childStart = (await collectEvents(baseParams())).find(
			(event) =>
				event.type === "tool_start" &&
				event.subagent?.agentId === "ambiguous-child",
		);
		expect(childStart).toMatchObject({
			type: "tool_start",
			subagent: { kind: "agent", status: "running" },
		});
		expect(
			childStart?.type === "tool_start"
				? childStart.subagent?.parentActivityId
				: undefined,
		).toBeUndefined();
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
			"interrupted",
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
				status: "interrupted",
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
					uuid: "synthetic-tool-result-id",
					session_id: "native-claude-session",
					parent_tool_use_id: null,
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
			{
				type: "tool_result",
				toolId: "t-1",
				content: "file1\nfile2",
				providerFrame: {
					providerSessionId: "native-claude-session",
					providerUuid: "synthetic-tool-result-id",
				},
			},
		]);
		expect(events.some((event) => event.type === "file_checkpoint")).toBe(
			false,
		);
	});

	it("emits assistant supersedes before the canonical replacement frame", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "assistant",
					uuid: "replacement-frame",
					session_id: "native-refusal",
					parent_tool_use_id: null,
					supersedes: ["refused-frame", "replacement-frame"],
					message: {
						model: "claude-sonnet-4-6",
						usage: { input_tokens: 2, output_tokens: 2 },
						content: [{ type: "text", text: "Canonical answer" }],
					},
				},
				{
					type: "result",
					subtype: "success",
					result: "Canonical answer",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 10,
					usage: { input_tokens: 2, output_tokens: 2 },
				},
			]),
		);
		const events = await collectEvents(baseParams());
		const retractionIndex = events.findIndex(
			(event) => event.type === "provider_message_retraction",
		);
		const frameIndex = events.findIndex(
			(event) =>
				event.type === "provider_message_frame" &&
				event.id === "replacement-frame",
		);
		const textIndex = events.findIndex((event) => event.type === "text_delta");
		expect(events[retractionIndex]).toEqual({
			type: "provider_message_retraction",
			ids: ["refused-frame"],
			providerSessionId: "native-refusal",
			source: "assistant_supersedes",
		});
		expect(retractionIndex).toBeLessThan(frameIndex);
		expect(frameIndex).toBeLessThan(textIndex);
	});

	it("uses the fallback notice as an idempotent final retraction backstop", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "system",
					subtype: "model_refusal_fallback",
					session_id: "native-refusal",
					uuid: "fallback-notice",
					trigger: "refusal",
					direction: "retry",
					scope: "local",
					original_model: "claude-opus-4-6",
					fallback_model: "claude-sonnet-4-6",
					request_id: "request-1",
					refused_user_message_uuid: "user-1",
					api_refusal_category: "cyber",
					api_refusal_explanation: "Display only",
					retracted_message_uuids: ["refused-frame", "tool-result-frame"],
					content: "",
				},
			]),
		);
		const events = await collectEvents(baseParams());
		expect(events).toContainEqual({
			type: "provider_message_retraction",
			ids: ["refused-frame", "tool-result-frame"],
			providerSessionId: "native-refusal",
			source: "model_refusal_fallback",
		});
		expect(events).toContainEqual({
			type: "provider_refusal",
			providerSessionId: "native-refusal",
			outcome: "fallback",
			originalModel: "claude-opus-4-6",
			fallbackModel: "claude-sonnet-4-6",
			direction: "retry",
			scope: "local",
			requestId: "request-1",
			refusedUserMessageUuid: "user-1",
			category: "cyber",
			explanation: "Display only",
			content: "",
		});
	});

	it("accepts fallback-first ordering before an overlapping replacement supersedes", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "system",
					subtype: "model_refusal_fallback",
					session_id: "native-fallback-first",
					uuid: "fallback-notice",
					trigger: "refusal",
					direction: "retry",
					original_model: "claude-opus-4-6",
					fallback_model: "claude-sonnet-4-6",
					request_id: "request-first",
					retracted_message_uuids: ["refused-frame"],
					content: "",
				},
				{
					type: "assistant",
					uuid: "replacement-frame",
					session_id: "native-fallback-first",
					parent_tool_use_id: null,
					supersedes: ["refused-frame"],
					message: {
						model: "claude-sonnet-4-6",
						usage: { input_tokens: 2, output_tokens: 2 },
						content: [{ type: "text", text: "Replacement after notice" }],
					},
				},
				{
					type: "result",
					subtype: "success",
					result: "Replacement after notice",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 10,
					usage: { input_tokens: 2, output_tokens: 2 },
				},
			]),
		);
		const events = await collectEvents(baseParams());
		const retractions = events
			.map((event, index) => ({ event, index }))
			.filter(
				(
					item,
				): item is {
					event: Extract<AgentEvent, { type: "provider_message_retraction" }>;
					index: number;
				} => item.event.type === "provider_message_retraction",
			);
		const replacementFrameIndex = events.findIndex(
			(event) =>
				event.type === "provider_message_frame" &&
				event.id === "replacement-frame",
		);
		expect(retractions.map(({ event }) => event.source)).toEqual([
			"model_refusal_fallback",
			"assistant_supersedes",
		]);
		expect(retractions[0]?.index).toBeLessThan(retractions[1]?.index ?? -1);
		expect(retractions[1]?.index).toBeLessThan(replacementFrameIndex);
		expect(events).toContainEqual({
			type: "text_delta",
			text: "Replacement after notice",
			providerFrame: {
				providerSessionId: "native-fallback-first",
				providerUuid: "replacement-frame",
			},
		});
	});

	it("accepts replacement supersedes before the overlapping final fallback notice", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "assistant",
					uuid: "refused-frame",
					session_id: "native-supersedes-first",
					parent_tool_use_id: null,
					message: {
						model: "claude-opus-4-6",
						usage: { input_tokens: 2, output_tokens: 2 },
						content: [{ type: "text", text: "Refused text" }],
					},
				},
				{
					type: "assistant",
					uuid: "replacement-frame",
					session_id: "native-supersedes-first",
					parent_tool_use_id: null,
					supersedes: ["refused-frame"],
					message: {
						model: "claude-sonnet-4-6",
						usage: { input_tokens: 2, output_tokens: 2 },
						content: [{ type: "text", text: "Canonical text" }],
					},
				},
				{
					type: "system",
					subtype: "model_refusal_fallback",
					session_id: "native-supersedes-first",
					uuid: "fallback-notice",
					trigger: "refusal",
					direction: "retry",
					original_model: "claude-opus-4-6",
					fallback_model: "claude-sonnet-4-6",
					request_id: "request-last",
					retracted_message_uuids: ["refused-frame"],
					content: "",
				},
				{
					type: "result",
					subtype: "success",
					result: "Canonical text",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 10,
					usage: { input_tokens: 2, output_tokens: 2 },
				},
			]),
		);
		const events = await collectEvents(baseParams());
		const retractions = events
			.map((event, index) => ({ event, index }))
			.filter(
				(
					item,
				): item is {
					event: Extract<AgentEvent, { type: "provider_message_retraction" }>;
					index: number;
				} => item.event.type === "provider_message_retraction",
			);
		const replacementFrameIndex = events.findIndex(
			(event) =>
				event.type === "provider_message_frame" &&
				event.id === "replacement-frame",
		);
		expect(retractions.map(({ event }) => event.source)).toEqual([
			"assistant_supersedes",
			"model_refusal_fallback",
		]);
		expect(retractions[0]?.index).toBeLessThan(replacementFrameIndex);
		expect(replacementFrameIndex).toBeLessThan(retractions[1]?.index ?? -1);
		expect(events).toContainEqual({
			type: "text_delta",
			text: "Canonical text",
			providerFrame: {
				providerSessionId: "native-supersedes-first",
				providerUuid: "replacement-frame",
			},
		});
	});

	it("preserves derived per-block UUID linkage from normalized multi-block messages", async () => {
		const assistantPrefix = "01234567-89ab-cdef-0123-";
		const resultPrefix = "fedcba98-7654-3210-fedc-";
		const assistantFrame = (index: number) =>
			`${assistantPrefix}${index.toString(16).padStart(12, "0")}`;
		const resultFrame = (index: number) =>
			`${resultPrefix}${index.toString(16).padStart(12, "0")}`;
		const assistantMessage = (
			index: number,
			block: Record<string, unknown>,
			extra: Record<string, unknown> = {},
		) => ({
			type: "assistant",
			uuid: assistantFrame(index),
			session_id: "native-normalized",
			parent_tool_use_id: null,
			...extra,
			message: {
				model: "claude-sonnet-4-6",
				usage: { input_tokens: 1, output_tokens: 1 },
				content: [block],
			},
		});
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				assistantMessage(
					0,
					{ type: "text", text: "Opening." },
					{ supersedes: ["old-text-frame", "old-tool-frame"] },
				),
				assistantMessage(1, {
					type: "tool_use",
					id: "read-tool",
					name: "Read",
					input: { file_path: "/tmp/a" },
				}),
				assistantMessage(2, {
					type: "tool_use",
					id: "bash-tool",
					name: "Bash",
					input: { command: "pwd" },
				}),
				assistantMessage(3, { type: "text", text: "Closing." }),
				{
					type: "user",
					uuid: resultFrame(0),
					session_id: "native-normalized",
					parent_tool_use_id: null,
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: "read-tool",
								content: "read result",
							},
						],
					},
				},
				{
					type: "user",
					uuid: resultFrame(1),
					session_id: "native-normalized",
					parent_tool_use_id: null,
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: "bash-tool",
								content: "bash result",
							},
						],
					},
				},
				{
					type: "result",
					subtype: "success",
					result: "Closing.",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 10,
					usage: { input_tokens: 4, output_tokens: 4 },
				},
			]),
		);
		const events = await collectEvents(baseParams());
		expect(
			events.filter((event) => event.type === "provider_message_retraction"),
		).toEqual([
			{
				type: "provider_message_retraction",
				ids: ["old-text-frame", "old-tool-frame"],
				providerSessionId: "native-normalized",
				source: "assistant_supersedes",
			},
		]);
		expect(
			events.filter((event) => event.type === "provider_message_frame"),
		).toEqual([
			{
				type: "provider_message_frame",
				id: assistantFrame(0),
				providerSessionId: "native-normalized",
				kind: "assistant",
				text: "Opening.",
			},
			{
				type: "provider_message_frame",
				id: assistantFrame(1),
				providerSessionId: "native-normalized",
				kind: "assistant",
				text: "",
				toolStartIds: ["read-tool"],
			},
			{
				type: "provider_message_frame",
				id: assistantFrame(2),
				providerSessionId: "native-normalized",
				kind: "assistant",
				text: "",
				toolStartIds: ["bash-tool"],
			},
			{
				type: "provider_message_frame",
				id: assistantFrame(3),
				providerSessionId: "native-normalized",
				kind: "assistant",
				text: "Closing.",
			},
			{
				type: "provider_message_frame",
				id: resultFrame(0),
				providerSessionId: "native-normalized",
				kind: "tool_result",
				toolResultIds: ["read-tool"],
			},
			{
				type: "provider_message_frame",
				id: resultFrame(1),
				providerSessionId: "native-normalized",
				kind: "tool_result",
				toolResultIds: ["bash-tool"],
			},
		]);
		expect(
			events
				.filter(
					(event) =>
						event.type === "text_delta" ||
						event.type === "tool_start" ||
						event.type === "tool_result",
				)
				.map((event) => ({
					type: event.type,
					providerFrame: event.providerFrame,
				})),
		).toEqual([
			{
				type: "text_delta",
				providerFrame: {
					providerSessionId: "native-normalized",
					providerUuid: assistantFrame(0),
				},
			},
			{
				type: "tool_start",
				providerFrame: {
					providerSessionId: "native-normalized",
					providerUuid: assistantFrame(1),
				},
			},
			{
				type: "tool_start",
				providerFrame: {
					providerSessionId: "native-normalized",
					providerUuid: assistantFrame(2),
				},
			},
			{
				type: "text_delta",
				providerFrame: {
					providerSessionId: "native-normalized",
					providerUuid: assistantFrame(3),
				},
			},
			{
				type: "tool_result",
				providerFrame: {
					providerSessionId: "native-normalized",
					providerUuid: resultFrame(0),
				},
			},
			{
				type: "tool_result",
				providerFrame: {
					providerSessionId: "native-normalized",
					providerUuid: resultFrame(1),
				},
			},
		]);
	});

	it("records no-fallback refusal evidence without inventing retractions", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "system",
					subtype: "model_refusal_no_fallback",
					session_id: "native-refusal",
					uuid: "no-fallback-notice",
					original_model: "claude-opus-4-6",
					request_id: "request-2",
					refused_user_message_uuid: null,
					api_refusal_category: null,
					api_refusal_explanation: null,
					content: "",
				},
			]),
		);
		const events = await collectEvents(baseParams());
		expect(
			events.filter((event) => event.type === "provider_message_retraction"),
		).toEqual([]);
		expect(events).toContainEqual({
			type: "provider_refusal",
			providerSessionId: "native-refusal",
			outcome: "no_fallback",
			originalModel: "claude-opus-4-6",
			requestId: "request-2",
			refusedUserMessageUuid: null,
			category: null,
			explanation: null,
			content: "",
		});
	});

	it("restores result fallback text after retracting the only assistant text", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "assistant",
					uuid: "refused-text",
					session_id: "native-refusal",
					parent_tool_use_id: null,
					message: {
						model: "claude-opus-4-6",
						usage: { input_tokens: 2, output_tokens: 2 },
						content: [{ type: "text", text: "Refused partial" }],
					},
				},
				{
					type: "system",
					subtype: "model_refusal_fallback",
					session_id: "native-refusal",
					uuid: "fallback-notice",
					trigger: "refusal",
					direction: "retry",
					original_model: "claude-opus-4-6",
					fallback_model: "claude-sonnet-4-6",
					request_id: null,
					retracted_message_uuids: ["refused-text"],
					content: "",
				},
				{
					type: "result",
					subtype: "success",
					result: "Authoritative fallback result",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 10,
					usage: { input_tokens: 2, output_tokens: 4 },
				},
			]),
		);
		const events = await collectEvents(baseParams());
		expect(events).toContainEqual({
			type: "result_text_fallback",
			text: "Authoritative fallback result",
		});
	});

	it("frames result fallback text so a trailing final retraction cannot erase it", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "result",
					subtype: "success",
					uuid: "result-fallback-frame",
					session_id: "native-result-fallback",
					result: "Authoritative result fallback",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 10,
					usage: { input_tokens: 2, output_tokens: 4 },
				},
				{
					type: "system",
					subtype: "model_refusal_fallback",
					session_id: "native-result-fallback",
					uuid: "fallback-notice",
					trigger: "refusal",
					direction: "retry",
					original_model: "claude-opus-4-6",
					fallback_model: "claude-sonnet-4-6",
					request_id: "request-result-fallback",
					retracted_message_uuids: ["refused-frame"],
					content: "",
				},
				{
					type: "result",
					subtype: "success",
					uuid: "continuation-result",
					session_id: "native-result-fallback",
					result: "",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 10,
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			]),
		);
		const provider = new ClaudeProvider();
		const session = provider.query(baseParams());
		if (!session.steer) throw new Error("Claude session must support steering");
		await session.steer("keep the turn open");
		const events: AgentEvent[] = [];
		for await (const event of session) events.push(event);

		const fallbackIndex = events.findIndex(
			(event) =>
				event.type === "result_text_fallback" &&
				event.text === "Authoritative result fallback",
		);
		const retractionIndex = events.findIndex(
			(event) => event.type === "provider_message_retraction",
		);
		const doneIndex = events.findIndex((event) => event.type === "done");
		expect(events[fallbackIndex]).toEqual({
			type: "result_text_fallback",
			text: "Authoritative result fallback",
			providerSessionId: "native-result-fallback",
			providerUuid: "result-fallback-frame",
		});
		expect(fallbackIndex).toBeLessThan(retractionIndex);
		expect(retractionIndex).toBeLessThan(doneIndex);
	});

	it("suppresses a late tombstoned tool result and tracker resurrection", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "assistant",
					uuid: "tool-frame",
					session_id: "native-refusal",
					parent_tool_use_id: null,
					message: {
						model: "claude-sonnet-4-6",
						usage: { input_tokens: 1, output_tokens: 1 },
						content: [
							{
								type: "tool_use",
								id: "agent-tool",
								name: "Agent",
								input: { prompt: "work" },
							},
						],
					},
				},
				{
					type: "system",
					subtype: "model_refusal_fallback",
					session_id: "native-refusal",
					uuid: "fallback-notice",
					trigger: "refusal",
					direction: "retry",
					original_model: "claude-sonnet-4-6",
					fallback_model: "claude-opus-4-6",
					request_id: null,
					retracted_message_uuids: ["tool-frame", "late-result"],
					content: "",
				},
				{
					type: "system",
					subtype: "task_started",
					session_id: "native-refusal",
					uuid: "task-started",
					task_id: "task-1",
					tool_use_id: "agent-tool",
					task_type: "subagent",
				},
				{
					type: "user",
					uuid: "late-result",
					session_id: "native-refusal",
					parent_tool_use_id: null,
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: "agent-tool",
								content: "late",
							},
						],
					},
				},
			]),
		);
		const events = await collectEvents(baseParams());
		expect(
			events.filter(
				(event) =>
					(event.type === "tool_update" || event.type === "tool_result") &&
					("toolId" in event ? event.toolId === "agent-tool" : false),
			),
		).toEqual([]);
	});

	it("suppresses tracker state when a fallback tombstone precedes a late tool frame", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "system",
					subtype: "model_refusal_fallback",
					session_id: "native-fallback-first-tool",
					uuid: "fallback-notice",
					trigger: "refusal",
					direction: "retry",
					original_model: "claude-opus-4-6",
					fallback_model: "claude-sonnet-4-6",
					request_id: "request-fallback-first-tool",
					retracted_message_uuids: [
						"late-tool-frame",
						"late-tool-result-frame",
					],
					content: "",
				},
				{
					type: "assistant",
					uuid: "late-tool-frame",
					session_id: "native-fallback-first-tool",
					parent_tool_use_id: null,
					message: {
						model: "claude-opus-4-6",
						usage: { input_tokens: 1, output_tokens: 1 },
						content: [
							{
								type: "tool_use",
								id: "late-agent-tool",
								name: "Agent",
								input: { prompt: "must stay quarantined" },
							},
						],
					},
				},
				{
					type: "system",
					subtype: "task_started",
					session_id: "native-fallback-first-tool",
					uuid: "task-started",
					task_id: "late-task",
					tool_use_id: "late-agent-tool",
					task_type: "subagent",
				},
				{
					type: "system",
					subtype: "task_progress",
					session_id: "native-fallback-first-tool",
					uuid: "task-progress",
					task_id: "late-task",
					description: "must not resurrect",
				},
				{
					type: "user",
					uuid: "late-tool-result-frame",
					session_id: "native-fallback-first-tool",
					parent_tool_use_id: null,
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: "late-agent-tool",
								content: "late result",
							},
						],
					},
				},
			]),
		);

		const events = await collectEvents(baseParams());
		expect(events).toContainEqual({
			type: "provider_message_retraction",
			ids: ["late-tool-frame", "late-tool-result-frame"],
			providerSessionId: "native-fallback-first-tool",
			source: "model_refusal_fallback",
		});
		expect(
			events.filter(
				(event) =>
					(event.type === "tool_start" ||
						event.type === "tool_update" ||
						event.type === "tool_result" ||
						event.type === "tool_activity_update") &&
					"toolId" in event &&
					event.toolId === "late-agent-tool",
			),
		).toEqual([]);
		expect(
			events.some(
				(event) =>
					event.type === "provider_message_frame" &&
					(event.id === "late-tool-frame" ||
						event.id === "late-tool-result-frame"),
			),
		).toBe(false);
	});

	it("does not let a tombstoned workflow result seed progress children", async () => {
		const workflowProgressReader = vi.fn(async () => ({
			workflowProgress: [
				{
					type: "workflow_agent",
					agentId: "must-not-exist",
					state: "running",
				},
			],
		}));
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "assistant",
					uuid: "workflow-start-frame",
					session_id: "native-late-workflow-result",
					parent_tool_use_id: null,
					message: {
						model: "claude-opus-4-6",
						usage: { input_tokens: 1, output_tokens: 1 },
						content: [
							{
								type: "tool_use",
								id: "late-workflow-tool",
								name: "Workflow",
								input: { name: "late-workflow" },
							},
						],
					},
				},
				{
					type: "system",
					subtype: "task_started",
					task_id: "late-workflow-task",
					tool_use_id: "late-workflow-tool",
					task_type: "local_workflow",
				},
				{
					type: "system",
					subtype: "model_refusal_fallback",
					session_id: "native-late-workflow-result",
					uuid: "fallback-notice",
					trigger: "refusal",
					direction: "retry",
					original_model: "claude-opus-4-6",
					fallback_model: "claude-sonnet-4-6",
					request_id: "request-late-workflow-result",
					retracted_message_uuids: ["late-workflow-result-frame"],
					content: "",
				},
				{
					type: "user",
					uuid: "late-workflow-result-frame",
					session_id: "native-late-workflow-result",
					parent_tool_use_id: null,
					tool_use_result: {
						status: "async_launched",
						taskId: "late-workflow-task",
						taskType: "local_workflow",
						runId: "late-workflow-run",
						scriptPath: "/tmp/workflows/scripts/late-workflow.js",
					},
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: "late-workflow-tool",
								content: "late workflow result",
							},
						],
					},
				},
			]),
		);

		const events = await collectEvents(baseParams(), {
			workflowProgressReader,
		});
		expect(workflowProgressReader).not.toHaveBeenCalled();
		expect(
			events.some(
				(event) =>
					(event.type === "tool_start" || event.type === "tool_update") &&
					event.subagent?.agentId === "must-not-exist",
			),
		).toBe(false);
	});

	it("links workflow descendants to their result trigger and root dependency", async () => {
		const runId = "refused-workflow-run";
		const statePath = `/tmp/workflows/${runId}.json`;
		const workflowProgressReader = vi.fn(
			async (_runtimeCwd: string, providerPath: string) =>
				providerPath === statePath
					? {
							workflowProgress: [
								{
									type: "workflow_agent",
									agentId: "refused-workflow-child",
									state: "running",
									lastToolName: "Read",
								},
							],
						}
					: null,
		);
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "assistant",
					uuid: "refused-workflow-frame",
					session_id: "native-refused-workflow",
					parent_tool_use_id: null,
					message: {
						model: "claude-opus-4-6",
						usage: { input_tokens: 1, output_tokens: 1 },
						content: [
							{
								type: "tool_use",
								id: "refused-workflow-tool",
								name: "Workflow",
								input: { name: "refused-workflow" },
							},
						],
					},
				},
				{
					type: "system",
					subtype: "task_started",
					task_id: "refused-workflow-task",
					tool_use_id: "refused-workflow-tool",
					task_type: "local_workflow",
					description: "Running refused workflow",
				},
				{
					type: "user",
					uuid: "refused-workflow-result",
					session_id: "native-refused-workflow",
					parent_tool_use_id: null,
					tool_use_result: {
						status: "async_launched",
						taskId: "refused-workflow-task",
						taskType: "local_workflow",
						runId,
						scriptPath: `/tmp/workflows/scripts/${runId}.js`,
					},
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: "refused-workflow-tool",
								content: "Workflow launched in background.",
							},
						],
					},
				},
				{
					type: "system",
					subtype: "model_refusal_fallback",
					session_id: "native-refused-workflow",
					uuid: "fallback-notice",
					trigger: "refusal",
					direction: "retry",
					original_model: "claude-opus-4-6",
					fallback_model: "claude-sonnet-4-6",
					request_id: "request-refused-workflow",
					retracted_message_uuids: ["refused-workflow-frame"],
					content: "",
				},
				{
					type: "system",
					subtype: "task_progress",
					task_id: "refused-workflow-task",
					description: "must remain suppressed",
				},
			]),
		);

		const events = await collectEvents(baseParams(), {
			workflowProgressReader,
		});
		const resultFrame = {
			providerSessionId: "native-refused-workflow",
			providerUuid: "refused-workflow-result",
		};
		const rootFrame = {
			providerSessionId: "native-refused-workflow",
			providerUuid: "refused-workflow-frame",
		};
		expect(
			events.find(
				(event) =>
					event.type === "tool_start" &&
					event.subagent?.agentId === "refused-workflow-child",
			),
		).toMatchObject({
			type: "tool_start",
			toolId:
				"claude-workflow-agent:refused-workflow-task:refused-workflow-child",
			providerFrame: resultFrame,
			providerLineageFrames: [resultFrame, rootFrame],
		});
		const retractionIndex = events.findIndex(
			(event) => event.type === "provider_message_retraction",
		);
		expect(retractionIndex).toBeGreaterThan(-1);
		expect(
			events
				.slice(retractionIndex + 1)
				.some(
					(event) =>
						(event.type === "tool_start" || event.type === "tool_update") &&
						(event.toolId === "refused-workflow-tool" ||
							event.toolId ===
								"claude-workflow-agent:refused-workflow-task:refused-workflow-child"),
				),
		).toBe(false);
	});

	it("removes a workflow child discovered only from a retracted result frame", async () => {
		const statePath = "/tmp/workflows/result-only-run.json";
		const workflowProgressReader = vi.fn(
			async (_runtimeCwd: string, providerPath: string) =>
				providerPath === statePath
					? {
							workflowProgress: [
								{
									type: "workflow_agent",
									agentId: "result-only-child",
									state: "running",
								},
							],
						}
					: null,
		);
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "assistant",
					uuid: "result-only-start",
					session_id: "native-result-only-child",
					parent_tool_use_id: null,
					message: {
						model: "claude-opus-4-6",
						usage: { input_tokens: 1, output_tokens: 1 },
						content: [
							{
								type: "tool_use",
								id: "result-only-workflow-tool",
								name: "Workflow",
								input: { name: "result-only" },
							},
						],
					},
				},
				{
					type: "system",
					subtype: "task_started",
					task_id: "result-only-workflow-task",
					tool_use_id: "result-only-workflow-tool",
					task_type: "local_workflow",
				},
				{
					type: "user",
					uuid: "result-only-frame",
					session_id: "native-result-only-child",
					parent_tool_use_id: null,
					tool_use_result: {
						status: "async_launched",
						taskId: "result-only-workflow-task",
						taskType: "local_workflow",
						runId: "result-only-run",
						scriptPath: "/tmp/workflows/scripts/result-only-run.js",
					},
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: "result-only-workflow-tool",
								content: "launched",
							},
						],
					},
				},
				{
					type: "system",
					subtype: "model_refusal_fallback",
					session_id: "native-result-only-child",
					uuid: "result-only-fallback",
					trigger: "refusal",
					direction: "retry",
					original_model: "claude-opus-4-6",
					fallback_model: "claude-sonnet-4-6",
					request_id: "result-only-request",
					retracted_message_uuids: ["result-only-frame"],
					content: "",
				},
			]),
		);

		const events = await collectEvents(baseParams(), {
			workflowProgressReader,
		});
		const childToolId =
			"claude-workflow-agent:result-only-workflow-task:result-only-child";
		const childStart = events.find(
			(event) => event.type === "tool_start" && event.toolId === childToolId,
		);
		expect(childStart).toMatchObject({
			type: "tool_start",
			providerFrame: {
				providerSessionId: "native-result-only-child",
				providerUuid: "result-only-frame",
			},
		});
		const retractionIndex = events.findIndex(
			(event) =>
				event.type === "provider_message_retraction" &&
				event.ids.includes("result-only-frame"),
		);
		expect(retractionIndex).toBeGreaterThan(-1);
		expect(
			events
				.slice(retractionIndex + 1)
				.some(
					(event) =>
						(event.type === "tool_start" || event.type === "tool_update") &&
						event.toolId === childToolId,
				),
		).toBe(false);
	});

	it.each([
		{
			name: "older result first",
			retractionOrder: ["ordered-result-a", "ordered-result-b"],
			survivingRun: "run-b",
		},
		{
			name: "newer result first",
			retractionOrder: ["ordered-result-b", "ordered-result-a"],
			survivingRun: "run-a",
		},
	])("reconstructs tracker result state when retracting $name", async ({
		retractionOrder,
		survivingRun,
	}) => {
		const statePath = (runId: string) => `/tmp/workflows/${runId}.json`;
		const workflowProgressReader = vi.fn(
			async (_runtimeCwd: string, providerPath: string) => {
				const runId = providerPath.includes("run-a") ? "run-a" : "run-b";
				return {
					workflowProgress: [
						{
							type: "workflow_agent",
							agentId: "ordered-child",
							state: "running",
							phaseTitle: runId,
							lastToolName: `${runId}-${workflowProgressReader.mock.calls.length}`,
						},
					],
				};
			},
		);
		const resultMessage = (uuid: string, runId: string) => ({
			type: "user",
			uuid,
			session_id: "native-ordered-results",
			parent_tool_use_id: null,
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "ordered-workflow-tool",
						content: {
							status: "async_launched",
							taskId: "ordered-workflow-task",
							taskType: "local_workflow",
							runId,
							scriptPath: `/tmp/workflows/scripts/${runId}.js`,
						},
					},
					{
						type: "tool_result",
						tool_use_id: "ordered-task-tool",
						content: {
							task: {
								id: "ordered-task",
								subject: `Task from ${runId}`,
								status: "in_progress",
							},
						},
					},
				],
			},
		});
		const retractionNotice = (providerUuid: string, index: number) => ({
			type: "system",
			subtype: "model_refusal_fallback",
			session_id: "native-ordered-results",
			uuid: `ordered-fallback-${index}`,
			trigger: "refusal",
			direction: "retry",
			original_model: "claude-opus-4-6",
			fallback_model: "claude-sonnet-4-6",
			request_id: `ordered-request-${index}`,
			retracted_message_uuids: [providerUuid],
			content: "",
		});
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "assistant",
					uuid: "ordered-start-frame",
					session_id: "native-ordered-results",
					parent_tool_use_id: null,
					message: {
						model: "claude-opus-4-6",
						usage: { input_tokens: 1, output_tokens: 1 },
						content: [
							{
								type: "tool_use",
								id: "ordered-workflow-tool",
								name: "Workflow",
								input: { name: "ordered-workflow" },
							},
							{
								type: "tool_use",
								id: "ordered-task-tool",
								name: "TaskCreate",
								input: { subject: "Ordered task" },
							},
						],
					},
				},
				{
					type: "system",
					subtype: "task_started",
					session_id: "native-ordered-results",
					uuid: "ordered-task-started",
					task_id: "ordered-workflow-task",
					tool_use_id: "ordered-workflow-tool",
					task_type: "local_workflow",
				},
				resultMessage("ordered-result-a", "run-a"),
				resultMessage("ordered-result-b", "run-b"),
				retractionNotice(retractionOrder[0] ?? "", 1),
				{
					type: "system",
					subtype: "task_progress",
					session_id: "native-ordered-results",
					uuid: "ordered-progress-1",
					task_id: "ordered-workflow-task",
					description: "After first retraction",
				},
				retractionNotice(retractionOrder[1] ?? "", 2),
				{
					type: "system",
					subtype: "task_progress",
					session_id: "native-ordered-results",
					uuid: "ordered-progress-2",
					task_id: "ordered-workflow-task",
					description: "After both retractions",
				},
				{
					type: "user",
					uuid: "ordered-result-c",
					session_id: "native-ordered-results",
					parent_tool_use_id: null,
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: "ordered-task-tool",
								content: {
									task: {
										id: "ordered-task",
										subject: "Replacement task result",
										status: "completed",
									},
								},
							},
						],
					},
				},
			]),
		);

		const events = await collectEvents(baseParams(), {
			workflowProgressReader,
		});
		expect(
			workflowProgressReader.mock.calls.map(([, providerPath]) => providerPath),
		).toEqual([
			statePath("run-a"),
			statePath("run-b"),
			statePath(survivingRun),
		]);
		const firstRetraction = events.findIndex(
			(event) =>
				event.type === "provider_message_retraction" &&
				event.ids.includes(retractionOrder[0] ?? ""),
		);
		const secondRetraction = events.findIndex(
			(event) =>
				event.type === "provider_message_retraction" &&
				event.ids.includes(retractionOrder[1] ?? ""),
		);
		const updateAfterFirst = events
			.slice(firstRetraction + 1, secondRetraction)
			.find(
				(event) =>
					event.type === "tool_update" &&
					event.toolId === "ordered-workflow-tool",
			);
		expect(updateAfterFirst).toMatchObject({
			type: "tool_update",
			subagent: { workflowRunId: survivingRun },
		});
		const updateAfterBoth = events
			.slice(secondRetraction + 1)
			.find(
				(event) =>
					event.type === "tool_update" &&
					event.toolId === "ordered-workflow-tool",
			);
		expect(updateAfterBoth).toBeDefined();
		if (updateAfterBoth?.type === "tool_update") {
			expect(updateAfterBoth.subagent.workflowRunId).toBeUndefined();
		}
		expect(
			events
				.slice(secondRetraction + 1)
				.some(
					(event) =>
						event.type === "tool_activity_update" &&
						event.toolId === "ordered-task-tool",
				),
		).toBe(true);
	});

	it("emits supersedes from an ignored late child without exposing its content", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "assistant",
					uuid: "root-tool-frame",
					session_id: "native-ignored-child",
					parent_tool_use_id: null,
					message: {
						model: "claude-sonnet-4-6",
						usage: { input_tokens: 1, output_tokens: 1 },
						content: [
							{
								type: "tool_use",
								id: "finished-parent-tool",
								name: "Agent",
								input: { prompt: "finish before child replay" },
							},
						],
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
				{
					type: "assistant",
					uuid: "ignored-child-frame",
					session_id: "native-ignored-child",
					parent_tool_use_id: "finished-parent-tool",
					supersedes: ["refused-child-frame"],
					message: {
						model: "claude-sonnet-4-6",
						usage: { input_tokens: 20, output_tokens: 10 },
						content: [
							{ type: "text", text: "must stay hidden" },
							{
								type: "tool_use",
								id: "ignored-nested-tool",
								name: "Agent",
								input: { prompt: "must not resurrect" },
							},
						],
					},
				},
				{
					type: "system",
					subtype: "task_started",
					task_id: "ignored-nested-task",
					tool_use_id: "ignored-nested-tool",
					task_type: "subagent",
				},
			]),
		);

		const events = await collectEvents(baseParams());
		expect(events).toContainEqual({
			type: "provider_message_retraction",
			ids: ["refused-child-frame"],
			providerSessionId: "native-ignored-child",
			source: "assistant_supersedes",
		});
		expect(
			events.some(
				(event) =>
					(event.type === "provider_message_frame" &&
						event.id === "ignored-child-frame") ||
					(event.type === "text_delta" && event.text === "must stay hidden"),
			),
		).toBe(false);
		expect(
			events.some(
				(event) =>
					(event.type === "tool_start" || event.type === "tool_update") &&
					event.toolId === "ignored-nested-tool",
			),
		).toBe(false);
	});

	it("accepts child lineage when a replacement reuses a retracted tool id", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "assistant",
					uuid: "old-reused-tool-frame",
					session_id: "native-reused-tool",
					parent_tool_use_id: null,
					message: {
						model: "claude-opus-4-6",
						usage: { input_tokens: 1, output_tokens: 1 },
						content: [
							{
								type: "tool_use",
								id: "reused-agent-tool",
								name: "Agent",
								input: { prompt: "old refused work" },
							},
						],
					},
				},
				{
					type: "system",
					subtype: "model_refusal_fallback",
					session_id: "native-reused-tool",
					uuid: "fallback-notice",
					trigger: "refusal",
					direction: "retry",
					original_model: "claude-opus-4-6",
					fallback_model: "claude-sonnet-4-6",
					request_id: "request-reused-tool",
					retracted_message_uuids: ["old-reused-tool-frame"],
					content: "",
				},
				{
					type: "assistant",
					uuid: "replacement-reused-tool-frame",
					session_id: "native-reused-tool",
					parent_tool_use_id: null,
					message: {
						model: "claude-sonnet-4-6",
						usage: { input_tokens: 2, output_tokens: 2 },
						content: [
							{
								type: "tool_use",
								id: "reused-agent-tool",
								name: "Agent",
								input: { prompt: "replacement work" },
							},
						],
					},
				},
				{
					type: "system",
					subtype: "task_started",
					task_id: "replacement-task",
					tool_use_id: "reused-agent-tool",
					task_type: "subagent",
				},
				{
					type: "assistant",
					uuid: "replacement-child-frame",
					session_id: "native-reused-tool",
					parent_tool_use_id: "reused-agent-tool",
					message: {
						model: "claude-sonnet-4-6",
						usage: { input_tokens: 3, output_tokens: 2 },
						content: [{ type: "text", text: "replacement child output" }],
					},
				},
			]),
		);

		const events = await collectEvents(baseParams());
		expect(events).toContainEqual({
			type: "text_delta",
			text: "replacement child output",
			providerFrame: {
				providerSessionId: "native-reused-tool",
				providerUuid: "replacement-child-frame",
			},
		});
		expect(
			events.find(
				(event) =>
					event.type === "tool_update" &&
					event.subagent.agentId === "replacement-task",
			),
		).toMatchObject({
			type: "tool_update",
			toolId: "reused-agent-tool",
			providerFrame: {
				providerSessionId: "native-reused-tool",
				providerUuid: "replacement-reused-tool-frame",
			},
		});
	});

	it("accounts late child usage from a retracted leg without exposing content", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "assistant",
					uuid: "accounted-parent-frame",
					session_id: "native-accounted-refusal",
					parent_tool_use_id: null,
					message: {
						id: "root-api-message",
						model: "claude-opus-4-6",
						usage: { input_tokens: 10, output_tokens: 5 },
						content: [
							{
								type: "tool_use",
								id: "accounted-parent-tool",
								name: "Agent",
								input: { prompt: "refused child work" },
							},
						],
					},
				},
				{
					type: "system",
					subtype: "model_refusal_fallback",
					session_id: "native-accounted-refusal",
					uuid: "fallback-notice",
					trigger: "refusal",
					direction: "retry",
					original_model: "claude-opus-4-6",
					fallback_model: "claude-sonnet-4-6",
					request_id: "request-accounted-refusal",
					retracted_message_uuids: ["accounted-parent-frame"],
					content: "",
				},
				{
					type: "assistant",
					uuid: "accounted-child-frame",
					session_id: "native-accounted-refusal",
					parent_tool_use_id: "accounted-parent-tool",
					message: {
						id: "child-api-message",
						model: "claude-opus-4-6",
						usage: { input_tokens: 2, output_tokens: 3 },
						content: [{ type: "text", text: "refused child content" }],
					},
				},
				{
					type: "result",
					subtype: "success",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 10,
					usage: { input_tokens: 10, output_tokens: 5 },
				},
			]),
		);

		const events = await collectEvents(baseParams());
		expect(
			events.some(
				(event) =>
					event.type === "text_delta" && event.text === "refused child content",
			),
		).toBe(false);
		expect(events.find((event) => event.type === "done")).toMatchObject({
			usage: { inputTokens: 12, outputTokens: 8 },
		});
	});

	it("keeps long Obsidian inputs separate from the returned path", async () => {
		const content = "x".repeat(2_000);
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "assistant",
					message: {
						content: [
							{
								type: "tool_use",
								id: "obsidian-long-1",
								name: "mcp__hlid_obsidian__append_note",
								input: {
									target: "path",
									path: "Projects/Hlid.md",
									content,
								},
							},
						],
						usage: { input_tokens: 10, output_tokens: 5 },
					},
				},
				{
					type: "user",
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: "obsidian-long-1",
								content: '{"path":"Projects/Hlid.md"}',
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
					usage: { input_tokens: 10, output_tokens: 5 },
				},
			]),
		);

		const events = await collectEvents(baseParams());
		expect(events).toContainEqual({
			type: "tool_start",
			toolId: "obsidian-long-1",
			name: "mcp__hlid_obsidian__append_note",
			input: {
				target: "path",
				path: "Projects/Hlid.md",
				content,
			},
		});
		expect(events).toContainEqual({
			type: "tool_result",
			toolId: "obsidian-long-1",
			content: '{"path":"Projects/Hlid.md"}',
		});
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

	it("reconciles cumulative whole-query modelUsage into per-model turn deltas", async () => {
		const modelUsage = (values: {
			inputTokens: number;
			outputTokens: number;
			cacheReadInputTokens: number;
			cacheCreationInputTokens: number;
			webSearchRequests: number;
			costUSD: number;
			contextWindow: number;
			maxOutputTokens: number;
			canonicalModel: string;
			provider: string;
		}) => values;
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "assistant",
					parent_tool_use_id: null,
					message: {
						id: "turn-1-root",
						model: "claude-opus-alias",
						content: [],
						usage: { input_tokens: 10, output_tokens: 4 },
					},
				},
				{
					type: "result",
					subtype: "success",
					total_cost_usd: 0.3,
					num_turns: 1,
					duration_ms: 100,
					usage: { input_tokens: 10, output_tokens: 4 },
					modelUsage: {
						"claude-opus-alias": modelUsage({
							inputTokens: 100,
							outputTokens: 30,
							cacheReadInputTokens: 40,
							cacheCreationInputTokens: 10,
							webSearchRequests: 2,
							costUSD: 0.25,
							contextWindow: 200_000,
							maxOutputTokens: 64_000,
							canonicalModel: "claude-opus-4-6",
							provider: "firstParty",
						}),
						"claude-haiku-alias": modelUsage({
							inputTokens: 20,
							outputTokens: 8,
							cacheReadInputTokens: 5,
							cacheCreationInputTokens: 3,
							webSearchRequests: 0,
							costUSD: 0.05,
							contextWindow: 200_000,
							maxOutputTokens: 8_192,
							canonicalModel: "claude-haiku-4-5",
							provider: "firstParty",
						}),
					},
				},
				{
					type: "assistant",
					parent_tool_use_id: null,
					message: {
						id: "turn-2-root",
						model: "claude-opus-alias",
						content: [],
						usage: { input_tokens: 12, output_tokens: 5 },
					},
				},
				{
					type: "result",
					subtype: "success",
					total_cost_usd: 0.5,
					num_turns: 1,
					duration_ms: 120,
					usage: { input_tokens: 12, output_tokens: 5 },
					modelUsage: {
						"claude-opus-alias": modelUsage({
							inputTokens: 140,
							outputTokens: 42,
							cacheReadInputTokens: 60,
							cacheCreationInputTokens: 14,
							webSearchRequests: 3,
							costUSD: 0.42,
							contextWindow: 200_000,
							maxOutputTokens: 64_000,
							canonicalModel: "claude-opus-4-6",
							provider: "firstParty",
						}),
						"claude-haiku-alias": modelUsage({
							inputTokens: 25,
							outputTokens: 10,
							cacheReadInputTokens: 7,
							cacheCreationInputTokens: 3,
							webSearchRequests: 0,
							costUSD: 0.08,
							contextWindow: 200_000,
							maxOutputTokens: 8_192,
							canonicalModel: "claude-haiku-4-5",
							provider: "firstParty",
						}),
					},
				},
			]),
		);

		const session = new ClaudeProvider().query(baseParams());
		await session.send("first turn");
		const firstTurn: AgentEvent[] = [];
		for await (const event of session) {
			firstTurn.push(event);
			if (event.type === "done") break;
		}
		await session.send("second turn");
		const secondTurn: AgentEvent[] = [];
		for await (const event of session) {
			secondTurn.push(event);
			if (event.type === "done") break;
		}

		expect(firstTurn.find((event) => event.type === "usage")).toMatchObject({
			inputTokens: 10,
			outputTokens: 4,
		});
		expect(firstTurn.find((event) => event.type === "done")).toMatchObject({
			usage: {
				inputTokens: 120,
				outputTokens: 38,
				cacheReadTokens: 45,
				cacheCreationTokens: 13,
			},
			modelUsage: {
				"claude-opus-alias": expect.objectContaining({
					inputTokens: 100,
					canonicalModel: "claude-opus-4-6",
					provider: "firstParty",
				}),
			},
		});
		expect(secondTurn.find((event) => event.type === "usage")).toMatchObject({
			inputTokens: 12,
			outputTokens: 5,
		});
		expect(secondTurn.find((event) => event.type === "done")).toMatchObject({
			usage: {
				inputTokens: 45,
				outputTokens: 14,
				cacheReadTokens: 22,
				cacheCreationTokens: 4,
			},
			modelUsage: {
				"claude-opus-alias": expect.objectContaining({
					inputTokens: 40,
					outputTokens: 12,
					costUSD: expect.closeTo(0.17, 10),
				}),
				"claude-haiku-alias": expect.objectContaining({
					inputTokens: 5,
					outputTokens: 2,
					costUSD: expect.closeTo(0.03, 10),
				}),
			},
		});
		session.cancel();
	});

	it("resets cumulative usage and cost baselines after a conversation reset", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "system",
					subtype: "init",
					session_id: "native-before-clear",
					tools: [],
				},
				{
					type: "result",
					subtype: "success",
					session_id: "native-before-clear",
					total_cost_usd: 0.3,
					num_turns: 1,
					duration_ms: 100,
					usage: { input_tokens: 10, output_tokens: 4 },
					modelUsage: {
						"claude-opus-alias": {
							inputTokens: 100,
							outputTokens: 30,
							cacheReadInputTokens: 40,
							cacheCreationInputTokens: 10,
							webSearchRequests: 2,
							costUSD: 0.3,
							contextWindow: 200_000,
							maxOutputTokens: 64_000,
						},
					},
				},
				{
					type: "conversation_reset",
					new_conversation_id: "native-after-clear",
					uuid: "clear-reset",
					session_id: "native-before-clear",
				},
				{
					type: "result",
					subtype: "success",
					session_id: "native-after-clear",
					total_cost_usd: 0.5,
					num_turns: 1,
					duration_ms: 120,
					usage: { input_tokens: 12, output_tokens: 5 },
					modelUsage: {
						"claude-opus-alias": {
							inputTokens: 140,
							outputTokens: 42,
							cacheReadInputTokens: 60,
							cacheCreationInputTokens: 14,
							webSearchRequests: 3,
							costUSD: 0.5,
							contextWindow: 200_000,
							maxOutputTokens: 64_000,
						},
					},
				},
			]),
		);

		const session = new ClaudeProvider().query(baseParams());
		await session.send("before clear");
		const firstTurn: AgentEvent[] = [];
		for await (const event of session) {
			firstTurn.push(event);
			if (event.type === "done") break;
		}
		await session.send("after clear");
		const secondTurn: AgentEvent[] = [];
		for await (const event of session) {
			secondTurn.push(event);
			if (event.type === "done") break;
		}

		expect(firstTurn.find((event) => event.type === "done")).toMatchObject({
			estimatedCost: 0.3,
			usage: { inputTokens: 100, outputTokens: 30 },
		});
		expect(secondTurn).toContainEqual({
			type: "provider_context_reset",
			sessionId: "native-after-clear",
		});
		expect(secondTurn.find((event) => event.type === "done")).toMatchObject({
			estimatedCost: 0.5,
			usage: {
				inputTokens: 140,
				outputTokens: 42,
				cacheReadTokens: 60,
				cacheCreationTokens: 14,
			},
			modelUsage: {
				"claude-opus-alias": expect.objectContaining({
					inputTokens: 140,
					outputTokens: 42,
					costUSD: 0.5,
				}),
			},
		});
		session.cancel();
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

	it("keeps a workflow notification continuation inside one visible turn", async () => {
		vi.useFakeTimers();
		try {
			let releaseContinuation = () => {};
			let signalWaiting = () => {};
			const continuation = new Promise<void>((resolve) => {
				releaseContinuation = resolve;
			});
			const waiting = new Promise<void>((resolve) => {
				signalWaiting = resolve;
			});
			vi.mocked(query).mockReturnValueOnce(
				sdkStream(async function* () {
					yield {
						type: "assistant",
						parent_tool_use_id: null,
						message: {
							id: "msg-workflow-root",
							model: "claude-opus-5",
							content: [
								{
									type: "tool_use",
									id: "workflow-tool-live",
									name: "Workflow",
									input: { name: "live-smoke" },
								},
							],
							usage: { input_tokens: 10, output_tokens: 5 },
						},
					};
					yield {
						type: "system",
						subtype: "task_started",
						task_id: "workflow-task-live",
						tool_use_id: "workflow-tool-live",
						task_type: "local_workflow",
						workflow_name: "live-smoke",
						description: "Running workflow",
					};
					yield {
						type: "user",
						tool_use_result: {
							status: "async_launched",
							taskId: "workflow-task-live",
							taskType: "local_workflow",
							runId: "workflow-run-live",
							scriptPath:
								"/tmp/workflow/scripts/live-smoke-workflow-run-live.js",
						},
						message: {
							content: [
								{
									type: "tool_result",
									tool_use_id: "workflow-tool-live",
									content: "Workflow launched in background.",
								},
							],
						},
					};
					yield {
						type: "assistant",
						parent_tool_use_id: null,
						message: {
							id: "msg-workflow-root",
							model: "claude-opus-5",
							content: [{ type: "text", text: "Ping you when done." }],
							usage: { input_tokens: 10, output_tokens: 5 },
						},
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
					yield {
						type: "system",
						subtype: "task_notification",
						task_id: "workflow-task-live",
						status: "completed",
						output_file: "/tmp/workflow-result",
						summary: "Workflow completed",
					};
					yield {
						type: "user",
						message: {
							role: "user",
							content:
								"<task-notification><task-id>workflow-task-live</task-id><status>completed</status></task-notification>",
						},
					};
					signalWaiting();
					await continuation;
					yield {
						type: "assistant",
						parent_tool_use_id: null,
						message: {
							id: "msg-workflow-completion",
							model: "claude-opus-5",
							content: [
								{ type: "text", text: "Workflow done. 4 agents, 0 errors." },
							],
							usage: { input_tokens: 20, output_tokens: 8 },
						},
					};
					yield {
						type: "result",
						subtype: "success",
						terminal_reason: "completed",
						total_cost_usd: 0.2,
						num_turns: 1,
						duration_ms: 200,
						usage: { input_tokens: 20, output_tokens: 8 },
					};
				}),
			);

			const collected = collectEvents(baseParams(), {
				workflowProgressReader: async () => null,
			});
			await waiting;
			// The live failure emitted Hlid done after 250ms, before Claude's
			// notification-driven assistant response began.
			await vi.advanceTimersByTimeAsync(1_000);
			releaseContinuation();
			const events = await collected;
			const doneEvents = events.filter((event) => event.type === "done");
			expect(doneEvents).toHaveLength(1);
			expect(doneEvents[0]).toMatchObject({
				turns: 2,
				durationMs: 300,
				usage: { inputTokens: 30, outputTokens: 13 },
			});
			expect(
				doneEvents[0]?.type === "done"
					? doneEvents[0].estimatedCost
					: undefined,
			).toBeCloseTo(0.2);
			const completionTextIndex = events.findIndex(
				(event) =>
					event.type === "text_delta" &&
					event.text.includes("Workflow done. 4 agents"),
			);
			const doneIndex = events.findIndex((event) => event.type === "done");
			expect(completionTextIndex).toBeGreaterThan(-1);
			expect(doneIndex).toBeGreaterThan(completionTextIndex);
		} finally {
			vi.useRealTimers();
		}
	});

	it("retains an earlier terminal failure across grouped workflow results", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "assistant",
					parent_tool_use_id: null,
					message: {
						id: "msg-workflow-failed-root",
						model: "claude-opus-5",
						content: [
							{
								type: "tool_use",
								id: "workflow-tool-failed-root",
								name: "Workflow",
								input: { name: "failure-smoke" },
							},
						],
						usage: { input_tokens: 10, output_tokens: 5 },
					},
				},
				{
					type: "system",
					subtype: "task_started",
					task_id: "workflow-task-failed-root",
					tool_use_id: "workflow-tool-failed-root",
					task_type: "local_workflow",
					workflow_name: "failure-smoke",
					description: "Running failure smoke",
				},
				{
					type: "user",
					tool_use_result: {
						status: "async_launched",
						taskId: "workflow-task-failed-root",
						taskType: "local_workflow",
						runId: "workflow-run-failed-root",
						scriptPath:
							"/tmp/workflow/scripts/failure-smoke-workflow-run-failed-root.js",
					},
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: "workflow-tool-failed-root",
								content: "Workflow launched in background.",
							},
						],
					},
				},
				{
					type: "result",
					subtype: "error_during_execution",
					is_error: true,
					errors: ["root failed while workflow remained active"],
					total_cost_usd: 0.1,
					num_turns: 1,
					duration_ms: 100,
					usage: { input_tokens: 10, output_tokens: 5 },
					modelUsage: {},
					permission_denials: [],
				},
				{
					type: "system",
					subtype: "task_notification",
					task_id: "workflow-task-failed-root",
					status: "completed",
					output_file: "/tmp/workflow-failed-root-result",
					summary: "Workflow completed after root failure",
				},
				{
					type: "user",
					message: {
						role: "user",
						content:
							"<task-notification><task-id>workflow-task-failed-root</task-id><status>completed</status></task-notification>",
					},
				},
				{
					type: "assistant",
					parent_tool_use_id: null,
					message: {
						id: "msg-workflow-failed-continuation",
						model: "claude-opus-5",
						content: [{ type: "text", text: "Workflow still completed." }],
						usage: { input_tokens: 20, output_tokens: 8 },
					},
				},
				{
					type: "result",
					subtype: "success",
					terminal_reason: "completed",
					total_cost_usd: 0.2,
					num_turns: 1,
					duration_ms: 200,
					usage: { input_tokens: 20, output_tokens: 8 },
				},
			]),
		);

		const events = await collectEvents(baseParams(), {
			workflowProgressReader: async () => null,
		});
		const doneEvents = events.filter((event) => event.type === "done");
		expect(doneEvents).toHaveLength(1);
		expect(doneEvents[0]).toMatchObject({
			turns: 2,
			durationMs: 300,
			estimatedCost: 0.2,
			usage: { inputTokens: 30, outputTokens: 13 },
			terminalFailure: {
				code: "error_during_execution",
				details: ["root failed while workflow remained active"],
			},
		});
	});

	it("closes a stopped workflow turn without waiting for a completion continuation", async () => {
		vi.useFakeTimers();
		let releaseStream = () => {};
		try {
			let signalWaiting = () => {};
			const waiting = new Promise<void>((resolve) => {
				signalWaiting = resolve;
			});
			const held = new Promise<void>((resolve) => {
				releaseStream = resolve;
			});
			vi.mocked(query).mockReturnValueOnce(
				sdkStream(async function* () {
					yield {
						type: "assistant",
						parent_tool_use_id: null,
						message: {
							id: "msg-workflow-stop-root",
							model: "claude-opus-5",
							content: [
								{
									type: "tool_use",
									id: "workflow-tool-stop-turn",
									name: "Workflow",
									input: { name: "stop-turn-smoke" },
								},
							],
							usage: { input_tokens: 4, output_tokens: 2 },
						},
					};
					yield {
						type: "system",
						subtype: "task_started",
						task_id: "workflow-task-stop-turn",
						tool_use_id: "workflow-tool-stop-turn",
						task_type: "local_workflow",
						workflow_name: "stop-turn-smoke",
						description: "Running stop-turn smoke",
					};
					yield {
						type: "user",
						tool_use_result: {
							status: "async_launched",
							taskId: "workflow-task-stop-turn",
							taskType: "local_workflow",
							runId: "workflow-run-stop-turn",
							scriptPath:
								"/tmp/workflow/scripts/stop-turn-workflow-run-stop-turn.js",
						},
						message: {
							content: [
								{
									type: "tool_result",
									tool_use_id: "workflow-tool-stop-turn",
									content: "Workflow launched in background.",
								},
							],
						},
					};
					yield {
						type: "assistant",
						parent_tool_use_id: null,
						message: {
							id: "msg-workflow-stop-root",
							model: "claude-opus-5",
							content: [{ type: "text", text: "Workflow is running." }],
							usage: { input_tokens: 4, output_tokens: 2 },
						},
					};
					yield {
						type: "result",
						subtype: "success",
						terminal_reason: "background_requested",
						total_cost_usd: 0,
						num_turns: 1,
						duration_ms: 10,
						usage: { input_tokens: 4, output_tokens: 2 },
					};
					yield {
						type: "system",
						subtype: "task_notification",
						task_id: "workflow-task-stop-turn",
						status: "stopped",
						summary: "Stopped by user",
					};
					signalWaiting();
					await held;
				}),
			);

			const session = new ClaudeProvider({
				workflowProgressReader: async () => null,
			}).query(baseParams());
			const iterator = session[Symbol.asyncIterator]();
			let doneEvent: AgentEvent | undefined;
			const consumeUntilDone = (async () => {
				while (true) {
					const next = await iterator.next();
					if (next.done || next.value.type === "done") return next.value;
				}
			})();
			void consumeUntilDone.then((event) => {
				doneEvent = event;
			});

			await waiting;
			await vi.advanceTimersByTimeAsync(1_000);
			expect(doneEvent?.type).toBe("done");

			releaseStream();
			await iterator.next();
		} finally {
			releaseStream();
			vi.useRealTimers();
		}
	});

	it("waits for a delayed workflow continuation after only a terminal task update", async () => {
		vi.useFakeTimers();
		try {
			let releaseContinuation = () => {};
			let signalWaiting = () => {};
			const continuation = new Promise<void>((resolve) => {
				releaseContinuation = resolve;
			});
			const waiting = new Promise<void>((resolve) => {
				signalWaiting = resolve;
			});
			vi.mocked(query).mockReturnValueOnce(
				sdkStream(async function* () {
					yield {
						type: "assistant",
						parent_tool_use_id: null,
						message: {
							id: "msg-workflow-delayed-root",
							model: "claude-opus-5",
							content: [
								{
									type: "tool_use",
									id: "workflow-tool-delayed",
									name: "Workflow",
									input: { name: "delayed-smoke" },
								},
							],
							usage: { input_tokens: 8, output_tokens: 4 },
						},
					};
					yield {
						type: "system",
						subtype: "task_started",
						task_id: "workflow-task-delayed",
						tool_use_id: "workflow-tool-delayed",
						task_type: "local_workflow",
						workflow_name: "delayed-smoke",
						description: "Running delayed workflow",
					};
					yield {
						type: "user",
						tool_use_result: {
							status: "async_launched",
							taskId: "workflow-task-delayed",
							taskType: "local_workflow",
							runId: "workflow-run-delayed",
							scriptPath:
								"/tmp/workflow/scripts/delayed-workflow-run-delayed.js",
						},
						message: {
							content: [
								{
									type: "tool_result",
									tool_use_id: "workflow-tool-delayed",
									content: "Workflow launched in background.",
								},
							],
						},
					};
					yield {
						type: "assistant",
						parent_tool_use_id: null,
						message: {
							id: "msg-workflow-delayed-root",
							model: "claude-opus-5",
							content: [{ type: "text", text: "Waiting for workflow." }],
							usage: { input_tokens: 8, output_tokens: 4 },
						},
					};
					yield {
						type: "result",
						subtype: "success",
						terminal_reason: "background_requested",
						total_cost_usd: 0.1,
						num_turns: 1,
						duration_ms: 100,
						usage: { input_tokens: 8, output_tokens: 4 },
					};
					yield {
						type: "system",
						subtype: "task_updated",
						task_id: "workflow-task-delayed",
						patch: { status: "completed" },
					};
					signalWaiting();
					await continuation;
					yield {
						type: "assistant",
						parent_tool_use_id: null,
						message: {
							id: "msg-workflow-delayed-completion",
							model: "claude-opus-5",
							content: [{ type: "text", text: "Delayed workflow done." }],
							usage: { input_tokens: 16, output_tokens: 7 },
						},
					};
					yield {
						type: "result",
						subtype: "success",
						terminal_reason: "completed",
						total_cost_usd: 0.2,
						num_turns: 1,
						duration_ms: 200,
						usage: { input_tokens: 16, output_tokens: 7 },
					};
				}),
			);

			const collected = collectEvents(baseParams(), {
				workflowProgressReader: async () => null,
			});
			await waiting;
			// The native completion turn can take longer than the old five-second
			// grace before producing its first SDK assistant message.
			await vi.advanceTimersByTimeAsync(10_000);
			releaseContinuation();
			const events = await collected;
			const doneEvents = events.filter((event) => event.type === "done");
			expect(doneEvents).toHaveLength(1);
			expect(doneEvents[0]).toMatchObject({
				turns: 2,
				durationMs: 300,
				usage: { inputTokens: 24, outputTokens: 11 },
			});
			expect(
				events.find(
					(event) =>
						event.type === "text_delta" &&
						event.text === "Delayed workflow done.",
				),
			).toBeDefined();
		} finally {
			vi.useRealTimers();
		}
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

	it("normalizes a rejected organization spend cap to spend_control", async () => {
		const overageResetsAt = 1_786_216_200;
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "rate_limit_event",
					rate_limit_info: {
						status: "rejected",
						resetsAt: overageResetsAt,
						overageResetsAt,
						overageDisabledReason: "org_level_disabled_until",
						isUsingOverage: false,
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
		expect(events.filter((event) => event.type === "rate_limit")).toEqual([
			{
				type: "rate_limit",
				status: "rejected",
				rateLimitType: "spend_control",
				resetsAt: overageResetsAt,
			},
		]);
	});

	it("uses the rejected rolling window when a spend cap only disables overage", async () => {
		const usageResetsAt = 1_786_200_000;
		const overageResetsAt = 1_786_216_200;
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "rate_limit_event",
					rate_limit_info: {
						status: "rejected",
						rateLimitType: "five_hour",
						utilization: 100,
						resetsAt: usageResetsAt,
						overageStatus: "rejected",
						overageResetsAt,
						overageDisabledReason: "org_level_disabled_until",
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
		expect(events.filter((event) => event.type === "rate_limit")).toEqual([
			{
				type: "rate_limit",
				status: "rejected",
				rateLimitType: "five_hour",
				utilization: 1,
				resetsAt: usageResetsAt,
			},
		]);
	});

	it("does not treat an ordinary organization disable as a spend cap", async () => {
		const usageResetsAt = 1_786_200_000;
		const overageResetsAt = 1_786_216_200;
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "rate_limit_event",
					rate_limit_info: {
						status: "allowed_warning",
						rateLimitType: "five_hour",
						utilization: 73,
						resetsAt: usageResetsAt,
						overageStatus: "rejected",
						overageResetsAt,
						overageDisabledReason: "org_level_disabled",
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
		expect(events.filter((event) => event.type === "rate_limit")).toEqual([
			{
				type: "rate_limit",
				status: "allowed_warning",
				rateLimitType: "five_hour",
				utilization: 0.73,
				resetsAt: usageResetsAt,
			},
		]);
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

	it("yields a server-owned fallback from result.result", async () => {
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
		const textEvents = events.filter((e) => e.type === "result_text_fallback");
		expect(textEvents).toEqual([
			{ type: "result_text_fallback", text: "Slash command output" },
		]);
	});

	it("leaves result fallback visibility to the server when prior text was emitted", async () => {
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
		expect(events).toContainEqual({
			type: "result_text_fallback",
			text: "should not appear",
		});
	});
});

// ── canUseTool pass-through ────────────────────────────────────────────────────

describe("ClaudeProvider — canUseTool pass-through", () => {
	it("registers Claude MCP elicitation and supported host-dialog callbacks", async () => {
		let captured:
			| {
					onElicitation?: unknown;
					onUserDialog?: unknown;
					supportedDialogKinds?: string[];
			  }
			| undefined;
		// biome-ignore lint/suspicious/noExplicitAny: test mock captures SDK options
		const captureInteractions: any = ({
			options,
		}: {
			options?: typeof captured;
		}) => {
			captured = options;
			return sdkGen([
				{
					type: "result",
					subtype: "success",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 1,
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			]);
		};
		vi.mocked(query).mockImplementationOnce(captureInteractions);

		await collectEvents(baseParams());

		expect(captured).toMatchObject({
			onElicitation: expect.any(Function),
			onUserDialog: expect.any(Function),
			supportedDialogKinds: [
				"refusal_fallback_prompt",
				"peer_inbound_approval",
			],
		});
	});

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

	it("retains commands_changed replacements for later probes", async () => {
		const refreshedCommands = [
			{
				name: "refreshed",
				description: "Fresh command snapshot",
				argumentHint: "",
			},
		];
		const gen = sdkGen([
			{
				type: "system",
				subtype: "commands_changed",
				commands: refreshedCommands,
				uuid: "uuid-commands",
				session_id: "sid-abc",
			},
		]);
		gen.supportedCommands = vi.fn().mockResolvedValue([
			{
				name: "stale",
				description: "Initialization snapshot",
				argumentHint: "",
			},
		]);
		vi.mocked(query).mockReturnValueOnce(gen);
		const session = new ClaudeProvider().query(baseParams());

		await expect(session[Symbol.asyncIterator]().next()).resolves.toEqual({
			done: false,
			value: { type: "commands_changed", commands: refreshedCommands },
		});
		await expect(session.supportedCommands?.()).resolves.toEqual(
			refreshedCommands,
		);
		expect(gen.supportedCommands).not.toHaveBeenCalled();
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
		let capturedOptions: Record<string, unknown> | undefined;
		vi.mocked(query).mockImplementationOnce(
			({ options }: { options?: Record<string, unknown> }) => {
				capturedOptions = options;
				return gen;
			},
		);

		await expect(
			new ClaudeProvider().listSkills?.({ cwd: "/work/project" }),
		).resolves.toEqual([{ name: "voice", description: "Apply voice rules" }]);
		expect(gen.supportedCommands).toHaveBeenCalledOnce();
		expect(capturedOptions?.settings).toEqual({
			crossSessionInbound: "refuse",
			dialogExpiry: "never",
		});
	});
});

describe("ClaudeProvider — reloadSkills", () => {
	it("retains the refreshed skill replacement for later session probes", async () => {
		const skills = [
			{
				name: "voice",
				description: "Apply voice rules",
				argumentHint: "",
			},
		];
		const gen = sdkGen([]);
		gen.reloadSkills = vi.fn().mockResolvedValue({ skills });
		gen.supportedCommands = vi.fn().mockResolvedValue([
			{
				name: "removed-skill",
				description: "Stale initialization snapshot",
				argumentHint: "",
			},
		]);
		vi.mocked(query).mockReturnValueOnce(gen);
		const session = new ClaudeProvider().query(baseParams());
		void session[Symbol.asyncIterator]().next();

		await expect(session.reloadSkills?.()).resolves.toEqual(skills);
		await expect(session.supportedCommands?.()).resolves.toEqual(skills);
		expect(gen.reloadSkills).toHaveBeenCalledOnce();
		expect(gen.supportedCommands).not.toHaveBeenCalled();
	});

	it("retains an empty refresh so deleted skills stay removed", async () => {
		const gen = sdkGen([]);
		gen.reloadSkills = vi.fn().mockResolvedValue({ skills: [] });
		gen.supportedCommands = vi.fn().mockResolvedValue([
			{
				name: "removed-skill",
				description: "Stale initialization snapshot",
				argumentHint: "",
			},
		]);
		vi.mocked(query).mockReturnValueOnce(gen);
		const session = new ClaudeProvider().query(baseParams());
		void session[Symbol.asyncIterator]().next();

		await expect(session.reloadSkills?.()).resolves.toEqual([]);
		await expect(session.supportedCommands?.()).resolves.toEqual([]);
		expect(gen.supportedCommands).not.toHaveBeenCalled();
	});

	it("does not start a hidden Query solely to refresh skills", async () => {
		const priorQueryCalls = vi.mocked(query).mock.calls.length;
		const session = new ClaudeProvider().query(baseParams());

		await expect(session.reloadSkills?.()).resolves.toBeNull();
		expect(query).toHaveBeenCalledTimes(priorQueryCalls);
	});
});

describe("ClaudeProvider — file rewind", () => {
	it("delegates dry-run and execute to the live SDK query", async () => {
		const gen = sdkGen([]);
		vi.mocked(query).mockReturnValueOnce(gen);
		const session = new ClaudeProvider().query(baseParams());
		void session[Symbol.asyncIterator]().next();

		await session.rewindFiles?.("checkpoint-user-id", { dryRun: true });
		await session.rewindFiles?.("checkpoint-user-id");

		expect(gen.rewindFiles).toHaveBeenNthCalledWith(1, "checkpoint-user-id", {
			dryRun: true,
		});
		expect(gen.rewindFiles).toHaveBeenNthCalledWith(
			2,
			"checkpoint-user-id",
			undefined,
		);
	});

	it("fails closed before the Claude SDK query is live", async () => {
		const session = new ClaudeProvider().query(baseParams());
		await expect(session.rewindFiles?.("checkpoint-user-id")).rejects.toThrow(
			"Claude session is not active",
		);
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
			cutoff: { kind: "message", id: "sdk-msg-uuid-1" },
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

describe("ClaudeProvider — live MCP configuration", () => {
	it("owns workspace .mcp.json dynamically while preserving native settings sources", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "hlid-claude-mcp-start-"));
		try {
			await writeFile(
				join(cwd, ".mcp.json"),
				JSON.stringify({
					mcpServers: {
						local: { command: "bun", args: ["server.ts"] },
						disabled: { type: "http", url: "https://example.com/mcp" },
					},
				}),
			);
			await mkdir(join(cwd, ".claude"));
			await writeFile(
				join(cwd, ".claude", "settings.local.json"),
				JSON.stringify({ disabledMcpjsonServers: ["disabled"] }),
			);
			let capturedOptions: Record<string, unknown> | undefined;
			vi.mocked(query).mockImplementationOnce(
				({ options }: { options?: Record<string, unknown> }) => {
					capturedOptions = options;
					return sdkGen([]);
				},
			);

			const session = new ClaudeProvider().query(baseParams({ cwd }));
			await session.send("hello");

			expect(capturedOptions?.settingSources).toEqual([
				"user",
				"project",
				"local",
			]);
			expect(capturedOptions?.settings).toEqual({
				crossSessionInbound: "refuse",
				dialogExpiry: "never",
				disabledMcpjsonServers: ["local", "disabled"],
			});
			expect(capturedOptions?.mcpServers).toEqual(
				expect.objectContaining({
					local: { command: "bun", args: ["server.ts"] },
				}),
			);
			expect(
				(capturedOptions?.mcpServers as Record<string, unknown>).disabled,
			).toBeUndefined();
			expect(
				Object.keys(capturedOptions?.mcpServers as Record<string, unknown>),
			).toHaveLength(3);
			session.cancel();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("replaces only the Hlid-managed dynamic subset in a live query", async () => {
		const gen = sdkGen([]);
		gen.setMcpServers = vi.fn().mockResolvedValue({
			added: ["next"],
			removed: ["old"],
			errors: {},
		});
		gen.mcpServerStatus = vi.fn().mockResolvedValue([
			{ name: "next", status: "connected", scope: "dynamic" },
			{ name: "claude.ai Drive", status: "connected", scope: "claudeai" },
		]);
		vi.mocked(query).mockReturnValueOnce(gen);
		const session = new ClaudeProvider().query(baseParams());
		await session.send("hello");

		await expect(
			session.setMcpServers?.([
				{
					name: "next",
					config: { type: "sse", url: "https://example.com/sse" },
					disabled: false,
				},
			]),
		).resolves.toEqual({
			added: ["next"],
			removed: ["old"],
			errors: {},
		});
		const dynamic = gen.setMcpServers.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(dynamic.next).toEqual({
			type: "sse",
			url: "https://example.com/sse",
		});
		expect(Object.keys(dynamic)).toHaveLength(3);
		await expect(session.mcpServerStatus?.()).resolves.toEqual([
			{ name: "claude.ai Drive", status: "connected", scope: "claudeai" },
			{ name: "next", status: "connected", scope: "project" },
		]);
		session.cancel();
	});

	it("defers a cold query without spawning Claude and uses the update on first send", async () => {
		vi.mocked(query).mockClear();
		let capturedOptions: Record<string, unknown> | undefined;
		vi.mocked(query).mockImplementationOnce(
			({ options }: { options?: Record<string, unknown> }) => {
				capturedOptions = options;
				return sdkGen([]);
			},
		);
		const session = new ClaudeProvider().query(baseParams());

		await expect(
			session.setMcpServers?.([
				{
					name: "late",
					config: { command: "bun", args: ["late.ts"] },
					disabled: false,
				},
			]),
		).resolves.toBeNull();
		expect(query).not.toHaveBeenCalled();

		await session.send("hello");
		expect(capturedOptions?.mcpServers).toEqual(
			expect.objectContaining({
				late: { command: "bun", args: ["late.ts"] },
			}),
		);
		expect(capturedOptions?.settings).toEqual({
			crossSessionInbound: "refuse",
			dialogExpiry: "never",
			disabledMcpjsonServers: ["late"],
		});
		session.cancel();
	});

	it("reports disabled and invalid workspace definitions without connecting them", async () => {
		const gen = sdkGen([]);
		gen.setMcpServers = vi.fn().mockResolvedValue({
			added: [],
			removed: [],
			errors: {},
		});
		vi.mocked(query).mockReturnValueOnce(gen);
		const session = new ClaudeProvider().query(baseParams());
		await session.send("hello");
		await session.setMcpServers?.([
			{
				name: "off",
				config: { command: "bun" },
				disabled: true,
			},
			{
				name: "broken",
				config: { type: "http", url: 1 },
				disabled: false,
			},
		]);

		expect(gen.setMcpServers.mock.calls[0]?.[0]).not.toHaveProperty("off");
		expect(gen.setMcpServers.mock.calls[0]?.[0]).not.toHaveProperty("broken");
		await expect(session.mcpServerStatus?.()).resolves.toEqual([
			{ name: "off", status: "disabled", scope: "project" },
			{
				name: "broken",
				status: "failed",
				scope: "project",
				error: "http configuration requires a URL",
			},
		]);
		session.cancel();
	});
});

describe("ClaudeProvider — MCP controls", () => {
	it("delegates reconnect and toggle to the live SDK query", async () => {
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
		vi.mocked(query).mockReturnValueOnce(gen);

		const session = new ClaudeProvider().query(baseParams());
		await session[Symbol.asyncIterator]().next();

		await session.reconnectMcpServer?.("github");
		await session.toggleMcpServer?.("github", false);

		expect(gen.reconnectMcpServer).toHaveBeenCalledWith("github");
		expect(gen.toggleMcpServer).toHaveBeenCalledWith("github", false);
	});

	it("fails closed before the Claude SDK query is live", async () => {
		const session = new ClaudeProvider().query(baseParams());

		await expect(session.reconnectMcpServer?.("github")).rejects.toThrow(
			"Claude session is not active",
		);
		await expect(session.toggleMcpServer?.("github", true)).rejects.toThrow(
			"Claude session is not active",
		);
	});

	it("applies and reports tighten-only per-server permission overrides", async () => {
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
			[{ name: "github", status: "connected", scope: "project" }],
		);
		gen.setMcpPermissionModeOverride = vi
			.fn()
			.mockResolvedValueOnce({ warning: "Stored for github" })
			.mockResolvedValue({});
		vi.mocked(query).mockReturnValueOnce(gen);

		const session = new ClaudeProvider().query(
			baseParams({
				permissionMode: "bypassPermissions",
				policyEnforced: false,
			}),
		);
		await session[Symbol.asyncIterator]().next();

		expect(session.mcpPermissionModeOverrideAvailable).toBe(true);
		await expect(
			session.setMcpPermissionModeOverride?.("github", "default"),
		).resolves.toEqual({ warning: "Stored for github" });
		await expect(session.mcpServerStatus?.()).resolves.toEqual([
			{
				name: "github",
				status: "connected",
				scope: "project",
				permissionModeOverride: "default",
			},
		]);
		await session.setMcpPermissionModeOverride?.("github", "auto");
		await session.setMcpPermissionModeOverride?.("github", null);

		expect(gen.setMcpPermissionModeOverride).toHaveBeenNthCalledWith(
			1,
			"github",
			"default",
		);
		expect(gen.setMcpPermissionModeOverride).toHaveBeenNthCalledWith(
			2,
			"github",
			"auto",
		);
		expect(gen.setMcpPermissionModeOverride).toHaveBeenNthCalledWith(
			3,
			"github",
			null,
		);
		await expect(session.mcpServerStatus?.()).resolves.toEqual([
			{ name: "github", status: "connected", scope: "project" },
		]);
	});

	it("keeps native MCP overrides unavailable under Hlid policy or prompting modes", async () => {
		const policyGen = sdkGen([
			{
				type: "result",
				subtype: "success",
				total_cost_usd: 0,
				num_turns: 1,
				duration_ms: 100,
				usage: { input_tokens: 10, output_tokens: 5 },
			},
		]);
		vi.mocked(query).mockReturnValueOnce(policyGen);
		const policySession = new ClaudeProvider().query(
			baseParams({
				permissionMode: "bypassPermissions",
				policyEnforced: true,
			}),
		);
		await policySession[Symbol.asyncIterator]().next();

		expect(policySession.mcpPermissionModeOverrideAvailable).toBe(false);
		await expect(
			policySession.setMcpPermissionModeOverride?.("github", "default"),
		).rejects.toThrow("Hlid policy enforcement owns MCP approvals");

		const promptGen = sdkGen([
			{
				type: "result",
				subtype: "success",
				total_cost_usd: 0,
				num_turns: 1,
				duration_ms: 100,
				usage: { input_tokens: 10, output_tokens: 5 },
			},
		]);
		vi.mocked(query).mockReturnValueOnce(promptGen);
		const promptSession = new ClaudeProvider().query(baseParams());
		await promptSession[Symbol.asyncIterator]().next();

		expect(promptSession.mcpPermissionModeOverrideAvailable).toBe(false);
		await expect(
			promptSession.setMcpPermissionModeOverride?.("github", "auto"),
		).rejects.toThrow("require Auto or Auto-approve all");
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

// ── setEffort ─────────────────────────────────────────────────────────────────

describe("ClaudeProvider — setEffort", () => {
	beforeEach(() => {
		vi.mocked(query).mockClear();
	});

	it("applies a live direct-Claude effort and retains the active query", async () => {
		let capturedOptions: Record<string, unknown> | undefined;
		const gen = sdkGen([]);
		gen.applyFlagSettings = vi.fn().mockResolvedValue(undefined);
		gen.setModel = vi.fn().mockResolvedValue(undefined);
		vi.mocked(query).mockImplementationOnce(({ options }) => {
			capturedOptions = options as unknown as Record<string, unknown>;
			return gen;
		});
		const requestModel = vi.fn(
			(model: string, effort: string | undefined) => `${model}:${effort}`,
		);
		const session = new ClaudeProvider({ requestModel }).query(
			baseParams({ model: "claude-opus-4-8", effort: "medium" }),
		);

		await session.send("hello");
		expect(capturedOptions?.effort).toBe("medium");
		await session.setEffort?.("xhigh");

		expect(gen.applyFlagSettings).toHaveBeenCalledWith({
			effortLevel: "xhigh",
		});
		expect(query).toHaveBeenCalledTimes(1);
		await session.setModel?.("claude-opus-4-8");
		expect(requestModel).toHaveBeenLastCalledWith("claude-opus-4-8", "xhigh");
		expect(gen.setModel).toHaveBeenCalledWith("claude-opus-4-8:xhigh");
		session.cancel();
	});

	it("updates a cold direct session without spawning and uses it on first send", async () => {
		let capturedOptions: Record<string, unknown> | undefined;
		const gen = sdkGen([]);
		gen.applyFlagSettings = vi.fn().mockResolvedValue(undefined);
		vi.mocked(query).mockImplementationOnce(({ options }) => {
			capturedOptions = options as unknown as Record<string, unknown>;
			return gen;
		});
		const requestModel = vi.fn(
			(model: string, effort: string | undefined) => `${model}:${effort}`,
		);
		const session = new ClaudeProvider({ requestModel }).query(
			baseParams({ model: "claude-sonnet-4-6", effort: "high" }),
		);

		await expect(session.setEffort?.("low")).resolves.toBeUndefined();
		expect(query).not.toHaveBeenCalled();
		await session.send("hello");

		expect(capturedOptions).toMatchObject({
			effort: "low",
			model: "claude-sonnet-4-6:low",
		});
		expect(gen.applyFlagSettings).not.toHaveBeenCalled();
		session.cancel();
	});

	it("keeps the prior effort and active query when live application rejects", async () => {
		const gen = sdkGen([]);
		gen.applyFlagSettings = vi
			.fn()
			.mockRejectedValue(new Error("effort is unavailable for this model"));
		gen.setModel = vi.fn().mockResolvedValue(undefined);
		vi.mocked(query).mockReturnValueOnce(gen);
		const requestModel = vi.fn(
			(model: string, effort: string | undefined) => `${model}:${effort}`,
		);
		const session = new ClaudeProvider({ requestModel }).query(
			baseParams({ model: "claude-sonnet-4-6", effort: "high" }),
		);
		await session.send("hello");

		await expect(session.setEffort?.("max")).rejects.toThrow(
			"effort is unavailable for this model",
		);
		expect(query).toHaveBeenCalledTimes(1);

		await session.setModel?.("claude-sonnet-4-6");
		expect(requestModel).toHaveBeenLastCalledWith("claude-sonnet-4-6", "high");
		expect(gen.setModel).toHaveBeenCalledWith("claude-sonnet-4-6:high");
		session.cancel();
	});

	it("rejects effort levels outside the direct Claude catalog", async () => {
		const session = new ClaudeProvider().query(baseParams());

		await expect(session.setEffort?.("ultra")).rejects.toThrow(
			"Unknown Claude effort level: ultra",
		);
		expect(query).not.toHaveBeenCalled();
		session.cancel();
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
		gen.setPermissionMode.mockClear();

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

	it("orders a cold initialization control before a concurrent external setter", async () => {
		const initialized = deferred<{ models: never[] }>();
		const controls: string[] = [];
		const gen = sdkGen([]);
		gen.initializationResult = vi.fn(() => initialized.promise);
		gen.setPermissionMode = vi.fn(async (mode: string) => {
			controls.push(mode);
		});
		vi.mocked(query).mockReturnValueOnce(gen);
		const session = new ClaudeProvider().query(
			baseParams({ permissionMode: "default" }),
		);

		const sending = session.send("hello");
		const setting = session.setPermissionMode?.("auto");
		expect(controls).toEqual([]);
		initialized.resolve({ models: [] });

		await expect(sending).resolves.toBeUndefined();
		await expect(setting).resolves.toBeUndefined();
		expect(controls).toEqual(["default", "auto"]);
		session.cancel();
	});

	it("keeps the cold initialization mode when the queued external setter rejects", async () => {
		const initialized = deferred<{ models: never[] }>();
		const controls: string[] = [];
		const gen = sdkGen([]);
		gen.initializationResult = vi.fn(() => initialized.promise);
		gen.setPermissionMode = vi.fn(async (mode: string) => {
			controls.push(mode);
			if (mode === "auto") throw new Error("Auto rejected by active settings");
		});
		vi.mocked(query).mockReturnValueOnce(gen);
		const session = new ClaudeProvider().query(
			baseParams({ permissionMode: "default" }),
		);

		const sending = session.send("hello");
		const setting = session.setPermissionMode?.("auto");
		const rejected = expect(setting).rejects.toMatchObject({
			name: "ProviderPermissionModeRejectedError",
			message: "Auto rejected by active settings",
			attempted: "auto",
			authoritative: "default",
		});
		initialized.resolve({ models: [] });

		await expect(sending).resolves.toBeUndefined();
		await rejected;
		expect(controls).toEqual(["default", "auto"]);
		expect(session.mcpPermissionModeOverrideAvailable).toBe(false);
		session.cancel();
	});

	it("ignores queued pre-ACK status and emits one matching post-activity native fallback", async () => {
		const gen = sdkGen([
			{ type: "system", subtype: "init", session_id: "native-auto", tools: [] },
			{
				type: "system",
				subtype: "status",
				session_id: "native-auto",
				permissionMode: "default",
			},
			{
				type: "assistant",
				session_id: "native-auto",
				message: {
					id: "assistant-after-ack",
					content: [{ type: "text", text: "working" }],
					usage: { input_tokens: 2, output_tokens: 1 },
				},
			},
			{
				type: "system",
				subtype: "status",
				session_id: "stale-native",
				permissionMode: "default",
			},
			{
				type: "system",
				subtype: "status",
				session_id: "native-auto",
				permissionMode: "default",
			},
			{
				type: "system",
				subtype: "status",
				session_id: "native-auto",
				permissionMode: "default",
			},
			{
				type: "result",
				subtype: "success",
				session_id: "native-auto",
				total_cost_usd: 0,
				num_turns: 1,
				duration_ms: 100,
				usage: { input_tokens: 2, output_tokens: 1 },
			},
		]);
		vi.mocked(query).mockReturnValueOnce(gen);
		const session = new ClaudeProvider().query(
			baseParams({ permissionMode: "auto", model: "claude-sonnet-5" }),
		);

		await session.send("hello");
		expect(session.mcpPermissionModeOverrideAvailable).toBe(true);
		const events: AgentEvent[] = [];
		for await (const event of session) events.push(event);

		expect(
			events.filter(
				(event) => event.type === "provider_permission_mode_changed",
			),
		).toEqual([
			{
				type: "provider_permission_mode_changed",
				permissionMode: "default",
				providerSessionId: "native-auto",
			},
		]);
		// Native fallback must also update the host-side mode used by later tool guards.
		expect(session.mcpPermissionModeOverrideAvailable).toBe(false);
	});

	it("is a no-op when the SDK query hasn't been created yet", async () => {
		const provider = new ClaudeProvider();
		const session = provider.query(baseParams());
		await expect(
			session.setPermissionMode?.("acceptEdits"),
		).resolves.toBeUndefined();
	});
});

describe("ClaudeProvider — exact Auto validation", () => {
	beforeEach(() => {
		vi.mocked(query).mockClear();
	});

	function validationContext(
		cwd: string,
		overrides: Partial<{
			model: string;
			forceExact: boolean;
		}> = {},
	) {
		return {
			cwd,
			capabilityCwd: cwd,
			model: "claude-sonnet-5",
			policyEnforced: false,
			usageGateEnforced: false,
			...overrides,
		};
	}

	it("accepts an exact model only after Auto succeeds and default is restored", async () => {
		const controls: string[] = [];
		const models: Array<string | undefined> = [];
		const gen = sdkGen([]);
		gen.setModel = vi.fn(async (model?: string) => {
			models.push(model);
		});
		gen.setPermissionMode = vi.fn(async (mode: string) => {
			controls.push(mode);
		});
		vi.mocked(query).mockReturnValueOnce(gen);

		await new ClaudeProvider().validatePermissionMode(
			"auto",
			validationContext("/tmp/auto-probe-success"),
		);

		expect(gen.initializationResult).toHaveBeenCalledOnce();
		expect(models).toEqual(["claude-sonnet-5"]);
		expect(controls).toEqual(["auto", "default"]);
	});

	it("fails closed and negative-caches an exact Auto rejection", async () => {
		const controls: string[] = [];
		const gen = sdkGen([]);
		gen.setPermissionMode = vi.fn(async (mode: string) => {
			controls.push(mode);
			if (mode === "auto") throw new Error("Auto disabled by settings");
		});
		vi.mocked(query).mockReturnValueOnce(gen);
		const provider = new ClaudeProvider();
		const context = validationContext("/tmp/auto-probe-negative-cache");

		await expect(
			provider.validatePermissionMode("auto", context),
		).rejects.toThrow("Auto is unavailable for claude-sonnet-5");
		await expect(
			provider.validatePermissionMode("auto", context),
		).rejects.toThrow("Auto is unavailable for claude-sonnet-5");

		expect(query).toHaveBeenCalledTimes(1);
		expect(controls).toEqual(["auto", "default"]);
	});

	it("positive-caches the exact executable/cwd/model probe identity", async () => {
		const gen = sdkGen([]);
		vi.mocked(query).mockReturnValueOnce(gen);
		const provider = new ClaudeProvider();
		const context = validationContext("/tmp/auto-probe-positive-cache");

		await provider.validatePermissionMode("auto", context);
		await provider.validatePermissionMode("auto", context);

		expect(query).toHaveBeenCalledTimes(1);
		expect(gen.setModel).toHaveBeenCalledTimes(1);
		expect(gen.setPermissionMode).toHaveBeenCalledTimes(2);
	});

	it("forceExact bypasses a warm positive result", async () => {
		const cachedProbe = sdkGen([]);
		const forcedProbe = sdkGen([]);
		vi.mocked(query)
			.mockReturnValueOnce(cachedProbe)
			.mockReturnValueOnce(forcedProbe);
		const provider = new ClaudeProvider();
		const cwd = "/tmp/auto-probe-force-exact";

		await provider.validatePermissionMode("auto", validationContext(cwd));
		await provider.validatePermissionMode(
			"auto",
			validationContext(cwd, { forceExact: true }),
		);

		expect(query).toHaveBeenCalledTimes(2);
		expect(cachedProbe.setModel).toHaveBeenCalledWith("claude-sonnet-5");
		expect(forcedProbe.setModel).toHaveBeenCalledWith("claude-sonnet-5");
	});

	it("uses one overall probe deadline and aborts after initialization consumes part of it", async () => {
		vi.useFakeTimers();
		try {
			let capturedAbortController: AbortController | undefined;
			const gen = sdkGen([]);
			gen.initializationResult = vi.fn(
				() =>
					new Promise<{ models: never[] }>((resolve) => {
						setTimeout(() => resolve({ models: [] }), 6_000);
					}),
			);
			gen.setModel = vi.fn(() => new Promise<void>(() => {}));
			vi.mocked(query).mockImplementationOnce(({ options }) => {
				capturedAbortController = options?.abortController;
				return gen;
			});
			const provider = new ClaudeProvider();
			const promise = provider.validatePermissionMode(
				"auto",
				validationContext("/tmp/auto-probe-overall-timeout"),
			);
			const rejected = expect(promise).rejects.toThrow(
				"Auto is unavailable for claude-sonnet-5",
			);

			await vi.advanceTimersByTimeAsync(5_999);
			expect(gen.setModel).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(4_001);
			await rejected;

			expect(gen.initializationResult).toHaveBeenCalledOnce();
			expect(gen.setModel).toHaveBeenCalledOnce();
			expect(capturedAbortController?.signal.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
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

describe("ClaudeProvider — stopTask", () => {
	it("delegates workflow cancellation to the SDK control request", async () => {
		const gen = sdkGen([]);
		gen.stopTask = vi.fn().mockResolvedValue(undefined);
		vi.mocked(query).mockReturnValueOnce(gen);

		const session = new ClaudeProvider().query(baseParams());
		await session.send("start");
		await session.stopTask?.("workflow-task-1");

		expect(gen.stopTask).toHaveBeenCalledWith("workflow-task-1");
	});

	it("backgrounds the active Claude foreground tasks through the SDK", async () => {
		const gen = sdkGen([]);
		gen.backgroundTasks = vi.fn().mockResolvedValue(true);
		vi.mocked(query).mockReturnValueOnce(gen);

		const session = new ClaudeProvider().query(baseParams());
		await session.send("start");
		await session.controlBackgroundActivity?.({ action: "background" });

		expect(gen.backgroundTasks).toHaveBeenCalledWith();
	});

	it("lists and stops the exact structured Claude background task", async () => {
		const gen = sdkGen([
			{
				type: "assistant",
				uuid: "assistant-1",
				session_id: "sdk-session-1",
				parent_tool_use_id: null,
				message: {
					model: "claude-sonnet-4-6",
					usage: { input_tokens: 1, output_tokens: 1 },
					content: [
						{
							type: "tool_use",
							id: "bash-1",
							name: "Bash",
							input: { command: "sleep 30" },
						},
					],
				},
			},
			{
				type: "user",
				uuid: "user-1",
				session_id: "sdk-session-1",
				parent_tool_use_id: null,
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "bash-1",
							content: "Command running in background",
						},
					],
				},
				tool_use_result: { backgroundTaskId: "task-1" },
			},
		]);
		gen.stopTask = vi.fn().mockResolvedValue(undefined);
		vi.mocked(query).mockReturnValueOnce(gen);

		const session = new ClaudeProvider().query(baseParams());
		const iter = session[Symbol.asyncIterator]();
		await iter.next();
		await iter.next();
		await iter.next();
		await iter.next();
		await iter.next();

		await expect(session.listBackgroundActivities?.()).resolves.toEqual([
			expect.objectContaining({
				providerId: "claude",
				providerSessionId: "sdk-session-1",
				activityId: "task-1",
				kind: "shell",
				command: "sleep 30",
				capabilities: { stop: true },
			}),
		]);
		await session.controlBackgroundActivity?.({
			action: "stop",
			activityId: "task-1",
		});

		expect(gen.stopTask).toHaveBeenCalledWith("task-1");
		await expect(session.listBackgroundActivities?.()).resolves.toEqual([]);
	});

	it("rolls back background activity created only by a retracted result frame", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "system",
					subtype: "background_tasks_changed",
					tasks: [
						{
							task_id: "existing-background-task",
							task_type: "remote_agent",
							description: "Keep this activity",
						},
					],
					uuid: "existing-background-level",
					session_id: "sdk-background-retraction",
				},
				{
					type: "assistant",
					uuid: "background-tool-frame",
					session_id: "sdk-background-retraction",
					parent_tool_use_id: null,
					message: {
						model: "claude-sonnet-4-6",
						usage: { input_tokens: 1, output_tokens: 1 },
						content: [
							{
								type: "tool_use",
								id: "background-tool",
								name: "Bash",
								input: { command: "sleep 30" },
							},
						],
					},
				},
				{
					type: "user",
					uuid: "background-result-frame",
					session_id: "sdk-background-retraction",
					parent_tool_use_id: null,
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: "background-tool",
								content: "Command running in background",
							},
						],
					},
					tool_use_result: { backgroundTaskId: "retracted-background-task" },
				},
				{
					type: "system",
					subtype: "model_refusal_fallback",
					session_id: "sdk-background-retraction",
					uuid: "background-fallback-notice",
					trigger: "refusal",
					direction: "retry",
					original_model: "claude-opus-4-6",
					fallback_model: "claude-sonnet-4-6",
					request_id: "background-request",
					retracted_message_uuids: ["background-result-frame"],
					content: "",
				},
			]),
		);

		const session = new ClaudeProvider().query(baseParams());
		for await (const _event of session) {
			// Drain through the accepted result and its later retraction.
		}

		await expect(session.listBackgroundActivities?.()).resolves.toEqual([
			expect.objectContaining({
				activityId: "existing-background-task",
				description: "Keep this activity",
			}),
		]);
	});

	it("lists a metadata-light task discovered from the authoritative level", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "system",
					subtype: "background_tasks_changed",
					tasks: [
						{
							task_id: "task-level-only",
							task_type: "remote_agent",
							description: "Remote research",
						},
					],
					uuid: "level-1",
					session_id: "sdk-session-level",
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

		const session = new ClaudeProvider().query(baseParams());
		for await (const _event of session) {
			// Drain the level message through the provider session.
		}

		await expect(session.listBackgroundActivities?.()).resolves.toEqual([
			expect.objectContaining({
				providerId: "claude",
				providerSessionId: "sdk-session-level",
				activityId: "task-level-only",
				kind: "workflow",
				description: "Remote research",
				capabilities: { stop: true },
			}),
		]);
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
		expect(capturedOptions).toMatchObject({
			enableFileCheckpointing: true,
			extraArgs: { "replay-user-messages": null },
		});
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
		expect("enableFileCheckpointing" in options).toBe(false);
		expect("extraArgs" in options).toBe(false);
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

	it("preserves the first message origin when a cold resume retries", async () => {
		const prompts: Array<AsyncIterable<unknown>> = [];
		vi.mocked(query).mockImplementation(
			({ prompt }: { prompt: unknown; options?: unknown }) => {
				prompts.push(prompt as AsyncIterable<unknown>);
				if (prompts.length === 1) {
					return sdkStream(async function* () {
						throw new Error("session not found");
						// biome-ignore lint/correctness/noUnreachable: satisfies AsyncGenerator contract
						yield;
					});
				}
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

		const session = new ClaudeProvider().query(
			baseParams({ sessionId: "stale-id" }),
		);
		await session.send("scheduled replay", { inputOrigin: "scheduled-task" });
		const original = await prompts[0]?.[Symbol.asyncIterator]().next();
		for await (const _event of session) {
			// Drain the replacement query.
		}
		const replayed = await prompts[1]?.[Symbol.asyncIterator]().next();

		expect(original?.value).toMatchObject({
			message: {
				content: [{ type: "text", text: "scheduled replay" }],
			},
			origin: {
				kind: "task-notification",
				subkind: "scheduled-trigger",
			},
		});
		expect(replayed?.value).toEqual(original?.value);
		session.cancel();
	});

	it("resets background state before recreating a cold-resume SDK process", async () => {
		const reset = vi.spyOn(ClaudeBackgroundActivityTracker.prototype, "reset");
		const resetCountsAtQuery: number[] = [];
		try {
			vi.mocked(query).mockImplementation(() => {
				resetCountsAtQuery.push(reset.mock.calls.length);
				if (resetCountsAtQuery.length === 1) {
					return sdkStream(async function* () {
						throw new Error("session not found");
						// biome-ignore lint/correctness/noUnreachable: satisfies AsyncGenerator contract
						yield;
					});
				}
				return sdkGen([
					{
						type: "result",
						subtype: "success",
						total_cost_usd: 0,
						num_turns: 1,
						duration_ms: 100,
						usage: { input_tokens: 1, output_tokens: 1 },
					},
				]);
			});

			for await (const _event of new ClaudeProvider().query(
				baseParams({ sessionId: "stale-id" }),
			)) {
				// Drain both the failed resume and its fresh replacement.
			}

			expect(resetCountsAtQuery).toEqual([1, 2]);
		} finally {
			reset.mockRestore();
		}
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

describe("ClaudeProvider — AI subagent progress summaries", () => {
	it("passes the namespaced boolean only to ordinary native Claude queries", async () => {
		const capturedOptions: Array<Record<string, unknown>> = [];
		vi.mocked(query).mockImplementation(
			({ options }: { prompt: unknown; options?: Record<string, unknown> }) => {
				capturedOptions.push(options ?? {});
				return sdkGen([
					{
						type: "result",
						subtype: "success",
						total_cost_usd: 0,
						num_turns: 1,
						duration_ms: 1,
						usage: { input_tokens: 1, output_tokens: 1 },
					},
				]);
			},
		);

		const direct = new ClaudeProvider();
		for (const enabled of [true, false]) {
			for await (const _ of direct.query(
				baseParams({ claude: { agentProgressSummaries: enabled } }),
			)) {
				// Drain the ordinary query.
			}
		}
		for await (const _ of direct.query(baseParams())) {
			// Direct provider calls without Hlid's namespace preserve SDK defaults.
		}

		const cliProxy = new CliProxyCodexProvider({
			base_url: "http://127.0.0.1:8317",
			api_key: "test-key",
		});
		for await (const _ of cliProxy.query(
			baseParams({ claude: { agentProgressSummaries: true } }),
		)) {
			// CLIProxy uses Claude's transport but is not native Claude.
		}

		expect(capturedOptions[0]).toHaveProperty("agentProgressSummaries", true);
		expect(capturedOptions[1]).toHaveProperty("agentProgressSummaries", false);
		expect(capturedOptions[2]).not.toHaveProperty("agentProgressSummaries");
		expect(capturedOptions[3]).not.toHaveProperty("agentProgressSummaries");
	});
});

// ── providerId + proxyConfig ───────────────────────────────────────────────────

describe("ClaudeProvider — providerId + proxyConfig", () => {
	it("removes the Windows loopback proxy from direct WSL Claude launches", async () => {
		const previous = process.env.ANTHROPIC_BASE_URL;
		process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:55884";
		vi.mocked(parseWslUnc).mockReturnValueOnce({
			distro: "Ubuntu-24.04",
			posixPath: "/home/kyle/project",
		});
		let capturedEnv: Record<string, string | undefined> | undefined;
		vi.mocked(query).mockImplementationOnce(({ options }) => {
			capturedEnv = options?.env;
			return sdkGen([
				{
					type: "result",
					subtype: "success",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 1,
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			]);
		});

		try {
			const provider = new ClaudeProvider();
			for await (const _ of provider.query(
				baseParams({
					cwd: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\project",
				}),
			)) {
				// drain
			}
			expect(capturedEnv).toBeDefined();
			expect(capturedEnv).not.toHaveProperty("ANTHROPIC_BASE_URL");
			expect(capturedEnv?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe("1");
		} finally {
			if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL;
			else process.env.ANTHROPIC_BASE_URL = previous;
		}
	});

	it("preserves an explicit WSL-local CLIProxy environment", async () => {
		vi.mocked(parseWslUnc).mockReturnValueOnce({
			distro: "Ubuntu-24.04",
			posixPath: "/home/kyle/project",
		});
		const sdkEnv = {
			ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
			ANTHROPIC_AUTH_TOKEN: "private-key",
		};
		let capturedEnv: Record<string, string | undefined> | undefined;
		vi.mocked(query).mockImplementationOnce(({ options }) => {
			capturedEnv = options?.env;
			return sdkGen([
				{
					type: "result",
					subtype: "success",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 1,
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			]);
		});

		const provider = new ClaudeProvider({ sdkEnv });
		for await (const _ of provider.query(
			baseParams({
				cwd: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\project",
			}),
		)) {
			// drain
		}

		expect(capturedEnv).toEqual({
			...sdkEnv,
			CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
		});
		expect(sdkEnv).not.toHaveProperty("CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS");
	});

	it("enables session-state evidence only for live query subprocesses", async () => {
		const sdkEnv = { HLID_CLAUDE_ENV_SENTINEL: "preserved" };
		let liveEnv: Record<string, string | undefined> | undefined;
		let modelProbeEnv: Record<string, string | undefined> | undefined;
		let skillProbeEnv: Record<string, string | undefined> | undefined;
		let modelProbeOptions: Record<string, unknown> | undefined;
		let skillProbeOptions: Record<string, unknown> | undefined;

		vi.mocked(query)
			.mockImplementationOnce(({ options }) => {
				liveEnv = options?.env;
				return sdkGen([
					{
						type: "result",
						subtype: "success",
						total_cost_usd: 0,
						num_turns: 1,
						duration_ms: 1,
						usage: { input_tokens: 1, output_tokens: 1 },
					},
				]);
			})
			.mockImplementationOnce(({ options }) => {
				modelProbeOptions = options;
				modelProbeEnv = options?.env;
				const gen = sdkGen([]);
				gen.supportedModels = vi.fn().mockResolvedValue([]);
				return gen;
			})
			.mockImplementationOnce(({ options }) => {
				skillProbeOptions = options;
				skillProbeEnv = options?.env;
				const gen = sdkGen([]);
				gen.supportedCommands = vi.fn().mockResolvedValue([]);
				return gen;
			});

		const provider = new ClaudeProvider({ sdkEnv });
		for await (const _ of provider.query(baseParams())) {
			// drain the real query
		}
		await provider.listModels();
		await provider.listSkills?.({ cwd: "/tmp/test" });

		expect(liveEnv).toEqual({
			...sdkEnv,
			CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
		});
		expect(modelProbeEnv).toBe(sdkEnv);
		expect(skillProbeEnv).toBe(sdkEnv);
		expect(modelProbeEnv).not.toHaveProperty(
			"CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS",
		);
		expect(skillProbeEnv).not.toHaveProperty(
			"CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS",
		);
		expect(modelProbeOptions).not.toHaveProperty("agentProgressSummaries");
		expect(skillProbeOptions).not.toHaveProperty("agentProgressSummaries");
	});

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
	it("refuses peer-session prompts and keeps Hlid-owned dialogs open", async () => {
		vi.mocked(query).mockReturnValueOnce(sdkGen([]));
		const session = new ClaudeProvider().query(baseParams());
		await session.send("hello");

		expect(vi.mocked(query).mock.calls.at(-1)?.[0].options?.settings).toEqual({
			crossSessionInbound: "refuse",
			dialogExpiry: "never",
		});
		session.cancel();
	});

	it("propagates an explicit held-peer policy to the Claude SDK settings", async () => {
		vi.mocked(query).mockReturnValueOnce(sdkGen([]));
		const session = new ClaudeProvider().query(
			baseParams({
				claudeCrossSessionInbound: "hold",
				onProviderInitiatedTurn: vi.fn().mockResolvedValue(true),
			}),
		);
		await session.send("hello");

		expect(vi.mocked(query).mock.calls.at(-1)?.[0].options?.settings).toEqual({
			crossSessionInbound: "hold",
			dialogExpiry: "never",
		});
		session.cancel();
	});

	it("refuses peer delivery when hold is requested without a continuation owner", async () => {
		vi.mocked(query).mockReturnValueOnce(sdkGen([]));
		const session = new ClaudeProvider().query(
			baseParams({ claudeCrossSessionInbound: "hold" }),
		);
		await session.send("hello");

		expect(vi.mocked(query).mock.calls.at(-1)?.[0].options?.settings).toEqual({
			crossSessionInbound: "refuse",
			dialogExpiry: "never",
		});
		session.cancel();
	});

	it("registers Hlid's deferred Relic publisher and curated Obsidian tools", async () => {
		vi.mocked(query).mockReturnValueOnce(sdkGen([]));
		const session = new ClaudeProvider().query(
			baseParams({ hostSessionId: "host-session-1" }),
		);
		await session.send("inspect my vault");
		const options = vi.mocked(query).mock.calls.at(-1)?.[0].options;
		expect(options?.mcpServers).toMatchObject({
			hlid: { type: "sdk", name: "hlid" },
			hlid_obsidian: { type: "sdk", name: "hlid_obsidian" },
		});
		const hlidServer = options?.mcpServers?.hlid as unknown as {
			instance: {
				options: {
					tools: Array<{
						name: string;
						alwaysLoad?: boolean;
						searchHint?: string;
						annotations?: {
							readOnlyHint?: boolean;
							idempotentHint?: boolean;
						};
						handler: (input: unknown) => Promise<{
							content: Array<{
								type: string;
								text?: string;
								data?: string;
								mimeType?: string;
							}>;
						}>;
					}>;
				};
			};
		};
		const hlidHelp = hlidServer.instance.options.tools.find(
			(item) => item.name === "hlid_help",
		);
		expect(hlidHelp).toMatchObject({
			alwaysLoad: false,
			annotations: { readOnlyHint: true, idempotentHint: true },
			searchHint: expect.stringContaining("capabilities"),
		});
		const publishRelic = hlidServer.instance.options.tools.find(
			(item) => item.name === "publish_relic",
		);
		expect(publishRelic?.alwaysLoad).toBe(false);
		vi.mocked(executeHlidAgentToolRich).mockResolvedValueOnce({
			text: '{"id":"relic-1"}',
		});
		expect(
			await publishRelic?.handler({
				filename: "report.html",
				content: "<h1>Report</h1>",
			}),
		).toEqual({ content: [{ type: "text", text: '{"id":"relic-1"}' }] });
		expect(executeHlidAgentToolRich).toHaveBeenCalledWith(
			"publish_relic",
			{ filename: "report.html", content: "<h1>Report</h1>" },
			expect.objectContaining({
				providerId: "claude",
				runtimeCwd: "/tmp/test",
				sessionId: "host-session-1",
				registeredHlidTools: expect.arrayContaining([
					"hlid_help",
					"inspect_hlid_ledger",
				]),
				providerSnapshot: expect.objectContaining({
					id: "claude",
					available: true,
					capabilities: expect.objectContaining({ workflowCatalog: true }),
				}),
			}),
		);
		const capturePreview = hlidServer.instance.options.tools.find(
			(item) => item.name === "capture_project_preview",
		);
		vi.mocked(executeHlidAgentToolRich).mockResolvedValueOnce({
			text: '{"viewport":"mobile"}',
			images: [{ data: "AQID", mimeType: "image/png" }],
		});
		expect(await capturePreview?.handler({ viewport: "mobile" })).toEqual({
			content: [
				{ type: "text", text: '{"viewport":"mobile"}' },
				{ type: "image", data: "AQID", mimeType: "image/png" },
			],
		});
		const controlPreview = hlidServer.instance.options.tools.find(
			(item) => item.name === "control_project_preview",
		);
		expect(controlPreview?.annotations?.readOnlyHint).toBe(false);
		vi.mocked(executeHlidAgentToolRich).mockResolvedValueOnce({
			text: '{"last_action":"click"}',
			images: [{ data: "BAUG", mimeType: "image/png" }],
		});
		expect(
			await controlPreview?.handler({
				action: "click",
				frame_id: "e16b1643-591f-4d67-8c22-9df105659385",
				ref: "e1",
			}),
		).toEqual({
			content: [
				{ type: "text", text: '{"last_action":"click"}' },
				{ type: "image", data: "BAUG", mimeType: "image/png" },
			],
		});
		const server = options?.mcpServers?.hlid_obsidian as unknown as {
			instance: {
				options: {
					tools: Array<{
						name: string;
						alwaysLoad?: boolean;
						searchHint?: string;
						inputSchema: Record<string, unknown>;
					}>;
				};
			};
		};
		expect(server.instance.options.tools.map((item) => item.name)).toEqual([
			"vault_info",
			"search",
			"read_note",
			"current_note",
			"daily_note",
			"links",
			"tasks",
			"properties",
			"base_query",
			"history",
			"list_templates",
			"list_commands",
			"read_template",
			"create_note",
			"capture_note",
			"open_daily_note",
			"base_create",
			"append_note",
			"prepend_note",
			"replace_note_text",
			"patch_note",
			"task_update",
			"property_set",
			"property_remove",
			"move_file",
			"rename_file",
			"trash_file",
			"run_command",
		]);
		expect(
			server.instance.options.tools.every(
				(item) => item.alwaysLoad === false && Boolean(item.searchHint),
			),
		).toBe(true);
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

	it("still requests exact Obsidian command approval in bypass mode", async () => {
		vi.mocked(query).mockReturnValueOnce(sdkGen([]));
		const canUseTool = vi.fn().mockResolvedValue({
			behavior: "deny",
			message: "Command needs approval",
		});
		const session = new ClaudeProvider().query(
			baseParams({ permissionMode: "bypassPermissions", canUseTool }),
		);
		await session.send("run an Obsidian command");
		const options = vi.mocked(query).mock.calls.at(-1)?.[0].options;
		const server = options?.mcpServers?.hlid_obsidian as unknown as {
			instance: {
				options: {
					tools: Array<{
						name: string;
						handler: (input: unknown) => Promise<{
							isError?: boolean;
							content: Array<{ type: string; text: string }>;
						}>;
					}>;
				};
			};
		};
		const runCommand = server.instance.options.tools.find(
			(item) => item.name === "run_command",
		);
		const result = await runCommand?.handler({
			id: "app:toggle-left-sidebar",
		});

		expect(canUseTool).toHaveBeenCalledWith(
			"mcp__hlid_obsidian__run_command",
			{ id: "app:toggle-left-sidebar" },
			expect.objectContaining({ title: "Obsidian run command" }),
		);
		expect(result).toEqual({
			isError: true,
			content: [{ type: "text", text: "Command needs approval" }],
		});
		expect(executeObsidianAgentTool).not.toHaveBeenCalled();
		session.cancel();
	});

	it("updates the Obsidian run_command guard across default to Auto and back", async () => {
		const gen = sdkGen([]);
		vi.mocked(query).mockReturnValueOnce(gen);
		const canUseTool = vi.fn().mockResolvedValue({
			behavior: "deny",
			message: "Exact command approval required",
		});
		vi.mocked(executeObsidianAgentTool).mockResolvedValue('{"executed":true}');
		const session = new ClaudeProvider().query(
			baseParams({ permissionMode: "default", canUseTool }),
		);
		await session.send("manage Obsidian");
		const options = vi.mocked(query).mock.calls.at(-1)?.[0].options;
		const server = options?.mcpServers?.hlid_obsidian as unknown as {
			instance: {
				options: {
					tools: Array<{
						name: string;
						handler: (input: unknown) => Promise<{
							isError?: boolean;
							content: Array<{ type: string; text: string }>;
						}>;
					}>;
				};
			};
		};
		const runCommand = server.instance.options.tools.find(
			(item) => item.name === "run_command",
		);
		const input = { id: "app:toggle-left-sidebar" };

		await expect(runCommand?.handler(input)).resolves.toEqual({
			content: [{ type: "text", text: '{"executed":true}' }],
		});
		expect(canUseTool).not.toHaveBeenCalled();
		expect(executeObsidianAgentTool).toHaveBeenCalledTimes(1);

		await session.setPermissionMode?.("auto");
		await expect(runCommand?.handler(input)).resolves.toEqual({
			isError: true,
			content: [{ type: "text", text: "Exact command approval required" }],
		});
		expect(canUseTool).toHaveBeenCalledOnce();
		expect(executeObsidianAgentTool).toHaveBeenCalledTimes(1);

		await session.setPermissionMode?.("default");
		await expect(runCommand?.handler(input)).resolves.toEqual({
			content: [{ type: "text", text: '{"executed":true}' }],
		});
		expect(canUseTool).toHaveBeenCalledOnce();
		expect(executeObsidianAgentTool).toHaveBeenCalledTimes(2);
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

	it("send() pushes a human-origin SDKUserMessage onto the prompt stream", async () => {
		let capturedPrompt: AsyncIterable<unknown> | undefined;
		vi.mocked(query).mockImplementationOnce(
			({ prompt }: { prompt: unknown; options?: unknown }) => {
				capturedPrompt = prompt as AsyncIterable<unknown>;
				return sdkGen([]);
			},
		);
		const provider = new ClaudeProvider();
		const session = provider.query(baseParams());
		await session.send("hello world", { inputOrigin: "human" });

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
				origin: { kind: string };
			}>
		).value;
		expect(sdkMsg.type).toBe("user");
		expect(sdkMsg.message.content[0].text).toBe("hello world");
		expect(sdkMsg.origin).toEqual({ kind: "human" });
	});

	it.each([
		{
			label: "missing provenance",
			inputOrigin: undefined,
			expected: { kind: "unclassified" },
		},
		{
			label: "scheduled task",
			inputOrigin: "scheduled-task",
			expected: {
				kind: "task-notification",
				subkind: "scheduled-trigger",
			},
		},
		{
			label: "coordinator",
			inputOrigin: "coordinator",
			expected: { kind: "coordinator" },
		},
		{
			label: "background notification",
			inputOrigin: "background-notification",
			expected: { kind: "task-notification" },
		},
		{
			label: "automatic continuation",
			inputOrigin: "auto-continuation",
			expected: { kind: "auto-continuation" },
		},
		{
			label: "unclassified input",
			inputOrigin: "unclassified",
			expected: { kind: "unclassified" },
		},
	] satisfies Array<{
		label: string;
		inputOrigin: AgentInputOrigin | undefined;
		expected: Record<string, string>;
	}>)("maps $label to the exact Claude origin", async ({
		inputOrigin,
		expected,
	}) => {
		let capturedPrompt: AsyncIterable<unknown> | undefined;
		vi.mocked(query).mockImplementationOnce(
			({ prompt }: { prompt: unknown; options?: unknown }) => {
				capturedPrompt = prompt as AsyncIterable<unknown>;
				return sdkGen([]);
			},
		);
		const session = new ClaudeProvider().query(baseParams());
		await session.send("classified input", { inputOrigin });

		const result = await (capturedPrompt as AsyncIterable<unknown>)
			[Symbol.asyncIterator]()
			.next();
		expect((result.value as { origin?: unknown }).origin).toEqual(expected);
		session.cancel();
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

	it("steer() pushes an immediate-priority message into the active stream", async () => {
		let capturedPrompt: AsyncIterable<unknown> | undefined;
		vi.mocked(query).mockImplementationOnce(
			({ prompt }: { prompt: unknown; options?: unknown }) => {
				capturedPrompt = prompt as AsyncIterable<unknown>;
				return sdkGen([]);
			},
		);
		const session = new ClaudeProvider().query(baseParams());
		await session.steer?.("change direction", { inputOrigin: "human" });

		const iter = (capturedPrompt as AsyncIterable<unknown>)[
			Symbol.asyncIterator
		]();
		const result = await iter.next();
		expect(result.value).toMatchObject({
			priority: "now",
			origin: { kind: "human" },
			message: {
				content: [{ type: "text", text: "change direction" }],
			},
		});
		session.cancel();
	});

	it("marks adjacent assistant messages within one query without steering", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkStream(async function* () {
				yield {
					type: "assistant",
					message: {
						content: [{ type: "text", text: "First update." }],
						usage: { input_tokens: 10, output_tokens: 3 },
					},
				};
				yield {
					type: "assistant",
					message: {
						content: [{ type: "text", text: "Second update." }],
						usage: { input_tokens: 10, output_tokens: 3 },
					},
				};
				yield {
					type: "result",
					subtype: "success",
					stop_reason: "end_turn",
					total_cost_usd: 0.1,
					num_turns: 1,
					duration_ms: 100,
					usage: { input_tokens: 10, output_tokens: 6 },
				};
			}),
		);
		const session = new ClaudeProvider().query(baseParams());
		await session.send("keep me posted");

		const events: AgentEvent[] = [];
		for await (const event of session) {
			events.push(event);
			if (event.type === "done") break;
		}

		expect(
			events.filter(
				(event) =>
					event.type === "text_delta" ||
					event.type === "assistant_message_boundary",
			),
		).toEqual([
			{ type: "text_delta", text: "First update." },
			{ type: "assistant_message_boundary" },
			{ type: "text_delta", text: "Second update." },
		]);
		session.cancel();
	});

	it("keeps the active turn open across the result boundary interrupted by a steer", async () => {
		let releaseInterruptedResult: (() => void) | undefined;
		const interruptedResultReady = new Promise<void>((resolve) => {
			releaseInterruptedResult = resolve;
		});
		vi.mocked(query).mockReturnValueOnce(
			sdkStream(async function* () {
				yield {
					type: "assistant",
					message: {
						content: [{ type: "text", text: "Starting the update." }],
						usage: { input_tokens: 10, output_tokens: 4 },
					},
				};
				await interruptedResultReady;
				yield {
					type: "result",
					subtype: "success",
					stop_reason: "tool_use",
					total_cost_usd: 0.1,
					num_turns: 1,
					duration_ms: 100,
					usage: { input_tokens: 10, output_tokens: 4 },
				};
				yield {
					type: "assistant",
					message: {
						content: [{ type: "text", text: "Status is done. Continuing." }],
						usage: { input_tokens: 12, output_tokens: 6 },
					},
				};
				yield {
					type: "result",
					subtype: "success",
					stop_reason: "end_turn",
					total_cost_usd: 0.2,
					num_turns: 1,
					duration_ms: 200,
					usage: { input_tokens: 12, output_tokens: 6 },
				};
			}),
		);
		const session = new ClaudeProvider().query(baseParams());
		await session.send("update the note");

		const events: AgentEvent[] = [];
		const completed = (async () => {
			for await (const event of session) {
				events.push(event);
				if (event.type === "done") return;
			}
		})();
		await vi.waitFor(() => {
			expect(events).toContainEqual({
				type: "text_delta",
				text: "Starting the update.",
			});
		});
		await session.steer?.("also mark the status done");
		releaseInterruptedResult?.();
		await completed;

		expect(events.filter((event) => event.type === "done")).toHaveLength(1);
		expect(events).toContainEqual({
			type: "text_delta",
			text: "Status is done. Continuing.",
		});
		const firstTextIndex = events.findIndex(
			(event) =>
				event.type === "text_delta" && event.text === "Starting the update.",
		);
		const boundaryIndex = events.findIndex(
			(event) => event.type === "assistant_message_boundary",
		);
		const secondTextIndex = events.findIndex(
			(event) =>
				event.type === "text_delta" &&
				event.text === "Status is done. Continuing.",
		);
		expect(firstTextIndex).toBeLessThan(boundaryIndex);
		expect(boundaryIndex).toBeLessThan(secondTextIndex);
		expect(events.find((event) => event.type === "done")).toMatchObject({
			turns: 2,
			durationMs: 300,
			stopReason: "end_turn",
		});
		session.cancel();
	});

	it("uses a matching idle state to release a result held only for steering evidence", async () => {
		let releaseTail = () => {};
		const tail = new Promise<void>((resolve) => {
			releaseTail = resolve;
		});
		vi.mocked(query).mockReturnValueOnce(
			sdkStream(async function* () {
				yield {
					type: "system",
					subtype: "init",
					session_id: "native-steer-idle",
					tools: [],
				};
				yield {
					type: "result",
					subtype: "success",
					session_id: "native-steer-idle",
					total_cost_usd: 0.1,
					num_turns: 1,
					duration_ms: 100,
					usage: { input_tokens: 5, output_tokens: 2 },
				};
				yield {
					type: "system",
					subtype: "session_state_changed",
					state: "idle",
					uuid: "idle-after-result",
					session_id: "native-steer-idle",
				};
				await tail;
			}),
		);

		const session = new ClaudeProvider().query(baseParams());
		await session.steer?.("keep this turn open");
		const events: AgentEvent[] = [];
		const completed = (async () => {
			for await (const event of session) {
				events.push(event);
				if (event.type === "done") return true;
			}
			return false;
		})();

		const released = await Promise.race([
			completed,
			new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
		]);
		expect(released).toBe(true);
		expect(events.filter((event) => event.type === "done")).toHaveLength(1);
		expect(events).not.toContainEqual(
			expect.objectContaining({ type: "session_state_changed" }),
		);
		releaseTail();
		session.cancel();
	});

	it("does not complete from idle evidence that arrives before the result", async () => {
		let signalIdle = () => {};
		let releaseResult = () => {};
		const idleObserved = new Promise<void>((resolve) => {
			signalIdle = resolve;
		});
		const resultReady = new Promise<void>((resolve) => {
			releaseResult = resolve;
		});
		vi.mocked(query).mockReturnValueOnce(
			sdkStream(async function* () {
				yield {
					type: "system",
					subtype: "init",
					session_id: "native-idle-first",
					tools: [],
				};
				yield {
					type: "system",
					subtype: "session_state_changed",
					state: "running",
					uuid: "running-before-result",
					session_id: "native-idle-first",
				};
				yield {
					type: "system",
					subtype: "session_state_changed",
					state: "requires_action",
					uuid: "action-before-result",
					session_id: "native-idle-first",
				};
				yield {
					type: "system",
					subtype: "session_state_changed",
					state: "idle",
					uuid: "idle-before-result",
					session_id: "native-idle-first",
				};
				signalIdle();
				await resultReady;
				yield {
					type: "result",
					subtype: "success",
					session_id: "native-idle-first",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 25,
					usage: { input_tokens: 2, output_tokens: 1 },
				};
			}),
		);

		const session = new ClaudeProvider().query(baseParams());
		await session.send("finish only after a result");
		const events: AgentEvent[] = [];
		const completed = (async () => {
			for await (const event of session) {
				events.push(event);
				if (event.type === "done") return;
			}
		})();
		await idleObserved;
		await Promise.resolve();
		expect(events.some((event) => event.type === "done")).toBe(false);

		releaseResult();
		await completed;
		expect(events.filter((event) => event.type === "done")).toHaveLength(1);
		session.cancel();
	});

	it("ignores mismatched, stale, and duplicate idle state frames", async () => {
		let signalIgnored = () => {};
		let releaseFreshIdle = () => {};
		const ignoredObserved = new Promise<void>((resolve) => {
			signalIgnored = resolve;
		});
		const freshIdleReady = new Promise<void>((resolve) => {
			releaseFreshIdle = resolve;
		});
		vi.mocked(query).mockReturnValueOnce(
			sdkStream(async function* () {
				yield {
					type: "system",
					subtype: "init",
					session_id: "native-state-match",
					tools: [],
				};
				yield {
					type: "system",
					subtype: "session_state_changed",
					state: "idle",
					uuid: "stale-idle",
					session_id: "native-state-match",
				};
				yield {
					type: "result",
					subtype: "success",
					session_id: "native-state-match",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 20,
					usage: { input_tokens: 2, output_tokens: 1 },
				};
				yield {
					type: "system",
					subtype: "session_state_changed",
					state: "idle",
					uuid: "wrong-session-idle",
					session_id: "another-native-session",
				};
				yield {
					type: "system",
					subtype: "session_state_changed",
					state: "idle",
					uuid: "stale-idle",
					session_id: "native-state-match",
				};
				signalIgnored();
				await freshIdleReady;
				yield {
					type: "system",
					subtype: "session_state_changed",
					state: "idle",
					uuid: "fresh-idle",
					session_id: "native-state-match",
				};
			}),
		);

		const session = new ClaudeProvider().query(baseParams());
		await session.steer?.("expect a continuation");
		const events: AgentEvent[] = [];
		const completed = (async () => {
			for await (const event of session) {
				events.push(event);
				if (event.type === "done") return;
			}
		})();
		await ignoredObserved;
		await Promise.resolve();
		expect(events.some((event) => event.type === "done")).toBe(false);

		releaseFreshIdle();
		await completed;
		expect(events.filter((event) => event.type === "done")).toHaveLength(1);
		session.cancel();
	});

	it("ignores an old-session idle after reset and a late old child frame", async () => {
		let signalOldIdle = () => {};
		let releaseStream = () => {};
		const oldIdleObserved = new Promise<void>((resolve) => {
			signalOldIdle = resolve;
		});
		const streamReady = new Promise<void>((resolve) => {
			releaseStream = resolve;
		});
		vi.mocked(query).mockReturnValueOnce(
			sdkStream(async function* () {
				yield {
					type: "system",
					subtype: "init",
					session_id: "native-before-reset",
					tools: [],
				};
				yield {
					type: "result",
					subtype: "success",
					session_id: "native-before-reset",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 20,
					usage: { input_tokens: 2, output_tokens: 1 },
				};
				yield {
					type: "conversation_reset",
					new_conversation_id: "native-after-reset",
					uuid: "reset-event",
					session_id: "native-before-reset",
				};
				yield {
					type: "assistant",
					uuid: "late-old-child-frame",
					session_id: "native-before-reset",
					parent_tool_use_id: "late-old-child",
					message: {
						model: "claude-sonnet-4-6",
						content: [],
						usage: { input_tokens: 1, output_tokens: 0 },
					},
				};
				yield {
					type: "system",
					subtype: "session_state_changed",
					state: "idle",
					uuid: "late-old-session-idle",
					session_id: "native-before-reset",
				};
				signalOldIdle();
				await streamReady;
			}),
		);

		const session = new ClaudeProvider().query(baseParams());
		await session.steer?.("hold across the reset");
		const events: AgentEvent[] = [];
		const completed = (async () => {
			for await (const event of session) {
				events.push(event);
				if (event.type === "done") return;
			}
		})();
		await oldIdleObserved;
		await Promise.resolve();
		expect(events.some((event) => event.type === "done")).toBe(false);

		releaseStream();
		await completed;
		expect(events.filter((event) => event.type === "done")).toHaveLength(1);
		expect(events).toContainEqual({
			type: "provider_context_reset",
			sessionId: "native-after-reset",
		});
		session.cancel();
	});

	it("does not let idle bypass a pending background task-version obligation", async () => {
		let signalIdle = () => {};
		let releaseTask = () => {};
		const idleObserved = new Promise<void>((resolve) => {
			signalIdle = resolve;
		});
		const taskReady = new Promise<void>((resolve) => {
			releaseTask = resolve;
		});
		vi.mocked(query).mockReturnValueOnce(
			sdkStream(async function* () {
				yield {
					type: "assistant",
					uuid: "background-candidate-frame",
					session_id: "native-background-version",
					parent_tool_use_id: null,
					message: {
						model: "claude-sonnet-4-6",
						content: [
							{
								type: "tool_use",
								id: "background-candidate-tool",
								name: "Agent",
								input: { prompt: "work in the background" },
							},
						],
						usage: { input_tokens: 4, output_tokens: 2 },
					},
				};
				yield {
					type: "result",
					subtype: "success",
					terminal_reason: "background_requested",
					session_id: "native-background-version",
					total_cost_usd: 0.1,
					num_turns: 1,
					duration_ms: 50,
					usage: { input_tokens: 4, output_tokens: 2 },
				};
				yield {
					type: "system",
					subtype: "session_state_changed",
					state: "idle",
					uuid: "idle-before-task-start",
					session_id: "native-background-version",
				};
				signalIdle();
				await taskReady;
				yield {
					type: "system",
					subtype: "task_started",
					task_id: "background-task",
					tool_use_id: "background-candidate-tool",
					task_type: "subagent",
					session_id: "native-background-version",
				};
				yield {
					type: "system",
					subtype: "task_notification",
					task_id: "background-task",
					status: "completed",
					summary: "Background work finished",
					session_id: "native-background-version",
				};
				yield {
					type: "result",
					subtype: "success",
					session_id: "native-background-version",
					total_cost_usd: 0.2,
					num_turns: 1,
					duration_ms: 75,
					usage: { input_tokens: 3, output_tokens: 1 },
				};
			}),
		);

		const session = new ClaudeProvider().query(baseParams());
		await session.steer?.("keep collecting the background task");
		const events: AgentEvent[] = [];
		const completed = (async () => {
			for await (const event of session) {
				events.push(event);
				if (event.type === "done") return;
			}
		})();
		await idleObserved;
		await Promise.resolve();
		expect(events.some((event) => event.type === "done")).toBe(false);

		releaseTask();
		await completed;
		expect(events.filter((event) => event.type === "done")).toHaveLength(1);
		expect(events.find((event) => event.type === "done")).toMatchObject({
			turns: 2,
			durationMs: 125,
		});
		session.cancel();
	});

	it("does not let idle cancel a provider-owned background activity", async () => {
		let releaseBackground = () => {};
		const backgroundReady = new Promise<void>((resolve) => {
			releaseBackground = resolve;
		});
		vi.mocked(query).mockReturnValueOnce(
			sdkStream(async function* () {
				yield {
					type: "system",
					subtype: "background_tasks_changed",
					tasks: [
						{
							task_id: "provider-background-task",
							task_type: "local_bash",
							description: "Long-running provider command",
						},
					],
					uuid: "background-list-running",
					session_id: "native-background-registry",
				};
				yield {
					type: "result",
					subtype: "success",
					session_id: "native-background-registry",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 20,
					usage: { input_tokens: 2, output_tokens: 1 },
				};
				yield {
					type: "system",
					subtype: "session_state_changed",
					state: "idle",
					uuid: "idle-with-background-registry",
					session_id: "native-background-registry",
				};
				await backgroundReady;
				yield {
					type: "system",
					subtype: "background_tasks_changed",
					tasks: [],
					uuid: "background-list-empty",
					session_id: "native-background-registry",
				};
				yield {
					type: "result",
					subtype: "success",
					session_id: "native-background-registry",
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 30,
					usage: { input_tokens: 2, output_tokens: 1 },
				};
			}),
		);

		const session = new ClaudeProvider().query(baseParams());
		await session.steer?.("keep the provider task alive");
		const events: AgentEvent[] = [];
		const completed = (async () => {
			for await (const event of session) {
				events.push(event);
				if (event.type === "done") return;
			}
		})();
		expect(
			await Promise.race([
				completed.then(() => true),
				new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
			]),
		).toBe(true);
		expect(events.filter((event) => event.type === "done")).toHaveLength(1);
		if (!session.listBackgroundActivities) {
			throw new Error("Claude session must expose background activities");
		}
		await expect(session.listBackgroundActivities()).resolves.toEqual([
			expect.objectContaining({
				activityId: "provider-background-task",
				status: "running",
			}),
		]);
		releaseBackground();
		session.cancel();
	});

	it("does not let idle settle a workflow awaiting its continuation", async () => {
		let signalIdle = () => {};
		let releaseContinuation = () => {};
		const idleObserved = new Promise<void>((resolve) => {
			signalIdle = resolve;
		});
		const continuationReady = new Promise<void>((resolve) => {
			releaseContinuation = resolve;
		});
		vi.mocked(query).mockReturnValueOnce(
			sdkStream(async function* () {
				yield {
					type: "assistant",
					uuid: "workflow-tool-frame",
					session_id: "native-workflow-idle",
					parent_tool_use_id: null,
					message: {
						model: "claude-sonnet-4-6",
						content: [
							{
								type: "tool_use",
								id: "workflow-tool-idle",
								name: "Workflow",
								input: { name: "idle-safety" },
							},
						],
						usage: { input_tokens: 5, output_tokens: 2 },
					},
				};
				yield {
					type: "system",
					subtype: "task_started",
					task_id: "workflow-task-idle",
					tool_use_id: "workflow-tool-idle",
					task_type: "local_workflow",
					workflow_name: "idle-safety",
					session_id: "native-workflow-idle",
				};
				yield {
					type: "result",
					subtype: "success",
					session_id: "native-workflow-idle",
					total_cost_usd: 0.1,
					num_turns: 1,
					duration_ms: 40,
					usage: { input_tokens: 5, output_tokens: 2 },
				};
				yield {
					type: "system",
					subtype: "task_notification",
					task_id: "workflow-task-idle",
					status: "completed",
					summary: "Workflow phase completed",
					session_id: "native-workflow-idle",
				};
				yield {
					type: "system",
					subtype: "session_state_changed",
					state: "idle",
					uuid: "idle-before-workflow-continuation",
					session_id: "native-workflow-idle",
				};
				signalIdle();
				await continuationReady;
				yield {
					type: "assistant",
					uuid: "workflow-continuation-frame",
					session_id: "native-workflow-idle",
					parent_tool_use_id: null,
					message: {
						model: "claude-sonnet-4-6",
						content: [{ type: "text", text: "Workflow is complete." }],
						usage: { input_tokens: 6, output_tokens: 3 },
					},
				};
				yield {
					type: "result",
					subtype: "success",
					session_id: "native-workflow-idle",
					total_cost_usd: 0.2,
					num_turns: 1,
					duration_ms: 60,
					usage: { input_tokens: 6, output_tokens: 3 },
				};
			}),
		);

		const session = new ClaudeProvider({
			workflowProgressReader: async () => null,
		}).query(baseParams());
		await session.steer?.("wait for the workflow continuation");
		const events: AgentEvent[] = [];
		const completed = (async () => {
			for await (const event of session) {
				events.push(event);
				if (event.type === "done") return;
			}
		})();
		await idleObserved;
		await Promise.resolve();
		expect(events.some((event) => event.type === "done")).toBe(false);

		releaseContinuation();
		await completed;
		expect(events.filter((event) => event.type === "done")).toHaveLength(1);
		expect(events).toContainEqual({
			type: "text_delta",
			text: "Workflow is complete.",
			providerFrame: {
				providerSessionId: "native-workflow-idle",
				providerUuid: "workflow-continuation-frame",
			},
		});
		session.cancel();
	});

	it("keeps the existing result timer fallback when no state event arrives", async () => {
		vi.useFakeTimers();
		let releaseTail = () => {};
		try {
			let signalTaskSettled = () => {};
			const taskSettled = new Promise<void>((resolve) => {
				signalTaskSettled = resolve;
			});
			const tail = new Promise<void>((resolve) => {
				releaseTail = resolve;
			});
			vi.mocked(query).mockReturnValueOnce(
				sdkStream(async function* () {
					yield {
						type: "assistant",
						uuid: "timer-tool-frame",
						session_id: "native-timer-fallback",
						parent_tool_use_id: null,
						message: {
							model: "claude-sonnet-4-6",
							content: [
								{
									type: "tool_use",
									id: "timer-agent-tool",
									name: "Agent",
									input: { prompt: "finish shortly" },
								},
							],
							usage: { input_tokens: 3, output_tokens: 1 },
						},
					};
					yield {
						type: "system",
						subtype: "task_started",
						task_id: "timer-task",
						tool_use_id: "timer-agent-tool",
						task_type: "subagent",
						session_id: "native-timer-fallback",
					};
					yield {
						type: "result",
						subtype: "success",
						session_id: "native-timer-fallback",
						total_cost_usd: 0,
						num_turns: 1,
						duration_ms: 30,
						usage: { input_tokens: 3, output_tokens: 1 },
					};
					yield {
						type: "system",
						subtype: "task_notification",
						task_id: "timer-task",
						status: "completed",
						summary: "Finished",
						session_id: "native-timer-fallback",
					};
					signalTaskSettled();
					await tail;
				}),
			);

			const session = new ClaudeProvider().query(baseParams());
			await session.send("run the short task");
			const events: AgentEvent[] = [];
			const completed = (async () => {
				for await (const event of session) {
					events.push(event);
					if (event.type === "done") return;
				}
			})();
			await taskSettled;
			await vi.advanceTimersByTimeAsync(249);
			expect(events.some((event) => event.type === "done")).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await completed;
			expect(events.filter((event) => event.type === "done")).toHaveLength(1);
			session.cancel();
		} finally {
			releaseTail();
			vi.useRealTimers();
		}
	});

	it("completes a steering continuation before consuming its trailing idle", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkStream(async function* () {
				yield {
					type: "result",
					subtype: "success",
					session_id: "native-started-steer",
					total_cost_usd: 0.1,
					num_turns: 1,
					duration_ms: 100,
					usage: { input_tokens: 5, output_tokens: 2 },
				};
				yield {
					type: "assistant",
					uuid: "steer-continuation-text",
					session_id: "native-started-steer",
					parent_tool_use_id: null,
					message: {
						model: "claude-sonnet-4-6",
						content: [{ type: "text", text: "Continuation started." }],
						usage: { input_tokens: 4, output_tokens: 2 },
					},
				};
				yield {
					type: "result",
					subtype: "success",
					session_id: "native-started-steer",
					total_cost_usd: 0.2,
					num_turns: 1,
					duration_ms: 200,
					usage: { input_tokens: 4, output_tokens: 2 },
				};
				yield {
					type: "system",
					subtype: "session_state_changed",
					state: "idle",
					uuid: "idle-after-continuation-result",
					session_id: "native-started-steer",
				};
			}),
		);

		const session = new ClaudeProvider().query(baseParams());
		await session.steer?.("continue differently");
		const events: AgentEvent[] = [];
		for await (const event of session) {
			events.push(event);
			if (event.type === "done") break;
		}
		expect(events.filter((event) => event.type === "done")).toHaveLength(1);
		expect(events).toContainEqual({
			type: "text_delta",
			text: "Continuation started.",
			providerFrame: {
				providerSessionId: "native-started-steer",
				providerUuid: "steer-continuation-text",
			},
		});
		expect(events.find((event) => event.type === "done")).toMatchObject({
			turns: 2,
			durationMs: 300,
		});
		await expect(session[Symbol.asyncIterator]().next()).resolves.toEqual({
			done: true,
			value: undefined,
		});
		session.cancel();
	});

	it("does not reuse a stale idle frame on the next turn of a long-lived query", async () => {
		let releaseSecondTurn = () => {};
		let signalStaleReplay = () => {};
		let releaseFreshIdle = () => {};
		const secondTurnReady = new Promise<void>((resolve) => {
			releaseSecondTurn = resolve;
		});
		const staleReplayObserved = new Promise<void>((resolve) => {
			signalStaleReplay = resolve;
		});
		const freshIdleReady = new Promise<void>((resolve) => {
			releaseFreshIdle = resolve;
		});
		vi.mocked(query).mockReturnValueOnce(
			sdkStream(async function* () {
				yield {
					type: "result",
					subtype: "success",
					session_id: "native-long-lived-state",
					total_cost_usd: 0.1,
					num_turns: 1,
					duration_ms: 10,
					usage: { input_tokens: 1, output_tokens: 1 },
				};
				yield {
					type: "system",
					subtype: "session_state_changed",
					state: "idle",
					uuid: "turn-one-idle",
					session_id: "native-long-lived-state",
				};
				await secondTurnReady;
				yield {
					type: "result",
					subtype: "success",
					session_id: "native-long-lived-state",
					total_cost_usd: 0.2,
					num_turns: 1,
					duration_ms: 20,
					usage: { input_tokens: 1, output_tokens: 1 },
				};
				yield {
					type: "system",
					subtype: "session_state_changed",
					state: "idle",
					uuid: "turn-one-idle",
					session_id: "native-long-lived-state",
				};
				signalStaleReplay();
				await freshIdleReady;
				yield {
					type: "system",
					subtype: "session_state_changed",
					state: "idle",
					uuid: "turn-two-idle",
					session_id: "native-long-lived-state",
				};
			}),
		);

		const session = new ClaudeProvider().query(baseParams());
		await session.steer?.("first turn");
		const firstTurn: AgentEvent[] = [];
		for await (const event of session) {
			firstTurn.push(event);
			if (event.type === "done") break;
		}
		expect(firstTurn.filter((event) => event.type === "done")).toHaveLength(1);

		await session.steer?.("second turn");
		const secondTurn: AgentEvent[] = [];
		const secondCompleted = (async () => {
			for await (const event of session) {
				secondTurn.push(event);
				if (event.type === "done") return;
			}
		})();
		releaseSecondTurn();
		await staleReplayObserved;
		await Promise.resolve();
		expect(secondTurn.some((event) => event.type === "done")).toBe(false);

		releaseFreshIdle();
		await secondCompleted;
		expect(secondTurn.filter((event) => event.type === "done")).toHaveLength(1);
		session.cancel();
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
				total_cost_usd: 0.1,
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
				total_cost_usd: 0.3,
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
		expect(collected1.find((e) => e.type === "done")).toMatchObject({
			estimatedCost: 0.1,
		});

		await session.send("turn 2");
		// Without the wrapper fix, this for-await yields nothing and the
		// loop exits immediately (cached iter is closed).
		const collected2: AgentEvent[] = [];
		for await (const e of session) {
			collected2.push(e);
			if (e.type === "done") break;
		}
		expect(collected2.some((e) => e.type === "done")).toBe(true);
		const secondDone = collected2.find((e) => e.type === "done");
		expect(
			secondDone?.type === "done" ? secondDone.estimatedCost : null,
		).toBeCloseTo(0.2);
		expect(
			collected2.some(
				(e) => e.type === "text_delta" && e.text === "second-turn-marker",
			),
		).toBe(true);
		session.cancel();
	});

	it("ignores a resumed stream's empty zero-turn boundary before the queued prompt", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "result",
					subtype: "success",
					result: "",
					stop_reason: null,
					terminal_reason: undefined,
					total_cost_usd: 0,
					num_turns: 0,
					duration_ms: 80,
					usage: {
						input_tokens: 0,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
					permission_denials: [],
				},
				{
					type: "assistant",
					parent_tool_use_id: null,
					uuid: "actual-turn-message",
					message: {
						model: "claude-opus-5",
						content: [{ type: "text", text: "Launching the workflow." }],
						usage: { input_tokens: 12, output_tokens: 7 },
					},
				},
				{
					type: "result",
					subtype: "success",
					result: "Launching the workflow.",
					stop_reason: "end_turn",
					total_cost_usd: 0.1,
					num_turns: 1,
					duration_ms: 5_000,
					usage: { input_tokens: 12, output_tokens: 7 },
					permission_denials: [],
				},
			]),
		);
		const session = new ClaudeProvider().query(baseParams());
		await session.send("start the workflow");

		const events: AgentEvent[] = [];
		for await (const event of session) {
			events.push(event);
			if (event.type === "done") break;
		}

		expect(events.filter((event) => event.type === "done")).toHaveLength(1);
		expect(events).toContainEqual({
			type: "text_delta",
			text: "Launching the workflow.",
		});
		expect(events.find((event) => event.type === "done")).toMatchObject({
			turns: 1,
			durationMs: 5_000,
			stopReason: "end_turn",
			usage: { inputTokens: 12, outputTokens: 7 },
		});
		session.cancel();
	});

	it.each([
		"error_during_execution",
		"error_max_turns",
		"error_max_budget_usd",
		"error_max_structured_output_retries",
	] as const)("retains usage and structurally marks %s", async (subtype) => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "result",
					subtype,
					is_error: true,
					errors: ["provider detail"],
					total_cost_usd: 0.25,
					num_turns: 2,
					duration_ms: 400,
					usage: {
						input_tokens: 33,
						output_tokens: 12,
						cache_read_input_tokens: 7,
						cache_creation_input_tokens: 4,
					},
					modelUsage: {},
					permission_denials: [],
				},
			]),
		);

		const done = (await collectEvents(baseParams())).find(
			(event) => event.type === "done",
		);
		expect(done).toMatchObject({
			type: "done",
			estimatedCost: 0.25,
			usage: {
				inputTokens: 33,
				outputTokens: 12,
				cacheReadTokens: 7,
				cacheCreationTokens: 4,
			},
			terminalFailure: {
				code: subtype,
				details: ["provider detail"],
			},
		});
	});

	it.each([
		"api_error",
		"malformed_tool_use_exhausted",
		"budget_exhausted",
		"structured_output_retry_exhausted",
		"tool_deferred_unavailable",
		"turn_setup_failed",
	] as const)("marks dead-turn terminal reason %s as failure", async (reason) => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "result",
					subtype: "success",
					result: "",
					is_error: false,
					terminal_reason: reason,
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 10,
					usage: { input_tokens: 2, output_tokens: 1 },
					modelUsage: {},
					permission_denials: [],
				},
			]),
		);

		expect(await collectEvents(baseParams())).toContainEqual(
			expect.objectContaining({
				type: "done",
				terminalFailure: expect.objectContaining({
					code: reason,
					terminalReason: reason,
				}),
			}),
		);
	});

	it("marks a success-shaped API status as a failed result boundary", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "result",
					subtype: "success",
					result: "",
					is_error: true,
					api_error_status: 529,
					total_cost_usd: 0,
					num_turns: 1,
					duration_ms: 10,
					usage: { input_tokens: 2, output_tokens: 1 },
					modelUsage: {},
					permission_denials: [],
				},
			]),
		);

		expect(await collectEvents(baseParams())).toContainEqual(
			expect.objectContaining({
				type: "done",
				terminalFailure: expect.objectContaining({
					code: "api_error",
					apiErrorStatus: 529,
				}),
			}),
		);
	});

	describe("permission denial reconciliation", () => {
		const toolStart = (sessionId: string, toolId: string, name = "Bash") => ({
			type: "assistant",
			parent_tool_use_id: null,
			uuid: `assistant-${sessionId}-${toolId}`,
			session_id: sessionId,
			message: {
				model: "claude-opus-4-6",
				content: [
					{ type: "tool_use", id: toolId, name, input: { command: "pwd" } },
				],
				usage: { input_tokens: 2, output_tokens: 1 },
			},
		});
		const result = (
			sessionId: string,
			permissionDenials: Array<{
				tool_name: string;
				tool_use_id: string;
				tool_input: Record<string, unknown>;
			}>,
			subtype:
				| "success"
				| "error_during_execution"
				| "error_max_turns"
				| "error_max_budget_usd"
				| "error_max_structured_output_retries" = "success",
		) => ({
			type: "result",
			subtype,
			...(subtype === "success" ? { result: "" } : { errors: ["blocked"] }),
			is_error: subtype !== "success",
			uuid: `result-${sessionId}-${crypto.randomUUID()}`,
			session_id: sessionId,
			total_cost_usd: 0,
			num_turns: 1,
			duration_ms: 10,
			stop_reason: "end_turn",
			usage: { input_tokens: 2, output_tokens: 1 },
			modelUsage: {},
			permission_denials: permissionDenials,
		});

		it("ignores an advisory that is absent from the authoritative result", async () => {
			vi.mocked(query).mockReturnValueOnce(
				sdkGen([
					toolStart("native-advisory", "tool-advisory"),
					{
						type: "system",
						subtype: "permission_denied",
						session_id: "native-advisory",
						uuid: "advisory-1",
						tool_name: "Bash",
						tool_use_id: "tool-advisory",
						message: "Advisory only",
					},
					result("native-advisory", []),
				]),
			);
			const events = await collectEvents(baseParams());
			expect(
				events.some((event) => event.type === "provider_permission_denied"),
			).toBe(false);
		});

		it("surfaces authoritative-only denial and synthesizes one missing result", async () => {
			vi.mocked(query).mockReturnValueOnce(
				sdkGen([
					toolStart("native-authoritative", "tool-blocked"),
					result("native-authoritative", [
						{
							tool_name: "Bash",
							tool_use_id: "tool-blocked",
							tool_input: { command: "pwd" },
						},
					]),
				]),
			);
			const events = await collectEvents(baseParams());
			const denialIndex = events.findIndex(
				(event) => event.type === "provider_permission_denied",
			);
			const syntheticIndex = events.findIndex(
				(event) => event.type === "tool_result",
			);
			const doneIndex = events.findIndex((event) => event.type === "done");
			expect(events[denialIndex]).toMatchObject({
				type: "provider_permission_denied",
				providerSessionId: "native-authoritative",
				toolId: "tool-blocked",
				toolName: "Bash",
			});
			expect(events[syntheticIndex]).toMatchObject({
				type: "tool_result",
				toolId: "tool-blocked",
				isError: true,
			});
			expect(denialIndex).toBeLessThan(syntheticIndex);
			expect(syntheticIndex).toBeLessThan(doneIndex);
		});

		it.each([
			"error_during_execution",
			"error_max_turns",
			"error_max_budget_usd",
			"error_max_structured_output_retries",
		] as const)("reconciles authoritative denial on %s", async (subtype) => {
			vi.mocked(query).mockReturnValueOnce(
				sdkGen([
					result(
						`native-${subtype}`,
						[
							{
								tool_name: "Read",
								tool_use_id: `tool-${subtype}`,
								tool_input: {},
							},
						],
						subtype,
					),
				]),
			);
			expect(await collectEvents(baseParams())).toContainEqual(
				expect.objectContaining({
					type: "provider_permission_denied",
					toolId: `tool-${subtype}`,
				}),
			);
		});

		it("merges exact advisory metadata only after result confirmation", async () => {
			vi.mocked(query).mockReturnValueOnce(
				sdkGen([
					toolStart("native-merged", "tool-merged"),
					{
						type: "system",
						subtype: "permission_denied",
						session_id: "native-merged",
						uuid: "advisory-merged",
						tool_name: "Bash",
						tool_use_id: "tool-merged",
						agent_id: "agent-1",
						decision_reason_type: "rule",
						decision_reason: "Workspace policy",
						message: "Command blocked by rule",
					},
					result("native-merged", [
						{
							tool_name: "Bash",
							tool_use_id: "tool-merged",
							tool_input: {},
						},
					]),
				]),
			);
			expect(await collectEvents(baseParams())).toContainEqual({
				type: "provider_permission_denied",
				providerSessionId: "native-merged",
				toolId: "tool-merged",
				toolName: "Bash",
				agentId: "agent-1",
				reasonType: "rule",
				reason: "Workspace policy",
				message: "Command blocked by rule",
			});
		});

		it("retains a richer real result even when its provider frame is absent", async () => {
			vi.mocked(query).mockReturnValueOnce(
				sdkGen([
					toolStart("native-real-result", "tool-real"),
					{
						type: "user",
						session_id: "native-real-result",
						parent_tool_use_id: null,
						message: {
							content: [
								{
									type: "tool_result",
									tool_use_id: "tool-real",
									content: "Detailed provider result",
									is_error: true,
								},
							],
						},
					},
					result("native-real-result", [
						{
							tool_name: "Bash",
							tool_use_id: "tool-real",
							tool_input: {},
						},
					]),
				]),
			);
			const toolResults = (await collectEvents(baseParams())).filter(
				(event) => event.type === "tool_result",
			);
			expect(toolResults).toHaveLength(1);
			expect(toolResults[0]).toMatchObject({
				content: "Detailed provider result",
				isError: true,
			});
		});

		it("synthesizes after the only real result frame is retracted", async () => {
			vi.mocked(query).mockReturnValueOnce(
				sdkGen([
					toolStart("native-retracted-result", "tool-retracted-result"),
					{
						type: "user",
						uuid: "real-result-frame",
						session_id: "native-retracted-result",
						parent_tool_use_id: null,
						message: {
							content: [
								{
									type: "tool_result",
									tool_use_id: "tool-retracted-result",
									content: "Retracted provider result",
									is_error: true,
								},
							],
						},
					},
					{
						type: "system",
						subtype: "model_refusal_fallback",
						session_id: "native-retracted-result",
						uuid: "fallback-notice",
						trigger: "refusal",
						direction: "retry",
						original_model: "claude-opus-4-6",
						fallback_model: "claude-sonnet-4-6",
						request_id: "request-retracted-result",
						retracted_message_uuids: ["real-result-frame"],
						content: "",
					},
					result("native-retracted-result", [
						{
							tool_name: "Bash",
							tool_use_id: "tool-retracted-result",
							tool_input: {},
						},
					]),
				]),
			);
			const targetResults = (await collectEvents(baseParams())).filter(
				(event) =>
					event.type === "tool_result" &&
					event.toolId === "tool-retracted-result",
			);
			expect(targetResults).toHaveLength(2);
			expect(targetResults.at(-1)).toMatchObject({
				type: "tool_result",
				toolId: "tool-retracted-result",
				isError: true,
				providerSessionId: "native-retracted-result",
			});
		});

		it("does not lose real-result settlement at the bounded-state edge", async () => {
			const sessionId = "native-settlement-bound";
			const fillerIds = Array.from(
				{ length: 2_047 },
				(_, index) => `filler-${index}`,
			);
			vi.mocked(query).mockReturnValueOnce(
				sdkGen([
					{
						type: "assistant",
						parent_tool_use_id: null,
						uuid: "bulk-tool-starts",
						session_id: sessionId,
						message: {
							model: "claude-opus-4-6",
							content: ["target", ...fillerIds].map((toolId) => ({
								type: "tool_use",
								id: toolId,
								name: "Bash",
								input: {},
							})),
							usage: { input_tokens: 2, output_tokens: 1 },
						},
					},
					{
						type: "user",
						uuid: "bulk-tool-results",
						session_id: sessionId,
						parent_tool_use_id: null,
						message: {
							content: ["target", ...fillerIds, "unknown-result"].map(
								(toolId) => ({
									type: "tool_result",
									tool_use_id: toolId,
									content: `real:${toolId}`,
								}),
							),
						},
					},
					result(sessionId, [
						{
							tool_name: "Bash",
							tool_use_id: "target",
							tool_input: {},
						},
					]),
				]),
			);
			const targetResults = (await collectEvents(baseParams())).filter(
				(event) => event.type === "tool_result" && event.toolId === "target",
			);
			expect(targetResults).toHaveLength(1);
			expect(targetResults[0]).toMatchObject({ content: "real:target" });
		});

		it("surfaces unknown authoritative evidence without inventing a tool result", async () => {
			vi.mocked(query).mockReturnValueOnce(
				sdkGen([
					result(
						"native-unknown",
						[
							{
								tool_name: "Read",
								tool_use_id: "unknown-tool",
								tool_input: { file_path: "/tmp/a" },
							},
						],
						"error_during_execution",
					),
				]),
			);
			const events = await collectEvents(baseParams());
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "provider_permission_denied",
					toolId: "unknown-tool",
				}),
			);
			expect(events.some((event) => event.type === "tool_result")).toBe(false);
		});

		it("does not synthesize against an old-turn start or a mismatched tool name", async () => {
			vi.mocked(query).mockReturnValueOnce(
				sdkGen([
					toolStart("native-turn-scope", "old-tool", "Read"),
					result("native-turn-scope", []),
					toolStart("native-turn-scope", "renamed-tool", "Read"),
					result("native-turn-scope", [
						{
							tool_name: "Bash",
							tool_use_id: "old-tool",
							tool_input: {},
						},
						{
							tool_name: "Bash",
							tool_use_id: "renamed-tool",
							tool_input: {},
						},
					]),
				]),
			);
			const events = await collectEvents(baseParams());
			expect(
				events.filter((event) => event.type === "provider_permission_denied"),
			).toHaveLength(2);
			expect(events.some((event) => event.type === "tool_result")).toBe(false);
		});

		it("does not synthesize when distinct oversized names share a bounded prefix", async () => {
			const sharedPrefix = "n".repeat(512);
			vi.mocked(query).mockReturnValueOnce(
				sdkGen([
					toolStart(
						"native-name-prefix",
						"prefix-collision",
						`${sharedPrefix}-start`,
					),
					result("native-name-prefix", [
						{
							tool_name: `${sharedPrefix}-denial`,
							tool_use_id: "prefix-collision",
							tool_input: {},
						},
					]),
				]),
			);
			const events = await collectEvents(baseParams());
			expect(
				events.filter((event) => event.type === "provider_permission_denied"),
			).toHaveLength(1);
			expect(events.some((event) => event.type === "tool_result")).toBe(false);
		});

		it("deduplicates replayed authoritative denial evidence", async () => {
			const denial = {
				tool_name: "Bash",
				tool_use_id: "tool-replayed",
				tool_input: {},
			};
			vi.mocked(query).mockReturnValueOnce(
				sdkGen([
					toolStart("native-replayed", "tool-replayed"),
					result("native-replayed", [denial]),
					result("native-replayed", [denial]),
				]),
			);
			const events = await collectEvents(baseParams());
			expect(
				events.filter((event) => event.type === "provider_permission_denied"),
			).toHaveLength(1);
			expect(
				events.filter((event) => event.type === "tool_result"),
			).toHaveLength(1);
		});

		it("caps one authoritative denial list without replay thrash", async () => {
			const denials = Array.from({ length: 2_050 }, (_, index) => ({
				tool_name: "Read",
				tool_use_id: `bounded-denial-${index}`,
				tool_input: {},
			}));
			vi.mocked(query).mockReturnValueOnce(
				sdkGen([
					result("native-denial-bound", denials),
					result("native-denial-bound", denials),
				]),
			);
			const providerDenials = (await collectEvents(baseParams())).filter(
				(event) => event.type === "provider_permission_denied",
			);
			expect(providerDenials).toHaveLength(2_048);
			expect(providerDenials.at(-1)).toMatchObject({
				toolId: "bounded-denial-2047",
			});
			expect(
				providerDenials.some((event) => event.toolId === "bounded-denial-2048"),
			).toBe(false);
		});

		it("isolates advisory metadata by native session and exact untruncated id", async () => {
			const validToolId = "x".repeat(1_024);
			vi.mocked(query).mockReturnValueOnce(
				sdkGen([
					toolStart("native-a", validToolId),
					{
						type: "system",
						subtype: "permission_denied",
						session_id: "native-b",
						uuid: "wrong-session",
						tool_name: "Bash",
						tool_use_id: validToolId,
						message: "Wrong native session",
					},
					{
						type: "system",
						subtype: "permission_denied",
						session_id: "native-a",
						uuid: "oversized-id",
						tool_name: "Bash",
						tool_use_id: `${validToolId}suffix`,
						message: "Truncated collision",
					},
					result("native-a", [
						{
							tool_name: "Bash",
							tool_use_id: validToolId,
							tool_input: {},
						},
					]),
				]),
			);
			const denial = (await collectEvents(baseParams())).find(
				(event) => event.type === "provider_permission_denied",
			);
			expect(denial).toMatchObject({
				type: "provider_permission_denied",
				providerSessionId: "native-a",
				toolId: validToolId,
			});
			expect(
				denial?.type === "provider_permission_denied" ? denial.message : "",
			).not.toContain("Wrong native session");
			expect(
				denial?.type === "provider_permission_denied" ? denial.message : "",
			).not.toContain("Truncated collision");
		});

		it("rejects control-character identities while bounding display metadata", async () => {
			const longReason = `reason-\u0000${"r".repeat(3_000)}`;
			vi.mocked(query).mockReturnValueOnce(
				sdkGen([
					toolStart("native-bounds", "tool-bounds"),
					{
						type: "system",
						subtype: "permission_denied",
						session_id: "native-bounds",
						uuid: "advisory-bounds",
						tool_name: "Bash",
						tool_use_id: "tool-bounds",
						decision_reason: longReason,
						message: `blocked-${"m".repeat(5_000)}`,
					},
					result("native-bounds", [
						{
							tool_name: "Bash",
							tool_use_id: "tool-bounds",
							tool_input: {},
						},
					]),
					result("native-bounds", [
						{
							tool_name: "Read",
							tool_use_id: "bad\u0000identity",
							tool_input: {},
						},
					]),
				]),
			);
			const denials = (await collectEvents(baseParams())).filter(
				(event) => event.type === "provider_permission_denied",
			);
			expect(denials).toHaveLength(1);
			expect(denials[0]?.type === "provider_permission_denied").toBe(true);
			if (denials[0]?.type === "provider_permission_denied") {
				expect(denials[0].reason?.length).toBe(2_000);
				expect(denials[0].reason).not.toContain("\u0000");
				expect(denials[0].message?.length).toBe(4_000);
			}
		});
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

		expect(capturedOptions?.settings).toEqual({
			crossSessionInbound: "refuse",
			dialogExpiry: "never",
		});
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

		expect(capturedOptions?.settings).toEqual({
			crossSessionInbound: "refuse",
			dialogExpiry: "never",
		});
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

		expect(capturedOptions?.settings).toEqual({
			crossSessionInbound: "refuse",
			dialogExpiry: "never",
		});
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
	it("declares workflows and native background activity", () => {
		expect(new ClaudeProvider().capabilities).toEqual({
			workflowCatalog: true,
			backgroundActivities: {
				maturity: "experimental",
				operations: ["background", "list", "stop"],
			},
		});
	});

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

	it("scopes Auto and dontAsk to direct Claude session catalogs and validation", async () => {
		const direct = new ClaudeProvider();
		const cliProxy = new CliProxyCodexProvider({
			base_url: "http://127.0.0.1:8317",
			api_key: "test-key",
		});
		const advancedModes = ["auto", "dontAsk"] as const;
		const directConfigModes = new Set<string>(
			(direct.permissionModes ?? []).map((mode) => mode.value),
		);
		const directSessionModes = new Set<string>(
			(direct.sessionPermissionModes ?? []).map((mode) => mode.value),
		);
		const cliProxySessionModes = new Set<string>(
			(cliProxy.sessionPermissionModes ?? []).map((mode) => mode.value),
		);

		for (const mode of advancedModes) {
			expect(directConfigModes.has(mode)).toBe(false);
			expect(directSessionModes.has(mode)).toBe(true);
			expect(cliProxySessionModes.has(mode)).toBe(false);
			const session = direct.query(
				baseParams({ permissionMode: mode, model: "claude-sonnet-5" }),
			);
			session.cancel();
			expect(() =>
				cliProxy.query(
					baseParams({ permissionMode: mode, model: "claude-sonnet-5" }),
				),
			).toThrow(`does not support permission mode ${mode}`);
			await expect(
				cliProxy.validatePermissionMode(mode, {
					cwd: "/tmp/cliproxy-advanced-mode",
					model: "claude-sonnet-5",
					policyEnforced: false,
					usageGateEnforced: false,
				}),
			).rejects.toThrow(`does not support permission mode ${mode}`);
		}
		await expect(
			direct.validatePermissionMode("dontAsk", {
				cwd: "/tmp/direct-dont-ask",
				model: "claude-sonnet-5",
				policyEnforced: false,
				usageGateEnforced: false,
			}),
		).resolves.toBeUndefined();
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
		expect(capturedOptions?.settings).toEqual({
			crossSessionInbound: "refuse",
			dialogExpiry: "never",
		});
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
