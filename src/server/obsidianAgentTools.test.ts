import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
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
		for (const fn of Object.values(bridge)) fn.mockResolvedValue("result");
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
	});

	it("validates and dispatches a graph query to the configured vault", async () => {
		await expect(
			executeObsidianAgentTool("links", {
				kind: "backlinks",
				path: "Notes/One.md",
			}),
		).resolves.toBe("result");
		expect(bridge.queryObsidianLinks).toHaveBeenCalledWith("Fornbok", {
			kind: "backlinks",
			path: "Notes/One.md",
		});
	});

	it("rejects unknown tools and invalid inputs before calling the bridge", async () => {
		await expect(
			executeObsidianAgentTool("history", { action: "restore" }),
		).rejects.toThrow();
		await expect(executeObsidianAgentTool("raw_cli", {})).rejects.toThrow(
			"Unknown Hlid Obsidian tool",
		);
		expect(bridge.queryObsidianHistory).not.toHaveBeenCalled();
	});
});
