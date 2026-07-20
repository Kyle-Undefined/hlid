import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
	MAX_OBSIDIAN_AGENT_OUTPUT_CHARS: 120_000,
	MAX_OBSIDIAN_APPEND_CHARS: 20_000,
	MAX_OBSIDIAN_CREATE_CHARS: 20_000,
	createObsidianBaseItem: vi.fn(),
	createObsidianNote: vi.fn(),
	executeObsidianCommand: vi.fn(),
	listObsidianTemplates: vi.fn(),
	mutateObsidianNote: vi.fn(),
	moveObsidianFile: vi.fn(),
	queryObsidianBase: vi.fn(),
	queryObsidianCurrentNote: vi.fn(),
	queryObsidianHistory: vi.fn(),
	queryObsidianLinks: vi.fn(),
	queryObsidianProperties: vi.fn(),
	queryObsidianSearch: vi.fn(),
	queryObsidianTasks: vi.fn(),
	queryObsidianVaultInfo: vi.fn(),
	readObsidianNote: vi.fn(),
	readObsidianTemplate: vi.fn(),
	removeObsidianProperty: vi.fn(),
	renameObsidianFile: vi.fn(),
	setObsidianProperty: vi.fn(),
	updateObsidianTask: vi.fn(),
}));

const config = vi.hoisted(() => ({
	vault: {
		name: "Fornbok",
		obsidian_command_allowlist: ["templater-obsidian:insert-templater"],
	},
}));
vi.mock("./config", () => ({ loadConfig: () => config }));
vi.mock("./obsidianCli", () => bridge);

import {
	executeObsidianAgentTool,
	OBSIDIAN_AGENT_TOOL_SPECS,
} from "./obsidianAgentTools";

