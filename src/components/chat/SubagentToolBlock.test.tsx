// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentSnapshot } from "#/server/agentProvider";
import type { PermissionMessage } from "./chatReducer";
import {
	resetSubagentOpenStateForTest,
	SubagentToolBlock,
	summarizeWorkflowChildren,
} from "./SubagentToolBlock";

function snapshot(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
	return {
		provider: "codex",
		agentId: "child-1",
		label: "Explorer",
		prompt: "Inspect the authentication flow",
		status: "running",
		currentStep: "Reading session code",
		startedAtMs: 1_000,
		...overrides,
	};
}

afterEach(() => {
	cleanup();
	resetSubagentOpenStateForTest();
	vi.useRealTimers();
});

describe("SubagentToolBlock", () => {
	it("summarizes native workflow children by lifecycle state", () => {
		expect(
			summarizeWorkflowChildren([
				snapshot({ agentId: "running", status: "running" }),
				snapshot({ agentId: "paused", status: "paused" }),
				snapshot({ agentId: "done", status: "completed" }),
				snapshot({ agentId: "failed", status: "interrupted" }),
			]),
		).toBe("1 running / 1 waiting / 1 done / 1 failed");
	});

	it("shows the provider name, model, and effort in the collapsed card", () => {
		render(
			<SubagentToolBlock
				subagent={snapshot({
					name: "auth-scout",
					model: "gpt-5.4",
					effort: "high",
				})}
			/>,
		);
		expect(
			screen.getByRole("button", { name: /auth-scout running/i }),
		).toBeTruthy();
		expect(screen.getByTitle("Model: gpt-5.4")).toBeTruthy();
		expect(screen.getByTitle("Effort: high")).toBeTruthy();
	});

	it("shows live workflow metadata and the completed result preview", () => {
		render(
			<SubagentToolBlock
				subagent={snapshot({
					provider: "claude",
					agentId: "agent-survey-1",
					name: "survey:vault-info",
					label: "Workflow agent",
					phase: "Survey",
					prompt: "Inspect the vault metadata and summarize what is available.",
					model: "claude-opus-5",
					attempt: 2,
					status: "completed",
					currentStep: "mcp__hlid_obsidian__vault_info",
					lastTool: "StructuredOutput",
					resultPreview: '{"summary":"Vault metadata inspected"}',
					endedAtMs: 9_146,
					usage: {
						durationMs: 8_146,
						toolUses: 4,
						totalTokens: 16_330,
					},
				})}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: /survey:vault-info completed/i }),
		);
		expect(screen.getByText("Phase").parentElement?.textContent).toContain(
			"Survey",
		);
		expect(screen.getByText("Attempt").parentElement?.textContent).toContain(
			"2",
		);
		expect(screen.getAllByText("mcp__hlid_obsidian__vault_info")).toHaveLength(
			2,
		);
		expect(
			screen.getByText(
				"Inspect the vault metadata and summarize what is available.",
			),
		).toBeTruthy();
		expect(screen.getByText("Result preview")).toBeTruthy();
		expect(
			screen.getByText('{"summary":"Vault metadata inspected"}'),
		).toBeTruthy();
		expect(screen.getByText("agent-survey-1")).toBeTruthy();
		expect(screen.getByText("Workflow agent")).toBeTruthy();
		expect(screen.getByText("tool StructuredOutput")).toBeTruthy();
		expect(screen.getByText("model claude-opus-5")).toBeTruthy();
		expect(screen.getByText("4 tools")).toBeTruthy();
		expect(screen.getByText("16,330 tokens")).toBeTruthy();
	});

	it("wraps long subagent identity and runtime fields on mobile", () => {
		const name = "long_mobile_subagent_name_that_must_remain_visible";
		const agentId = "019f6942-a481-7651-b1b9-a39b62c56657-extra-context";
		render(
			<SubagentToolBlock
				subagent={snapshot({
					name,
					label: "/root/long_mobile_subagent_name_that_must_remain_visible",
					agentId,
					model: "gpt-5.6-sol-with-a-long-runtime-label",
					effort: "high",
				})}
			/>,
		);

		const button = screen.getByRole("button", { name: new RegExp(name) });
		expect(button.className).toContain(
			"grid-cols-[auto_auto_minmax(0,1fr)_auto]",
		);
		expect(screen.getByText(name).className).toContain("break-all");
		expect(screen.getByTitle(/Model:/).className).toContain("break-all");
		expect(screen.getByText(agentId).className).toContain("break-all");
		expect(
			screen.getByText(
				"/root/long_mobile_subagent_name_that_must_remain_visible",
			).className,
		).toContain("break-words");
	});

	it("can collapse while running and continues advancing elapsed time", () => {
		vi.useFakeTimers();
		vi.setSystemTime(6_000);
		render(<SubagentToolBlock subagent={snapshot()} />);
		const button = screen.getByRole("button", { name: /explorer running/i });
		expect(button.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getAllByText("5s").length).toBeGreaterThan(0);
		fireEvent.click(button);
		expect(button.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByText("Inspect the authentication flow")).toBeNull();
		act(() => vi.advanceTimersByTime(2_000));
		expect(screen.getByText("7s")).toBeTruthy();
		fireEvent.click(button);
		expect(button.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByText("Inspect the authentication flow")).toBeTruthy();
	});

	it("restores a running card's collapsed state after navigation remounts it", () => {
		const first = render(<SubagentToolBlock subagent={snapshot()} />);
		fireEvent.click(screen.getByRole("button", { name: /explorer running/i }));
		expect(
			screen
				.getByRole("button", { name: /explorer running/i })
				.getAttribute("aria-expanded"),
		).toBe("false");

		first.unmount();
		render(<SubagentToolBlock subagent={snapshot()} />);
		expect(
			screen
				.getByRole("button", { name: /explorer running/i })
				.getAttribute("aria-expanded"),
		).toBe("false");
	});

	it("auto-collapses on completion and reopens with retained details", () => {
		const { rerender } = render(<SubagentToolBlock subagent={snapshot()} />);
		rerender(
			<SubagentToolBlock
				subagent={snapshot({
					status: "completed",
					currentStep: "Inspection complete",
					endedAtMs: 8_000,
				})}
			/>,
		);
		const button = screen.getByRole("button", { name: /explorer completed/i });
		expect(button.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByText("Inspect the authentication flow")).toBeNull();
		fireEvent.click(button);
		expect(button.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByText("Inspect the authentication flow")).toBeTruthy();
	});

	it("keeps an active workflow collapsed, nests its agents, and stops it natively", () => {
		const onStop = vi.fn();
		render(
			<SubagentToolBlock
				subagent={snapshot({
					provider: "claude",
					agentId: "workflow-1",
					taskId: "workflow-1",
					kind: "workflow",
					name: "Repository audit",
					status: "running",
				})}
				childSubagents={[
					snapshot({
						provider: "claude",
						agentId: "child-running",
						name: "Reader",
						status: "running",
					}),
					snapshot({
						provider: "claude",
						agentId: "child-done",
						name: "Reviewer",
						status: "completed",
					}),
				]}
				onStop={onStop}
			/>,
		);

		const workflow = screen.getByRole("button", {
			name: /repository audit running/i,
		});
		expect(workflow.getAttribute("aria-expanded")).toBe("false");
		expect(screen.getByText("1 running / 1 done / 0 failed")).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: /reader running/i }),
		).toBeNull();

		fireEvent.click(workflow);
		expect(
			screen.getByRole("button", { name: /reader running/i }),
		).toBeTruthy();
		const agentList = screen.getByRole("list", { name: "Workflow agents" });
		expect(agentList.className).toContain("max-h-80");
		expect(agentList.className).toContain("overflow-y-auto");
		expect(agentList.className).toContain("overscroll-contain");
		expect(screen.getAllByRole("listitem")).toHaveLength(2);
		fireEvent.click(screen.getByRole("button", { name: "Stop workflow" }));
		expect(onStop).toHaveBeenCalledOnce();
		expect(screen.getByRole("button", { name: "Stopping" })).toBeTruthy();
	});

	it("keeps a child approval visible and actionable on a collapsed workflow", () => {
		const onDecide = vi.fn();
		const child = snapshot({
			provider: "claude",
			agentId: "child-reader",
			parentActivityId: "workflow-1",
			name: "Reader",
		});
		const approval: PermissionMessage = {
			id: "approval-1",
			role: "permission",
			toolName: "mcp__hlid_obsidian__create_note",
			title: "Claude requests Create note",
			input: { path: "Notes/Review.md" },
			requester: {
				providerId: "claude",
				agentId: "child-reader",
			},
			policy: {
				source: "umbod",
				reason: "no matching rule",
			},
			decision: "pending",
		};
		render(
			<SubagentToolBlock
				subagent={snapshot({
					provider: "claude",
					agentId: "workflow-1",
					kind: "workflow",
					name: "Repository audit",
				})}
				childSubagents={[child]}
				pendingPermissions={[approval]}
				onDecidePermission={onDecide}
			/>,
		);

		const workflow = screen.getByRole("button", {
			name: /repository audit running/i,
		});
		expect(workflow.getAttribute("aria-expanded")).toBe("false");
		expect(
			screen.getByText("1 running / 0 done / 0 failed / 1 approval needed"),
		).toBeTruthy();
		expect(screen.getByText("Create note")).toBeTruthy();
		expect(screen.getByText("Reader")).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: /reader running/i }),
		).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Approve" }));
		expect(onDecide).toHaveBeenCalledWith("approval-1", true);
	});

	it("offers native resume only for an interrupted run and fresh rerun for completed scripts", () => {
		const onResume = vi.fn();
		const onRerun = vi.fn();
		const { rerender } = render(
			<SubagentToolBlock
				subagent={snapshot({
					provider: "claude",
					agentId: "workflow-1",
					kind: "workflow",
					name: "Repository audit",
					status: "interrupted",
					workflowRunId: "run-1",
					endedAtMs: 2_000,
				})}
				onResume={onResume}
				onRerun={onRerun}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: /repository audit interrupted/i }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Resume workflow" }));
		expect(onResume).toHaveBeenCalledOnce();

		rerender(
			<SubagentToolBlock
				subagent={snapshot({
					provider: "claude",
					agentId: "workflow-2",
					kind: "workflow",
					name: "Repository audit",
					status: "completed",
					workflowRunId: "run-2",
					workflowScriptPath: "/tmp/audit.js",
					endedAtMs: 2_000,
				})}
				onResume={onResume}
				onRerun={onRerun}
			/>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: /repository audit completed/i }),
		);
		expect(
			screen.queryByRole("button", { name: "Resume workflow" }),
		).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Rerun workflow" }));
		expect(onRerun).toHaveBeenCalledOnce();
	});
});
