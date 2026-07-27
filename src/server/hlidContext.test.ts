import { describe, expect, it } from "vitest";
import {
	HLID_AGENT_TOOL_COUNT,
	HLID_OBSIDIAN_TOOL_COUNT,
	type HlidPromptContextManifest,
} from "../lib/hlidContext";
import {
	finalizeHlidTurnContextManifest,
	hlidToolLoadingSummary,
} from "./hlidContext";

const promptManifest: HlidPromptContextManifest = {
	contractVersion: 1,
	userMessageChars: 5,
	promptChars: 15,
	hlidAddedChars: 10,
	estimatedHlidTokens: 3,
	blocks: [],
	agentMode: "cwd",
	skills: [],
	attachments: [],
	vaultReferences: [],
	workspaceReferences: [],
	planHtml: false,
};

describe("Hlid context manifest", () => {
	it.each([
		"claude",
		"cliproxy-codex",
		"codex",
		"cliproxy:codex",
	])("reports deferred Hlid schemas for the %s runtime", (providerId) => {
		expect(hlidToolLoadingSummary(providerId)).toEqual([
			{
				namespace: "hlid",
				total: HLID_AGENT_TOOL_COUNT,
				deferred: HLID_AGENT_TOOL_COUNT,
			},
			{
				namespace: "hlid_obsidian",
				total: HLID_OBSIDIAN_TOOL_COUNT,
				deferred: HLID_OBSIDIAN_TOOL_COUNT,
			},
		]);
	});

	it("reports ACP fallback schemas as eagerly available", () => {
		expect(hlidToolLoadingSummary("acp")).toEqual([
			{
				namespace: "hlid",
				total: HLID_AGENT_TOOL_COUNT,
				deferred: 0,
			},
			{
				namespace: "hlid_obsidian",
				total: HLID_OBSIDIAN_TOOL_COUNT,
				deferred: 0,
			},
		]);
	});

	it("records delivery settings without changing prompt accounting", () => {
		expect(
			finalizeHlidTurnContextManifest(promptManifest, {
				delivery: "chat",
				providerId: "codex",
				model: "gpt-5.6-sol",
				effort: "high",
				permissionMode: "ask",
				providerPromptChars: 15,
				providerHandoffChars: 4,
				recordedAt: 1_700_000_000_000,
			}),
		).toMatchObject({
			...promptManifest,
			recordedAt: 1_700_000_000_000,
			delivery: "chat",
			providerId: "codex",
			model: "gpt-5.6-sol",
			effort: "high",
			permissionMode: "ask",
			providerPromptChars: 15,
			providerHandoffChars: 4,
		});
	});
});
