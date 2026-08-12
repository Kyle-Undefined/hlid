import { describe, expect, it } from "vitest";
import {
	buildHlidToolLoadingSummary,
	describeHlidToolLoading,
	HLID_AGENT_TOOL_COUNT,
	HLID_OBSIDIAN_TOOL_COUNT,
	type HlidPromptContextManifest,
	parseHlidTurnContextManifest,
	summarizeHlidStructuredPrompt,
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
	it("keeps legacy v1 receipts valid without a structured prompt summary", () => {
		const legacy = {
			...promptManifest,
			recordedAt: 1_700_000_000_000,
			delivery: "chat" as const,
			providerId: "acp:legacy",
			providerPromptChars: 15,
			providerHandoffChars: 0,
			toolLoading: [],
		};

		const parsed = parseHlidTurnContextManifest(JSON.stringify(legacy));
		expect(parsed).toEqual(legacy);
		expect(parsed?.structuredPrompt).toBeUndefined();
	});

	it("summarizes only accepted native ACP blocks", () => {
		expect(
			summarizeHlidStructuredPrompt([
				{ type: "image", data: "AQID" },
				{ type: "image", data: "AQI=" },
				{ type: "resource", text: "selected" },
				{ type: "resource", blob: "AQID" },
			]),
		).toEqual({
			imageCount: 2,
			imageDecodedBytes: 5,
			embeddedResourceCount: 2,
			embeddedResourceChars: "selected".length,
		});
		expect(summarizeHlidStructuredPrompt([])).toBeUndefined();
	});

	it("records exact loaded and deferred tool names without copying schemas", () => {
		expect(
			describeHlidToolLoading(
				[
					{ name: "hlid_help", deferLoading: true },
					{ name: "windows_computer_use", deferLoading: false },
				],
				true,
			),
		).toEqual([
			{ name: "hlid_help", delivery: "deferred" },
			{ name: "windows_computer_use", delivery: "loaded" },
		]);
	});

	it("builds an exact namespace summary from a provider tool inventory", () => {
		expect(
			buildHlidToolLoadingSummary("hlid", [
				{ name: "hlid_help", delivery: "deferred" },
				{ name: "windows_computer_use", delivery: "loaded" },
			]),
		).toEqual({
			namespace: "hlid",
			total: 2,
			deferred: 1,
			tools: [
				{ name: "hlid_help", delivery: "deferred" },
				{ name: "windows_computer_use", delivery: "loaded" },
			],
		});
	});

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
		const toolLoading = [
			{ namespace: "hlid" as const, total: 9, deferred: 8 },
			{ namespace: "hlid_obsidian" as const, total: 28, deferred: 28 },
		];
		expect(
			finalizeHlidTurnContextManifest(promptManifest, {
				delivery: "chat",
				providerId: "codex",
				model: "gpt-5.6-sol",
				effort: "high",
				permissionMode: "ask",
				providerPromptChars: 15,
				providerHandoffChars: 4,
				toolLoading,
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
			toolLoading,
		});
	});
});
