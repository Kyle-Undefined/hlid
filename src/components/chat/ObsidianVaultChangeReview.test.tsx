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
				'{"ok":true,"id":"templater-obsidian:insert-templater"}',
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
			},
		]);
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
						'{"ok":true,"id":"templater-obsidian:insert-templater"}',
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
		expect(screen.getByText("Affected files unknown")).toBeTruthy();
		expect(
			screen.getByRole("button", {
				name: "Open Notes/Changed.md in Obsidian",
			}),
		).toBeTruthy();
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
