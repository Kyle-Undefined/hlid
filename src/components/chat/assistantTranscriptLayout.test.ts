import { describe, expect, it } from "vitest";
import type { ToolEventMessage } from "#/server/protocol";
import { planAssistantTranscript } from "./assistantTranscriptLayout";
import type { UserMessage } from "./chatReducer";

const isProjectPreviewEvent = (event: ToolEventMessage) =>
	event.name.endsWith("_project_preview");

function tool(
	id: string,
	overrides: Partial<ToolEventMessage> = {},
): ToolEventMessage {
	return {
		type: "tool_event",
		id,
		name: `Read ${id}`,
		input: {},
		...overrides,
	};
}

function steer(id: string, boundary?: number): UserMessage {
	return {
		id,
		role: "user",
		text: id,
		steerToolEventIndex: boundary,
	};
}

describe("planAssistantTranscript", () => {
	it("uses accepted boundaries for grouping without interleaving receipts", () => {
		const toolEvents = Array.from({ length: 4 }, (_, index) =>
			tool(`tool-${index}`),
		);
		const acceptedSteers = [
			steer("negative", -3),
			steer("fractional", 1.9),
			steer("non-finite", Number.POSITIVE_INFINITY),
			steer("oversized", 99),
			steer("middle", 3),
		];

		const plan = planAssistantTranscript({
			toolEvents,
			acceptedSteers,
			toolEventStartIndex: 2,
			isProjectPreviewEvent,
		});

		expect(plan.items).toEqual([
			{ kind: "tool", key: "tool-2", eventIndex: 2 },
			{ kind: "tool", key: "tool-3", eventIndex: 3 },
		]);
	});

	it("nests only workflow children that stay on the parent's side of a steer", () => {
		const toolEvents = [
			tool("workflow", {
				name: "Workflow",
				subagent: {
					provider: "claude",
					agentId: "workflow-1",
					kind: "workflow",
					status: "completed",
					startedAtMs: 1,
				},
			}),
			tool("nested-child", {
				name: "Subagent",
				subagent: {
					provider: "claude",
					agentId: "child-1",
					parentActivityId: "workflow-1",
					status: "completed",
					startedAtMs: 1,
				},
			}),
			tool("active-child", {
				name: "spawn_agent",
				subagent: {
					provider: "codex",
					agentId: "active-1",
					status: "running",
					startedAtMs: 1,
				},
			}),
			tool("cross-boundary-child", {
				name: "Subagent",
				subagent: {
					provider: "claude",
					agentId: "child-2",
					parentActivityId: "workflow-1",
					status: "completed",
					startedAtMs: 1,
				},
			}),
			tool("later"),
		];

		const plan = planAssistantTranscript({
			toolEvents,
			acceptedSteers: [steer("redirect", 2)],
			toolEventStartIndex: 0,
			isProjectPreviewEvent,
		});

		expect([...plan.workflowChildEventIndices]).toEqual([["workflow-1", [1]]]);
		expect(plan.activeSubagentEventIndices).toEqual([2]);
		expect(plan.items).toEqual([
			{ kind: "tool", key: "workflow", eventIndex: 0 },
			{ kind: "tool", key: "cross-boundary-child", eventIndex: 3 },
			{ kind: "tool", key: "later", eventIndex: 4 },
		]);
	});

	it("keeps active subagents outside the tool window available for bottom placement", () => {
		const toolEvents = [
			tool("active", {
				name: "spawn_agent",
				subagent: {
					provider: "codex",
					agentId: "active-1",
					status: "paused",
					startedAtMs: 1,
				},
			}),
			tool("hidden"),
			tool("visible"),
		];

		const plan = planAssistantTranscript({
			toolEvents,
			acceptedSteers: [],
			toolEventStartIndex: 2,
			isProjectPreviewEvent,
		});

		expect(plan.activeSubagentEventIndices).toEqual([0]);
		expect(plan.items).toEqual([
			{ kind: "tool", key: "visible", eventIndex: 2 },
		]);
	});

	it("keeps task activity outside the tool window available for bottom placement", () => {
		const taskActivity = {
			kind: "tasks" as const,
			source: "claude-task-store" as const,
			operation: "create" as const,
			items: [{ id: "1", subject: "Hidden task", status: "pending" as const }],
		};
		const toolEvents = [
			tool("hidden-task", { name: "TaskCreate", taskActivity }),
			tool("hidden"),
			tool("visible"),
		];

		const plan = planAssistantTranscript({
			toolEvents,
			acceptedSteers: [],
			toolEventStartIndex: 2,
			isProjectPreviewEvent,
		});

		expect(plan.taskActivityGroups).toEqual([
			{
				key: "task-group:hidden-task",
				eventIndices: [0],
			},
		]);
		expect(plan.items).toEqual([
			{ kind: "tool", key: "visible", eventIndex: 2 },
		]);
	});

	it("excludes either all Preview activity or only the externally grouped events", () => {
		const toolEvents = [
			tool("preview-start", { name: "mcp__hlid__start_project_preview" }),
			tool("ordinary"),
			tool("preview-capture", {
				name: "mcp__hlid__capture_project_preview",
			}),
			tool("preview-control", {
				name: "mcp__hlid__control_project_preview",
			}),
		];

		const localGroup = planAssistantTranscript({
			toolEvents,
			acceptedSteers: [],
			toolEventStartIndex: 0,
			isProjectPreviewEvent,
		});
		expect(localGroup.groupedProjectPreviewEventIndices).toEqual([0, 2, 3]);
		expect(localGroup.items).toEqual([
			{ kind: "tool", key: "ordinary", eventIndex: 1 },
		]);

		const externalGroup = planAssistantTranscript({
			toolEvents,
			acceptedSteers: [],
			toolEventStartIndex: 0,
			groupedProjectPreviewEventIds: new Set(["preview-capture"]),
			isProjectPreviewEvent,
		});
		expect(externalGroup.groupedProjectPreviewEventIndices).toEqual([2]);
		expect(externalGroup.items).toEqual([
			{ kind: "tool", key: "preview-start", eventIndex: 0 },
			{ kind: "tool", key: "ordinary", eventIndex: 1 },
			{ kind: "tool", key: "preview-control", eventIndex: 3 },
		]);
	});

	it("groups task activity by provider source without crossing a steer", () => {
		const taskActivity = {
			kind: "tasks" as const,
			source: "claude-task-store" as const,
			operation: "create" as const,
			items: [
				{ id: "1", subject: "Test grouping", status: "pending" as const },
			],
		};
		const toolEvents = [
			tool("task-create", { name: "TaskCreate", taskActivity }),
			tool("ordinary"),
			tool("task-list", {
				name: "TaskList",
				taskActivity: { ...taskActivity, operation: "list" },
			}),
			tool("task-update-after-steer", {
				name: "TaskUpdate",
				taskActivity: { ...taskActivity, operation: "update" },
			}),
		];

		const plan = planAssistantTranscript({
			toolEvents,
			acceptedSteers: [steer("redirect", 3)],
			toolEventStartIndex: 0,
			isProjectPreviewEvent,
		});

		expect(plan.items).toEqual([
			{
				kind: "task_group",
				key: "task-group:task-create",
				eventIndices: [0, 2],
			},
			{ kind: "tool", key: "ordinary", eventIndex: 1 },
			{
				kind: "task_group",
				key: "task-group:task-update-after-steer",
				eventIndices: [3],
			},
		]);
	});
});
