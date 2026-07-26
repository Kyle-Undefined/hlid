// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentSnapshot } from "#/server/agentProvider";
import type { ToolEventMessage } from "#/server/protocol";
import type { ChatMessage } from "./chatReducer";
import { resetSubagentOpenStateForTest } from "./SubagentToolBlock";
import { WorkflowManagerDialog } from "./WorkflowManagerDialog";

function snapshot(
	agentId: string,
	status: SubagentSnapshot["status"],
	overrides: Partial<SubagentSnapshot> = {},
): SubagentSnapshot {
	return {
		provider: "claude",
		agentId,
		status,
		startedAtMs: Date.now() - 4_000,
		...overrides,
	};
}

function event(id: string, subagent: SubagentSnapshot): ToolEventMessage {
	return {
		type: "tool_event",
		id,
		name: subagent.kind === "workflow" ? "Workflow" : "Agent",
		input: {},
		subagent,
	};
}

function assistant(id: string, toolEvents: ToolEventMessage[]): ChatMessage {
	return {
		id,
		role: "assistant",
		text: "",
		toolEvents,
		streaming: false,
		cost: null,
	};
}

afterEach(() => {
	cleanup();
	resetSubagentOpenStateForTest();
});

describe("WorkflowManagerDialog", () => {
	it("opens without a selection and shows run details after selection", () => {
		const onStop = vi.fn();
		const scrollIntoView = vi.fn();
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
			configurable: true,
			value: scrollIntoView,
		});
		const messages = [
			assistant("done-message", [
				event(
					"done",
					snapshot("done-task", "completed", {
						kind: "workflow",
						taskId: "done-task",
						workflowRunId: "done-run",
						name: "Finished audit",
						endedAtMs: Date.now() - 1_000,
					}),
				),
			]),
			assistant("live-message", [
				event(
					"live",
					snapshot("live-task", "running", {
						kind: "workflow",
						taskId: "live-task",
						workflowRunId: "live-run",
						name: "Live audit",
						prompt: "Inspect every route",
					}),
				),
				event(
					"live-child",
					snapshot("route-reader", "running", {
						parentActivityId: "live-task",
						currentStep: "Reading routes",
					}),
				),
			]),
		];

		render(
			<WorkflowManagerDialog
				messages={messages}
				sessionId="session-1"
				providerId="claude"
				onStop={onStop}
				onRunPrompt={vi.fn()}
				onSave={vi.fn()}
				onDelete={vi.fn()}
				onReadSource={vi.fn(() => "source-1")}
				onClose={vi.fn()}
			/>,
		);

		const options = screen.getAllByRole("option");
		const listbox = screen.getByRole("listbox");
		expect(options).toHaveLength(2);
		expect(options[0]?.textContent).toContain("Live audit");
		expect(options[0]?.getAttribute("aria-selected")).toBe("false");
		expect(listbox.classList.contains("max-h-none")).toBe(true);
		expect(screen.getByText("Select a workflow")).toBeTruthy();
		fireEvent.click(options[0] as HTMLElement);
		expect(options[0]?.getAttribute("aria-selected")).toBe("true");
		expect(listbox.classList.contains("max-h-52")).toBe(true);
		expect(screen.queryByText("Inspect every route")).not.toBeNull();
		expect(screen.queryByText("Reading routes")).not.toBeNull();

		fireEvent.click(options[0] as HTMLElement);
		expect(options[0]?.getAttribute("aria-selected")).toBe("false");
		expect(listbox.classList.contains("max-h-none")).toBe(true);
		fireEvent.click(options[0] as HTMLElement);
		fireEvent.click(screen.getByRole("button", { name: "Stop workflow" }));
		expect(onStop).toHaveBeenCalledWith(
			expect.objectContaining({ key: "live-run" }),
		);

		const finishedOption = options[1];
		if (!finishedOption) throw new Error("Expected a finished workflow option");
		fireEvent.click(finishedOption);
		expect(finishedOption.getAttribute("aria-selected")).toBe("true");
		expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
		expect(scrollIntoView.mock.contexts.at(-1)).toBe(finishedOption);
		expect(screen.queryByText("done-task")).not.toBeNull();
	});

	it("offers native resume for a terminal run and can load older history", () => {
		const onRunPrompt = vi.fn();
		const onLoadOlderHistory = vi.fn(async () => 100);
		render(
			<WorkflowManagerDialog
				messages={[
					assistant("message", [
						event(
							"stopped",
							snapshot("stopped-task", "interrupted", {
								kind: "workflow",
								taskId: "stopped-task",
								workflowRunId: "stopped-run",
								workflowStopConfirmed: true,
								name: "Stopped audit",
							}),
						),
					]),
				]}
				sessionId="session-1"
				providerId="claude"
				hasOlderHistory
				onLoadOlderHistory={onLoadOlderHistory}
				onStop={vi.fn()}
				onRunPrompt={onRunPrompt}
				onSave={vi.fn()}
				onDelete={vi.fn()}
				onReadSource={vi.fn(() => "source-1")}
				onClose={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByRole("option"));
		fireEvent.click(screen.getByRole("button", { name: "Resume workflow" }));
		expect(onRunPrompt).toHaveBeenCalledWith(
			expect.stringContaining('resumeFromRunId set to "stopped-run"'),
		);
		fireEvent.click(screen.getByRole("button", { name: "Load older history" }));
		expect(onLoadOlderHistory).toHaveBeenCalledOnce();
	});

	it("keeps a live row selected when Claude adds its native run id", () => {
		const callbacks = {
			onStop: vi.fn(),
			onRunPrompt: vi.fn(),
			onSave: vi.fn(),
			onDelete: vi.fn(),
			onReadSource: vi.fn(() => "source-1"),
			onClose: vi.fn(),
		};
		const message = (workflowRunId?: string) => [
			assistant("live-message", [
				event(
					"live-event",
					snapshot("live-task", "running", {
						kind: "workflow",
						taskId: "live-task",
						...(workflowRunId ? { workflowRunId } : {}),
						name: "Live audit",
						prompt: "Inspect every route",
					}),
				),
			]),
		];
		const view = render(
			<WorkflowManagerDialog
				{...callbacks}
				messages={message()}
				sessionId="session-1"
				providerId="claude"
			/>,
		);

		fireEvent.click(screen.getByRole("option"));
		expect(screen.getByRole("option").getAttribute("aria-selected")).toBe(
			"true",
		);
		expect(screen.getByText("Inspect every route")).toBeTruthy();

		view.rerender(
			<WorkflowManagerDialog
				{...callbacks}
				messages={message("native-run-1")}
				sessionId="session-1"
				providerId="claude"
			/>,
		);
		expect(screen.getByRole("option").getAttribute("aria-selected")).toBe(
			"true",
		);
		expect(screen.getByText("Inspect every route")).toBeTruthy();

		fireEvent.click(screen.getByRole("option"));
		expect(screen.getByRole("option").getAttribute("aria-selected")).toBe(
			"false",
		);
	});

	it("reruns and saves a completed run while exposing saved commands", () => {
		const onRunPrompt = vi.fn();
		const onSave = vi.fn(() => "save-1");
		const onReadSource = vi.fn(() => "source-1");
		const scrollIntoView = vi.fn();
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
			configurable: true,
			value: scrollIntoView,
		});
		const view = render(
			<WorkflowManagerDialog
				messages={[
					assistant("message", [
						event(
							"completed",
							snapshot("completed-task", "completed", {
								kind: "workflow",
								taskId: "completed-task",
								workflowRunId: "completed-run",
								workflowScriptPath: "/tmp/generated-audit.js",
								name: "audit",
							}),
						),
					]),
				]}
				sessionId="session-1"
				providerId="claude"
				savedWorkflows={[
					{
						id: "saved-audit",
						name: "saved-audit",
						description: "Audit the project",
						argumentHint: "[input]",
						scriptPath: "/project/.claude/workflows/saved-audit.js",
						scope: "project",
						scopeLabel: "Project",
						availableAsCommand: true,
					},
				]}
				saveLocations={[
					{
						scope: "project",
						scopeLabel: "Project",
						path: "/project/.claude/workflows",
						available: true,
					},
					{
						scope: "personal",
						scopeLabel: "Personal",
						path: "/home/test/.claude/workflows",
						available: true,
					},
				]}
				onStop={vi.fn()}
				onRunPrompt={onRunPrompt}
				onSave={onSave}
				onDelete={vi.fn()}
				onReadSource={onReadSource}
				onClose={vi.fn()}
			/>,
		);

		const options = screen.getAllByRole("option");
		expect(options[0]?.textContent).toContain("saved-audit");
		expect(options[0]?.getAttribute("aria-selected")).toBe("false");
		if (!options[1]) throw new Error("Expected the completed workflow run");
		fireEvent.click(options[1]);

		fireEvent.click(screen.getByRole("button", { name: "Rerun workflow" }));
		expect(onRunPrompt).toHaveBeenCalledWith(
			expect.stringContaining(
				'Workflow tool with scriptPath set to "/tmp/generated-audit.js"',
			),
		);

		fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
		expect(onReadSource).toHaveBeenCalledWith("/tmp/generated-audit.js");
		expect(screen.getByLabelText("Workflow definition").textContent).toContain(
			"Loading definition",
		);
		expect(scrollIntoView).toHaveBeenCalledWith({
			behavior: "smooth",
			block: "nearest",
		});
		expect(document.activeElement).toBe(
			screen.getByLabelText("Save workflow options"),
		);
		expect(screen.getByText("/project/.claude/workflows")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Save to project" }));
		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({ key: "completed-run" }),
			"project",
			false,
		);
		const saveRequestId = onSave.mock.results[0]?.value;
		if (!saveRequestId) throw new Error("Expected a workflow save request");
		view.rerender(
			<WorkflowManagerDialog
				messages={[
					assistant("message", [
						event(
							"completed",
							snapshot("completed-task", "completed", {
								kind: "workflow",
								taskId: "completed-task",
								workflowRunId: "completed-run",
								workflowScriptPath: "/tmp/generated-audit.js",
								name: "audit",
							}),
						),
					]),
				]}
				sessionId="session-1"
				providerId="claude"
				savedWorkflows={[
					{
						id: "saved-audit",
						name: "saved-audit",
						description: "Audit the project",
						argumentHint: "[input]",
						scriptPath: "/project/.claude/workflows/saved-audit.js",
						scope: "project",
						scopeLabel: "Project",
						availableAsCommand: true,
					},
					{
						id: "saved-new-audit",
						name: "audit",
						description: "Run audit",
						argumentHint: "[input]",
						scriptPath: "/project/.claude/workflows/audit.js",
						scope: "project",
						scopeLabel: "Project",
						availableAsCommand: true,
					},
				]}
				saveLocations={[
					{
						scope: "project",
						scopeLabel: "Project",
						path: "/project/.claude/workflows",
						available: true,
					},
				]}
				saveResult={{
					type: "workflow_save_result",
					request_id: saveRequestId,
					workflow: {
						id: "saved-new-audit",
						name: "audit",
						description: "Run audit",
						argumentHint: "[input]",
						scriptPath: "/project/.claude/workflows/audit.js",
						scope: "project",
						scopeLabel: "Project",
						availableAsCommand: true,
					},
				}}
				onStop={vi.fn()}
				onRunPrompt={onRunPrompt}
				onSave={onSave}
				onDelete={vi.fn()}
				onReadSource={onReadSource}
				onClose={vi.fn()}
			/>,
		);
		expect(screen.queryByLabelText("Save workflow options")).toBeNull();

		fireEvent.click(screen.getByRole("option", { name: /saved-audit/i }));
		fireEvent.change(screen.getByLabelText("Optional input"), {
			target: { value: "routes only" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));
		expect(onRunPrompt).toHaveBeenLastCalledWith(
			expect.stringContaining(
				'Workflow tool with scriptPath set to "/project/.claude/workflows/saved-audit.js"',
			),
		);
		expect(onRunPrompt.mock.calls.at(-1)?.[0]).toContain('"routes only"');
	});

	it("confirms permanent deletion of an exact saved workflow", () => {
		const workflow = {
			id: "saved-audit",
			name: "saved-audit",
			description: "Audit the project",
			argumentHint: "[input]",
			scriptPath: "/project/.claude/workflows/saved-audit.js",
			scope: "project" as const,
			scopeLabel: "Project",
			availableAsCommand: true,
		};
		const onDelete = vi.fn(() => "delete-1");
		render(
			<WorkflowManagerDialog
				messages={[]}
				sessionId="session-1"
				providerId="claude"
				savedWorkflows={[workflow]}
				onStop={vi.fn()}
				onRunPrompt={vi.fn()}
				onSave={vi.fn()}
				onDelete={onDelete}
				onReadSource={vi.fn(() => "source-1")}
				onClose={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByRole("option"));
		fireEvent.click(screen.getByRole("button", { name: "Delete workflow" }));
		expect(screen.getByText("Delete /saved-audit permanently?")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "delete" }));
		expect(onDelete).toHaveBeenCalledWith(workflow);
	});

	it("loads and displays an exact saved workflow definition on demand", () => {
		const workflow = {
			id: "saved-audit",
			name: "saved-audit",
			description: "Audit the project",
			argumentHint: "[input]",
			scriptPath: "/project/.claude/workflows/saved-audit.js",
			scope: "project" as const,
			scopeLabel: "Project",
			availableAsCommand: true,
		};
		const onReadSource = vi.fn(() => "source-1");
		const props = {
			messages: [],
			sessionId: "session-1",
			providerId: "claude",
			savedWorkflows: [workflow],
			onStop: vi.fn(),
			onRunPrompt: vi.fn(),
			onSave: vi.fn(),
			onDelete: vi.fn(),
			onReadSource,
			onClose: vi.fn(),
		};
		const view = render(<WorkflowManagerDialog {...props} />);

		expect(screen.getByText("Select a workflow")).toBeTruthy();
		fireEvent.click(screen.getByRole("option"));
		expect(onReadSource).toHaveBeenCalledWith(workflow.scriptPath, "project");
		expect(screen.getByLabelText("Workflow definition").textContent).toContain(
			"Loading definition",
		);

		view.rerender(
			<WorkflowManagerDialog
				{...props}
				sourceResult={{
					type: "workflow_source_result",
					request_id: "source-1",
					script_path: workflow.scriptPath,
					source: 'export const meta = { name: "saved-audit" }',
				}}
			/>,
		);
		expect(screen.getByLabelText("Workflow definition").textContent).toContain(
			'export const meta = { name: "saved-audit" }',
		);
		fireEvent.click(screen.getByRole("option"));
		expect(screen.getByRole("option").getAttribute("aria-selected")).toBe(
			"false",
		);
		expect(onReadSource).toHaveBeenCalledTimes(1);
	});
});
