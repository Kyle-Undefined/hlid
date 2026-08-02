/**
 * ClaudeProvider unit tests — SDK event mapping, canUseTool pass-through,
 * session resume, retry-on-failure, and cancel.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	AgentQueryParams,
	CanUseTool,
	SubagentSnapshot,
} from "./agentProvider";
import { createClaudeHistorySessionStore } from "./claudeHistorySessionStore";
import {
	ClaudeProvider,
	mapClaudeModels,
	mapClaudeUsageWindows,
} from "./claudeProvider";
import { executeHlidAgentToolRich } from "./hlidAgentTools";
import { executeObsidianAgentTool } from "./obsidianAgentTools";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal async-iterable SDK query response with mcpServerStatus(). */
function sdkGen(events: unknown[], mcpStatuses: unknown[] = []) {
	const gen = (async function* () {
		for (const e of events) yield e;
	})();
	Object.assign(gen, {
		mcpServerStatus: vi.fn().mockResolvedValue(mcpStatuses),
		reconnectMcpServer: vi.fn().mockResolvedValue(undefined),
		toggleMcpServer: vi.fn().mockResolvedValue(undefined),
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

	it("surfaces a root replayed user message as a file checkpoint", async () => {
		vi.mocked(query).mockReturnValueOnce(
			sdkGen([
				{
					type: "user",
					uuid: "checkpoint-user-id",
					session_id: "native-claude-session",
					parent_tool_use_id: null,
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
			{ type: "tool_result", toolId: "t-1", content: "file1\nfile2" },
		]);
		expect(events.some((event) => event.type === "file_checkpoint")).toBe(
			false,
		);
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
			supportedDialogKinds: ["refusal_fallback_prompt"],
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
		vi.mocked(query).mockReturnValueOnce(gen);

		await expect(
			new ClaudeProvider().listSkills?.({ cwd: "/work/project" }),
		).resolves.toEqual([{ name: "voice", description: "Apply voice rules" }]);
		expect(gen.supportedCommands).toHaveBeenCalledOnce();
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

		expect(capturedEnv).toBe(sdkEnv);
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

	it("steer() pushes an immediate-priority message into the active stream", async () => {
		let capturedPrompt: AsyncIterable<unknown> | undefined;
		vi.mocked(query).mockImplementationOnce(
			({ prompt }: { prompt: unknown; options?: unknown }) => {
				capturedPrompt = prompt as AsyncIterable<unknown>;
				return sdkGen([]);
			},
		);
		const session = new ClaudeProvider().query(baseParams());
		await session.steer?.("change direction");

		const iter = (capturedPrompt as AsyncIterable<unknown>)[
			Symbol.asyncIterator
		]();
		const result = await iter.next();
		expect(result.value).toMatchObject({
			priority: "now",
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
	it("declares the provider-native workflow catalog", () => {
		expect(new ClaudeProvider().capabilities).toEqual({
			workflowCatalog: true,
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
