import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
	MAX_OBSIDIAN_AGENT_OUTPUT_CHARS: 120_000,
	queryObsidianBase: vi.fn(),
	queryObsidianHistory: vi.fn(),
	queryObsidianLinks: vi.fn(),
	queryObsidianProperties: vi.fn(),
	queryObsidianTasks: vi.fn(),
}));

vi.mock("./config", () => ({
	loadConfig: () => ({ vault: { name: "Fornbok" } }),
}));
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

	it("publishes only the five curated read-only capabilities", () => {
		expect(OBSIDIAN_AGENT_TOOL_SPECS.map((tool) => tool.name)).toEqual([
			"links",
			"tasks",
			"properties",
			"base_query",
			"history",
		]);
		expect(
			JSON.stringify(
				OBSIDIAN_AGENT_TOOL_SPECS.map((tool) => ({
					name: tool.name,
					schema: tool.inputSchema,
				})),
			),
		).not.toMatch(/restore|eval|install|write/i);
		for (const tool of OBSIDIAN_AGENT_TOOL_SPECS) {
			expect(tool.inputSchema.properties).toMatchObject({
				limit: { type: "integer", minimum: 1, maximum: 200 },
				countOnly: { type: "boolean" },
			});
		}
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
