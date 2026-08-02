import { describe, expect, it } from "vitest";
import {
	claudeTaskActivityResult,
	claudeTaskActivityStart,
	codexPlanActivity,
} from "./taskActivity";

describe("task activity normalization", () => {
	it("normalizes a Codex plan snapshot", () => {
		expect(
			codexPlanActivity({
				explanation: "Implementation order",
				plan: [
					{ step: "Parse task tools", status: "completed" },
					{ step: "Render the card", status: "in_progress" },
				],
			}),
		).toEqual({
			kind: "tasks",
			source: "codex-plan",
			operation: "snapshot",
			explanation: "Implementation order",
			items: [
				{ subject: "Parse task tools", status: "completed" },
				{ subject: "Render the card", status: "in_progress" },
			],
		});
	});

	it("normalizes Claude TodoWrite active forms", () => {
		expect(
			claudeTaskActivityStart("TodoWrite", {
				todos: [
					{
						content: "Run focused tests",
						activeForm: "Running focused tests",
						status: "in_progress",
					},
				],
			}),
		).toMatchObject({
			source: "claude-todo",
			items: [
				{
					subject: "Run focused tests",
					activeForm: "Running focused tests",
					status: "in_progress",
				},
			],
		});
	});

	it("enriches Claude task-list and task-get results", () => {
		expect(
			claudeTaskActivityResult(
				"TaskList",
				{},
				{
					tasks: [
						{
							id: "4",
							subject: "Persist activity",
							status: "completed",
							owner: "worker",
							blockedBy: ["2"],
						},
					],
				},
			),
		).toMatchObject({
			operation: "list",
			items: [
				{
					id: "4",
					subject: "Persist activity",
					status: "completed",
					owner: "worker",
					blockedBy: ["2"],
				},
			],
		});
		expect(
			claudeTaskActivityResult(
				"TaskGet",
				{ taskId: "4" },
				{
					task: {
						id: "4",
						subject: "Persist activity",
						description: "Keep it across Raven reloads",
						status: "in_progress",
					},
				},
			),
		).toMatchObject({
			operation: "get",
			items: [
				{
					id: "4",
					subject: "Persist activity",
					description: "Keep it across Raven reloads",
					status: "in_progress",
				},
			],
		});
	});

	it("does not claim unrelated or malformed tools", () => {
		expect(claudeTaskActivityStart("Task", { prompt: "delegate" })).toBe(
			undefined,
		);
		expect(claudeTaskActivityStart("TodoWrite", { todos: "bad" })).toBe(
			undefined,
		);
		expect(codexPlanActivity({ plan: "bad" })).toBe(undefined);
	});
});
