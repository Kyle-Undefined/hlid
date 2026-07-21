// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as privacyStore from "#/hooks/privacyStore";
import type { ToolEventMessage } from "#/server/protocol";
import {
	ObsidianVaultChangeReview,
	obsidianVaultChanges,
} from "./ObsidianVaultChangeReview";

afterEach(cleanup);
beforeEach(() => privacyStore.__resetForTesting());

function event(
	id: string,
	name: string,
	input: Record<string, unknown>,
	result = '{"path":"Notes/Changed.md"}',
): ToolEventMessage {
	return { type: "tool_event", id, name, input, result };
}

describe("ObsidianVaultChangeReview", () => {
	it("collects successful mutations across provider tool naming formats", () => {
		const changes = obsidianVaultChanges([
			event(
				"capture",
				"mcp__hlid_obsidian__capture_note",
				{ content: "Captured body" },
				'{"path":"0 Inbox/Hlid capture.md","destination":"Inbox"}',
			),
			event(
				"create",
				"mcp__hlid_obsidian__create_note",
				{ path: "Notes/New.md", content: "Body" },
				'{"path":"Notes/New.md"}',
			),
			event(
				"append",
				"hlid_obsidian.append_note",
				{ target: "daily", content: "Daily body" },
				'{"path":"Journal/2026-07-20.md"}',
			),
			event(
				"move",
				"hlid_obsidian/move_file",
				{ path: "Notes/Old.md", to: "Archive/Old.md" },
				'{"path":"Archive/Old.md"}',
			),
			event(
				"command",
				"mcp__hlid_obsidian__run_command",
				{ id: "templater-obsidian:insert-templater" },
				'{"ok":true,"id":"templater-obsidian:insert-templater","activeBefore":"Notes/Before.md","activeAfter":"Notes/After.md"}',
			),
			event(
				"base",
				"mcp__hlid_obsidian__base_create",
				{
					path: "Projects.base",
					name: "New item",
					content: "# New item",
				},
				'{"basePath":"Projects.base","name":"New item"}',
			),
			event(
				"task",
				"mcp__hlid_obsidian__task_update",
				{ path: "Notes/New.md", line: 8, action: "done" },
				'{"path":"Notes/New.md","line":8,"action":"done"}',
			),
			event(
				"property",
				"mcp__hlid_obsidian__property_set",
				{
					path: "Notes/New.md",
					name: "status",
					type: "text",
					value: "Active",
				},
				'{"path":"Notes/New.md","name":"status","type":"text","value":"Active"}',
			),
			{
				...event("failed", "hlid_obsidian:rename_file", {
					path: "Notes/Old.md",
					name: "New.md",
				}),
				isError: true,
			},
			event("read", "mcp__hlid_obsidian__read_note", {
				path: "Notes/New.md",
			}),
		]);

		expect(changes).toEqual([
			{
				id: "capture",
				kind: "created",
				path: "0 Inbox/Hlid capture.md",
				content: "Captured body",
			},
			{
				id: "create",
				kind: "created",
				path: "Notes/New.md",
				content: "Body",
			},
			{
				id: "append",
				kind: "appended",
				path: "Journal/2026-07-20.md",
				content: "Daily body",
			},
			{
				id: "move",
				kind: "moved",
				path: "Archive/Old.md",
				from: "Notes/Old.md",
			},
			{
				id: "command",
				kind: "command",
				commandId: "templater-obsidian:insert-templater",
				activeBefore: "Notes/Before.md",
				activeAfter: "Notes/After.md",
			},
			{
				id: "base",
				kind: "base",
				summary: "New item via Projects.base",
				content: "# New item",
			},
			{
				id: "task",
				kind: "task",
				path: "Notes/New.md",
				summary: "Notes/New.md:8 · done",
			},
			{
				id: "property",
				kind: "property-set",
				path: "Notes/New.md",
				summary: 'Notes/New.md · status = "Active"',
			},
		]);
	});

	it("renders task, property, and Base activity without verification claims", () => {
		render(
			<ObsidianVaultChangeReview
				toolEvents={[
					event(
						"base",
						"mcp__hlid_obsidian__base_create",
						{ path: "Projects.base", name: "New item" },
						'{"basePath":"Projects.base","name":"New item"}',
					),
					event(
						"task",
						"mcp__hlid_obsidian__task_update",
						{ path: "Notes/New.md", line: 8, action: "done" },
						'{"path":"Notes/New.md","line":8,"action":"done"}',
					),
					event(
						"property",
						"mcp__hlid_obsidian__property_remove",
						{ path: "Notes/New.md", name: "status" },
						'{"path":"Notes/New.md","name":"status"}',
					),
				]}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: /vault activity.*3/i }));
		expect(screen.getByText("New item via Projects.base")).toBeTruthy();
		expect(screen.getByText("Notes/New.md:8 · done")).toBeTruthy();
		expect(screen.getByText("Notes/New.md · removed status")).toBeTruthy();
		expect(screen.queryByText(/verified/i)).toBeNull();
	});

	it("shows a compact per-turn review with paths and added-content previews", () => {
		render(
			<ObsidianVaultChangeReview
				toolEvents={[
					event("append", "mcp__hlid_obsidian__append_note", {
						target: "path",
						path: "Notes/Changed.md",
						content: "First line\nSecond line",
					}),
					event(
						"command",
						"mcp__hlid_obsidian__run_command",
						{ id: "templater-obsidian:insert-templater" },
						JSON.stringify({
							type: "dynamicToolCall",
							contentItems: [
								{
									type: "inputText",
									text: JSON.stringify({
										ok: true,
										id: "templater-obsidian:insert-templater",
										activeBefore: "Notes/Active.md",
										activeAfter: "Notes/Active.md",
									}),
								},
							],
						}),
					),
				]}
			/>,
		);

		const toggle = screen.getByRole("button", { name: /vault activity.*2/i });
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(toggle);
		expect(screen.getByText("Notes/Changed.md")).toBeTruthy();
		expect(screen.getByText(/\+ First line/)).toBeTruthy();
		expect(
			screen.getByText("templater-obsidian:insert-templater"),
		).toBeTruthy();
		expect(screen.getByText("Active note when run")).toBeTruthy();
		expect(screen.getByText("Notes/Active.md")).toBeTruthy();
		expect(
			screen.getByText("Commands may affect other vault files."),
		).toBeTruthy();
		expect(
			screen.getByRole("button", {
				name: "Open Notes/Changed.md in Obsidian",
			}),
		).toBeTruthy();
		expect(
			screen.getByRole("button", {
				name: "Open Notes/Active.md in Obsidian",
			}),
		).toBeTruthy();
	});

	it("shows active-note transitions without claiming a complete diff", () => {
		render(
			<ObsidianVaultChangeReview
				toolEvents={[
					event(
						"command",
						"run_command",
						{ id: "daily-notes" },
						'{"ok":true,"id":"daily-notes","activeBefore":"0 Inbox/Test.md","activeAfter":"0 Inbox/2026-07-20.md"}',
					),
				]}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: /vault activity.*1/i }));
		expect(screen.getByText("Active before")).toBeTruthy();
		expect(screen.getByText("0 Inbox/Test.md")).toBeTruthy();
		expect(screen.getByText("Active after")).toBeTruthy();
		expect(screen.getByText("0 Inbox/2026-07-20.md")).toBeTruthy();
		expect(screen.queryByText(/affected files unknown/i)).toBeNull();
	});

	it("does not render when the turn made no successful vault changes", () => {
		const { container } = render(
			<ObsidianVaultChangeReview
				toolEvents={[
					{
						type: "tool_event",
						id: "pending",
						name: "mcp__hlid_obsidian__create_note",
						input: { path: "Notes/New.md" },
					},
				]}
			/>,
		);
		expect(container.innerHTML).toBe("");
	});
});
