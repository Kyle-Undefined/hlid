import { describe, expect, it } from "vitest";
import type { SubagentSnapshot } from "#/server/agentProvider";
import type { ToolEventMessage } from "#/server/protocol";
import {
	collectWorkflowRuns,
	savedWorkflowRunPrompt,
	workflowDurationMs,
	workflowRerunPrompt,
	workflowTokenTotal,
} from "./workflowRuns";

function snapshot(
	agentId: string,
	status: SubagentSnapshot["status"],
	overrides: Partial<SubagentSnapshot> = {},
): SubagentSnapshot {
	return {
		provider: "claude",
		agentId,
		status,
		startedAtMs: 1_000,
		...overrides,
	};
}

function event(
	id: string,
	subagent: SubagentSnapshot,
	input: unknown = {},
): ToolEventMessage {
	return {
		type: "tool_event",
		id,
		name: subagent.kind === "workflow" ? "Workflow" : "Agent",
		input,
		subagent,
	};
}

describe("workflowRuns", () => {
	it("deduplicates resumed parents, correlates every attempt's children, and puts active runs first", () => {
		const runs = collectWorkflowRuns([
			{
				id: "assistant-1",
				role: "assistant",
				toolEvents: [
					event(
						"finished-parent",
						snapshot("finished-task", "completed", {
							kind: "workflow",
							taskId: "finished-task",
							workflowRunId: "finished-run",
							name: "Finished audit",
							endedAtMs: 4_000,
						}),
					),
					event(
						"parent-attempt-1",
						snapshot("task-attempt-1", "interrupted", {
							kind: "workflow",
							taskId: "task-attempt-1",
							workflowRunId: "active-run",
							name: "Repository audit",
						}),
					),
					event(
						"child-attempt-1",
						snapshot("reader", "completed", {
							parentActivityId: "task-attempt-1",
							usage: { totalTokens: 120 },
						}),
					),
				],
			},
			{
				id: "assistant-2",
				role: "assistant",
				toolEvents: [
					event(
						"parent-attempt-2",
						snapshot("task-attempt-2", "running", {
							kind: "workflow",
							taskId: "task-attempt-2",
							workflowRunId: "active-run",
							name: "Repository audit",
						}),
					),
					event(
						"child-attempt-2",
						snapshot("reviewer", "running", {
							parentActivityId: "task-attempt-2",
							startedAtMs: 2_000,
							usage: { totalTokens: 80 },
						}),
					),
				],
			},
		]);

		expect(runs.map((run) => run.key)).toEqual(["active-run", "finished-run"]);
		expect(runs[0]).toMatchObject({
			selectionKey: "assistant-2:parent-attempt-2",
			eventId: "parent-attempt-2",
			messageId: "assistant-2",
			workflow: {
				agentId: "task-attempt-2",
				status: "running",
			},
		});
		expect(runs[0]?.children.map((child) => child.agentId)).toEqual([
			"reader",
			"reviewer",
		]);
		const activeRun = runs[0];
		if (!activeRun) throw new Error("Expected an active workflow run");
		expect(workflowTokenTotal(activeRun)).toBe(200);
	});

	it("uses provider totals and a terminal end time when available", () => {
		const [run] = collectWorkflowRuns([
			{
				id: "assistant",
				role: "assistant",
				toolEvents: [
					event(
						"workflow",
						snapshot("task", "completed", {
							kind: "workflow",
							workflowRunId: "run",
							endedAtMs: 6_000,
							usage: { totalTokens: 450 },
						}),
					),
				],
			},
		]);

		if (!run) throw new Error("Expected a workflow run");
		expect(workflowTokenTotal(run)).toBe(450);
		expect(workflowDurationMs(run, 20_000)).toBe(5_000);
	});

	it("preserves args for a fresh native rerun without resume state", () => {
		const [run] = collectWorkflowRuns([
			{
				id: "assistant",
				role: "assistant",
				toolEvents: [
					event(
						"workflow",
						snapshot("task", "completed", {
							kind: "workflow",
							workflowRunId: "old-run",
							workflowScriptPath: "/tmp/audit.js",
							name: "audit",
						}),
						{ args: { paths: ["src/routes"] } },
					),
				],
			},
		]);
		if (!run) throw new Error("Expected a workflow run");
		expect(run.args).toEqual({ paths: ["src/routes"] });
		const prompt = workflowRerunPrompt(run.workflow, run.args);
		expect(prompt).toContain('scriptPath set to "/tmp/audit.js"');
		expect(prompt).toContain('{"paths":["src/routes"]}');
		expect(prompt).toContain("Do not pass resumeFromRunId");

		expect(
			savedWorkflowRunPrompt(
				{ name: "audit", scriptPath: "/saved/audit.js" },
				"routes only",
			),
		).toContain('"routes only"');
	});
});