describe("Obsidian agent tools", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		for (const fn of Object.values(bridge)) {
			if (typeof fn === "function") fn.mockResolvedValue("[]");
		}
	});

	it("publishes curated vault reads and non-destructive note writes", () => {
		expect(OBSIDIAN_AGENT_TOOL_SPECS.map((tool) => tool.name)).toEqual([
			"vault_info",
			"search",
			"read_note",
			"current_note",
			"links",
			"tasks",
			"properties",
			"base_query",
			"history",
			"list_templates",
			"read_template",
			"create_note",
			"base_create",
			"append_note",
			"prepend_note",
			"task_update",
			"property_set",
			"property_remove",
			"move_file",
			"rename_file",
			"run_command",
		]);
		expect(
			JSON.stringify(
				OBSIDIAN_AGENT_TOOL_SPECS.filter((tool) => tool.readOnly).map(
					(tool) => ({
						name: tool.name,
						schema: tool.inputSchema,
					}),
				),
			),
		).not.toMatch(/restore|eval|install|write/i);
		for (const tool of OBSIDIAN_AGENT_TOOL_SPECS.filter(
			(tool) =>
				tool.readOnly &&
				tool.name !== "read_template" &&
				tool.name !== "vault_info",
		)) {
			expect(tool.inputSchema.properties).toMatchObject({
				limit: { type: "integer", minimum: 1, maximum: 200 },
				countOnly: { type: "boolean" },
			});
		}
		expect(
			OBSIDIAN_AGENT_TOOL_SPECS.filter((tool) => !tool.readOnly).map(
				(tool) => tool.name,
			),
		).toEqual([
			"create_note",
			"base_create",
			"append_note",
			"prepend_note",
			"task_update",
			"property_set",
			"property_remove",
			"move_file",
			"rename_file",
			"run_command",
		]);
	});

	it("reports the native vault connection and reads one exact note", async () => {
		bridge.queryObsidianVaultInfo.mockResolvedValueOnce({
			name: "Fornbok",
			version: "1.12.7",
			activeNote: "Notes/Current.md",
		});
		const info = await executeObsidianAgentTool("vault_info", {});
		expect(info).toContain('"name":"Fornbok"');
		expect(info).toContain(
			'"allowedCommands":["templater-obsidian:insert-templater"]',
		);

		bridge.readObsidianNote.mockResolvedValueOnce(
			["one", "two", "three", "four"].join("\n"),
		);
		const output = JSON.parse(
			await executeObsidianAgentTool("read_note", {
				path: "Notes/One.md",
				startLine: 2,
				limit: 2,
			}),
		);
		expect(output).toMatchObject({
			total: 4,
			returned: 2,
			truncated: true,
			data: ["two", "three"],
		});
		expect(bridge.readObsidianNote).toHaveBeenCalledWith(
			"Fornbok",
			"Notes/One.md",
		);
	});

	it("lists, reads, creates, and updates notes through the shared bridge", async () => {
		bridge.listObsidianTemplates.mockResolvedValueOnce("New Note\nNew Project");
		expect(
			JSON.parse(
				await executeObsidianAgentTool("list_templates", { limit: 1 }),
			),
		).toMatchObject({ total: 2, returned: 1, data: ["New Note"] });
		expect(bridge.listObsidianTemplates).toHaveBeenCalledWith("Fornbok", false);

		bridge.readObsidianTemplate.mockResolvedValueOnce("# <% tp.file.title %>");
		expect(
			JSON.parse(
				await executeObsidianAgentTool("read_template", {
					name: "New Note",
				}),
			),
		).toMatchObject({ returned: 1, data: ["# <% tp.file.title %>"] });

		bridge.createObsidianNote.mockResolvedValueOnce({
			path: "0 Inbox/One.md",
		});
		await expect(
			executeObsidianAgentTool("create_note", {
				path: "0 Inbox/One.md",
				template: "New Note",
			}),
		).resolves.toBe('{"path":"0 Inbox/One.md"}');

		bridge.createObsidianBaseItem.mockResolvedValueOnce({
			basePath: "Projects.base",
			view: "Active",
			name: "One",
		});
		await executeObsidianAgentTool("base_create", {
			path: "Projects.base",
			view: "Active",
			name: "One",
		});
		expect(bridge.createObsidianBaseItem).toHaveBeenCalledWith("Fornbok", {
			path: "Projects.base",
			view: "Active",
			name: "One",
		});

		bridge.mutateObsidianNote.mockResolvedValue({ path: "Notes/One.md" });
		await executeObsidianAgentTool("append_note", {
			target: "path",
			path: "Notes/One.md",
			content: "Body",
		});
		expect(bridge.mutateObsidianNote).toHaveBeenCalledWith(
			"Fornbok",
			"append",
			expect.objectContaining({ content: "Body" }),
		);

		bridge.updateObsidianTask.mockResolvedValueOnce({
			path: "Notes/One.md",
			line: 8,
			action: "done",
		});
		await executeObsidianAgentTool("task_update", {
			path: "Notes/One.md",
			line: 8,
			action: "done",
		});
		expect(bridge.updateObsidianTask).toHaveBeenCalledWith("Fornbok", {
			path: "Notes/One.md",
			line: 8,
			action: "done",
		});

		bridge.setObsidianProperty.mockResolvedValueOnce({
			path: "Notes/One.md",
			name: "status",
			type: "text",
			value: "Active",
		});
		await executeObsidianAgentTool("property_set", {
			path: "Notes/One.md",
			name: "status",
			type: "text",
			value: "Active",
		});
		expect(bridge.setObsidianProperty).toHaveBeenCalledWith("Fornbok", {
			path: "Notes/One.md",
			name: "status",
			type: "text",
			value: "Active",
		});

		bridge.removeObsidianProperty.mockResolvedValueOnce({
			path: "Notes/One.md",
			name: "status",
		});
		await executeObsidianAgentTool("property_remove", {
			path: "Notes/One.md",
			name: "status",
		});
		expect(bridge.removeObsidianProperty).toHaveBeenCalledWith("Fornbok", {
			path: "Notes/One.md",
			name: "status",
		});

		bridge.moveObsidianFile.mockResolvedValue({ path: "Archive/One.md" });
		await executeObsidianAgentTool("move_file", {
			path: "Notes/One.md",
			to: "Archive/One.md",
		});
		expect(bridge.moveObsidianFile).toHaveBeenCalledWith("Fornbok", {
			path: "Notes/One.md",
			to: "Archive/One.md",
		});

		bridge.renameObsidianFile.mockResolvedValue({ path: "Notes/Renamed.md" });
		await executeObsidianAgentTool("rename_file", {
			path: "Notes/One.md",
			name: "Renamed.md",
		});
		expect(bridge.renameObsidianFile).toHaveBeenCalledWith("Fornbok", {
			path: "Notes/One.md",
			name: "Renamed.md",
		});

		await executeObsidianAgentTool("run_command", {
			id: "templater-obsidian:insert-templater",
		});
		expect(bridge.executeObsidianCommand).toHaveBeenCalledWith(
			"Fornbok",
			"templater-obsidian:insert-templater",
		);
	});

	it("rejects Obsidian commands outside the workspace allowlist", async () => {
		await expect(
			executeObsidianAgentTool("run_command", {
				id: "workspace:delete",
			}),
		).rejects.toThrow("not allowed");
		expect(bridge.executeObsidianCommand).not.toHaveBeenCalled();
	});

	it("searches indexed vault text with bounded path and context results", async () => {
		bridge.queryObsidianSearch.mockResolvedValueOnce(
			"Notes/One.md:4: ship it\nNotes/Two.md:9: ship it",
		);
		const output = JSON.parse(
			await executeObsidianAgentTool("search", {
				query: "ship it",
				path: "Notes",
				context: true,
				limit: 1,
			}),
		);

		expect(output).toMatchObject({
			sourceFormat: "text",
			total: 2,
			returned: 1,
			truncated: true,
			data: ["Notes/One.md:4: ship it"],
		});
		expect(bridge.queryObsidianSearch).toHaveBeenCalledWith("Fornbok", {
			query: "ship it",
			path: "Notes",
			context: true,
			limit: 1,
		});
	});

	it("passes explicit graph-aware searches through the curated search tool", async () => {
		bridge.queryObsidianSearch.mockResolvedValueOnce(
			JSON.stringify([
				{
					path: "Notes/Related.md",
					sources: ["backlink"],
					relatedTo: ["Notes/One.md"],
				},
			]),
		);
		const output = JSON.parse(
			await executeObsidianAgentTool("search", {
				query: "One",
				includeGraph: true,
				limit: 20,
			}),
		);

		expect(output.data).toEqual([
			{
				path: "Notes/Related.md",
				sources: ["backlink"],
				relatedTo: ["Notes/One.md"],
			},
		]);
		expect(bridge.queryObsidianSearch).toHaveBeenCalledWith("Fornbok", {
			query: "One",
			includeGraph: true,
			limit: 20,
		});
	});

	it("reads and outlines the note currently active in Obsidian", async () => {
		bridge.queryObsidianCurrentNote.mockResolvedValueOnce("# One\nBody");
		const note = JSON.parse(
			await executeObsidianAgentTool("current_note", {
				action: "read",
				limit: 1,
			}),
		);
		expect(note).toMatchObject({
			sourceFormat: "text",
			total: 2,
			returned: 1,
			truncated: true,
			data: ["# One"],
		});

		bridge.queryObsidianCurrentNote.mockResolvedValueOnce(
			JSON.stringify([{ heading: "One", level: 1 }]),
		);
		const outline = JSON.parse(
			await executeObsidianAgentTool("current_note", { action: "outline" }),
		);
		expect(outline).toMatchObject({
			sourceFormat: "json",
			total: 1,
			returned: 1,
			data: [{ heading: "One", level: 1 }],
		});
	});

	it("does not mistake numeric current-note content for a native count", async () => {
		bridge.queryObsidianCurrentNote.mockResolvedValueOnce("123");
		const output = JSON.parse(
			await executeObsidianAgentTool("current_note", {
				action: "read",
				countOnly: true,
			}),
		);
		expect(output).toMatchObject({ total: 1, returned: 0, countOnly: true });
	});

	it("validates and dispatches a graph query to the configured vault", async () => {
		const output = await executeObsidianAgentTool("links", {
			kind: "backlinks",
			path: "Notes/One.md",
		});
		expect(JSON.parse(output)).toEqual({
			sourceFormat: "json",
			total: 0,
			returned: 0,
			truncated: false,
			countOnly: false,
			data: [],
		});
		expect(bridge.queryObsidianLinks).toHaveBeenCalledWith("Fornbok", {
			kind: "backlinks",
			path: "Notes/One.md",
		});
	});

	it("returns a valid bounded envelope for broad structured queries", async () => {
		bridge.queryObsidianTasks.mockResolvedValueOnce(
			JSON.stringify(Array.from({ length: 75 }, (_, index) => ({ index }))),
		);
		const output = await executeObsidianAgentTool("tasks", { limit: 2 });

		expect(JSON.parse(output)).toEqual({
			sourceFormat: "json",
			total: 75,
			returned: 2,
			truncated: true,
			countOnly: false,
			data: [{ index: 0 }, { index: 1 }],
		});
	});

	it("defaults broad queries to fifty results", async () => {
		bridge.queryObsidianTasks.mockResolvedValueOnce(
			JSON.stringify(Array.from({ length: 75 }, (_, index) => ({ index }))),
		);
		const output = JSON.parse(await executeObsidianAgentTool("tasks", {}));

		expect(output).toMatchObject({
			total: 75,
			returned: 50,
			truncated: true,
		});
		expect(output.data).toHaveLength(50);
	});

	it("uses native totals without returning the matching task payload", async () => {
		bridge.queryObsidianTasks.mockResolvedValueOnce("494");
		const output = await executeObsidianAgentTool("tasks", {
			state: "todo",
			countOnly: true,
		});

		expect(JSON.parse(output)).toEqual({
			sourceFormat: "text",
			total: 494,
			returned: 0,
			truncated: false,
			countOnly: true,
		});
		expect(bridge.queryObsidianTasks).toHaveBeenCalledWith("Fornbok", {
			state: "todo",
			countOnly: true,
		});
	});

	it("bounds JSON objects and plain-text history with the same metadata", async () => {
		bridge.queryObsidianProperties.mockResolvedValueOnce(
			JSON.stringify({ status: 4, owner: 3, due: 2 }),
		);
		const properties = JSON.parse(
			await executeObsidianAgentTool("properties", { limit: 1 }),
		);
		expect(properties).toMatchObject({
			sourceFormat: "json",
			total: 3,
			returned: 1,
			truncated: true,
			data: { status: 4 },
		});

		bridge.queryObsidianHistory.mockResolvedValueOnce("one\ntwo\nthree");
		const history = JSON.parse(
			await executeObsidianAgentTool("history", {
				action: "files",
				limit: 2,
			}),
		);
		expect(history).toMatchObject({
			sourceFormat: "text",
			total: 3,
			returned: 2,
			truncated: true,
			data: ["one", "two"],
		});
	});

	it("keeps the envelope valid when one result exceeds the character budget", async () => {
		bridge.queryObsidianTasks.mockResolvedValueOnce(
			JSON.stringify([{ body: "x".repeat(130_000) }]),
		);
		const output = await executeObsidianAgentTool("tasks", { limit: 1 });
		const parsed = JSON.parse(output);

		expect(output.length).toBeLessThan(1_000);
		expect(parsed).toMatchObject({
			total: 1,
			returned: 0,
			truncated: true,
			data: [],
		});
		expect(parsed.notice).toContain("Narrow the query");
	});

	it("rejects incomplete JSON instead of forwarding a broken payload", async () => {
		bridge.queryObsidianTasks.mockResolvedValueOnce('[{"task":');
		await expect(executeObsidianAgentTool("tasks", {})).rejects.toThrow(
			"incomplete structured output",
		);
	});

	it("rejects unknown tools and invalid inputs before calling the bridge", async () => {
		await expect(
			executeObsidianAgentTool("history", { action: "restore" }),
		).rejects.toThrow();
		await expect(executeObsidianAgentTool("raw_cli", {})).rejects.toThrow(
			"Unknown Hlid Obsidian tool",
		);
		await expect(
			executeObsidianAgentTool("tasks", { limit: 201 }),
		).rejects.toThrow();
		expect(bridge.queryObsidianHistory).not.toHaveBeenCalled();
	});
});
