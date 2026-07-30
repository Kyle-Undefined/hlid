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
	it("normalizes accepted boundaries and clamps hidden receipts to the visible window", () => {
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
			{ kind: "steer", key: "steer:negative", steerIndex: 0, boundary: 2 },
			{
				kind: "steer",
				key: "steer:fractional",
				steerIndex: 1,
				boundary: 2,
			},
			{ kind: "tool", key: "tool-2", eventIndex: 2 },
			{ kind: "steer", key: "steer:middle", steerIndex: 4, boundary: 3 },
			{ kind: "tool", key: "tool-3", eventIndex: 3 },
			{
				kind: "steer",
				key: "steer:non-finite",
				steerIndex: 2,
				boundary: 4,
			},
			{
				kind: "steer",
				key: "steer:oversized",
				steerIndex: 3,
				boundary: 4,
			},
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
			{ kind: "steer", key: "steer:redirect", steerIndex: 0, boundary: 2 },
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
});
