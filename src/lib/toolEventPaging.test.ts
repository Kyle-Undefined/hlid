import { describe, expect, it } from "vitest";
import {
	isGeneratedMediaToolName,
	isHlidDelegationToolName,
	isHlidVisualizationToolName,
	isObsidianMutationToolName,
	isProjectPreviewToolName,
	isTranscriptPagingSpecialToolName,
} from "./toolEventPaging";

describe("toolEventPaging", () => {
	it("classifies transcript tools that require complete response context", () => {
		expect(isGeneratedMediaToolName("ImageGeneration")).toBe(true);
		expect(isHlidVisualizationToolName("mcp__hlid__create_visualization")).toBe(
			true,
		);
		expect(isProjectPreviewToolName("hlid.capture_project_preview")).toBe(true);
		expect(isObsidianMutationToolName("mcp__obsidian__patch_note")).toBe(true);
		expect(isHlidDelegationToolName("mcp__hlid__delegate_hlid_agent")).toBe(
			true,
		);
		for (const name of [
			"ImageGeneration",
			"mcp__hlid__create_visualization",
			"hlid.capture_project_preview",
			"mcp__obsidian__patch_note",
			"mcp__hlid__delegate_hlid_agent",
		]) {
			expect(isTranscriptPagingSpecialToolName(name)).toBe(true);
		}
	});

	it("leaves ordinary tool names eligible for paging", () => {
		for (const name of ["Read", "Bash", "web.run", "update_plan"]) {
			expect(isTranscriptPagingSpecialToolName(name)).toBe(false);
		}
	});
});
