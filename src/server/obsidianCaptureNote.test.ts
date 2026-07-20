import { describe, expect, it, vi } from "vitest";
import { HlidConfigSchema } from "#/config";
import { captureObsidianNote } from "./obsidianCaptureNote";

describe("captureObsidianNote", () => {
	it("uses the workspace destination, template, and collision-safe name", async () => {
		const vault = HlidConfigSchema.parse({
			vault: {
				name: "Fornbok",
				style: "para",
				inbox: "0 Inbox",
				save_to_obsidian_template: "Quick Capture",
			},
		}).vault;
		const createNote = vi.fn().mockResolvedValue({
			path: "0 Inbox/Final.md",
		});

		await expect(
			captureObsidianNote(
				vault,
				{ content: "Captured by an agent", open: true },
				{
					now: () => new Date(2026, 6, 20, 14, 35, 9, 42),
					nonce: () => "ab-cd_123456",
					createNote,
				},
			),
		).resolves.toEqual({
			path: "0 Inbox/Final.md",
			destination: "Inbox",
			template: "Quick Capture",
		});
		expect(createNote).toHaveBeenCalledWith("Fornbok", {
			path: "0 Inbox/Hlid 2026-07-20 14-35-09-042 abcd1234.md",
			template: "Quick Capture",
			content: "Captured by an agent",
			open: true,
		});
	});

	it("rejects workspaces without an Inbox or Raw destination", async () => {
		const vault = HlidConfigSchema.parse({
			vault: { name: "Fornbok", style: "para" },
		}).vault;
		await expect(
			captureObsidianNote(vault, { content: "No destination" }),
		).rejects.toThrow("does not have an Obsidian Inbox or Raw folder");
	});
});
