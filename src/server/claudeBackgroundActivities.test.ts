import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
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
});
