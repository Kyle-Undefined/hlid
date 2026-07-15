import { describe, expect, it } from "vitest";
import {
	commandMatches,
	mergeCommands,
	resolveCommandSubmission,
	skillCommand,
} from "./commands";
import type { Skill } from "./skills";

const skill: Skill = {
	file: "garden-check.md",
	name: "garden-check",
	description: "Check the garden",
	content: "",
	filePath: "/vault/skills/garden-check.md",
	section: "vault",
};

describe("commands", () => {
	it("keeps vault, provider, and Hlid actions distinct", () => {
		const commands = mergeCommands(
			[skill],
			[
				{
					name: "explain",
					description: "Explain context",
					argumentHint: "",
					aliases: ["why"],
				},
				{
					name: "review",
					description: "Review changes",
					argumentHint: "[instructions]",
					action: "review",
				},
			],
			"codex",
		);
		expect(commands.map(({ source }) => source)).toEqual([
			"vault",
			"provider",
			"hlid",
		]);
		expect(commandMatches(commands[1], "wh")).toBe(true);
	});

	it("omits controls already owned by the UI", () => {
		const commands = mergeCommands(
			[],
			[
				{ name: "model", description: "Model", argumentHint: "" },
				{ name: "mcp", description: "MCP", argumentHint: "" },
				{ name: "explain", description: "Explain", argumentHint: "" },
			],
		);
		expect(commands.map(({ name }) => name)).toEqual(["explain"]);
	});

	it("resolves vault skills to context and provider commands to prompts", () => {
		const vault = skillCommand(skill);
		expect(resolveCommandSubmission(vault, "please", [vault])).toEqual({
			text: "please",
			skillContext: skill.filePath,
		});
		const provider = mergeCommands(
			[],
			[
				{
					name: "explain",
					description: "Explain",
					argumentHint: "",
				},
			],
		)[0];
		expect(resolveCommandSubmission(provider, "", [provider])).toEqual({
			text: "/explain",
		});
	});

	it("resolves review as a capability action", () => {
		const review = mergeCommands(
			[],
			[
				{
					name: "review",
					description: "Review",
					argumentHint: "[instructions]",
					action: "review",
				},
			],
			"codex",
		)[0];
		expect(resolveCommandSubmission(review, "focus on auth", [review])).toEqual(
			{
				text: "/review focus on auth",
				commandAction: "review",
			},
		);
		expect(
			resolveCommandSubmission(null, "/review focus on auth", [
				skillCommand({ ...skill, name: "review" }),
				review,
			]),
		).toEqual({
			text: "/review focus on auth",
			commandAction: "review",
		});
	});

	it("resolves computer-use as a namespaced Hlid capability action", () => {
		const computerUse = mergeCommands(
			[],
			[
				{
					name: "computer-use",
					description: "Use the Windows desktop",
					argumentHint: "<task>",
					action: "computer-use",
				},
			],
			"codex",
		)[0];
		expect(
			resolveCommandSubmission(computerUse, "open Calculator", [computerUse]),
		).toEqual({
			text: "/computer-use open Calculator",
			commandAction: "computer-use",
		});
	});
});
