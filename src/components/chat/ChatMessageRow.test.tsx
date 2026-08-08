// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentSnapshot } from "#/server/agentProvider";
import { ChatMessageRow } from "./ChatMessageRow";
import type {
	AssistantMessage,
	PermissionMessage,
	UserMessage,
} from "./chatReducer";

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

	it("keeps human approval and a provider block visible despite fold metadata", () => {
		renderRow({
			message: {
				...permission,
				decision: "approved_session",
				providerOutcome: "blocked",
				providerId: "claude",
			},
			permissionLabels: new Map([[permission.id, "APPROVED FOR SESSION"]]),
			embeddedPermissionIds: new Set([permission.id]),
		});

		expect(screen.getByText(/SHELL COMMAND APPROVED FOR SESSION/)).toBeTruthy();
		expect(
			screen.getByText(/SHELL COMMAND BLOCKED\/PROVIDER-REPORTED/),
		).toBeTruthy();
	});
});

describe("ChatMessageRow steering placement", () => {
	it("forwards accepted steers into the assistant row instead of a user row", () => {
		const assistant: AssistantMessage = {
			id: "assistant-1",
			role: "assistant",
			turnId: "original-turn",
			text: "Agent final response",
			toolEvents: [
				{
					type: "tool_event",
					id: "tool-before",
					name: "Read",
					input: { path: "/before" },
				},
			],
			streaming: true,
			cost: null,
		};
		const steer: UserMessage = {
			id: "steer-1",
			role: "user",
			text: "Change direction",
			steerTargetTurnId: "original-turn",
			steerToolEventIndex: 1,
		};
		const { container } = renderRow({
			message: assistant,
			acceptedSteers: [steer],
		});
		const firstTool = screen.getByRole("button", {
			name: /^Read path: \/before/,
		});
		const receipt = container.querySelector("[data-steer-receipt='steer-1']");
		const agentText = screen.getByText("Agent final response");
		expect(receipt).not.toBeNull();
		expect(
			firstTool.compareDocumentPosition(receipt as Element) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			(receipt as Element).compareDocumentPosition(agentText) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});
});
