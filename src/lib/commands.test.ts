import { describe, expect, it } from "vitest";
import {
	addCommandSelection,
	canSelectCommand,
	commandMatches,
	filterProviderCompatibleCommands,
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
	it("keeps only commands compatible with the active provider", () => {
		const neutral = skillCommand(skill);
		const claude = { ...neutral, id: "claude", providerId: "claude" };
		const codex = { ...neutral, id: "codex", providerId: "codex" };
		expect(
			filterProviderCompatibleCommands([neutral, claude, codex], "codex"),
		).toEqual([neutral, codex]);
		const compatible = [neutral, codex];
		expect(filterProviderCompatibleCommands(compatible, "codex")).toBe(
			compatible,
		);
	});

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

	it("matches slash commands without requiring accent marks", () => {
		const command = {
			...skillCommand(skill),
			name: "résumé",
		};
		expect(commandMatches(command, "resume")).toBe(true);
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
			text: "skills: /garden-check\n\nplease",
			skillContexts: [skill.filePath],
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

	it("keeps Hlid-managed skill imports provider-neutral", () => {
		const managed: Skill = {
			...skill,
			filePath: "/hlid/library/skills/garden-check/SKILL.md",
			source: "hlid",
		};
		const command = mergeCommands([managed], [], "codex")[0];
		expect(command).toMatchObject({
			source: "library",
			execution: { kind: "skill", filePath: managed.filePath },
		});
		expect(mergeCommands([managed], [], "claude")).toHaveLength(1);
	});

	it("shows provider-owned skills only for their provider", () => {
		const claudeSkill: Skill = {
			...skill,
			file: "kyle-voice/SKILL.md",
			name: "kyle-voice",
			filePath: "/home/kyle/.claude/skills/kyle-voice/SKILL.md",
			providerId: "claude",
		};
		expect(
			mergeCommands([skill, claudeSkill], [], "codex").map(
				(command) => command.name,
			),
		).toEqual(["garden-check"]);

		const commands = mergeCommands([skill, claudeSkill], [], "claude");
		const claude = commands.find((command) => command.name === "kyle-voice");
		expect(claude).toMatchObject({
			source: "provider",
			providerId: "claude",
			execution: { kind: "prompt" },
		});
		expect(
			resolveCommandSubmission(claude ?? null, "be concise", commands),
		).toEqual({
			text: "/kyle-voice be concise",
		});
	});

	it("deduplicates provider discovery against a preloaded provider skill", () => {
		const claudeSkill: Skill = {
			...skill,
			name: "kyle-voice",
			providerId: "claude",
		};
		const commands = mergeCommands(
			[claudeSkill],
			[
				{
					name: "kyle-voice",
					description: "Native Claude skill",
					argumentHint: "",
				},
			],
			"claude",
		);
		expect(
			commands.filter((command) => command.name === "kyle-voice"),
		).toHaveLength(1);
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

	it("composes multiple vault skills and Codex skill mentions", () => {
		const second = skillCommand({
			...skill,
			file: "release.md",
			name: "release",
			filePath: "/vault/skills/release.md",
		});
		const codex = mergeCommands(
			[],
			[
				{ name: "github", description: "GitHub", argumentHint: "" },
				{ name: "yeet", description: "Publish", argumentHint: "" },
			],
			"codex",
		);
		expect(
			resolveCommandSubmission(
				[skillCommand(skill), second, ...codex],
				"ship it",
				[skillCommand(skill), second, ...codex],
			),
		).toEqual({
			text: "$github $yeet skills: /garden-check /release\n\nship it",
			skillContexts: [skill.filePath, "/vault/skills/release.md"],
		});
	});

	it("caps Claude at six selections and ACP at one native command", () => {
		const claudeCommands = Array.from(
			{ length: 7 },
			(_, index) =>
				mergeCommands(
					[],
					[
						{
							name: `skill-${index}`,
							description: "",
							argumentHint: "",
						},
					],
					"claude",
				)[0],
		);
		expect(
			canSelectCommand(claudeCommands.slice(0, 6), claudeCommands[6], "claude"),
		).toBe(false);

		const acpCommands = claudeCommands.slice(0, 2).map((command, index) => ({
			...command,
			id: `provider:acp:test:${index}`,
			providerId: "acp:test",
		}));
		expect(canSelectCommand([acpCommands[0]], acpCommands[1], "acp:test")).toBe(
			false,
		);
		expect(
			addCommandSelection([acpCommands[0]], skillCommand(skill), "acp:test"),
		).toHaveLength(2);
	});
});
