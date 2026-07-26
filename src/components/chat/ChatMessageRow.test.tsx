// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentSnapshot } from "#/server/agentProvider";
import { ChatMessageRow } from "./ChatMessageRow";
import type { PermissionMessage } from "./chatReducer";

afterEach(cleanup);

const permission: PermissionMessage = {
	id: "approval-1",
	role: "permission",
	toolName: "Bash",
	title: "Claude requests Shell command",
	requester: {
		providerId: "claude",
		agentId: "child-1",
	},
	decision: "pending",
};

function renderRow(
	overrides: Partial<Parameters<typeof ChatMessageRow>[0]> = {},
) {
	return render(
		<ChatMessageRow
			message={permission}
			permissionLabels={new Map()}
			queueState={undefined}
			onDecide={vi.fn()}
			onSubmitAnswers={vi.fn()}
			onPlanDecide={vi.fn()}
			onCancelQueued={vi.fn()}
			onPromoteQueued={vi.fn()}
			onSteerQueued={vi.fn()}
			canSteerQueued={false}
			{...overrides}
		/>,
	);
}

describe("ChatMessageRow permission placement", () => {
	it("does not duplicate a pending approval embedded in a workflow", () => {
		const { container } = renderRow({
			embeddedPermissionIds: new Set(["approval-1"]),
		});
		expect(container.innerHTML).toBe("");
	});

	it("enriches a standalone approval with the matching subagent", () => {
		const subagent: SubagentSnapshot = {
			provider: "claude",
			agentId: "child-1",
			name: "Reader",
			status: "running",
			currentStep: "Inspecting the vault",
			startedAtMs: 1,
		};
		renderRow({
			requesterSubagents: new Map([["claude:child-1", subagent]]),
		});
		expect(screen.getByText("Reader")).toBeTruthy();
		expect(screen.getByText("Inspecting the vault")).toBeTruthy();
	});
});
