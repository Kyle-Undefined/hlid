// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PermissionMessage } from "./chatReducer";
import { PermissionCard } from "./PermissionCard";

afterEach(cleanup);

function permission(
	overrides: Partial<PermissionMessage> = {},
): PermissionMessage {
	return {
		id: "permission-1",
		role: "permission",
		toolName: "Bash",
		title: "Run command?",
		decision: "pending",
		...overrides,
	};
}

describe("PermissionCard", () => {
	it("renders completed approvals and denials", () => {
		const { rerender } = render(
			<PermissionCard
				message={permission({ decision: "approved_session" })}
				onDecide={vi.fn()}
			/>,
		);
		expect(screen.getByText(/BASH APPROVED FOR SESSION/)).not.toBeNull();
		rerender(
			<PermissionCard
				message={permission({ decision: "denied", displayName: "Shell" })}
				onDecide={vi.fn()}
			/>,
		);
		expect(screen.getByText(/SHELL DENIED/)).not.toBeNull();
	});

	it("emits every pending decision and redirects with an instruction", () => {
		const onDecide = vi.fn();
		render(
			<PermissionCard
				message={permission({
					description: "Needed for setup",
					input: { command: "bun test" },
				})}
				onDecide={onDecide}
			/>,
		);
		expect(screen.getByText("bun test")).not.toBeNull();
		expect(screen.getByText("Needed for setup")).not.toBeNull();
		fireEvent.click(screen.getByLabelText("Deny"));
		fireEvent.click(screen.getByLabelText("Approve"));
		fireEvent.click(screen.getByLabelText("Approve for this session"));
		fireEvent.click(screen.getByLabelText("Approve always"));
		const input = screen.getByPlaceholderText(
			"Tell Claude what to do instead…",
		);
		fireEvent.change(input, { target: { value: " use a safer command " } });
		fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
		fireEvent.click(screen.getByLabelText("Deny with instruction"));

		expect(onDecide).toHaveBeenCalledWith("permission-1", false);
		expect(onDecide).toHaveBeenCalledWith("permission-1", true);
		expect(onDecide).toHaveBeenCalledWith("permission-1", true, "session");
		expect(onDecide).toHaveBeenCalledWith("permission-1", true, "local");
		expect(onDecide).toHaveBeenCalledWith(
			"permission-1",
			false,
			undefined,
			"use a safer command",
		);
	});

	it("falls back to the first string input preview", () => {
		render(
			<PermissionCard
				message={permission({ input: { count: 2, target: "/tmp/output" } })}
				onDecide={vi.fn()}
			/>,
		);
		expect(screen.getByText("/tmp/output")).not.toBeNull();
	});
});
