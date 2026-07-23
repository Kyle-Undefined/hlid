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

	it("shows the active note for an Obsidian command approval", () => {
		render(
			<PermissionCard
				message={permission({
					toolName: "mcp__hlid_obsidian__run_command",
					displayName: "Obsidian command",
					input: {
						id: "app:delete-file",
						activeNote: "1 Projects/Hlid/Current plan.md",
					},
				})}
				onDecide={vi.fn()}
			/>,
		);

		expect(screen.getByText("Active note")).not.toBeNull();
		expect(screen.getByText("1 Projects/Hlid/Current plan.md")).not.toBeNull();
		expect(screen.getByText("app:delete-file")).not.toBeNull();
	});

	it("makes native Computer Use app identity and Always scope explicit", () => {
		render(
			<PermissionCard
				message={permission({
					toolName:
						"hlid.windows_computer_use:process:C:\\Program Files\\Brave\\brave.exe",
					title: "Allow Codex to use Brave?",
					input: {
						task: "Check the active window",
						appName: "Brave",
						appId: "process:C:\\Program Files\\Brave\\brave.exe",
					},
				})}
				onDecide={vi.fn()}
			/>,
		);

		expect(screen.getByText("Application")).not.toBeNull();
		expect(screen.getByText("Brave")).not.toBeNull();
		expect(
			screen.getByText("process:C:\\Program Files\\Brave\\brave.exe"),
		).not.toBeNull();
		expect(
			screen.getByText("Always applies only to this application."),
		).not.toBeNull();
		expect(screen.queryByText("Check the active window")).toBeNull();
	});

	it("hides permanent approval when policy owns persistence", () => {
		render(
			<PermissionCard
				message={permission({ allowAlways: false })}
				onDecide={vi.fn()}
			/>,
		);
		expect(screen.queryByLabelText("Approve always")).toBeNull();
		expect(screen.getByLabelText("Approve for this session")).not.toBeNull();
	});

	it("hides one-time approval when the native app needs a durable scope", () => {
		render(
			<PermissionCard
				message={permission({ allowOnce: false })}
				onDecide={vi.fn()}
			/>,
		);
		expect(screen.queryByLabelText("Approve")).toBeNull();
		expect(screen.getByLabelText("Approve for this session")).not.toBeNull();
		expect(
			screen.getByLabelText("Approve for this session").className,
		).toContain("border-b");
		const always = screen.getByLabelText("Approve always");
		expect(always.className).toContain("col-span-2");
		expect(always.className).toContain("sm:col-span-1");
	});
});
