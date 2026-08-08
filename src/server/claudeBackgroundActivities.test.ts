import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { ClaudeBackgroundActivityTracker } from "./claudeBackgroundActivities";

function message(value: Record<string, unknown>): SDKMessage {
	return value as unknown as SDKMessage;
}

describe("ClaudeBackgroundActivityTracker", () => {
	it("projects backgrounded Bash lifecycle messages and clears settled work", () => {
		const tracker = new ClaudeBackgroundActivityTracker("claude", "/work");
		tracker.observe(
			message({
				type: "assistant",
				session_id: "sdk-session-1",
				message: {
					content: [
						{
							type: "tool_use",
							id: "tool-1",
							name: "Bash",
							input: { command: "sleep 30" },
						},
					],
				},
			}),
		);
		tracker.observe(
			message({
				type: "system",
				subtype: "task_started",
				task_id: "task-1",
				tool_use_id: "tool-1",
				description: "Waiting for the command",
				session_id: "sdk-session-1",
			}),
		);
		tracker.observe(
			message({
				type: "system",
				subtype: "task_updated",
				task_id: "task-1",
				patch: { status: "running", is_backgrounded: true },
				session_id: "sdk-session-1",
			}),
		);
		tracker.observe(
			message({
				type: "system",
				subtype: "task_progress",
				task_id: "task-1",
				description: "Still running",
				summary: "Waiting on sleep",
				session_id: "sdk-session-1",
			}),
		);

		expect(tracker.list()).toEqual([
			expect.objectContaining({
				providerId: "claude",
				providerSessionId: "sdk-session-1",
				activityId: "task-1",
				kind: "shell",
				status: "running",
				command: "sleep 30",
				description: "Still running",
				recentOutput: "Waiting on sleep",
				cwd: "/work",
				capabilities: { stop: true },
			}),
		]);

		tracker.observe(
			message({
				type: "system",
				subtype: "task_notification",
				task_id: "task-1",
				status: "completed",
				session_id: "sdk-session-1",
			}),
		);
		expect(tracker.list()).toEqual([]);
	});

	it("recognizes the structured background task result without transcript inference", () => {
		const tracker = new ClaudeBackgroundActivityTracker("claude", "/work");
		tracker.observe(
			message({
				type: "assistant",
				session_id: "sdk-session-2",
				message: {
					content: [
						{
							type: "tool_use",
							id: "tool-2",
							name: "Bash",
							input: { command: "bun run validate" },
						},
					],
				},
			}),
		);
		tracker.observe(
			message({
				type: "user",
				session_id: "sdk-session-2",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "tool-2",
							content: "Command running in background",
						},
					],
				},
				tool_use_result: {
					backgroundTaskId: "task-2",
					stdout: "RUN v4.1.9",
				},
			}),
		);

		expect(tracker.list()).toEqual([
			expect.objectContaining({
				activityId: "task-2",
				command: "bun run validate",
				recentOutput: "RUN v4.1.9",
			}),
		]);
	});

	it("drops settled foreground tool metadata instead of retaining it for the session", () => {
		const tracker = new ClaudeBackgroundActivityTracker("claude", "/work");
		tracker.observe(
			message({
				type: "assistant",
				session_id: "sdk-session-foreground",
				message: {
					content: [
						{
							type: "tool_use",
							id: "settled-tool",
							name: "Bash",
							input: { command: "pwd" },
						},
					],
				},
			}),
		);
		tracker.observe(
			message({
				type: "user",
				session_id: "sdk-session-foreground",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "settled-tool",
							content: "done",
						},
					],
				},
			}),
		);

		expect(
			(
				tracker as unknown as {
					tools: Map<string, unknown>;
				}
			).tools.size,
		).toBe(0);
	});

	it("marks the exact foreground candidate when the host backgrounds it", () => {
		const tracker = new ClaudeBackgroundActivityTracker("claude", "/work");
		for (const [taskId, toolUseId] of [
			["task-a", "tool-a"],
			["task-b", "tool-b"],
		]) {
			tracker.observe(
				message({
					type: "system",
					subtype: "task_started",
					task_id: taskId,
					tool_use_id: toolUseId,
					description: taskId,
					session_id: "sdk-session-3",
				}),
			);
		}

		expect(tracker.markBackgrounded("tool-b")).toBe(1);
		expect(tracker.list().map((activity) => activity.activityId)).toEqual([
			"task-b",
		]);
	});

	it("keeps edge metadata and start time when the level arrives after task_started", () => {
		const tracker = new ClaudeBackgroundActivityTracker("claude", "/work");
		const now = vi.spyOn(Date, "now");
		try {
			now.mockReturnValue(1_000);
			tracker.observe(
				message({
					type: "assistant",
					session_id: "sdk-session-edge-first",
					message: {
						content: [
							{
								type: "tool_use",
								id: "tool-edge-first",
								name: "Bash",
								input: { command: "sleep 60" },
							},
						],
					},
				}),
			);
			tracker.observe(
				message({
					type: "system",
					subtype: "task_started",
					task_id: "task-edge-first",
					tool_use_id: "tool-edge-first",
					task_type: "shell",
					description: "Edge description",
					session_id: "sdk-session-edge-first",
				}),
			);

			now.mockReturnValue(2_000);
			tracker.observe(
				message({
					type: "system",
					subtype: "background_tasks_changed",
					tasks: [
						{
							task_id: "task-edge-first",
							task_type: "shell",
							description: "Level description",
						},
					],
					session_id: "sdk-session-edge-first",
				}),
			);

			expect(tracker.list()).toEqual([
				expect.objectContaining({
					activityId: "task-edge-first",
					kind: "shell",
					command: "sleep 60",
					description: "Level description",
					startedAtMs: 1_000,
					updatedAtMs: 2_000,
				}),
			]);

			now.mockReturnValue(9_000);
			tracker.observe(
				message({
					type: "system",
					subtype: "background_tasks_changed",
					tasks: [
						{
							task_id: "task-edge-first",
							task_type: "shell",
							description: "Level description",
						},
					],
					session_id: "sdk-session-edge-first",
				}),
			);
			expect(tracker.list()[0]?.updatedAtMs).toBe(2_000);
		} finally {
			now.mockRestore();
		}
	});

	it("enriches a level-discovered task when task_started arrives later", () => {
		const tracker = new ClaudeBackgroundActivityTracker("claude", "/work");
		const now = vi.spyOn(Date, "now");
		try {
			now.mockReturnValue(3_000);
			tracker.observe(
				message({
					type: "system",
					subtype: "background_tasks_changed",
					tasks: [
						{
							task_id: "task-level-first",
							task_type: "shell",
							description: "Level-only task",
						},
					],
					session_id: "sdk-session-level-first",
				}),
			);

			now.mockReturnValue(4_000);
			tracker.observe(
				message({
					type: "assistant",
					session_id: "sdk-session-level-first",
					message: {
						content: [
							{
								type: "tool_use",
								id: "tool-level-first",
								name: "Bash",
								input: { command: "bun run validate" },
							},
						],
					},
				}),
			);
			tracker.observe(
				message({
					type: "system",
					subtype: "task_started",
					task_id: "task-level-first",
					tool_use_id: "tool-level-first",
					task_type: "shell",
					description: "Enriched edge task",
					session_id: "sdk-session-level-first",
				}),
			);

			expect(tracker.list()).toEqual([
				expect.objectContaining({
					activityId: "task-level-first",
					command: "bun run validate",
					description: "Enriched edge task",
					startedAtMs: 3_000,
					updatedAtMs: 4_000,
				}),
			]);
		} finally {
			now.mockRestore();
		}
	});

	it("retains an absent foreground candidate until it is backgrounded", () => {
		const tracker = new ClaudeBackgroundActivityTracker("claude", "/work");
		tracker.observe(
			message({
				type: "assistant",
				session_id: "sdk-session-foreground-level",
				message: {
					content: [
						{
							type: "tool_use",
							id: "tool-foreground-level",
							name: "Bash",
							input: { command: "sleep 90" },
						},
					],
				},
			}),
		);
		tracker.observe(
			message({
				type: "system",
				subtype: "task_started",
				task_id: "task-foreground-level",
				tool_use_id: "tool-foreground-level",
				task_type: "local_bash",
				description: "Foreground command",
				session_id: "sdk-session-foreground-level",
			}),
		);
		tracker.observe(
			message({
				type: "system",
				subtype: "background_tasks_changed",
				tasks: [
					{
						task_id: "task-unrelated",
						task_type: "local_agent",
						description: "Unrelated background work",
					},
				],
				session_id: "sdk-session-foreground-level",
			}),
		);
		tracker.observe(
			message({
				type: "system",
				subtype: "background_tasks_changed",
				tasks: [],
				session_id: "sdk-session-foreground-level",
			}),
		);

		expect(tracker.list()).toEqual([]);
		expect(tracker.markBackgrounded("tool-foreground-level")).toBe(1);
		expect(tracker.list()).toEqual([
			expect.objectContaining({
				activityId: "task-foreground-level",
				kind: "shell",
				command: "sleep 90",
				description: "Foreground command",
			}),
		]);
	});

	it("maps pinned Claude task types without tool metadata", () => {
		const tracker = new ClaudeBackgroundActivityTracker("claude", "/work");
		tracker.observe(
			message({
				type: "system",
				subtype: "background_tasks_changed",
				tasks: [
					{
						task_id: "local-bash",
						task_type: "local_bash",
						description: "Local shell",
					},
					{
						task_id: "local-agent",
						task_type: "local_agent",
						description: "Local agent",
					},
					{
						task_id: "teammate",
						task_type: "in_process_teammate",
						description: "Teammate",
					},
					{
						task_id: "workflow",
						task_type: "local_workflow",
						description: "Workflow",
					},
					{
						task_id: "remote-agent",
						task_type: "remote_agent",
						description: "Remote agent",
					},
				],
				session_id: "sdk-session-kinds",
			}),
		);

		expect(
			Object.fromEntries(
				tracker.list().map((activity) => [activity.activityId, activity.kind]),
			),
		).toEqual({
			"local-bash": "shell",
			"local-agent": "agent",
			teammate: "agent",
			workflow: "workflow",
			"remote-agent": "workflow",
		});
	});

	it("replaces membership, heals missed terminal edges, and prunes removed tool metadata", () => {
		const tracker = new ClaudeBackgroundActivityTracker("claude", "/work");
		tracker.observe(
			message({
				type: "assistant",
				session_id: "sdk-session-replace",
				message: {
					content: [
						{
							type: "tool_use",
							id: "tool-removed",
							name: "Bash",
							input: { command: "sleep 10" },
						},
						{
							type: "tool_use",
							id: "tool-survivor",
							name: "Bash",
							input: { command: "sleep 20" },
						},
					],
				},
			}),
		);
		for (const [taskId, toolUseId] of [
			["task-removed", "tool-removed"],
			["task-survivor", "tool-survivor"],
		]) {
			tracker.observe(
				message({
					type: "system",
					subtype: "task_started",
					task_id: taskId,
					tool_use_id: toolUseId,
					task_type: "shell",
					description: taskId,
					session_id: "sdk-session-replace",
				}),
			);
		}
		tracker.observe(
			message({
				type: "system",
				subtype: "background_tasks_changed",
				tasks: [
					{
						task_id: "task-removed",
						task_type: "shell",
						description: "Will disappear",
					},
					{
						task_id: "task-survivor",
						task_type: "shell",
						description: "Survives",
					},
				],
				session_id: "sdk-session-replace",
			}),
		);
		const survivorStartedAt = tracker
			.list()
			.find((activity) => activity.activityId === "task-survivor")?.startedAtMs;

		tracker.observe(
			message({
				type: "system",
				subtype: "background_tasks_changed",
				tasks: [
					{
						task_id: "task-survivor",
						task_type: "shell",
						description: "Still running",
					},
					{
						task_id: "task-discovered",
						task_type: "local_workflow",
						description: "Discovered from the level",
					},
				],
				session_id: "sdk-session-replace",
			}),
		);

		const activities = tracker.list();
		expect(activities.map((activity) => activity.activityId).sort()).toEqual([
			"task-discovered",
			"task-survivor",
		]);
		expect(
			activities.find((activity) => activity.activityId === "task-survivor"),
		).toEqual(
			expect.objectContaining({
				command: "sleep 20",
				description: "Still running",
				startedAtMs: survivorStartedAt,
			}),
		);
		expect(
			activities.find((activity) => activity.activityId === "task-discovered"),
		).toEqual(
			expect.objectContaining({
				kind: "workflow",
				description: "Discovered from the level",
			}),
		);
		const tools = (tracker as unknown as { tools: Map<string, unknown> }).tools;
		expect(tools.has("tool-removed")).toBe(false);
		expect(tools.has("tool-survivor")).toBe(true);

		tracker.observe(
			message({
				type: "system",
				subtype: "background_tasks_changed",
				tasks: [],
				session_id: "sdk-session-replace",
			}),
		);
		expect(tracker.list()).toEqual([]);
		expect(tools.size).toBe(0);
	});

	it("resets the process-local projection on a new SDK init", () => {
		const tracker = new ClaudeBackgroundActivityTracker("claude", "/work");
		tracker.observe(
			message({
				type: "system",
				subtype: "background_tasks_changed",
				tasks: [
					{
						task_id: "task-old-process",
						task_type: "subagent",
						description: "Old process task",
					},
				],
				session_id: "sdk-session-old",
			}),
		);
		expect(tracker.list()).toHaveLength(1);

		tracker.observe(
			message({
				type: "system",
				subtype: "init",
				session_id: "sdk-session-new",
			}),
		);

		expect(tracker.list()).toEqual([]);
	});
});
